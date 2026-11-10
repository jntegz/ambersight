// One install, several Cloudflare accounts: the v5 migration, isolation between accounts, and the scheduler.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAccountState, getSettings, listAccounts, setAccountState, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { buildAccounts, buildOverview } from '../src/worker/overview';
import { dueAccounts, effectiveIntervalMinutes, scheduledRun } from '../src/worker/scheduler';
import { runScan } from '../src/worker/scan';
import { createD1 } from './d1';
import { fakeFetch, NOW, type FakeOptions } from './fixtures';

const env = (over: Partial<Env> = {}): Env => ({
  DB: createD1(),
  ASSETS: {} as Fetcher,
  CF_API_TOKEN: 'test-token',
  ADMIN_PASSPHRASE: 'correct horse battery',
  ...over,
});

const stub = (opts: FakeOptions = {}) => vi.stubGlobal('fetch', fakeFetch(opts).fn);
afterEach(() => vi.unstubAllGlobals());

/** acc2 has one Worker that shares a name with acc1's, to prove the two never mix. */
const ACC2 = {
  workers: [{ name: 'api', deployed_on: '2026-11-01T10:00:00Z', subdomain: { enabled: false, previews_enabled: false } }],
  scripts: [{ id: 'api', has_modules: true, compatibility_date: '2026-09-01', handlers: ['fetch'], usage_model: 'standard' }],
};

describe('migration to multi-account (0005)', () => {
  it('keeps a v4 install\'s history under its account', async () => {
    const db = createD1({ stopBefore: '0005' });
    await db.batch([
      setSettings(db, { account_id: 'acc1', setup_done: '1', last_scan_at: '2026-11-09T11:00:00Z', detected_plan: 'paid', config: '{}' }),
      db.prepare(`INSERT INTO workers (name, last_seen, handlers) VALUES ('api', '2026-11-09T11:00:00Z', '["fetch"]')`),
      db.prepare(`INSERT INTO metrics_hourly (script, hour, requests) VALUES ('api', '2026-11-09T10:00:00Z', 42)`),
      db.prepare(`INSERT INTO findings (id, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
        VALUES ('exposure:api:preview-urls', 'api', 'exposure', 'warning', 'preview-urls', 'm', '{}', 'a', 'x', 'x', 'acknowledged')`),
    ]);
    (db as unknown as { migrateFrom: (f: string) => void }).migrateFrom('0005');

    expect(await listAccounts(db)).toMatchObject([{ id: 'acc1', enabled: 1, detected_plan: 'paid' }]);
    expect((await getAccountState(db, 'acc1')).last_scan_at).toBe('2026-11-09T11:00:00Z');
    const settings = await getSettings(db);
    expect(settings.account_id).toBeUndefined();
    expect(settings.last_scan_at).toBeUndefined();
    expect(settings.setup_done).toBe('1');
    expect(await db.prepare('SELECT account, name FROM workers').all()).toMatchObject({ results: [{ account: 'acc1', name: 'api' }] });
    expect(await db.prepare('SELECT account, requests FROM metrics_hourly').all()).toMatchObject({ results: [{ account: 'acc1', requests: 42 }] });
    // The acknowledgement survives, under the prefixed ID.
    expect(await db.prepare('SELECT id, account, status FROM findings').all()).toMatchObject({
      results: [{ id: 'acc1/exposure:api:preview-urls', account: 'acc1', status: 'acknowledged' }],
    });
  });

  it('works on a fresh install with no account yet', async () => {
    const db = createD1();
    expect(await listAccounts(db, true)).toEqual([]);
  });
});

