// The scan: read inventory and metrics from Cloudflare, store them in D1, run the checks.
// Built for the Workers Free plan: 50 subrequests and 50 D1 queries per cron run, so
// per-Worker detail is fetched a few Workers at a time on a rotating cursor and the run
// stops cleanly when its subrequest budget is spent.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope, thresholdsFor, type Config } from '../shared/config';
import { checkOf } from '../shared/findings';
import type { Finding } from '../shared/types';
import { CfClient, CronRunsTruncated, type ApiScript, type ApiWorker, type CronRunRow, type Deployment, type InventoryItem, type ResourceOps, type ScriptSettings } from './cf';
import { median, runChecks, type CronStats, type HourPoint, type ResourceStats, type WorkerMeta, type WorkerStats } from './checks';
import { countRuns } from './cron';
import { configFrom, getAccountState, getSettings, hourFloor, isoHour, planFrom, recordUsage, setAccountState, setSettings, upsertAccount, utcMidnight, type Settings } from './db';
import type { Env } from './env';
import type { InventoryFacts } from './hygiene';
import { metered } from './meter';
import { allowedFetch } from './net';
import { sendAlerts } from './notify';
import { isNewer, REPO, VERSION } from './version';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Subrequests per run, leaving room for alerts and the update check. */
const BUDGET = { free: 42, paid: 900 };
const DETAIL_MAX_AGE = 6 * HOUR;
const MAX_ZONES = 20;

export interface ScanResult {
  skipped?: boolean;
  workers: number;
  findings: number;
  subrequests: number;
  warnings: string[];
  detailRemaining?: number;
}

