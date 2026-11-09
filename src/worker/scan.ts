// The hourly scan. Reads Cloudflare APIs, stores history in D1, runs checks, sends alerts.
// Designed for the Workers Free plan: about 10 subrequests and 20 D1 queries per run.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Finding } from '../shared/types';
import { CfClient, type ApiScript, type ApiWorker } from './cf';
import { median, runChecks, type CronStats, type WorkerStats } from './checks';
import { countRuns } from './cron';
import { getSettings, hourFloor, isoHour, setSettings, utcMidnight } from './db';
import { sendAlerts } from './notify';
import type { Env } from './env';

const HOUR = 3_600_000;
/** Detail calls (schedules) per run; keeps every run well under 50 subrequests. */
const MAX_DETAIL_CALLS = 10;

export interface ScanResult {
  workers: number;
  findings: number;
  subrequests: number;
  warnings: string[];
}

export async function runScan(env: Env, now = new Date()): Promise<ScanResult> {
  const db = env.DB;
  const settings = await getSettings(db);
  const warnings: string[] = [];
  const stamp = now.toISOString();

  const accountId = env.CF_ACCOUNT_ID || settings.account_id || (await CfClient.resolveAccountId(env.CF_API_TOKEN));
  const cf = new CfClient(env.CF_API_TOKEN, accountId);
  const plan: 'free' | 'paid' = (settings.plan ?? env.PLAN) === 'paid' ? 'paid' : 'free';

  // 1. Inventory. The beta Workers list adds subdomain and observability settings; if the
  //    token cannot read it, the scripts list alone is enough for v0.1 checks.
  const [apiWorkers, scripts] = await Promise.all([
    cf.listWorkers().catch((e: Error) => {
      warnings.push(`Workers list unavailable: ${e.message}`);
      return [] as ApiWorker[];
    }),
    cf.listScripts(),
  ]);
  const inventory = mergeInventory(scripts, apiWorkers, stamp);

  // 2. Metrics since the last stored hour (at most 48 h back on first run).
  const lastHourRow = await db.prepare('SELECT MAX(hour) AS h FROM metrics_hourly').first<{ h: string | null }>();
  const since = lastHourRow?.h
    ? new Date(Math.max(new Date(lastHourRow.h).getTime() - HOUR, now.getTime() - 48 * HOUR))
    : new Date(hourFloor(now).getTime() - 48 * HOUR);
  const [hourly, exceeded] = await Promise.all([
    cf.hourlyMetrics(since, now),
    cf.exceededByHour(since, now).catch((e: Error) => {
      warnings.push(`Limit outcomes unavailable: ${e.message}`);
      return [];
    }),
  ]);

  // 3. Cron schedules, a few Workers per run, refreshed every 6 hours.
  const scheduled = inventory.filter((w) => w.handlers.includes('scheduled')).map((w) => w.name);
  const { results: known } = await db.prepare('SELECT script, checked_at FROM schedules').all<{ script: string; checked_at: string }>();
  const checkedAt = new Map(known.map((k) => [k.script, k.checked_at]));
  const due = scheduled
    .filter((s) => !checkedAt.has(s) || now.getTime() - new Date(checkedAt.get(s)!).getTime() > 6 * HOUR)
    .slice(0, MAX_DETAIL_CALLS);
  const scheduleRows: { script: string; crons: string; checked_at: string }[] = [];
  for (const script of due) {
    try {
      scheduleRows.push({ script, crons: JSON.stringify(await cf.schedules(script)), checked_at: stamp });
    } catch (e) {
      warnings.push(`Schedules for ${script} unavailable: ${(e as Error).message}`);
    }
  }

  // 4. Cron runs (experimental dataset; retried once a day if unavailable).
  const cronFrom = new Date(hourFloor(now).getTime() - 25 * HOUR);
  const cronTo = new Date(hourFloor(now).getTime() - HOUR);
  let cronRuns: Awaited<ReturnType<CfClient['cronRuns']>> | null = null;
  const cronRetryDue =
    settings.cron_dataset !== 'unavailable' || now.getTime() - new Date(settings.cron_dataset_checked ?? 0).getTime() > 24 * HOUR;
  if (scheduled.length && cronRetryDue) {
    try {
      cronRuns = await cf.cronRuns(new Date(cronFrom.getTime() - HOUR), now);
    } catch (e) {
      warnings.push(`Cron runs unavailable: ${(e as Error).message}`);
    }
  }

  // 5. Write everything in one batch.
  const writes: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO workers (name, has_modules, compatibility_date, handlers, usage_model, created_on, modified_on,
         deployed_on, workers_dev, previews_enabled, logs_enabled, sampling_rate, logpush, tags, last_seen)
       SELECT json_extract(value,'$.name'), json_extract(value,'$.has_modules'), json_extract(value,'$.compatibility_date'),
         json_extract(value,'$.handlers'), json_extract(value,'$.usage_model'), json_extract(value,'$.created_on'),
         json_extract(value,'$.modified_on'), json_extract(value,'$.deployed_on'), json_extract(value,'$.workers_dev'),
         json_extract(value,'$.previews_enabled'), json_extract(value,'$.logs_enabled'), json_extract(value,'$.sampling_rate'),
         json_extract(value,'$.logpush'), json_extract(value,'$.tags'), json_extract(value,'$.last_seen')
       FROM json_each(?1) WHERE true
       ON CONFLICT(name) DO UPDATE SET has_modules=excluded.has_modules, compatibility_date=excluded.compatibility_date,
         handlers=excluded.handlers, usage_model=excluded.usage_model, created_on=excluded.created_on,
         modified_on=excluded.modified_on, deployed_on=excluded.deployed_on, workers_dev=excluded.workers_dev,
         previews_enabled=excluded.previews_enabled, logs_enabled=excluded.logs_enabled,
         sampling_rate=excluded.sampling_rate, logpush=excluded.logpush, tags=excluded.tags, last_seen=excluded.last_seen`,
    ).bind(JSON.stringify(inventory.map((w) => ({ ...w, handlers: JSON.stringify(w.handlers), tags: JSON.stringify(w.tags) })))),
    db.prepare('DELETE FROM workers WHERE last_seen <> ?1').bind(stamp),
    db.prepare(
      `INSERT INTO metrics_hourly (script, hour, requests, errors, subrequests, cpu_p99)
       SELECT json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.requests'),
         json_extract(value,'$.errors'), json_extract(value,'$.subrequests'), json_extract(value,'$.cpuP99')
       FROM json_each(?1) WHERE true
       ON CONFLICT(script, hour) DO UPDATE SET requests=excluded.requests, errors=excluded.errors,
         subrequests=excluded.subrequests, cpu_p99=excluded.cpu_p99`,
    ).bind(JSON.stringify(hourly)),
    db.prepare(
      `INSERT INTO metrics_hourly (script, hour, exceeded)
       SELECT json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.count')
       FROM json_each(?1) WHERE true
       ON CONFLICT(script, hour) DO UPDATE SET exceeded=excluded.exceeded`,
    ).bind(JSON.stringify(exceeded)),
    db.prepare(
      `INSERT INTO schedules (script, crons, checked_at)
       SELECT json_extract(value,'$.script'), json_extract(value,'$.crons'), json_extract(value,'$.checked_at')
       FROM json_each(?1) WHERE true
       ON CONFLICT(script) DO UPDATE SET crons=excluded.crons, checked_at=excluded.checked_at`,
    ).bind(JSON.stringify(scheduleRows)),
    db.prepare(`DELETE FROM schedules WHERE script NOT IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(scheduled)),
    db.prepare('DELETE FROM metrics_hourly WHERE hour < ?1').bind(isoHour(new Date(now.getTime() - 30 * 24 * HOUR))),
  ];
  if (cronRuns) {
    writes.push(
      db.prepare(
        `INSERT INTO cron_runs (script, hour, runs, failures)
         SELECT json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.runs'), json_extract(value,'$.failures')
         FROM json_each(?1) WHERE true
         ON CONFLICT(script, hour) DO UPDATE SET runs=excluded.runs, failures=excluded.failures`,
      ).bind(JSON.stringify(cronRuns)),
    );
  }
  writes.push(
    setSettings(db, {
      account_id: accountId,
      ...(scheduled.length && cronRetryDue
        ? { cron_dataset: cronRuns ? 'available' : 'unavailable', cron_dataset_checked: stamp }
        : {}),
    }),
  );
  await db.batch(writes);

  // 6. Checks.
  const workerStats = await loadWorkerStats(db, now);
  const accountToday = await db
    .prepare('SELECT COALESCE(SUM(requests),0) AS n FROM metrics_hourly WHERE hour >= ?1')
    .bind(isoHour(utcMidnight(now)))
    .first<{ n: number }>();
  const cronDatasetOk = cronRuns != null || settings.cron_dataset === 'available';
  const crons = cronDatasetOk ? await loadCronStats(db, cronFrom, cronTo) : null;
  const findings = runChecks({
    now,
    plan,
    accountRequestsToday: accountToday?.n ?? 0,
    workers: workerStats,
    crons,
    thresholds: settings.thresholds ? JSON.parse(settings.thresholds) : undefined,
  });

  await saveFindings(db, findings, stamp);
  await db.batch([setSettings(db, { last_scan_at: stamp, last_scan_calls: String(cf.calls), last_scan_warnings: JSON.stringify(warnings) })]);

  // 7. Alerts and weekly digest (only if e-mail is configured).
  await sendAlerts(env, now).catch((e: Error) => warnings.push(`Alerts failed: ${e.message}`));

  return { workers: inventory.length, findings: findings.length, subrequests: cf.calls, warnings };
}