describe('several accounts in one install', () => {
  it('scans each account on its own: same Worker name, separate rows and findings', async () => {
    stub({ fleets: { acc2: ACC2 } });
    const e = env();
    await e.DB.batch([upsertAccount(e.DB, { id: 'acc1', name: 'One' }, NOW), upsertAccount(e.DB, { id: 'acc2', name: 'Two' }, new Date(NOW.getTime() + 1))]);
    await runScan(e, NOW, { account: 'acc1' });
    await runScan(e, NOW, { account: 'acc2' });

    const rows = await e.DB.prepare('SELECT account, name FROM workers ORDER BY account, name').all<{ account: string; name: string }>();
    expect(rows.results.filter((r) => r.account === 'acc2').map((r) => r.name)).toEqual(['api']);
    expect(rows.results.filter((r) => r.account === 'acc1').map((r) => r.name)).toContain('legacy');

    // acc1's api has public previews; acc2's api does not.
    const previews = await e.DB.prepare(`SELECT id FROM findings WHERE code = 'previews-without-workers-dev'`).all<{ id: string }>();
    expect(previews.results.map((r) => r.id)).toEqual(['acc1/exposure:api:previews-without-workers-dev']);

    const o1 = await buildOverview(e, 'acc1', NOW);
    const o2 = await buildOverview(e, 'acc2', NOW);
    expect(o1.account).toMatchObject({ id: 'acc1', label: 'One' });
    expect(o2.workers.map((w) => w.name)).toEqual(['api']);
    expect(o2.findings.every((f) => f.id.startsWith('acc2/'))).toBe(true);
    expect(o1.accountCount).toBe(2);

    const summary = await buildAccounts(e, NOW);
    expect(summary.map((a) => [a.id, a.workers])).toEqual([['acc1', 4], ['acc2', 1]]);
    expect(summary[0].findings.critical).toBeGreaterThan(0);
  });

  it('a scan resolves only its own account\'s findings', async () => {
    stub({ fleets: { acc2: ACC2 } });
    const e = env();
    await e.DB.batch([upsertAccount(e.DB, { id: 'acc1' }, NOW), upsertAccount(e.DB, { id: 'acc2' }, NOW)]);
    await runScan(e, NOW, { account: 'acc1' });
    const before = await e.DB.prepare(`SELECT COUNT(*) AS n FROM findings WHERE account = 'acc1' AND status = 'open'`).first<{ n: number }>();
    await runScan(e, new Date(NOW.getTime() + 3_600_000), { account: 'acc2' });
    const after = await e.DB.prepare(`SELECT COUNT(*) AS n FROM findings WHERE account = 'acc1' AND status = 'open'`).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('uses the label from Settings and a per-account plan', async () => {
    stub({ fleets: { acc2: ACC2 } });
    const e = env();
    await e.DB.batch([
      upsertAccount(e.DB, { id: 'acc1', name: 'Cloudflare name' }, NOW),
      setSettings(e.DB, { config: JSON.stringify({ version: 1, accounts: { acc1: { label: 'Client A', plan: 'paid' } } }) }),
    ]);
    const o = await buildOverview(e, 'acc1', NOW);
    expect(o.account).toMatchObject({ label: 'Client A', plan: 'paid' });
    expect(o.budget).toBeNull();
  });
});

describe('scheduler', () => {
  it('scans the most overdue account first, and a failing account does not block the others', async () => {
    stub({ fleets: { acc2: 'fail' } });
    const e = env();
    await e.DB.batch([
      setSettings(e.DB, { setup_done: '1' }),
      upsertAccount(e.DB, { id: 'acc1' }, NOW),
      upsertAccount(e.DB, { id: 'acc2' }, NOW),
      setAccountState(e.DB, 'acc1', { last_scan_at: '2026-11-09T09:00:00Z' }),
    ]);
    // acc2 has never been scanned, so it goes first, and fails.
    const first = await scheduledRun(e, NOW);
    expect(first?.account).toBe('acc2');
    expect('error' in first!.result).toBe(true);
    expect((await getAccountState(e.DB, 'acc2')).scan_failures).toBe('1');
    // Fifteen minutes later acc1 is the most overdue: the failure counted as an attempt.
    const second = await scheduledRun(e, new Date(NOW.getTime() + 15 * 60_000));
    expect(second?.account).toBe('acc1');
    expect('error' in second!.result).toBe(false);
    // Nothing is due right after.
    expect(await dueAccounts(e, new Date(NOW.getTime() + 20 * 60_000))).toEqual([]);
  });

  it('skips accounts that were switched off, and does nothing before setup', async () => {
    stub();
    const e = env();
    await upsertAccount(e.DB, { id: 'acc1', enabled: false }, NOW).run();
    expect(await scheduledRun(e, NOW)).toBeNull(); // setup not done
    await setSettings(e.DB, { setup_done: '1' }).run();
    expect(await dueAccounts(e, NOW)).toEqual([]);
  });

  it('CF_ACCOUNT_ID pins the accounts, comma-separated', async () => {
    stub({ fleets: { acc2: ACC2 } });
    const e = env({ CF_ACCOUNT_ID: 'acc2, acc1' });
    await setSettings(e.DB, { setup_done: '1' }).run();
    expect((await dueAccounts(e, NOW)).map((a) => a.id).sort()).toEqual(['acc1', 'acc2']);
  });

  it('a pre-multi-account install with no stored account watches the token\'s first account', async () => {
    stub();
    const e = env();
    await setSettings(e.DB, { setup_done: '1' }).run();
    expect((await dueAccounts(e, NOW)).map((a) => a.id)).toEqual(['acc1']);
    expect((await listAccounts(e.DB)).map((a) => a.id)).toEqual(['acc1']);
  });

  it('stretches the interval when one cron tick serves many accounts', () => {
    expect(effectiveIntervalMinutes(60, 2, false)).toBe(60);
    expect(effectiveIntervalMinutes(60, 8, false)).toBe(120);
    expect(effectiveIntervalMinutes(60, 8, true)).toBe(60);
  });
});
