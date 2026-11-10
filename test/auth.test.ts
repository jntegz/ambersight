// Sign-in: per-IP lockout, account-wide cap, minimum secret length.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { COOKIE, hashPassphrase, hasSession, login } from '../src/worker/auth';
import { setSettings } from '../src/worker/db';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';
import { createD1 } from './d1';
import { timingSafeEqual } from 'node:crypto';

// Workers add timingSafeEqual to crypto.subtle; Node keeps it in node:crypto.
const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const T = Date.parse('2026-11-09T12:00:00Z');
const env = (over: Partial<Env> = {}): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery', ...over });

describe('login', () => {
  it('signs in with the right passphrase', async () => {
    const r = await login(env(), 'correct horse battery', '1.1.1.1', T);
    expect(r.ok).toBe(true);
  });

  it('locks only the IP that failed five times, for 15 minutes', async () => {
    const e = env();
    for (let i = 0; i < 5; i++) expect((await login(e, 'wrong', '6.6.6.6', T + i)).ok).toBe(false);
    const locked = await login(e, 'correct horse battery', '6.6.6.6', T + 10);
    expect(locked).toMatchObject({ ok: false, status: 429 });
    // The owner, from another address, still gets in.
    expect((await login(e, 'correct horse battery', '1.1.1.1', T + 20)).ok).toBe(true);
    // And the locked address can try again after 15 minutes.
    expect((await login(e, 'correct horse battery', '6.6.6.6', T + 15 * 60_000 + 11)).ok).toBe(true);
  });

  it('pauses sign-in for everyone after 50 failures from many addresses', async () => {
    const e = env();
    for (let i = 0; i < 50; i++) await login(e, 'wrong', `10.0.0.${i}`, T + i);
    expect(await login(e, 'correct horse battery', '1.1.1.1', T + 100)).toMatchObject({ ok: false, status: 429 });
    expect((await login(e, 'correct horse battery', '1.1.1.1', T + 15 * 60_000 + 100)).ok).toBe(true);
  });

  it('counts concurrent wrong attempts, so a burst gets no more than five guesses', async () => {
    const e = env();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => login(e, 'wrong', '6.6.6.6', T + i)));
    expect(rs.filter((r) => !r.ok && r.status === 401).length).toBeLessThanOrEqual(5);
    expect(await login(e, 'correct horse battery', '6.6.6.6', T + 100)).toMatchObject({ ok: false, status: 429 });
  });

  it('refuses a short ADMIN_PASSPHRASE secret and says how to fix it', async () => {
    const r = await login(env({ ADMIN_PASSPHRASE: 'password' }), 'password', '1.1.1.1', T);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(!r.ok && r.error).toContain('wrangler secret put ADMIN_PASSPHRASE');
  });
});

describe('sessions', () => {
  const cookieOf = (r: Awaited<ReturnType<typeof login>>) => (r.ok ? r.cookie.split(';')[0] : '');

  it('uses a __Host- cookie and stores only a digest of the session id', async () => {
    const e = env();
    const r = await login(e, 'correct horse battery', '1.1.1.1');
    const cookie = cookieOf(r);
    expect(cookie.startsWith('__Host-as_session=')).toBe(true);
    expect(await hasSession(e, cookie)).toBe(true);
    const row = await e.DB.prepare('SELECT id FROM sessions').first<{ id: string }>();
    expect(cookie.endsWith(row!.id)).toBe(false);
    expect(await hasSession(e, `${COOKIE}=${row!.id}`)).toBe(false);
  });

  it('signs sessions out when the passphrase secret is rotated', async () => {
    const e = env();
    const cookie = cookieOf(await login(e, 'correct horse battery', '1.1.1.1'));
    expect(await hasSession(e, cookie)).toBe(true);
    expect(await hasSession({ ...e, ADMIN_PASSPHRASE: 'a different long secret' }, cookie)).toBe(false);
  });

  it('signs sessions out when the stored passphrase hash is removed', async () => {
    const e = env();
    await setSettings(e.DB, { passphrase_hash: await hashPassphrase('stored passphrase 1') }).run();
    const cookie = cookieOf(await login(e, 'stored passphrase 1', '1.1.1.1'));
    expect(await hasSession(e, cookie)).toBe(true);
    await e.DB.prepare("DELETE FROM settings WHERE key = 'passphrase_hash'").run();
    expect(await hasSession(e, cookie)).toBe(false);
  });
});

describe('API request checks', () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const signedIn = async () => {
    const e = env();
    const r = await login(e, 'correct horse battery', '1.1.1.1');
    return { e, cookie: r.ok ? r.cookie.split(';')[0] : '' };
  };

  it('refuses a cross-origin form-style POST that carries the session cookie', async () => {
    const { e, cookie } = await signedIn();
    const res = await worker.fetch(new Request('https://ambersight.me.workers.dev/api/findings/bulk', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.me.workers.dev', 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'text/plain' },
      body: '{"action":"acknowledge","ids":["x"]}',
    }), e, ctx);
    expect(res.status).toBe(403);
  });

  it('still accepts the dashboard\'s own JSON requests', async () => {
    const { e, cookie } = await signedIn();
    const res = await worker.fetch(new Request('https://ambersight.me.workers.dev/api/findings/bulk', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://ambersight.me.workers.dev', 'Content-Type': 'application/json' },
      body: '{"action":"acknowledge","ids":["x"]}',
    }), e, ctx);
    expect(res.status).toBe(200);
  });

  it('limits guesses of the current passphrase when changing it', async () => {
    const { e, cookie } = await signedIn();
    const change = () => worker.fetch(new Request('https://ambersight.me.workers.dev/api/passphrase', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'CF-Connecting-IP': '6.6.6.6' },
      body: JSON.stringify({ current: 'wrong guess', next: 'attacker passphrase' }),
    }), e, ctx);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await change()).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});
