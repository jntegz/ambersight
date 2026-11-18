// Sign-in limits, credential binding, API token life, account selection, cached views and the API
// boundary: what stops an attacker, and what keeps the operator in.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passphraseProblem } from '../src/shared/passphrase';
import { attemptKey, COOKIE, DEVICE_COOKIE, hashPassphrase, hasSession, login, sweepSignInState } from '../src/worker/auth';
import { setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { historyRetention } from '../src/worker/history';
import worker, { usageBuffer } from '../src/worker/index';
import { buildOverview } from '../src/worker/overview';
import { scheduledRun } from '../src/worker/scheduler';
import { checkToken } from '../src/worker/tokens';
import { createD1 } from './d1';
import { fakeFetch } from './fixtures';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = 'correct horse battery';
const NEXT = 'violet anchor quietly mends';
const T = Date.parse('2026-11-09T12:00:00Z');
const WINDOW = 15 * 60_000;
const ORIGIN = 'https://ambersight.example';
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  usageBuffer.reset();
});

const env = (over: Partial<Env> = {}): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS, ...over });
const pair = (cookie: string) => cookie.split(';')[0];

async function signIn(e: Env, passphrase = PASS, ip = '1.1.1.1') {
  const r = await login(e, passphrase, ip);
  if (!r.ok) throw new Error(r.error);
  return { session: pair(r.cookie), device: r.deviceCookie ? pair(r.deviceCookie) : '' };
}

const get = (e: Env, cookie: string, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }), e, ctx);
const send = (e: Env, cookie: string, path: string, body: unknown = {}, method = 'POST') =>
  worker.fetch(new Request(`${ORIGIN}${path}`, {
    method, body: JSON.stringify(body),
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
  }), e, ctx);
