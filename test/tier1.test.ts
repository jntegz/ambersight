// Tier 1 checks: free daily quotas, storage caps, token expiry, idle loops, bursts on new
// Workers, log volume and the cost estimate. Pure functions, plus one end-to-end scan.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOf } from '../src/shared/findings';
import { burstFindings, healthFindings, idleLoopFindings, loggingFindings, quotaFindings, runChecks, storageFindings, type CheckInput, type ResourceStats, type WorkerMeta, type WorkerStats } from '../src/worker/checks';
import { estimate, monthlyCost } from '../src/worker/cost';
import { DEFAULT_THRESHOLDS, defaultConfig } from '../src/shared/config';
import { setAccountState, setSettings, upsertAccount } from '../src/worker/db';
import { buildOverview, buildTimeline } from '../src/worker/overview';
import { runScan } from '../src/worker/scan';
import { scheduledRun } from '../src/worker/scheduler';
import type { Env } from '../src/worker/env';
import { createD1 } from './d1';
import { fakeFetch, NOW } from './fixtures';

const now = new Date('2026-11-09T12:00:00Z');
const base = (over: Partial<CheckInput> = {}): CheckInput => ({ now, plan: 'free', accountRequestsToday: 0, workers: [], crons: null, ...over });
const t = DEFAULT_THRESHOLDS;
const tf = () => t;

const worker = (over: Partial<WorkerStats> = {}): WorkerStats => ({
  name: 'api', requests24h: 1000, errors24h: 0, requestsPrev: 6000, errorsPrev: 0, exceeded24h: 0, cpuP99Max24h: 2,
  lastHourRequests: 40, hourlyMedian7d: 40, lastHourCpuUs: 40_000, hourlyMedianCpuUs7d: 40_000,
  lastHourSubrequests: 0, hourlyMedianSubrequests7d: 0, historyHours: 168, ...over,
});
const resource = (over: Partial<ResourceStats> = {}): ResourceStats => ({
  kind: 'do', resource: 'chat', label: 'Durable Objects in chat', script: 'chat', lastHour: 3000, median7d: 3000, historyHours: 168,
  recentOps: [3000, 3000, 3000], recentRequests: [5, 2, 0], ...over,
});
const meta = (over: Partial<WorkerMeta> = {}): WorkerMeta => ({
  name: 'api', groups: [], handlers: ['fetch'], hasModules: true, compatibilityDate: '2026-09-01', compatibilityFlags: [], usageModel: 'standard',
  bindings: [], workersDev: false, previewsEnabled: false, logsEnabled: true, samplingRate: 1, logpush: false, deployedOn: '2026-11-01', listed: true, deployments: [], ...over,
});

describe('free daily quotas', () => {
  it('warns at 70% of free KV writes and projects when they run out', () => {
    const [f] = quotaFindings(base({ quotaToday: { 'kv.write': 700 } }), t);
    expect(f).toMatchObject({ id: 'budget:*:free-daily-kv-writes', severity: 'warning' });
    expect(f.evidence.projectedLimitAt).toBe('2026-11-09T17:08:34.285Z');
    expect(f.action).toContain('per account');
  });
  it('is critical at 90% and says when the limit is already reached', () => {
    expect(quotaFindings(base({ quotaToday: { 'd1.rowsRead': 4_600_000 } }), t)[0].severity).toBe('critical');
    const [out] = quotaFindings(base({ quotaToday: { 'd1.rowsWritten': 120_000 } }), t);
    expect(out.message).toContain('out of free D1 rows written');
    expect(out.evidence.projectedLimitAt).toBe('reached');
  });
  it('stays quiet below the warning level and on Workers Paid', () => {
    expect(quotaFindings(base({ quotaToday: { 'kv.read': 50_000, 'queues.ops': 6_000 } }), t)).toEqual([]);
    expect(quotaFindings(base({ plan: 'paid', quotaToday: { 'kv.write': 50_000 } }), t)).toEqual([]);
  });
  it('tells Paid accounts when Workers AI passes the free daily neurons', () => {
    const [f] = quotaFindings(base({ plan: 'paid', quotaToday: { 'ai.neurons': 12_000 } }), t);
    expect(f).toMatchObject({ code: 'free-daily-ai-neurons', severity: 'info' });
  });
  it('runs only with the usage module on', () => {
    const config = defaultConfig();
    config.modules.usage = false;
    expect(runChecks(base({ quotaToday: { 'kv.write': 990 }, config }))).toEqual([]);
  });
});

