// Housekeeping that must not depend on a scan. Retention normally runs with an account's daily
// inventory refresh, so an account nobody scans any more would keep its data forever. This runs
// from the cron instead: no Cloudflare calls, and once a day one D1 batch, which counts as a single
// query against the Free plan's 50 per invocation.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config } from '../shared/config';
import { pruneAdminEvents } from './adminLog';
import { configFrom, setSettings, type Settings } from './db';
import type { Env } from './env';
import { accountRetention, historyRetention } from './history';
import { activeAccounts } from './scheduler';

const DAY = 86_400_000;
const RUN_EVERY_MS = DAY;

/** What describes an account as it was at its last scan. It has no age of its own. */
const SNAPSHOT_TABLES = ['workers', 'schedules', 'resources', 'zones', 'storage_sizes', 'd1_queries', 'worker_packages', 'resource_activity'];
/** Kept after an account's data is gone: how long ago it was last scanned, so the rule stays true. */
const KEPT_STATE = ['last_scan_at', 'last_attempt_at'];

export interface UnwatchedAccount {
  id: string;
  /** Last scan or attempt; when it was added if it was never scanned. */
  last: string;
}

/**
 * Retention for accounts no longer scanned, in a fixed order. History ages out as for any account.
 * Once the last scan is older than the retention period, what no later scan will ever update goes
 * too: every finding (not only resolved ones), the inventory and the stored account state.
 */
export function unwatchedStatements(db: D1Database, accounts: UnwatchedAccount[], config: Config, now: Date): D1PreparedStatement[] {
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a.id);
  const cutoff = new Date(now.getTime() - config.retentionDays * DAY).toISOString();
  const staleIds = accounts.filter((a) => a.last < cutoff).map((a) => a.id);
  const stale = JSON.stringify(staleIds);
  return [
    ...accountRetention(db, ids, now, config.retentionDays),
    ...historyRetention(db, ids, now),
    ...(staleIds.length
      ? [
          db.prepare('DELETE FROM findings WHERE account IN (SELECT value FROM json_each(?1))').bind(stale),
          ...SNAPSHOT_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE account IN (SELECT value FROM json_each(?1))`).bind(stale)),
          db.prepare('DELETE FROM account_state WHERE account IN (SELECT value FROM json_each(?1)) AND key NOT IN (SELECT value FROM json_each(?2))').bind(stale, JSON.stringify(KEPT_STATE)),
          // The row stays: it records that the account was switched off on purpose.
          db.prepare('UPDATE accounts SET name = NULL WHERE id IN (SELECT value FROM json_each(?1)) AND name IS NOT NULL').bind(stale),
        ]
      : []),
  ];
}

/** The daily round, if one is due. Costs no query at all on the runs in between. */
export async function runHousekeeping(env: Env, now: Date, settings: Settings): Promise<void> {
  if (settings.housekeeping_at && now.getTime() - Date.parse(settings.housekeeping_at) < RUN_EVERY_MS) return;
  const db = env.DB;
  const active = new Set((await activeAccounts(env, now)).map((a) => a.id));
  const { results } = await db
    .prepare(
      `SELECT a.id, COALESCE((SELECT MAX(s.value) FROM account_state s WHERE s.account = a.id AND s.key IN ('last_scan_at', 'last_attempt_at')), a.added_at) AS last
       FROM accounts a`,
    )
    .all<UnwatchedAccount>();
  await db.batch([
    ...unwatchedStatements(db, results.filter((a) => !active.has(a.id)), configFrom(settings), now),
    pruneAdminEvents(db, now),
    setSettings(db, { housekeeping_at: now.toISOString() }),
  ]);
}
