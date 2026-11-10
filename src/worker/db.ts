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

/** Plan in effect: the config wins, then the plan detected by the wizard, then the PLAN var. */
export function planFrom(config: Config, settings: Settings, envPlan?: string): 'free' | 'paid' {
  if (config.plan !== 'auto') return config.plan;
  const p = settings.detected_plan ?? envPlan;
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