interface InventoryRow {
  name: string;
  has_modules: number | null;
  compatibility_date: string | null;
  handlers: string[];
  usage_model: string | null;
  created_on: string | null;
  modified_on: string | null;
  deployed_on: string | null;
  workers_dev: number | null;
  previews_enabled: number | null;
  logs_enabled: number | null;
  sampling_rate: number | null;
  logpush: number | null;
  tags: string[];
  last_seen: string;
}

const flag = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);

export function mergeInventory(scripts: ApiScript[], workers: ApiWorker[], stamp: string): InventoryRow[] {
  const byName = new Map(workers.map((w) => [w.name, w]));
  return scripts.map((s) => {
    const w = byName.get(s.id);
    return {
      name: s.id,
      has_modules: flag(s.has_modules),
      compatibility_date: s.compatibility_date ?? null,
      handlers: s.handlers ?? [],
      usage_model: s.usage_model ?? null,
      created_on: s.created_on ?? w?.created_on ?? null,
      modified_on: s.modified_on ?? w?.updated_on ?? null,
      deployed_on: w?.deployed_on ?? null,
      workers_dev: flag(w?.subdomain?.enabled),
      previews_enabled: flag(w?.subdomain?.previews_enabled),
      logs_enabled: flag(w?.observability?.enabled),
      sampling_rate: w?.observability?.head_sampling_rate ?? null,
      logpush: flag(w?.logpush),
      tags: w?.tags ?? [],
      last_seen: stamp,
    };
  });
}

