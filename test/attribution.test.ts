// The install-level choice to record who made changes: what a scan keeps, what switching it off
// erases, and that findings do not move with it.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, parseConfig, type Config } from '../src/shared/config';
import type { TimelineEntry, WorkerDetail } from '../src/shared/types';
import { configChanges } from '../src/worker/adminLog';
import { continueErasure, ERASE_KEY, eraseAttribution, RESUMED_KEY } from '../src/worker/attribution';
import { login } from '../src/worker/auth';
import { getSettings, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import worker, { usageBuffer } from '../src/worker/index';
import { withoutPerson } from '../src/worker/redact';
import { runScan } from '../src/worker/scan';
import { scheduledRun } from '../src/worker/scheduler';
import { auditFindings } from '../src/worker/security';
import { createD1 } from './d1';
import { fakeFetch, NOW } from './fixtures';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const AUTHOR = 'ada.lovelace@example.test';
const ACTOR = 'grace.hopper@example.test';
const TOKEN_ACTOR = 'katherine-ci-token';
const MEMBER_ID = 'member-linus-0001';
const MEMBER_MAIL = 'linus@example.test';
const ALERT_MAIL = 'alan@example.test';
const SEEDS = [AUTHOR, ACTOR, TOKEN_ACTOR, MEMBER_ID, MEMBER_MAIL, ALERT_MAIL];

const PASS = 'correct horse battery';
const ORIGIN = 'https://ambersight.example';
const HOUR = 3_600_000;
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { 'Content-Type': 'application/json' } });

const deployment = (id: string, created: string, author: string, message: string) =>
  ({ id, created_on: created, source: 'wrangler', author_email: author, annotations: { 'workers/message': message } });

const AUDIT = [
  { id: 'ev-member', action: { type: 'create', description: `Added member ${MEMBER_MAIL}`, result: 'success', time: '2026-11-09T09:00:00Z' }, actor: { email: ACTOR, type: 'user' }, resource: { product: 'members', type: 'account.member', id: MEMBER_ID } },
  { id: 'ev-token', action: { type: 'create', description: `Token created by ${TOKEN_ACTOR}`, result: 'success', time: '2026-11-09T09:30:00Z' }, actor: { token_name: TOKEN_ACTOR, type: 'account' }, resource: { product: 'api_tokens', type: 'token', id: 'tok-9' } },
  { id: 'ev-script', action: { type: 'update', description: `Secret changed by ${ACTOR}`, result: 'success', time: '2026-11-09T11:00:00Z' }, actor: { email: ACTOR, type: 'user' }, resource: { product: 'workers', type: 'script', id: 'legacy' } },
];

/** The fixture fleet, plus an audit log, Cloudflare notifications and a deploy that name people. */
function cloudflare(over: { audit?: unknown[]; deployments?: unknown[]; onAudit?: () => Promise<void> } = {}) {
  const base = fakeFetch({ hourly: [{ scriptName: 'legacy', datetimeHour: '2026-11-09T11:00:00Z', requests: 5000, errors: 2500 }] });
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/logs/audit')) {
      await over.onAudit?.();
      return ok(over.audit ?? AUDIT);
    }
    if (url.pathname.endsWith('/alerting/v3/history')) return ok([{ id: 'al-1', sent: '2026-11-09T08:00:00Z', alert_type: 'x', name: 'Notice', description: `Sent to ${ALERT_MAIL}` }]);
    if (url.pathname.endsWith('/scripts/api/deployments')) return ok({ deployments: over.deployments ?? [deployment('dep-api-1', '2026-11-09T10:40:00Z', AUTHOR, `Hotfix by ${AUTHOR}`)] });
    return base.fn(input, init);
  };
  vi.stubGlobal('fetch', fn as typeof fetch);
}

function setup(): Env {
  return { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS };
}

async function scan(env: Env, now = NOW) {
  await upsertAccount(env.DB, { id: 'acc1', name: 'Test account' }, new Date('2026-11-01T00:00:00Z')).run();
  const r = await runScan(env, now, { account: 'acc1', force: true });
  expect('error' in r).toBe(false);
}

const setConfig = (env: Env, change: (c: Config) => void) => {
  const c = defaultConfig();
  change(c);
  return setSettings(env.DB, { config: JSON.stringify(c) }).run();
};

