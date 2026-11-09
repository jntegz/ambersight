// Minimal five-field cron matcher, enough to count expected runs in a window.
// Supports *, numbers, ranges (a-b), lists (a,b) and steps (*/n, a-b/n). UTC, like Cron Triggers.
// SPDX-License-Identifier: AGPL-3.0-only

type FieldSet = Set<number>;

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday; 7 also accepted)
];

const NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseValue(v: string): number {
  const n = NAMES[v.toLowerCase()] ?? Number(v);
  if (!Number.isInteger(n)) throw new Error(`Bad cron value: ${v}`);
  return n;
}

function parseField(field: string, [min, max]: [number, number], isDow: boolean): FieldSet {
  const out: FieldSet = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step: ${part}`);
    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const [a, b] = rangePart.split('-');
      lo = parseValue(a);
      hi = b !== undefined ? parseValue(b) : stepPart ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(isDow && v === 7 ? 0 : v);
  }
  return out;
}

export interface CronSpec {
  minutes: FieldSet;
  hours: FieldSet;
  days: FieldSet;
  months: FieldSet;
  weekdays: FieldSet;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Expected 5 cron fields: ${expr}`);
  return {
    minutes: parseField(fields[0], RANGES[0], false),
    hours: parseField(fields[1], RANGES[1], false),
    days: parseField(fields[2], RANGES[2], false),
    months: parseField(fields[3], RANGES[3], false),
    weekdays: parseField(fields[4], RANGES[4], true),
    dayRestricted: fields[2] !== '*',
    weekdayRestricted: fields[4] !== '*',
  };
}

export function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minutes.has(d.getUTCMinutes()) || !spec.hours.has(d.getUTCHours()) || !spec.months.has(d.getUTCMonth() + 1)) return false;
  const dom = spec.days.has(d.getUTCDate());
  const dow = spec.weekdays.has(d.getUTCDay());
  // Standard cron: if both day fields are restricted, either may match.
  if (spec.dayRestricted && spec.weekdayRestricted) return dom || dow;
  return dom && dow;
}

/**
 * Number of times the expression fires in [from, to). Minute resolution, but cheap:
 * whole hours are checked once and add the number of matching minutes, so a 24-hour
 * window costs about 24 checks instead of 1,440 (Free plan cron runs get 10 ms of CPU).
 */
export function countRuns(expr: string, from: Date, to: Date): number {
  const spec = parseCron(expr);
  const HOUR = 3_600_000;
  let count = 0;
  let t = Math.ceil(from.getTime() / 60_000) * 60_000;
  const end = to.getTime();
  while (t < end) {
    const d = new Date(t);
    if (d.getUTCMinutes() === 0 && t + HOUR <= end) {
      if (spec.hours.has(d.getUTCHours()) && matchesDay(spec, d)) count += spec.minutes.size;
      t += HOUR;
    } else {
      if (matches(spec, d)) count++;
      t += 60_000;
    }
  }
  return count;
}

function matchesDay(spec: CronSpec, d: Date): boolean {
  if (!spec.months.has(d.getUTCMonth() + 1)) return false;
  const dom = spec.days.has(d.getUTCDate());
  const dow = spec.weekdays.has(d.getUTCDay());
  if (spec.dayRestricted && spec.weekdayRestricted) return dom || dow;
  return dom && dow;
}
