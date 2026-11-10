// Read-side views from D1: the overview, the change timeline and the Self-cost panel.
// No Cloudflare API calls happen on page view.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope } from '../shared/config';
import { SEVERITY_WEIGHT, type Finding, type Overview, type SelfCost, type Severity, type TimelineEntry, type WorkerSummary } from '../shared/types';
import { FREE_DAILY_REQUESTS, projectLimitTime } from './checks';
import { configFrom, getSettings, isoHour, planFrom, utcMidnight } from './db';
import type { Env } from './env';
import { updateNotice } from './scan';

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

export async function buildOverview(env: Env, now = new Date()): Promise<Overview> {
  const db = env.DB;
  const settings = await getSettings(db);
  const config = configFrom(settings);
  const plan = planFrom(config, settings, env.PLAN);
  const midnight = isoHour(utcMidnight(now));
  const dayAgo = isoHour(new Date(now.getTime() - DAY));
  const weekStart = isoHour(new Date(utcMidnight(now).getTime() - 6 * DAY));

  const [workers, hourly, daily, today, findings, entries] = await db.batch([
    db.prepare('SELECT name, deployed_on, modified_on, handlers, tags, workers_dev FROM workers ORDER BY name'),
    db.prepare('SELECT script, hour, requests, errors FROM metrics_hourly WHERE hour >= ?1').bind(dayAgo),
    db.prepare(
      `SELECT script, substr(hour, 1, 10) AS day, SUM(requests) AS requests FROM metrics_hourly
       WHERE hour >= ?1 GROUP BY script, day`,
    ).bind(weekStart),
    db.prepare('SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors FROM metrics_hourly WHERE hour >= ?1').bind(midnight),
    db.prepare(`SELECT * FROM findings WHERE status = 'open'`),
    db.prepare(`SELECT name, script FROM resources WHERE kind IN ('route','domain')`),
  ]);

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
    lastScanAt: settings.last_scan_at ?? null,
    setupDone: settings.setup_done === '1',
    update: updateNotice(settings),
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
    findings: open,
    workers: summaries,
    groups: [...new Set(visible.flatMap((w) => w.groups))].sort(),
  };
}

/** M8: every deployment across the fleet, newest first, with correlated findings marked. */
export async function buildTimeline(env: Env, days = 14): Promise<TimelineEntry[]> {
  const db = env.DB;
  const settings = await getSettings(db);
  const config = configFrom(settings);
  const since = new Date(Date.now() - days * DAY).toISOString();
  const [deps, workers, findings] = await db.batch([
    db.prepare('SELECT script, id, created_on, author, message, source FROM deployments WHERE created_on >= ?1 ORDER BY created_on DESC LIMIT 300').bind(since),
    db.prepare('SELECT name, tags FROM workers'),
    db.prepare(`SELECT code, evidence FROM findings WHERE status <> 'resolved' AND evidence LIKE '%deployId%'`),
  ]);
  const tags = new Map((workers.results as { name: string; tags: string | null }[]).map((w) => [w.name, w.tags ? (JSON.parse(w.tags) as string[]) : []]));
  const correlated = new Map<string, string[]>();
  for (const f of findings.results as { code: string; evidence: string }[]) {
    const id = (JSON.parse(f.evidence) as { deployId?: string }).deployId;
    if (id) correlated.set(id, [...(correlated.get(id) ?? []), f.code]);
  }
  return (deps.results as { script: string; id: string; created_on: string; author: string | null; message: string | null; source: string | null }[])
    .map((d) => ({ d, groups: groupsFor(config, d.script, tags.get(d.script) ?? []) }))
    .filter(({ d, groups }) => !tags.has(d.script) || inScope(config, d.script, groups))
    .map(({ d, groups }) => ({
      script: d.script,
      id: d.id,
      createdOn: d.created_on,
      author: d.author,
      message: d.message,
      source: d.source,
      groups,
      correlated: correlated.get(d.id) ?? [],
    }));
}

export async function buildSelfCost(env: Env): Promise<SelfCost> {
  const db = env.DB;
  const settings = await getSettings(db);
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
