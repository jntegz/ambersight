// Lighter on D1 and the API: migration 0008, the no-traffic check without a 30-day scan, upserts
// that skip unchanged rows, light queue continuations and the audit log every 6 hours.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAccountState, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { runScan } from '../src/worker/scan';
import { median } from '../src/worker/checks';
import { createD1 } from './d1';
import { fakeFetch, fleet, NOW, type FakeOptions } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

const newEnv = (): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery staple' });
const H = 3_600_000;
function stub(opts: FakeOptions = {}) {
  const f = fakeFetch(opts);
  vi.stubGlobal('fetch', f.fn);
  return f.calls;
}
async function setup() {
  const e = newEnv();
  await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
  return e;
}

describe('migration 0008', () => {
  it('fills last_active_hour from history and drops the unused indexes', async () => {
    const db = createD1({ stopBefore: '0008' });
    await db.batch([
      db.prepare(`INSERT INTO workers (account, name, last_seen) VALUES ('acc1', 'api', 'x'), ('acc1', 'idle', 'x')`),
      db.prepare(`INSERT INTO metrics_hourly (account, script, hour, requests) VALUES ('acc1', 'api', '2026-11-01T10:00:00Z', 5), ('acc1', 'api', '2026-11-02T10:00:00Z', 0), ('acc1', 'idle', '2026-11-01T10:00:00Z', 0)`),
    ]);
    (db as unknown as { migrateFrom: (f: string) => void }).migrateFrom('0008');
    const { results } = await db.prepare('SELECT name, last_active_hour FROM workers ORDER BY name').all();
    expect(results).toEqual([{ name: 'api', last_active_hour: '2026-11-01T10:00:00Z' }, { name: 'idle', last_active_hour: null }]);
    const idx = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%\\_all' ESCAPE '\\'`).all();
    expect(idx.results).toEqual([]);
  });
});

describe('no-traffic check', () => {
  it('reads the last active hour instead of summing 30 days of metrics', async () => {
    stub({ hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 10, errors: 0 }] });
    const e = await setup();
    await setAccountState(e.DB, 'acc1', { first_metrics_at: '2026-09-01T00:00:00Z' }).run();
    await runScan(e, NOW, { account: 'acc1' });
    const row = await e.DB.prepare(`SELECT last_active_hour FROM workers WHERE account = 'acc1' AND name = 'api'`).first<{ last_active_hour: string }>();
    expect(row?.last_active_hour).toBe('2026-11-09T11:00:00Z');
    const zombies = await e.DB.prepare(`SELECT script FROM findings WHERE code = 'no-traffic' AND status = 'open' ORDER BY script`).all<{ script: string }>();
    // api had a request; legacy (fetch only) has none in the window; draft was never deployed.
    expect(zombies.results.map((r) => r.script)).toContain('legacy');
    expect(zombies.results.map((r) => r.script)).not.toContain('api');
  });
});

describe('writes only what changed', () => {
  it('does not rewrite unchanged Workers or findings, and still deletes removed Workers', async () => {
    stub();
    const e = await setup();
    await runScan(e, NOW, { account: 'acc1' });
    const before = await e.DB.prepare(`SELECT name, last_seen FROM workers WHERE account = 'acc1' ORDER BY name`).all<{ name: string; last_seen: string }>();
    // A finding whose text and evidence do not change between scans (cron counts, for example, do).
    const findingBefore = await e.DB.prepare(`SELECT id, last_seen FROM findings WHERE id = 'acc1/exposure:api:previews-without-workers-dev'`).first<{ id: string; last_seen: string }>();
    expect(findingBefore).not.toBeNull();

    await runScan(e, new Date(NOW.getTime() + H), { account: 'acc1' });
    const after = await e.DB.prepare(`SELECT name, last_seen FROM workers WHERE account = 'acc1' ORDER BY name`).all<{ name: string; last_seen: string }>();
    expect(after.results).toEqual(before.results); // same data: no row rewritten
    const findingAfter = await e.DB.prepare(`SELECT last_seen, status FROM findings WHERE id = ?1`).bind(findingBefore!.id).first<{ last_seen: string; status: string }>();
    expect(findingAfter).toEqual({ last_seen: findingBefore!.last_seen, status: 'open' });

    // A Worker deleted in Cloudflare disappears from the table and its findings resolve.
    vi.unstubAllGlobals();
    stub({ fleets: {} });
    const original = { workers: fleet.workers, scripts: fleet.scripts };
    fleet.workers = fleet.workers.filter((w) => w.name !== 'draft');
    fleet.scripts = fleet.scripts.filter((s) => s.id !== 'draft');
    try {
      await runScan(e, new Date(NOW.getTime() + 2 * H), { account: 'acc1' });
    } finally {
      fleet.workers = original.workers;
      fleet.scripts = original.scripts;
    }
    const names = await e.DB.prepare(`SELECT name FROM workers WHERE account = 'acc1'`).all<{ name: string }>();
    expect(names.results.map((r) => r.name)).not.toContain('draft');
    const draft = await e.DB.prepare(`SELECT status FROM findings WHERE script = 'draft'`).all<{ status: string }>();
    expect(draft.results.every((r) => r.status === 'resolved')).toBe(true);
  });

  it('re-reads metrics from the last stored hour, not the hour before', async () => {
    const calls: string[] = [];
    const base = fakeFetch({ hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 10, errors: 0 }] });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/graphql')) {
        const b = JSON.parse(String(init?.body));
        // The request that reads the hourly totals (alone, or combined with the limit outcomes).
        if (/(totals: )?workersInvocationsAdaptive\(limit: 10000, filter: \{ datetime_geq: \$since, datetime_lt: \$until \}\)/.test(b.query)) calls.push(b.variables.since);
      }
      return base.fn(input, init);
    });
    const e = await setup();
    await runScan(e, NOW, { account: 'acc1' });
    await runScan(e, new Date(NOW.getTime() + H), { account: 'acc1' });
    expect(calls[1]).toBe('2026-11-09T11:00:00.000Z');
  });
});

