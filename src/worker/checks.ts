// Checks for usage, runaway, errors and cron health, plus deploy correlation.
// Pure functions: data in, findings out. No I/O here, so they are cheap and testable.
// Hygiene checks (deprecation, exposure, zombies) live in hygiene.ts.
// SPDX-License-Identifier: AGPL-3.0-only

import { DEFAULT_THRESHOLDS, defaultConfig, type Config, type Thresholds } from '../shared/config';
import type { Finding, Severity } from '../shared/types';
import { hygieneFindings, type InventoryFacts } from './hygiene';

export { DEFAULT_THRESHOLDS };
export type { Thresholds };

/** Noise floors. Not user settings: they keep tiny Workers from raising alarms. */
export const FLOORS = {
  errorMinRequests: 50,
  errorBaselineMinErrors: 10,
  errorBaselineMinRate: 0.005,
  runawayMinRequests: 500,
  runawayMinCpuMs: 60_000, // one CPU-minute in the hour
  runawayMinSubrequests: 2_000,
  runawayMinOps: 1_000,
  runawayMinHistoryHours: 72,
  logsVolumeRequests: 10_000,
};

export const FREE_DAILY_REQUESTS = 100_000;
export const FREE_CPU_MS = 10;
export const CRON_CPU_MS = { free: 10, paid: 30_000 };
export const CRON_LIMIT = { free: 5, paid: 250 };

export interface HourPoint {
  hour: string;
  requests: number;
  errors: number;
}

export interface WorkerStats {
  name: string;
  requests24h: number;
  errors24h: number;
  /** The 6 days before the last 24 hours, for the error baseline. */
  requestsPrev: number;
  errorsPrev: number;
  exceeded24h: number;
  cpuP99Max24h: number | null;
  lastHourRequests: number;
  hourlyMedian7d: number;
  lastHourCpuUs: number;
  hourlyMedianCpuUs7d: number;
  lastHourSubrequests: number;
  hourlyMedianSubrequests7d: number;
  historyHours: number;
  /** Hourly requests and errors for the last 24 hours, oldest first. */
  hours24?: HourPoint[];
  /** Requests in the zombie window. */
  requestsWindow?: number;
}

export interface WorkerMeta {
  name: string;
  groups: string[];
  handlers: string[];
  hasModules: boolean | null;
  compatibilityDate: string | null;
  compatibilityFlags: string[];
  usageModel: string | null;
  /** null = settings not fetched yet. */
  bindings: { type: string; name: string; target?: string }[] | null;
  workersDev: boolean | null;
  previewsEnabled: boolean | null;
  logsEnabled: boolean | null;
  samplingRate: number | null;
  logpush: boolean | null;
  deployedOn: string | null;
  /** True when the beta Workers list returned this Worker (subdomain/preview/deploy data is real). */
  listed: boolean;
  deployments: { id: string; createdOn: string }[];
}

export interface CronStats {
  name: string;
  expected: number;
  observed: number;
  failures: number;
  /** Most recent expected slots that were missed or failed, back to back. */
  consecutiveBad?: number;
  cpuMaxMs?: number | null;
}

export interface ResourceStats {
  kind: 'd1' | 'kv' | 'r2' | 'do' | 'queues';
  resource: string;
  label: string;
  /** Worker most likely responsible (first Worker binding it), or "*". */
  script: string;
  lastHour: number;
  median7d: number;
  historyHours: number;
}

export interface CheckInput {
  now: Date;
  plan: 'free' | 'paid';
  accountRequestsToday: number;
  workers: WorkerStats[];
  crons: CronStats[] | null; // null = cron dataset unavailable
  /** Cron expressions across the account, null when not all schedules are known yet. */
  cronTotal?: number | null;
  resources?: ResourceStats[];
  meta?: WorkerMeta[];
  inventory?: InventoryFacts;
  config?: Config;
  /** Per-Worker thresholds (overrides already applied). Falls back to config.thresholds. */
  thresholdsFor?: (name: string) => Thresholds;
}

