// SPDX-License-Identifier: AGPL-3.0-only
// Labels, units and display conversion for config thresholds. Ranges come from THRESHOLD_RANGES.
import { THRESHOLD_RANGES, type Thresholds } from '../../../src/shared/config';

export type ThresholdKey = keyof Thresholds;

export interface ThresholdMeta {
  key: ThresholdKey;
  label: string;
  help: string;
  /** Shares (0..1) are shown and typed as percentages. */
  unit: '%' | '×' | 'months' | 'days' | 'min';
}

export const THRESHOLD_GROUPS: { title: string; items: ThresholdMeta[] }[] = [
  {
    title: 'Free request budget',
    items: [
      { key: 'budgetWarn', label: 'Warn at', help: 'Share of the 100,000 daily free requests.', unit: '%' },
      { key: 'budgetCritical', label: 'Critical at', help: 'Must be above the warning level.', unit: '%' },
    ],
  },
  {
    title: 'Errors',
    items: [
      { key: 'errorWarn', label: 'Warn at error rate', help: 'Errors as a share of requests over 24 hours.', unit: '%' },
      { key: 'errorCritical', label: 'Critical at error rate', help: 'Must be above the warning level.', unit: '%' },
      { key: 'errorBaselineMultiplier', label: 'Spike vs 7-day rate', help: 'Warn when the error rate is this many times its 7-day rate.', unit: '×' },
    ],
  },
  {
    title: 'Traffic and CPU',
    items: [
      { key: 'runawayMultiplier', label: 'Runaway traffic', help: 'Last full hour vs the 7-day hourly median.', unit: '×' },
      { key: 'cpuShareWarn', label: 'CPU time warning', help: 'p99 CPU time as a share of the plan limit.', unit: '%' },
    ],
  },
  {
    title: 'Hygiene',
    items: [
      { key: 'compatAgeMonths', label: 'Old compatibility date', help: 'Flag compatibility dates older than this.', unit: 'months' },
      { key: 'zombieDays', label: 'Unused Worker', help: 'No requests for this many days.', unit: 'days' },
      { key: 'deployWindowMinutes', label: 'Deploy correlation window', help: 'A problem starting this soon after a deploy is linked to it.', unit: 'min' },
    ],
  },
];

export const THRESHOLD_META: Record<ThresholdKey, ThresholdMeta> = Object.fromEntries(
  THRESHOLD_GROUPS.flatMap((g) => g.items).map((m) => [m.key, m]),
) as Record<ThresholdKey, ThresholdMeta>;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Stored value -> what the input shows. */
export const toDisplay = (key: ThresholdKey, v: number) => (THRESHOLD_META[key].unit === '%' ? round(v * 100) : v);
/** Input value -> stored value. */
export const fromDisplay = (key: ThresholdKey, v: number) => (THRESHOLD_META[key].unit === '%' ? round(v / 100) : v);

export function rangeText(key: ThresholdKey): string {
  const [min, max] = THRESHOLD_RANGES[key];
  const u = THRESHOLD_META[key].unit;
  return `${toDisplay(key, min)}–${toDisplay(key, max)}${u === '%' || u === '×' ? u : ` ${u}`}`;
}

export function inputStep(key: ThresholdKey): number {
  const u = THRESHOLD_META[key].unit;
  return u === '%' ? 0.1 : u === '×' ? 0.5 : 1;
}
