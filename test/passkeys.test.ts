// Passkeys: the verifier refuses what it must, and the dashboard's rules around them hold. The first
// passkey turns the passphrase off, a replaced secret recovers once, sensitive steps need a passkey
// answer for this session, and removing one ends what it signed in.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { login, readSession, sessionDigest } from '../src/worker/auth';
import type { Env } from '../src/worker/env';
import worker, { usageBuffer } from '../src/worker/index';
import { assertionOptions, confirmWithPasskey, issueChallenge, passkeySignIn } from '../src/worker/passkeys';
import { decodeCbor, derToRaw, relyingPartyOf, WebAuthnError } from '../src/worker/webauthn';
import { createD1 } from './d1';
import { fakeFetch } from './fixtures';
import { cbor, SoftPasskey, type TestAlg } from './webauthn';

const PASS = 'correct horse battery';
const ORIGIN = 'https://ambersight.example';
const RP = relyingPartyOf(ORIGIN);
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  vi.unstubAllGlobals();
  usageBuffer.reset();
});

const env = (over: Partial<Env> = {}): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS, ...over });
const pair = (cookie: string) => cookie.split(';')[0];

async function signIn(e: Env, passphrase = PASS) {
  const r = await login(e, passphrase, '1.1.1.1');
  if (!r.ok) throw new Error(r.error);
  return pair(r.cookie);
}

const send = (e: Env, cookie: string, path: string, body: unknown = {}, origin = ORIGIN) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
  }), e, ctx);
const get = (e: Env, cookie: string, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }), e, ctx);
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const cookieFrom = (r: Response, name: string) => r.headers.getSetCookie().map(pair).find((c) => c.startsWith(`${name}=`)) ?? '';

/** Registers a new passkey through the API, with whatever proof the session needs. */
async function addPasskey(e: Env, session: string, key: SoftPasskey, proof: Record<string, unknown> = {}, name = 'Laptop') {
  const options = (await json(await send(e, session, '/api/passkeys/options', { purpose: 'register' }))) as never;
  return send(e, session, '/api/passkeys', { response: await key.create(options), name, ...proof });
}

/** A passkey answer confirming a step for this session. */
async function confirmation(e: Env, session: string, key: SoftPasskey) {
  const options = (await json(await send(e, session, '/api/passkeys/options', { purpose: 'confirm' }))) as never;
  return key.get(options);
}

async function passkeyLogin(e: Env, key: SoftPasskey) {
  const options = (await json(await send(e, '', '/api/login/passkey/options'))) as never;
  return send(e, '', '/api/login/passkey', { response: await key.get(options) });
}

/** An install with one passkey, added by a fresh passphrase session. */
async function withPasskey(alg: TestAlg = -7, counter = 0) {
  const e = env();
  const session = await signIn(e);
  const key = await SoftPasskey.make(ORIGIN, alg, counter);
  const r = await addPasskey(e, session, key);
  expect(r.status).toBe(200);
  return { e, session, key };
}

describe('the WebAuthn parser', () => {
  it('reads definite CBOR and refuses indefinite lengths, floats, tags and deep nesting', () => {
    expect(decodeCbor(cbor(new Map<number, string | Uint8Array>([[1, 'a'], [-2, Uint8Array.of(1, 2)]]))).value).toEqual(new Map<unknown, unknown>([[1, 'a'], [-2, Uint8Array.of(1, 2)]]));
    for (const bad of [[0x5f, 0x41, 0x00, 0xff], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0], [0xc0, 0x00], [0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x00], [0x42, 0x00]]) {
      expect(() => decodeCbor(Uint8Array.from(bad))).toThrow(WebAuthnError);
    }
    // Duplicate map keys are refused rather than resolved one way or the other.
    expect(() => decodeCbor(Uint8Array.of(0xa2, 0x01, 0x01, 0x01, 0x02))).toThrow(WebAuthnError);
  });

  it('turns DER signatures into r||s and refuses non-minimal or trailing encodings', () => {
    const r = new Uint8Array(32).fill(0x80);
    const s = Uint8Array.of(...new Array(31).fill(0), 7);
    const der = Uint8Array.of(0x30, 2 + 33 + 2 + 1, 0x02, 33, 0, ...r, 0x02, 1, 7);
    expect(derToRaw(der)).toEqual(Uint8Array.of(...r, ...s));
    expect(derToRaw(Uint8Array.of(0x30, 6, 0x02, 2, 0, 1, 0x02, 1, 7))).toBeNull(); // 0x00 0x01: not minimal
    expect(derToRaw(Uint8Array.of(...der, 0))).toBeNull();
    expect(derToRaw(Uint8Array.of(0x30, 6, 0x02, 1, 0x81, 0x02, 1, 7))).toBeNull(); // negative
  });
});