/** Scans one account. The scheduler (scheduler.ts) decides which account is due. */
export async function runScan(rawEnv: Env, now = new Date(), opts: { account: string; force?: boolean }): Promise<ScanResult> {
  const started = Date.now();
  const { db, meter } = metered(rawEnv.DB);
  const env = { ...rawEnv, DB: db };
  const accountId = opts.account;
  const [global, settings, accountRow] = await Promise.all([
    getSettings(db),
    getAccountState(db, accountId),
    db.prepare('SELECT detected_plan FROM accounts WHERE id = ?1').bind(accountId).first<{ detected_plan: string | null }>(),
  ]);
  const config = configFrom(global);

  // The cron fires every 15 minutes; honour the configured interval.
  if (!opts.force && settings.last_scan_at && now.getTime() - new Date(settings.last_scan_at).getTime() < (config.scanIntervalMinutes - 2) * 60_000) {
    return { skipped: true, workers: 0, findings: 0, subrequests: 0, warnings: [] };
  }

  const warnings: string[] = [];
  const stamp = now.toISOString();
  const cf = new CfClient(env.CF_API_TOKEN, accountId);
  let detectedPlan = accountRow?.detected_plan ?? null;
  const plan = planFrom(config, detectedPlan, env.PLAN, accountId);
  const budget = BUDGET[plan];
  const left = () => budget - cf.calls;

  // 1. Inventory. The beta Workers list adds subdomain, preview, observability and deploy data.
  const [apiWorkers, scripts] = await Promise.all([
    cf.listWorkers().catch((e: Error) => {
      warnings.push(`Workers list unavailable: ${e.message}`);
      return null;
    }),
    cf.listScripts(),
  ]);
  const inventory = mergeInventory(scripts, apiWorkers ?? [], stamp);
  const { results: known } = await db
    .prepare(`SELECT name, detail_checked_at, bindings LIKE '%durable_object_namespace%' AS has_do FROM workers WHERE account = ?1`)
    .bind(accountId)
    .all<{ name: string; detail_checked_at: string | null; has_do: number | null }>();
  const knownNames = new Set(known.map((k) => k.name));
  const currentNames = new Set(inventory.map((w) => w.name));
  const fleetEvents = knownNames.size
    ? [
        ...inventory.filter((w) => !knownNames.has(w.name)).map((w) => ({ at: stamp, kind: 'added', script: w.name })),
        ...[...knownNames].filter((n) => !currentNames.has(n)).map((n) => ({ at: stamp, kind: 'removed', script: n })),
      ]
    : [];

  // 2. Metrics since the last stored hour (at most 48 h back).
  const lastHourRow = await db.prepare('SELECT MAX(hour) AS h FROM metrics_hourly WHERE account = ?1').bind(accountId).first<{ h: string | null }>();
  const since = lastHourRow?.h
    ? new Date(Math.max(new Date(lastHourRow.h).getTime() - HOUR, now.getTime() - 48 * HOUR))
    : new Date(hourFloor(now).getTime() - 48 * HOUR);
  const cpuSum = settings.cpu_sum !== 'unsupported';
  const [hourly, exceeded] = await Promise.all([
    cf.hourlyMetrics(since, now, cpuSum).catch(async (e: Error) => {
      if (!cpuSum) throw e;
      settings.cpu_sum = 'unsupported';
      warnings.push('CPU totals unavailable; CPU runaway detection is off.');
      return cf.hourlyMetrics(since, now, false);
    }),
    cf.exceededByHour(since, now).catch((e: Error) => {
      warnings.push(`Limit outcomes unavailable: ${e.message}`);
      return [];
    }),
  ]);

  // 3. Cron runs (experimental dataset; retried once a day if unavailable).
  const scheduled = inventory.filter((w) => w.handlers.includes('scheduled')).map((w) => w.name);
  const cronFrom = new Date(hourFloor(now).getTime() - 25 * HOUR);
  const cronTo = new Date(hourFloor(now).getTime() - HOUR);
  let cronRuns: CronRunRow[] | null = null;
  let cronTruncated = false;
  const cronRetryDue = settings.cron_dataset !== 'unavailable' || now.getTime() - new Date(settings.cron_dataset_checked ?? 0).getTime() > DAY;
  if (config.modules.cron && scheduled.length && cronRetryDue) {
    const withCpu = settings.cron_cpu !== 'unsupported';
    try {
      cronRuns = await cf.cronRuns(new Date(cronFrom.getTime() - HOUR), now, withCpu).catch(async (e: Error) => {
        if (!withCpu) throw e;
        settings.cron_cpu = 'unsupported';
        return cf.cronRuns(new Date(cronFrom.getTime() - HOUR), now, false);
      });
    } catch (e) {
      cronTruncated = e instanceof CronRunsTruncated;
      warnings.push(cronTruncated ? `Cron checks paused: ${(e as Error).message}` : `Cron runs unavailable: ${(e as Error).message}`);
    }
  }

  // 4. Storage and Durable Object operations, for kinds the account actually has.
  let resourceOps: ResourceOps[] = [];
  if (config.modules.usage) {
    const { results: kindRows } = await db.prepare(`SELECT DISTINCT kind FROM resources WHERE account = ?1 AND kind IN ('kv','d1','r2','queues')`).bind(accountId).all<{ kind: ResourceOps['kind'] }>();
    const kinds = kindRows.map((k) => k.kind);
    if (known.some((k) => k.has_do) || inventory.some((w) => w.handlers.includes('alarm'))) kinds.push('do');
    const failedBefore = new Set((settings.ops_unavailable ?? '').split(',').filter(Boolean));
    const retryFailed = now.getTime() - new Date(settings.ops_checked ?? 0).getTime() > DAY;
    const tryKinds = kinds.filter((k) => retryFailed || !failedBefore.has(k)).slice(0, Math.max(0, left() - 20));
    if (tryKinds.length) {
      const r = await cf.resourceOps(new Date(Math.max(since.getTime(), now.getTime() - 3 * HOUR)), now, tryKinds);
      resourceOps = r.rows;
      if (retryFailed || r.failed.length) {
        settings.ops_unavailable = r.failed.join(',');
        settings.ops_checked = stamp;
      }
    }
  }

  // 5. Full inventory refresh: custom domains, routes, storage, Access, update check.
  const refreshDue = inventoryDue(now, settings.inventory_at ?? null, config);
  const refreshed: InventoryItem[] = [];
  const refreshedKinds = new Set<InventoryItem['kind']>();
  let routeZones: string[] | null = null; // set when only some zones' routes were read
  let subdomain = settings.workers_subdomain ?? null;
  if (refreshDue) {
    subdomain = (await cf.workersSubdomain()) ?? subdomain;
    const step = async (kinds: InventoryItem['kind'][], label: string, run: () => Promise<InventoryItem[]>) => {
      try {
        refreshed.push(...(await run()));
        kinds.forEach((k) => refreshedKinds.add(k));
      } catch (e) {
        warnings.push(`${label} unavailable: ${(e as Error).message}`);
      }
    };
    await step(['domain'], 'Custom domains', () => cf.customDomains());
    await step(['route'], 'Routes', async () => {
      const r = await cf.routes(Math.max(1, Math.min(MAX_ZONES, left() - 15)));
      if (r.zonesSkipped) {
        warnings.push(`Routes: ${r.zonesSkipped} zones not checked this run.`);
        // Replace stored routes only for the zones read; keep the rest instead of deleting them.
        routeZones = r.zonesChecked;
      }
      return r.items;
    });
    const st = await cf.storage();
    refreshed.push(...st.items);
    const storageLabel = { kv: 'KV', d1: 'D1', r2: 'R2', queues: 'Queues' } as const;
    for (const k of ['kv', 'd1', 'r2', 'queues'] as const) if (!st.failed.includes(storageLabel[k])) refreshedKinds.add(k);
    if (st.failed.length) warnings.push(`Storage lists unavailable: ${st.failed.join(', ')} (add the matching Read permissions to the token).`);
    if (config.modules.exposure && config.modules.access) {
      await step(['access'], 'Access applications', () => cf.accessApps());
      if (refreshedKinds.has('access')) settings.access_listed_at = stamp;
    }
    if (config.plan === 'auto' && !config.accounts[accountId]?.plan) {
      detectedPlan = (await cf.detectPlan()) ?? detectedPlan;
    }
    // The update check is install-wide: one account's inventory run does it for all.
    if (config.updateCheck && now.getTime() - new Date(global.update_checked_at ?? 0).getTime() > 20 * HOUR) {
      await checkForUpdate(global).catch((e: Error) => warnings.push(`Update check failed: ${e.message}`));
      global.update_checked_at = stamp;
    }
  }

  // 6. Per-Worker detail on a rotating cursor: settings (bindings), deployments, schedules.
  const checkedAt = new Map(known.map((k) => [k.name, k.detail_checked_at]));
  const due = inventory
    .filter((w) => !checkedAt.get(w.name) || now.getTime() - new Date(checkedAt.get(w.name)!).getTime() > DETAIL_MAX_AGE)
    .sort((a, b) => (checkedAt.get(a.name) ?? '').localeCompare(checkedAt.get(b.name) ?? ''));
  const wantSettings = config.modules.deprecation || config.modules.zombies;
  const wantDeploys = config.modules.timeline;
  const details: { name: string; settings: ScriptSettings | null; deployments: Deployment[] | null; crons: string[] | null }[] = [];
  let detailRemaining = 0;
  for (const w of due) {
    const isCron = w.handlers.includes('scheduled');
    const cost = (wantSettings ? 1 : 0) + (wantDeploys ? 1 : 0) + (isCron ? 1 : 0);
    if (cost > left()) {
      detailRemaining = due.length - details.length;
      break;
    }
    const d: (typeof details)[number] = { name: w.name, settings: null, deployments: null, crons: null };
    try {
      if (wantSettings) d.settings = await cf.scriptSettings(w.name);
      if (wantDeploys) d.deployments = await cf.deployments(w.name);
      if (isCron) d.crons = await cf.schedules(w.name);
    } catch (e) {
      warnings.push(`Details for ${w.name} unavailable: ${(e as Error).message}`);
    }
    details.push(d);
  }
  if (detailRemaining) warnings.push(`${detailRemaining} Workers will get their details on the next runs.`);

  // 7. Write everything in one batch. ?1 is always the account.
  const j = JSON.stringify;
  const A = accountId;
  const writes: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO workers (account, name, has_modules, compatibility_date, compat_flags, handlers, usage_model, created_on, modified_on,
         deployed_on, workers_dev, previews_enabled, logs_enabled, sampling_rate, logpush, tags, last_seen, first_seen)
       SELECT ?1, json_extract(value,'$.name'), json_extract(value,'$.has_modules'), json_extract(value,'$.compatibility_date'),
         json_extract(value,'$.compat_flags'), json_extract(value,'$.handlers'), json_extract(value,'$.usage_model'),
         json_extract(value,'$.created_on'), json_extract(value,'$.modified_on'), json_extract(value,'$.deployed_on'),
         json_extract(value,'$.workers_dev'), json_extract(value,'$.previews_enabled'), json_extract(value,'$.logs_enabled'),
         json_extract(value,'$.sampling_rate'), json_extract(value,'$.logpush'), json_extract(value,'$.tags'),
         json_extract(value,'$.last_seen'), json_extract(value,'$.last_seen')
       FROM json_each(?2) WHERE true
       ON CONFLICT(account, name) DO UPDATE SET has_modules=excluded.has_modules, compatibility_date=excluded.compatibility_date,
         compat_flags=COALESCE(excluded.compat_flags, workers.compat_flags),
         handlers=excluded.handlers, usage_model=excluded.usage_model, created_on=excluded.created_on,
         modified_on=excluded.modified_on, deployed_on=excluded.deployed_on, workers_dev=excluded.workers_dev,
         previews_enabled=excluded.previews_enabled, logs_enabled=excluded.logs_enabled,
         sampling_rate=excluded.sampling_rate, logpush=excluded.logpush, tags=excluded.tags, last_seen=excluded.last_seen`,
    ).bind(A, j(inventory.map((w) => ({ ...w, handlers: j(w.handlers), tags: j(w.tags), compat_flags: w.compat_flags ? j(w.compat_flags) : null })))),
    db.prepare('DELETE FROM workers WHERE account = ?1 AND last_seen <> ?2').bind(A, stamp),
    db.prepare(
      `INSERT INTO metrics_hourly (account, script, hour, requests, errors, subrequests, cpu_p99, cpu_time_us)
       SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.requests'),
         json_extract(value,'$.errors'), json_extract(value,'$.subrequests'), json_extract(value,'$.cpuP99'), json_extract(value,'$.cpuTimeUs')
       FROM json_each(?2) WHERE true
       ON CONFLICT(account, script, hour) DO UPDATE SET requests=excluded.requests, errors=excluded.errors,
         subrequests=excluded.subrequests, cpu_p99=excluded.cpu_p99, cpu_time_us=excluded.cpu_time_us`,
    ).bind(A, j(hourly)),
    db.prepare(
      `INSERT INTO metrics_hourly (account, script, hour, exceeded)
       SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.count')
       FROM json_each(?2) WHERE true
       ON CONFLICT(account, script, hour) DO UPDATE SET exceeded=excluded.exceeded`,
    ).bind(A, j(exceeded)),
    // Detail: bindings, flags, schedules, deployments.
    db.prepare(
      `UPDATE workers SET
         bindings = COALESCE(json_extract(d.value,'$.bindings'), workers.bindings),
         compat_flags = COALESCE(json_extract(d.value,'$.flags'), workers.compat_flags),
         detail_checked_at = ?3
       FROM json_each(?2) AS d WHERE workers.account = ?1 AND workers.name = json_extract(d.value,'$.name')`,
    ).bind(
      A,
      j(details.map((d) => ({
        name: d.name,
        bindings: d.settings ? j([...d.settings.bindings, ...d.settings.tail_consumers.map((t) => ({ type: 'tail_consumer', name: t, target: t }))]) : null,
        flags: d.settings ? j(d.settings.compatibility_flags) : null,
      }))),
      stamp,
    ),
    db.prepare(
      `INSERT INTO schedules (account, script, crons, checked_at)
       SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.crons'), ?3 FROM json_each(?2) WHERE true
       ON CONFLICT(account, script) DO UPDATE SET crons=excluded.crons, checked_at=excluded.checked_at`,
    ).bind(A, j(details.filter((d) => d.crons).map((d) => ({ script: d.name, crons: j(d.crons) }))), stamp),
    db.prepare(`DELETE FROM schedules WHERE account = ?1 AND script NOT IN (SELECT value FROM json_each(?2))`).bind(A, j(scheduled)),
    db.prepare(
      `INSERT INTO deployments (account, script, id, created_on, author, message, source)
       SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.id'), json_extract(value,'$.created_on'),
         json_extract(value,'$.author'), json_extract(value,'$.message'), json_extract(value,'$.source')
       FROM json_each(?2) WHERE true
       ON CONFLICT(account, script, id) DO NOTHING`,
    ).bind(A, j(details.flatMap((d) => (d.deployments ?? []).map((x) => ({ ...x, script: d.name }))))),
    db.prepare(`INSERT INTO fleet_events (account, at, kind, script) SELECT ?1, json_extract(value,'$.at'), json_extract(value,'$.kind'), json_extract(value,'$.script') FROM json_each(?2) WHERE true`).bind(A, j(fleetEvents)),
  ];
  if (cronRuns) {
    writes.push(
      db.prepare(
        `INSERT INTO cron_runs (account, script, hour, runs, failures, cpu_max_ms)
         SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.runs'),
           json_extract(value,'$.failures'), json_extract(value,'$.cpuMaxMs')
         FROM json_each(?2) WHERE true
         ON CONFLICT(account, script, hour) DO UPDATE SET runs=excluded.runs, failures=excluded.failures, cpu_max_ms=excluded.cpu_max_ms`,
      ).bind(A, j(cronRuns)),
    );
  }
  if (resourceOps.length) {
    writes.push(
      db.prepare(
        `INSERT INTO resource_hourly (account, kind, resource, hour, ops)
         SELECT ?1, json_extract(value,'$.kind'), json_extract(value,'$.resource'), json_extract(value,'$.hour'), json_extract(value,'$.ops')
         FROM json_each(?2) WHERE true
         ON CONFLICT(account, kind, resource, hour) DO UPDATE SET ops=excluded.ops`,
      ).bind(A, j(resourceOps)),
    );
  }
  if (refreshDue) {
    writes.push(
      db.prepare(`DELETE FROM resources WHERE account = ?1 AND kind IN (SELECT value FROM json_each(?2))`)
        .bind(A, j([...refreshedKinds].filter((k) => !(k === 'route' && routeZones)))),
      ...(routeZones
        ? [db.prepare(`DELETE FROM resources WHERE account = ?1 AND kind = 'route' AND json_extract(extra, '$.zone') IN (SELECT value FROM json_each(?2))`).bind(A, j(routeZones))]
        : []),
      db.prepare(
        `INSERT INTO resources (account, kind, id, name, script, extra)
         SELECT ?1, json_extract(value,'$.kind'), json_extract(value,'$.id'), json_extract(value,'$.name'), json_extract(value,'$.script'), json_extract(value,'$.extra')
         FROM json_each(?2) WHERE true ON CONFLICT(account, kind, id) DO NOTHING`,
      ).bind(A, j(refreshed.filter((r) => refreshedKinds.has(r.kind)).map((r) => ({ ...r, extra: r.extra ? j(r.extra) : null })))),
      // Retention, once per inventory refresh.
      ...retentionDeletes(db, A, now, config.retentionDays),
      upsertAccount(db, { id: A, detectedPlan }, now),
    );
  }
  writes.push(
    setAccountState(db, A, {
      ...(settings.cpu_sum ? { cpu_sum: settings.cpu_sum } : {}),
      ...(settings.cron_cpu ? { cron_cpu: settings.cron_cpu } : {}),
      ...(settings.ops_checked ? { ops_unavailable: settings.ops_unavailable ?? '', ops_checked: settings.ops_checked } : {}),
      ...(refreshDue ? { inventory_at: stamp, workers_subdomain: subdomain ?? '' } : {}),
      ...(settings.access_listed_at ? { access_listed_at: settings.access_listed_at } : {}),
      ...(settings.first_metrics_at ? {} : { first_metrics_at: stamp }),
      ...(config.modules.cron && scheduled.length && cronRetryDue ? { cron_dataset: cronRuns || cronTruncated ? 'available' : 'unavailable', cron_dataset_checked: stamp } : {}),
    }),
  );
  if (global.update_checked_at === stamp) {
    writes.push(setSettings(db, {
      update_checked_at: stamp,
      ...(global.latest_version ? { latest_version: global.latest_version, latest_url: global.latest_url ?? '' } : {}),
    }));
  }
  await db.batch(writes);

  // 8. Checks.
  // Judge crons only on runs fetched in this scan: stored rows from an earlier scan lack the recent hours.
  const facts = await loadFacts(db, accountId, now, config, settings, cronRuns ? { from: cronFrom, to: cronTo } : null, subdomain);
  // No runs at all for any scheduled Worker, Ambersight's own cron included, means Cloudflare
  // returned no data, not that every cron stopped. Say so instead of raising a missed run per Worker.
  const cronDataEmpty = (facts.crons?.length ?? 0) > 0 && (cronRuns ?? []).every((r) => r.runs === 0);
  if (cronDataEmpty) warnings.push('Cron checks paused: Cloudflare returned no scheduled runs for any Worker in the last 24 hours, not even Ambersight\'s own.');
  const findings = runChecks({
    now,
    plan,
    accountRequestsToday: facts.accountToday,
    workers: facts.stats,
    crons: cronDataEmpty ? [] : facts.crons,
    cronTotal: facts.cronTotal,
    resources: facts.resources,
    meta: facts.meta,
    inventory: facts.inventory,
    config,
    thresholdsFor: facts.thresholdsFor,
  });
  // Checks the user switched off are dropped here, so their open findings resolve like fixed ones.
  const muted = new Set(config.mutedChecks);
  // While cron checks are paused (too many runs to count, or no data at all), keep existing cron
  // findings as they are rather than resolving them as if every cron had recovered.
  const keepModules = cronTruncated || cronDataEmpty ? ['cron'] : [];
  await saveFindings(db, accountId, muted.size ? findings.filter((f) => !muted.has(checkOf(f))) : findings, stamp, keepModules);

  // 9. Alerts and digest, then the run's own cost.
  await sendAlerts(env, now, config).catch((e: Error) => warnings.push(`Alerts failed: ${e.message}`));
  await db.batch([
    setAccountState(db, A, {
      last_scan_at: stamp,
      last_scan_calls: String(cf.calls),
      last_scan_ms: String(Date.now() - started),
      last_scan_warnings: j(warnings),
      scan_failures: '0',
    }),
    recordUsage(db, now, { cronRuns: 1, subrequests: cf.calls, rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten }),
  ]);

  return { workers: inventory.length, findings: findings.length, subrequests: cf.calls, warnings, detailRemaining };
}

export function inventoryDue(now: Date, last: string | null, config: Config): boolean {
  if (!last) return true;
  const age = now.getTime() - new Date(last).getTime();
  const interval = config.inventoryIntervalHours * HOUR;
  if (age >= interval + 2 * HOUR) return true; // missed the preferred hour: catch up
  if (age < interval - HOUR) return false;
  return config.inventoryIntervalHours % 24 !== 0 || now.getUTCHours() === config.inventoryHourUtc;
}

function retentionDeletes(db: D1Database, account: string, now: Date, days: number): D1PreparedStatement[] {
  const cutoff = new Date(now.getTime() - days * DAY);
  const hour = isoHour(cutoff);
  const iso = cutoff.toISOString();
  return [
    db.prepare('DELETE FROM metrics_hourly WHERE account = ?1 AND hour < ?2').bind(account, hour),
    db.prepare('DELETE FROM cron_runs WHERE account = ?1 AND hour < ?2').bind(account, hour),
    db.prepare('DELETE FROM resource_hourly WHERE account = ?1 AND hour < ?2').bind(account, hour),
    db.prepare(`DELETE FROM findings WHERE account = ?1 AND status = 'resolved' AND last_seen < ?2`).bind(account, iso),
    db.prepare('DELETE FROM deployments WHERE account = ?1 AND created_on < ?2').bind(account, iso),
    db.prepare('DELETE FROM fleet_events WHERE account = ?1 AND at < ?2').bind(account, iso),
    // Install-wide tables: any account's refresh may tidy them.
    db.prepare('DELETE FROM usage_daily WHERE day < ?1').bind(iso.slice(0, 10)),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now.toISOString()),
  ];
}

async function checkForUpdate(settings: Settings): Promise<void> {
  const res = await allowedFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'ambersight-update-check', Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return; // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const r = (await res.json()) as { tag_name?: string; html_url?: string };
  if (r.tag_name) {
    settings.latest_version = r.tag_name;
    settings.latest_url = r.html_url ?? `https://github.com/${REPO}/releases`;
  }
}