async function loadWorkerStats(db: D1Database, now: Date): Promise<WorkerStats[]> {
  const lastFullHour = isoHour(new Date(hourFloor(now).getTime() - HOUR));
  const dayAgo = isoHour(new Date(now.getTime() - 24 * HOUR));
  const weekAgo = isoHour(new Date(now.getTime() - 7 * 24 * HOUR));
  const [names, day, hist] = await db.batch([
    db.prepare('SELECT name FROM workers'),
    db.prepare(
      `SELECT script, SUM(requests) AS requests, SUM(errors) AS errors, SUM(exceeded) AS exceeded, MAX(cpu_p99) AS cpu
       FROM metrics_hourly WHERE hour >= ?1 GROUP BY script`,
    ).bind(dayAgo),
    db.prepare('SELECT script, hour, requests FROM metrics_hourly WHERE hour >= ?1 AND hour <= ?2').bind(weekAgo, lastFullHour),
  ]);
  const dayBy = new Map((day.results as { script: string; requests: number; errors: number; exceeded: number; cpu: number | null }[]).map((r) => [r.script, r]));
  const histBy = new Map<string, { last: number; others: number[] }>();
  for (const r of hist.results as { script: string; hour: string; requests: number }[]) {
    const h = histBy.get(r.script) ?? { last: 0, others: [] };
    if (r.hour === lastFullHour) h.last = r.requests;
    else h.others.push(r.requests);
    histBy.set(r.script, h);
  }
  return (names.results as { name: string }[]).map(({ name }) => {
    const d = dayBy.get(name);
    const h = histBy.get(name);
    return {
      name,
      requests24h: d?.requests ?? 0,
      errors24h: d?.errors ?? 0,
      exceeded24h: d?.exceeded ?? 0,
      cpuP99Max24h: d?.cpu ?? null,
      lastHourRequests: h?.last ?? 0,
      hourlyMedian7d: median(h?.others ?? []),
      historyHours: (h?.others.length ?? 0) + (h ? 1 : 0),
    };
  });
}

