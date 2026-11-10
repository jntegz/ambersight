// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { defaultConfig, groupsFor, inScope, matchPattern, parseConfig, thresholdsFor } from '../src/shared/config';
import { runChecks, type WorkerStats } from '../src/worker/checks';
import { cronStats } from '../src/worker/scan';
import { accessCovers, hostOf, monthsBetween } from '../src/worker/hygiene';
import { digestDue, inQuietHours, localTime } from '../src/worker/time';
import { isNewer } from '../src/worker/version';

const now = new Date('2026-11-09T12:00:00Z');
const w = (over: Partial<WorkerStats> = {}): WorkerStats => ({
  name: 'api', requests24h: 10_000, errors24h: 0, requestsPrev: 60_000, errorsPrev: 60, exceeded24h: 0, cpuP99Max24h: 1,
  lastHourRequests: 400, hourlyMedian7d: 400, lastHourCpuUs: 1e6, hourlyMedianCpuUs7d: 1e6, lastHourSubrequests: 0,
  hourlyMedianSubrequests7d: 0, historyHours: 168, ...over,
});

describe('config', () => {
  it('round-trips the defaults and fills missing sections', () => {
    expect(parseConfig(defaultConfig())).toEqual(defaultConfig());
    expect(parseConfig({ version: 1 })).toEqual(defaultConfig());
  });
  it('rejects out-of-range and inconsistent values', () => {
    expect(() => parseConfig({ version: 1, thresholds: { runawayMultiplier: 1 } })).toThrow(/runawayMultiplier/);
    expect(() => parseConfig({ version: 1, thresholds: { budgetWarn: 0.9, budgetCritical: 0.8 } })).toThrow(/budgetCritical/);
    expect(() => parseConfig({ version: 1, timeZone: 'Mars/Base' })).toThrow(/timeZone/);
    expect(() => parseConfig({ version: 1, digest: { groupRecipients: { a: ['not-an-email'] } } })).toThrow(/groupRecipients/);
    expect(() => parseConfig({ version: 1, overrides: { api: { nope: 1 } } })).toThrow(/not a known threshold/);
  });
  it('applies groups, scope and overrides in order', () => {
    const c = defaultConfig();
    c.groups = { clientA: ['a-*'] };
    c.overrides = { 'group:clientA': { errorWarn: 0.05 }, 'a-scraper': { errorWarn: 0.2, errorCritical: 0.4 } };
    c.scope.exclude = ['group:internal'];
    expect(groupsFor(c, 'a-api', ['internal'])).toEqual(['clientA', 'internal']);
    expect(inScope(c, 'a-api', ['clientA', 'internal'])).toBe(false);
    expect(thresholdsFor(c, 'a-api', ['clientA']).errorWarn).toBe(0.05);
    expect(thresholdsFor(c, 'a-scraper', ['clientA']).errorWarn).toBe(0.2);
    expect(matchPattern('*-staging', 'api-staging')).toBe(true);
    expect(matchPattern('api.v1', 'apixv1')).toBe(false);
  });
});

