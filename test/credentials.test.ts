// Credential changes and what depends on them: tokens from before credential marks, weak-passphrase
// rules for any script, setup with a replacement, PBKDF2 work per route, the Turnstile cap, failed
// account reads, and what a browser may keep.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passphraseProblem } from '../src/shared/passphrase';
import { hashPassphrase, login } from '../src/worker/auth';
import { setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import worker, { usageBuffer } from '../src/worker/index';
import { checkToken, listTokens } from '../src/worker/tokens';
import { createD1 } from './d1';
import { fakeFetch } from './fixtures';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = 'correct horse battery';
const NEXT = 'violet anchor quietly mends';
const ROTATED = 'the replacement secret';
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

async function signIn(e: Env, passphrase = PASS) {
  const r = await login(e, passphrase, '1.1.1.1');
  if (!r.ok) throw new Error(r.error);
  return r.cookie.split(';')[0];
}
const get = (e: Env, cookie: string, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie, ...headers } }), e, ctx);
const send = (e: Env, cookie: string, path: string, body: unknown = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
  }), e, ctx);
const works = (e: Env, token: string) => checkToken(e, `Bearer ${token}`);
const settled = () => Promise.allSettled(pending.splice(0));
const setting = (e: Env, key: string) => e.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first<string>('value');

/** An install just after the upgrade: two tokens with no credential mark, and no session. */
async function upgraded(over: Partial<Env> = {}) {
  const e = env(over);
  const cookie = await signIn(e, over.ADMIN_PASSPHRASE ?? PASS);
  const issue = async (name: string) => ((await (await send(e, cookie, '/api/tokens', { name, passphrase: over.ADMIN_PASSPHRASE ?? PASS, accounts: 'all' })).json()) as { token: string }).token;
  const tokens = [await issue('used'), await issue('idle')];
  await e.DB.batch([
    e.DB.prepare('UPDATE api_tokens SET cred = NULL, last_used_at = NULL'),
    e.DB.prepare('DELETE FROM sessions'),
    e.DB.prepare('DELETE FROM known_devices'),
  ]);
  return { e, used: tokens[0], idle: tokens[1] };
}
const marks = async (e: Env) => (await e.DB.prepare('SELECT cred FROM api_tokens ORDER BY name').all<{ cred: string | null }>()).results.map((r) => r.cred);

describe('tokens from before credential marks', () => {
  it('are tied to the credential by the first sign-in, even if never used', async () => {
    const { e, idle } = await upgraded();
    await signIn(e);
    const { cred } = (await e.DB.prepare('SELECT cred FROM sessions').first<{ cred: string }>())!;
    expect(await marks(e)).toEqual([cred, cred]);
    expect(await works(e, idle)).toBe(true);
    const rotated = { ...e, ADMIN_PASSPHRASE: ROTATED };
    expect(await works(rotated, idle)).toBe(false);
    await signIn(rotated, ROTATED);
    expect((await listTokens(rotated)).every((t) => t.invalidated)).toBe(true);
  });

  it('take the outgoing credential when the passphrase changes, so the change ends them', async () => {
    const e = env();
    const cookie = await signIn(e);
    const { token } = (await (await send(e, cookie, '/api/tokens', { name: 'old', passphrase: PASS, accounts: 'all' })).json()) as { token: string };
    const { cred: issued } = (await e.DB.prepare('SELECT cred FROM sessions').first<{ cred: string }>())!;
    await e.DB.prepare('UPDATE api_tokens SET cred = NULL').run();
    expect((await send(e, cookie, '/api/passphrase', { current: PASS, next: NEXT })).status).toBe(200);
    expect(await marks(e)).toEqual([issued]);
    expect(await works(e, token)).toBe(false);
    await signIn(e, NEXT);
    expect((await listTokens(e))[0].invalidated).toBe(true);
  });

  it('are all tied by the first use of any of them', async () => {
    const { e, used, idle } = await upgraded();
    expect(await works(e, used)).toBe(true);
    expect((await marks(e)).every(Boolean)).toBe(true);
    expect(await works({ ...e, ADMIN_PASSPHRASE: ROTATED }, idle)).toBe(false);
  });

  it('are tied by the scheduled run, with nobody signing in', async () => {
    const { e, idle } = await upgraded();
    await worker.scheduled({} as ScheduledController, e, ctx);
    await settled();
    expect((await marks(e)).every(Boolean)).toBe(true);
    expect(await works({ ...e, ADMIN_PASSPHRASE: ROTATED }, idle)).toBe(false);
  });

  it('costs the scheduled run no derivation when every token is tied', async () => {
    const e = env({ ADMIN_PASSPHRASE: 'a secret no other test derives' });
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    await worker.scheduled({} as ScheduledController, e, ctx);
    await settled();
    expect(derive).not.toHaveBeenCalled();
  });

  it('cannot be told apart if the secret was replaced before any of those: the known limit', async () => {
    const { e, idle } = await upgraded();
    const rotated = { ...e, ADMIN_PASSPHRASE: ROTATED };
    await signIn(rotated, ROTATED);
    expect(await works(rotated, idle)).toBe(true);
    expect(await works(e, idle)).toBe(false);
  });
});