async function loadCronStats(db: D1Database, from: Date, to: Date): Promise<CronStats[]> {
  const [schedules, runs] = await db.batch([
    db.prepare('SELECT script, crons FROM schedules'),
    db.prepare(
      `SELECT script, SUM(runs) AS runs, SUM(failures) AS failures FROM cron_runs
       WHERE hour >= ?1 AND hour < ?2 GROUP BY script`,
    ).bind(isoHour(from), isoHour(to)),
  ]);
  const runsBy = new Map((runs.results as { script: string; runs: number; failures: number }[]).map((r) => [r.script, r]));
  const out: CronStats[] = [];
  for (const s of schedules.results as { script: string; crons: string }[]) {
    let expected = 0;
    for (const expr of JSON.parse(s.crons) as string[]) {
      try {
        expected += countRuns(expr, from, to);
      } catch {
        // Unsupported expression: skip rather than raise a false alarm.
      }
    }
    const r = runsBy.get(s.script);
    if (expected > 0) out.push({ name: s.script, expected, observed: r?.runs ?? 0, failures: r?.failures ?? 0 });
  }
  return out;
}

async function saveFindings(db: D1Database, findings: Finding[], stamp: string): Promise<void> {
  const rows = findings.map((f) => ({ ...f, evidence: JSON.stringify(f.evidence), docsUrl: f.docsUrl ?? null }));
  await db.batch([
    db.prepare(
      `INSERT INTO findings (id, script, module, severity, code, message, evidence, action, docs_url, first_seen, last_seen, status)
       SELECT json_extract(value,'$.id'), json_extract(value,'$.script'), json_extract(value,'$.module'),
         json_extract(value,'$.severity'), json_extract(value,'$.code'), json_extract(value,'$.message'),
         json_extract(value,'$.evidence'), json_extract(value,'$.action'), json_extract(value,'$.docsUrl'), ?2, ?2, 'open'
       FROM json_each(?1) WHERE true
       ON CONFLICT(id) DO UPDATE SET
         message=excluded.message, evidence=excluded.evidence, action=excluded.action, docs_url=excluded.docs_url,
         last_seen=excluded.last_seen,
         first_seen = CASE WHEN findings.status = 'resolved' THEN excluded.first_seen ELSE findings.first_seen END,
         notified_at = CASE WHEN findings.status = 'resolved' THEN NULL ELSE findings.notified_at END,
         status = CASE
           WHEN findings.status = 'resolved' THEN 'open'
           WHEN findings.status = 'acknowledged' AND findings.severity <> excluded.severity THEN 'open'
           WHEN findings.status = 'snoozed' AND findings.snooze_until < excluded.last_seen THEN 'open'
           ELSE findings.status END,
         severity=excluded.severity`,
    ).bind(JSON.stringify(rows), stamp),
    db.prepare(`UPDATE findings SET status = 'resolved' WHERE last_seen <> ?1 AND status <> 'resolved'`).bind(stamp),
  ]);
}
