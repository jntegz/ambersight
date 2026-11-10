// Read-side views from D1: the overview, the change timeline and the Self-cost panel.
// No Cloudflare API calls happen on page view.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope } from '../shared/config';
import { SEVERITY_WEIGHT, type AccountSummary, type Finding, type Overview, type SelfCost, type Severity, type TimelineEntry, type WorkerSummary } from '../shared/types';
import { FREE_DAILY, STORAGE_LIMITS, type QuotaMetric, type StorageKind } from '../shared/limits';
import type { CostEstimate, QuotaStatus, StorageStatus } from '../shared/types';
import { FREE_DAILY_REQUESTS, projectLimitTime } from './checks';
import { estimate } from './cost';
import { configFrom, getAccountState, getSettings, isoHour, planFrom, utcMidnight, type AccountRow } from './db';
import type { Env } from './env';
import { updateNotice } from './scan';
import { activeAccounts } from './scheduler';

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface FindingRow {
  id: string;
  script: string;
  module: Finding['module'];
  severity: Severity;
  code: string;
  message: string;
  evidence: string;
  action: string;
  docs_url: string | null;
  first_seen: string;
  status: Finding['status'];
}

const toFinding = (r: FindingRow): Finding => ({
  id: r.id,
  script: r.script,
  module: r.module,
  severity: r.severity,
  code: r.code,
  message: r.message,
  evidence: JSON.parse(r.evidence),
  action: r.action,
  docsUrl: r.docs_url ?? undefined,
  firstSeen: r.first_seen,
  status: r.status,
});

/** Display name: the label from Settings, then the Cloudflare account name, then the ID. */
export const accountLabel = (a: Pick<AccountRow, 'id' | 'name'>, config: ReturnType<typeof configFrom>) => config.accounts[a.id]?.label ?? a.name ?? a.id;

/** The account a request asks for, or the first watched one. Null before setup. */
export async function pickAccount(env: Env, requested?: string | null): Promise<{ account: AccountRow | null; accounts: AccountRow[] }> {
  const accounts = await activeAccounts(env).catch(() => [] as AccountRow[]);
  return { account: accounts.find((a) => a.id === requested) ?? accounts[0] ?? null, accounts };
}

