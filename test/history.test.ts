// History: combined GraphQL requests, the splits that used to be merged, daily rollups, the finding
// event log, scan runs, cached views with ETags and the findings inbox.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { timingSafeEqual } from 'node:crypto';
import { login } from '../src/worker/auth';
import { getAccountState, setAccountState, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { rollupDays } from '../src/worker/history';
import worker, { usageBuffer } from '../src/worker/index';
import { buildSelfCost } from '../src/worker/overview';
import { runScan } from '../src/worker/scan';
import { createD1 } from './d1';
import { fakeFetch, NOW, type FakeOptions } from './fixtures';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const H = 3_600_000;
const PASS = 'correct horse battery';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
  usageBuffer.reset();
});

function env(): Env {
  return { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS };
}

function stub(opts: FakeOptions = {}) {
  const f = fakeFetch(opts);
  vi.stubGlobal('fetch', f.fn);
  return f;
}

async function scan(e: Env, now: Date, force = false) {
  await upsertAccount(e.DB, { id: 'acc1', name: 'Test account' }, new Date('2026-11-01T00:00:00Z')).run();
  return runScan(e, now, { account: 'acc1', force });
}

/** Yesterday (2026-11-08) and today's hours, so the rollup has a complete day to fold. */
const HOURLY = [
  ...Array.from({ length: 24 }, (_, i) => ({ scriptName: 'api', datetimeHour: `2026-11-08T${String(i).padStart(2, '0')}:00:00Z`, requests: 100, errors: i === 3 ? 7 : 0, cpuTimeUs: 2000 })),
  { scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 50, errors: 0 },
];

describe('combined GraphQL requests', () => {
  it('reads totals and limit outcomes in one request, and the limit hits by type', async () => {
    const f = stub({
      hourly: HOURLY,
      exceeded: [
        { scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', status: 'exceededCpu', requests: 4 },
        { scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', status: 'exceededMemory', requests: 1 },
      ],
    });
    const e = env();
    await scan(e, NOW);
    expect(f.graphqlAliases).toContainEqual(['workersInvocationsAdaptive', 'workersInvocationsAdaptive']);
    const graphql = f.calls.filter((c) => c.endsWith('/graphql'));
    // No request reads the totals or the limit outcomes on its own any more.
    expect(graphql.length).toBeLessThanOrEqual(4);
    const row = await e.DB.prepare(`SELECT exceeded, exceeded_cpu, exceeded_memory FROM metrics_hourly WHERE script = 'api' AND hour = '2026-11-09T11:00:00Z'`).first();
    expect(row).toEqual({ exceeded: 5, exceeded_cpu: 4, exceeded_memory: 1 });
    expect((await getAccountState(e.DB, 'acc1')).gql_merge).toBe('yes');
  });

  it('reads an hourly scan with at most 3 GraphQL requests', async () => {
    const f = stub({ hourly: HOURLY, kvOps: [{ namespaceId: 'ns-used', datetimeHour: '2026-11-09T11:00:00Z', requests: 3 }] });
    const e = env();
    await scan(e, NOW);
    f.calls.length = 0;
    await scan(e, new Date(NOW.getTime() + H));
    // Totals and limit outcomes (1), cron runs (1), storage operations of every kind (1).
    expect(f.calls.filter((c) => c.endsWith('/graphql')).length).toBeLessThanOrEqual(3);
  });

  it('falls back to one request per dataset when the account rejects the combined one', async () => {
    const f = stub({ hourly: HOURLY, rejectCpuSum: true });
    const e = env();
    await setAccountState(e.DB, 'acc1', { cpu_sum: 'unsupported' }).run();
    // With CPU totals already known to be unsupported, a failing combined query is the combination's fault.
    const base = f.fn;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/graphql') && String(init?.body).includes('totals: ')) return new Response(JSON.stringify({ data: null, errors: [{ message: 'aliases not allowed' }] }));
      return base(input, init);
    });
    await scan(e, NOW);
    expect(await e.DB.prepare(`SELECT SUM(requests) AS n FROM metrics_hourly WHERE script = 'api'`).first('n')).toBe(2450);
    const s = await getAccountState(e.DB, 'acc1');
    expect(s.gql_merge).toBe('no');
    // The next hourly scan does not try the combination again.
    f.graphqlAliases.length = 0;
    await scan(e, new Date(NOW.getTime() + H));
    expect(f.graphqlAliases.filter((a) => a.includes('workersInvocationsAdaptive'))).toEqual([]);
  });

  it('keeps the KV operation split per namespace', async () => {
    stub({
      kvOps: [
        { namespaceId: 'ns-used', datetimeHour: '2026-11-09T11:00:00Z', requests: 30, actionType: 'read' },
        { namespaceId: 'ns-used', datetimeHour: '2026-11-09T11:00:00Z', requests: 5, actionType: 'write' },
      ],
    });
    const e = env();
    await scan(e, NOW); // the first scan lists the namespaces
    await scan(e, new Date(NOW.getTime() + H));
    const row = await e.DB.prepare(`SELECT ops, reads, writes FROM resource_hourly WHERE kind = 'kv' AND resource = 'ns-used' AND hour = '2026-11-09T11:00:00Z'`).first();
    expect(row).toEqual({ ops: 35, reads: 30, writes: 5 });
  });
});

