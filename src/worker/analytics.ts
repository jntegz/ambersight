// Analytics and the Worker page, read from D1 only: hourly rows for short ranges, the daily
// rollups (plus today's hours) for long ones. No Cloudflare API call happens on page view.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope } from '../shared/config';
import { checkOf } from '../shared/findings';
import { FREE_DAILY, PRICES, STORAGE_LIMITS, unitPrice, type QuotaMetric, type StorageKind } from '../shared/limits';
import type { AnalyticsView, Finding, FindingListItem, MetricPoint, MetricTotals, Range, Severity, WorkerDetail } from '../shared/types';
import { monthlyCost } from './cost';
import { configFrom, getAccountState, getSettings, isoHour, planFrom } from './db';
import type { Env } from './env';
import { pickAccount, toFinding, type FindingRow } from './overview';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANGE_MS: Record<Range, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '365d': 365 * DAY };

export const parseRange = (v: string | undefined, fallback: Range = '7d'): Range => (v && v in RANGE_MS ? (v as Range) : fallback);

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The window a range covers, ending now, aligned to whole hours or days, and the window before it. */
export function windowOf(range: Range, now: Date) {
  const granularity: 'hour' | 'day' = range === '24h' || range === '7d' ? 'hour' : 'day';
  const step = granularity === 'hour' ? HOUR : DAY;
  // The current (partial) bucket is included: "today so far".
  const end = Math.floor(now.getTime() / step) * step + step;
  const start = end - RANGE_MS[range];
  const buckets = Array.from({ length: RANGE_MS[range] / step }, (_, i) => {
    const t = start + i * step;
    return granularity === 'hour' ? isoHour(new Date(t)) : dayOf(t);
  });
  return { granularity, start, end, prevStart: start - RANGE_MS[range], buckets };
}

const ZERO: MetricTotals = { requests: 0, errors: 0, subrequests: 0, cpuTimeUs: 0, cpuP99: null, cpuP50: null, wallP50: null, wallP99: null, exceeded: 0, exceededCpu: 0, exceededMemory: 0 };

type Agg = { t?: string; script?: string; requests: number | null; errors: number | null; subrequests: number | null; cpu_time_us: number | null; cpu: number | null; exceeded: number | null; exceeded_cpu: number | null; exceeded_memory: number | null;
  cpu50: number | null; wall50: number | null; wall99: number | null };
const toTotals = (r: Agg | undefined): MetricTotals => (r ? {
  requests: r.requests ?? 0, errors: r.errors ?? 0, subrequests: r.subrequests ?? 0, cpuTimeUs: r.cpu_time_us ?? 0, cpuP99: r.cpu,
  cpuP50: r.cpu50 ?? null, wallP50: r.wall50 ?? null, wallP99: r.wall99 ?? null,
  exceeded: r.exceeded ?? 0, exceededCpu: r.exceeded_cpu ?? 0, exceededMemory: r.exceeded_memory ?? 0,
} : { ...ZERO });

const SUMS = `SUM(requests) AS requests, SUM(errors) AS errors, SUM(subrequests) AS subrequests, SUM(cpu_time_us) AS cpu_time_us,
  MAX(cpu) AS cpu, SUM(exceeded) AS exceeded, SUM(exceeded_cpu) AS exceeded_cpu, SUM(exceeded_memory) AS exceeded_memory,
  SUM(cpu50 * requests) / NULLIF(SUM(CASE WHEN cpu50 IS NOT NULL THEN requests END), 0) AS cpu50,
  SUM(wall50 * requests) / NULLIF(SUM(CASE WHEN wall50 IS NOT NULL THEN requests END), 0) AS wall50, MAX(wall99) AS wall99`;

/**
 * Worker metrics between two times, from the daily rollups up to the last rolled-up day and from
 * the hourly rows after it. `by`: per bucket (hour or day), per Worker, or one total.
 * ?1 account, ?2 start day, ?3 end day, ?4 last rolled-up day, ?5 hourly start, ?6 hourly end, ?7 script or NULL.
 */
