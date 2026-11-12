// History: daily rollups of the hourly tables, kept long after the hourly rows are pruned, the
// scan-run log, and the change counter that response caching keys on.
// All of it is computed inside D1 from rows the scan already stored: no Cloudflare API calls.
// SPDX-License-Identifier: AGPL-3.0-only

const DAY = 86_400_000;

/** Daily rollups and the finding event log are kept this long (13 months and a bit). */
export const HISTORY_DAYS = 400;
/** Scan runs are kept for this many days. */
export const SCAN_RUN_DAYS = 90;
/** Days rolled up per scan at most, so a scan after a long outage stays light. */
const ROLLUP_DAYS_PER_SCAN = 3;
/** A day is rolled up once this many hours of the next day have passed: late analytics rows have arrived. */
const ROLLUP_DELAY_HOURS = 2;

export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));

/**
 * The UTC days to fold into the daily tables on this scan, oldest first: every complete day after
 * `lastRolled`, at most a few per scan. Without a stored day, the last three days are (re)built.
 */
export function rollupDays(now: Date, lastRolled: string | undefined): string[] {
  const today = dayOf(now);
  const newest = now.getUTCHours() >= ROLLUP_DELAY_HOURS ? addDays(today, -1) : addDays(today, -2);
  let from = lastRolled ? addDays(lastRolled, 1) : addDays(newest, -2);
  // Older than the hourly retention there is nothing left to roll up.
  const floor = addDays(today, -90);
  if (from < floor) from = floor;
  const days: string[] = [];
  for (let d = from; d <= newest && days.length < ROLLUP_DAYS_PER_SCAN; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Statements that fold the given days of hourly rows into the daily tables (upserts, so a rerun is harmless). */
export function rollupStatements(db: D1Database, account: string, days: string[]): D1PreparedStatement[] {
  if (!days.length) return [];
  const from = `${days[0]}T00:00:00Z`;
  const to = `${addDays(days.at(-1)!, 1)}T00:00:00Z`;
  return [
    db.prepare(
      `INSERT INTO metrics_daily (account, script, day, requests, errors, subrequests, cpu_time_us, exceeded, exceeded_cpu, exceeded_memory, cpu_p99_max, active_hours)
       SELECT account, script, substr(hour, 1, 10), COALESCE(SUM(requests), 0), COALESCE(SUM(errors), 0), COALESCE(SUM(subrequests), 0),
         COALESCE(SUM(cpu_time_us), 0), COALESCE(SUM(exceeded), 0), COALESCE(SUM(exceeded_cpu), 0), COALESCE(SUM(exceeded_memory), 0),
         MAX(cpu_p99), SUM(CASE WHEN requests > 0 THEN 1 ELSE 0 END)
       FROM metrics_hourly WHERE account = ?1 AND hour >= ?2 AND hour < ?3 GROUP BY script, substr(hour, 1, 10)
       ON CONFLICT(account, script, day) DO UPDATE SET requests = excluded.requests, errors = excluded.errors, subrequests = excluded.subrequests,
         cpu_time_us = excluded.cpu_time_us, exceeded = excluded.exceeded, exceeded_cpu = excluded.exceeded_cpu,
         exceeded_memory = excluded.exceeded_memory, cpu_p99_max = excluded.cpu_p99_max, active_hours = excluded.active_hours`,
    ).bind(account, from, to),
    db.prepare(
      `INSERT INTO resource_daily (account, kind, resource, day, ops, rows_read, rows_written, reads, writes, deletes, lists, peak_ops)
       SELECT account, kind, resource, substr(hour, 1, 10), COALESCE(SUM(ops), 0), SUM(rows_read), SUM(rows_written), SUM(reads), SUM(writes),
         SUM(deletes), SUM(lists), COALESCE(MAX(ops), 0)
       FROM resource_hourly WHERE account = ?1 AND hour >= ?2 AND hour < ?3 GROUP BY kind, resource, substr(hour, 1, 10)
       ON CONFLICT(account, kind, resource, day) DO UPDATE SET ops = excluded.ops, rows_read = excluded.rows_read, rows_written = excluded.rows_written,
         reads = excluded.reads, writes = excluded.writes, deletes = excluded.deletes, lists = excluded.lists, peak_ops = excluded.peak_ops`,
    ).bind(account, from, to),
    // The busiest hour of each metric and day comes along, for "usually peaks at 14:00 UTC".
    db.prepare(
      `INSERT INTO quota_daily (account, metric, day, value, peak_hour, peak_value)
       SELECT ?1, metric, day, total, hour, value FROM (
         SELECT metric, substr(hour, 1, 10) AS day, hour, value,
           SUM(value) OVER (PARTITION BY metric, substr(hour, 1, 10)) AS total,
           ROW_NUMBER() OVER (PARTITION BY metric, substr(hour, 1, 10) ORDER BY value DESC, hour) AS n
         FROM quota_hourly WHERE account = ?1 AND hour >= ?2 AND hour < ?3
       ) WHERE n = 1
       ON CONFLICT(account, metric, day) DO UPDATE SET value = excluded.value, peak_hour = excluded.peak_hour, peak_value = excluded.peak_value`,
    ).bind(account, from, to),
    db.prepare(
      `INSERT INTO cron_daily (account, script, day, runs, failures, cpu_max_ms)
       SELECT account, script, substr(hour, 1, 10), COALESCE(SUM(runs), 0), COALESCE(SUM(failures), 0), MAX(cpu_max_ms)
       FROM cron_runs WHERE account = ?1 AND hour >= ?2 AND hour < ?3 GROUP BY script, substr(hour, 1, 10)
       ON CONFLICT(account, script, day) DO UPDATE SET runs = excluded.runs, failures = excluded.failures, cpu_max_ms = excluded.cpu_max_ms`,
    ).bind(account, from, to),
  ];
}

/** Retention for the long-lived tables, run with the daily inventory refresh. */
export function historyRetention(db: D1Database, account: string, now: Date): D1PreparedStatement[] {
  const day = dayOf(new Date(now.getTime() - HISTORY_DAYS * DAY));
  const iso = new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString();
  return [
    db.prepare('DELETE FROM metrics_daily WHERE account = ?1 AND day < ?2').bind(account, day),
    db.prepare('DELETE FROM resource_daily WHERE account = ?1 AND day < ?2').bind(account, day),
    db.prepare('DELETE FROM quota_daily WHERE account = ?1 AND day < ?2').bind(account, day),
    db.prepare('DELETE FROM cron_daily WHERE account = ?1 AND day < ?2').bind(account, day),
    db.prepare('DELETE FROM storage_daily WHERE account = ?1 AND day < ?2').bind(account, day),
    db.prepare('DELETE FROM finding_events WHERE account = ?1 AND at < ?2').bind(account, iso),
    // Cached Worker pages pile up one per Worker and range viewed; a day later they are stale anyway.
    db.prepare(`DELETE FROM view_cache WHERE view LIKE 'worker-%'`),
    db.prepare('DELETE FROM scan_runs WHERE account = ?1 AND at < ?2').bind(account, new Date(now.getTime() - SCAN_RUN_DAYS * DAY).toISOString()),
  ];
}

/** One row per scan. */
export function scanRunStatement(
  db: D1Database, account: string,
  r: { at: string; ms: number; calls: number; rowsRead: number; rowsWritten: number; warnings: number; findings: number; opened: number; resolved: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO scan_runs (account, at, ms, calls, rows_read, rows_written, warnings, findings, opened, resolved)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(account, at) DO NOTHING`,
    )
    .bind(account, r.at, r.ms, r.calls, r.rowsRead, r.rowsWritten, r.warnings, r.findings, r.opened, r.resolved);
}

/**
 * Marks that what the dashboard shows has changed (a scan finished, a finding was acknowledged,
 * the config was saved). Cached responses carry the counter in their ETag, so they are rebuilt
 * once after a change and served from one row until the next.
 */
export function bumpRevision(db: D1Database): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('data_rev', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)`,
    );
}