const bearer = (e: Env, token: string, path = '/api/health') => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${token}` } }), e, ctx);
const tokenWorks = (e: Env, token: string, now?: Date) => checkToken(e, `Bearer ${token}`, now);

const attemptRows = async (e: Env) => (await e.DB.prepare('SELECT ip, fails FROM login_attempts ORDER BY ip').all<{ ip: string; fails: number }>()).results;
const clientRows = async (e: Env) => (await attemptRows(e)).filter((r) => r.ip !== '#global');

/** Fills the current window so that sign-in is paused from time `at` on. */
const pause = async (e: Env, at = T) => {
  await e.DB.prepare(`INSERT INTO login_attempts (ip, fails, window_start, locked_until) VALUES ('#global', 50, ?1, 0)
    ON CONFLICT(ip) DO UPDATE SET fails = 50, window_start = ?1`).bind(at).run();
};

/** Records every SQL statement the worker sends to D1. */
function recordSql(e: Env) {
  const sql: string[] = [];
  const db = e.DB;
  const spied = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (q: string) => { sql.push(q); return target.prepare(q); };
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { env: { ...e, DB: spied }, sql };
}
const writes = (sql: string[]) => sql.filter((q) => !/^\s*SELECT/i.test(q));

describe('sign-in limits', () => {
  it('costs the same however many clients have been seen, with no sum over the table', async () => {
    const quiet = recordSql(env());
    await login(quiet.env, 'wrong', '9.9.9.1', T);
    const busy = recordSql(env());
    for (let i = 0; i < 300; i++) {
      await busy.env.DB.prepare('INSERT INTO login_attempts (ip, fails, window_start, locked_until) VALUES (?1, 1, ?2, 0)').bind(`10.0.${i >> 8}.${i & 255}`, T).run();
    }
    busy.sql.length = 0;
    await login(busy.env, 'wrong', '9.9.9.1', T);
    expect(busy.sql.length).toBe(quiet.sql.length);
    expect(busy.sql.join('\n')).not.toMatch(/SUM\(|COUNT\(/i);
    expect(busy.sql.join('\n')).not.toMatch(/DELETE FROM login_attempts WHERE window_start/);
  });

  it('refuses a locked client from one read, with no write', async () => {
    const e = env();
    for (let i = 0; i < 5; i++) await login(e, 'wrong', '6.6.6.6', T + i);
    const before = await attemptRows(e);
    const { env: spied, sql } = recordSql(e);
    expect(await login(spied, PASS, '6.6.6.6', T + 10)).toMatchObject({ ok: false, status: 429 });
    expect(writes(sql)).toEqual([]);
    expect(await attemptRows(e)).toEqual(before);
  });

  it('adds no client rows and writes nothing once the window is over the limit', async () => {
    const e = env();
    for (let i = 0; i < 50; i++) await login(e, 'wrong', `10.0.0.${i}`, T + i);
    expect(await clientRows(e)).toHaveLength(50);
    const { env: spied, sql } = recordSql(e);
    for (let i = 0; i < 20; i++) expect(await login(spied, 'wrong', `10.0.1.${i}`, T + 100 + i)).toMatchObject({ ok: false, status: 429 });
    expect(writes(sql)).toEqual([]);
    expect(await clientRows(e)).toHaveLength(50);
  });

  it('counts concurrent attempts from many addresses in one atomic row', async () => {
    const e = env();
    const rs = await Promise.all(Array.from({ length: 70 }, (_, i) => login(e, 'wrong', `10.0.2.${i}`, T)));
    expect(rs.filter((r) => !r.ok && r.status === 401)).toHaveLength(50);
    expect(await clientRows(e)).toHaveLength(50);
    expect((await attemptRows(e)).find((r) => r.ip === '#global')?.fails).toBe(70);
  });

  it('does not count a correct sign-in towards the pause', async () => {
    const e = env();
    for (let i = 0; i < 60; i++) expect((await login(e, PASS, '1.1.1.1', T + i)).ok).toBe(true);
    expect((await attemptRows(e)).find((r) => r.ip === '#global')?.fails).toBe(0);
  });

  it('ends the pause with the window, so refused attempts cannot extend it', async () => {
    const e = env();
    await pause(e);
    for (let i = 1; i < 5; i++) await login(e, 'wrong', `10.0.3.${i}`, T + i * 60_000);
    expect((await login(e, PASS, '1.1.1.1', T + WINDOW - 1)).ok).toBe(false);
    expect((await login(e, PASS, '1.1.1.1', T + WINDOW)).ok).toBe(true);
  });

  it('keys IPv6 clients by /64 and leaves IPv4 alone', () => {
    expect(attemptKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(attemptKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(attemptKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(attemptKey('::1')).toBe('0:0:0:0::/64');
    expect(attemptKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(attemptKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(attemptKey('192.0.2.1')).toBe('192.0.2.1');
    expect(attemptKey('unknown')).toBe('unknown');
  });

  it('locks a whole IPv6 /64 together', async () => {
    const e = env();
    for (let i = 0; i < 5; i++) await login(e, 'wrong', `2001:db8:1:2::${i + 1}`, T + i);
    expect(await login(e, PASS, '2001:db8:1:2:ffff::9', T + 10)).toMatchObject({ ok: false, status: 429 });
    expect((await login(e, PASS, '2001:db8:1:3::1', T + 11)).ok).toBe(true);
    expect(await clientRows(e)).toEqual([{ ip: '2001:db8:1:2::/64', fails: 5 }]);
  });

  it('removes expired attempts on the scheduled run, before setup and with no sign-in', async () => {
    const e = env();
    await login(e, 'wrong', '6.6.6.6', T);
    for (let i = 0; i < 5; i++) await login(e, 'wrong', '7.7.7.7', T + WINDOW - 5 + i);
    // 6.6.6.6 is past its window; 7.7.7.7 is locked; the window row itself has aged out too.
    expect(await scheduledRun(e, new Date(T + WINDOW + 1))).toBeNull();
    expect((await attemptRows(e)).map((r) => r.ip)).toEqual(['7.7.7.7']);
    await scheduledRun(e, new Date(T + 3 * WINDOW));
    expect(await attemptRows(e)).toEqual([]);
  });
});

describe('signing in during a pause', () => {
  it('lets a browser with a known-device marker in, and nobody else', async () => {
    const e = env();
    const { device } = await signIn(e);
    expect(device.startsWith(`${DEVICE_COOKIE}=`)).toBe(true);
    await e.DB.prepare('DELETE FROM login_attempts').run();
    await pause(e);
    expect(await login(e, PASS, '2.2.2.2', T + 1)).toMatchObject({ ok: false, status: 429 });
    expect(await login(e, PASS, '2.2.2.2', T + 2, { cookieHeader: `${DEVICE_COOKIE}=${'a'.repeat(64)}` })).toMatchObject({ ok: false, status: 429 });
    const ok = await login(e, PASS, '2.2.2.2', T + 3, { cookieHeader: device });
    expect(ok.ok).toBe(true);
    // A marker that worked is kept, not replaced.
    expect(ok.ok && ok.deviceCookie).toBeFalsy();
  });

  it('still applies the per-client limit to a known device', async () => {
    const e = env();
    const { device } = await signIn(e);
    await e.DB.prepare('DELETE FROM login_attempts').run();
    await pause(e);
    for (let i = 0; i < 5; i++) expect(await login(e, 'wrong', '2.2.2.2', T + i, { cookieHeader: device })).toMatchObject({ status: 401 });
    expect(await login(e, PASS, '2.2.2.2', T + 9, { cookieHeader: device })).toMatchObject({ ok: false, status: 429 });
  });

  it('accepts a passed Turnstile check during a pause, up to a cap on new rows', async () => {
    const e = env();
    await pause(e);
    expect((await login(e, PASS, '3.3.3.3', T + 1, { turnstilePassed: true })).ok).toBe(true);
    await e.DB.prepare(`UPDATE login_attempts SET fails = 200 WHERE ip = '#global'`).run();
    expect(await login(e, PASS, '3.3.3.4', T + 2, { turnstilePassed: true })).toMatchObject({ ok: false, status: 429 });
    expect(await clientRows(e)).toEqual([]);
  });

  it('stores only a digest of the marker, and keeps the table small', async () => {
    const e = env();
    let last = '';
    for (let i = 0; i < 14; i++) last = (await signIn(e)).device;
    const rows = (await e.DB.prepare('SELECT digest FROM known_devices').all<{ digest: string }>()).results;
    expect(rows).toHaveLength(10);
    expect(JSON.stringify(rows)).not.toContain(last.split('=')[1]);
  });

  it('drops expired markers on the scheduled sweep', async () => {
    const e = env();
    await signIn(e);
    await sweepSignInState(e.DB, Date.now() + 91 * 86_400_000);
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM known_devices').first('n')).toBe(0);
  });

  it('stops honouring markers when the credential changes', async () => {
    const e = env();
    const { device } = await signIn(e);
    const rotated = { ...e, ADMIN_PASSPHRASE: 'a different long secret' };
    await e.DB.prepare('DELETE FROM login_attempts').run();
    await pause(e);
    expect(await login(rotated, 'a different long secret', '2.2.2.2', T + 1, { cookieHeader: device })).toMatchObject({ ok: false, status: 429 });
  });

  it('still lets a session change the passphrase, under the per-client limit only', async () => {
    const e = env();
    const { session } = await signIn(e);
    await pause(e, Date.now());
    for (let i = 0; i < 5; i++) expect((await send(e, session, '/api/passphrase', { current: 'wrong', next: NEXT })).status).toBe(401);
    expect((await send(e, session, '/api/passphrase', { current: PASS, next: NEXT })).status).toBe(429);
    await e.DB.prepare(`DELETE FROM login_attempts WHERE ip LIKE 'passphrase:%'`).run();
    expect((await send(e, session, '/api/passphrase', { current: PASS, next: NEXT })).status).toBe(200);
  });

  it('keys the passphrase check by /64 too', async () => {
    const e = env();
    const { session } = await signIn(e);
    await worker.fetch(new Request(`${ORIGIN}/api/passphrase`, {
      method: 'POST', body: JSON.stringify({ current: 'wrong', next: NEXT }),
      headers: { Cookie: session, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '2001:db8:5:6::7' },
    }), e, ctx);
    expect(await clientRows(e)).toEqual([{ ip: 'passphrase:2001:db8:5:6::/64', fails: 1 }]);
  });
});

describe('credentials', () => {
  it('keeps sessions.cred from being a fast check of the secret', async () => {
    const e = env();
    await signIn(e);
    const { cred } = (await e.DB.prepare('SELECT cred FROM sessions').first<{ cred: string }>())!;
    const fast = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`env:${PASS}`))).toString('hex');
    expect(cred).not.toContain(fast);
    expect(cred.startsWith('secret$')).toBe(true);
    // A random salt per install: the same secret gives different values elsewhere.
    const other = env();
    await signIn(other);
    expect((await other.DB.prepare('SELECT cred FROM sessions').first<{ cred: string }>())!.cred).not.toBe(cred);
  });

  it('derives the slow value once per isolate, not once per request', async () => {
    const e = env({ ADMIN_PASSPHRASE: 'a secret only this test uses' });
    const { session } = await signIn(e, 'a secret only this test uses');
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    for (let i = 0; i < 5; i++) expect(await hasSession(e, session)).toBe(true);
    expect(derive).not.toHaveBeenCalled();
  });

  it('ends everything when the secret is replaced after a Settings passphrase was saved', async () => {
    const e = env();
    const { session } = await signIn(e);
    expect((await send(e, session, '/api/passphrase', { current: PASS, next: NEXT })).status).toBe(200);
    const again = await signIn(e, NEXT);
    expect(await hasSession(e, again.session)).toBe(true);

    const rotated = { ...e, ADMIN_PASSPHRASE: 'the replacement secret' };
    expect(await hasSession(rotated, again.session)).toBe(false);
    expect(await login(rotated, NEXT, '4.4.4.4')).toMatchObject({ ok: false, status: 401 });
    const fresh = await signIn(rotated, 'the replacement secret', '4.4.4.5');
    expect(await hasSession(rotated, fresh.session)).toBe(true);
    // The Settings passphrase is gone: putting the old secret back does not revive it.
    expect(await login(e, NEXT, '4.4.4.6')).toMatchObject({ ok: false, status: 401 });
    expect(await e.DB.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key IN ('passphrase_hash', 'passphrase_binding')`).first('n')).toBe(0);
  });

  it('keeps working while the secret stays the same', async () => {
    const e = env();
    const { session } = await signIn(e);
    await send(e, session, '/api/passphrase', { current: PASS, next: NEXT });
    expect(await login(e, PASS, '4.4.4.7')).toMatchObject({ ok: false, status: 401 });
    expect((await login(e, NEXT, '4.4.4.8')).ok).toBe(true);
  });

  it('honours a stored hash with no binding yet, and binds it at its next sign-in', async () => {
    const e = env();
    await setSettings(e.DB, { passphrase_hash: await hashPassphrase(NEXT) }).run();
    const first = await signIn(e, NEXT);
    expect(await e.DB.prepare(`SELECT value FROM settings WHERE key = 'passphrase_binding'`).first('value')).toBeTruthy();
    // Binding does not change the credential, so the session it just issued stays valid.
    expect(await hasSession(e, first.session)).toBe(true);
    expect(await hasSession({ ...e, ADMIN_PASSPHRASE: 'the replacement secret' }, first.session)).toBe(false);
  });

  it('honours a stored hash on an install with no secret at all', async () => {
    const e = env({ ADMIN_PASSPHRASE: '' });
    await setSettings(e.DB, { passphrase_hash: await hashPassphrase(NEXT) }).run();
    const { session } = await signIn(e, NEXT);
    expect(await hasSession(e, session)).toBe(true);
    expect(await e.DB.prepare(`SELECT value FROM settings WHERE key = 'passphrase_binding'`).first('value')).toBeNull();
    expect((await send(e, session, '/api/passphrase', { current: NEXT, next: 'pale harbor sings loudly' })).status).toBe(200);
    expect((await login(e, 'pale harbor sings loudly', '4.4.4.9')).ok).toBe(true);
  });

  it('refuses a short replacement secret once it is the credential', async () => {
    const e = env();
    const { session } = await signIn(e);
    await send(e, session, '/api/passphrase', { current: PASS, next: NEXT });
    expect(await login({ ...e, ADMIN_PASSPHRASE: 'short' }, 'short', '4.4.5.1')).toMatchObject({ ok: false, status: 500 });
  });

  it('ends existing sessions and gives existing tokens 90 days when migrating', async () => {
    const db = createD1({ stopBefore: '0014' });
    await db.prepare(`INSERT INTO sessions (id, expires_at, cred) VALUES ('s', '2099-01-01T00:00:00Z', 'old')`).run();
    await db.prepare(`INSERT INTO api_tokens (id, name, digest, hint, created_at) VALUES ('t', 'n', 'd', 'h', '2026-01-01T00:00:00Z')`).run();
    (db as unknown as { migrateFrom: (f: string) => void }).migrateFrom('0014');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(0);
    const row = (await db.prepare('SELECT expires_at, cred FROM api_tokens').first<{ expires_at: string; cred: string | null }>())!;
    expect(row.cred).toBeNull();
    expect(Math.round((Date.parse(row.expires_at) - Date.now()) / 86_400_000)).toBe(90);
  });
});

