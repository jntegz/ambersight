// Cloudflare free-plan limits and Workers Paid list prices that Ambersight measures against.
// Checked against the cloudflare-docs source (src/content/docs and partials) on 2026-11-10.
// `verified: false` marks a number or dataset that could not be confirmed there; those are read
// defensively and shown as estimates.
// SPDX-License-Identifier: AGPL-3.0-only

/** Usage Ambersight totals per account per hour (table quota_hourly). */
export type QuotaMetric =
  | 'workers.requests' | 'workers.cpuMs'
  | 'd1.rowsRead' | 'd1.rowsWritten'
  | 'kv.read' | 'kv.write' | 'kv.delete' | 'kv.list'
  | 'do.requests' | 'queues.ops' | 'workflows.steps' | 'ai.neurons';

export interface DailyQuota {
  metric: QuotaMetric;
  /** Short slug for the finding code, e.g. "kv-writes". */
  slug: string;
  label: string;
  limit: number;
  /** What happens past the limit on the Free plan. */
  exceeded: string;
  docs: string;
  verified: boolean;
}

const D = 'https://developers.cloudflare.com';

/** Free-plan limits that reset at 00:00 UTC. Workers requests are handled by the original budget check. */
export const FREE_DAILY: DailyQuota[] = [
  { metric: 'd1.rowsRead', slug: 'd1-rows-read', label: 'D1 rows read', limit: 5_000_000, exceeded: 'D1 queries fail until 00:00 UTC.', docs: `${D}/d1/platform/pricing/`, verified: true },
  { metric: 'd1.rowsWritten', slug: 'd1-rows-written', label: 'D1 rows written', limit: 100_000, exceeded: 'D1 queries fail until 00:00 UTC.', docs: `${D}/d1/platform/pricing/`, verified: true },
  { metric: 'kv.read', slug: 'kv-reads', label: 'KV reads', limit: 100_000, exceeded: 'KV reads fail until 00:00 UTC.', docs: `${D}/kv/platform/limits/`, verified: true },
  { metric: 'kv.write', slug: 'kv-writes', label: 'KV writes', limit: 1_000, exceeded: 'KV writes fail until 00:00 UTC.', docs: `${D}/kv/platform/limits/`, verified: true },
  { metric: 'kv.delete', slug: 'kv-deletes', label: 'KV deletes', limit: 1_000, exceeded: 'KV deletes fail until 00:00 UTC.', docs: `${D}/kv/platform/pricing/`, verified: true },
  { metric: 'kv.list', slug: 'kv-lists', label: 'KV list requests', limit: 1_000, exceeded: 'KV list requests fail until 00:00 UTC.', docs: `${D}/kv/platform/pricing/`, verified: true },
  { metric: 'do.requests', slug: 'do-requests', label: 'Durable Object requests', limit: 100_000, exceeded: 'Durable Object requests fail until 00:00 UTC.', docs: `${D}/durable-objects/platform/pricing/`, verified: true },
  { metric: 'queues.ops', slug: 'queue-ops', label: 'Queue operations', limit: 10_000, exceeded: 'Queue operations fail until 00:00 UTC.', docs: `${D}/queues/platform/pricing/`, verified: true },
  { metric: 'workflows.steps', slug: 'workflow-steps', label: 'Workflow steps', limit: 3_000, exceeded: 'New Workflow steps fail until 00:00 UTC.', docs: `${D}/workflows/reference/pricing/`, verified: true },
  // Same allocation on Workers Paid, where usage past it is billed.
  { metric: 'ai.neurons', slug: 'ai-neurons', label: 'Workers AI neurons', limit: 10_000, exceeded: 'Workers AI requests fail until 00:00 UTC.', docs: `${D}/workers-ai/platform/pricing/`, verified: true },
];

export const FREE_DAILY_REQUESTS = 100_000;

export type StorageKind = 'd1' | 'kv' | 'r2' | 'do';