describe('storage caps', () => {
  it('flags a D1 database near the 500 MB Free limit, grouped as one check', () => {
    const [f] = storageFindings(base({ storage: [{ kind: 'd1', id: 'db1', bytes: 460e6, label: 'main' }] }));
    expect(f).toMatchObject({ code: 'storage-d1-db-db1', severity: 'warning' });
    expect(checkOf(f)).toBe('budget:storage-d1-db');
    expect(f.message).toContain('main');
  });
  it('uses the 10 GB limit on Paid, and the account totals on Free', () => {
    expect(storageFindings(base({ plan: 'paid', storage: [{ kind: 'd1', id: 'db1', bytes: 460e6, label: 'main' }] }))).toEqual([]);
    const kv = storageFindings(base({ storage: [{ kind: 'kv', id: 'a', bytes: 0.6e9, label: 'a' }, { kind: 'kv', id: 'b', bytes: 0.4e9, label: 'b' }] }));
    expect(kv.map((f) => [f.code, f.severity])).toEqual([['storage-kv-account', 'critical']]);
  });
  it('keeps R2 at warning, since past the free amount it is billed rather than blocked', () => {
    expect(storageFindings(base({ storage: [{ kind: 'r2', id: 'b', bytes: 9.9e9, label: 'b' }] }))[0].severity).toBe('warning');
  });
});

describe('token expiry', () => {
  it('warns two weeks out and is critical in the last 3 days', () => {
    expect(healthFindings(base({ tokenExpiresOn: '2026-11-30T00:00:00Z' }))).toEqual([]);
    expect(healthFindings(base({ tokenExpiresOn: '2026-11-20T00:00:00Z' }))[0]).toMatchObject({ id: 'health:*:token-expiry', severity: 'warning' });
    expect(healthFindings(base({ tokenExpiresOn: '2026-11-11T00:00:00Z' }))[0].severity).toBe('critical');
    expect(healthFindings(base({ tokenExpiresOn: null }))).toEqual([]);
  });
  it('is raised even when every module is switched off', () => {
    const config = defaultConfig();
    for (const k of Object.keys(config.modules) as (keyof typeof config.modules)[]) config.modules[k] = false;
    expect(runChecks(base({ config, tokenExpiresOn: '2026-11-10T00:00:00Z' })).map((f) => f.code)).toEqual(['token-expiry']);
  });
});

describe('idle loops', () => {
  it('flags Durable Objects busy for 3 hours while their Worker sees almost no requests', () => {
    const [f] = idleLoopFindings(base({ plan: 'paid', resources: [resource()] }));
    expect(f).toMatchObject({ code: 'idle-loop-do-chat', severity: 'critical' });
    expect(checkOf(f)).toBe('usage:idle-loop-do');
  });
  it('is a warning on Free, and quiet when traffic explains the work or one hour was calm', () => {
    expect(idleLoopFindings(base({ resources: [resource()] }))[0].severity).toBe('warning');
    expect(idleLoopFindings(base({ resources: [resource({ recentRequests: [100, 100, 100] })] }))).toEqual([]);
    expect(idleLoopFindings(base({ resources: [resource({ recentOps: [3000, 500, 3000] })] }))).toEqual([]);
    expect(idleLoopFindings(base({ resources: [resource({ recentRequests: null })] }))).toEqual([]);
  });
});

