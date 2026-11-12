// Which account to scan, and when. One install can watch several Cloudflare accounts; each cron
// tick (every 15 minutes) scans the account that is most overdue. A failing account cannot block
// the others: its attempt time counts like a scan when ordering.
// SPDX-License-Identifier: AGPL-3.0-only

import { CfClient } from './cf';
import { bumpRevision } from './history';
import { configFrom, getAccountState, getSettings, listAccounts, pinnedAccounts, setAccountState, upsertAccount, type AccountRow } from './db';
import { sendSystemAlert } from './notify';
import type { Env, ScanMessage } from './env';
import { runScan, type ScanResult } from './scan';

const MINUTE = 60_000;
/** Failed scans in a row before Ambersight alerts about itself. */
export const FAILURE_ALERT_AFTER = 3;

/**
 * Accounts to scan. CF_ACCOUNT_ID (comma-separated) pins the set. Otherwise the accounts chosen
 * in the setup wizard. An install from before multi-account support with no account stored
 * yet watches the first account the token can see.
 */
export async function activeAccounts(env: Env, now = new Date(), opts: { resolve?: boolean } = {}): Promise<AccountRow[]> {
  const db = env.DB;
  const pinned = pinnedAccounts(env.CF_ACCOUNT_ID);
  if (pinned) {
    const known = new Map((await listAccounts(db, true)).map((a) => [a.id, a]));
    const missing = pinned.filter((id) => !known.has(id));
    if (missing.length) await db.batch(missing.map((id) => upsertAccount(db, { id }, now)));
    return pinned.map((id) => known.get(id) ?? { id, name: null, enabled: 1, detected_plan: null, added_at: now.toISOString() });
  }
  const list = await listAccounts(db);
  if (list.length) return list;
  const all = await listAccounts(db, true);
  if (all.length || !opts.resolve) return []; // every account switched off on purpose, or a read-only view
  const id = await CfClient.resolveAccountId(env.CF_API_TOKEN);
  await upsertAccount(db, { id }, now).run();
  return [{ id, name: null, enabled: 1, detected_plan: null, added_at: now.toISOString() }];
}

export interface DueAccount {
  id: string;
  /** Last scan or last failed attempt, whichever is later; null when never tried. */
  lastTry: string | null;
}

/** Accounts whose scan interval has passed, most overdue first. */
export async function dueAccounts(env: Env, now = new Date()): Promise<DueAccount[]> {
  const db = env.DB;
  const config = configFrom(await getSettings(db));
  const accounts = await activeAccounts(env, now, { resolve: true });
  if (!accounts.length) return [];
  const { results } = await db
    .prepare(
      `SELECT account, MAX(value) AS last FROM account_state
       WHERE key IN ('last_scan_at', 'last_attempt_at') AND account IN (SELECT value FROM json_each(?1)) GROUP BY account`,
    )
    .bind(JSON.stringify(accounts.map((a) => a.id)))
    .all<{ account: string; last: string | null }>();
  const last = new Map(results.map((r) => [r.account, r.last]));
  const intervalMs = (config.scanIntervalMinutes - 2) * MINUTE;
  return accounts
    .map((a) => ({ id: a.id, lastTry: last.get(a.id) ?? null }))
    .filter((a) => !a.lastTry || now.getTime() - new Date(a.lastTry).getTime() >= intervalMs)
    .sort((a, b) => (a.lastTry ?? '').localeCompare(b.lastTry ?? ''));
}

/**
 * How often each account really gets scanned. One cron tick scans one account, so with many
 * accounts the interval stretches to accounts x 15 minutes (unless the scan queue is bound).
 */
export function effectiveIntervalMinutes(configured: number, accounts: number, queue: boolean): number {
  return queue ? configured : Math.max(configured, accounts * 15);
}

/** Runs one account's scan and records a failure instead of throwing, so the next tick moves on. */
export async function scanAccount(env: Env, account: string, now = new Date(), force = true, continuation = false): Promise<ScanResult | { error: string }> {
  const db = env.DB;
  try {
    return await runScan(env, now, { account, force, continuation });
  } catch (e) {
    const message = (e as Error).message || 'Unknown error';
    const state = await getAccountState(db, account);
    const failures = Number(state.scan_failures ?? 0) + 1;
    const update: Record<string, string> = {
      last_attempt_at: now.toISOString(),
      last_scan_error: message.slice(0, 500),
      scan_failures: String(failures),
    };
    // Three failures in a row: say so, at most once a day, on the critical-alert channel.
    if (failures >= FAILURE_ALERT_AFTER && now.getTime() - new Date(state.failure_alert_at ?? 0).getTime() > 24 * 60 * MINUTE) {
      const global = await getSettings(db);
      const config = configFrom(global);
      const name = config.accounts[account]?.label ?? (await db.prepare('SELECT name FROM accounts WHERE id = ?1').bind(account).first<{ name: string | null }>())?.name ?? account;
      const sent = await sendSystemAlert(
        env, now, config,
        `The last ${failures} scans of ${name} failed: ${message.slice(0, 200)}`,
        'Ambersight cannot see this account until this is fixed. Check that the CF_API_TOKEN secret is still valid and has not expired, then press Scan now.',
      ).catch(() => false);
      if (sent) update.failure_alert_at = now.toISOString();
    }
    // The failed-scan banner is part of the cached overview: mark the change.
    await db.batch([setAccountState(db, account, update), bumpRevision(db)]);
    return { error: message };
  }
}

/**
 * The cron entry point. Without the scan queue: scan the most overdue account. With it: put every
 * due account on the queue, where each scan runs in its own invocation with its own budget.
 */
export async function scheduledRun(env: Env, now = new Date()): Promise<{ account: string; result: ScanResult | { error: string } } | { queued: string[] } | null> {
  const settings = await getSettings(env.DB);
  if (settings.setup_done !== '1') return null;
  const due = await dueAccounts(env, now);
  if (!due.length) return null;
  if (env.SCAN_QUEUE) {
    // Marked as attempted now, so the next tick does not queue them again while they wait.
    await env.DB.batch(due.map((a) => setAccountState(env.DB, a.id, { last_attempt_at: now.toISOString() })));
    await env.SCAN_QUEUE.sendBatch(due.map((a) => ({ body: { kind: 'scan', account: a.id } satisfies ScanMessage })));
    return { queued: due.map((a) => a.id) };
  }
  const account = due[0].id;
  await setAccountState(env.DB, account, { last_attempt_at: now.toISOString() }).run();
  return { account, result: await scanAccount(env, account, now, true) };
}

/** Continuations per account per scan: enough for a few hundred Workers' details or zones. */
export const MAX_CONTINUATIONS = 20;

/**
 * The queue consumer. A scan that could not finish (Workers still waiting for their details,
 * zones still to read) queues a continuation, which runs as a new invocation with a fresh budget.
 */
export async function handleQueueMessage(env: Env, msg: ScanMessage, now = new Date()): Promise<ScanResult | { error: string }> {
  const accounts = await activeAccounts(env, now);
  if (!accounts.some((a) => a.id === msg.account)) return { error: 'Account is no longer watched.' };
  const result = await scanAccount(env, msg.account, now, true, msg.kind === 'continue');
  const step = (msg.step ?? 0) + 1;
  if (!('error' in result) && env.SCAN_QUEUE && step <= MAX_CONTINUATIONS && ((result.detailRemaining ?? 0) > 0 || (result.zonesRemaining ?? 0) > 0)) {
    await env.SCAN_QUEUE.send({ kind: 'continue', account: msg.account, step } satisfies ScanMessage);
  }
  return result;
}