async function session(env: Env) {
  const r = await login(env, PASS, '1.1.1.1');
  if (!r.ok) throw new Error(r.error);
  return r.cookie.split(';')[0];
}
const put = (env: Env, cookie: string, body: unknown) => worker.fetch(new Request(`${ORIGIN}/api/config`, {
  method: 'PUT', body: JSON.stringify(body), headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
}), env, ctx);
const get = (env: Env, cookie: string, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }), env, ctx);
const turnOff = (env: Env, cookie: string) => put(env, cookie, { ...defaultConfig(), recordAttribution: false, confirmErase: true });
const turnOn = (env: Env, cookie: string) => put(env, cookie, { ...defaultConfig(), recordAttribution: true, confirmRecord: true });
const stored = async (env: Env) => JSON.parse((await getSettings(env.DB)).config) as Config;

/** Every row of every table, as text. */
async function everything(db: D1Database) {
  const { results } = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of results) out[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results;
  return JSON.stringify(out);
}
const namesIn = (text: string) => SEEDS.filter((s) => text.includes(s));

const findings = async (db: D1Database) => (await db.prepare('SELECT id, severity, status, message, first_seen FROM findings ORDER BY id').all()).results;
const eventCount = async (db: D1Database) => (await db.prepare('SELECT COUNT(*) AS n FROM finding_events').first<{ n: number }>())!.n;
const rev = async (db: D1Database) => (await getSettings(db)).data_rev;

const addDeployments = (env: Env, n: number) => env.DB.prepare(
  `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ?1)
   INSERT INTO deployments (account, script, id, created_on, author, message, source)
   SELECT 'acc1', 'api', 'bulk-' || i, '2026-11-09T01:00:00Z', ?2, 'routine', 'wrangler' FROM c`,
).bind(n, AUTHOR).run();
const named = async (db: D1Database) => (await db.prepare('SELECT COUNT(*) AS n FROM deployments WHERE author IS NOT NULL').first<{ n: number }>())!.n;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  usageBuffer.reset();
});

describe('a scan with recording off', () => {
  it('stores nothing that identifies a person, in any table, and keeps the rest of each row', async () => {
    const env = setup();
    cloudflare();
    await setConfig(env, (c) => { c.recordAttribution = false; });
    await scan(env);

    expect(namesIn(await everything(env.DB))).toEqual([]);
    const dep = await env.DB.prepare(`SELECT author, message, source FROM deployments WHERE id = 'dep-api-1'`).first();
    expect(dep).toEqual({ author: null, message: 'Hotfix by [person]', source: 'wrangler' });
    const audit = await env.DB.prepare('SELECT id, actor, description, resource_id FROM audit_events ORDER BY id').all();
    expect(audit.results).toEqual([
      { id: 'ev-member', actor: null, description: 'Added member [email]', resource_id: null },
      { id: 'ev-script', actor: null, description: 'Secret changed by [person]', resource_id: 'legacy' },
      { id: 'ev-token', actor: null, description: 'Token created by [person]', resource_id: 'tok-9' },
    ]);
  });

  it('still raises the checks that read the audit log, and the dashboard says names are not recorded', async () => {
    const env = setup();
    cloudflare();
    await setConfig(env, (c) => { c.recordAttribution = false; });
    await scan(env);

    const ids = (await findings(env.DB)).map((f) => f.id as string);
    expect(ids).toContain('acc1/security:*:member-change-ev-member');
    expect(ids).toContain('acc1/security:*:token-created-ev-token');
    const cookie = await session(env);
    const timeline = await (await get(env, cookie, '/api/timeline?account=acc1')).json() as TimelineEntry[];
    const deploy = timeline.find((e) => e.kind === 'deploy')!;
    expect(deploy).toMatchObject({ author: null, authorNotRecorded: true });
    expect(timeline.filter((e) => e.kind === 'audit').every((e) => e.author === null && e.authorNotRecorded)).toBe(true);
    const detail = await (await get(env, cookie, '/api/workers/api?account=acc1')).json() as WorkerDetail;
    expect(detail.recordsAttribution).toBe(false);
    expect(detail.deploys[0].author).toBeNull();
  });

  it('with recording on, everything is stored and shown as before', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    const stored = await everything(env.DB);
    for (const s of [AUTHOR, ACTOR, TOKEN_ACTOR, MEMBER_ID]) expect(stored).toContain(s);
    const cookie = await session(env);
    const timeline = await (await get(env, cookie, '/api/timeline?account=acc1')).json() as TimelineEntry[];
    expect(timeline.find((e) => e.kind === 'deploy')).toMatchObject({ author: AUTHOR });
    expect(timeline.some((e) => e.authorNotRecorded)).toBe(false);
  });
});