describe('API tokens', () => {
  async function withToken(body: Record<string, unknown> = {}) {
    const e = env();
    const { session } = await signIn(e);
    const res = await send(e, session, '/api/tokens', { name: 'Grafana', passphrase: PASS, accounts: 'all', ...body });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { token: string; info: { id: string; expiresAt: string } };
    return { e, session, token: r.token, info: r.info };
  }
  const listed = async (e: Env, session: string) => (await (await get(e, session, '/api/tokens')).json()) as { expired: boolean; invalidated: boolean; expiresAt: string }[];

  it('needs the passphrase again, under the per-client limit', async () => {
    const e = env();
    const { session } = await signIn(e);
    expect((await send(e, session, '/api/tokens', { name: 'x' })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await send(e, session, '/api/tokens', { name: 'x', passphrase: 'wrong' })).status).toBe(401);
    expect((await send(e, session, '/api/tokens', { name: 'x', passphrase: PASS })).status).toBe(429);
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first('n')).toBe(0);
  });

  it('lasts 90 days by default, or the 30 or 365 chosen, and nothing else', async () => {
    const days = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
    expect(days((await withToken()).info.expiresAt)).toBe(90);
    expect(days((await withToken({ days: 30 })).info.expiresAt)).toBe(30);
    expect(days((await withToken({ days: 365 })).info.expiresAt)).toBe(365);
    const e = env();
    const { session } = await signIn(e);
    expect((await send(e, session, '/api/tokens', { name: 'x', passphrase: PASS, days: 9999 })).status).toBe(400);
  });

  it('stops at its expiry, and says so in the list', async () => {
    const { e, session, token, info } = await withToken({ days: 30 });
    expect(await tokenWorks(e, token)).toBe(true);
    expect(await tokenWorks(e, token, new Date(Date.parse(info.expiresAt) + 1))).toBe(false);
    await e.DB.prepare('UPDATE api_tokens SET expires_at = ?1').bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await bearer(e, token, '/api/overview')).status).toBe(401);
    expect((await listed(e, session))[0]).toMatchObject({ expired: true, invalidated: false });
  });

  it('stops when the passphrase changes, and is flagged', async () => {
    const { e, session, token } = await withToken();
    expect((await send(e, session, '/api/passphrase', { current: PASS, next: NEXT })).status).toBe(200);
    expect(await tokenWorks(e, token)).toBe(false);
    const { session: fresh } = await signIn(e, NEXT);
    expect((await listed(e, fresh))[0]).toMatchObject({ invalidated: true });
  });

  it('stops when the secret is replaced or the stored hash is deleted, with no code run here', async () => {
    const { e, session, token } = await withToken();
    expect(await tokenWorks({ ...e, ADMIN_PASSPHRASE: 'the replacement secret' }, token)).toBe(false);
    await send(e, session, '/api/passphrase', { current: PASS, next: NEXT });
    const { session: fresh } = await signIn(e, NEXT);
    const second = (await (await send(e, fresh, '/api/tokens', { name: 'Two', passphrase: NEXT, accounts: 'all' })).json()) as { token: string };
    expect(await tokenWorks(e, second.token)).toBe(true);
    await e.DB.prepare(`DELETE FROM settings WHERE key = 'passphrase_hash'`).run();
    expect(await tokenWorks(e, second.token)).toBe(false);
  });

  it('binds a token from before this check at first use, then holds it to that credential', async () => {
    const { e, token } = await withToken();
    await e.DB.prepare('UPDATE api_tokens SET cred = NULL, expires_at = NULL').run();
    expect(await tokenWorks(e, token)).toBe(true);
    const row = (await e.DB.prepare('SELECT cred, expires_at FROM api_tokens').first<{ cred: string; expires_at: string }>())!;
    expect(row.cred).toBeTruthy();
    expect(row.expires_at).toBeTruthy();
    expect(await tokenWorks({ ...e, ADMIN_PASSPHRASE: 'the replacement secret' }, token)).toBe(false);
  });
});

