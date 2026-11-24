// Passkeys: registering them, signing in with one, and confirming a sensitive step with one.
//
// Challenges are not stored. Each is 16 random bytes, an expiry and an HMAC over both, the step
// it is for and what it is bound to (the session, for adding a passkey or confirming a step), with
// a key that lives in D1. Asking for one therefore writes nothing, so the sign-in page cannot be
// used to fill a table. A challenge that a passkey answered is recorded until it would have
// expired (webauthn_used), in the same D1 batch as what the answer was for, so an answer works
// once. The HMAC key is not a secret in the strong sense: someone with a copy of D1 could make
// challenges, but answering one still takes the passkey.
// SPDX-License-Identifier: AGPL-3.0-only

import { adminEventStatements, handleOf, type AdminEvent } from './adminLog';
import { credentialGeneration, ensureCredSalt, newSession, passkeyCount, type LoginResult, type SessionInfo } from './auth';
import { getSettings, setSettings } from './db';
import type { Env } from './env';
import {
  ALGORITHMS, b64urlDecode, b64urlEncode, readAssertion, readClientData, verifyAssertion, verifyRegistration,
  WebAuthnError, type Alg, type RelyingParty, type StoredKey,
} from './webauthn';

export const MAX_PASSKEYS = 10;
const CHALLENGE_MS = 5 * 60_000;
const MAX_NAME = 60;

export type ChallengeKind = 'signin' | 'register' | 'stepup';

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const digestHex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

/** A random install value kept in settings, created the first time it is needed. */
async function installValue(db: D1Database, key: string, bytes: number): Promise<string> {
  const [, row] = await db.batch([
    db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING').bind(key, hex(crypto.getRandomValues(new Uint8Array(bytes)))),
    db.prepare('SELECT value FROM settings WHERE key = ?1').bind(key),
  ]);
  return (row.results[0] as { value: string }).value;
}