describe('bursts on new Workers and resources', () => {
  it('flags a new Worker with a big hour, which the 5x baseline cannot see yet', () => {
    const [f] = burstFindings(base({ plan: 'paid', workers: [worker({ historyHours: 10, lastHourRequests: 80_000 })] }), tf);
    expect(f).toMatchObject({ code: 'new-worker-burst', severity: 'critical' });
    expect(f.message).toContain('$');
    expect(burstFindings(base({ workers: [worker({ historyHours: 200, lastHourRequests: 80_000 })] }), tf)).toEqual([]);
  });
  it('flags a new resource past the absolute floor', () => {
    const [f] = burstFindings(base({ resources: [resource({ kind: 'kv', resource: 'ns1', label: 'cache', historyHours: 5, lastHour: 150_000 })] }), tf);
    expect(f).toMatchObject({ code: 'new-resource-burst-kv-ns1', severity: 'warning' });
  });
});

describe('runaway cost on Paid', () => {
  it('adds the dollars above usual to a traffic spike', () => {
    const [f] = runChecks(base({ plan: 'paid', workers: [worker({ lastHourRequests: 2_000_000, hourlyMedian7d: 100_000 })] }));
    expect(f.code).toBe('traffic-spike');
    expect(f.evidence.extraPerHour).toBe('$0.57');
  });
});

describe('log volume (per-GB pricing from 1 December 2026)', () => {
  it('warns Free accounts that logs will stop being stored partway through the day', () => {
    const f = loggingFindings(base({ workers: [worker({ requests24h: 500_000 })], meta: [meta()] }));
    const free = f.find((x) => x.code === 'logs-free-allowance')!;
    expect(free.severity).toBe('warning');
    expect(free.message).toMatch(/stop being stored around \d\d:\d\d UTC/);
  });
  it('estimates monthly GB per Worker, and the cost past 50 GB on Paid', () => {
    const f = loggingFindings(base({ plan: 'paid', workers: [worker({ requests24h: 2_000_000 })], meta: [meta()] }));
    const one = f.find((x) => x.code === 'logs-full-sampling')!;
    expect(one.evidence.estimatedGbPerMonth).toBe(90);
    expect(one.message).toContain('$10.00 a month');
  });
});

describe('cost estimate', () => {
  it('charges only past the included amounts', () => {
    expect(monthlyCost({ 'workers.requests': 9e6 }, {}).total).toBe(5);
    const c = monthlyCost({ 'workers.requests': 20e6, 'kv.write': 2e6 }, { d1: 6e9 });
    expect(c.total).toBeCloseTo(5 + 3 + 5 + 0.75, 5);
  });
  it('forecasts the month from the days so far and ranks Workers', () => {
    const e = estimate(new Date('2026-11-16T00:00:00Z'), { 'workers.requests': 15e6 }, {}, [
      { name: 'cheap', requests: 1000, cpuMs: 0 },
      { name: 'busy', requests: 7e6, cpuMs: 7e6 },
    ], '2026-11-01T00:00:00Z');
    expect(e.monthToDate).toBe(6.5);
    expect(e.forecast).toBe(11); // 30M requests: 20M over the included 10M
    expect(e.topWorkers[0].name).toBe('busy');
    expect(e.partialMonth).toBe(false);
  });
});