function metricsQuery(
  db: D1Database, account: string, start: number, end: number, rolled: string | null, by: 'hour' | 'day' | 'script' | 'total', script: string | null, hourly = by === 'hour',
) {
  const scriptFilter = 'AND (?7 IS NULL OR script = ?7)';
  // Ranges drawn by hour start mid-day: their totals come from the hourly rows alone.
  if (hourly) {
    const key = by === 'hour' ? 'hour' : by === 'script' ? 'script' : "'all'";
    return db.prepare(
      `SELECT ${key} AS k, ${SUMS} FROM (
         SELECT hour, script, requests, errors, subrequests, cpu_time_us, cpu_p99 AS cpu, exceeded, exceeded_cpu, exceeded_memory,
           cpu_p50 AS cpu50, wall_p50 AS wall50, wall_p99 AS wall99
         FROM metrics_hourly WHERE account = ?1 AND hour >= ?5 AND hour < ?6 ${scriptFilter}
       ) GROUP BY k`,
    ).bind(account, null, null, null, isoHour(new Date(start)), isoHour(new Date(end)), script);
  }
  // Hours after the last rolled-up day (today, and any day a scan has not folded yet).
  const hourlyFrom = Math.max(start, rolled ? Date.parse(`${rolled}T00:00:00Z`) + DAY : start);
  const key = by === 'day' ? 't' : by === 'script' ? 'script' : "'all'";
  return db.prepare(
    `SELECT ${key} AS k, ${SUMS} FROM (
       SELECT day AS t, script, requests, errors, subrequests, cpu_time_us, cpu_p99_max AS cpu, exceeded, exceeded_cpu, exceeded_memory,
         cpu_p50 AS cpu50, wall_p50 AS wall50, wall_p99_max AS wall99
       FROM metrics_daily WHERE account = ?1 AND day >= ?2 AND day < ?3 AND (?4 IS NOT NULL AND day <= ?4) ${scriptFilter}
       UNION ALL
       SELECT substr(hour, 1, 10), script, requests, errors, subrequests, cpu_time_us, cpu_p99, exceeded, exceeded_cpu, exceeded_memory,
         cpu_p50, wall_p50, wall_p99
       FROM metrics_hourly WHERE account = ?1 AND hour >= ?5 AND hour < ?6 ${scriptFilter}
     ) GROUP BY k`,
  ).bind(account, dayOf(start), dayOf(end), rolled, isoHour(new Date(hourlyFrom)), isoHour(new Date(end)), script);
}

/** Fills every bucket of the range, zero where nothing was stored. */
function fill(buckets: string[], rows: (Agg & { k?: string })[]): MetricPoint[] {
  const by = new Map(rows.map((r) => [r.t ?? r.k ?? '', r]));
  return buckets.map((t) => ({ t, ...toTotals(by.get(t)) }));
}

