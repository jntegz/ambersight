// Builds the one-page overview from D1. No Cloudflare API calls happen on page view.
// SPDX-License-Identifier: AGPL-3.0-only

import { SEVERITY_WEIGHT, type Finding, type Overview, type Severity, type WorkerSummary } from '../shared/types';
import { FREE_DAILY_REQUESTS, projectLimitTime } from './checks';
import { getSettings, isoHour, utcMidnight } from './db';
import type { Env } from './env';

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

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

export async function buildOverview(env: Env, now = new Date()): Promise<Overview> {
  const db = env.DB;
  const settings = await getSettings(db);
  const plan: 'free' | 'paid' = (settings.plan ?? env.PLAN) === 'paid' ? 'paid' : 'free';
  const midnight = isoHour(utcMidnight(now));
  const dayAgo = isoHour(new Date(now.getTime() - 86_400_000));
  const weekStart = isoHour(new Date(utcMidnight(now).getTime() - 6 * 86_400_000));

  const [workers, day, daily, today, findings] = await db.batch([
    db.prepare('SELECT name, deployed_on, modified_on, handlers FROM workers ORDER BY name'),
    db.prepare('SELECT script, SUM(requests) AS requests, SUM(errors) AS errors FROM metrics_hourly WHERE hour >= ?1 GROUP BY script').bind(dayAgo),
    db.prepare(
      `SELECT script, substr(hour, 1, 10) AS day, SUM(requests) AS requests FROM metrics_hourly
       WHERE hour >= ?1 GROUP BY script, day`,
    ).bind(weekStart),
    db.prepare('SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors FROM metrics_hourly WHERE hour >= ?1').bind(midnight),
    db.prepare(`SELECT * FROM findings WHERE status = 'open'`),
  ]);

  const open: Finding[] = (findings.results as FindingRow[])
    .map((r) => ({
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
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.firstSeen ?? '').localeCompare(a.firstSeen ?? ''));

  const dayBy = new Map((day.results as { script: string; requests: number; errors: number }[]).map((r) => [r.script, r]));
  const days = Array.from({ length: 7 }, (_, i) => new Date(utcMidnight(now).getTime() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
  const sparkBy = new Map<string, number[]>();
  for (const r of daily.results as { script: string; day: string; requests: number }[]) {
    const s = sparkBy.get(r.script) ?? days.map(() => 0);
    const i = days.indexOf(r.day);
    if (i >= 0) s[i] = r.requests;
    sparkBy.set(r.script, s);
  }

  const summaries: WorkerSummary[] = (workers.results as { name: string; deployed_on: string | null; modified_on: string | null; handlers: string | null }[]).map((w) => {
    const mine = open.filter((f) => f.script === w.name);
    return {
      name: w.name,
      score: mine.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0),
      requests24h: dayBy.get(w.name)?.requests ?? 0,
      errors24h: dayBy.get(w.name)?.errors ?? 0,
      spark: sparkBy.get(w.name) ?? days.map(() => 0),
      deployedOn: w.deployed_on ?? w.modified_on,
      handlers: w.handlers ? JSON.parse(w.handlers) : [],
      topFinding: mine[0] ?? null,
    };
  });
  summaries.sort((a, b) => b.score - a.score || b.requests24h - a.requests24h || a.name.localeCompare(b.name));

  const t = today.results[0] as { requests: number; errors: number };
  return {
    lastScanAt: settings.last_scan_at ?? null,
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
          }
        : null,
    findings: open,
    workers: summaries,
  };
}
