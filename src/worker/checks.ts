// Checks for usage, runaway, errors and cron health, plus deploy correlation.
// Pure functions: data in, findings out. No I/O here, so they are cheap and testable.
// Hygiene checks (deprecation, exposure, zombies) live in hygiene.ts.
// SPDX-License-Identifier: AGPL-3.0-only

import { DEFAULT_THRESHOLDS, defaultConfig, type Config, type Thresholds } from '../shared/config';
import { FREE_DAILY, FREE_DAILY_REQUESTS, LOGS, STORAGE_LIMITS, unitPrice, type QuotaMetric, type StorageKind } from '../shared/limits';
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
  /** Idle loop: operations an hour, every hour, with almost no requests behind them. */
  idleMinOps: 2_000,
  idleOpsPerRequest: 100,
};

export { FREE_DAILY_REQUESTS };
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
  /** Operations in each of the last 3 full hours, oldest first. */
  recentOps?: number[];
  /** Requests to the Workers bound to this resource in the same hours; null when none is known. */
  recentRequests?: number[] | null;
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
  /** Account-wide usage since 00:00 UTC per quota metric. */
  quotaToday?: Partial<Record<QuotaMetric, number>>;
  /** Latest storage sizes, with display labels. */
  storage?: { kind: StorageKind; id: string; bytes: number; label: string }[];
  /** When the API token expires; null when it does not or is unknown. */
  tokenExpiresOn?: string | null;
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
export function projectLimitTime(now: Date, usedToday: number, limit = FREE_DAILY_REQUESTS): string | null {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsedMs = now.getTime() - midnight;
  if (usedToday <= 0 || elapsedMs <= 0) return null;
  if (usedToday >= limit) return now.toISOString();
  const rate = usedToday / elapsedMs;
  const hitAt = midnight + limit / rate;
  return hitAt < midnight + 86_400_000 ? new Date(hitAt).toISOString() : null;
}

/**
 * The other free daily limits: D1 rows, KV operations by type, Durable Objects, Queues, Workflows
 * and Workers AI. On the Free plan each one fails hard until 00:00 UTC. Workers AI has the same
 * allocation on Paid, where usage past it is billed.
 */
export function quotaFindings(input: CheckInput, t: Thresholds): Finding[] {
  const out: Finding[] = [];
  for (const q of FREE_DAILY) {
    const used = input.quotaToday?.[q.metric] ?? 0;
    if (!used) continue;
    const share = used / q.limit;
    if (input.plan === 'paid') {
      if (q.metric === 'ai.neurons' && share >= 1) {
        out.push(finding(
          'budget', '*', `free-daily-${q.slug}`, 'info',
          `Workers AI has used ${fmt(used)} neurons today, past the ${fmt(q.limit)} free daily allocation.`,
          { usedToday: Math.round(used), freeAllocation: q.limit },
          'Usage past the allocation is billed at $0.011 per 1,000 neurons. Check which Worker calls Workers AI if this is unexpected.',
          q.docs,
        ));
      }
      continue;
    }
    if (share < t.budgetWarn) continue;
    const projected = projectLimitTime(input.now, used, q.limit);
    out.push(finding(
      'budget', '*', `free-daily-${q.slug}`, share >= t.budgetCritical ? 'critical' : 'warning',
      share >= 1 ? `The account is out of free ${q.label} for today (${fmt(used)} of ${fmt(q.limit)}).` : `You have used ${pct(share)} of today's free ${q.label} (${fmt(used)} of ${fmt(q.limit)}).`,
      { usedToday: Math.round(used), limit: q.limit, projectedLimitAt: share >= 1 ? 'reached' : projected ?? 'not today' },
      share >= 1
        ? `${q.exceeded} Find the Worker behind it, or move to Workers Paid.`
        : projected
          ? `At this pace the account runs out around ${projected.slice(11, 16)} UTC. ${q.exceeded} The limit is per account, so spreading the work over several Workers does not help.`
          : 'Usage is high but should stay under the limit today.',
      q.docs,
    ));
  }
  return out;
}

