// Estimated Workers Paid bill: month to date, a month-end forecast, and the Workers that cost most.
// List prices from shared/limits.ts. An estimate only: billing cycles may not start on the 1st,
// R2 operations, egress-free products and logs are not counted, and storage is billed on the
// month's average rather than today's size.
// SPDX-License-Identifier: AGPL-3.0-only

import { PRICES, unitPrice, type QuotaMetric, type StorageKind } from '../shared/limits';
import type { CostEstimate } from '../shared/types';

const GB = 1e9;

/** USD for one month of usage at list price, after the included amounts and the $5 base. */
export function monthlyCost(usage: Partial<Record<QuotaMetric, number>>, storage: Partial<Record<StorageKind, number>>): { total: number; items: { label: string; amount: number }[] } {
  const items: { label: string; amount: number }[] = [{ label: 'Workers Paid subscription', amount: PRICES.base }];
  for (const p of PRICES.items) {
    const over = Math.max(0, (usage[p.metric] ?? 0) - p.included);
    if (over > 0) items.push({ label: p.label, amount: over * p.perUnit });
  }
  for (const [kind, p] of Object.entries(PRICES.storage) as [StorageKind, (typeof PRICES.storage)[StorageKind]][]) {
    const over = Math.max(0, (storage[kind] ?? 0) / GB - p.includedGb);
    if (over > 0) items.push({ label: p.label, amount: over * p.perGb });
  }
  return { total: items.reduce((n, i) => n + i.amount, 0), items };
}

export function estimate(
  now: Date,
  monthToDate: Partial<Record<QuotaMetric, number>>,
  storage: Partial<Record<StorageKind, number>>,
  workers: { name: string; requests: number; cpuMs: number }[],
  /** Hours of usage history this month; a scan that started mid-month cannot see the days before. */
  trackedSince: string | null,
): CostEstimate {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const from = Math.max(start, trackedSince ? new Date(trackedSince).getTime() : start);
  const elapsed = Math.max(1, now.getTime() - from);
  const scale = (end - from) / elapsed;
  const mtd = monthlyCost(monthToDate, storage);
  const projected: Partial<Record<QuotaMetric, number>> = {};
  for (const [m, v] of Object.entries(monthToDate) as [QuotaMetric, number][]) projected[m] = v * scale;
  const forecast = monthlyCost(projected, storage);
  // Per Worker, last 7 days scaled to 30, at list price before included usage.
  const top = workers
    .map((w) => ({ name: w.name, amount: ((w.requests * unitPrice('workers.requests') + w.cpuMs * unitPrice('workers.cpuMs')) * 30) / 7 }))
    .filter((w) => w.amount >= 0.01)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
  return {
    monthToDate: round(mtd.total),
    forecast: round(forecast.total),
    breakdown: forecast.items.map((i) => ({ label: i.label, amount: round(i.amount) })).sort((a, b) => b.amount - a.amount),
    topWorkers: top.map((w) => ({ ...w, amount: round(w.amount) })),
    partialMonth: from > start,
    pricesAsOf: PRICES.asOf,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
