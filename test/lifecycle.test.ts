// What happens to data when nobody scans it any more, what scope really limits, and the daily
// recheck of the Cloudflare token's permissions.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type Config } from '../src/shared/config';
import { EXPECTED_TOKEN_PERMISSIONS, TOKEN_PERMISSION_KEYS, TOKEN_TEMPLATE_URL, unexpectedPermissions } from '../src/shared/token';
import { buildWorkerDetail } from '../src/worker/analytics';
import { healthFindings } from '../src/worker/checks';
import { getSettings, setAccountState, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { runHousekeeping } from '../src/worker/lifecycle';
import { buildResources } from '../src/worker/resources';
import { runScan, tokenScopeState } from '../src/worker/scan';
import { scheduledRun } from '../src/worker/scheduler';
import { createD1 } from './d1';
import { fakeFetch, NOW, type FakeOptions } from './fixtures';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const env = (over: Partial<Env> = {}): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery', ...over });
const stub = (opts: FakeOptions = {}) => {
  const f = fakeFetch(opts);
  vi.stubGlobal('fetch', f.fn);
  return f;
};
const count = async (e: Env, table: string, where = '1') => (await e.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
const withConfig = (c: Partial<Config>) => JSON.stringify({ ...defaultConfig(), ...c });

afterEach(() => vi.unstubAllGlobals());

/** acc1 is watched and was just scanned; old is unticked and last scanned `lastScan` ago. */
async function twoAccounts(lastScanDays: number, config: Partial<Config> = {}) {
  const e = env();
  const db = e.DB;
  const scanned = ago(lastScanDays);
  await db.batch([
    upsertAccount(db, { id: 'acc1' }, NOW),
    upsertAccount(db, { id: 'old', name: 'Former client', enabled: false }, new Date(NOW.getTime() - 500 * DAY)),
    setSettings(db, { setup_done: '1', config: withConfig(config) }),
    setAccountState(db, 'acc1', { last_scan_at: NOW.toISOString() }),
    setAccountState(db, 'old', { last_scan_at: scanned, workers_subdomain: 'former' }),
    db.prepare(`INSERT INTO workers (account, name, last_seen) VALUES ('old', 'w', ?1), ('acc1', 'w', ?1)`).bind(scanned),
    db.prepare(`INSERT INTO deployments (account, script, id, created_on, author) VALUES ('old', 'w', 'd-old', ?1, 'someone@example.com'), ('old', 'w', 'd-new', ?2, 'someone@example.com'), ('acc1', 'w', 'd-old', ?1, 'me@example.com')`).bind(ago(40), ago(1)),
    db.prepare(`INSERT INTO audit_events (account, id, at, actor, action) VALUES ('old', 'a1', ?1, 'someone@example.com', 'x'), ('acc1', 'a1', ?1, 'me@example.com', 'x')`).bind(ago(40)),
    db.prepare(`INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
      VALUES ('old/open', 'old', 'w', 'errors', 'warning', 'e', 'm', '{}', 'a', ?1, ?1, 'open'), ('acc1/open', 'acc1', 'w', 'errors', 'warning', 'e', 'm', '{}', 'a', ?1, ?1, 'open')`).bind(scanned),
    db.prepare(`INSERT INTO metrics_daily (account, script, day, requests, errors, subrequests, cpu_time_us, exceeded) VALUES ('old', 'w', ?1, 1, 0, 0, 0, 0), ('old', 'w', ?2, 1, 0, 0, 0, 0)`).bind(ago(450).slice(0, 10), ago(100).slice(0, 10)),
  ]);
  return e;
}

const round = async (e: Env) => runHousekeeping(e, NOW, await getSettings(e.DB));

describe('retention for accounts that are no longer scanned', () => {
  it('ages out history by the same rules, and leaves watched accounts to their scans', async () => {
    const e = await twoAccounts(3);
    await round(e);
    expect(await count(e, 'deployments', `account = 'old'`)).toBe(1);
    expect(await count(e, 'audit_events', `account = 'old'`)).toBe(0);
    expect(await count(e, 'metrics_daily', `account = 'old'`)).toBe(1);
    // Scanned recently enough: what it last saw is still there.
    expect(await count(e, 'workers', `account = 'old'`)).toBe(1);
    expect(await count(e, 'findings', `account = 'old'`)).toBe(1);
    // The watched account is untouched: its own scan handles it.
    expect(await count(e, 'deployments', `account = 'acc1'`)).toBe(1);
    expect(await count(e, 'audit_events', `account = 'acc1'`)).toBe(1);
  });

  it('removes findings, inventory and state once the last scan is older than the retention period', async () => {
    const e = await twoAccounts(40);
    await round(e);
    for (const t of ['workers', 'findings', 'audit_events']) expect(await count(e, t, `account = 'old'`), t).toBe(0);
    const row = await e.DB.prepare(`SELECT name, enabled FROM accounts WHERE id = 'old'`).first();
    // Still recorded as switched off, so it is not picked up again, but no longer named.
    expect(row).toEqual({ name: null, enabled: 0 });
    expect(await e.DB.prepare(`SELECT key FROM account_state WHERE account = 'old'`).all()).toMatchObject({ results: [{ key: 'last_scan_at' }] });
    expect(await count(e, 'findings', `account = 'acc1'`)).toBe(1);
  });

  it('follows retentionDays', async () => {
    const e = await twoAccounts(40, { retentionDays: 90 });
    await round(e);
    expect(await count(e, 'workers', `account = 'old'`)).toBe(1);
    expect(await count(e, 'deployments', `account = 'old'`)).toBe(2);
  });

  it('treats an account outside CF_ACCOUNT_ID as not scanned, even if it was never unticked', async () => {
    const e = await twoAccounts(40);
    e.CF_ACCOUNT_ID = 'old';
    await e.DB.prepare(`UPDATE accounts SET enabled = 1`).run();
    await round(e);
    expect(await count(e, 'deployments', `account = 'acc1'`)).toBe(0);
    expect(await count(e, 'deployments', `account = 'old'`)).toBe(2);
  });

  it('runs once a day as one batch, without contacting Cloudflare', async () => {
    const e = await twoAccounts(40);
    const f = stub();
    let batches = 0;
    const batch = e.DB.batch.bind(e.DB);
    e.DB.batch = ((s: D1PreparedStatement[]) => (batches++, batch(s))) as typeof e.DB.batch;
    await round(e);
    expect(batches).toBe(1);
    expect(f.calls).toEqual([]);
    await runHousekeeping(e, new Date(NOW.getTime() + HOUR), await getSettings(e.DB));
    expect(batches).toBe(1);
    await runHousekeeping(e, new Date(NOW.getTime() + 25 * HOUR), await getSettings(e.DB));
    expect(batches).toBe(2);
  });

  it('is run by the cron, on a run with no scan due', async () => {
    const e = await twoAccounts(40);
    const f = stub();
    await scheduledRun(e, new Date(NOW.getTime() + 60_000));
    expect(f.calls).toEqual([]);
    expect(await count(e, 'workers', `account = 'old'`)).toBe(0);
  });

  it('also runs after a scan, and a failure in it does not touch the scan', async () => {
    const e = await twoAccounts(40);
    await setAccountState(e.DB, 'acc1', { last_scan_at: ago(1) }).run();
    stub();
    const batch = e.DB.batch.bind(e.DB);
    let fail = true;
    e.DB.batch = ((s: D1PreparedStatement[]) => (fail && s.length > 15 && !JSON.stringify(s).includes('INSERT INTO workers') ? Promise.reject(new Error('busy')) : batch(s))) as typeof e.DB.batch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await scheduledRun(e, NOW)).toMatchObject({ account: 'acc1', result: { workers: 4 } });
    expect((await getSettings(e.DB)).housekeeping_at).toBeUndefined();
    fail = false;
    await scheduledRun(e, new Date(NOW.getTime() + 60_000));
    expect((await getSettings(e.DB)).housekeeping_at).toBeDefined();
  });
});

describe('out-of-scope Workers', () => {
  const excluded = (c: Partial<Config['scope']>) => withConfig({ scope: { include: [], exclude: [], ...c } });

  async function scanned(exclude: string[], opts: FakeOptions = {}) {
    const e = env();
    await e.DB.batch([upsertAccount(e.DB, { id: 'acc1' }, NOW), setSettings(e.DB, { config: excluded({ exclude }) })]);
    const f = stub(opts);
    await runScan(e, NOW, { account: 'acc1' });
    return { e, f };
  }

  it('collects no deployments for them, whether excluded by name or by tag', async () => {
    for (const rule of ['api', 'group:client-a']) {
      const { e, f } = await scanned([rule]);
      expect(f.calls.filter((c) => c.includes('/scripts/api/deployments'))).toEqual([]);
      expect(await count(e, 'deployments', `script = 'api'`)).toBe(0);
    }
  });

  it('keeps only the storage bindings the account-wide checks need', async () => {
    const { e, f } = await scanned(['api']);
    expect(f.calls.some((c) => c.includes('/scripts/api/settings'))).toBe(true);
    const row = await e.DB.prepare(`SELECT bindings FROM workers WHERE name = 'api'`).first<{ bindings: string }>();
    expect(JSON.parse(row!.bindings)).toEqual([{ type: 'kv_namespace', name: 'CACHE', target: 'ns-used' }]);
    // The namespace it uses is not called a leftover, on the Resources page or in a finding.
    expect(await count(e, 'findings', `code LIKE 'unbound-kv-ns-used%'`)).toBe(0);
    const config = { ...defaultConfig(), scope: { include: [], exclude: ['api'] } };
    const view = await buildResources(e.DB, 'acc1', config);
    expect(JSON.stringify(view)).toContain('ns-used');
    expect(await count(e, 'findings', `script = 'api'`)).toBe(0);
  });

  it('still counts their schedules toward the account limit', async () => {
    const { f } = await scanned(['cron-job']);
    expect(f.calls.some((c) => c.includes('/scripts/cron-job/schedules'))).toBe(true);
  });

  it('removes deployments and full bindings stored before the exclusion', async () => {
    const e = env();
    await e.DB.batch([upsertAccount(e.DB, { id: 'acc1' }, NOW), setSettings(e.DB, { config: excluded({}) })]);
    stub();
    await runScan(e, NOW, { account: 'acc1' });
    expect(await count(e, 'deployments', `script = 'api'`)).toBe(1);
    expect((await e.DB.prepare(`SELECT bindings FROM workers WHERE name = 'api'`).first<{ bindings: string }>())!.bindings).toContain('AUTH');
    await setSettings(e.DB, { config: excluded({ exclude: ['api'] }) }).run();
    stub();
    await runScan(e, new Date(NOW.getTime() + 27 * HOUR), { account: 'acc1' });
    expect(await count(e, 'deployments', `script = 'api'`)).toBe(0);
    expect((await e.DB.prepare(`SELECT bindings FROM workers WHERE name = 'api'`).first<{ bindings: string }>())!.bindings).not.toContain('AUTH');
  });

  it('keeps a scan going by the last known tags when the Workers list fails', async () => {
    const e = env();
    await e.DB.batch([upsertAccount(e.DB, { id: 'acc1' }, NOW), setSettings(e.DB, { config: excluded({ exclude: ['group:client-a'] }) })]);
    stub();
    await runScan(e, NOW, { account: 'acc1' });
    const f = fakeFetch();
    vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) =>
      (String(input).endsWith('/workers/workers?page=1&per_page=100') ? Promise.resolve(new Response('{"success":false,"errors":[{"message":"down"}]}', { status: 500 })) : f.fn(input, init))) as typeof fetch);
    await e.DB.prepare(`UPDATE workers SET detail_checked_at = NULL`).run();
    await runScan(e, new Date(NOW.getTime() + HOUR), { account: 'acc1' });
    expect(f.calls.filter((c) => c.includes('/scripts/api/deployments'))).toEqual([]);
    expect((await e.DB.prepare(`SELECT tags FROM workers WHERE name = 'api'`).first<{ tags: string }>())!.tags).toBe('["client-a"]');
  });

  it('gives them no Worker page', async () => {
    const { e } = await scanned(['api'], { hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T10:00:00Z', requests: 5, errors: 0 }] });
    await e.DB.prepare(`INSERT INTO audit_events (account, id, at, actor, action, resource_id) VALUES ('acc1', 'x', ?1, 'someone@example.com', 'edit', 'api')`).bind(NOW.toISOString()).run();
    const d = await buildWorkerDetail(e, 'acc1', 'api', '7d', NOW);
    expect(d).toMatchObject({ exists: false, deploys: [], changes: [], bindings: null, handlers: [] });
    expect(d.totals.requests).toBe(0);
    expect((await buildWorkerDetail(e, 'acc1', 'legacy', '7d', NOW)).exists).toBe(true);
  });
});