describe('scan queue continuations', () => {
  it('skip the metrics, cron, notifications and audit reads the first scan already did', async () => {
    const calls = stub();
    const e = await setup();
    await runScan(e, NOW, { account: 'acc1' });
    calls.length = 0;
    await runScan(e, new Date(NOW.getTime() + 60_000), { account: 'acc1', force: true, continuation: true });
    expect(calls.filter((c) => c.endsWith('/graphql'))).toEqual([]);
    expect(calls.some((c) => c.includes('/alerting/') || c.includes('/logs/audit'))).toBe(false);
    // Cron findings from the first scan are kept, not resolved.
    const cron = await e.DB.prepare(`SELECT status FROM findings WHERE module = 'cron'`).all<{ status: string }>();
    expect(cron.results.length).toBeGreaterThan(0);
    expect(cron.results.every((r) => r.status === 'open')).toBe(true);
  });
});

describe('audit log cadence', () => {
  it('is read every 6 hours, not every scan', async () => {
    const base = fakeFetch();
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/logs/audit')) return new Response(JSON.stringify({ success: true, result: [], errors: [] }));
      return base.fn(input, init);
    });
    const e = await setup();
    for (let h = 0; h < 7; h++) await runScan(e, new Date(NOW.getTime() + h * H), { account: 'acc1' });
    expect(calls.filter((c) => c.includes('/logs/audit'))).toHaveLength(2); // at 0 h and 6 h
  });
});

describe('median', () => {
  it('matches the sorted middle, for odd and even lengths and duplicates', () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7, 7, 7, 1, 9, 7])).toBe(7);
  });
});

describe('deleted Workers leave "Needs attention" on the next scan', () => {
  it('resolves their findings even in a module whose findings are being kept, acknowledged ones too', async () => {
    stub();
    const e = await setup();
    await runScan(e, NOW, { account: 'acc1' });
    const cron = await e.DB.prepare(`SELECT id FROM findings WHERE script = 'cron-job' AND status = 'open'`).all<{ id: string }>();
    expect(cron.results.length).toBeGreaterThan(0);
    await e.DB.prepare(`UPDATE findings SET status = 'acknowledged' WHERE id = ?1`).bind(cron.results[0].id).run();

    // cron-job is deleted in Cloudflare; the next run is a continuation, which keeps cron findings.
    const original = { workers: fleet.workers, scripts: fleet.scripts };
    fleet.workers = fleet.workers.filter((w) => w.name !== 'cron-job');
    fleet.scripts = fleet.scripts.filter((s) => s.id !== 'cron-job');
    try {
      await runScan(e, new Date(NOW.getTime() + 60_000), { account: 'acc1', force: true, continuation: true });
    } finally {
      fleet.workers = original.workers;
      fleet.scripts = original.scripts;
    }
    const left = await e.DB.prepare(`SELECT status FROM findings WHERE script = 'cron-job'`).all<{ status: string }>();
    expect(left.results.every((r) => r.status === 'resolved')).toBe(true);
    const { buildOverview } = await import('../src/worker/overview');
    const o = await buildOverview(e, 'acc1', NOW);
    expect(o.findings.some((f) => f.script === 'cron-job')).toBe(false);
    expect(o.workers.some((w) => w.name === 'cron-job')).toBe(false);
  });
});