/** The last day folded into the daily tables, and the first day of any history. */
async function historyBounds(db: D1Database, account: string): Promise<{ rolled: string | null; start: string | null }> {
  const [rolled, first] = await db.batch([
    db.prepare('SELECT MAX(day) AS d FROM metrics_daily WHERE account = ?1').bind(account),
    db.prepare(`SELECT MIN(d) AS d FROM (SELECT MIN(day) AS d FROM metrics_daily WHERE account = ?1 UNION ALL SELECT MIN(substr(hour, 1, 10)) FROM metrics_hourly WHERE account = ?1)`).bind(account),
  ]);
  return { rolled: (rolled.results[0] as { d: string | null } | undefined)?.d ?? null, start: (first.results[0] as { d: string | null } | undefined)?.d ?? null };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

const QUOTA_LABEL: Record<QuotaMetric, string> = {
  'workers.requests': 'Workers requests', 'workers.cpuMs': 'Workers CPU time (ms)',
  ...Object.fromEntries(FREE_DAILY.map((q) => [q.metric, q.label])),
} as Record<QuotaMetric, string>;

export async function buildAnalytics(env: Env, requested: string | undefined, range: Range, now = new Date()): Promise<AnalyticsView> {
  const db = env.DB;
  const config = configFrom(await getSettings(db));
  const { account: acct } = await pickAccount(env, requested);
  const A = acct?.id ?? '';
  const plan = planFrom(config, acct?.detected_plan, env.PLAN, A);
  const w = windowOf(range, now);
  const hourly = w.granularity === 'hour';
  const { rolled, start: historyStart } = await historyBounds(db, A);
  // Quotas, cost and storage are daily even for short ranges: at least the last 7 days.
  const dayStart = Math.min(w.start, Math.floor(now.getTime() / DAY) * DAY - 6 * DAY);
  const dayEnd = Math.floor(now.getTime() / DAY) * DAY + DAY;
  const days = Array.from({ length: Math.round((dayEnd - dayStart) / DAY) }, (_, i) => dayOf(dayStart + i * DAY));
  const hourlyQuotaFrom = Math.max(dayStart, rolled ? Date.parse(`${rolled}T00:00:00Z`) + DAY : dayStart);
  const yearAgo = dayOf(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const sparkStart = w.granularity === 'hour' ? w.start : w.end - 30 * DAY;

  const [series, totals, previous, perWorker, prevWorker, sparkR, quotaR, monthsR, storageR, namesR, workersR, eventsR, deploysR] = await db.batch([
    metricsQuery(db, A, w.start, w.end, rolled, w.granularity, null),
    metricsQuery(db, A, w.start, w.end, rolled, 'total', null, hourly),
    metricsQuery(db, A, w.prevStart, w.start, rolled, 'total', null, hourly),
    metricsQuery(db, A, w.start, w.end, rolled, 'script', null, hourly),
    metricsQuery(db, A, w.prevStart, w.start, rolled, 'script', null, hourly),
    // Requests per Worker per day for the table's sparklines (last 30 days, or the range by hour).
    w.granularity === 'hour'
      ? db.prepare(`SELECT script, substr(hour, 1, 13) AS t, SUM(requests) AS n FROM metrics_hourly WHERE account = ?1 AND hour >= ?2 GROUP BY script, ${range === '24h' ? 'hour' : 'substr(hour, 1, 10)'}`).bind(A, isoHour(new Date(sparkStart)))
      : db.prepare(
        `SELECT script, t, SUM(n) AS n FROM (
           SELECT script, day AS t, requests AS n FROM metrics_daily WHERE account = ?1 AND day >= ?2 AND (?3 IS NOT NULL AND day <= ?3)
           UNION ALL SELECT script, substr(hour, 1, 10), requests FROM metrics_hourly WHERE account = ?1 AND hour >= ?4
         ) GROUP BY script, t`,
      ).bind(A, dayOf(sparkStart), rolled, isoHour(new Date(Math.max(sparkStart, rolled ? Date.parse(`${rolled}T00:00:00Z`) + DAY : sparkStart)))),
    db.prepare(
      `SELECT metric, day, SUM(value) AS value, MAX(peak_hour) AS peak_hour FROM (
         SELECT metric, day, value, peak_hour FROM quota_daily WHERE account = ?1 AND day >= ?2 AND (?3 IS NOT NULL AND day <= ?3)
         UNION ALL SELECT metric, substr(hour, 1, 10), value, NULL FROM quota_hourly WHERE account = ?1 AND hour >= ?4
       ) GROUP BY metric, day`,
    ).bind(A, dayOf(dayStart), rolled, isoHour(new Date(hourlyQuotaFrom))),
    plan === 'paid'
      ? db.prepare(
        `SELECT metric, substr(day, 1, 7) AS month, SUM(value) AS value, MIN(day) AS first FROM (
           SELECT metric, day, value FROM quota_daily WHERE account = ?1 AND day >= ?2 AND (?3 IS NOT NULL AND day <= ?3)
           UNION ALL SELECT metric, substr(hour, 1, 10), value FROM quota_hourly WHERE account = ?1 AND hour >= ?4
         ) GROUP BY metric, month`,
      ).bind(A, yearAgo, rolled, isoHour(new Date(Math.max(Date.parse(`${yearAgo}T00:00:00Z`), rolled ? Date.parse(`${rolled}T00:00:00Z`) + DAY : 0))))
      : db.prepare('SELECT 1 WHERE 0'),
    db.prepare('SELECT kind, id, day, bytes FROM storage_daily WHERE account = ?1 AND day >= ?2 ORDER BY day').bind(A, dayOf(Math.min(dayStart, now.getTime() - 90 * DAY))),
    db.prepare(`SELECT kind, id, name FROM resources WHERE account = ?1 AND kind IN ('d1','kv','r2')`).bind(A),
    db.prepare('SELECT name, tags FROM workers WHERE account = ?1').bind(A),
    db.prepare('SELECT finding_id, at, kind, severity, check_id FROM finding_events WHERE account = ?1 AND at >= ?2 ORDER BY finding_id, at LIMIT 20000')
      .bind(A, new Date(w.start - 90 * DAY).toISOString()),
    db.prepare(
      `SELECT substr(d.created_on, 1, 10) AS day, COUNT(*) AS n,
         SUM(EXISTS (SELECT 1 FROM finding_events e WHERE e.account = d.account AND e.script = d.script AND e.kind IN ('opened', 'reopened')
           AND e.at >= d.created_on AND e.at < strftime('%Y-%m-%dT%H:%M:%fZ', d.created_on, '+2 hours'))) AS followed
       FROM deployments d WHERE d.account = ?1 AND d.created_on >= ?2 GROUP BY day`,
    ).bind(A, new Date(w.start).toISOString()),
  ]);

  // Per Worker, in scope only.
  const tags = new Map((workersR.results as { name: string; tags: string | null }[]).map((r) => [r.name, r.tags ? (JSON.parse(r.tags) as string[]) : []]));
  const prevBy = new Map((prevWorker.results as (Agg & { k: string })[]).map((r) => [r.k, r]));
  const sparkBuckets = w.granularity === 'hour'
    // w.end is the next hour boundary: the last day is the day of the hour before it (today).
    ? (range === '24h' ? w.buckets.map((b) => b.slice(0, 13)) : Array.from({ length: 7 }, (_, i) => dayOf(w.end - HOUR - (6 - i) * DAY)))
    : Array.from({ length: 30 }, (_, i) => dayOf(w.end - (30 - i) * DAY));
  const spark = new Map<string, Map<string, number>>();
  for (const r of sparkR.results as { script: string; t: string; n: number }[]) {
    const m = spark.get(r.script) ?? new Map<string, number>();
    m.set(range === '24h' ? r.t : r.t.slice(0, 10), r.n);
    spark.set(r.script, m);
  }
  const workers = (perWorker.results as (Agg & { k: string })[])
    .map((r) => ({ name: r.k, groups: groupsFor(config, r.k, tags.get(r.k) ?? []) }))
    .filter((x) => !tags.has(x.name) || inScope(config, x.name, x.groups))
    .map((x) => {
      const r = (perWorker.results as (Agg & { k: string })[]).find((y) => y.k === x.name);
      const s = spark.get(x.name);
      return { ...x, totals: toTotals(r), previous: toTotals(prevBy.get(x.name)), spark: sparkBuckets.map((b) => s?.get(b) ?? 0) };
    })
    .sort((a, b) => b.totals.requests - a.totals.requests);

  // Quotas per day.
  const quotaRows = quotaR.results as { metric: QuotaMetric; day: string; value: number; peak_hour: string | null }[];
  const limits = new Map(FREE_DAILY.map((q) => [q.metric, q.limit]));
  const metrics = [...new Set(quotaRows.map((r) => r.metric))];
  const quotas = metrics.map((m) => {
    const byDay = new Map(quotaRows.filter((r) => r.metric === m).map((r) => [r.day, r]));
    return {
      metric: m, label: QUOTA_LABEL[m] ?? m,
      limit: plan === 'free' ? (m === 'workers.requests' ? 100_000 : (limits.get(m) ?? null)) : null,
      days: days.map((d) => ({ day: d, value: byDay.get(d)?.value ?? 0, peakHour: byDay.get(d)?.peak_hour?.slice(11, 16) ?? null })),
    };
  }).filter((q) => q.days.some((d) => d.value > 0))
    .sort((a, b) => (a.metric === 'workers.requests' ? -1 : b.metric === 'workers.requests' ? 1 : a.label.localeCompare(b.label)));

  // Storage growth and the date each cap is reached at the current pace.
  const names = new Map((namesR.results as { kind: string; id: string; name: string | null }[]).map((r) => [`${r.kind}|${r.id}`, r.name ?? r.id]));
  const caps = STORAGE_LIMITS[plan];
  const byRes = new Map<string, { kind: StorageKind; id: string; days: { day: string; bytes: number }[] }>();
  for (const r of storageR.results as { kind: StorageKind; id: string; day: string; bytes: number }[]) {
    const k = `${r.kind}|${r.id}`;
    const e = byRes.get(k) ?? { kind: r.kind, id: r.id, days: [] };
    e.days.push({ day: r.day, bytes: r.bytes });
    byRes.set(k, e);
  }
  const storage = [...byRes.values()].map((s) => {
    const last = s.days.at(-1)!;
    // Growth per day over up to the last 30 days of samples.
    const from = s.days.find((d) => Date.parse(d.day) >= Date.parse(last.day) - 30 * DAY) ?? s.days[0];
    const span = (Date.parse(last.day) - Date.parse(from.day)) / DAY;
    const growth = span >= 3 ? (last.bytes - from.bytes) / span : null;
    const limit = s.id === '*' ? caps[s.kind].account : caps[s.kind].perResource;
    const capDate = limit && growth && growth > 0 && last.bytes < limit ? dayOf(Date.parse(last.day) + Math.ceil((limit - last.bytes) / growth) * DAY) : null;
    return {
      kind: s.kind, id: s.id, label: s.id === '*' ? 'Durable Objects' : (names.get(`${s.kind}|${s.id}`) ?? s.id), bytes: last.bytes,
      growthPerDay: growth, limit, capDate, days: s.days.filter((d) => d.day >= dayOf(w.start) || range === '24h' || range === '7d'),
    };
  }).sort((a, b) => (a.capDate ?? '9999').localeCompare(b.capDate ?? '9999') || b.bytes - a.bytes);

  // Cost: usage at list price per day; the bill per month with included usage.
  let cost: AnalyticsView['cost'] = null;
  if (plan === 'paid') {
    const priced = new Set(PRICES.items.map((p) => p.metric as QuotaMetric));
    const perDay = new Map<string, number>();
    for (const r of quotaRows) if (priced.has(r.metric)) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.value * unitPrice(r.metric));
    const monthRows = monthsR.results as { metric: QuotaMetric; month: string; value: number; first: string }[];
    const months = [...new Set(monthRows.map((r) => r.month))].sort().map((month) => {
      const usage = Object.fromEntries(monthRows.filter((r) => r.month === month).map((r) => [r.metric, r.value]));
      const first = monthRows.filter((r) => r.month === month).reduce((m, r) => (r.first < m ? r.first : m), '9999');
      const storageNow = Object.fromEntries([...byRes.values()].reduce((acc, s) => {
        const d = s.days.filter((x) => x.day.startsWith(month)).at(-1);
        if (d) acc.set(s.kind, (acc.get(s.kind) ?? 0) + d.bytes);
        return acc;
      }, new Map<StorageKind, number>()));
      return { month, amount: round2(monthlyCost(usage, storageNow).total), partial: first > `${month}-01` || month === dayOf(now.getTime()).slice(0, 7) };
    });
    const span = (w.end - w.start) / DAY;
    cost = {
      days: days.map((d) => ({ day: d, amount: round2(perDay.get(d) ?? 0) })),
      months,
      perWorker: workers.map((x) => {
        const amount = x.totals.requests * unitPrice('workers.requests') + (x.totals.cpuTimeUs / 1000) * unitPrice('workers.cpuMs');
        return { name: x.name, amount: round2(amount * (30 / Math.max(1, span))), perMillion: x.totals.requests ? round2((amount / x.totals.requests) * 1e6) : null };
      }).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 20),
      pricesAsOf: PRICES.asOf,
    };
  }

  return {
    range, granularity: w.granularity, from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString(),
    historyStart, plan,
    series: fill(w.buckets, series.results as Agg[]),
    totals: toTotals((totals.results as Agg[])[0]),
    previous: toTotals((previous.results as Agg[])[0]),
    workers,
    quotas,
    cost,
    storage,
    reliability: reliability(eventsR.results as Ev[], w.start, w.end, days.filter((d) => Date.parse(d) >= w.start - DAY)),
    deploys: (deploysR.results as { day: string; n: number; followed: number }[]).map((r) => ({ day: r.day, count: r.n, followedByFinding: r.followed })),
  };
}