export async function buildOverview(env: Env, requested?: string | null, now = new Date()): Promise<Overview> {
  const db = env.DB;
  const global = await getSettings(db);
  const config = configFrom(global);
  const { account: acct, accounts } = await pickAccount(env, requested);
  const A = acct?.id ?? '';
  const settings = A ? await getAccountState(db, A) : {};
  const plan = planFrom(config, acct?.detected_plan, env.PLAN, A);
  const midnight = isoHour(utcMidnight(now));
  const dayAgo = isoHour(new Date(now.getTime() - DAY));
  const weekStart = isoHour(new Date(utcMidnight(now).getTime() - 6 * DAY));

  const monthStart = isoHour(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const [workers, hourly, daily, today, findings, entries, quotaToday, quotaMonth, storageR, resNames, week] = await db.batch([
    db.prepare('SELECT name, deployed_on, modified_on, handlers, tags, workers_dev FROM workers WHERE account = ?1 ORDER BY name').bind(A),
    db.prepare('SELECT script, hour, requests, errors FROM metrics_hourly WHERE account = ?1 AND hour >= ?2').bind(A, dayAgo),
    db.prepare(
      `SELECT script, substr(hour, 1, 10) AS day, SUM(requests) AS requests FROM metrics_hourly
       WHERE account = ?1 AND hour >= ?2 GROUP BY script, day`,
    ).bind(A, weekStart),
    db.prepare('SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors FROM metrics_hourly WHERE account = ?1 AND hour >= ?2').bind(A, midnight),
    db.prepare(`SELECT * FROM findings WHERE account = ?1 AND status = 'open'`).bind(A),
    db.prepare(`SELECT name, script FROM resources WHERE account = ?1 AND kind IN ('route','domain')`).bind(A),
    db.prepare('SELECT metric, SUM(value) AS v FROM quota_hourly WHERE account = ?1 AND hour >= ?2 GROUP BY metric').bind(A, midnight),
    db.prepare('SELECT metric, SUM(value) AS v, MIN(hour) AS first FROM quota_hourly WHERE account = ?1 AND hour >= ?2 GROUP BY metric').bind(A, monthStart),
    db.prepare('SELECT kind, id, bytes FROM storage_sizes WHERE account = ?1').bind(A),
    db.prepare(`SELECT kind, id, name FROM resources WHERE account = ?1 AND kind IN ('d1','kv','r2')`).bind(A),
    db.prepare(
      `SELECT script, SUM(requests) AS requests, SUM(cpu_time_us) AS cpu FROM metrics_hourly WHERE account = ?1 AND hour >= ?2 GROUP BY script`,
    ).bind(A, isoHour(new Date(now.getTime() - 7 * DAY))),
  ]);
  const usedToday = Object.fromEntries((quotaToday.results as { metric: QuotaMetric; v: number }[]).map((r) => [r.metric, r.v]));
  const quotas: QuotaStatus[] = plan === 'free'
    ? FREE_DAILY.filter((q) => (usedToday[q.metric] ?? 0) > 0).map((q) => ({
        metric: q.metric, label: q.label, used: usedToday[q.metric], limit: q.limit,
        share: usedToday[q.metric] / q.limit, projectedLimitAt: projectLimitTime(now, usedToday[q.metric], q.limit),
      })).sort((a, b) => b.share - a.share)
    : [];
  const names = new Map((resNames.results as { kind: string; id: string; name: string | null }[]).map((r) => [`${r.kind}|${r.id}`, r.name ?? r.id]));
  const sizes = storageR.results as { kind: StorageKind; id: string; bytes: number }[];
  const caps = STORAGE_LIMITS[plan];
  const PRODUCT: Record<StorageKind, string> = { d1: 'D1', kv: 'KV', r2: 'R2', do: 'Durable Objects' };
  const storage: StorageStatus[] = [];
  const totals = new Map<StorageKind, number>();
  for (const z of sizes) {
    totals.set(z.kind, (totals.get(z.kind) ?? 0) + z.bytes);
    const cap = caps[z.kind].perResource;
    if (cap && z.id !== '*') storage.push({ kind: z.kind, label: names.get(`${z.kind}|${z.id}`) ?? z.id, bytes: z.bytes, limit: cap, share: z.bytes / cap });
  }
  for (const [kind, bytes] of totals) {
    const cap = caps[kind].account;
    storage.push({ kind, label: `All ${PRODUCT[kind]}`, bytes, limit: cap, share: cap ? bytes / cap : null });
  }
  storage.sort((a, b) => (b.share ?? -1) - (a.share ?? -1) || b.bytes - a.bytes);
  let cost: CostEstimate | null = null;
  if (plan === 'paid' && config.modules.cost) {
    const month = quotaMonth.results as { metric: QuotaMetric; v: number; first: string }[];
    const firstHour = month.reduce<string | null>((m, r) => (!m || r.first < m ? r.first : m), null);
    cost = estimate(
      now,
      Object.fromEntries(month.map((r) => [r.metric, r.v])),
      Object.fromEntries(totals),
      (week.results as { script: string; requests: number; cpu: number }[]).map((r) => ({ name: r.script, requests: r.requests, cpuMs: (r.cpu ?? 0) / 1000 })),
      firstHour,
    );
  }

  type W = { name: string; deployed_on: string | null; modified_on: string | null; handlers: string | null; tags: string | null; workers_dev: number | null };
  const all = (workers.results as W[]).map((w) => ({ ...w, groups: groupsFor(config, w.name, w.tags ? JSON.parse(w.tags) : []) }));
  const visible = all.filter((w) => inScope(config, w.name, w.groups));
  const visibleNames = new Set(visible.map((w) => w.name));

  const open = (findings.results as unknown as FindingRow[])
    .map(toFinding)
    .filter((f) => f.script === '*' || visibleNames.has(f.script))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.firstSeen ?? '').localeCompare(a.firstSeen ?? ''));

  // Last 24 hours, hourly, and last 7 days, daily.
  const hours = Array.from({ length: 24 }, (_, i) => isoHour(new Date(now.getTime() - (23 - i) * HOUR)));
  const days = Array.from({ length: 7 }, (_, i) => new Date(utcMidnight(now).getTime() - (6 - i) * DAY).toISOString().slice(0, 10));
  const spark24 = new Map<string, number[]>();
  const dayTotals = new Map<string, { requests: number; errors: number }>();
  for (const r of hourly.results as { script: string; hour: string; requests: number; errors: number }[]) {
    const s = spark24.get(r.script) ?? hours.map(() => 0);
    const i = hours.indexOf(r.hour);
    if (i >= 0) s[i] = r.requests;
    spark24.set(r.script, s);
    const t = dayTotals.get(r.script) ?? { requests: 0, errors: 0 };
    t.requests += r.requests;
    t.errors += r.errors;
    dayTotals.set(r.script, t);
  }
  const spark7 = new Map<string, number[]>();
  for (const r of daily.results as { script: string; day: string; requests: number }[]) {
    const s = spark7.get(r.script) ?? days.map(() => 0);
    const i = days.indexOf(r.day);
    if (i >= 0) s[i] = r.requests;
    spark7.set(r.script, s);
  }
  const entryBy = new Map<string, string[]>();
  for (const e of entries.results as { name: string; script: string | null }[]) {
    if (e.script) entryBy.set(e.script, [...(entryBy.get(e.script) ?? []), e.name]);
  }
  const subdomain = settings.workers_subdomain;

  const summaries: WorkerSummary[] = visible.map((w) => {
    const mine = open.filter((f) => f.script === w.name);
    const handlers: string[] = w.handlers ? JSON.parse(w.handlers) : [];
    return {
      name: w.name,
      score: mine.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0),
      requests24h: dayTotals.get(w.name)?.requests ?? 0,
      errors24h: dayTotals.get(w.name)?.errors ?? 0,
      spark: spark7.get(w.name) ?? days.map(() => 0),
      spark24: spark24.get(w.name) ?? hours.map(() => 0),
      deployedOn: w.deployed_on ?? w.modified_on,
      handlers,
      groups: w.groups,
      entryPoints: [...(entryBy.get(w.name) ?? []), ...(w.workers_dev && subdomain ? [`${w.name}.${subdomain}.workers.dev`] : [])],
      topFinding: mine[0] ?? null,
      latestFindingAt: mine.reduce<string | null>((m, f) => (!m || (f.firstSeen ?? '') > m ? (f.firstSeen ?? m) : m), null),
    };
  });
  // Attention score, then most recent finding, then traffic.
  summaries.sort(
    (a, b) => b.score - a.score || (b.latestFindingAt ?? '').localeCompare(a.latestFindingAt ?? '') || b.requests24h - a.requests24h || a.name.localeCompare(b.name),
  );

  const t = today.results[0] as { requests: number; errors: number };
  return {
    account: acct ? { id: acct.id, label: accountLabel(acct, config), plan } : null,
    accountCount: accounts.length,
    scanHealth: {
      failures: Number(settings.scan_failures ?? 0),
      lastError: settings.last_scan_error ?? null,
      lastAttemptAt: settings.last_attempt_at ?? null,
    },
    lastScanAt: settings.last_scan_at ?? null,
    setupDone: global.setup_done === '1',
    update: updateNotice(global),
    totals: {
      workers: summaries.length,
      needAttention: summaries.filter((s) => s.score > 0).length,
      requestsToday: t.requests,
      errorsToday: t.errors,
    },
    budget:
      plan === 'free'
        ? {
            plan,
            limit: FREE_DAILY_REQUESTS,
            usedToday: t.requests,
            share: t.requests / FREE_DAILY_REQUESTS,
            projectedLimitAt: projectLimitTime(now, t.requests),
            warnAt: config.thresholds.budgetWarn,
            criticalAt: config.thresholds.budgetCritical,
          }
        : null,
    quotas,
    storage,
    cost,
    findings: open,
    workers: summaries,
    groups: [...new Set(visible.flatMap((w) => w.groups))].sort(),
  };
}