export function updateNotice(settings: Settings): { current: string; latest: string; url: string } | null {
  const latest = settings.latest_version;
  return latest && isNewer(latest, VERSION) ? { current: VERSION, latest, url: settings.latest_url || `https://github.com/${REPO}/releases` } : null;
}

interface InventoryRow {
  name: string;
  has_modules: number | null;
  compatibility_date: string | null;
  compat_flags: string[] | null;
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
      compat_flags: s.compatibility_flags ?? null,
      handlers: s.handlers ?? [],
      usage_model: s.usage_model ?? null,
      created_on: s.created_on ?? w?.created_on ?? null,
      modified_on: s.modified_on ?? w?.updated_on ?? null,
      deployed_on: w ? (w.deployed_on ?? null) : null,
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

interface WorkerRow {
  name: string;
  has_modules: number | null;
  compatibility_date: string | null;
  compat_flags: string | null;
  handlers: string | null;
  usage_model: string | null;
  deployed_on: string | null;
  workers_dev: number | null;
  previews_enabled: number | null;
  logs_enabled: number | null;
  sampling_rate: number | null;
  logpush: number | null;
  tags: string | null;
  bindings: string | null;
  detail_checked_at: string | null;
}

const bool = (v: number | null) => (v == null ? null : v === 1);
const parse = <T>(s: string | null, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);

export interface Facts {
  accountToday: number;
  stats: WorkerStats[];
  meta: WorkerMeta[];
  crons: CronStats[] | null;
  cronTotal: number | null;
  resources: ResourceStats[];
  inventory: InventoryFacts;
  thresholdsFor: (name: string) => ReturnType<typeof thresholdsFor>;
}

/** Everything the checks need, from D1, in one batch. Out-of-scope Workers are left out. */
export async function loadFacts(
  db: D1Database, account: string, now: Date, config: Config, settings: Settings, cronWindow: { from: Date; to: Date } | null, subdomain: string | null,
): Promise<Facts> {
  const lastFullHour = isoHour(new Date(hourFloor(now).getTime() - HOUR));
  const dayAgo = isoHour(new Date(now.getTime() - DAY));
  const weekAgo = isoHour(new Date(now.getTime() - 7 * DAY));
  const zombieFrom = isoHour(new Date(now.getTime() - Math.min(config.thresholds.zombieDays, config.retentionDays) * DAY));
  const deployFrom = new Date(now.getTime() - 26 * HOUR - config.thresholds.deployWindowMinutes * 60_000).toISOString();
  const cronFrom = cronWindow ? isoHour(cronWindow.from) : lastFullHour;
  const cronTo = cronWindow ? isoHour(cronWindow.to) : lastFullHour;

  const [workersR, histR, windowR, todayR, schedR, runsR, resR, opsR, depR] = await db.batch([
    db.prepare('SELECT * FROM workers WHERE account = ?1').bind(account),
    db.prepare(
      `SELECT script, hour, requests, errors, subrequests, cpu_time_us, exceeded, cpu_p99 FROM metrics_hourly
       WHERE account = ?1 AND hour >= ?2 ORDER BY hour`,
    ).bind(account, weekAgo),
    db.prepare('SELECT script, SUM(requests) AS requests FROM metrics_hourly WHERE account = ?1 AND hour >= ?2 GROUP BY script').bind(account, zombieFrom),
    db.prepare('SELECT COALESCE(SUM(requests),0) AS n FROM metrics_hourly WHERE account = ?1 AND hour >= ?2').bind(account, isoHour(utcMidnight(now))),
    db.prepare('SELECT script, crons FROM schedules WHERE account = ?1').bind(account),
    db.prepare('SELECT script, hour, runs, failures, cpu_max_ms FROM cron_runs WHERE account = ?1 AND hour >= ?2 AND hour < ?3').bind(account, cronFrom, cronTo),
    db.prepare('SELECT kind, id, name, script, extra FROM resources WHERE account = ?1').bind(account),
    db.prepare('SELECT kind, resource, hour, ops FROM resource_hourly WHERE account = ?1 AND hour >= ?2').bind(account, weekAgo),
    db.prepare('SELECT script, id, created_on FROM deployments WHERE account = ?1 AND created_on >= ?2').bind(account, deployFrom),
  ]);

  const allRows = workersR.results as unknown as WorkerRow[];
  const groupsOf = new Map(allRows.map((w) => [w.name, groupsFor(config, w.name, parse<string[]>(w.tags, []))]));
  const rows = allRows.filter((w) => inScope(config, w.name, groupsOf.get(w.name)!));
  const tf = (name: string) => thresholdsFor(config, name, groupsOf.get(name) ?? []);

  // Metrics per Worker.
  type H = { script: string; hour: string; requests: number; errors: number; subrequests: number; cpu_time_us: number; exceeded: number; cpu_p99: number | null };
  const hist = new Map<string, H[]>();
  for (const h of histR.results as unknown as H[]) {
    const list = hist.get(h.script) ?? [];
    list.push(h);
    hist.set(h.script, list);
  }
  const windowBy = new Map((windowR.results as { script: string; requests: number }[]).map((r) => [r.script, r.requests]));
  const stats: WorkerStats[] = rows.map(({ name }) => {
    const hs = hist.get(name) ?? [];
    const day = hs.filter((h) => h.hour >= dayAgo);
    const prev = hs.filter((h) => h.hour < dayAgo);
    const before = hs.filter((h) => h.hour < lastFullHour);
    const last = hs.find((h) => h.hour === lastFullHour);
    const sum = (list: H[], k: 'requests' | 'errors' | 'exceeded') => list.reduce((a, h) => a + (h[k] ?? 0), 0);
    const cpu = day.map((h) => h.cpu_p99).filter((v): v is number => v != null);
    return {
      name,
      requests24h: sum(day, 'requests'),
      errors24h: sum(day, 'errors'),
      requestsPrev: sum(prev, 'requests'),
      errorsPrev: sum(prev, 'errors'),
      exceeded24h: sum(day, 'exceeded'),
      cpuP99Max24h: cpu.length ? Math.max(...cpu) : null,
      lastHourRequests: last?.requests ?? 0,
      hourlyMedian7d: median(before.map((h) => h.requests)),
      lastHourCpuUs: last?.cpu_time_us ?? 0,
      hourlyMedianCpuUs7d: median(before.map((h) => h.cpu_time_us ?? 0)),
      lastHourSubrequests: last?.subrequests ?? 0,
      hourlyMedianSubrequests7d: median(before.map((h) => h.subrequests ?? 0)),
      historyHours: before.length + (last ? 1 : 0),
      hours24: day.map((h): HourPoint => ({ hour: h.hour, requests: h.requests, errors: h.errors })),
      requestsWindow: windowBy.get(name) ?? 0,
    };
  });

  // Metadata and deployments.
  const deps = new Map<string, { id: string; createdOn: string }[]>();
  for (const d of depR.results as { script: string; id: string; created_on: string }[]) {
    const list = deps.get(d.script) ?? [];
    list.push({ id: d.id, createdOn: d.created_on });
    deps.set(d.script, list);
  }
  const meta: WorkerMeta[] = rows.map((w) => ({
    name: w.name,
    groups: groupsOf.get(w.name)!,
    handlers: parse<string[]>(w.handlers, []),
    hasModules: bool(w.has_modules),
    compatibilityDate: w.compatibility_date,
    compatibilityFlags: parse<string[]>(w.compat_flags, []),
    usageModel: w.usage_model,
    bindings: w.detail_checked_at ? parse(w.bindings, []) : null,
    workersDev: bool(w.workers_dev),
    previewsEnabled: bool(w.previews_enabled),
    logsEnabled: bool(w.logs_enabled),
    samplingRate: w.sampling_rate,
    logpush: bool(w.logpush),
    deployedOn: w.deployed_on,
    listed: w.workers_dev != null || w.previews_enabled != null,
    deployments: deps.get(w.name) ?? [],
  }));
  const inScopeNames = new Set(rows.map((r) => r.name));

  // Cron stats per schedule, with the run of bad slots at the end.
  let crons: CronStats[] | null = null;
  const schedules = schedR.results as { script: string; crons: string }[];
  if (cronWindow) {
    type R = { script: string; hour: string; runs: number; failures: number; cpu_max_ms: number | null };
    const runs = new Map<string, Map<string, R>>();
    for (const r of runsR.results as unknown as R[]) {
      const m = runs.get(r.script) ?? new Map<string, R>();
      m.set(r.hour, r);
      runs.set(r.script, m);
    }
    crons = [];
    // A deploy can add or change a schedule: expect runs only from the first full hour after it.
    const deployedAt = new Map(rows.map((w) => [w.name, w.deployed_on ? new Date(w.deployed_on).getTime() : 0]));
    for (const s of schedules) {
      if (!inScopeNames.has(s.script)) continue;
      const from = new Date(Math.max(cronWindow.from.getTime(), Math.ceil((deployedAt.get(s.script) ?? 0) / HOUR) * HOUR));
      const stat = cronStats(s.script, parse<string[]>(s.crons, []), runs.get(s.script) ?? new Map(), from, cronWindow.to);
      if (stat) crons.push(stat);
    }
  }
  const scheduledCount = rows.filter((w) => parse<string[]>(w.handlers, []).includes('scheduled')).length;
  const cronTotal = schedules.length >= scheduledCount ? schedules.reduce((n, s) => n + parse<string[]>(s.crons, []).length, 0) : null;

  // Resources.
  type Res = { kind: string; id: string; name: string | null; script: string | null; extra: string | null };
  const res = resR.results as unknown as Res[];
  const labelOf = new Map(res.map((r) => [`${r.kind}|${r.id}`, r.name ?? r.id]));
  const bindingOwner = new Map<string, string>();
  for (const m of meta) for (const b of m.bindings ?? []) if (b.target && !bindingOwner.has(b.target)) bindingOwner.set(b.target, m.name);
  type Op = { kind: ResourceStats['kind']; resource: string; hour: string; ops: number };
  const opsBy = new Map<string, Op[]>();
  for (const o of opsR.results as unknown as Op[]) {
    const k = `${o.kind}|${o.resource}`;
    opsBy.set(k, [...(opsBy.get(k) ?? []), o]);
  }
  const resources: ResourceStats[] = [...opsBy.entries()].map(([k, list]) => {
    const [kind, resource] = k.split('|') as [ResourceStats['kind'], string];
    const last = list.find((o) => o.hour === lastFullHour);
    const before = list.filter((o) => o.hour < lastFullHour);
    const label = kind === 'do' ? `Durable Objects in ${resource}` : (labelOf.get(`${kind}|${resource}`) ?? resource);
    const script = kind === 'do' ? resource : (bindingOwner.get(resource) ?? '*');
    return { kind, resource, label, script, lastHour: last?.ops ?? 0, median7d: median(before.map((o) => o.ops)), historyHours: before.length + (last ? 1 : 0) };
  });

  const firstMetrics = settings.first_metrics_at ? new Date(settings.first_metrics_at).getTime() : now.getTime();
  const inventory: InventoryFacts = {
    bindingsComplete: allRows.every((w) => w.detail_checked_at),
    refreshed: Boolean(settings.inventory_at) || res.length > 0,
    storage: res.filter((r) => ['kv', 'd1', 'r2', 'queues'].includes(r.kind)).map((r) => ({ kind: r.kind as 'kv', id: r.id, name: r.name, inUse: parse<{ inUse?: boolean }>(r.extra, {}).inUse === true })),
    routes: res.filter((r) => r.kind === 'route').map((r) => ({ id: r.id, pattern: r.name ?? '', script: r.script })),
    domains: res.filter((r) => r.kind === 'domain').map((r) => ({ id: r.id, hostname: r.name ?? '', script: r.script })),
    // A successful listing with zero apps means nothing is covered, not that the check is off.
    accessDomains: config.modules.access && (res.some((r) => r.kind === 'access') || Boolean(settings.access_listed_at))
      ? res.filter((r) => r.kind === 'access').flatMap((r) => parse<{ domains?: string[] }>(r.extra, {}).domains ?? [])
      : null,
    workersSubdomain: subdomain || null,
    trackingDays: Math.floor((now.getTime() - firstMetrics) / DAY),
    retentionDays: config.retentionDays,
  };

  return {
    accountToday: (todayR.results[0] as { n: number }).n,
    stats,
    meta,
    crons,
    cronTotal,
    resources,
    inventory,
    thresholdsFor: tf,
  };
}

/** Expected vs observed runs in [from, to), plus how many of the latest expected slots went bad in a row. */
export function cronStats(
  name: string, exprs: string[], runs: Map<string, { runs: number; failures: number; cpu_max_ms: number | null }>, from: Date, to: Date,
): CronStats | null {
  let expected = 0;
  const slots: { hour: string; expected: number }[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += HOUR) {
    let n = 0;
    for (const expr of exprs) {
      try {
        n += countRuns(expr, new Date(t), new Date(t + HOUR));
      } catch {
        // Unsupported expression: skip rather than raise a false alarm.
      }
    }
    if (n) slots.push({ hour: isoHour(new Date(t)), expected: n });
    expected += n;
  }
  if (!expected) return null;
  let observed = 0;
  let failures = 0;
  let cpuMaxMs: number | null = null;
  for (const [hour, r] of runs) {
    const t = new Date(hour).getTime();
    if (t < from.getTime() || t >= to.getTime()) continue;
    observed += r.runs;
    failures += r.failures;
    if (r.cpu_max_ms != null) cpuMaxMs = Math.max(cpuMaxMs ?? 0, r.cpu_max_ms);
  }
  let consecutiveBad = 0;
  for (let i = slots.length - 1; i >= 0; i--) {
    const r = runs.get(slots[i].hour);
    const bad = Math.max(0, slots[i].expected - (r?.runs ?? 0)) + (r?.failures ?? 0);
    if (!bad) break;
    consecutiveBad += bad;
  }
  return { name, expected, observed, failures, consecutiveBad, cpuMaxMs };
}

/** Stored finding IDs carry the account, so the same check on a same-named Worker in two accounts stays apart. */
export const findingKey = (account: string, id: string) => `${account}/${id}`;

async function saveFindings(db: D1Database, account: string, findings: Finding[], stamp: string, keepModules: string[] = []): Promise<void> {
  const rows = findings.map((f) => ({ ...f, id: findingKey(account, f.id), evidence: JSON.stringify(f.evidence), docsUrl: f.docsUrl ?? null }));
  await db.batch([
    db.prepare(
      `INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, docs_url, first_seen, last_seen, status)
       SELECT json_extract(value,'$.id'), ?3, json_extract(value,'$.script'), json_extract(value,'$.module'),
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
    ).bind(JSON.stringify(rows), stamp, account),
    db.prepare(
      `UPDATE findings SET status = 'resolved'
       WHERE account = ?3 AND last_seen <> ?1 AND status <> 'resolved' AND module NOT IN (SELECT value FROM json_each(?2))`,
    ).bind(stamp, JSON.stringify(keepModules), account),
  ]);
}
