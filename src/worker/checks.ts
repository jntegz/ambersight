// v0.1 checks: free-plan budget, errors and limits, runaway usage, cron health.
// Pure functions: data in, findings out. No I/O here, so they are cheap and testable.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Finding, Severity } from '../shared/types';

export interface Thresholds {
  budgetWarn: number; // share of the daily free limit, e.g. 0.7
  budgetCritical: number; // e.g. 0.9
  errorWarn: number; // error rate, e.g. 0.02
  errorCritical: number; // e.g. 0.1
  errorMinRequests: number; // ignore error rates below this many requests in 24 h
  runawayMultiplier: number; // last hour vs 7-day hourly median, e.g. 5
  runawayMinRequests: number; // ignore runaway below this many requests in the last hour
  runawayMinHistoryHours: number; // need this much history before judging
  cpuShareWarn: number; // p99 CPU as share of the plan limit, e.g. 0.8
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  budgetWarn: 0.7,
  budgetCritical: 0.9,
  errorWarn: 0.02,
  errorCritical: 0.1,
  errorMinRequests: 50,
  runawayMultiplier: 5,
  runawayMinRequests: 500,
  runawayMinHistoryHours: 72,
  cpuShareWarn: 0.8,
};

export const FREE_DAILY_REQUESTS = 100_000;
export const FREE_CPU_MS = 10;

export interface WorkerStats {
  name: string;
  requests24h: number;
  errors24h: number;
  exceeded24h: number;
  cpuP99Max24h: number | null;
  lastHourRequests: number;
  hourlyMedian7d: number;
  historyHours: number;
}

export interface CronStats {
  name: string;
  expected: number;
  observed: number;
  failures: number;
}

export interface CheckInput {
  now: Date;
  plan: 'free' | 'paid';
  accountRequestsToday: number;
  workers: WorkerStats[];
  crons: CronStats[] | null; // null = cron dataset unavailable
  thresholds?: Partial<Thresholds>;
}

const DOCS = {
  limits: 'https://developers.cloudflare.com/workers/platform/limits/',
  errors: 'https://developers.cloudflare.com/workers/observability/errors/',
  cron: 'https://developers.cloudflare.com/workers/configuration/cron-triggers/',
  budget: 'https://developers.cloudflare.com/billing/manage/budget-alerts/',
};