type Ev = { finding_id: string; at: string; kind: string; severity: Severity | null; check_id: string | null };

/** Findings opened and resolved per day, time to resolve, and what happened to each check's findings. */
export function reliability(events: Ev[], start: number, end: number, days: string[]): AnalyticsView['reliability'] {
  const perDay = new Map(days.map((d) => [d, { day: d, opened: 0, resolved: 0 }]));
  const ttr: Record<Severity, number[]> = { critical: [], warning: [], info: [] };
  type C = { check: string; opened: number; alerted: number; acknowledged: number; snoozed: number; resolved: number; open: number[]; reopened: number };
  const checks = new Map<string, C>();
  let openedAt: string | null = null;
  let current = '';
  for (const e of events) {
    if (e.finding_id !== current) {
      current = e.finding_id;
      openedAt = null;
    }
    const t = Date.parse(e.at);
    const inRange = t >= start && t < end;
    if (e.kind === 'opened' || e.kind === 'reopened') openedAt = e.at;
    if (!inRange) continue;
    const day = perDay.get(e.at.slice(0, 10));
    // One row per check, not per resource: "zombies:unbound-kv-<id>" counts as zombies:unbound-kv.
    const [module, ...code] = (e.check_id ?? '?:?').split(':');
    const check = checkOf({ module: module as Finding['module'], code: code.join(':') });
    const c = checks.get(check) ?? { check, opened: 0, alerted: 0, acknowledged: 0, snoozed: 0, resolved: 0, open: [], reopened: 0 };
    if (e.kind === 'opened' || e.kind === 'reopened') {
      if (day) day.opened++;
      c.opened++;
      if (e.kind === 'reopened') c.reopened++;
    }
    if (e.kind === 'alerted') c.alerted++;
    if (e.kind === 'acknowledged') c.acknowledged++;
    if (e.kind === 'snoozed') c.snoozed++;
    if (e.kind === 'resolved') {
      if (day) day.resolved++;
      c.resolved++;
      if (openedAt) {
        const hours = (t - Date.parse(openedAt)) / HOUR;
        c.open.push(hours);
        if (e.severity) ttr[e.severity].push(hours);
      }
      openedAt = null;
    }
    checks.set(c.check, c);
  }
  const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    days: [...perDay.values()],
    mttrHours: { critical: r1(median(ttr.critical)), warning: r1(median(ttr.warning)), info: r1(median(ttr.info)) },
    checks: [...checks.values()]
      .map(({ open, ...c }) => ({ ...c, medianOpenHours: r1(median(open)) }))
      .sort((a, b) => b.opened - a.opened || a.check.localeCompare(b.check)),
  };
}

