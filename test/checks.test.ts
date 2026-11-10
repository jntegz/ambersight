// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { median, projectLimitTime, runChecks, type WorkerStats } from '../src/worker/checks';
import { countRuns } from '../src/worker/cron';
import { mergeInventory } from '../src/worker/scan';

const worker = (over: Partial<WorkerStats> = {}): WorkerStats => ({
  name: 'api',
  requests24h: 1000,
  errors24h: 0,
  requestsPrev: 6000,
  errorsPrev: 0,
  exceeded24h: 0,
  cpuP99Max24h: 2,
  lastHourRequests: 40,
  hourlyMedian7d: 40,
  lastHourCpuUs: 40_000,
  hourlyMedianCpuUs7d: 40_000,
  lastHourSubrequests: 0,
  hourlyMedianSubrequests7d: 0,
  historyHours: 168,
  ...over,
});

const now = new Date('2026-11-09T12:00:00Z');

describe('budget', () => {
  it('stays quiet under 70% of the free limit', () => {
    expect(runChecks({ now, plan: 'free', accountRequestsToday: 69_000, workers: [], crons: null })).toEqual([]);
  });
  it('warns at 70% and projects the limit time', () => {
    const [f] = runChecks({ now, plan: 'free', accountRequestsToday: 70_000, workers: [], crons: null });
    expect(f.severity).toBe('warning');
    expect(f.evidence.projectedLimitAt).toBe('2026-11-09T17:08:34.285Z');
  });
  it('is critical at 90%', () => {
    expect(runChecks({ now, plan: 'free', accountRequestsToday: 95_000, workers: [], crons: null })[0].severity).toBe('critical');
  });
  it('is off on the paid plan', () => {
    expect(runChecks({ now, plan: 'paid', accountRequestsToday: 500_000, workers: [], crons: null })).toEqual([]);
  });
  it('returns null when the limit is not reached today', () => {
    expect(projectLimitTime(now, 10_000)).toBeNull();
  });
});

describe('errors and limits', () => {
  it('flags an error rate above 2% as warning and above 10% as critical', () => {
    const warn = runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [worker({ errors24h: 30 })], crons: null });
    expect(warn.map((f) => [f.code, f.severity])).toEqual([['error-rate', 'warning']]);
    const crit = runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [worker({ errors24h: 200 })], crons: null });
    expect(crit[0].severity).toBe('critical');
  });
  it('ignores error rates on tiny traffic', () => {
    expect(runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [worker({ requests24h: 10, errors24h: 5 })], crons: null })).toEqual([]);
  });
  it('flags resource limit hits and CPU near the free limit', () => {
    const f = runChecks({ now, plan: 'free', accountRequestsToday: 0, workers: [worker({ cpuP99Max24h: 9 })], crons: null });
    expect(f.map((x) => x.code)).toEqual(['cpu-near-limit']);
    const g = runChecks({ now, plan: 'free', accountRequestsToday: 0, workers: [worker({ exceeded24h: 3, cpuP99Max24h: 12 })], crons: null });
    expect(g.map((x) => x.code)).toEqual(['resource-limit']);
  });
});

describe('runaway', () => {
  it('flags a 5x spike with enough history', () => {
    const f = runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [worker({ lastHourRequests: 5000, hourlyMedian7d: 400 })], crons: null });
    expect(f[0].code).toBe('traffic-spike');
  });
  it('waits for 72 hours of history', () => {
    const f = runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [worker({ lastHourRequests: 5000, hourlyMedian7d: 400, historyHours: 24 })], crons: null });
    expect(f).toEqual([]);
  });
});

describe('cron', () => {
  it('counts expected runs', () => {
    const from = new Date('2026-11-08T11:00:00Z');
    const to = new Date('2026-11-09T11:00:00Z');
    expect(countRuns('0 * * * *', from, to)).toBe(24);
    expect(countRuns('*/15 * * * *', from, to)).toBe(96);
    expect(countRuns('30 8 * * *', from, to)).toBe(1);
    expect(countRuns('0 9 * * mon-fri', from, to)).toBe(1); // Monday 9 Nov only
    expect(countRuns('0 9 * * 6,0', from, to)).toBe(0);
  });
  it('flags missed and failed runs', () => {
    const f = runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [], crons: [{ name: 'sync', expected: 24, observed: 21, failures: 1 }] });
    expect(f.map((x) => [x.code, x.severity])).toEqual([['missed-runs', 'critical'], ['failed-runs', 'warning']]);
  });
});

describe('helpers', () => {
  it('median', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it('merges scripts with beta Workers list data', () => {
    const rows = mergeInventory(
      [{ id: 'api', handlers: ['fetch', 'scheduled'], has_modules: true, compatibility_date: '2025-01-01' }],
      [{ name: 'api', subdomain: { enabled: true, previews_enabled: false }, observability: { enabled: true, head_sampling_rate: 1 } }],
      'stamp',
    );
    expect(rows[0]).toMatchObject({ name: 'api', has_modules: 1, workers_dev: 1, previews_enabled: 0, logs_enabled: 1, sampling_rate: 1 });
  });
});