const GB = 1e9;
const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 2 : 1)} GB`;
const STORAGE_NAMES: Record<StorageKind, string> = { d1: 'D1', kv: 'KV', r2: 'R2', do: 'Durable Object' };
const STORAGE_DOCS: Record<StorageKind, string> = {
  d1: 'https://developers.cloudflare.com/d1/platform/limits/',
  kv: 'https://developers.cloudflare.com/kv/platform/limits/',
  r2: 'https://developers.cloudflare.com/r2/pricing/',
  do: 'https://developers.cloudflare.com/durable-objects/platform/limits/',
};

/** Storage close to a cap: per D1 database, and per account for each product. */
export function storageFindings(input: CheckInput): Finding[] {
  const out: Finding[] = [];
  const limits = STORAGE_LIMITS[input.plan];
  const sev = (share: number): Severity | null => (share >= 0.95 ? 'critical' : share >= 0.8 ? 'warning' : null);
  const totals = new Map<StorageKind, number>();
  for (const s of input.storage ?? []) {
    totals.set(s.kind, (totals.get(s.kind) ?? 0) + s.bytes);
    const cap = limits[s.kind].perResource;
    if (!cap || s.id === '*') continue;
    const severity = sev(s.bytes / cap);
    if (!severity) continue;
    out.push(finding(
      'budget', '*', `storage-${s.kind}-db-${s.id}`, severity,
      `${STORAGE_NAMES[s.kind]} database ${s.label} is ${gb(s.bytes)}, ${pct(s.bytes / cap)} of the ${gb(cap)} limit per database.`,
      { database: s.label, size: gb(s.bytes), limit: gb(cap) },
      'A full database rejects writes. Delete old rows, split the data across databases, or move large values to R2.',
      STORAGE_DOCS[s.kind],
    ));
  }
  for (const [kind, bytes] of totals) {
    const cap = limits[kind].account;
    if (!cap) continue;
    const share = bytes / cap;
    const severity = sev(share);
    if (!severity) continue;
    const billed = limits[kind].billed;
    out.push(finding(
      'budget', '*', `storage-${kind}-account`, billed ? 'warning' : severity,
      `${STORAGE_NAMES[kind]} storage is ${gb(bytes)}, ${pct(share)} of the ${gb(cap)} ${input.plan === 'free' ? 'free' : ''} account limit.`.replace('  ', ' '),
      { stored: gb(bytes), limit: gb(cap) },
      billed
        ? 'Storage past the free amount is billed. Delete what you no longer need, or set lifecycle rules.'
        : 'At the limit, new writes fail. Delete old data, or move to Workers Paid for more room.',
      STORAGE_DOCS[kind],
    ));
  }
  return out;
}

/** Ambersight's own health: a token that expires soon leaves it blind. */
export function healthFindings(input: CheckInput): Finding[] {
  if (!input.tokenExpiresOn) return [];
  const days = (new Date(input.tokenExpiresOn).getTime() - input.now.getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days > 14) return [];
  const when = input.tokenExpiresOn.slice(0, 10);
  return [finding(
    'health', '*', 'token-expiry', days <= 3 ? 'critical' : 'warning',
    days <= 0 ? `Ambersight's API token expired on ${when}. Scans stop working.` : `Ambersight's API token expires on ${when}, in ${Math.max(1, Math.round(days))} day${Math.round(days) === 1 ? '' : 's'}.`,
    { expiresOn: when },
    'Create a new read-only token (or extend this one under My Profile › API Tokens), then update the CF_API_TOKEN secret.',
    'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
  )];
}

/**
 * Runaway work with nothing driving it: a Durable Object alarm or Queue retry loop keeps going
 * while the Workers bound to it see almost no requests. The 5x baseline cannot catch a loop that
 * started on day one; this can.
 */
export function idleLoopFindings(input: CheckInput): Finding[] {
  const names = { d1: 'D1 queries', kv: 'KV operations', r2: 'R2 operations', do: 'Durable Object requests', queues: 'Queue operations' };
  const out: Finding[] = [];
  for (const r of input.resources ?? []) {
    if (!r.recentOps || !r.recentRequests || r.recentOps.length < 3) continue;
    const idle = r.recentOps.every((ops, i) => ops >= FLOORS.idleMinOps && r.recentRequests![i] * FLOORS.idleOpsPerRequest < ops);
    if (!idle) continue;
    const perHour = Math.round(r.recentOps.reduce((a, b) => a + b, 0) / 3);
    const cost = input.plan === 'paid' ? costPerHour(r.kind, perHour) : 0;
    out.push(finding(
      'usage', r.script, `idle-loop-${r.kind}-${r.resource}`, input.plan === 'paid' ? 'critical' : 'warning',
      `${names[r.kind]} on ${r.label} ran at about ${fmt(perHour)} an hour for 3 hours while its Workers had almost no requests.${cost >= 0.01 ? ` That is about $${cost.toFixed(2)} an hour.` : ''}`,
      { resource: r.label, opsPerHour: perHour, requests3h: r.recentRequests.reduce((a, b) => a + b, 0) },
      'Work with nothing driving it is usually a loop: a Durable Object alarm that always sets the next alarm, a Queue consumer that fails and retries every message, or a cron that never finishes. Find it before it runs all night.',
      'https://developers.cloudflare.com/durable-objects/api/alarms/',
    ));
  }
  return out;
}

/** List price of one hour of extra operations of a kind, for runaway messages on Paid. */
function costPerHour(kind: ResourceStats['kind'], ops: number): number {
  const metric: Partial<Record<ResourceStats['kind'], QuotaMetric>> = { do: 'do.requests', queues: 'queues.ops', kv: 'kv.read' };
  return metric[kind] ? ops * unitPrice(metric[kind]!) : 0;
}

/** Absolute floors for Workers and resources too new for the 5x baseline (under 72 hours of history). */
export function burstFindings(input: CheckInput, tf: (n: string) => Thresholds): Finding[] {
  const out: Finding[] = [];
  const t = input.config?.thresholds ?? DEFAULT_THRESHOLDS;
  const sev: Severity = input.plan === 'paid' ? 'critical' : 'warning';
  for (const w of input.workers) {
    if (w.historyHours >= FLOORS.runawayMinHistoryHours) continue;
    const limit = tf(w.name).newWorkerHourlyRequests;
    if (w.lastHourRequests < limit) continue;
    const cost = input.plan === 'paid' ? w.lastHourRequests * unitPrice('workers.requests') + (w.lastHourCpuUs / 1000) * unitPrice('workers.cpuMs') : 0;
    out.push(finding(
      'runaway', w.name, 'new-worker-burst', sev,
      `This Worker is new and served ${fmt(w.lastHourRequests)} requests in the last hour.${cost >= 0.01 ? ` About $${cost.toFixed(2)} an hour at list price.` : ''}`,
      { lastHour: w.lastHourRequests, threshold: limit, historyHours: w.historyHours },
      'It has too little history for the usual comparison. If this traffic is not expected, look for a loop, a retry storm or a crawler.',
      DOCS.budget,
    ));
  }
  for (const r of input.resources ?? []) {
    if (r.historyHours >= FLOORS.runawayMinHistoryHours || r.lastHour < t.newResourceHourlyOps) continue;
    out.push(finding(
      'usage', r.script, `new-resource-burst-${r.kind}-${r.resource}`, sev,
      `${r.label} is new and had ${fmt(r.lastHour)} operations in the last hour.`,
      { resource: r.label, lastHour: r.lastHour, threshold: t.newResourceHourlyOps },
      'It has too little history for the usual comparison. If this is not expected, look for a loop writing or reading in a hot path.',
      DOCS.pricing,
    ));
  }
  return out;
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
      const extra = input.plan === 'paid'
        ? code === 'traffic-spike' ? (last - usual) * unitPrice('workers.requests') : code === 'cpu-spike' ? (last - usual) * unitPrice('workers.cpuMs') : 0
        : 0;
      out.push(finding(
        'runaway', w.name, code, 'critical',
        `${label} in the last hour ${label === 'CPU time' ? 'is' : 'are'} ${Math.round(ratio)}x this Worker's usual hourly level.${extra >= 0.01 ? ` About $${extra.toFixed(2)} an hour above usual.` : ''}`,
        { lastHour: show(last), usualHour: show(usual), ...(extra >= 0.01 ? { extraPerHour: `$${extra.toFixed(2)}` } : {}) },
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
  // Estimated log volume per Worker: requests a day x sampling rate x an average event size.
  const volume = (input.meta ?? [])
    .filter((m) => m.logsEnabled)
    .map((m) => ({ name: m.name, gbPerDay: ((stats.get(m.name)?.requests24h ?? 0) * (m.samplingRate ?? 1) * LOGS.bytesPerEventEstimate) / 1e9 }))
    .filter((v) => v.gbPerDay > 0)
    .sort((a, b) => b.gbPerDay - a.gbPerDay);
  const totalGb = volume.reduce((n, v) => n + v.gbPerDay, 0);
  if (input.plan === 'free' && totalGb >= LOGS.freeGbPerDay * 0.7) {
    const stopsAt = totalGb > LOGS.freeGbPerDay ? new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()) + (LOGS.freeGbPerDay / totalGb) * 86_400_000).toISOString().slice(11, 16) : null;
    out.push(finding(
      'usage', '*', 'logs-free-allowance', totalGb > LOGS.freeGbPerDay ? 'warning' : 'info',
      stopsAt
        ? `Workers send an estimated ${totalGb.toFixed(2)} GB of logs a day, more than the free 0.5 GB. Logs stop being stored around ${stopsAt} UTC each day.`
        : `Workers send an estimated ${totalGb.toFixed(2)} GB of logs a day, close to the free 0.5 GB.`,
      { estimatedGbPerDay: Number(totalGb.toFixed(2)), freeGbPerDay: LOGS.freeGbPerDay, largest: volume.slice(0, 3).map((v) => v.name).join(', ') },
      'From 1 December 2026, Free accounts ingest 0.5 GB of logs and traces a day, then nothing until 00:00 UTC. Lower head_sampling_rate on the busiest Workers so the logs you need are kept. The estimate assumes about 1.5 KB per event.',
      LOGS.docs,
    ));
  }
  const paidExtra = input.plan === 'paid' ? Math.max(0, totalGb * 30 - LOGS.paidIncludedGbPerCycle) * LOGS.paidPerGb : 0;
  for (const m of input.meta ?? []) {
    const s = stats.get(m.name);
    if (m.logsEnabled && (m.samplingRate ?? 1) >= 1 && (s?.requests24h ?? 0) >= FLOORS.logsVolumeRequests) {
      const gbMonth = ((s!.requests24h * LOGS.bytesPerEventEstimate) / 1e9) * 30;
      const share = totalGb > 0 ? (gbMonth / 30) / totalGb : 0;
      const cost = paidExtra * share;
      out.push(finding(
        'usage', m.name, 'logs-full-sampling', 'info',
        `Logs are on at 100% sampling for ${fmt(s!.requests24h)} requests a day, an estimated ${gbMonth.toFixed(1)} GB a month.${cost >= 0.5 ? ` About $${cost.toFixed(2)} a month past the included 50 GB.` : ''}`,
        { samplingRate: '100%', requests24h: s!.requests24h, estimatedGbPerMonth: Number(gbMonth.toFixed(1)) },
        input.plan === 'paid'
          ? 'From 1 December 2026 logs and traces are billed per GB: 50 GB a month included, then $0.25 per GB. Lower head_sampling_rate if you do not need every request.'
          : 'From 1 December 2026 the Free plan stores 0.5 GB of logs a day for the whole account. Lower head_sampling_rate if you do not need every request.',
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
  if (m.usage) {
    out.push(
      ...budgetFindings(input, config.thresholds), ...quotaFindings(input, config.thresholds), ...storageFindings(input),
      ...runawayFindings(input, tf), ...burstFindings(input, tf), ...resourceFindings(input), ...idleLoopFindings(input), ...loggingFindings(input),
    );
  }
  // Ambersight's own health cannot be switched off.
  out.push(...healthFindings(input));
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
