// Small D1 helpers. Bulk writes go through json_each(?) so one statement handles
// any number of rows: D1 allows 50 queries per invocation on the Free plan.
// SPDX-License-Identifier: AGPL-3.0-only

import { defaultConfig, parseConfig, type Config } from '../shared/config';

export type Settings = Record<string, string>;

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export function setSettings(db: D1Database, values: Settings): D1PreparedStatement {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
  return db
    .prepare(
      `INSERT INTO settings (key, value)
       SELECT json_extract(value, '$.key'), json_extract(value, '$.value') FROM json_each(?1) WHERE true
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(JSON.stringify(rows));
}

export function hourFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);
}

export function isoHour(d: Date): string {
  return hourFloor(d).toISOString().replace('.000Z', 'Z');
}

export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The saved config, or defaults. An invalid saved config falls back to defaults rather than breaking scans. */
export function configFrom(settings: Settings): Config {
  if (!settings.config) return defaultConfig();
  try {
    return parseConfig(JSON.parse(settings.config));
  } catch {
    return defaultConfig();
  }
}

/** Per-account scan state: last scan, inventory time, dataset availability and so on. */
export async function getAccountState(db: D1Database, account: string): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM account_state WHERE account = ?1').bind(account).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export function setAccountState(db: D1Database, account: string, values: Settings): D1PreparedStatement {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
  return db
    .prepare(
      `INSERT INTO account_state (account, key, value)
       SELECT ?1, json_extract(value, '$.key'), json_extract(value, '$.value') FROM json_each(?2) WHERE true
       ON CONFLICT(account, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(account, JSON.stringify(rows));
}

export interface AccountRow {
  id: string;
  name: string | null;
  enabled: number;
  detected_plan: string | null;
  added_at: string;
}

/** Watched accounts, oldest first. `all` includes the ones switched off. */
export async function listAccounts(db: D1Database, all = false): Promise<AccountRow[]> {
  const { results } = await db
    .prepare(`SELECT id, name, enabled, detected_plan, added_at FROM accounts ${all ? '' : 'WHERE enabled = 1'} ORDER BY added_at, id`)
    .all<AccountRow>();
  return results;
}

export function upsertAccount(db: D1Database, a: { id: string; name?: string | null; enabled?: boolean; detectedPlan?: string | null }, now = new Date()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO accounts (id, name, enabled, detected_plan, added_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, accounts.name),
         enabled = CASE WHEN ?6 THEN excluded.enabled ELSE accounts.enabled END,
         detected_plan = COALESCE(excluded.detected_plan, accounts.detected_plan)`,
    )
    .bind(a.id, a.name ?? null, a.enabled === false ? 0 : 1, a.detectedPlan ?? null, now.toISOString(), a.enabled === undefined ? 0 : 1);
}

/** Accounts pinned with CF_ACCOUNT_ID (comma-separated), or null when not pinned. */
export function pinnedAccounts(envValue?: string): string[] | null {
  const ids = (envValue ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * Plan in effect for one account: the per-account config wins, then the global config, then the
 * plan detected from billing, then the PLAN var.
 */
export function planFrom(config: Config, detected: string | null | undefined, envPlan?: string, account?: string): 'free' | 'paid' {
  const own = account ? config.accounts[account]?.plan : undefined;
  if (own && own !== 'auto') return own;
  if (config.plan !== 'auto') return config.plan;
  const p = detected ?? envPlan;
  return p === 'paid' ? 'paid' : 'free';
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Adds to today's usage counters for the Self-cost panel. */
export function recordUsage(
  db: D1Database, now: Date,
  u: { cronRuns?: number; apiRequests?: number; subrequests?: number; rowsRead?: number; rowsWritten?: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO usage_daily (day, cron_runs, api_requests, subrequests, rows_read, rows_written) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(day) DO UPDATE SET cron_runs = cron_runs + ?2, api_requests = api_requests + ?3,
         subrequests = subrequests + ?4, rows_read = rows_read + ?5, rows_written = rows_written + ?6`,
    )
    .bind(utcDay(now), u.cronRuns ?? 0, u.apiRequests ?? 0, u.subrequests ?? 0, u.rowsRead ?? 0, u.rowsWritten ?? 0);
}