describe('the token\'s permissions', () => {
  const scan = async (e: Env, tokenPolicies: FakeOptions['tokenPolicies'], at = NOW) => {
    stub({ tokenPolicies });
    return runScan(e, at, { account: 'acc1' });
  };
  const fresh = async () => {
    const e = env();
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    return e;
  };
  const scopeFindings = (e: Env) => e.DB.prepare(`SELECT code, severity, message FROM findings WHERE code LIKE 'token-scope%' AND status = 'open'`).all<{ code: string; severity: string; message: string }>();
  // The inventory refresh is due again: past its interval and the grace after it.
  const NEXT_DAY = new Date(NOW.getTime() + 27 * HOUR);

  it('compares with a list of what is expected, not with what names look like', () => {
    expect(unexpectedPermissions([...EXPECTED_TOKEN_PERMISSIONS])).toEqual([]);
    expect(unexpectedPermissions(['workers scripts read'])).toEqual([]);
    // Neither of these says "write" or "edit".
    expect(unexpectedPermissions(['Workers Scripts Manage', 'Logs Read', 'Workers Scripts Read'])).toEqual(['Workers Scripts Manage', 'Logs Read']);
    expect(tokenScopeState(['Workers Scripts Read'], {})).toEqual({ token_scope: 'ok', token_scope_unexpected: '[]' });
    expect(tokenScopeState(null, {})).toEqual({ token_scope: 'unverified', token_scope_unexpected: '[]' });
    expect(tokenScopeState([], {})).toMatchObject({ token_scope: 'unverified' });
    expect(tokenScopeState(null, { token_scope: 'unexpected' })).toEqual({});
  });

  it('raises a critical finding for an unexpected grant, until the grant is gone', async () => {
    const e = await fresh();
    await scan(e, [{ name: 'Workers Scripts Read' }, { name: 'Workers Scripts Write' }]);
    expect((await scopeFindings(e)).results).toMatchObject([{ code: 'token-scope', severity: 'critical' }]);
    expect((await scopeFindings(e)).results[0].message).toContain('Workers Scripts Write');
    await scan(e, [{ name: 'Workers Scripts Read' }], NEXT_DAY);
    expect((await scopeFindings(e)).results).toEqual([]);
  });

  it('says so when the permissions cannot be read, and does not forget a bad grant because of it', async () => {
    const e = await fresh();
    await scan(e, null);
    expect((await scopeFindings(e)).results).toMatchObject([{ code: 'token-scope-unverified', severity: 'info' }]);
    await scan(e, [{ name: 'Zone Edit' }], NEXT_DAY);
    await scan(e, null, new Date(NEXT_DAY.getTime() + 27 * HOUR));
    expect((await scopeFindings(e)).results).toMatchObject([{ code: 'token-scope', severity: 'critical' }]);
  });

  it('rereads them only with the inventory refresh', async () => {
    const e = await fresh();
    await scan(e, []);
    const f = stub({ tokenPolicies: [] });
    await runScan(e, new Date(NOW.getTime() + HOUR), { account: 'acc1' });
    expect(f.calls.filter((c) => c.includes('/user/tokens'))).toEqual([]);
  });

  it('keeps the finding with the rest of Ambersight\'s health findings', () => {
    const base = { now: NOW, plan: 'free' as const, accountRequestsToday: 0, workers: [], crons: null };
    expect(healthFindings({ ...base, tokenScope: { state: 'unexpected', permissions: ['Zone Edit'] } })[0]).toMatchObject({ id: 'health:*:token-scope', severity: 'critical' });
    expect(healthFindings({ ...base, tokenScope: null })).toEqual([]);
  });
});

describe('the token template', () => {
  it('asks only for what the default features use, the same everywhere', () => {
    expect(TOKEN_PERMISSION_KEYS).not.toContain('access');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { cloudflare: { bindings: { CF_API_TOKEN: { description: string } } } };
    expect(pkg.cloudflare.bindings.CF_API_TOKEN.description).toContain(TOKEN_TEMPLATE_URL.replace(' ', '%20'));
    expect(readFileSync('README.md', 'utf8')).toContain(TOKEN_TEMPLATE_URL);
  });

  it('does not expect the optional Access permission to be missing', () => {
    expect(unexpectedPermissions(['Access: Apps and Policies Read', 'Notifications Read'])).toEqual([]);
  });
});