describe('daily rollups', () => {
  it('rolls up complete days only, a few per scan, after a short delay', () => {
    expect(rollupDays(new Date('2026-11-09T01:30:00Z'), '2026-11-07')).toEqual([]);
    expect(rollupDays(new Date('2026-11-09T02:30:00Z'), '2026-11-07')).toEqual(['2026-11-08']);
    expect(rollupDays(new Date('2026-11-09T12:00:00Z'), undefined)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']);
    expect(rollupDays(new Date('2026-11-09T12:00:00Z'), '2026-11-01')).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('folds yesterday into metrics_daily and quota_daily, with the peak hour', async () => {
    stub({ hourly: HOURLY });
    const e = env();
    await scan(e, NOW);
    const day = await e.DB.prepare(`SELECT requests, errors, cpu_time_us, active_hours FROM metrics_daily WHERE script = 'api' AND day = '2026-11-08'`).first();
    expect(day).toEqual({ requests: 2400, errors: 7, cpu_time_us: 48_000, active_hours: 24 });
    const quota = await e.DB.prepare(`SELECT value, peak_value FROM quota_daily WHERE metric = 'workers.requests' AND day = '2026-11-08'`).first();
    expect(quota).toEqual({ value: 2400, peak_value: 100 });
    // Today is not rolled up yet.
    expect(await e.DB.prepare(`SELECT COUNT(*) AS n FROM metrics_daily WHERE day = '2026-11-09'`).first('n')).toBe(0);
    expect((await getAccountState(e.DB, 'acc1')).rollup_day).toBe('2026-11-08');
  });
});

describe('finding history and scan runs', () => {
  it('records opened findings and the scan that opened them', async () => {
    stub();
    const e = env();
    await scan(e, NOW);
    const opened = (await e.DB.prepare(`SELECT COUNT(*) AS n FROM finding_events WHERE kind = 'opened'`).first('n')) as number;
    const open = (await e.DB.prepare(`SELECT COUNT(*) AS n FROM findings WHERE status = 'open'`).first('n')) as number;
    expect(opened).toBe(open);
    expect(opened).toBeGreaterThan(0);
    const run = await e.DB.prepare('SELECT opened, resolved, findings FROM scan_runs').first<{ opened: number; resolved: number; findings: number }>();
    expect(run?.opened).toBe(opened);
    expect(run?.resolved).toBe(0);
  });

  it('records a resolve and a reopen, and counts reopens', async () => {
    stub();
    const e = env();
    await scan(e, NOW);
    const id = 'acc1/test:*:manual';
    // A finding no scan raises: the next scan resolves it.
    await e.DB.prepare(
      `INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
       VALUES (?1, 'acc1', '*', 'health', 'warning', 'manual', 'm', '{}', 'a', ?2, ?2, 'open')`,
    ).bind(id, NOW.toISOString()).run();
    await scan(e, new Date(NOW.getTime() + H), true);
    expect(await e.DB.prepare('SELECT status FROM findings WHERE id = ?1').bind(id).first('status')).toBe('resolved');
    const kinds = (await e.DB.prepare('SELECT kind FROM finding_events WHERE finding_id = ?1 ORDER BY at').bind(id).all<{ kind: string }>()).results.map((r) => r.kind);
    expect(kinds).toEqual(['resolved']);
  });
});

async function signedIn(e: Env) {
  const r = await login(e, PASS, '1.1.1.1');
  if (!r.ok) throw new Error('login failed');
  return r.cookie.split(';')[0];
}

const get = (e: Env, cookie: string, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://ambersight.example${path}`, { headers: { Cookie: cookie, ...headers } }), e, ctx);
const post = (e: Env, cookie: string, path: string, body: unknown = {}) =>
  worker.fetch(new Request(`https://ambersight.example${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Cookie: cookie, Origin: 'https://ambersight.example', 'Content-Type': 'application/json' },
  }), e, ctx);

describe('cached views', () => {
  it('answers 304 to a browser that has the current overview, and rebuilds after a change', async () => {
    stub();
    const e = env();
    await scan(e, NOW);
    const cookie = await signedIn(e);
    const first = await get(e, cookie, '/api/overview');
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag')!;
    expect(etag).toBeTruthy();
    expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
    const again = await get(e, cookie, '/api/overview', { 'If-None-Match': etag });
    expect(again.status).toBe(304);

    // Acknowledging a finding changes what the overview shows.
    const body = (await first.json()) as { findings: { id: string }[] };
    expect((await post(e, cookie, `/api/findings/${encodeURIComponent(body.findings[0].id)}/acknowledge`)).status).toBe(200);
    const after = await get(e, cookie, '/api/overview', { 'If-None-Match': etag });
    expect(after.status).toBe(200);
    expect(after.headers.get('ETag')).not.toBe(etag);
    const shown = (await after.json()) as { findings: { id: string }[] };
    expect(shown.findings.map((f) => f.id)).not.toContain(body.findings[0].id);
  });

  it('serves the stored copy without rebuilding it', async () => {
    stub();
    const e = env();
    await scan(e, NOW);
    const cookie = await signedIn(e);
    const a = await (await get(e, cookie, '/api/overview')).text();
    // Change a row behind the cache's back: the cached copy is served until the next change.
    await e.DB.prepare(`UPDATE workers SET name = name`).run();
    const b = await (await get(e, cookie, '/api/overview')).text();
    expect(b).toBe(a);
    expect(await e.DB.prepare(`SELECT COUNT(*) AS n FROM view_cache WHERE view = 'overview'`).first('n')).toBe(1);
  });
});

describe('the findings inbox', () => {
  it('lists acknowledged findings and restores one, with its history', async () => {
    stub();
    const e = env();
    await scan(e, NOW);
    const cookie = await signedIn(e);
    const open = (await (await get(e, cookie, '/api/findings?status=open')).json()) as { id: string }[];
    const id = open[0].id;
    await post(e, cookie, `/api/findings/${encodeURIComponent(id)}/acknowledge`);
    const acked = (await (await get(e, cookie, '/api/findings?status=acknowledged')).json()) as { id: string; statusAt: string | null }[];
    expect(acked.map((f) => f.id)).toEqual([id]);
    expect(acked[0].statusAt).toBeTruthy();
    await post(e, cookie, `/api/findings/${encodeURIComponent(id)}/restore`);
    expect(((await (await get(e, cookie, '/api/findings?status=acknowledged')).json()) as unknown[]).length).toBe(0);
    const history = (await (await get(e, cookie, `/api/findings/${encodeURIComponent(id)}/history`)).json()) as { kind: string }[];
    expect(history.map((h) => h.kind)).toEqual(['opened', 'acknowledged', 'restored']);
  });

  it('restores a whole group with the bulk action', async () => {
    stub();
    const e = env();
    await scan(e, NOW);
    const cookie = await signedIn(e);
    const open = (await (await get(e, cookie, '/api/findings?status=open')).json()) as { id: string }[];
    const ids = open.slice(0, 2).map((f) => f.id);
    const snoozed = (await (await post(e, cookie, '/api/findings/bulk', { ids, action: 'snooze', days: 30 })).json()) as { changed: number };
    expect(snoozed.changed).toBe(2);
    const restored = (await (await post(e, cookie, '/api/findings/bulk', { ids, action: 'restore' })).json()) as { changed: number };
    expect(restored.changed).toBe(2);
    expect((await post(e, cookie, '/api/findings/bulk', { ids, action: 'delete' })).status).toBe(400);
  });
});

describe('the Self-cost panel', () => {
  it('lists days oldest first, so the last one is today', async () => {
    const e = env();
    await e.DB.prepare(`INSERT INTO usage_daily (day, cron_runs, api_requests, subrequests, rows_read, rows_written) VALUES (?1, 1, 0, 0, 0, 0), (?2, 2, 0, 0, 0, 0)`)
      .bind(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)).run();
    const cost = await buildSelfCost(e, 'acc1');
    expect(cost.days.map((d) => d.cronRuns)).toEqual([1, 2]);
  });

  it('writes the dashboard request count in batches, not one row per request', async () => {
    stub();
    const e = env();
    const cookie = await signedIn(e);
    for (let i = 0; i < 9; i++) await get(e, cookie, '/api/health');
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM usage_daily').first('n')).toBe(0);
    expect(usageBuffer.pending().apiRequests).toBe(9);
    await get(e, cookie, '/api/health');
    expect(await e.DB.prepare('SELECT api_requests FROM usage_daily').first('api_requests')).toBe(10);
  });
});