describe('adding and signing in with a passkey', () => {
  for (const [alg, label] of [[-7, 'ES256'], [-8, 'Ed25519'], [-257, 'RS256']] as const) {
    it(`registers and signs in with ${label}`, async () => {
      const { e, key } = await withPasskey(alg);
      const r = await passkeyLogin(e, key);
      expect(r.status).toBe(200);
      const session = await readSession(e, cookieFrom(r, '__Host-as_session'));
      expect(session).toMatchObject({ method: 'passkey', passkey: key.id });
      expect(r.headers.getSetCookie()[0]).toMatch(/HttpOnly; Secure; SameSite=Strict; Max-Age=604800$/);
    });
  }

  it('stores a public key only, and lists passkeys without it', async () => {
    const { e, session, key } = await withPasskey();
    const row = await e.DB.prepare('SELECT * FROM passkeys').first<Record<string, string>>();
    expect(JSON.parse(row!.public_key)).not.toHaveProperty('d');
    const list = await json(await get(e, session, '/api/passkeys'));
    expect(list.passkeys).toEqual([expect.objectContaining({ id: key.id, name: 'Laptop', current: false })]);
    expect(JSON.stringify(list)).not.toContain(row!.public_key);
  });

  it('refuses a registration without user verification, from another origin, or for another relying party', async () => {
    const e = env();
    const session = await signIn(e);
    const key = await SoftPasskey.make(ORIGIN);
    const register = async (k: Parameters<SoftPasskey['create']>[1]) => {
      const options = (await json(await send(e, session, '/api/passkeys/options', { purpose: 'register' }))) as never;
      return send(e, session, '/api/passkeys', { response: await key.create(options, k) });
    };
    expect(await json(await register({ userVerified: false }))).toMatchObject({ error: expect.stringMatching(/did not verify you/) });
    expect(await json(await register({ userPresent: false }))).toMatchObject({ error: expect.stringMatching(/present/) });
    expect(await json(await register({ origin: 'https://evil.example' }))).toMatchObject({ error: expect.stringMatching(/different site/) });
    expect(await json(await register({ rpId: 'evil.example' }))).toMatchObject({ error: expect.stringMatching(/different site/) });
    expect(await json(await register({ crossOrigin: true }))).toMatchObject({ error: expect.stringMatching(/different site/) });
    expect(await json(await register({ type: 'webauthn.get' }))).toMatchObject({ error: expect.stringMatching(/different step/) });
    expect((await register({ challenge: 'AAAA' })).status).toBe(401);
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM passkeys').first('n')).toBe(0);
  });

  it('refuses a registration challenge issued to another session', async () => {
    const e = env();
    const mine = await signIn(e);
    const theirs = await signIn(e);
    const key = await SoftPasskey.make(ORIGIN);
    const options = (await json(await send(e, theirs, '/api/passkeys/options', { purpose: 'register' }))) as never;
    const r = await send(e, mine, '/api/passkeys', { response: await key.create(options) });
    expect(r.status).toBe(401);
  });

  it('refuses a sign-in answer that is replayed, tampered, unknown, unverified or for another site', async () => {
    const { e, key } = await withPasskey();
    const options = (await json(await send(e, '', '/api/login/passkey/options'))) as { challenge: string; rpId: string; allowCredentials: unknown[] };
    // No credential IDs before sign-in: the page names no passkey.
    expect(options.allowCredentials).toEqual([]);
    const answer = await key.get(options);
    expect((await send(e, '', '/api/login/passkey', { response: answer })).status).toBe(200);
    expect(await json(await send(e, '', '/api/login/passkey', { response: answer }))).toMatchObject({ error: expect.stringMatching(/already used/) });

    const fresh = async (k: Parameters<SoftPasskey['get']>[1]) => {
      const o = (await json(await send(e, '', '/api/login/passkey/options'))) as never;
      return send(e, '', '/api/login/passkey', { response: await key.get(o, k) });
    };
    expect(await json(await fresh({ badSignature: true }))).toMatchObject({ error: expect.stringMatching(/signature/) });
    expect((await fresh({ userVerified: false })).status).toBe(401);
    expect((await fresh({ origin: 'https://ambersight.example.evil.example' })).status).toBe(401);
    expect((await fresh({ rpId: 'example' })).status).toBe(401);
    expect((await fresh({ userHandle: null })).status).toBe(401);
    expect((await fresh({ userHandle: 'AAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(401);
    const stranger = await SoftPasskey.make(ORIGIN);
    const o = (await json(await send(e, '', '/api/login/passkey/options'))) as never;
    expect(await json(await send(e, '', '/api/login/passkey', { response: await stranger.get(o) }))).toMatchObject({ error: expect.stringMatching(/not registered/) });
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE method = ?1').bind('passkey').first('n')).toBe(1);
  });

  it('refuses an expired challenge, and a step-up challenge at sign-in', async () => {
    const { e, session, key } = await withPasskey();
    const old = { challenge: await issueChallenge(e.DB, 'signin', '', Date.now() - 6 * 60_000), rpId: RP.id };
    expect(await passkeySignIn(e, await key.get(old), RP)).toMatchObject({ ok: false, status: 401 });
    const stepUp = await confirmation(e, session, key);
    expect(await json(await send(e, '', '/api/login/passkey', { response: stepUp }))).toMatchObject({ error: expect.stringMatching(/expired or is not for this step/) });
  });

  it('refuses a passkey whose counter goes backwards', async () => {
    const { e, key } = await withPasskey(-7, 5);
    expect((await passkeyLogin(e, key)).status).toBe(200);
    const o = (await json(await send(e, '', '/api/login/passkey/options'))) as never;
    const r = await send(e, '', '/api/login/passkey', { response: await key.get(o, { counter: 3 }) });
    expect(await json(r)).toMatchObject({ error: expect.stringMatching(/counter went backwards/) });
  });

  it('writes nothing when a sign-in challenge is asked for', async () => {
    const { e } = await withPasskey();
    const before = await e.DB.prepare('SELECT (SELECT COUNT(*) FROM webauthn_used) + (SELECT COUNT(*) FROM settings) AS n').first('n');
    for (let i = 0; i < 20; i++) await send(e, '', '/api/login/passkey/options');
    expect(await e.DB.prepare('SELECT (SELECT COUNT(*) FROM webauthn_used) + (SELECT COUNT(*) FROM settings) AS n').first('n')).toBe(before);
  });
});

describe('the first passkey', () => {
  it('can be added by a session that signed in minutes ago, and turns the passphrase off', async () => {
    const e = env();
    const other = await signIn(e);
    const mine = await signIn(e);
    await e.DB.prepare('INSERT INTO known_devices (digest, cred, expires_at) VALUES (?1, ?2, ?3)').bind('d', 'x', Date.now() + 1e9).run();
    const r = await addPasskey(e, mine, await SoftPasskey.make(ORIGIN));
    expect(await json(r)).toMatchObject({ first: true });
    // Every other session, signed in with the passphrase, is over; this one stays.
    expect(await readSession(e, other)).toBeNull();
    expect(await readSession(e, mine)).not.toBeNull();
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM known_devices').first('n')).toBe(0);

    const attempts = () => e.DB.prepare('SELECT ip, fails FROM login_attempts ORDER BY ip').all();
    const before = await attempts();
    const refused = await login(e, PASS, '7.7.7.7');
    expect(refused).toMatchObject({ ok: false, status: 403 });
    // Refused before the passphrase is looked at: no attempt counted, nothing learned.
    expect(await login(e, 'wrong', '7.7.7.7')).toEqual(refused);
    expect(await attempts()).toEqual(before);
    const http = await send(e, '', '/api/login', { passphrase: PASS });
    expect(await json(http)).toMatchObject({ code: 'passphrase_locked' });
  });

  it('needs the passphrase from a session that is no longer fresh', async () => {
    const e = env();
    const session = await signIn(e);
    await e.DB.prepare('UPDATE sessions SET created_at = ?1').bind(Date.now() - 11 * 60_000).run();
    const key = await SoftPasskey.make(ORIGIN);
    expect(await json(await addPasskey(e, session, key))).toMatchObject({ code: 'passphrase_required' });
    expect((await addPasskey(e, session, key, { passphrase: 'wrong wrong wrong' })).status).toBe(401);
    expect((await addPasskey(e, session, key, { passphrase: PASS })).status).toBe(200);
  });

  it('tells the operators, and the sign-in page only that passkeys are in use', async () => {
    const { e } = await withPasskey();
    expect(await e.DB.prepare(`SELECT action, target, notice FROM admin_events WHERE action = 'passkey.added'`).first()).toMatchObject({ target: '"Laptop", passphrase sign-in turned off', notice: expect.any(String) });
    const s = await json(await get(e, '', '/api/session'));
    expect(s).toEqual({ authenticated: false, turnstileSiteKey: null, signIn: { passkeys: true, link: false } });
  });
});

describe('sensitive steps with passkeys', () => {
  it('need a passkey answer made for this session; the passphrase no longer counts', async () => {
    const { e, session, key } = await withPasskey();
    const create = (proof: Record<string, unknown>) => send(e, session, '/api/tokens', { name: 'ci', accounts: 'all', ...proof });
    expect(await json(await create({ passphrase: PASS }))).toMatchObject({ code: 'passkey_required' });
    const answer = await confirmation(e, session, key);
    expect((await create({ passkey: answer })).status).toBe(200);
    // One answer confirms one step.
    expect(await json(await create({ passkey: answer }))).toMatchObject({ error: expect.stringMatching(/already used/) });

    const other = pair((await passkeyLogin(e, key)).headers.getSetCookie()[0]);
    const theirs = await confirmation(e, other, key);
    expect((await create({ passkey: theirs })).status).toBe(401);
  });

  it('a sign-in answer cannot confirm a step', async () => {
    const { e, session, key } = await withPasskey();
    const signInAnswer = await key.get((await json(await send(e, '', '/api/login/passkey/options'))) as never);
    const s = await readSession(e, session);
    expect(await confirmWithPasskey(e, signInAnswer, RP, s!)).toMatchObject({ ok: false, status: 401 });
  });

  it('adding a second passkey needs one of the first', async () => {
    const { e, session, key } = await withPasskey();
    const second = await SoftPasskey.make(ORIGIN, -8);
    expect(await json(await addPasskey(e, session, second))).toMatchObject({ code: 'passkey_required' });
    expect((await addPasskey(e, session, second, { passkey: await confirmation(e, session, key) }, 'Phone')).status).toBe(200);
    expect((await passkeyLogin(e, second)).status).toBe(200);
  });

  it('the passphrase cannot be changed in Settings', async () => {
    const { e, session } = await withPasskey();
    expect(await json(await send(e, session, '/api/passphrase', { current: PASS, next: 'violet anchor quietly mends' }))).toMatchObject({ error: expect.stringMatching(/only for recovery/) });
    expect(await e.DB.prepare(`SELECT value FROM settings WHERE key = 'passphrase_hash'`).first()).toBeNull();
  });

  it('in the setup wizard, a passkey replaces the need for a stronger passphrase, and the passphrase cannot be replaced', async () => {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const WEAK = 'password1234';
    const e = env({ ADMIN_PASSPHRASE: WEAK });
    const session = await signIn(e, WEAK);
    const finish = (replacePassphrase?: unknown) => send(e, session, '/api/setup/complete', { timeZone: 'UTC', replacePassphrase });
    expect(await json(await finish())).toMatchObject({ error: expect.stringMatching(/too easy to guess/) });
    expect((await addPasskey(e, session, await SoftPasskey.make(ORIGIN))).status).toBe(200);
    expect(await json(await finish({ current: WEAK, next: 'violet anchor quietly mends' }))).toMatchObject({ error: expect.stringMatching(/only for recovery/) });
    expect((await finish()).status).toBe(200);
    expect(await e.DB.prepare(`SELECT value FROM settings WHERE key = 'setup_done'`).first('value')).toBe('1');
  });

  it('confirmation options list the registered passkeys, and need a session', async () => {
    const { e, session, key } = await withPasskey();
    const s = await readSession(e, session);
    expect((await assertionOptions(e.DB, RP, 'stepup', s!)).allowCredentials).toEqual([expect.objectContaining({ id: key.id })]);
    expect((await send(e, '', '/api/passkeys/options', { purpose: 'confirm' })).status).toBe(401);
    expect((await get(e, '', '/api/passkeys')).status).toBe(401);
  });
});

describe('removing passkeys and ending sessions', () => {
  it('ends the other sessions the removed passkey signed in', async () => {
    const { e, session, key } = await withPasskey();
    const viaKey = pair((await passkeyLogin(e, key)).headers.getSetCookie()[0]);
    const r = await send(e, session, `/api/passkeys/${key.id}/remove`, { passkey: await confirmation(e, session, key) });
    expect(await json(r)).toMatchObject({ ok: true, last: true });
    expect(await readSession(e, viaKey)).toBeNull();
    expect(await readSession(e, session)).not.toBeNull();
    // The last one gone: the passphrase signs in again.
    expect(await login(e, PASS, '1.1.1.1')).toMatchObject({ ok: true });
  });

  it('needs a passkey answer to remove one', async () => {
    const { e, session, key } = await withPasskey();
    expect(await json(await send(e, session, `/api/passkeys/${key.id}/remove`))).toMatchObject({ code: 'passkey_required' });
    expect(await e.DB.prepare('SELECT COUNT(*) AS n FROM passkeys').first('n')).toBe(1);
  });

  it('can sign out every other session', async () => {
    const { e, session, key } = await withPasskey();
    const other = pair((await passkeyLogin(e, key)).headers.getSetCookie()[0]);
    const r = await send(e, session, '/api/sessions/end-others', { passkey: await confirmation(e, session, key) });
    expect(await json(r)).toMatchObject({ ok: true, ended: 1 });
    expect(await readSession(e, other)).toBeNull();
    expect(await readSession(e, session)).not.toBeNull();
  });
});

describe('recovery', () => {
  it('opens passphrase sign-in once after the secret is replaced, and tells the operators', async () => {
    const { e, session, key } = await withPasskey();
    const NEW = 'brand new recovery secret';
    const replaced = { ...e, ADMIN_PASSPHRASE: NEW };
    // The old secret is gone, and so is every session tied to it.
    expect(await login(replaced, PASS, '1.1.1.1')).toMatchObject({ ok: false, status: 401 });
    expect(await readSession(replaced, session)).toBeNull();

    const r = await send(replaced, '', '/api/login', { passphrase: NEW });
    expect(await json(r)).toMatchObject({ ok: true, recovery: true });
    expect(r.headers.getSetCookie()[0]).toMatch(/Max-Age=86400$/);
    const recovered = pair(r.headers.getSetCookie()[0]);
    expect(await readSession(replaced, recovered)).toMatchObject({ method: 'recovery' });
    expect(await e.DB.prepare(`SELECT target, notice FROM admin_events WHERE action = 'signin' ORDER BY id DESC LIMIT 1`).first()).toMatchObject({ target: 'recovery passphrase', notice: expect.any(String) });

    // Once: the new secret is locked in turn.
    expect(await login(replaced, NEW, '1.1.1.1')).toMatchObject({ ok: false, status: 403 });

    // A fresh recovery session replaces lost passkeys without one.
    const spare = await SoftPasskey.make(ORIGIN, -8);
    expect((await addPasskey(replaced, recovered, spare, {}, 'Spare')).status).toBe(200);
    expect((await send(replaced, recovered, `/api/passkeys/${key.id}/remove`)).status).toBe(200);
    // But a recovery session still confirms other steps with a passkey.
    expect(await json(await send(replaced, recovered, '/api/tokens', { name: 'x' }))).toMatchObject({ code: 'passkey_required' });
  });

  it('is refused while the replaced secret is easy to guess', async () => {
    const { e } = await withPasskey();
    const weak = { ...e, ADMIN_PASSPHRASE: 'password1234' };
    expect(await login(weak, 'password1234', '1.1.1.1')).toMatchObject({ ok: false, status: 500, error: expect.stringMatching(/too easy to guess, so recovery is off/) });
    // Nothing was spent: a stronger secret still recovers.
    expect(await login({ ...e, ADMIN_PASSPHRASE: 'brand new recovery secret' }, 'brand new recovery secret', '1.1.1.1')).toMatchObject({ ok: true, recovery: true });
  });

  it('a recovery session that is no longer fresh needs a passkey like any other', async () => {
    const { e, key } = await withPasskey();
    const replaced = { ...e, ADMIN_PASSPHRASE: 'brand new recovery secret' };
    const recovered = pair((await send(replaced, '', '/api/login', { passphrase: replaced.ADMIN_PASSPHRASE })).headers.getSetCookie()[0]);
    await e.DB.prepare('UPDATE sessions SET created_at = ?1 WHERE id = ?2').bind(Date.now() - 11 * 60_000, await sessionDigest(recovered.split('=')[1])).run();
    expect(await json(await send(replaced, recovered, `/api/passkeys/${key.id}/remove`))).toMatchObject({ code: 'passkey_required' });
  });
});