async function challengeMac(db: D1Database, kind: ChallengeKind, binding: string, body: Uint8Array): Promise<Uint8Array> {
  const raw = Uint8Array.from((await installValue(db, 'webauthn_key', 32)).match(/../g)!, (h) => Number.parseInt(h, 16));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const label = enc.encode(`ambersight-webauthn:${kind}:${binding}:`);
  const data = new Uint8Array(label.length + body.length);
  data.set(label);
  data.set(body, label.length);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** A challenge for `kind`, good for this binding (a session digest, or '' at sign-in) for five minutes. */
export async function issueChallenge(db: D1Database, kind: ChallengeKind, binding: string, now = Date.now()): Promise<string> {
  const body = new Uint8Array(24);
  body.set(crypto.getRandomValues(new Uint8Array(16)));
  new DataView(body.buffer).setFloat64(16, now + CHALLENGE_MS);
  const mac = await challengeMac(db, kind, binding, body);
  const out = new Uint8Array(body.length + mac.length);
  out.set(body);
  out.set(mac, body.length);
  return b64urlEncode(out);
}

/** When the challenge expires, if it is one of ours for this kind and binding and has not yet. Writes nothing. */
async function challengeExpiry(db: D1Database, challenge: string, kind: ChallengeKind, binding: string, now: number): Promise<number | null> {
  const bytes = b64urlDecode(challenge, 128);
  if (!bytes || bytes.length !== 56) return null;
  const body = bytes.subarray(0, 24);
  const want = await challengeMac(db, kind, binding, body);
  const got = bytes.subarray(24);
  if (!crypto.subtle.timingSafeEqual(want, got)) return null;
  const expires = new DataView(body.buffer, body.byteOffset).getFloat64(16);
  return expires > now && expires <= now + CHALLENGE_MS ? expires : null;
}

/** Records an answered challenge. In a batch, a second use fails the whole batch on the primary key. */
const spendChallenge = async (db: D1Database, challenge: string, expires: number) =>
  db.prepare('INSERT INTO webauthn_used (digest, expires_at) VALUES (?1, ?2)').bind(await digestHex(`challenge:${challenge}`), Math.ceil(expires));

const isReplay = (e: unknown) => /unique|constraint|primary key/i.test(String((e as Error)?.message ?? e));

const REPLAYED = 'This passkey answer was already used. Try again.';
const EXPIRED = 'The passkey request expired or is not for this step. Try again.';

/** The one install-wide user every passkey belongs to: there is one dashboard identity. */
const userHandle = (db: D1Database) => installValue(db, 'webauthn_user', 16).then((h) => b64urlEncode(Uint8Array.from(h.match(/../g)!, (x) => Number.parseInt(x, 16))));

interface PasskeyRow {
  id: string;
  public_key: string;
  alg: number;
  sign_count: number;
  backed_up: number;
  transports: string | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

const ids = async (db: D1Database) =>
  (await db.prepare('SELECT id, transports FROM passkeys ORDER BY created_at').all<{ id: string; transports: string | null }>()).results.map((r) => ({
    type: 'public-key' as const,
    id: r.id,
    ...(r.transports ? { transports: JSON.parse(r.transports) as string[] } : {}),
  }));

/** Options for navigator.credentials.create(), as JSON (PublicKeyCredentialCreationOptionsJSON). */
export async function registrationOptions(db: D1Database, rp: RelyingParty, session: SessionInfo, now = Date.now()) {
  return {
    challenge: await issueChallenge(db, 'register', session.digest, now),
    rp: { id: rp.id, name: 'Ambersight' },
    user: { id: await userHandle(db), name: `Ambersight · ${rp.id}`, displayName: 'Ambersight dashboard' },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: CHALLENGE_MS,
    attestation: 'none' as const,
    authenticatorSelection: { residentKey: 'required' as const, requireResidentKey: true, userVerification: 'required' as const },
    excludeCredentials: await ids(db),
  };
}

/**
 * Options for navigator.credentials.get(). At sign-in no credential IDs are listed, so the page
 * says nothing about which passkeys exist: the browser offers the ones it has for this site.
 */
export async function assertionOptions(db: D1Database, rp: RelyingParty, kind: 'signin' | 'stepup', session?: SessionInfo, now = Date.now()) {
  return {
    challenge: await issueChallenge(db, kind, kind === 'stepup' ? session!.digest : '', now),
    rpId: rp.id,
    timeout: CHALLENGE_MS,
    userVerification: 'required' as const,
    allowCredentials: kind === 'stepup' ? await ids(db) : [],
  };
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '');

export type Outcome<T> = ({ ok: true } & T) | { ok: false; status: 400 | 401 | 409 | 500; error: string };

/** Checks a passkey answer for `kind` and returns its passkey, plus the statements that spend it and record its use. */
async function checkAnswer(
  env: Env, response: unknown, rp: RelyingParty, kind: 'signin' | 'stepup', binding: string, now: number,
): Promise<Outcome<{ passkey: PasskeyRow; statements: D1PreparedStatement[] }>> {
  const db = env.DB;
  try {
    const client = readClientData(response);
    const expires = await challengeExpiry(db, client.challenge, kind, binding, now);
    if (!expires) return { ok: false, status: 401, error: EXPIRED };
    const { id, userHandle: handle } = readAssertion(response);
    const row = await db.prepare('SELECT * FROM passkeys WHERE id = ?1').bind(id).first<PasskeyRow>();
    // The same answer for an unknown passkey and a wrong signature: neither says which passkeys exist.
    // At sign-in no credential was named, so the passkey must say whose it is (WebAuthn §7.2).
    const handleOk = handle === null ? kind === 'stepup' : handle === (await userHandle(db));
    if (!row || !handleOk) return { ok: false, status: 401, error: 'This passkey is not registered here. Use another one, or sign in with an e-mailed link.' };
    const key: StoredKey = { alg: row.alg as Alg, jwk: JSON.parse(row.public_key) as JsonWebKey };
    const result = await verifyAssertion(response, rp, client.challenge, { key, signCount: row.sign_count });
    return {
      ok: true,
      passkey: row,
      statements: [
        await spendChallenge(db, client.challenge, expires),
        db.prepare('UPDATE passkeys SET sign_count = ?2, backed_up = ?3, last_used_at = ?4 WHERE id = ?1').bind(row.id, result.signCount, result.backedUp ? 1 : 0, new Date(now).toISOString()),
      ],
    };
  } catch (e) {
    if (e instanceof WebAuthnError) return { ok: false, status: 401, error: e.message };
    throw e;
  }
}

/** Signs in with a passkey. `noticeTo` is unused here: a passkey sign-in is the normal way in. */
export async function passkeySignIn(env: Env, response: unknown, rp: RelyingParty, now = Date.now()): Promise<LoginResult> {
  const db = env.DB;
  const answer = await checkAnswer(env, response, rp, 'signin', '', now);
  if (!answer.ok) return { ok: false, status: answer.status === 401 ? 401 : 500, error: answer.error };
  const generation = await credentialGeneration(env, await ensureCredSalt(db, await getSettings(db)));
  if (!generation) return { ok: false, status: 500, error: 'Sign-in is off: the ADMIN_PASSPHRASE secret is not set. Passkeys need it too, as the recovery credential.' };
  const session = await newSession(db, { generation, method: 'passkey', passkey: answer.passkey.id, now });
  try {
    await db.batch([
      ...answer.statements,
      ...session.statements,
      ...adminEventStatements(db, [{ action: 'signin', target: `passkey "${answer.passkey.name}"` }], await handleOf(session.id), new Date(now)),
    ]);
  } catch (e) {
    if (isReplay(e)) return { ok: false, status: 401, error: REPLAYED };
    throw e;
  }
  return { ok: true, cookie: session.cookie };
}

/**
 * Confirms a sensitive step with a passkey, for this session. On success the answer is already
 * spent, so it cannot confirm a second step.
 */
export async function confirmWithPasskey(env: Env, response: unknown, rp: RelyingParty, session: SessionInfo, now = Date.now()): Promise<Outcome<{ name: string }>> {
  const answer = await checkAnswer(env, response, rp, 'stepup', session.digest, now);
  if (!answer.ok) return answer;
  try {
    await env.DB.batch(answer.statements);
  } catch (e) {
    if (isReplay(e)) return { ok: false, status: 401, error: REPLAYED };
    throw e;
  }
  return { ok: true, name: answer.passkey.name };
}

/**
 * Stores a new passkey from a registration answer. The caller has already decided this session may
 * add one. The first passkey turns passphrase sign-in off: the generation in force is locked, and
 * every other session ends, since those were signed in by a way that no longer counts.
 */
export async function addPasskey(
  env: Env, response: unknown, rp: RelyingParty, session: SessionInfo, name: unknown,
  log: (events: AdminEvent[]) => Promise<D1PreparedStatement[]>, now = Date.now(),
): Promise<Outcome<{ info: PasskeyInfo; first: boolean }>> {
  const db = env.DB;
  const count = await passkeyCount(db);
  if (count >= MAX_PASSKEYS) return { ok: false, status: 409, error: `At most ${MAX_PASSKEYS} passkeys. Remove one first.` };
  let created;
  let challenge: string;
  try {
    challenge = readClientData(response).challenge;
    const expires = await challengeExpiry(db, challenge, 'register', session.digest, now);
    if (!expires) return { ok: false, status: 401, error: EXPIRED };
    created = { ...(await verifyRegistration(response, rp, challenge)), expires };
  } catch (e) {
    if (e instanceof WebAuthnError) return { ok: false, status: 400, error: e.message };
    throw e;
  }
  if (await db.prepare('SELECT 1 AS found FROM passkeys WHERE id = ?1').bind(created.id).first('found')) {
    return { ok: false, status: 409, error: 'This passkey is already registered.' };
  }
  const settings = await ensureCredSalt(db, await getSettings(db));
  const generation = await credentialGeneration(env, settings);
  if (!generation) return { ok: false, status: 500, error: 'The ADMIN_PASSPHRASE secret is not set. Passkeys need it too, as the recovery credential.' };
  const first = count === 0;
  const label = cleanName(name) || `Passkey ${count + 1}`;
  const at = new Date(now).toISOString();
  try {
    await db.batch([
      await spendChallenge(db, challenge, created.expires),
      db.prepare('INSERT INTO passkeys (id, public_key, alg, sign_count, backed_up, transports, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(created.id, JSON.stringify(created.key.jwk), created.key.alg, created.signCount, created.backedUp ? 1 : 0, created.transports.length ? JSON.stringify(created.transports) : null, label, at),
      ...(first
        ? [
            setSettings(db, { passkey_lock: generation }),
            db.prepare('DELETE FROM sessions WHERE id <> ?1').bind(session.digest),
            // Known browsers only let the passphrase through a pause, which no longer applies.
            db.prepare('DELETE FROM known_devices'),
          ]
        : []),
      ...(await log([{ action: 'passkey.added', target: `"${label}"${first ? ', passphrase sign-in turned off' : ''}`, notice: true }])),
    ]);
  } catch (e) {
    if (isReplay(e)) return { ok: false, status: 401, error: REPLAYED };
    throw e;
  }
  return { ok: true, first, info: { id: created.id, name: label, createdAt: at, lastUsedAt: null, backedUp: created.backedUp, current: false } };
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Synced to a cloud account, so it survives losing the device. */
  backedUp: boolean;
  /** The passkey this session signed in with. */
  current: boolean;
}

export async function listPasskeys(db: D1Database, session: SessionInfo | undefined): Promise<PasskeyInfo[]> {
  const { results } = await db.prepare('SELECT id, name, created_at, last_used_at, backed_up FROM passkeys ORDER BY created_at').all<PasskeyRow>();
  return results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, backedUp: r.backed_up === 1, current: session?.passkey === r.id }));
}

/**
 * Removes a passkey, and ends every other session it signed in. Removing the last one turns
 * passphrase sign-in back on, which the notice says.
 */
export async function removePasskey(
  env: Env, id: string, session: SessionInfo, log: (events: AdminEvent[]) => Promise<D1PreparedStatement[]>,
): Promise<Outcome<{ last: boolean }>> {
  const db = env.DB;
  const row = await db.prepare('SELECT name FROM passkeys WHERE id = ?1').bind(id).first<{ name: string }>();
  if (!row) return { ok: false, status: 400, error: 'No such passkey.' };
  const last = (await passkeyCount(db)) === 1;
  await db.batch([
    db.prepare('DELETE FROM passkeys WHERE id = ?1').bind(id),
    db.prepare('DELETE FROM sessions WHERE passkey = ?1 AND id <> ?2').bind(id, session.digest),
    ...(last ? [db.prepare(`DELETE FROM settings WHERE key = 'passkey_lock'`)] : []),
    ...(await log([{ action: 'passkey.removed', target: `"${row.name}"${last ? ', passphrase sign-in turned back on' : ''}`, notice: true }])),
  ]);
  return { ok: true, last };
}