/** M8: every deployment across the fleet, newest first, with correlated findings marked. */
export async function buildTimeline(env: Env, account: string, days = 14): Promise<TimelineEntry[]> {
  const db = env.DB;
  const settings = await getSettings(db);
  const config = configFrom(settings);
  const since = new Date(Date.now() - days * DAY).toISOString();
  const [deps, workers, findings, alerts] = await db.batch([
    db.prepare('SELECT script, id, created_on, author, message, source FROM deployments WHERE account = ?1 AND created_on >= ?2 ORDER BY created_on DESC LIMIT 300').bind(account, since),
    db.prepare('SELECT name, tags FROM workers WHERE account = ?1').bind(account),
    db.prepare(`SELECT code, evidence FROM findings WHERE account = ?1 AND status <> 'resolved' AND evidence LIKE '%deployId%'`).bind(account),
    db.prepare('SELECT id, sent, alert_type, name, description FROM cf_alerts WHERE account = ?1 AND sent >= ?2 ORDER BY sent DESC LIMIT 100').bind(account, since),
  ]);
  const tags = new Map((workers.results as { name: string; tags: string | null }[]).map((w) => [w.name, w.tags ? (JSON.parse(w.tags) as string[]) : []]));
  const correlated = new Map<string, string[]>();
  for (const f of findings.results as { code: string; evidence: string }[]) {
    const id = (JSON.parse(f.evidence) as { deployId?: string }).deployId;
    if (id) correlated.set(id, [...(correlated.get(id) ?? []), f.code]);
  }
  const deploys: TimelineEntry[] = (deps.results as { script: string; id: string; created_on: string; author: string | null; message: string | null; source: string | null }[])
    .map((d) => ({ d, groups: groupsFor(config, d.script, tags.get(d.script) ?? []) }))
    .filter(({ d, groups }) => !tags.has(d.script) || inScope(config, d.script, groups))
    .map(({ d, groups }) => ({
      kind: 'deploy' as const,
      script: d.script,
      id: d.id,
      createdOn: d.created_on,
      author: d.author,
      message: d.message,
      source: d.source,
      groups,
      correlated: correlated.get(d.id) ?? [],
    }));
  // Cloudflare's own notifications: account-wide, so they show under every group.
  const cf: TimelineEntry[] = (alerts.results as { id: string; sent: string; alert_type: string | null; name: string | null; description: string | null }[]).map((a) => ({
    kind: 'cf-alert',
    script: '*',
    id: `cf-${a.id}`,
    createdOn: a.sent,
    author: 'Cloudflare',
    message: a.description || a.name,
    source: a.name ?? a.alert_type,
    groups: [],
    correlated: [],
  }));
  return [...deploys, ...cf].sort((a, b) => b.createdOn.localeCompare(a.createdOn));
}