const DOCS = {
  limits: 'https://developers.cloudflare.com/workers/platform/limits/',
  errors: 'https://developers.cloudflare.com/workers/observability/errors/',
  cron: 'https://developers.cloudflare.com/workers/configuration/cron-triggers/',
  budget: 'https://developers.cloudflare.com/billing/manage/budget-alerts/',
  pricing: 'https://developers.cloudflare.com/workers/platform/pricing/',
  observability: 'https://developers.cloudflare.com/observability/pricing/',
  logpush: 'https://developers.cloudflare.com/workers/observability/logs/logpush/',
};

export function finding(
  module: Finding['module'], script: string, code: string, severity: Severity,
  message: string, evidence: Finding['evidence'], action: string, docsUrl: string,
): Finding {
  return { id: `${module}:${script}:${code}`, module, script, code, severity, message, evidence, action, docsUrl };
}

export const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
export const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

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

export function errorFindings(input: CheckInput, tf: (n: string) => Thresholds): Finding[] {
  const out: Finding[] = [];
  const cpuLimit = input.plan === 'free' ? FREE_CPU_MS : null;
  for (const w of input.workers) {
    const t = tf(w.name);
    let flagged = false;
    if (w.requests24h >= FLOORS.errorMinRequests) {
      const rate = w.errors24h / w.requests24h;
      if (rate >= t.errorWarn) {
        flagged = true;
        out.push(finding(
          'errors', w.name, 'error-rate', rate >= t.errorCritical ? 'critical' : 'warning',
          `${pct(rate)} of requests failed in the last 24 hours.`,
          { errors: w.errors24h, requests: w.requests24h },
          'Open the Worker in Workers Observability and look at the most frequent exception.',
          DOCS.errors,
        ));
      }
      const baseline = w.requestsPrev >= FLOORS.errorMinRequests ? w.errorsPrev / w.requestsPrev : 0;
      if (
        !flagged && baseline > 0 && rate >= baseline * t.errorBaselineMultiplier &&
        rate >= FLOORS.errorBaselineMinRate && w.errors24h >= FLOORS.errorBaselineMinErrors
      ) {
        out.push(finding(
          'errors', w.name, 'error-baseline', 'warning',
          `The error rate is ${pct(rate)}, ${Math.round(rate / baseline)}x this Worker's usual ${pct(baseline)}.`,
          { errors: w.errors24h, requests: w.requests24h, usualRate: pct(baseline) },
          'Something changed: check recent deploys and the most frequent exception in Workers Observability.',
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

export function runawayFindings(input: CheckInput, tf: (n: string) => Thresholds): Finding[] {
  const out: Finding[] = [];
  for (const w of input.workers) {
    if (w.historyHours < FLOORS.runawayMinHistoryHours) continue;
    const t = tf(w.name);
    const metrics: [string, string, number, number, number, (n: number) => string][] = [
      ['traffic-spike', 'Requests', w.lastHourRequests, w.hourlyMedian7d, FLOORS.runawayMinRequests, fmt],
      ['cpu-spike', 'CPU time', w.lastHourCpuUs / 1000, w.hourlyMedianCpuUs7d / 1000, FLOORS.runawayMinCpuMs, (n) => `${fmt(n / 1000)} s`],
      ['subrequest-spike', 'Subrequests', w.lastHourSubrequests, w.hourlyMedianSubrequests7d, FLOORS.runawayMinSubrequests, fmt],
    ];
    for (const [code, label, last, usual, floor, show] of metrics) {
      if (last < floor) continue;
      const ratio = last / Math.max(usual, 1);
      if (ratio < t.runawayMultiplier) continue;
      out.push(finding(
        'runaway', w.name, code, 'critical',
        `${label} in the last hour ${label === 'CPU time' ? 'is' : 'are'} ${Math.round(ratio)}x this Worker's usual hourly level.`,
        { lastHour: show(last), usualHour: show(usual) },
        'Check for a loop, a retry storm or a crawler. On Workers Paid this usage is billed; there is no hard spending cap.',
        DOCS.budget,
      ));
    }
  }
  return out;
}

/** Storage and Durable Object operations far above their own baseline (PRD P1, P2). */
export function resourceFindings(input: CheckInput): Finding[] {
  const t = input.config?.thresholds ?? DEFAULT_THRESHOLDS;
  const names = { d1: 'D1 queries', kv: 'KV operations', r2: 'R2 operations', do: 'Durable Object requests', queues: 'Queue operations' };
  const out: Finding[] = [];
  for (const r of input.resources ?? []) {
    if (r.historyHours < FLOORS.runawayMinHistoryHours || r.lastHour < FLOORS.runawayMinOps) continue;
    const ratio = r.lastHour / Math.max(r.median7d, 1);
    if (ratio < t.runawayMultiplier) continue;
    out.push(finding(
      'usage', r.script, `ops-spike-${r.kind}-${r.resource}`, 'critical',
      `${names[r.kind]} on ${r.label} in the last hour are ${Math.round(ratio)}x the usual hourly level.`,
      { resource: r.label, lastHour: r.lastHour, usualHour: Math.round(r.median7d) },
      'Look for a loop writing or reading in a hot path. These operations are billed per use on Workers Paid; usage notifications do not cover them.',
      DOCS.pricing,
    ));
  }
  return out;
}

/** Logging posture: logs move to volume-based pricing on 1 Dec 2026 (PRD P9). */
export function loggingFindings(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  const stats = new Map(input.workers.map((w) => [w.name, w]));
  for (const m of input.meta ?? []) {
    const s = stats.get(m.name);
    if (m.logsEnabled && (m.samplingRate ?? 1) >= 1 && (s?.requests24h ?? 0) >= FLOORS.logsVolumeRequests) {
      out.push(finding(
        'usage', m.name, 'logs-full-sampling', 'info',
        `Logs are on at 100% sampling for ${fmt(s!.requests24h)} requests a day.`,
        { samplingRate: '100%', requests24h: s!.requests24h },
        'Logs are billed by volume from 1 December 2026. Lower head_sampling_rate if you do not need every request.',
        DOCS.observability,
      ));
    }
    if (m.logpush) {
      out.push(finding(
        'usage', m.name, 'logpush-on', 'info',
        'Logpush is enabled for this Worker.',
        { logpush: 'on' },
        'Make sure the destination and its costs are still wanted.',
        DOCS.logpush,
      ));
    }
  }
  return out;
}

export function cronFindings(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  const t = input.config?.thresholds ?? DEFAULT_THRESHOLDS;
  for (const c of input.crons ?? []) {
    const missed = Math.max(0, c.expected - c.observed);
    const consecutive = c.consecutiveBad ?? missed + c.failures;
    if (missed > 0) {
      out.push(finding(
        'cron', c.name, 'missed-runs', missed >= 2 && consecutive >= 2 ? 'critical' : 'warning',
        `${missed} scheduled run${missed === 1 ? ' was' : 's were'} missed in the last 24 hours.`,
        { expected: c.expected, observed: c.observed, inARow: consecutive },
        'Check the Cron Trigger is still attached and the scheduled() handler is deployed.',
        DOCS.cron,
      ));
    }
    if (c.failures > 0) {
      out.push(finding(
        'cron', c.name, 'failed-runs', c.failures >= 2 && consecutive >= 2 ? 'critical' : 'warning',
        `${c.failures} scheduled run${c.failures === 1 ? '' : 's'} failed in the last 24 hours.`,
        { failures: c.failures, runs: c.observed, inARow: consecutive },
        'Look at the scheduled invocations in Workers Observability for the exception.',
        DOCS.cron,
      ));
    }
    const limit = CRON_CPU_MS[input.plan];
    if (c.cpuMaxMs != null && c.cpuMaxMs >= limit * t.cpuShareWarn) {
      out.push(finding(
        'cron', c.name, 'cron-cpu-near-limit', 'warning',
        `A scheduled run used ${c.cpuMaxMs.toFixed(1)} ms of CPU, close to the ${fmt(limit)} ms limit.`,
        { cpuMaxMs: Number(c.cpuMaxMs.toFixed(1)), limitMs: limit },
        'Runs above the limit are cancelled. Split the job into smaller steps or move it to a Queue.',
        DOCS.limits,
      ));
    }
  }
  if (input.cronTotal != null) {
    const limit = CRON_LIMIT[input.plan];
    if (input.cronTotal >= limit) {
      out.push(finding(
        'cron', '*', 'cron-count', 'warning',
        `The account uses ${input.cronTotal} of ${limit} Cron Triggers.`,
        { used: input.cronTotal, limit },
        'New schedules will be rejected. Combine schedules into one Worker or remove unused ones.',
        DOCS.limits,
      ));
    } else if (input.cronTotal >= limit * 0.8) {
      out.push(finding(
        'cron', '*', 'cron-count', 'info',
        `The account uses ${input.cronTotal} of ${limit} Cron Triggers.`,
        { used: input.cronTotal, limit },
        'You are close to the limit for your plan.',
        DOCS.limits,
      ));
    }
  }
  return out;
}

/**
 * M8: if an error or runaway problem started within the correlation window after a deploy,
 * say so and raise a warning to critical.
 */
export function correlateDeploys(findings: Finding[], input: CheckInput, tf: (n: string) => Thresholds): Finding[] {
  const meta = new Map((input.meta ?? []).map((m) => [m.name, m]));
  const stats = new Map(input.workers.map((w) => [w.name, w]));
  const lastFullHour = Math.floor(input.now.getTime() / 3_600_000) * 3_600_000 - 3_600_000;
  return findings.map((f) => {
    if (f.module !== 'errors' && f.module !== 'runaway') return f;
    if (f.code !== 'error-rate' && f.code !== 'error-baseline' && f.module !== 'runaway') return f;
    const m = meta.get(f.script);
    if (!m?.deployments.length) return f;
    const t = tf(f.script);
    const start = f.module === 'runaway' ? lastFullHour : problemStart(stats.get(f.script)?.hours24 ?? [], t.errorWarn);
    if (start == null) return f;
    const windowMs = t.deployWindowMinutes * 60_000;
    const deploy = m.deployments
      .filter((d) => {
        const at = new Date(d.createdOn).getTime();
        return at >= start - windowMs && at < start + 3_600_000;
      })
      .sort((a, b) => b.createdOn.localeCompare(a.createdOn))[0];
    if (!deploy) return f;
    return {
      ...f,
      severity: f.severity === 'warning' ? 'critical' : f.severity,
      message: `${f.message} It started right after a deploy.`,
      evidence: { ...f.evidence, deployedAt: deploy.createdOn, deployId: deploy.id },
      action: `Compare the deploy of ${deploy.createdOn.slice(0, 16).replace('T', ' ')} UTC with the one before it, or roll back. ${f.action}`,
    };
  });
}

/** Start (ms) of the trailing run of hours with an error rate at or above `rate`. */
export function problemStart(hours: HourPoint[], rate: number): number | null {
  let start: number | null = null;
  for (let i = hours.length - 1; i >= 0; i--) {
    const h = hours[i];
    if (h.requests > 0 && h.errors / h.requests >= rate) start = new Date(h.hour).getTime();
    else if (start != null) break;
  }
  return start;
}

export function runChecks(input: CheckInput): Finding[] {
  const config = input.config ?? defaultConfig();
  const m = config.modules;
  const tf = input.thresholdsFor ?? (() => config.thresholds);
  let out: Finding[] = [];
  if (m.usage) out.push(...budgetFindings(input, config.thresholds), ...runawayFindings(input, tf), ...resourceFindings(input), ...loggingFindings(input));
  if (m.errors) out.push(...errorFindings(input, tf));
  if (m.cron) out.push(...cronFindings(input));
  if (input.meta && input.inventory) out.push(...hygieneFindings(input.now, input.meta, input.workers, input.inventory, config, tf));
  if (m.timeline) out = correlateDeploys(out, input, tf);
  return out;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