describe('accounts and cached views', () => {
  async function watched() {
    const e = env();
    await upsertAccount(e.DB, { id: 'acc1', name: 'One' }, new Date('2026-01-01T00:00:00Z')).run();
    await upsertAccount(e.DB, { id: 'acc2', name: 'Two' }, new Date('2026-01-02T00:00:00Z')).run();
    await upsertAccount(e.DB, { id: 'off', name: 'Unticked', enabled: false }, new Date('2026-01-03T00:00:00Z')).run();
    await e.DB.prepare(`INSERT INTO workers (account, name, last_seen) VALUES ('acc1', 'api', '2026-11-09T12:00:00Z')`).run();
    const { session } = await signIn(e);
    return { e, session };
  }
  const cacheRows = async (e: Env) => (await e.DB.prepare('SELECT account, view FROM view_cache ORDER BY account, view').all<{ account: string; view: string }>()).results;

  it('refuses an unknown or unwatched account on every account route, with no data', async () => {
    const { e, session } = await watched();
    const routes = ['overview', 'analytics', 'workers/api', 'timeline', 'packages', 'resources', 'self-cost', 'findings', 'changes?since=2026-01-01T00:00:00Z', 'report'];
    for (const id of ['nope', 'off']) {
      for (const route of routes) {
        const res = await get(e, session, `/api/${route}${route.includes('?') ? '&' : '?'}account=${id}`);
        expect(res.status, route).toBe(404);
        expect(await res.json()).toEqual({ error: 'That account is not watched by this install.', code: 'unknown_account' });
      }
      expect((await send(e, session, '/api/scan', { account: id })).status).toBe(404);
    }
    expect(await cacheRows(e)).toEqual([]);
  });

  it('gives a named account its own data and only an unnamed request the default', async () => {
    const { e, session } = await watched();
    const name = async (path: string) => ((await (await get(e, session, path)).json()) as { account: { id: string } }).account.id;
    expect(await name('/api/overview')).toBe('acc1');
    expect(await name('/api/overview?account=acc2')).toBe('acc2');
    expect(await name('/api/overview?account=')).toBe('acc1');
    expect((await buildOverview(e, 'nope')).account).toBeNull();
  });

  it('stores one row per account and fixed view, whatever the query text', async () => {
    const { e, session } = await watched();
    for (const q of ['', '?account=acc1', '?x=1']) await get(e, session, `/api/overview${q}`);
    for (const d of ['7', '7.5', '8', '13.999', '14', '30', '31', '1e3', 'abc', '-1']) await get(e, session, `/api/timeline?days=${d}`);
    expect(await cacheRows(e)).toEqual([
      { account: 'acc1', view: 'overview' },
      { account: 'acc1', view: 'timeline-14' },
      { account: 'acc1', view: 'timeline-30' },
      { account: 'acc1', view: 'timeline-7' },
    ]);
  });

  it('caches a Worker page only for Workers in the inventory', async () => {
    const { e, session } = await watched();
    expect((await get(e, session, '/api/workers/api')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await get(e, session, `/api/workers/ghost-${i}`)).status).toBe(200);
    expect((await cacheRows(e)).map((r) => r.view)).toEqual(['worker-7d-api']);
  });

  it('drops cached views from earlier hours in the retention sweep, and keeps the current ones', async () => {
    const e = env();
    const now = new Date('2026-11-09T12:30:00Z');
    const put = (view: string, hour: string) => e.DB.prepare(`INSERT INTO view_cache (account, view, etag, body) VALUES ('a', ?1, ?2, '{}')`).bind(view, `W/"1.1.2.7.${hour}.abc"`).run();
    await put('overview', '2026-11-09T12');
    await put('timeline-14', '2026-11-09T11');
    await put('analytics-30d', '2026-10-01T00');
    await e.DB.batch(historyRetention(e.DB, 'a', now));
    expect((await cacheRows(e)).map((r) => r.view)).toEqual(['overview']);
  });
});