describe('passphrase rules in any script', () => {
  it('accepts passphrases with few or no ASCII letters and digits', () => {
    for (const p of ['длинная секретная фраза', '!@#$%^&*()_+{}', '日本語のパスフレーズです123', '日本語のパスフレーズです1212']) expect(passphraseProblem(p), p).toBeNull();
  });

  it('still refuses weak ones', () => {
    for (const p of ['123456789012', 'abcdefghijklm', 'zyxwvutsrqpon', 'qwertyuiopas', 'abc-def-ghi-jkl', '1234-5678-9012', 'adminadmin12', 'abcabcabcabc', 'password1234', 'aaaaaaaaaaaa', 'ааааааааааааа']) {
      expect(passphraseProblem(p), p).not.toBeNull();
    }
  });
});

describe('finishing setup with a replacement passphrase', () => {
  const WEAK = 'password1234';
  async function wizard() {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const e = env({ ADMIN_PASSPHRASE: WEAK });
    return { e, cookie: await signIn(e, WEAK) };
  }
  const finish = (e: Env, cookie: string, replacePassphrase?: unknown) => send(e, cookie, '/api/setup/complete', { timeZone: 'UTC', replacePassphrase });

  it('leaves setup unfinished and the secret in place when the current passphrase is wrong', async () => {
    const { e, cookie } = await wizard();
    const res = await finish(e, cookie, { current: 'mistyped', next: NEXT });
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty('code');
    expect(await setting(e, 'setup_done')).toBeNull();
    expect(await setting(e, 'passphrase_hash')).toBeNull();
    expect((await login(e, WEAK, '2.2.2.2')).ok).toBe(true);
  });

  it('no longer accepts a bare promise to replace it, or a weak replacement', async () => {
    const { e, cookie } = await wizard();
    expect((await finish(e, cookie, true)).status).toBe(400);
    expect((await finish(e, cookie, { current: WEAK, next: 'password5678' })).status).toBe(400);
    expect(await setting(e, 'setup_done')).toBeNull();
    expect(await e.DB.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip LIKE 'passphrase:%'`).first('n')).toBe(0);
  });

  it('does both together, and signs everyone out', async () => {
    const { e, cookie } = await wizard();
    expect((await finish(e, cookie, { current: WEAK, next: NEXT })).status).toBe(200);
    expect(await setting(e, 'setup_done')).toBe('1');
    expect(await setting(e, 'passphrase_hash')).toBeTruthy();
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(0);
    expect((await login(e, WEAK, '2.2.2.2')).ok).toBe(false);
    expect((await login(e, NEXT, '2.2.2.3')).ok).toBe(true);
    expect(await e.DB.prepare(`SELECT COUNT(*) AS n FROM admin_events WHERE action = 'passphrase.changed'`).first('n')).toBe(1);
  });

  it('uses the same attempt limit as changing the passphrase', async () => {
    const { e, cookie } = await wizard();
    for (let i = 0; i < 5; i++) expect((await finish(e, cookie, { current: 'mistyped', next: NEXT })).status).toBe(401);
    expect((await finish(e, cookie, { current: WEAK, next: NEXT })).status).toBe(429);
    expect((await send(e, cookie, '/api/passphrase', { current: WEAK, next: NEXT })).status).toBe(429);
    expect(await setting(e, 'setup_done')).toBeNull();
  });
});

describe('PBKDF2 work per route', () => {
  const iterationsOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.reduce((sum, c) => sum + (c[0] as { iterations: number }).iterations, 0);

  it('changes a secret passphrase with one hash once the isolate is warm', async () => {
    const e = env({ ADMIN_PASSPHRASE: 'a warm secret for this test' });
    const cookie = await signIn(e, 'a warm secret for this test');
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    expect((await send(e, cookie, '/api/passphrase', { current: 'a warm secret for this test', next: NEXT })).status).toBe(200);
    expect(iterationsOf(derive)).toBe(50_000);
  });

  it('changes a Settings passphrase with one check and one hash once warm', async () => {
    const e = env({ ADMIN_PASSPHRASE: 'another warm secret here' });
    const first = await signIn(e, 'another warm secret here');
    await send(e, first, '/api/passphrase', { current: 'another warm secret here', next: NEXT });
    const cookie = await signIn(e, NEXT);
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    expect((await send(e, cookie, '/api/passphrase', { current: NEXT, next: 'pale harbor sings loudly' })).status).toBe(200);
    expect(iterationsOf(derive)).toBe(100_000);
  });

  it('does not compute a stored hash that no longer counts when the replaced secret signs in', async () => {
    const e = env({ ADMIN_PASSPHRASE: 'the secret that gets replaced' });
    const first = await signIn(e, 'the secret that gets replaced');
    await send(e, first, '/api/passphrase', { current: 'the secret that gets replaced', next: NEXT });
    const rotated = { ...e, ADMIN_PASSPHRASE: 'its replacement, long enough' };
    await signIn(rotated, 'its replacement, long enough');
    expect(await setting(e, 'passphrase_hash')).toBeNull();
    await setSettings(e.DB, { passphrase_hash: await hashPassphrase(NEXT), passphrase_binding: 'stale' }).run();
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    expect((await login(rotated, 'its replacement, long enough', '3.3.3.3')).ok).toBe(true);
    expect(iterationsOf(derive)).toBe(0);
  });
});

describe('the Turnstile cap', () => {
  it('refuses a passed check at 200 attempts in a window, and keeps a known browser in', async () => {
    const e = env();
    const first = await login(e, PASS, '1.1.1.1');
    const device = first.ok ? first.deviceCookie!.split(';')[0] : '';
    const now = Date.now();
    await e.DB.prepare(`INSERT INTO login_attempts (ip, fails, window_start, locked_until) VALUES ('#global', 200, ?1, 0)
      ON CONFLICT(ip) DO UPDATE SET fails = 200, window_start = ?1`).bind(now).run();
    expect(await login(e, PASS, '3.3.3.3', now + 1, { turnstilePassed: true })).toMatchObject({ ok: false, status: 429 });
    expect((await login(e, PASS, '3.3.3.4', now + 2, { turnstilePassed: true, cookieHeader: device })).ok).toBe(true);
  });
});

describe('a failed read of the watched accounts', () => {
  /** D1 whose reads of the accounts table fail, as during an outage. */
  const failingAccounts = (e: Env): Env => ({
    ...e,
    DB: new Proxy(e.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (q: string) => {
            if (/FROM accounts/i.test(q)) throw new Error('D1_ERROR: overloaded');
            return target.prepare(q);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }),
  });

  it('is a server error, not "unknown account", so the browser keeps its selection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = env();
    await upsertAccount(e.DB, { id: 'acc1', name: 'One' }).run();
    const cookie = await signIn(e);
    for (const path of ['/api/overview?account=acc1', '/api/timeline?account=acc1', '/api/overview']) {
      const res = await get(failingAccounts(e), cookie, path);
      expect(res.status, path).toBe(500);
      expect(await res.json(), path).not.toHaveProperty('code');
    }
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM view_cache').first('n')).toBe(0);
    expect((await get(e, cookie, '/api/overview?account=nope')).status).toBe(404);
  });
});

describe('what a browser may keep', () => {
  async function withToken() {
    const e = env();
    await upsertAccount(e.DB, { id: 'acc1', name: 'One' }).run();
    const cookie = await signIn(e);
    const { token } = (await (await send(e, cookie, '/api/tokens', { name: 'poller', passphrase: PASS, accounts: 'all' })).json()) as { token: string };
    return { e, cookie, auth: { Authorization: `Bearer ${token}` } };
  }

  it('sends signed-in views as no-store, with no validator and never a 304', async () => {
    const { e, cookie, auth } = await withToken();
    const etag = (await get(e, '', '/api/overview', auth)).headers.get('ETag')!;
    for (const path of ['/api/overview', '/api/timeline', '/api/analytics', '/api/accounts', '/api/resources']) {
      const res = await get(e, cookie, path, { 'If-None-Match': etag });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Cache-Control'), path).toBe('no-store');
      expect(res.headers.get('ETag'), path).toBeNull();
    }
    const repeat = await get(e, cookie, '/api/overview', { 'If-None-Match': '*' });
    expect(((await repeat.json()) as { account: { id: string } }).account.id).toBe('acc1');
  });

  it('marks the other signed-in routes no-store too', async () => {
    const { e, cookie } = await withToken();
    for (const path of ['/api/config', '/api/tokens', '/api/admin-events', '/api/findings', '/api/self-cost', '/api/report', '/api/session', '/api/workers/ghost']) {
      expect((await get(e, cookie, path)).headers.get('Cache-Control'), path).toBe('no-store');
    }
  });

  it('keeps the ETag and 304 for API tokens', async () => {
    const { e, auth } = await withToken();
    const first = await get(e, '', '/api/overview', auth);
    expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
    const again = await get(e, '', '/api/overview', { ...auth, 'If-None-Match': first.headers.get('ETag')! });
    expect(again.status).toBe(304);
  });
});
