// The scan: read inventory and metrics from Cloudflare, store them in D1, run the checks.
// Built for the Workers Free plan: 50 subrequests and 50 D1 queries per cron run, so
// per-Worker detail is fetched a few Workers at a time on a rotating cursor and the run
// stops cleanly when its subrequest budget is spent.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope, thresholdsFor, type Config } from '../shared/config';
import { checkOf } from '../shared/findings';
import type { Finding } from '../shared/types';
import type { QuotaMetric, StorageKind } from '../shared/limits';
import { CfClient, CronRunsTruncated, type ApiScript, type ApiWorker, type AuditEvent, type CfAlert, type CronRunRow, type D1Query, type Deployment, type InventoryItem, type QuotaRow, type ResourceOps, type ScriptSettings, type StorageSize, type Zone } from './cf';
import { median, runChecks, type CronStats, type HourPoint, type ResourceStats, type WorkerMeta, type WorkerStats } from './checks';
import { countRuns } from './cron';
import { configFrom, getAccountState, getSettings, hourFloor, isoHour, planFrom, recordUsage, setAccountState, setSettings, upsertAccount, utcMidnight, type Settings } from './db';
import type { Env } from './env';
import type { InventoryFacts } from './hygiene';
import type { ChangeFacts } from './security';
import { metered } from './meter';
import { fetchIncidents, type Incident } from './incidents';
import { allowedFetch } from './net';
import { sendAlerts } from './notify';
import { isNewer, REPO, VERSION } from './version';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Subrequests per run, leaving room for alerts and the update check. */
const BUDGET = { free: 42, paid: 900 };
const DETAIL_MAX_AGE = 6 * HOUR;
/** Per-zone tasks (routes, certificates, DNS) are refreshed this often, a few zones per scan. */
const ZONE_TASK_MAX_AGE = DAY - HOUR;

export interface ScanResult {
  skipped?: boolean;
  workers: number;
  findings: number;
  subrequests: number;
  /** D1 statements this scan ran; the Free plan allows 50 per invocation. */
  d1Queries?: number;
  warnings: string[];
  detailRemaining?: number;
  /** Per-zone checks still waiting for a later scan. */
  zonesRemaining?: number;
}

/**
 * Scans one account. The scheduler (scheduler.ts) decides which account is due. `continuation`
 * (from the scan queue) only carries on with what the last scan could not finish, per-Worker
 * detail and zones, and skips the reads and alerts that scan already did.
 */