/** Storage caps. `perResource` is per database; `account` is the account total. null = no cap. */
export const STORAGE_LIMITS: Record<'free' | 'paid', Record<StorageKind, { perResource: number | null; account: number | null; billed: boolean }>> = {
  free: {
    d1: { perResource: 500e6, account: 5e9, billed: false },
    kv: { perResource: null, account: 1e9, billed: false },
    // R2 past 10 GB-month is billed, not blocked.
    r2: { perResource: null, account: 10e9, billed: true },
    do: { perResource: null, account: 5e9, billed: false },
  },
  paid: {
    d1: { perResource: 10e9, account: 1e12, billed: false },
    kv: { perResource: null, account: null, billed: true },
    r2: { perResource: null, account: null, billed: true },
    do: { perResource: null, account: null, billed: true },
  },
};

/** Workers Logs and traces from 1 December 2026 (observability/pricing). */
export const LOGS = {
  freeGbPerDay: 0.5,
  paidIncludedGbPerCycle: 50,
  paidPerGb: 0.25,
  /** Not documented: an average Workers Logs event with default attributes. Used for estimates only. */
  bytesPerEventEstimate: 1_500,
  docs: `${D}/observability/pricing/`,
};

/** Workers Paid list prices: included per month, then USD per unit. */
export const PRICES = {
  asOf: '2026-11-10',
  base: 5,
  items: [
    { metric: 'workers.requests', label: 'Workers requests', included: 10e6, perUnit: 0.30 / 1e6 },
    { metric: 'workers.cpuMs', label: 'Workers CPU time', included: 30e6, perUnit: 0.02 / 1e6 },
    { metric: 'd1.rowsRead', label: 'D1 rows read', included: 25e9, perUnit: 0.001 / 1e6 },
    { metric: 'd1.rowsWritten', label: 'D1 rows written', included: 50e6, perUnit: 1.0 / 1e6 },
    { metric: 'kv.read', label: 'KV reads', included: 10e6, perUnit: 0.5 / 1e6 },
    { metric: 'kv.write', label: 'KV writes', included: 1e6, perUnit: 5.0 / 1e6 },
    { metric: 'kv.delete', label: 'KV deletes', included: 1e6, perUnit: 5.0 / 1e6 },
    { metric: 'kv.list', label: 'KV lists', included: 1e6, perUnit: 5.0 / 1e6 },
    { metric: 'do.requests', label: 'Durable Object requests', included: 1e6, perUnit: 0.15 / 1e6 },
    { metric: 'queues.ops', label: 'Queue operations', included: 1e6, perUnit: 0.40 / 1e6 },
    { metric: 'workflows.steps', label: 'Workflow steps', included: 500_000, perUnit: 0.80 / 100_000 },
    // 10,000 neurons a day are free on Paid too: about 300,000 a month.
    { metric: 'ai.neurons', label: 'Workers AI', included: 300_000, perUnit: 0.011 / 1_000 },
  ] satisfies { metric: QuotaMetric; label: string; included: number; perUnit: number }[],
  /** Storage, USD per GB-month after the included amount. */
  storage: {
    d1: { label: 'D1 storage', includedGb: 5, perGb: 0.75 },
    kv: { label: 'KV storage', includedGb: 1, perGb: 0.5 },
    r2: { label: 'R2 storage', includedGb: 10, perGb: 0.015 },
    do: { label: 'Durable Object storage', includedGb: 5, perGb: 0.2 },
  } satisfies Record<StorageKind, { label: string; includedGb: number; perGb: number }>,
  docs: `${D}/workers/platform/pricing/`,
};

/** USD per unit for a metric at list price, ignoring the included amount. */
export function unitPrice(metric: QuotaMetric): number {
  return PRICES.items.find((p) => p.metric === metric)?.perUnit ?? 0;
}

/** "120 MB", rounded so a finding is not rewritten for every byte that changes. */
export function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : Number(n.toPrecision(2))} ${units[i]}`;
}