type FRow = FindingRow & { last_seen: string; status_at: string | null; snooze_until: string | null; reopen_count: number | null };

export async function buildWorkerDetail(env: Env, requested: string | undefined, name: string, range: Range, now = new Date()): Promise<WorkerDetail> {
  const db = env.DB;
  const global = await getSettings(db);
  const config = configFrom(global);
  const { account: acct } = await pickAccount(env, requested);
  const A = acct?.id ?? '';
  const plan = planFrom(config, acct?.detected_plan, env.PLAN, A);
  const state = A ? await getAccountState(db, A) : {};
  const w = windowOf(range, now);
  const hourly = w.granularity === 'hour';
  const { rolled, start: historyStart } = await historyBounds(db, A);
  const cronHourly = w.granularity === 'hour';
  const [series, totals, previous, workerR, schedR, entriesR, cronR, depR, findR, eventsR, auditR, impactR] = await db.batch([
    metricsQuery(db, A, w.start, w.end, rolled, w.granularity, name),
    metricsQuery(db, A, w.start, w.end, rolled, 'total', name, hourly),
    metricsQuery(db, A, w.prevStart, w.start, rolled, 'total', name, hourly),
    db.prepare('SELECT * FROM workers WHERE account = ?1 AND name = ?2').bind(A, name),
    db.prepare('SELECT crons FROM schedules WHERE account = ?1 AND script = ?2').bind(A, name),
    db.prepare(`SELECT name FROM resources WHERE account = ?1 AND kind IN ('route','domain') AND script = ?2`).bind(A, name),
    cronHourly
      ? db.prepare('SELECT hour AS t, runs, failures, cpu_max_ms FROM cron_runs WHERE account = ?1 AND script = ?2 AND hour >= ?3 ORDER BY hour').bind(A, name, isoHour(new Date(w.start)))
      : db.prepare(
        `SELECT t, SUM(runs) AS runs, SUM(failures) AS failures, MAX(cpu_max_ms) AS cpu_max_ms FROM (
           SELECT day AS t, runs, failures, cpu_max_ms FROM cron_daily WHERE account = ?1 AND script = ?2 AND day >= ?3 AND (?4 IS NOT NULL AND day <= ?4)
           UNION ALL SELECT substr(hour, 1, 10), runs, failures, cpu_max_ms FROM cron_runs WHERE account = ?1 AND script = ?2 AND hour >= ?5
         ) GROUP BY t ORDER BY t`,
      ).bind(A, name, dayOf(w.start), rolled, isoHour(new Date(Math.max(w.start, rolled ? Date.parse(`${rolled}T00:00:00Z`) + DAY : w.start)))),
    db.prepare('SELECT id, created_on, author, message, source FROM deployments WHERE account = ?1 AND script = ?2 AND created_on >= ?3 ORDER BY created_on DESC LIMIT 100')
      .bind(A, name, new Date(w.start).toISOString()),
    db.prepare(
      `SELECT * FROM findings WHERE account = ?1 AND script = ?2 AND (status <> 'resolved' OR last_seen >= ?3)
       ORDER BY CASE status WHEN 'resolved' THEN 1 ELSE 0 END, last_seen DESC LIMIT 200`,
    ).bind(A, name, new Date(w.start).toISOString()),
    db.prepare('SELECT at, kind, detail FROM fleet_events WHERE account = ?1 AND script = ?2 AND at >= ?3 ORDER BY at DESC LIMIT 100').bind(A, name, new Date(w.start).toISOString()),
    db.prepare(
      `SELECT at, action, description, actor FROM audit_events WHERE account = ?1 AND resource_id = ?2 AND at >= ?3 ORDER BY at DESC LIMIT 100`,
    ).bind(A, name, new Date(w.start).toISOString()),
    // Hourly rows around the deploys in the range (24 hours either side), for before and after.
    db.prepare(
      `SELECT hour, requests, errors, subrequests, cpu_time_us, cpu_p99, exceeded, exceeded_cpu, exceeded_memory, cpu_p50, wall_p50, wall_p99 FROM metrics_hourly
       WHERE account = ?1 AND script = ?2 AND hour >= ?3 ORDER BY hour`,
    ).bind(A, name, isoHour(new Date(w.start - DAY))),
  ]);

  type WRow = { name: string; handlers: string | null; tags: string | null; deployed_on: string | null; modified_on: string | null; created_on: string | null;
    compatibility_date: string | null; usage_model: string | null; workers_dev: number | null; previews_enabled: number | null; logs_enabled: number | null;
    bindings: string | null; detail_checked_at: string | null };
  const wr = (workerR.results as WRow[])[0];
  const bool = (v: number | null | undefined) => (v == null ? null : v === 1);
  const subdomain = state.workers_subdomain;
  const deploys = (depR.results as { id: string; created_on: string; author: string | null; message: string | null; source: string | null }[]);
  const findings: FindingListItem[] = (findR.results as FRow[]).map((r) => ({
    ...toFinding(r), lastSeen: r.last_seen, statusAt: r.status_at ?? null, snoozeUntil: r.snooze_until ?? null, reopenCount: r.reopen_count ?? 0,
  }));
  const correlated = new Map<string, string[]>();
  for (const f of findings) {
    const id = typeof f.evidence.deployId === 'string' ? f.evidence.deployId : null;
    if (id) correlated.set(id, [...(correlated.get(id) ?? []), f.code]);
  }

  // Before and after each deploy: the 24 hours either side, from the hourly rows.
  type HRow = { hour: string; requests: number; errors: number; subrequests: number; cpu_time_us: number; cpu_p99: number | null; exceeded: number; exceeded_cpu: number | null; exceeded_memory: number | null;
    cpu_p50: number | null; wall_p50: number | null; wall_p99: number | null };
  const hours = impactR.results as HRow[];
  const sum = (from: number, to: number): MetricTotals => {
    const t = { ...ZERO };
    let w50 = 0, n50 = 0, c50 = 0, m50 = 0;
    for (const h of hours) {
      const ts = Date.parse(h.hour);
      if (ts < from || ts >= to) continue;
      t.requests += h.requests ?? 0;
      t.errors += h.errors ?? 0;
      t.subrequests += h.subrequests ?? 0;
      t.cpuTimeUs += h.cpu_time_us ?? 0;
      t.exceeded += h.exceeded ?? 0;
      t.exceededCpu += h.exceeded_cpu ?? 0;
      t.exceededMemory += h.exceeded_memory ?? 0;
      if (h.cpu_p99 != null) t.cpuP99 = Math.max(t.cpuP99 ?? 0, h.cpu_p99);
      if (h.wall_p99 != null) t.wallP99 = Math.max(t.wallP99 ?? 0, h.wall_p99);
      if (h.cpu_p50 != null) { c50 += h.cpu_p50 * h.requests; m50 += h.requests; }
      if (h.wall_p50 != null) { w50 += h.wall_p50 * h.requests; n50 += h.requests; }
    }
    t.cpuP50 = m50 ? c50 / m50 : null;
    t.wallP50 = n50 ? w50 / n50 : null;
    return t;
  };
  const deployImpact = deploys.slice(0, 20).map((d) => {
    const t = Math.floor(Date.parse(d.created_on) / HOUR) * HOUR;
    return { id: d.id, createdOn: d.created_on, before: sum(t - DAY, t), after: sum(t + HOUR, t + HOUR + DAY) };
  });

  const total = toTotals((totals.results as Agg[])[0]);
  let cost: WorkerDetail['cost'] = null;
  if (plan === 'paid') {
    const amount = total.requests * unitPrice('workers.requests') + (total.cpuTimeUs / 1000) * unitPrice('workers.cpuMs');
    cost = { amount: round2(amount), perMillion: total.requests ? round2((amount / total.requests) * 1e6) : null };
  }
  const changes = [
    ...(eventsR.results as { at: string; kind: string; detail: string | null }[]).map((e) => ({
      at: e.at, kind: e.kind, detail: e.kind === 'binding-removed' ? `Binding ${e.detail} removed` : e.detail,
    })),
    ...(auditR.results as { at: string; action: string | null; description: string | null; actor: string | null }[]).map((a) => ({
      at: a.at, kind: 'audit', detail: `${a.description || a.action || 'Change'}${a.actor ? ` (${a.actor})` : ''}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    name,
    exists: Boolean(wr),
    range, granularity: w.granularity, from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString(), historyStart,
    groups: wr ? groupsFor(config, name, wr.tags ? JSON.parse(wr.tags) : []) : [],
    handlers: wr?.handlers ? JSON.parse(wr.handlers) : [],
    deployedOn: wr?.deployed_on ?? wr?.modified_on ?? null,
    createdOn: wr?.created_on ?? null,
    compatibilityDate: wr?.compatibility_date ?? null,
    usageModel: wr?.usage_model ?? null,
    workersDev: bool(wr?.workers_dev),
    previewsEnabled: bool(wr?.previews_enabled),
    logsEnabled: bool(wr?.logs_enabled),
    entryPoints: [...(entriesR.results as { name: string }[]).map((e) => e.name), ...(wr?.workers_dev && subdomain ? [`${name}.${subdomain}.workers.dev`] : [])],
    bindings: wr?.detail_checked_at && wr.bindings ? JSON.parse(wr.bindings) : null,
    crons: (schedR.results as { crons: string }[])[0] ? JSON.parse((schedR.results as { crons: string }[])[0].crons) : [],
    series: fill(w.buckets, series.results as Agg[]),
    totals: total,
    previous: toTotals((previous.results as Agg[])[0]),
    cron: (cronR.results as { t: string; runs: number; failures: number; cpu_max_ms: number | null }[]).map((r) => ({ t: r.t, runs: r.runs, failures: r.failures, cpuMaxMs: r.cpu_max_ms })),
    deploys: deploys.map((d) => ({ id: d.id, createdOn: d.created_on, author: d.author, message: d.message, source: d.source, correlated: correlated.get(d.id) ?? [] })),
    deployImpact,
    findings,
    changes,
    cost,
  };
}
