// E-mailed sign-in links: only to the operators, once, briefly, only in the browser that asked, and
// a link session confirms nothing sensitive while passkeys exist.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { afterEach, describe, expect, it } from 'vitest';
import { login, readSession, sweepSignInState } from '../src/worker/auth';
import { setSettings } from '../src/worker/db';
import type { EmailBinding, Env } from '../src/worker/env';
import worker, { usageBuffer } from '../src/worker/index';
import { confirmLink, requestLink } from '../src/worker/signinLink';
import { createD1 } from './d1';
import { SoftPasskey } from './webauthn';

const PASS = 'correct horse battery';
const ORIGIN = 'https://ambersight.example';
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  usageBuffer.reset();
});

type Mail = Parameters<EmailBinding['send']>[0];
function env(over: Partial<Env> = {}) {
  const sent: Mail[] = [];
  const e: Env = {
    DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS,
    EMAIL_FROM: 'ambersight@example.com', DIGEST_TO: 'me@example.com, client@example.com',
    EMAIL: { send: async (m) => void sent.push(m) },
    ...over,
  };
  return { e, sent };
}

const pair = (cookie: string) => cookie.split(';')[0];
const send = (e: Env, cookie: string, path: string, body: unknown = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
  }), e, ctx);
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const tokenIn = (m: Mail) => /#\/link\/([a-f0-9]{64})/.exec(m.text ?? '')![1];

/** Asks for a link the way the sign-in page does. Returns the browser's cookie and the token from the mail. */
async function ask(e: Env, sent: Mail[]) {
  const r = await send(e, '', '/api/login/link');
  expect(r.status).toBe(200);
  return { browser: pair(r.headers.getSetCookie()[0]), token: tokenIn(sent.at(-1)!) };
}