export async function buildSelfCost(env: Env, account: string): Promise<SelfCost> {
  const db = env.DB;
  const settings = await getAccountState(db, account);
  const { results } = await db
    .prepare('SELECT * FROM usage_daily WHERE day >= ?1 ORDER BY day DESC')
    .bind(new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10))
    .all<{ day: string; cron_runs: number; api_requests: number; subrequests: number; rows_read: number; rows_written: number }>();
  return {
    days: results.map((r) => ({ day: r.day, cronRuns: r.cron_runs, apiRequests: r.api_requests, subrequests: r.subrequests, rowsRead: r.rows_read, rowsWritten: r.rows_written })),
    lastScan: {
      at: settings.last_scan_at ?? null,
      subrequests: Number(settings.last_scan_calls ?? 0),
      durationMs: Number(settings.last_scan_ms ?? 0),
      warnings: settings.last_scan_warnings ? JSON.parse(settings.last_scan_warnings) : [],
    },
    allowances: { requestsPerDay: FREE_DAILY_REQUESTS, subrequestsPerRun: 50, rowsWrittenPerDay: 100_000, rowsReadPerDay: 5_000_000 },
  };
}

/** The "All accounts" view: one row per watched account. */
export async function buildAccounts(env: Env, now = new Date()): Promise<AccountSummary[]> {
  const db = env.DB;
  const config = configFrom(await getSettings(db));
  const accounts = await activeAccounts(env, now);
  const ids = JSON.stringify(accounts.map((a) => a.id));
  const [counts, today, state, workers] = await db.batch([
    db.prepare(
      `SELECT account, severity, COUNT(*) AS n FROM findings WHERE status = 'open' AND account IN (SELECT value FROM json_each(?1))
       GROUP BY account, severity`,
    ).bind(ids),
    db.prepare(
      `SELECT account, COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors FROM metrics_hourly
       WHERE hour >= ?2 AND account IN (SELECT value FROM json_each(?1)) GROUP BY account`,
    ).bind(ids, isoHour(utcMidnight(now))),
    db.prepare(
      `SELECT account, key, value FROM account_state WHERE key IN ('last_scan_at', 'scan_failures', 'last_scan_error')
       AND account IN (SELECT value FROM json_each(?1))`,
    ).bind(ids),
    db.prepare(`SELECT account, COUNT(*) AS n FROM workers WHERE account IN (SELECT value FROM json_each(?1)) GROUP BY account`).bind(ids),
  ]);
  const sev = new Map<string, Record<Severity, number>>();
  for (const r of counts.results as { account: string; severity: Severity; n: number }[]) {
    const m = sev.get(r.account) ?? { critical: 0, warning: 0, info: 0 };
    m[r.severity] = r.n;
    sev.set(r.account, m);
  }
  const t = new Map((today.results as { account: string; requests: number; errors: number }[]).map((r) => [r.account, r]));
  const st = new Map<string, Record<string, string>>();
  for (const r of state.results as { account: string; key: string; value: string }[]) st.set(r.account, { ...(st.get(r.account) ?? {}), [r.key]: r.value });
  const w = new Map((workers.results as { account: string; n: number }[]).map((r) => [r.account, r.n]));
  return accounts.map((a) => {
    const plan = planFrom(config, a.detected_plan, env.PLAN, a.id);
    const requests = t.get(a.id)?.requests ?? 0;
    const s = st.get(a.id) ?? {};
    return {
      id: a.id,
      label: accountLabel(a, config),
      plan,
      workers: w.get(a.id) ?? 0,
      findings: sev.get(a.id) ?? { critical: 0, warning: 0, info: 0 },
      requestsToday: requests,
      errorsToday: t.get(a.id)?.errors ?? 0,
      budgetShare: plan === 'free' ? requests / FREE_DAILY_REQUESTS : null,
      lastScanAt: s.last_scan_at ?? null,
      scanFailures: Number(s.scan_failures ?? 0),
      lastError: s.last_scan_error ?? null,
    };
  });
}