describe('Tier 1 end to end', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores quotas and storage, then shows them on the overview with the token expiry finding', async () => {
    const f = fakeFetch();
    const real = f.fn;
    // KV writes by action type, D1 rows, storage sizes and a token that expires next week.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const json = (data: unknown) => new Response(JSON.stringify({ data, errors: null }));
      if (url.endsWith('/graphql')) {
        const q = JSON.parse(String(init?.body)).query as string;
        if (q.includes('kvOperationsAdaptiveGroups') && q.includes('actionType')) {
          return json({ viewer: { accounts: [{ kvOperationsAdaptiveGroups: [
            { dimensions: { namespaceId: 'ns-used', datetimeHour: '2026-11-09T09:00:00Z', actionType: 'write' }, sum: { requests: 450 } },
            { dimensions: { namespaceId: 'ns-used', datetimeHour: '2026-11-09T10:00:00Z', actionType: 'write' }, sum: { requests: 400 } },
            { dimensions: { namespaceId: 'ns-used', datetimeHour: '2026-11-09T10:00:00Z', actionType: 'read' }, sum: { requests: 2000 } },
          ] }] } });
        }
        if (q.includes('kvStorageAdaptiveGroups')) return json({ viewer: { accounts: [{ kvStorageAdaptiveGroups: [{ dimensions: { namespaceId: 'ns-used' }, max: { byteCount: 9.7e8, keyCount: 10 } }] }] } });
      }
      if (url.endsWith('/user/tokens/verify')) return new Response(JSON.stringify({ success: true, result: { id: 'tok1', status: 'active', expires_on: '2026-11-12T00:00:00Z' } }));
      return real(input, init);
    });
    const e: Env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery' };
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    // The first scan lists the KV namespaces; operations are read from the next scan on.
    await runScan(e, NOW, { account: 'acc1' });
    await runScan(e, new Date(NOW.getTime() + 5 * 60_000), { account: 'acc1', force: true });

    const { results } = await e.DB.prepare(`SELECT code, severity FROM findings WHERE status = 'open' AND module IN ('budget','health')`).all<{ code: string; severity: string }>();
    const codes = Object.fromEntries(results.map((r) => [r.code, r.severity]));
    expect(codes['free-daily-kv-writes']).toBe('warning'); // 850 of 1,000 is 85%: critical starts at 90%
    expect(codes['storage-kv-account']).toBe('critical'); // 0.97 of 1 GB
    expect(codes['token-expiry']).toBe('critical');

    const o = await buildOverview(e, 'acc1', NOW);
    expect(o.quotas.map((q) => [q.label, q.used])).toEqual([['KV writes', 850], ['KV reads', 2000]]);
    expect(o.storage[0]).toMatchObject({ kind: 'kv', label: 'All KV' });
    expect(o.cost).toBeNull(); // Free plan
  });

  it('puts Cloudflare\'s own notifications on the timeline', async () => {
    const f = fakeFetch();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.includes('/alerting/v3/history')) {
        return new Response(JSON.stringify({ success: true, result: [{ id: 'al1', sent: '2026-11-09T08:00:00Z', alert_type: 'workers_usage', name: 'Usage notification', description: 'Your Workers used 80% of the daily limit.' }] }));
      }
      return f.fn(input, init);
    });
    const e: Env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery' };
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    await runScan(e, NOW, { account: 'acc1' });
    vi.setSystemTime(NOW);
    const tl = await buildTimeline(e, 'acc1', 7);
    vi.useRealTimers();
    expect(tl.find((x) => x.kind === 'cf-alert')).toMatchObject({ source: 'Usage notification', message: 'Your Workers used 80% of the daily limit.' });
  });

  it('alerts once a day after 3 failed scans in a row', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }] }), { status: 403 }));
    const sent: { subject: string }[] = [];
    const e: Env = {
      DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery',
      EMAIL_FROM: 'a@example.com', DIGEST_TO: 'me@example.com', EMAIL: { send: async (m) => void sent.push(m) },
    };
    await e.DB.batch([setSettings(e.DB, { setup_done: '1' }), upsertAccount(e.DB, { id: 'acc1' }, NOW), setAccountState(e.DB, 'acc1', { last_scan_at: '2026-11-08T00:00:00Z' })]);
    for (let i = 0; i < 4; i++) await scheduledRun(e, new Date(NOW.getTime() + i * 3_600_000));
    expect(sent.map((m) => m.subject)).toEqual(['Ambersight: scans are failing']);
    const o = await buildOverview(e, 'acc1', NOW);
    expect(o.scanHealth).toMatchObject({ failures: 4, lastError: 'Invalid API Token' });
  });
});

describe('free plan limits of the scan itself', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('stays within 42 subrequests and 50 D1 queries, first scan and later scans', async () => {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const e: Env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery' };
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    const first = await runScan(e, NOW, { account: 'acc1' });
    const later = await runScan(e, new Date(NOW.getTime() + 3_600_000), { account: 'acc1' });
    for (const r of [first, later]) {
      expect(r.subrequests).toBeLessThanOrEqual(42);
      expect(r.d1Queries).toBeLessThan(50);
    }
  });
});