describe('asking for a sign-in link', () => {
  it('mails the operators only, with the token in the fragment and no address taken from the request', async () => {
    const { e, sent } = env();
    await e.DB.batch([setSettings(e.DB, { config: JSON.stringify({ accounts: { a1: { digestTo: ['client@example.com'] } } }) })]);
    const r = await send(e, '', '/api/login/link', { to: 'attacker@evil.example' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['me@example.com']);
    expect(sent[0].text).toContain(`${ORIGIN}/#/link/`);
    expect(sent[0].text).toContain('203.0.113.9');
    expect(r.headers.getSetCookie()[0]).toMatch(/^__Host-as_link=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=600$/);
    // Only digests are stored.
    const row = await e.DB.prepare('SELECT digest, browser FROM signin_links').first<{ digest: string; browser: string }>();
    expect(row!.digest).not.toBe(tokenIn(sent[0]));
    expect(row!.browser).not.toBe(r.headers.getSetCookie()[0].split(/[=;]/)[1]);
  });

  it('is off without e-mail', async () => {
    const { e } = env({ EMAIL: undefined });
    expect((await send(e, '', '/api/login/link')).status).toBe(409);
    expect(await json(await worker.fetch(new Request(`${ORIGIN}/api/session`), e, ctx))).toMatchObject({ signIn: { link: false } });
  });

  it('sends at most one a minute and five an hour, install-wide', async () => {
    const { e, sent } = env();
    const T = Date.parse('2026-11-24T10:00:00Z');
    expect(await requestLink(e, ORIGIN, '1.1.1.1', T)).toMatchObject({ ok: true });
    expect(await requestLink(e, ORIGIN, '2.2.2.2', T + 30_000)).toMatchObject({ ok: false, status: 429 });
    for (let i = 1; i < 5; i++) expect(await requestLink(e, ORIGIN, `10.0.0.${i}`, T + i * 61_000)).toMatchObject({ ok: true });
    expect(await requestLink(e, ORIGIN, '10.0.1.1', T + 6 * 61_000)).toMatchObject({ ok: false, status: 429, error: expect.stringMatching(/Five links/) });
    // The scheduled sweep keeps the hour's count.
    await sweepSignInState(e.DB, T + 20 * 60_000);
    expect(await requestLink(e, ORIGIN, '10.0.1.2', T + 21 * 60_000)).toMatchObject({ ok: false, status: 429 });
    expect(await requestLink(e, ORIGIN, '10.0.1.3', T + 61 * 60_000)).toMatchObject({ ok: true });
    expect(sent).toHaveLength(6);
  });

  it('sends at most two an hour to one client, before spending the install-wide allowance', async () => {
    const { e, sent } = env();
    const T = Date.parse('2026-11-24T10:00:00Z');
    expect(await requestLink(e, ORIGIN, '1.1.1.1', T)).toMatchObject({ ok: true });
    expect(await requestLink(e, ORIGIN, '1.1.1.1', T + 61_000)).toMatchObject({ ok: true });
    for (let i = 2; i < 6; i++) {
      expect(await requestLink(e, ORIGIN, '1.1.1.1', T + i * 61_000)).toMatchObject({ ok: false, status: 429, error: expect.stringMatching(/from this address/) });
    }
    // One IPv6 /64 counts as one client.
    expect(await requestLink(e, ORIGIN, '2001:db8:1:2::1', T + 7 * 61_000)).toMatchObject({ ok: true });
    expect(await requestLink(e, ORIGIN, '2001:db8:1:2::2', T + 8 * 61_000)).toMatchObject({ ok: true });
    expect(await requestLink(e, ORIGIN, '2001:db8:1:2:ffff::3', T + 9 * 61_000)).toMatchObject({ ok: false, status: 429, error: expect.stringMatching(/from this address/) });
    // The refused requests did not spend the install's hour: another client still gets its link.
    expect(await requestLink(e, ORIGIN, '3.3.3.3', T + 10 * 61_000)).toMatchObject({ ok: true });
    expect(sent).toHaveLength(5);
  });

  it('does not end a link someone else asked for', async () => {
    const { e, sent } = env();
    const T = Date.parse('2026-11-24T10:00:00Z');
    const operator = await requestLink(e, ORIGIN, '1.1.1.1', T);
    if (!operator.ok) throw new Error(operator.error);
    const token = tokenIn(sent[0]);
    expect(await requestLink(e, ORIGIN, '6.6.6.6', T + 61_000)).toMatchObject({ ok: true });
    expect(await confirmLink(e, token, pair(operator.cookie), T + 2 * 61_000)).toMatchObject({ ok: true });
  });

  it('keeps no link when the mail cannot be sent', async () => {
    const { e } = env({ EMAIL: { send: async () => { throw new Error('quota'); } } });
    expect((await send(e, '', '/api/login/link')).status).toBe(502);
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM signin_links').first('n')).toBe(0);
  });
});

describe('using a sign-in link', () => {
  it('signs in the browser that asked, once, for a day', async () => {
    const { e, sent } = env();
    const { browser, token } = await ask(e, sent);
    const r = await send(e, browser, '/api/login/link/confirm', { token });
    expect(r.status).toBe(200);
    const [clear, session] = r.headers.getSetCookie();
    expect(clear).toMatch(/^__Host-as_link=; .*Max-Age=0$/);
    expect(session).toMatch(/Max-Age=86400$/);
    expect(await readSession(e, pair(session))).toMatchObject({ method: 'link' });
    expect(await json(await send(e, browser, '/api/login/link/confirm', { token }))).toMatchObject({ error: expect.stringMatching(/used or expired/) });
  });

  it('is refused in another browser, and is then spent for the right one too', async () => {
    const { e, sent } = env();
    const { browser, token } = await ask(e, sent);
    expect(await json(await send(e, '', '/api/login/link/confirm', { token }))).toMatchObject({ error: expect.stringMatching(/only works in the browser/) });
    expect((await send(e, browser, '/api/login/link/confirm', { token })).status).toBe(401);
  });

  it('is refused with a browser cookie from another request', async () => {
    const { e, sent } = env();
    const first = await ask(e, sent);
    await e.DB.prepare(`DELETE FROM settings WHERE key = 'cooldown:signin-link'`).run();
    const second = await ask(e, sent);
    // The second link does not work with the first request's cookie, and is spent by trying.
    expect(await json(await send(e, first.browser, '/api/login/link/confirm', { token: second.token }))).toMatchObject({ error: expect.stringMatching(/only works in the browser/) });
    expect((await send(e, second.browser, '/api/login/link/confirm', { token: second.token })).status).toBe(401);
    // The first link was not ended by the second request.
    expect((await send(e, first.browser, '/api/login/link/confirm', { token: first.token })).status).toBe(200);
  });

  it('expires after ten minutes', async () => {
    const { e, sent } = env();
    const T = Date.now();
    const asked = await requestLink(e, ORIGIN, '1.1.1.1', T);
    if (!asked.ok) throw new Error(asked.error);
    expect(await confirmLink(e, tokenIn(sent[0]), pair(asked.cookie), T + 10 * 60_000 + 1)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses malformed tokens without a lookup', async () => {
    const { e } = env();
    for (const token of [undefined, 42, 'x', 'A'.repeat(64), `${'a'.repeat(64)}'`]) {
      expect((await send(e, '', '/api/login/link/confirm', { token })).status).toBe(401);
    }
  });
});

describe('a link session', () => {
  it('needs the passphrase to add the first passkey, even while fresh, and confirms nothing with passkeys present', async () => {
    const { e, sent } = env();
    const { browser, token } = await ask(e, sent);
    const session = pair((await send(e, browser, '/api/login/link/confirm', { token })).headers.getSetCookie()[1]);
    const key = await SoftPasskey.make(ORIGIN);
    // Reading the operators' mail is not enough to add a passkey, which would turn the passphrase off.
    const options = await json(await send(e, session, '/api/passkeys/options', { purpose: 'register' }));
    expect(await json(await send(e, session, '/api/passkeys', { response: await key.create(options as never) }))).toMatchObject({ code: 'passphrase_required' });
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM passkeys').first('n')).toBe(0);
    expect(await json(await send(e, session, '/api/passkeys', { response: await key.create(options as never), passphrase: 'wrong passphrase!' }))).toMatchObject({ error: expect.stringMatching(/wrong/) });
    const again = await json(await send(e, session, '/api/passkeys/options', { purpose: 'register' }));
    expect((await send(e, session, '/api/passkeys', { response: await key.create(again as never), passphrase: PASS })).status).toBe(200);

    expect(await json(await send(e, session, '/api/tokens', { name: 'x', accounts: 'all' }))).toMatchObject({ code: 'passkey_required' });
    const second = await SoftPasskey.make(ORIGIN, -8);
    const more = await json(await send(e, session, '/api/passkeys/options', { purpose: 'register' }));
    expect(await json(await send(e, session, '/api/passkeys', { response: await second.create(more as never) }))).toMatchObject({ code: 'passkey_required' });
    expect(await json(await send(e, session, '/api/sessions/end-others'))).toMatchObject({ code: 'passkey_required' });
  });

  it('still signs in while passkeys exist, as the fallback', async () => {
    const { e, sent } = env();
    const first = await login(e, PASS, '1.1.1.1');
    if (!first.ok) throw new Error(first.error);
    const key = await SoftPasskey.make(ORIGIN);
    const options = await json(await send(e, pair(first.cookie), '/api/passkeys/options', { purpose: 'register' }));
    await send(e, pair(first.cookie), '/api/passkeys', { response: await key.create(options as never) });
    const { browser, token } = await ask(e, sent);
    expect((await send(e, browser, '/api/login/link/confirm', { token })).status).toBe(200);
  });

  it('expired links are swept by the scheduled run', async () => {
    const { e, sent } = env();
    await ask(e, sent);
    await sweepSignInState(e.DB, Date.now() + 11 * 60_000);
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM signin_links').first('n')).toBe(0);
  });
});