describe('checks', () => {
  it('flags an error rate 3x its own baseline even under 2%', () => {
    // Baseline 0.1%, now 1.5%.
    const f = runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [w({ errors24h: 150 })], crons: null });
    expect(f.map((x) => [x.code, x.severity])).toEqual([['error-baseline', 'warning']]);
  });
  it('flags CPU and subrequest spikes, and storage spikes', () => {
    const f = runChecks({
      now, plan: 'paid', accountRequestsToday: 0, crons: null,
      workers: [w({ lastHourCpuUs: 300e6, hourlyMedianCpuUs7d: 10e6, lastHourSubrequests: 50_000, hourlyMedianSubrequests7d: 1_000 })],
      resources: [{ kind: 'do', resource: 'chat', label: 'Durable Objects in chat', script: 'chat', lastHour: 90_000, median7d: 2_000, historyHours: 168 }],
    });
    expect(f.map((x) => x.id)).toEqual(['runaway:api:cpu-spike', 'runaway:api:subrequest-spike', 'usage:chat:ops-spike-do-chat']);
  });
  it('uses per-Worker thresholds', () => {
    const c = defaultConfig();
    c.overrides = { api: { errorWarn: 0.2, errorCritical: 0.4 } };
    const f = runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [w({ errors24h: 1_000, errorsPrev: 6_000 })], crons: null, config: c, thresholdsFor: (n) => thresholdsFor(c, n, []) });
    expect(f).toEqual([]);
  });
  it('counts back-to-back bad cron slots', () => {
    const from = new Date('2026-11-08T11:00:00Z');
    const to = new Date('2026-11-09T11:00:00Z');
    const runs = new Map<string, { runs: number; failures: number; cpu_max_ms: number | null }>();
    for (let t = from.getTime(); t < to.getTime() - 2 * 3_600_000; t += 3_600_000) runs.set(new Date(t).toISOString().replace('.000Z', 'Z'), { runs: 1, failures: 0, cpu_max_ms: 2 });
    const s = cronStats('job', ['0 * * * *'], runs, from, to)!;
    expect(s).toMatchObject({ expected: 24, observed: 22, consecutiveBad: 2, cpuMaxMs: 2 });
    const f = runChecks({ now, plan: 'free', accountRequestsToday: 0, workers: [], crons: [s] });
    expect(f.map((x) => [x.code, x.severity])).toEqual([['missed-runs', 'critical']]);
  });
  it('warns when the account is at its Cron Trigger limit', () => {
    const f = runChecks({ now, plan: 'free', accountRequestsToday: 0, workers: [], crons: [], cronTotal: 5 });
    expect(f.map((x) => [x.id, x.severity])).toEqual([['cron:*:cron-count', 'warning']]);
  });
});

describe('hygiene helpers', () => {
  it('matches Access applications to hostnames', () => {
    expect(hostOf('*example.com/*')).toBe('example.com');
    expect(hostOf('https://Admin.example.com/x')).toBe('admin.example.com');
    expect(accessCovers(['*.example.com'], 'admin.example.com')).toBe(true);
    expect(accessCovers(['admin.example.com/panel'], 'admin.example.com')).toBe(true);
    expect(accessCovers(['admin.example.com'], 'example.com')).toBe(false);
  });
  it('counts whole months', () => {
    expect(monthsBetween(new Date('2025-11-09'), now)).toBe(12);
    expect(monthsBetween(new Date('2025-11-10'), now)).toBe(11);
  });
});

describe('time', () => {
  it('converts to local time', () => {
    expect(localTime(now, 'Europe/Prague')).toEqual({ date: '2026-11-09', weekday: 1, hour: 13, minute: 0 });
  });
  it('handles quiet hours across midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(inQuietHours(new Date('2026-11-09T23:30:00Z'), 'UTC', q)).toBe(true);
    expect(inQuietHours(new Date('2026-11-09T06:59:00Z'), 'UTC', q)).toBe(true);
    expect(inQuietHours(new Date('2026-11-09T07:00:00Z'), 'UTC', q)).toBe(false);
  });
  it('sends the weekly digest on the configured local weekday and hour, once', () => {
    const mon8 = new Date('2026-11-09T07:00:00Z'); // 08:00 in Prague, Monday
    expect(digestDue(mon8, 'Europe/Prague', 'weekly', 1, 8, null)).toBe(true);
    expect(digestDue(new Date('2026-11-09T06:00:00Z'), 'Europe/Prague', 'weekly', 1, 8, null)).toBe(false);
    expect(digestDue(new Date('2026-11-09T09:00:00Z'), 'Europe/Prague', 'weekly', 1, 8, mon8.toISOString())).toBe(false);
    expect(digestDue(new Date('2026-11-10T07:00:00Z'), 'Europe/Prague', 'weekly', 1, 8, null)).toBe(false);
  });
});

it('compares versions', () => {
  expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
  expect(isNewer('v0.1.0', '0.1.0')).toBe(false);
  expect(isNewer('0.10.0', '0.9.9')).toBe(true);
});