export async function runScan(rawEnv: Env, now = new Date(), opts: { account: string; force?: boolean; continuation?: boolean }): Promise<ScanResult> {
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
    .prepare(
      `SELECT name, detail_checked_at, bindings, bindings LIKE '%durable_object_namespace%' AS has_do,
         bindings LIKE '%"type":"workflow"%' AS has_workflow, bindings LIKE '%"type":"ai"%' AS has_ai
       FROM workers WHERE account = ?1`,
    )
    .bind(accountId)
    .all<{ name: string; detail_checked_at: string | null; bindings: string | null; has_do: number | null; has_workflow: number | null; has_ai: number | null }>();
  const knownNames = new Set(known.map((k) => k.name));
  const currentNames = new Set(inventory.map((w) => w.name));
  const fleetEvents: { at: string; kind: string; script: string; detail?: string }[] = knownNames.size
    ? [
        ...inventory.filter((w) => !knownNames.has(w.name)).map((w) => ({ at: stamp, kind: 'added', script: w.name })),
        ...[...knownNames].filter((n) => !currentNames.has(n)).map((n) => ({ at: stamp, kind: 'removed', script: n })),
      ]
    : [];

  // 2. Metrics since the last stored hour (at most 48 h back).
  // The last hour stored is kept in the account state: a MAX() over metrics would be a query per scan.
  // Fetching from that hour again completes it (the previous scan saw it partly) and adds the new ones.
  const lastHour = settings.metrics_hour || null;
  const since = lastHour
    ? new Date(Math.max(new Date(lastHour).getTime(), now.getTime() - 48 * HOUR))
    : new Date(hourFloor(now).getTime() - 48 * HOUR);
  const light = opts.continuation === true;
  const cpuSum = settings.cpu_sum !== 'unsupported';
  const [hourly, exceeded] = light ? [[], []] : await Promise.all([
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
  const cronTried = !light && config.modules.cron && scheduled.length > 0 && cronRetryDue;
  if (cronTried) {
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
  const quotaRows: QuotaRow[] = [];
  if (config.modules.usage && !light) {
    const { results: kindRows } = await db.prepare(`SELECT DISTINCT kind FROM resources WHERE account = ?1 AND kind IN ('kv','d1','r2','queues')`).bind(accountId).all<{ kind: ResourceOps['kind'] }>();
    const kinds = kindRows.map((k) => k.kind);
    if (known.some((k) => k.has_do) || inventory.some((w) => w.handlers.includes('alarm'))) kinds.push('do');
    const failedBefore = new Set((settings.ops_unavailable ?? '').split(',').filter(Boolean));
    const retryFailed = now.getTime() - new Date(settings.ops_checked ?? 0).getTime() > DAY;
    const tryKinds = kinds.filter((k) => retryFailed || !failedBefore.has(k)).slice(0, Math.max(0, left() - 20));
    // Whole hours since the last stored hour (at most 48 h): the daily quota totals need every hour,
    // and a window starting mid-hour would overwrite a full hour with part of it.
    const opsFrom = hourFloor(since);
    if (tryKinds.length) {
      // Kinds whose richer query (D1 rows, KV by action) the account rejected; retried with the others daily.
      const simple = new Set(retryFailed ? [] : (settings.ops_simple ?? '').split(',').filter(Boolean));
      const r = await cf.resourceOps(opsFrom, now, tryKinds, simple);
      resourceOps = r.rows;
      if (retryFailed || r.failed.length || r.downgraded.length) {
        settings.ops_unavailable = r.failed.join(',');
        settings.ops_simple = [...new Set([...simple, ...r.downgraded])].join(',');
        settings.ops_checked = stamp;
      }
    }
    // Workflows and Workers AI, only for accounts that bind them; an unavailable dataset is retried daily.
    const extraFailed = new Set(retryFailed ? [] : (settings.quota_unavailable ?? '').split(',').filter(Boolean));
    const extras: [string, boolean, () => Promise<QuotaRow[]>][] = [
      ['workflows', known.some((k) => k.has_workflow), () => cf.workflowSteps(opsFrom, now)],
      ['ai', known.some((k) => k.has_ai), () => cf.aiNeurons(opsFrom, now)],
    ];
    const failedNow: string[] = [];
    for (const [name, used, run] of extras) {
      if (!used || extraFailed.has(name) || left() <= 20) continue;
      try {
        quotaRows.push(...(await run()));
      } catch {
        failedNow.push(name);
      }
    }
    if (retryFailed || failedNow.length) settings.quota_unavailable = [...new Set([...(retryFailed ? [] : extraFailed), ...failedNow])].join(',');
    // Account-wide totals per metric and hour.
    const totals = new Map<string, QuotaRow>();
    const add = (metric: QuotaMetric, hour: string, value: number) => {
      const key = `${metric}|${hour}`;
      const row = totals.get(key) ?? { metric, hour, value: 0 };
      row.value += value;
      totals.set(key, row);
    };
    for (const r of resourceOps) for (const [m, v] of Object.entries(r.metrics ?? {})) add(m as QuotaMetric, r.hour, v ?? 0);
    for (const r of quotaRows.splice(0)) add(r.metric, r.hour, r.value);
    quotaRows.push(...totals.values());
  }
  // Workers requests and CPU per hour feed the cost estimate (and outlive the metrics retention).
  {
    const totals = new Map<string, QuotaRow>();
    for (const h of hourly) {
      for (const [metric, value] of [['workers.requests', h.requests], ['workers.cpuMs', h.cpuTimeUs / 1000]] as const) {
        const key = `${metric}|${h.hour}`;
        const row = totals.get(key) ?? { metric, hour: h.hour, value: 0 };
        row.value += value;
        totals.set(key, row);
      }
    }
    quotaRows.push(...totals.values());
  }

  // 5. Full inventory refresh: custom domains, routes, storage, Access, update check.
  const refreshDue = !light && inventoryDue(now, settings.inventory_at ?? null, config);
  const refreshed: InventoryItem[] = [];
  const refreshedKinds = new Set<InventoryItem['kind']>();
  let zoneList: Zone[] | null = null;
  let incidents: Incident[] | null = null;
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
    // Routes, certificates and DNS are read per zone on a cursor (step 5d); here only the list.
    try {
      zoneList = await cf.listZones();
    } catch (e) {
      warnings.push(`Zones unavailable: ${(e as Error).message}`);
    }
    if (config.modules.pages) {
      await step(['pages'], 'Pages projects', async () =>
        (await cf.pagesProjects()).map((p) => ({ kind: 'pages' as const, id: p.name, name: p.name, script: p.productionScript, extra: { ...p } })),
      );
      // Only a list that loaded counts as "these are all the projects" for the dangling-DNS check.
      if (refreshedKinds.has('pages')) settings.pages_listed_at = stamp;
    }
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
    // The token's own expiry, so Ambersight can warn before it goes blind.
    await cf.verifyToken().then((t) => {
      settings.token_expires_on = t.expiresOn ?? '';
      settings.token_status = t.status;
    }).catch(() => {});
    // The update check is install-wide: one account's inventory run does it for all.
    if (config.updateCheck && now.getTime() - new Date(global.update_checked_at ?? 0).getTime() > 20 * HOUR) {
      await checkForUpdate(global).catch((e: Error) => warnings.push(`Update check failed: ${e.message}`));
      global.update_checked_at = stamp;
    }
    // Recent Cloudflare incidents for the timeline, install-wide, when switched on.
    if (config.modules.incidents && now.getTime() - new Date(global.incidents_at ?? 0).getTime() > 20 * HOUR) {
      incidents = await fetchIncidents('incidents').catch((e: Error) => {
        warnings.push(`Cloudflare status page unavailable: ${e.message}`);
        return null;
      });
      if (incidents) global.incidents_at = stamp;
    }
  }

  // 5a. Expensive D1 queries, once a day with the inventory.
  let d1Queries: D1Query[] | null = null;
  if (refreshDue && config.modules.usage && left() > 12 && (refreshed.some((r) => r.kind === 'd1') || known.some((k) => (k.bindings ?? '').includes('"type":"d1"')))) {
    d1Queries = await cf.d1TopQueries(now).catch(() => {
      warnings.push('D1 query insights unavailable.');
      return null;
    });
  }

  // 5b. Storage sizes, once a day with the inventory, for the kinds the account has.
  let storageSizes: StorageSize[] | null = null;
  if (refreshDue && config.modules.usage && left() > 12) {
    const { results: kindRows } = await db.prepare(`SELECT DISTINCT kind FROM resources WHERE account = ?1 AND kind IN ('kv','d1','r2')`).bind(accountId).all<{ kind: StorageKind }>();
    const kinds = new Set<StorageKind>([...kindRows.map((k) => k.kind), ...refreshed.filter((r) => ['kv', 'd1', 'r2'].includes(r.kind)).map((r) => r.kind as StorageKind)]);
    if (known.some((k) => k.has_do)) kinds.add('do');
    if (kinds.size) {
      const r = await cf.storageSizes([...kinds], now);
      storageSizes = r.sizes;
      if (r.failed.length) warnings.push(`Storage sizes unavailable: ${r.failed.join(', ')}.`);
    }
  }

  // 5c. Notifications Cloudflare sent to the account, every 6 hours, for the timeline.
  let cfAlerts: CfAlert[] = [];
  const alertsDue = !light && config.modules.cfAlerts && now.getTime() - new Date(settings.cf_alerts_at ?? 0).getTime() > 6 * HOUR && left() > 12;
  if (alertsDue) {
    const from = new Date(Math.max(now.getTime() - 7 * DAY, new Date(settings.cf_alerts_at ?? 0).getTime() - HOUR));
    try {
      cfAlerts = await cf.alertHistory(from);
      settings.cf_alerts_at = stamp;
    } catch (e) {
      // Usually the Notifications Read permission is missing: say so once a day, not every scan.
      settings.cf_alerts_at = new Date(now.getTime() - 6 * HOUR + DAY).toISOString();
      warnings.push(`Cloudflare notifications unavailable: ${(e as Error).message} (add Notifications Read to the token).`);
    }
  }

  // 5d. Zones: routes, certificates and DNS, the most overdue first, with a share of the budget.
  const { results: zoneRows } = await db.prepare('SELECT id, name, routes_at, certs_at, dns_at FROM zones WHERE account = ?1').bind(accountId).all<{
    id: string; name: string; routes_at: string | null; certs_at: string | null; dns_at: string | null;
  }>();
  const zoneState = new Map(zoneRows.map((z) => [z.id, z]));
  const zones = zoneList ?? zoneRows.map((z) => ({ id: z.id, name: z.name }));
  type ZoneTask = 'routes' | 'certs' | 'dns';
  const wantTasks: ZoneTask[] = [
    ...(config.modules.exposure || config.modules.zombies ? ['routes' as const] : []),
    ...(config.modules.security ? ['certs' as const, 'dns' as const] : []),
  ];
  const tasks = zones
    .flatMap((z) => wantTasks.map((task) => ({ zone: z, task, last: zoneState.get(z.id)?.[`${task}_at` as 'routes_at'] ?? null })))
    .filter((t) => !t.last || now.getTime() - new Date(t.last).getTime() > ZONE_TASK_MAX_AGE)
    .sort((a, b) => (a.last ?? '').localeCompare(b.last ?? '') || (a.task === 'routes' ? -1 : 1));
  const zoneBudget = plan === 'paid' ? 120 : refreshDue ? 12 : 6;
  const zoneDone: { id: string; task: ZoneTask }[] = [];
  const zoneItems: InventoryItem[] = [];
  const zoneFailed = new Set<ZoneTask>();
  for (const t of tasks) {
    if (zoneDone.length >= zoneBudget || left() <= 8) break;
    if (zoneFailed.has(t.task)) continue; // a missing permission fails every zone the same way
    try {
      if (t.task === 'routes') zoneItems.push(...(await cf.zoneRoutes(t.zone)));
      if (t.task === 'certs') {
        for (const c of await cf.certPacks(t.zone)) {
          zoneItems.push({ kind: 'cert', id: c.id, name: c.hosts[0] ?? c.id, script: null, extra: { zone: t.zone.name, ...c } });
        }
      }
      if (t.task === 'dns') {
        for (const d of await cf.cnameTargets(t.zone)) zoneItems.push({ kind: 'dns', id: d.id, name: d.name, script: null, extra: { zone: t.zone.name, target: d.target } });
      }
      zoneDone.push({ id: t.zone.id, task: t.task });
    } catch (e) {
      zoneFailed.add(t.task);
      const perm = { routes: 'Zone and Workers Routes', certs: 'SSL and Certificates', dns: 'DNS' }[t.task];
      warnings.push(`${t.task === 'routes' ? 'Routes' : t.task === 'certs' ? 'Certificates' : 'DNS records'} unavailable for ${t.zone.name}: ${(e as Error).message} (add ${perm} Read to the token).`);
    }
  }
  const zonesLeft = tasks.length - zoneDone.length;
  if (zonesLeft > 0 && !zoneFailed.size) warnings.push(`${zonesLeft} zone checks will run on the next scans.`);

  // 5e. Audit log since the last read, every 6 hours (and the next page right away while there is more).
  let auditEvents: AuditEvent[] = [];
  const auditDue = Boolean(settings.audit_cursor) || now.getTime() - new Date(settings.audit_at || 0).getTime() >= 6 * HOUR;
  if (!light && auditDue && config.modules.security && left() > 6 && now.getTime() >= new Date(settings.audit_retry_at ?? 0).getTime()) {
    const from = new Date(settings.audit_at || now.getTime() - DAY);
    try {
      const r = await cf.auditLogs(from, now, settings.audit_cursor || undefined);
      auditEvents = r.events;
      settings.audit_cursor = r.cursor ?? '';
      // With more pages to read, keep the same window and continue from the cursor next scan.
      if (!r.cursor) settings.audit_at = stamp;
    } catch (e) {
      settings.audit_retry_at = new Date(now.getTime() + DAY).toISOString();
      settings.audit_cursor = '';
      warnings.push(`Audit log unavailable: ${(e as Error).message} (needs Account Settings Read).`);
    }
  }

  // 6. Per-Worker detail on a rotating cursor: settings (bindings), deployments, schedules.
  const checkedAt = new Map(known.map((k) => [k.name, k.detail_checked_at]));
  const due = inventory
    .filter((w) => !checkedAt.get(w.name) || now.getTime() - new Date(checkedAt.get(w.name)!).getTime() > DETAIL_MAX_AGE)
    .sort((a, b) => (checkedAt.get(a.name) ?? '').localeCompare(checkedAt.get(b.name) ?? ''));
  const wantSettings = config.modules.deprecation || config.modules.zombies || config.modules.drift;
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
      if (wantSettings) {
        d.settings = await cf.scriptSettings(w.name);
        // Config drift: a binding (or secret) that was there at the last read and is gone now.
        const before = known.find((k) => k.name === w.name)?.bindings;
        if (before && config.modules.drift) {
          const now_ = new Set(d.settings.bindings.map((b) => b.name));
          for (const b of parse<{ name: string; type: string }[]>(before, [])) {
            if (b.type !== 'tail_consumer' && !now_.has(b.name)) fleetEvents.push({ at: stamp, kind: 'binding-removed', script: w.name, detail: b.name });
          }
        }
      }
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
         sampling_rate=excluded.sampling_rate, logpush=excluded.logpush, tags=excluded.tags, last_seen=excluded.last_seen
       -- Only rows that changed: D1 bills every row written, and most Workers do not change between scans.
       WHERE workers.has_modules IS NOT excluded.has_modules OR workers.compatibility_date IS NOT excluded.compatibility_date
         OR (excluded.compat_flags IS NOT NULL AND workers.compat_flags IS NOT excluded.compat_flags)
         OR workers.handlers IS NOT excluded.handlers OR workers.usage_model IS NOT excluded.usage_model
         OR workers.created_on IS NOT excluded.created_on OR workers.modified_on IS NOT excluded.modified_on
         OR workers.deployed_on IS NOT excluded.deployed_on OR workers.workers_dev IS NOT excluded.workers_dev
         OR workers.previews_enabled IS NOT excluded.previews_enabled OR workers.logs_enabled IS NOT excluded.logs_enabled
         OR workers.sampling_rate IS NOT excluded.sampling_rate OR workers.logpush IS NOT excluded.logpush OR workers.tags IS NOT excluded.tags`,
    ).bind(A, j(inventory.map((w) => ({ ...w, handlers: j(w.handlers), tags: j(w.tags), compat_flags: w.compat_flags ? j(w.compat_flags) : null })))),
    db.prepare('DELETE FROM workers WHERE account = ?1 AND name NOT IN (SELECT value FROM json_each(?2))').bind(A, j(inventory.map((w) => w.name))),
    // The last hour each Worker had a request, for the no-traffic check (no 30-day scan of metrics).
    db.prepare(
      `UPDATE workers SET last_active_hour = a.hour
       FROM (SELECT json_extract(value,'$.script') AS script, MAX(json_extract(value,'$.hour')) AS hour FROM json_each(?2)
             WHERE json_extract(value,'$.requests') > 0 GROUP BY 1) AS a
       WHERE workers.account = ?1 AND workers.name = a.script AND (workers.last_active_hour IS NULL OR workers.last_active_hour < a.hour)`,
    ).bind(A, j(hourly)),
    db.prepare(
      `INSERT INTO metrics_hourly (account, script, hour, requests, errors, subrequests, cpu_p99, cpu_time_us)
       SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.requests'),
         json_extract(value,'$.errors'), json_extract(value,'$.subrequests'), json_extract(value,'$.cpuP99'), json_extract(value,'$.cpuTimeUs')
       FROM json_each(?2) WHERE true
       ON CONFLICT(account, script, hour) DO UPDATE SET requests=excluded.requests, errors=excluded.errors,
         subrequests=excluded.subrequests, cpu_p99=excluded.cpu_p99, cpu_time_us=excluded.cpu_time_us
       WHERE metrics_hourly.requests IS NOT excluded.requests OR metrics_hourly.errors IS NOT excluded.errors
         OR metrics_hourly.subrequests IS NOT excluded.subrequests OR metrics_hourly.cpu_p99 IS NOT excluded.cpu_p99
         OR metrics_hourly.cpu_time_us IS NOT excluded.cpu_time_us`,
    ).bind(A, j(hourly)),
    db.prepare(
      `INSERT INTO metrics_hourly (account, script, hour, exceeded)
       SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.count')
       FROM json_each(?2) WHERE true
       ON CONFLICT(account, script, hour) DO UPDATE SET exceeded=excluded.exceeded WHERE metrics_hourly.exceeded IS NOT excluded.exceeded`,
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
       ON CONFLICT(account, script) DO UPDATE SET crons=excluded.crons, checked_at=excluded.checked_at WHERE schedules.crons IS NOT excluded.crons`,
    ).bind(A, j(details.filter((d) => d.crons).map((d) => ({ script: d.name, crons: j(d.crons) }))), stamp),
    db.prepare(`DELETE FROM schedules WHERE account = ?1 AND script NOT IN (SELECT value FROM json_each(?2))`).bind(A, j(scheduled)),
    db.prepare(
      `INSERT INTO deployments (account, script, id, created_on, author, message, source, versions)
       SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.id'), json_extract(value,'$.created_on'),
         json_extract(value,'$.author'), json_extract(value,'$.message'), json_extract(value,'$.source'), json_extract(value,'$.versions')
       FROM json_each(?2) WHERE true
       ON CONFLICT(account, script, id) DO UPDATE SET versions = excluded.versions WHERE deployments.versions IS NULL`,
    ).bind(A, j(details.flatMap((d) => (d.deployments ?? []).map((x) => ({ ...x, versions: j(x.versions), script: d.name }))))),
    db.prepare(
      `INSERT INTO fleet_events (account, at, kind, script, detail)
       SELECT ?1, json_extract(value,'$.at'), json_extract(value,'$.kind'), json_extract(value,'$.script'), json_extract(value,'$.detail') FROM json_each(?2) WHERE true`,
    ).bind(A, j(fleetEvents)),
  ];
  if (cronRuns) {
    writes.push(
      db.prepare(
        `INSERT INTO cron_runs (account, script, hour, runs, failures, cpu_max_ms)
         SELECT ?1, json_extract(value,'$.script'), json_extract(value,'$.hour'), json_extract(value,'$.runs'),
           json_extract(value,'$.failures'), json_extract(value,'$.cpuMaxMs')
         FROM json_each(?2) WHERE true
         ON CONFLICT(account, script, hour) DO UPDATE SET runs=excluded.runs, failures=excluded.failures, cpu_max_ms=excluded.cpu_max_ms
         WHERE cron_runs.runs IS NOT excluded.runs OR cron_runs.failures IS NOT excluded.failures OR cron_runs.cpu_max_ms IS NOT excluded.cpu_max_ms`,
      ).bind(A, j(cronRuns)),
    );
  }
  if (resourceOps.length) {
    writes.push(
      db.prepare(
        `INSERT INTO resource_hourly (account, kind, resource, hour, ops)
         SELECT ?1, json_extract(value,'$.kind'), json_extract(value,'$.resource'), json_extract(value,'$.hour'), json_extract(value,'$.ops')
         FROM json_each(?2) WHERE true
         ON CONFLICT(account, kind, resource, hour) DO UPDATE SET ops=excluded.ops WHERE resource_hourly.ops IS NOT excluded.ops`,
      ).bind(A, j(resourceOps)),
    );
  }
  if (quotaRows.length) {
    writes.push(
      db.prepare(
        `INSERT INTO quota_hourly (account, metric, hour, value)
         SELECT ?1, json_extract(value,'$.metric'), json_extract(value,'$.hour'), json_extract(value,'$.value') FROM json_each(?2) WHERE true
         ON CONFLICT(account, metric, hour) DO UPDATE SET value = excluded.value WHERE quota_hourly.value IS NOT excluded.value`,
      ).bind(A, j(quotaRows)),
    );
  }
  if (storageSizes) {
    writes.push(
      db.prepare(`DELETE FROM storage_sizes WHERE account = ?1`).bind(A),
      db.prepare(
        `INSERT INTO storage_sizes (account, kind, id, bytes, objects, at)
         SELECT ?1, json_extract(value,'$.kind'), json_extract(value,'$.id'), json_extract(value,'$.bytes'), json_extract(value,'$.objects'), ?3
         FROM json_each(?2) WHERE true ON CONFLICT(account, kind, id) DO UPDATE SET bytes = excluded.bytes, objects = excluded.objects, at = excluded.at`,
      ).bind(A, j(storageSizes), stamp),
    );
  }
  if (cfAlerts.length) {
    writes.push(
      db.prepare(
        `INSERT INTO cf_alerts (account, id, sent, alert_type, name, description)
         SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.sent'), json_extract(value,'$.alertType'), json_extract(value,'$.name'), json_extract(value,'$.description')
         FROM json_each(?2) WHERE true ON CONFLICT(account, id) DO NOTHING`,
      ).bind(A, j(cfAlerts)),
    );
  }
  if (zoneList) {
    // Zones gone from the account take their routes, certificates and DNS records with them.
    writes.push(
      db.prepare(`DELETE FROM zones WHERE account = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`).bind(A, j(zoneList.map((z) => z.id))),
      db.prepare(
        `INSERT INTO zones (account, id, name) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.name') FROM json_each(?2) WHERE true
         ON CONFLICT(account, id) DO UPDATE SET name = excluded.name`,
      ).bind(A, j(zoneList)),
      db.prepare(`DELETE FROM resources WHERE account = ?1 AND kind IN ('route','cert','dns') AND json_extract(extra, '$.zone') NOT IN (SELECT value FROM json_each(?2))`)
        .bind(A, j(zoneList.map((z) => z.name))),
    );
  }
  if (zoneDone.length) {
    const nameOf = new Map(zones.map((z) => [z.id, z.name]));
    const kindOf = { routes: 'route', certs: 'cert', dns: 'dns' } as const;
    writes.push(
      // Replace exactly what was read: each (kind, zone) pair that completed.
      db.prepare(
        `DELETE FROM resources WHERE account = ?1 AND EXISTS (SELECT 1 FROM json_each(?2) AS t
           WHERE json_extract(t.value,'$.kind') = resources.kind AND json_extract(t.value,'$.zone') = json_extract(resources.extra, '$.zone'))`,
      ).bind(A, j(zoneDone.map((d) => ({ kind: kindOf[d.task], zone: nameOf.get(d.id) })))),
      db.prepare(
        `INSERT INTO resources (account, kind, id, name, script, extra)
         SELECT ?1, json_extract(value,'$.kind'), json_extract(value,'$.id'), json_extract(value,'$.name'), json_extract(value,'$.script'), json_extract(value,'$.extra')
         FROM json_each(?2) WHERE true ON CONFLICT(account, kind, id) DO UPDATE SET name = excluded.name, script = excluded.script, extra = excluded.extra`,
      ).bind(A, j(zoneItems.map((r) => ({ ...r, extra: r.extra ? j(r.extra) : null })))),
      db.prepare(
        `UPDATE zones SET
           routes_at = CASE WHEN EXISTS (SELECT 1 FROM json_each(?2) AS t WHERE json_extract(t.value,'$.id') = zones.id AND json_extract(t.value,'$.task') = 'routes') THEN ?3 ELSE routes_at END,
           certs_at = CASE WHEN EXISTS (SELECT 1 FROM json_each(?2) AS t WHERE json_extract(t.value,'$.id') = zones.id AND json_extract(t.value,'$.task') = 'certs') THEN ?3 ELSE certs_at END,
           dns_at = CASE WHEN EXISTS (SELECT 1 FROM json_each(?2) AS t WHERE json_extract(t.value,'$.id') = zones.id AND json_extract(t.value,'$.task') = 'dns') THEN ?3 ELSE dns_at END
         WHERE account = ?1`,
      ).bind(A, j(zoneDone), stamp),
    );
  }
  if (auditEvents.length) {
    writes.push(
      db.prepare(
        `INSERT INTO audit_events (account, id, at, actor, action, description, product, resource_type, resource_id, result)
         SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.at'), json_extract(value,'$.actor'), json_extract(value,'$.action'),
           json_extract(value,'$.description'), json_extract(value,'$.product'), json_extract(value,'$.resourceType'), json_extract(value,'$.resourceId'), json_extract(value,'$.result')
         FROM json_each(?2) WHERE true ON CONFLICT(account, id) DO NOTHING`,
      ).bind(A, j(auditEvents)),
    );
  }
  if (d1Queries) {
    writes.push(
      db.prepare('DELETE FROM d1_queries WHERE account = ?1').bind(A),
      db.prepare(
        `INSERT INTO d1_queries (account, hash, database_id, query, rows_read, rows_returned, runs, at)
         SELECT ?1, json_extract(value,'$.hash'), json_extract(value,'$.databaseId'), json_extract(value,'$.query'), json_extract(value,'$.rowsRead'),
           json_extract(value,'$.rowsReturned'), json_extract(value,'$.runs'), ?3 FROM json_each(?2) WHERE true ON CONFLICT(account, hash) DO NOTHING`,
      ).bind(A, j(d1Queries.map((q) => ({ ...q, query: q.query.slice(0, 2000), hash: hashText(`${q.databaseId}|${q.query}`) }))), stamp),
    );
  }
  if (incidents?.length) {
    writes.push(
      db.prepare(
        `INSERT INTO cf_incidents (id, name, impact, status, created_at, resolved_at, url)
         SELECT json_extract(value,'$.id'), json_extract(value,'$.name'), json_extract(value,'$.impact'), json_extract(value,'$.status'),
           json_extract(value,'$.createdAt'), json_extract(value,'$.resolvedAt'), json_extract(value,'$.url') FROM json_each(?1) WHERE true
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, resolved_at = excluded.resolved_at, impact = excluded.impact`,
      ).bind(j(incidents)),
    );
  }
  if (refreshDue) {
    writes.push(
      db.prepare(`DELETE FROM resources WHERE account = ?1 AND kind IN (SELECT value FROM json_each(?2))`)
        .bind(A, j([...refreshedKinds])),
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
      ...(settings.ops_checked ? { ops_unavailable: settings.ops_unavailable ?? '', ops_simple: settings.ops_simple ?? '', ops_checked: settings.ops_checked } : {}),
      ...(settings.quota_unavailable != null ? { quota_unavailable: settings.quota_unavailable } : {}),
      ...(settings.token_status ? { token_expires_on: settings.token_expires_on ?? '', token_status: settings.token_status } : {}),
      ...(settings.cf_alerts_at ? { cf_alerts_at: settings.cf_alerts_at } : {}),
      ...(settings.audit_at != null ? { audit_at: settings.audit_at } : {}),
      ...(settings.audit_cursor != null ? { audit_cursor: settings.audit_cursor } : {}),
      ...(settings.audit_retry_at ? { audit_retry_at: settings.audit_retry_at } : {}),
      ...(settings.pages_listed_at ? { pages_listed_at: settings.pages_listed_at } : {}),
      ...(refreshDue ? { inventory_at: stamp, workers_subdomain: subdomain ?? '' } : {}),
      ...(settings.access_listed_at ? { access_listed_at: settings.access_listed_at } : {}),
      ...(settings.first_metrics_at ? {} : { first_metrics_at: stamp }),
      ...(newestHour(hourly, settings.metrics_hour) ? { metrics_hour: newestHour(hourly, settings.metrics_hour)! } : {}),
      ...(cronTried ? { cron_dataset: cronRuns || cronTruncated ? 'available' : 'unavailable', cron_dataset_checked: stamp } : {}),
    }),
  );
  if (global.update_checked_at === stamp || global.incidents_at === stamp) {
    writes.push(setSettings(db, {
      ...(global.incidents_at ? { incidents_at: global.incidents_at } : {}),
      update_checked_at: global.update_checked_at ?? '',
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
    quotaToday: facts.quotaToday,
    storage: facts.storage,
    tokenExpiresOn: facts.tokenExpiresOn,
    changes: facts.changes,
  });
  // Checks the user switched off are dropped here, so their open findings resolve like fixed ones.
  const muted = new Set(config.mutedChecks);
  // While cron checks are paused (too many runs to count, or no data at all), keep existing cron
  // findings as they are rather than resolving them as if every cron had recovered.
  // Cron findings stay as they are when this scan did not read cron runs (paused, or a continuation).
  const keepModules = cronTruncated || cronDataEmpty || light ? ['cron'] : [];
  await saveFindings(db, accountId, muted.size ? findings.filter((f) => !muted.has(checkOf(f))) : findings, stamp, keepModules, inventory.map((w) => w.name));

  // 9. Alerts and digest, then the run's own cost.
  if (!light) await sendAlerts(env, now, config).catch((e: Error) => warnings.push(`Alerts failed: ${e.message}`));
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

  return { workers: inventory.length, findings: findings.length, subrequests: cf.calls, d1Queries: meter.queries, warnings, detailRemaining, zonesRemaining: zonesLeft };
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
    db.prepare('DELETE FROM cf_alerts WHERE account = ?1 AND sent < ?2').bind(account, iso),
    db.prepare('DELETE FROM audit_events WHERE account = ?1 AND at < ?2').bind(account, iso),
    db.prepare('DELETE FROM cf_incidents WHERE created_at < ?1').bind(iso),
    // Quota totals stay at least 35 days: the cost estimate needs the whole month so far.
    db.prepare('DELETE FROM quota_hourly WHERE account = ?1 AND hour < ?2').bind(account, isoHour(new Date(now.getTime() - Math.max(days, 35) * DAY))),
    // Install-wide tables: any account's refresh may tidy them.
    db.prepare('DELETE FROM usage_daily WHERE day < ?1').bind(iso.slice(0, 10)),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now.toISOString()),
  ];
}