describe('the API boundary', () => {
  const raw = (e: Env, cookie: string, method: string, path: string, headers: Record<string, string>, body?: string) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { Cookie: cookie, ...headers }, body }), e, ctx);
  const JSON_TYPE = { 'Content-Type': 'application/json' };

  it('refuses a change that does not prove it came from this page', async () => {
    const e = env();
    const { session } = await signIn(e);
    const bulk = '{"action":"acknowledge","ids":["x"]}';
    const refused: [string, string, Record<string, string>][] = [
      ['POST', '/api/findings/bulk', { ...JSON_TYPE }], // no signal at all
      ['POST', '/api/findings/bulk', { ...JSON_TYPE, Origin: 'https://evil.example' }],
      ['POST', '/api/findings/bulk', { ...JSON_TYPE, 'Sec-Fetch-Site': 'same-site', Origin: 'https://evil.me.example' }],
      ['POST', '/api/findings/bulk', { ...JSON_TYPE, 'Sec-Fetch-Site': 'cross-site', Origin: ORIGIN }],
      ['POST', '/api/findings/bulk', { Origin: ORIGIN }], // no content type
      ['POST', '/api/findings/bulk', { Origin: ORIGIN, 'Content-Type': 'text/plain' }],
      ['POST', '/api/findings/bulk', { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }],
      ['PUT', '/api/config', { ...JSON_TYPE, Origin: 'https://evil.example' }],
      ['DELETE', '/api/tokens/x', { ...JSON_TYPE }],
      ['POST', '/api/login', { ...JSON_TYPE }],
      ['POST', '/api/logout', {}],
    ];
    for (const [method, path, headers] of refused) {
      expect((await raw(e, session, method, path, headers, method === 'DELETE' ? undefined : bulk)).status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
    }
  });

  it('accepts what the dashboard sends, including requests with no body', async () => {
    const e = env();
    const { session } = await signIn(e);
    const browser = { ...JSON_TYPE, 'Sec-Fetch-Site': 'same-origin' };
    expect((await raw(e, session, 'POST', '/api/findings/x/acknowledge', browser)).status).toBe(200);
    expect((await raw(e, session, 'POST', '/api/findings/x/acknowledge', { ...JSON_TYPE, Origin: ORIGIN })).status).toBe(200);
    expect((await raw(e, session, 'DELETE', '/api/tokens/none', { 'Content-Type': 'application/json; charset=utf-8', Origin: ORIGIN })).status).toBe(404);
    const out = await raw(e, session, 'POST', '/api/logout', browser);
    expect(out.status).toBe(200);
    expect(out.headers.get('Set-Cookie')).toContain(`${COOKIE}=;`);
  });

  it('sets both cookies at sign-in, with the attributes that keep them first-party', async () => {
    const e = env();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/login`, {
      method: 'POST', body: JSON.stringify({ passphrase: PASS }), headers: { ...JSON_TYPE, Origin: ORIGIN, 'CF-Connecting-IP': '1.1.1.1' },
    }), e, ctx);
    const cookies = res.headers.getSetCookie();
    expect(cookies.map((c) => c.split('=')[0])).toEqual([COOKIE, DEVICE_COOKIE]);
    for (const c of cookies) expect(c).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  });

  it('tells a missing session apart from a wrong passphrase, so the browser clears its data only for the first', async () => {
    const e = env();
    const gone = await get(e, '', '/api/overview');
    expect(gone.status).toBe(401);
    expect(await gone.json()).toMatchObject({ code: 'not_signed_in' });
    const { session } = await signIn(e);
    const wrong = await send(e, session, '/api/passphrase', { current: 'wrong', next: NEXT });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).not.toHaveProperty('code');
  });

  it('forbids framing of API responses and of the static shell', async () => {
    const e = env();
    const { session } = await signIn(e);
    await upsertAccount(e.DB, { id: 'acc1', name: 'One' }).run();
    const res = await get(e, session, '/api/health');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const report = await get(e, session, '/api/report?account=acc1');
    expect(report.headers.get('Content-Security-Policy')).toContain("style-src 'unsafe-inline'");
    const headers = readFileSync(new URL('../web/public/_headers', import.meta.url), 'utf8');
    expect(headers).toMatch(/^\/\*\r?\n\s+Content-Security-Policy: frame-ancestors 'none'/m);
    expect(headers).toContain('X-Frame-Options: DENY');
  });
});

describe('weak passphrases', () => {
  it('refuses short, common, repetitive and sequential ones', () => {
    for (const p of ['short', 'password1234', 'Password123!', 'PASSPHRASE-2026', 'aaaaaaaaaaaa', 'abcabcabcabc', 'adminadmin12', '123456789012', 'abcdefghijklm', 'qwertyuiopas', 'correct horse battery staple']) {
      expect(passphraseProblem(p), p).not.toBeNull();
    }
    for (const p of [PASS, NEXT, 'attacker passphrase', 'x7#Kq9!mZ2@v']) expect(passphraseProblem(p), p).toBeNull();
  });

  it('is enforced when changing the passphrase, without spending an attempt', async () => {
    const e = env();
    const { session } = await signIn(e);
    const res = await send(e, session, '/api/passphrase', { current: PASS, next: 'password1234' });
    expect(res.status).toBe(400);
    expect(await clientRows(e)).toEqual([]);
    expect(await e.DB.prepare(`SELECT value FROM settings WHERE key = 'passphrase_hash'`).first('value')).toBeNull();
  });

  it('holds first-time setup until a weak deploy passphrase is replaced', async () => {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const e = env({ ADMIN_PASSPHRASE: 'password1234' });
    const { session } = await signIn(e, 'password1234');
    const status = (await (await get(e, session, '/api/setup')).json()) as { passphraseWeak: boolean };
    expect(status.passphraseWeak).toBe(true);
    const res = await send(e, session, '/api/setup/complete', { timeZone: 'UTC' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('too easy to guess');
    expect((await send(e, session, '/api/setup/complete', { timeZone: 'UTC', replacePassphrase: { current: 'password1234', next: NEXT } })).status).toBe(200);
  });
});

describe('manual work limits', () => {
  async function ready(over: Partial<Env> = {}) {
    const f = fakeFetch({ fleets: { acc2: { workers: [], scripts: [] } } });
    vi.stubGlobal('fetch', f.fn);
    const e = env(over);
    await upsertAccount(e.DB, { id: 'acc1', name: 'One' }, new Date('2026-01-01T00:00:00Z')).run();
    await upsertAccount(e.DB, { id: 'acc2', name: 'Two' }, new Date('2026-01-02T00:00:00Z')).run();
    const { session } = await signIn(e);
    return { e, session, f };
  }
  const inventoryReads = (calls: string[], account: string) => calls.filter((c) => c.endsWith(`/accounts/${account}/workers/workers`)).length;

  it('skips a repeated scan of the same account, not of another one', async () => {
    const { e, session, f } = await ready();
    expect(((await (await send(e, session, '/api/scan', { account: 'acc1' })).json()) as { skipped?: boolean }).skipped).toBeUndefined();
    const reads = inventoryReads(f.calls, 'acc1');
    expect(await (await send(e, session, '/api/scan', { account: 'acc1' })).json()).toEqual({ skipped: true, workers: 0, findings: 0, subrequests: 0, warnings: [] });
    expect(inventoryReads(f.calls, 'acc1')).toBe(reads);
    expect(((await (await send(e, session, '/api/scan', { account: 'acc2' })).json()) as { skipped?: boolean }).skipped).toBeUndefined();
  });

  it('starts one scan for the first setup and none for a repeat', async () => {
    const { e, session, f } = await ready();
    const complete = () => send(e, session, '/api/setup/complete', { timeZone: 'UTC', accountIds: ['acc1'] });
    expect((await complete()).status).toBe(200);
    await Promise.allSettled(pending.splice(0));
    const reads = inventoryReads(f.calls, 'acc1');
    expect(reads).toBeGreaterThan(0);
    expect((await complete()).status).toBe(200);
    await Promise.allSettled(pending.splice(0));
    expect(inventoryReads(f.calls, 'acc1')).toBe(reads);
  });

  it('limits test messages per channel', async () => {
    const { e, session, f } = await ready({ WEBHOOK_URL: 'https://hooks.slack.com/services/x' });
    expect((await send(e, session, '/api/notify/test', { channel: 'webhook' })).status).toBe(200);
    expect((await send(e, session, '/api/notify/test', { channel: 'webhook' })).status).toBe(429);
    expect(f.calls.filter((c) => c.includes('hooks.slack.com'))).toHaveLength(1);
    // The other channel has its own limit: this one fails for not being configured, not for the cooldown.
    expect(((await (await send(e, session, '/api/notify/test', { channel: 'email' })).json()) as { error: string }).error).toContain('not configured');
  });
});