describe('turning recording off', () => {
  it('needs an explicit confirmation, and then erases every name and the cached views', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    const cookie = await session(env);
    await get(env, cookie, '/api/timeline?account=acc1');
    expect((await env.DB.prepare('SELECT body FROM view_cache').all<{ body: string }>()).results.some((r) => r.body.includes(AUTHOR))).toBe(true);
    const counts = async () => (await env.DB.prepare('SELECT (SELECT COUNT(*) FROM deployments) AS d, (SELECT COUNT(*) FROM audit_events) AS a, (SELECT COUNT(*) FROM findings) AS f').first());
    const before = await counts();
    const revBefore = await rev(env.DB);

    const refused = await put(env, cookie, { ...defaultConfig(), recordAttribution: false });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'confirm_erase' });
    expect((await everything(env.DB))).toContain(AUTHOR);

    const res = await turnOff(env, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recordAttribution: false, attributionErasure: 'done' });

    expect(namesIn(await everything(env.DB))).toEqual([]);
    expect(await counts()).toEqual(before);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM view_cache').first<{ n: number }>())!.n).toBe(0);
    expect(Number(await rev(env.DB))).toBeGreaterThan(Number(revBefore));
    expect(await env.DB.prepare(`SELECT message FROM deployments WHERE id = 'dep-api-1'`).first('message')).toBe('Hotfix by [person]');
    expect(await env.DB.prepare(`SELECT description FROM cf_alerts WHERE id = 'al-1'`).first('description')).toBe('Sent to [email]');
    const evidence = await env.DB.prepare(`SELECT evidence FROM findings WHERE code = 'member-change-ev-member'`).first<string>('evidence');
    expect(JSON.parse(evidence!)).toEqual({ action: 'create', at: '2026-11-09 09:00' });
  });

  it('is logged as a settings change, not as reduced detection', async () => {
    expect(configChanges(defaultConfig(), { ...defaultConfig(), recordAttribution: false })).toEqual({ reduced: [], other: ['recording who made changes turned off, stored names erased'] });
    const env = setup();
    cloudflare();
    await scan(env);
    await turnOff(env, await session(env));
    const log = (await env.DB.prepare(`SELECT action, target, notice FROM admin_events WHERE action LIKE 'config.%'`).all()).results;
    expect(log).toEqual([{ action: 'config.changed', target: 'recording who made changes turned off, stored names erased', notice: null }]);
  });

  it('keeps every finding as it was, with the same text, across off and on again', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    const first = await findings(env.DB);
    const events = await eventCount(env.DB);
    const context = await env.DB.prepare(`SELECT message, evidence FROM findings WHERE code = 'error-rate' AND script = 'legacy'`).first<{ message: string; evidence: string }>();
    expect(context!.message).toContain('Shortly before, "Secret changed by [person]" (audit log).');
    expect(JSON.parse(context!.evidence).changedBy).toBe(ACTOR);

    const cookie = await session(env);
    await turnOff(env, cookie);
    expect(await findings(env.DB)).toEqual(first);
    await scan(env);
    expect(await findings(env.DB)).toEqual(first);
    expect(JSON.parse((await env.DB.prepare(`SELECT evidence FROM findings WHERE code = 'error-rate' AND script = 'legacy'`).first<string>('evidence'))!).changedBy).toBeUndefined();

    expect((await turnOn(env, cookie)).status).toBe(200);
    await scan(env);
    expect(await findings(env.DB)).toEqual(first);
    expect(await eventCount(env.DB)).toBe(events);
  });

  it('works through a large history in rounds, and the cron finishes it', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    await addDeployments(env, 3500);
    const res = await turnOff(env, await session(env));
    expect(await res.json()).toMatchObject({ attributionErasure: 'running' });
    // Three rounds of 1,000, plus the one deploy whose message names its author, rewritten separately.
    expect(await named(env.DB)).toBe(500);
    expect((await getSettings(env.DB))[ERASE_KEY]).toBeTruthy();

    // Not finished, and then too soon for a late writer to be ruled out: the mark stays.
    await continueErasure(env.DB, NOW, await getSettings(env.DB));
    expect(await named(env.DB)).toBe(0);
    expect((await getSettings(env.DB))[ERASE_KEY]).toBeTruthy();

    await continueErasure(env.DB, later(1), await getSettings(env.DB));
    expect((await getSettings(env.DB))[ERASE_KEY]).toBeUndefined();
    expect(namesIn(await everything(env.DB))).toEqual([]);
  });

  it('is continued by the scheduled run', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    await addDeployments(env, 3500);
    await turnOff(env, await session(env));
    await setSettings(env.DB, { setup_done: '1' }).run();
    await scheduledRun(env, later(1));
    expect(await named(env.DB)).toBe(0);
    expect((await getSettings(env.DB))[ERASE_KEY]).toBeUndefined();
  });

  it('catches a scan that was already running when the switch was turned off', async () => {
    const env = setup();
    // The switch flips while the scan is under way, after it read its settings.
    cloudflare({ onAudit: async () => { await setConfig(env, (c) => { c.recordAttribution = false; }); } });
    await scan(env);
    expect(await everything(env.DB)).toContain(AUTHOR);
    const settings = await getSettings(env.DB);
    expect(settings[ERASE_KEY]).toBe(NOW.toISOString());
    await continueErasure(env.DB, later(1), settings);
    expect(namesIn(await everything(env.DB))).toEqual([]);
  });

  it('leaves text alone that only resembles an address or an actor type', async () => {
    expect(withoutPerson('Changed user settings', 'user')).toBe('Changed user settings');
    expect(withoutPerson('Changed @scope/pkg', null)).toBe('Changed @scope/pkg');
    expect(withoutPerson(`Rotated by ${TOKEN_ACTOR}`, TOKEN_ACTOR)).toBe('Rotated by [person]');
    const env = setup();
    await upsertAccount(env.DB, { id: 'acc1' }).run();
    await env.DB.prepare(`INSERT INTO audit_events (account, id, at, actor, description, product, resource_type, resource_id) VALUES ('acc1', 'e', 'x', 'user', 'Changed user settings of @scope', 'workers', 'script', 'api')`).run();
    expect(await eraseAttribution(env.DB, 3)).toBe(true);
    expect(await env.DB.prepare('SELECT actor, description, resource_id FROM audit_events').first()).toEqual({ actor: null, description: 'Changed user settings of @scope', resource_id: 'api' });
  });

  it('replaces a name only where it stands on its own', async () => {
    expect(withoutPerson('malice and alices, by alice.', 'alice')).toBe('malice and alices, by [person].');
    expect(withoutPerson('alice-bot ran', 'alice')).toBe('[person]-bot ran');
    expect(withoutPerson('Paid by a.b+c (a.b+c)', 'a.b+c')).toBe('Paid by [person] ([person])');
    expect(withoutPerson('Updated deploy settings', 'deploy')).toBe('Updated deploy settings');
    expect(withoutPerson('API token created', 'token')).toBe('API token created');
  });

  it('does the same to stored text, and still removes every name', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO deployments (account, script, id, created_on, author, message, source) VALUES ('acc1', 'api', 'dep-word', '2026-11-09T01:00:00Z', 'alice', 'Fix malice, by alice', 'wrangler')`),
      env.DB.prepare(`INSERT INTO deployments (account, script, id, created_on, author, message, source) VALUES ('acc1', 'api', 'dep-token', '2026-11-09T01:00:00Z', 'deploy', 'Updated deploy settings', 'wrangler')`),
      env.DB.prepare(`INSERT INTO audit_events (account, id, at, actor, description, product, resource_type, resource_id) VALUES ('acc1', 'ev-word', 'x', 'alice', 'Palace changed by alice', 'workers', 'script', 'api')`),
      env.DB.prepare(
        `UPDATE findings SET message = 'Malice: alice changed it',
           evidence = json_set(evidence, '$.changedBy', 'alice', '$.change', 'alice renamed palace')
         WHERE code = 'error-rate' AND script = 'legacy'`,
      ),
    ]);
    expect(await eraseAttribution(env.DB, 5)).toBe(true);

    expect(await env.DB.prepare(`SELECT author, message FROM deployments WHERE id = 'dep-word'`).first()).toEqual({ author: null, message: 'Fix malice, by [person]' });
    expect(await env.DB.prepare(`SELECT author, message FROM deployments WHERE id = 'dep-token'`).first()).toEqual({ author: null, message: 'Updated deploy settings' });
    expect(await env.DB.prepare(`SELECT actor, description FROM audit_events WHERE id = 'ev-word'`).first()).toEqual({ actor: null, description: 'Palace changed by [person]' });
    const f = await env.DB.prepare(`SELECT message, evidence FROM findings WHERE code = 'error-rate' AND script = 'legacy'`).first<{ message: string; evidence: string }>();
    expect(f!.message).toBe('Malice: [person] changed it');
    expect(JSON.parse(f!.evidence)).toMatchObject({ change: '[person] renamed palace' });
    expect(JSON.parse(f!.evidence).changedBy).toBeUndefined();
    expect(namesIn(await everything(env.DB))).toEqual([]);
  });

  it('leaves the security checks their keywords, with or without the name recorded', () => {
    const event = { id: 'e', at: '2026-11-09T09:00:00Z', action: 'create', product: 'iam', resourceType: 'thing', resourceId: 'x' };
    const codes = (description: string, actor: string | null) => auditFindings({ audit: [{ ...event, description, actor }] } as never).map((f) => f.code);
    expect(codes('token created', 'token')).toEqual(['token-created-e']);
    expect(codes('member invited', 'member')).toEqual(['member-change-e']);
    // A keyword that is only part of who did it says nothing about what was done.
    expect(codes('Rule added by token-bot', 'token-bot')).toEqual([]);
    expect(codes('Rule added by [person]', null)).toEqual([]);
  });
});

describe('a browser tab opened earlier', () => {
  it('cannot turn recording back on: its save goes through and recording stays off', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    const cookie = await session(env);
    const tabA = await (await get(env, cookie, '/api/config')).json() as Config;
    expect(tabA.recordAttribution).toBe(true);

    await turnOff(env, cookie); // tab B
    await continueErasure(env.DB, later(1), await getSettings(env.DB));
    expect((await getSettings(env.DB))[ERASE_KEY]).toBeUndefined();

    const res = await put(env, cookie, { ...tabA, mutedChecks: ['errors:error-rate'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recordAttribution: false, mutedChecks: ['errors:error-rate'] });
    expect(await stored(env)).toMatchObject({ recordAttribution: false, mutedChecks: ['errors:error-rate'] });
    expect((await getSettings(env.DB))[RESUMED_KEY]).toBeUndefined();
    const log = (await env.DB.prepare(`SELECT target FROM admin_events WHERE action = 'config.changed'`).all<{ target: string }>()).results;
    expect(log.some((e) => e.target.includes('turned on'))).toBe(false);

    await scan(env, later(2));
    expect(namesIn(await everything(env.DB))).toEqual([]);
  });

  it('holding "off" neither erases nor changes anything after recording was turned on elsewhere', async () => {
    const env = setup();
    cloudflare();
    const cookie = await session(env);
    await turnOff(env, cookie);
    const tabA = await (await get(env, cookie, '/api/config')).json() as Config;
    await turnOn(env, cookie); // tab B
    await scan(env);
    expect(await everything(env.DB)).toContain(TOKEN_ACTOR);

    // What a page that sends the old value gets: refused, as nobody confirmed erasing.
    const refused = await put(env, cookie, tabA);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'confirm_erase' });

    // What the dashboard sends: the setting is left out, so it stays on.
    const { recordAttribution: _, ...partial } = tabA;
    const res = await put(env, cookie, { ...partial, mutedChecks: ['errors:error-rate'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recordAttribution: true, mutedChecks: ['errors:error-rate'] });
    expect((await getSettings(env.DB))[ERASE_KEY]).toBeUndefined();
    expect(await everything(env.DB)).toContain(TOKEN_ACTOR);
  });

  it('ignores the confirmations where they do not apply', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    const cookie = await session(env);
    const res = await put(env, cookie, { ...defaultConfig(), confirmRecord: true, confirmErase: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recordAttribution: true });
    expect((await getSettings(env.DB))[RESUMED_KEY]).toBeUndefined();
    expect(await everything(env.DB)).toContain(AUTHOR);
  });
});

describe('turning recording on again', () => {
  it('needs an explicit confirmation, and notes when', async () => {
    const env = setup();
    cloudflare();
    const cookie = await session(env);
    await turnOff(env, cookie);
    expect(await (await put(env, cookie, defaultConfig())).json()).toMatchObject({ recordAttribution: false });
    expect(await (await turnOn(env, cookie)).json()).toMatchObject({ recordAttribution: true });
    expect((await getSettings(env.DB))[RESUMED_KEY]).toBe(NOW.toISOString());
  });

  it('does not bring back the author of a deploy whose row was deleted in the meantime', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    const cookie = await session(env);
    await turnOff(env, cookie);
    // What excluding a Worker does at the daily refresh.
    await env.DB.prepare(`DELETE FROM deployments WHERE script = 'api'`).run();
    vi.setSystemTime(later(1));
    await turnOn(env, cookie);

    const fresh = 'new.person@example.test';
    cloudflare({ deployments: [deployment('dep-api-1', '2026-11-09T10:40:00Z', AUTHOR, `Hotfix by ${AUTHOR}`), deployment('dep-api-2', later(2).toISOString(), fresh, 'Next')] });
    vi.setSystemTime(later(24));
    await scan(env, later(24));

    expect(await env.DB.prepare(`SELECT author, message FROM deployments WHERE id = 'dep-api-1'`).first()).toEqual({ author: null, message: 'Hotfix by [person]' });
    expect(await env.DB.prepare(`SELECT author FROM deployments WHERE id = 'dep-api-2'`).first('author')).toBe(fresh);
  });

  it('keeps the author of older deploys on an install that never turned it off', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    expect((await getSettings(env.DB))[RESUMED_KEY]).toBeUndefined();
    expect(await env.DB.prepare(`SELECT author FROM deployments WHERE id = 'dep-api-1'`).first('author')).toBe(AUTHOR);
  });

  it('collects from future scans only: erased names do not come back', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    const cookie = await session(env);
    await turnOff(env, cookie);
    const res = await turnOn(env, cookie);
    expect(res.status).toBe(200);
    expect((await getSettings(env.DB))[ERASE_KEY]).toBeUndefined();

    const fresh = 'new.person@example.test';
    cloudflare({
      deployments: [deployment('dep-api-1', '2026-11-09T10:40:00Z', AUTHOR, `Hotfix by ${AUTHOR}`), deployment('dep-api-2', '2026-11-10T10:00:00Z', fresh, 'Next')],
      audit: [...AUDIT, { id: 'ev-new', action: { type: 'update', description: 'Route changed', result: 'success', time: '2026-11-10T10:00:00Z' }, actor: { email: fresh, type: 'user' }, resource: { product: 'workers', type: 'route', id: 'r1' } }],
    });
    vi.setSystemTime(later(24));
    await scan(env, later(24));

    expect(namesIn(await everything(env.DB))).toEqual([]);
    expect(await env.DB.prepare(`SELECT author FROM deployments WHERE id = 'dep-api-2'`).first('author')).toBe(fresh);
    expect(await env.DB.prepare(`SELECT author FROM deployments WHERE id = 'dep-api-1'`).first('author')).toBeNull();
    expect(await env.DB.prepare(`SELECT actor FROM audit_events WHERE id = 'ev-new'`).first('actor')).toBe(fresh);
  });

  it('stores no name for a deploy older than the retention period, which Cloudflare may still list', async () => {
    const env = setup();
    cloudflare();
    await scan(env); // includes the daily clean-up, which the next scan does not repeat
    cloudflare({ deployments: [deployment('dep-old', '2026-09-01T10:00:00Z', AUTHOR, `Old by ${AUTHOR}`)] });
    await scan(env, later(7));
    expect(await env.DB.prepare(`SELECT author, message FROM deployments WHERE id = 'dep-old'`).first()).toEqual({ author: null, message: 'Old by [person]' });
  });

  it('waits until the erasing has finished', async () => {
    const env = setup();
    cloudflare();
    await scan(env);
    await addDeployments(env, 6500);
    const cookie = await session(env);
    await turnOff(env, cookie);
    const refused = await turnOn(env, cookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'erase_running' });
    expect((await (await get(env, cookie, '/api/config')).json() as Config).recordAttribution).toBe(false);
    expect((await getSettings(env.DB))[RESUMED_KEY]).toBeUndefined();
    expect((await turnOn(env, cookie)).status).toBe(200);
  });
});

describe('older settings', () => {
  it('default to recording, and a save that does not mention the setting leaves it alone', async () => {
    const { recordAttribution: _, ...old } = defaultConfig();
    expect(parseConfig(old).recordAttribution).toBe(true);
    expect(() => parseConfig({ ...old, recordAttribution: 'no' })).toThrow('recordAttribution');

    const env = setup();
    cloudflare();
    const cookie = await session(env);
    await turnOff(env, cookie);
    const res = await put(env, cookie, old);
    expect(res.status).toBe(200);
    expect((await res.json() as Config).recordAttribution).toBe(false);
  });
});