/** The newest hour in this scan's metrics, if it is newer than the stored one. */
function newestHour(rows: { hour: string }[], stored: string | undefined): string | null {
  const max = rows.reduce<string | null>((m, r) => (!m || r.hour > m ? r.hour : m), null);
  return max && (!stored || max > stored) ? max : null;
}

/** Short stable hash for IDs (FNV-1a, hex). Not for security. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
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
  last_active_hour: string | null;
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
  quotaToday: Partial<Record<QuotaMetric, number>>;
  storage: (StorageSize & { label: string })[];
  tokenExpiresOn: string | null;
  changes: ChangeFacts;
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

  const weekAgoIso = new Date(now.getTime() - 7 * DAY).toISOString();
  const [workersR, histR, todayR, schedR, runsR, resR, opsR, depR, quotaR, storageR, latestR, removedR, auditR, d1qR] = await db.batch([
    db.prepare('SELECT * FROM workers WHERE account = ?1').bind(account),
    db.prepare(
      `SELECT script, hour, requests, errors, subrequests, cpu_time_us, exceeded, cpu_p99 FROM metrics_hourly
       WHERE account = ?1 AND hour >= ?2 ORDER BY hour`,
    ).bind(account, weekAgo),
    db.prepare('SELECT COALESCE(SUM(requests),0) AS n FROM metrics_hourly WHERE account = ?1 AND hour >= ?2').bind(account, isoHour(utcMidnight(now))),
    db.prepare('SELECT script, crons FROM schedules WHERE account = ?1').bind(account),
    db.prepare('SELECT script, hour, runs, failures, cpu_max_ms FROM cron_runs WHERE account = ?1 AND hour >= ?2 AND hour < ?3').bind(account, cronFrom, cronTo),
    db.prepare('SELECT kind, id, name, script, extra FROM resources WHERE account = ?1').bind(account),
    db.prepare('SELECT kind, resource, hour, ops FROM resource_hourly WHERE account = ?1 AND hour >= ?2').bind(account, weekAgo),
    db.prepare('SELECT script, id, created_on FROM deployments WHERE account = ?1 AND created_on >= ?2').bind(account, deployFrom),
    db.prepare('SELECT metric, SUM(value) AS v FROM quota_hourly WHERE account = ?1 AND hour >= ?2 GROUP BY metric').bind(account, isoHour(utcMidnight(now))),
    db.prepare('SELECT kind, id, bytes, objects FROM storage_sizes WHERE account = ?1').bind(account),
    // Each Worker's latest deployment, for stuck gradual rollouts.
    db.prepare(
      `SELECT d.script, d.created_on, d.versions FROM deployments d WHERE d.account = ?1
         AND d.created_on = (SELECT MAX(created_on) FROM deployments x WHERE x.account = d.account AND x.script = d.script)`,
    ).bind(account),
    db.prepare(`SELECT script, detail, at FROM fleet_events WHERE account = ?1 AND kind = 'binding-removed' AND at >= ?2`).bind(account, weekAgoIso),
    db.prepare(
      `SELECT id, at, actor, action, description, product, resource_type, resource_id FROM audit_events
       WHERE account = ?1 AND at >= ?2 ORDER BY at DESC LIMIT 300`,
    ).bind(account, weekAgoIso),
    db.prepare('SELECT hash, database_id, query, rows_read, rows_returned, runs FROM d1_queries WHERE account = ?1').bind(account),
  ]);

  const allRows = workersR.results as unknown as WorkerRow[];
  const groupsOf = new Map(allRows.map((w) => [w.name, groupsFor(config, w.name, parse<string[]>(w.tags, []))]));
  const rows = allRows.filter((w) => inScope(config, w.name, groupsOf.get(w.name)!));
  // Thresholds per Worker are asked for several times per scan: work each out once.
  const tfCache = new Map<string, ReturnType<typeof thresholdsFor>>();
  const tf = (name: string) => {
    let t = tfCache.get(name);
    if (!t) tfCache.set(name, (t = thresholdsFor(config, name, groupsOf.get(name) ?? [])));
    return t;
  };

  // Metrics per Worker.
  type H = { script: string; hour: string; requests: number; errors: number; subrequests: number; cpu_time_us: number; exceeded: number; cpu_p99: number | null };
  const hist = new Map<string, H[]>();
  for (const h of histR.results as unknown as H[]) {
    const list = hist.get(h.script) ?? [];
    list.push(h);
    hist.set(h.script, list);
  }
  // The no-traffic check reads workers.last_active_hour, kept up to date by every scan.
  const lastActive = new Map(allRows.map((w) => [w.name, w.last_active_hour]));
  // One pass over each Worker's week of hours: this runs for every Worker on every scan, inside
  // the Free plan's 10 ms of CPU per invocation.
  const stats: WorkerStats[] = rows.map(({ name }) => {
    const hs = hist.get(name) ?? [];
    let requests24h = 0, errors24h = 0, exceeded24h = 0, subrequests24h = 0, requestsPrev = 0, errorsPrev = 0;
    let cpuMax: number | null = null;
    let last: H | undefined;
    const beforeReq: number[] = [], beforeCpu: number[] = [], beforeSub: number[] = [];
    const hours24: HourPoint[] = [];
    for (const h of hs) {
      if (h.hour >= dayAgo) {
        requests24h += h.requests ?? 0;
        errors24h += h.errors ?? 0;
        exceeded24h += h.exceeded ?? 0;
        subrequests24h += h.subrequests ?? 0;
        if (h.cpu_p99 != null) cpuMax = Math.max(cpuMax ?? 0, h.cpu_p99);
        hours24.push({ hour: h.hour, requests: h.requests, errors: h.errors });
      } else {
        requestsPrev += h.requests ?? 0;
        errorsPrev += h.errors ?? 0;
      }
      if (h.hour < lastFullHour) {
        beforeReq.push(h.requests);
        beforeCpu.push(h.cpu_time_us ?? 0);
        beforeSub.push(h.subrequests ?? 0);
      } else if (h.hour === lastFullHour) last = h;
    }
    return {
      name,
      subrequests24h,
      requests24h,
      errors24h,
      requestsPrev,
      errorsPrev,
      exceeded24h,
      cpuP99Max24h: cpuMax,
      lastHourRequests: last?.requests ?? 0,
      hourlyMedian7d: median(beforeReq),
      lastHourCpuUs: last?.cpu_time_us ?? 0,
      hourlyMedianCpuUs7d: median(beforeCpu),
      lastHourSubrequests: last?.subrequests ?? 0,
      hourlyMedianSubrequests7d: median(beforeSub),
      historyHours: beforeReq.length + (last ? 1 : 0),
      hours24,
      // Any request since the start of the no-traffic window counts as activity.
      requestsWindow: (lastActive.get(name) ?? '') >= zombieFrom ? 1 : 0,
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
  // Every Worker bound to a resource, for the idle-loop check. Queues are bound by name, not ID.
  const boundBy = new Map<string, string[]>();
  for (const m of meta) {
    for (const b of m.bindings ?? []) {
      if (!b.target) continue;
      if (!bindingOwner.has(b.target)) bindingOwner.set(b.target, m.name);
      boundBy.set(b.target, [...(boundBy.get(b.target) ?? []), m.name]);
    }
  }
  const recentHours = [3, 2, 1].map((n) => isoHour(new Date(hourFloor(now).getTime() - n * HOUR)));
  // Requests per Worker for the 3 hours the idle-loop check compares, looked up once.
  const recentReq = new Map<string, number>();
  for (const [n, hs] of hist) {
    // Rows are ordered by hour: walk back from the newest and stop before the first hour needed.
    for (let i = hs.length - 1; i >= 0 && hs[i].hour >= recentHours[0]; i--) recentReq.set(`${n}|${hs[i].hour}`, hs[i].requests);
  }
  const requestsAt = (names: string[], hour: string) => names.reduce((sum, n) => sum + (recentReq.get(`${n}|${hour}`) ?? 0), 0);
  type Op = { kind: ResourceStats['kind']; resource: string; hour: string; ops: number };
  const opsBy = new Map<string, Op[]>();
  for (const o of opsR.results as unknown as Op[]) {
    const k = `${o.kind}|${o.resource}`;
    const list = opsBy.get(k);
    if (list) list.push(o);
    else opsBy.set(k, [o]);
  }
  const resources: ResourceStats[] = [...opsBy.entries()].map(([k, list]) => {
    const [kind, resource] = k.split('|') as [ResourceStats['kind'], string];
    const last = list.find((o) => o.hour === lastFullHour);
    const before = list.filter((o) => o.hour < lastFullHour);
    const label = kind === 'do' ? `Durable Objects in ${resource}` : (labelOf.get(`${kind}|${resource}`) ?? resource);
    const target = kind === 'queues' ? (labelOf.get(`${kind}|${resource}`) ?? resource) : resource;
    const script = kind === 'do' ? resource : (bindingOwner.get(target) ?? '*');
    const owners = kind === 'do' ? [resource] : (boundBy.get(target) ?? []);
    return {
      kind, resource, label, script, lastHour: last?.ops ?? 0, median7d: median(before.map((o) => o.ops)), historyHours: before.length + (last ? 1 : 0),
      recentOps: recentHours.map((h) => list.find((o) => o.hour === h)?.ops ?? 0),
      // null when no Worker is known to use it: the idle check then has nothing to compare with.
      recentRequests: owners.length ? recentHours.map((h) => requestsAt(owners, h)) : null,
    };
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

  const ex = <T>(r: { extra: string | null }) => parse<T>(r.extra, {} as T);
  const changes: ChangeFacts = {
    latestDeploys: (latestR.results as { script: string; created_on: string; versions: string | null }[])
      .filter((d) => inScopeNames.has(d.script))
      .map((d) => ({ script: d.script, createdOn: d.created_on, versions: parse<{ id: string; percentage: number }[]>(d.versions, []) })),
    removedBindings: (removedR.results as { script: string; detail: string | null; at: string }[])
      .filter((e) => e.detail && inScopeNames.has(e.script)).map((e) => ({ script: e.script, name: e.detail!, at: e.at })),
    audit: (auditR.results as { id: string; at: string; actor: string | null; action: string | null; description: string | null; product: string | null; resource_type: string | null; resource_id: string | null }[])
      .map((a) => ({ id: a.id, at: a.at, actor: a.actor, action: a.action ?? '', description: a.description, product: a.product, resourceType: a.resource_type, resourceId: a.resource_id })),
    pages: settings.pages_listed_at
      ? res.filter((r) => r.kind === 'pages').map((r) => ({ name: r.id, ...ex<{ subdomain: string | null; domains: string[]; latest: { id: string; createdOn: string; status: string; stage: string; environment: string; branch: string | null } | null }>(r) }))
      : null,
    certs: res.filter((r) => r.kind === 'cert').map((r) => ({ id: r.id, ...ex<{ zone: string; type: string; status: string; hosts: string[]; expiresOn: string | null; errors: string[] }>(r) })),
    dns: res.filter((r) => r.kind === 'dns').map((r) => ({ id: r.id, name: r.name ?? '', ...ex<{ zone: string; target: string }>(r) })),
    d1Queries: (d1qR.results as { hash: string; database_id: string; query: string; rows_read: number; rows_returned: number; runs: number }[]).map((q) => ({
      hash: q.hash, database: labelOf.get(`d1|${q.database_id}`) ?? q.database_id, query: q.query, rowsRead: q.rows_read, rowsReturned: q.rows_returned, runs: q.runs,
    })),
    workerNames: new Set(allRows.map((w) => w.name)),
    workersSubdomain: subdomain || null,
  };
  const storage = (storageR.results as { kind: StorageSize['kind']; id: string; bytes: number; objects: number | null }[]).map((r) => ({
    kind: r.kind, id: r.id, bytes: r.bytes, objects: r.objects ?? undefined,
    label: r.id === '*' ? 'Durable Objects' : (labelOf.get(`${r.kind}|${r.id}`) ?? r.id),
  }));
  return {
    quotaToday: Object.fromEntries((quotaR.results as { metric: QuotaMetric; v: number }[]).map((r) => [r.metric, r.v])),
    storage,
    tokenExpiresOn: settings.token_expires_on || null,
    changes,
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

async function saveFindings(db: D1Database, account: string, findings: Finding[], stamp: string, keepModules: string[] = [], workerNames: string[] = []): Promise<void> {
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
         severity=excluded.severity
       -- Only when something changed: an unchanged open finding is not rewritten every scan.
       WHERE findings.status = 'resolved' OR findings.severity IS NOT excluded.severity OR findings.message IS NOT excluded.message
         OR findings.evidence IS NOT excluded.evidence OR findings.action IS NOT excluded.action OR findings.docs_url IS NOT excluded.docs_url
         OR (findings.status = 'snoozed' AND findings.snooze_until < excluded.last_seen)`,
    ).bind(JSON.stringify(rows), stamp, account),
    // Resolved: findings of this account that this scan did not raise. Findings of a Worker that no
    // longer exists resolve too, even in a module whose findings are being kept (paused cron data),
    // so a deleted Worker leaves "Needs attention" on the next scan.
    db.prepare(
      `UPDATE findings SET status = 'resolved', last_seen = ?1
       WHERE account = ?3 AND status <> 'resolved'
         AND id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(?4))
         AND (module NOT IN (SELECT value FROM json_each(?2))
              OR (script <> '*' AND script NOT IN (SELECT value FROM json_each(?5))))`,
    ).bind(stamp, JSON.stringify(keepModules), account, JSON.stringify(rows), JSON.stringify(workerNames)),
  ]);
}