function finding(
  module: Finding['module'], script: string, code: string, severity: Severity,
  message: string, evidence: Finding['evidence'], action: string, docsUrl: string,
): Finding {
  return { id: `${module}:${script}:${code}`, module, script, code, severity, message, evidence, action, docsUrl };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function budgetFindings(input: CheckInput, t: Thresholds): Finding[] {
  if (input.plan !== 'free') return [];
  const share = input.accountRequestsToday / FREE_DAILY_REQUESTS;
  if (share < t.budgetWarn) return [];
  const severity: Severity = share >= t.budgetCritical ? 'critical' : 'warning';
  const projected = projectLimitTime(input.now, input.accountRequestsToday);
  return [
    finding(
      'budget', '*', 'free-daily-requests', severity,
      `You have used ${pct(share)} of today's free Workers requests.`,
      { usedToday: input.accountRequestsToday, limit: FREE_DAILY_REQUESTS, projectedLimitAt: projected ?? 'not today' },
      projected
        ? `At this pace the account hits the limit around ${projected.slice(11, 16)} UTC and Workers return Error 1027 until midnight UTC. Find the Worker driving traffic below, or move to Workers Paid.`
        : 'Usage is high but should stay under the limit today. Check which Worker drives traffic.',
      DOCS.limits,
    ),
  ];
}

/** Linear projection of when today's free limit is reached, or null if not today. */
export function projectLimitTime(now: Date, usedToday: number): string | null {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsedMs = now.getTime() - midnight;
  if (usedToday <= 0 || elapsedMs <= 0) return null;
  if (usedToday >= FREE_DAILY_REQUESTS) return now.toISOString();
  const rate = usedToday / elapsedMs;
  const hitAt = midnight + FREE_DAILY_REQUESTS / rate;
  return hitAt < midnight + 86_400_000 ? new Date(hitAt).toISOString() : null;
}

export function errorFindings(input: CheckInput, t: Thresholds): Finding[] {
  const out: Finding[] = [];
  const cpuLimit = input.plan === 'free' ? FREE_CPU_MS : null;
  for (const w of input.workers) {
    if (w.requests24h >= t.errorMinRequests) {
      const rate = w.errors24h / w.requests24h;
      if (rate >= t.errorWarn) {
        out.push(finding(
          'errors', w.name, 'error-rate', rate >= t.errorCritical ? 'critical' : 'warning',
          `${pct(rate)} of requests failed in the last 24 hours.`,
          { errors: w.errors24h, requests: w.requests24h },
          'Open the Worker in Workers Observability and look at the most frequent exception.',
          DOCS.errors,
        ));
      }
    }
    if (w.exceeded24h > 0) {
      out.push(finding(
        'errors', w.name, 'resource-limit', 'warning',
        `${fmt(w.exceeded24h)} invocations hit the CPU or memory limit in the last 24 hours.`,
        { exceeded: w.exceeded24h },
        'Profile the slow path or move heavy work to a Queue or Workflow.',
        DOCS.limits,
      ));
    }
    if (cpuLimit && w.cpuP99Max24h != null && w.cpuP99Max24h >= cpuLimit * t.cpuShareWarn && w.exceeded24h === 0) {
      out.push(finding(
        'errors', w.name, 'cpu-near-limit', 'info',
        `p99 CPU time is ${w.cpuP99Max24h.toFixed(1)} ms, close to the ${cpuLimit} ms Free plan limit.`,
        { cpuP99Ms: Number(w.cpuP99Max24h.toFixed(1)), limitMs: cpuLimit },
        'Requests above the limit fail with Error 1102. Trim CPU work before traffic grows.',
        DOCS.limits,
      ));
    }
  }
  return out;
}

export function runawayFindings(input: CheckInput, t: Thresholds): Finding[] {
  const out: Finding[] = [];
  for (const w of input.workers) {
    if (w.historyHours < t.runawayMinHistoryHours || w.lastHourRequests < t.runawayMinRequests) continue;
    const baseline = Math.max(w.hourlyMedian7d, 1);
    const ratio = w.lastHourRequests / baseline;
    if (ratio >= t.runawayMultiplier) {
      out.push(finding(
        'runaway', w.name, 'traffic-spike', 'critical',
        `Requests in the last hour are ${Math.round(ratio)}x this Worker's usual hourly level.`,
        { lastHour: w.lastHourRequests, usualHour: Math.round(w.hourlyMedian7d) },
        'Check for a loop, a retry storm or a crawler. On Workers Paid this traffic is billed; there is no hard spending cap.',
        DOCS.budget,
      ));
    }
  }
  return out;
}

export function cronFindings(input: CheckInput): Finding[] {
  if (!input.crons) return [];
  const out: Finding[] = [];
  for (const c of input.crons) {
    const missed = Math.max(0, c.expected - c.observed);
    if (missed > 0) {
      out.push(finding(
        'cron', c.name, 'missed-runs', missed >= 2 ? 'critical' : 'warning',
        `${missed} scheduled run${missed === 1 ? ' was' : 's were'} missed in the last 24 hours.`,
        { expected: c.expected, observed: c.observed },
        'Check the Cron Trigger is still attached and the scheduled() handler is deployed.',
        DOCS.cron,
      ));
    }
    if (c.failures > 0) {
      out.push(finding(
        'cron', c.name, 'failed-runs', c.failures >= 2 ? 'critical' : 'warning',
        `${c.failures} scheduled run${c.failures === 1 ? '' : 's'} failed in the last 24 hours.`,
        { failures: c.failures, runs: c.observed },
        'Look at the scheduled invocations in Workers Observability for the exception.',
        DOCS.cron,
      ));
    }
  }
  return out;
}

export function runChecks(input: CheckInput): Finding[] {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  return [
    ...budgetFindings(input, t),
    ...runawayFindings(input, t),
    ...errorFindings(input, t),
    ...cronFindings(input),
  ];
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
