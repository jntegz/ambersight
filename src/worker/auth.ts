// Passphrase login with server-side sessions. The credential is the ADMIN_PASSPHRASE Worker secret,
// or a passphrase set in Settings. D1 never holds either in the clear: a Settings passphrase is a
// PBKDF2 hash, stored with a slow salted binding to the secret in force when it was saved, and that
// hash counts only while the binding still matches, so replacing the secret takes the credential
// back. Sessions are random ids, kept in D1 only as SHA-256 digests and tied to the credential
// generation that issued them. Five failed attempts lock a client out for 15 minutes (IPv4 address,
// or IPv6 /64); past 50 attempts from any mix of clients in a 15-minute window, sign-in needs a
// known browser or a passed Turnstile check until the window ends, and past 200 a known browser.
// SPDX-License-Identifier: AGPL-3.0-only

import { MIN_PASSPHRASE } from '../shared/passphrase';
import { adminEventStatements, handleOf } from './adminLog';
import { getSettings, setSettings } from './db';
import type { Env } from './env';
import { allowedFetch, OPTIONAL_HOSTS } from './net';

export { MIN_PASSPHRASE };

/** Turnstile is on when both the site key (var) and the secret (Worker secret) are set. */
export const turnstileOn = (env: Env) => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);

/**
 * Checks a Turnstile token with Cloudflare (siteverify). Runs before the passphrase check, so a
 * bot that cannot pass the challenge cannot use up the sign-in attempts and lock you out.
 */
export async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<boolean> {
  if (!turnstileOn(env)) return true;
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET!);
  body.set('response', token);
  if (ip && ip !== 'unknown') body.set('remoteip', ip);
  try {
    const res = await allowedFetch(`https://${OPTIONAL_HOSTS.turnstile}/turnstile/v0/siteverify`, { method: 'POST', body }, undefined, [OPTIONAL_HOSTS.turnstile]);
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}

/** __Host- keeps sibling subdomains (other *.workers.dev Workers, other zone hosts) from setting or shadowing it. */
export const COOKIE = '__Host-as_session';
/** Marks a browser that has signed in here, so it can still sign in during a pause. It grants nothing by itself. */
export const DEVICE_COOKIE = '__Host-as_device';
const SESSION_DAYS = 7;
const DEVICE_DAYS = 90;
const MAX_DEVICES = 10;
const MAX_FAILS = 5;
/** Attempts in one window before sign-in needs a known browser or Turnstile. */
const GLOBAL_MAX_FAILS = 50;
/** Attempts in one window after which a passed Turnstile check is refused too, so it cannot add rows to login_attempts without limit. */
const GLOBAL_ROW_CAP = 200;
const LOCK_MS = 15 * 60_000;
/** The reserved login_attempts row that holds the install-wide count. Client keys never start with #. */
const GLOBAL_KEY = '#global';

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

/** Constant-time comparison of two strings via their SHA-256 digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}

// About 8 ms when measured in Node. The cost on Workers has not been measured, so it is not known
// whether a request that runs this once or twice (changing a Settings passphrase verifies the old
// one and hashes the new one) stays inside the Free plan's 10 ms of CPU.
const PBKDF2_ITERATIONS = 50_000;
// Half of that: paid once per isolate, on top of whatever that isolate's first request does.
const SECRET_ITERATIONS = 25_000;

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));

async function pbkdf2(passphrase: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

/** Format: pbkdf2 / iterations / salt hex / hash hex, joined with "$". */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return ['pbkdf2', PBKDF2_ITERATIONS, hex(salt), hex(await pbkdf2(passphrase, salt, PBKDF2_ITERATIONS))].join('$');
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const [scheme, it, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !salt || !hash) return false;
  const got = await pbkdf2(passphrase, unhex(salt), Number(it));
  const want = unhex(hash);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

/** The settings rows that decide which credential is in force. */
export interface CredentialSettings {
  passphrase_hash?: string | null;
  passphrase_binding?: string | null;
  cred_salt?: string | null;
}

/** The same rows as columns, for reading them along with a session or token in one query. */
export const CREDENTIAL_COLUMNS = ['passphrase_hash', 'passphrase_binding', 'cred_salt']
  .map((k) => `(SELECT value FROM settings WHERE key = '${k}') AS ${k}`)
  .join(', ');

/** The install's random salt for deriving from the secret, created the first time it is needed. */
export async function ensureCredSalt<T extends CredentialSettings>(db: D1Database, s: T): Promise<T> {
  if (s.cred_salt) return s;
  const [, row] = await db.batch([
    db.prepare(`INSERT INTO settings (key, value) VALUES ('cred_salt', ?1) ON CONFLICT(key) DO NOTHING`).bind(hex(crypto.getRandomValues(new Uint8Array(16)))),
    db.prepare(`SELECT value FROM settings WHERE key = 'cred_salt'`),
  ]);
  return { ...s, cred_salt: (row.results[0] as { value: string }).value };
}

// Only the finished value is kept: a Worker must not await a promise that belongs to another request.
let secretMemo: { secret: string; salt: string; value: string } | null = null;

/** Slow salted derivation of the secret, computed once per isolate so sessions do not pay for it per request. */
async function secretDigest(secret: string, salt: string): Promise<string> {
  if (secretMemo?.secret === secret && secretMemo.salt === salt) return secretMemo.value;
  const value = hex(await pbkdf2(secret, unhex(salt), SECRET_ITERATIONS));
  secretMemo = { secret, salt, value };
  return value;
}

/**
 * Whether the stored Settings passphrase counts. It does while its binding matches the secret in
 * force. A hash with no binding yet (saved by an older version) counts and is bound at its next
 * sign-in, and so does a hash on an install with no secret at all, which has nothing to bind to.
 */
async function hashHonored(env: Env, s: CredentialSettings): Promise<boolean> {
  if (!s.passphrase_hash) return false;
  if (!env.ADMIN_PASSPHRASE || !s.passphrase_binding) return true;
  return Boolean(s.cred_salt) && (await secretDigest(env.ADMIN_PASSPHRASE, s.cred_salt!)) === s.passphrase_binding;
}

/** The settings rows that store a new Settings passphrase, bound to the secret in force. */
export async function storePassphrase(env: Env, passphrase: string, s: CredentialSettings): Promise<D1PreparedStatement[]> {
  const db = env.DB;
  const hash = await hashPassphrase(passphrase);
  if (!env.ADMIN_PASSPHRASE) return [setSettings(db, { passphrase_hash: hash }), db.prepare(`DELETE FROM settings WHERE key = 'passphrase_binding'`)];
  const { cred_salt } = await ensureCredSalt(db, s);
  return [setSettings(db, { passphrase_hash: hash, passphrase_binding: await secretDigest(env.ADMIN_PASSPHRASE, cred_salt!) })];
}

/**
 * Checks a passphrase against the credential in force. A wrong guess costs one PBKDF2, and the
 * binding is only worked out for a passphrase that matched something. The secret is the cheap
 * comparison, so when it matches and the stored hash no longer counts, the hash is not computed.
 */
export async function checkPassphrase(env: Env, passphrase: string, s: CredentialSettings): Promise<boolean> {
  const secretOk = env.ADMIN_PASSPHRASE ? await safeEqual(passphrase, env.ADMIN_PASSPHRASE) : false;
  if (!s.passphrase_hash) return secretOk;
  if (secretOk) return !(await hashHonored(env, s)) || verifyPassphrase(passphrase, s.passphrase_hash);
  return (await verifyPassphrase(passphrase, s.passphrase_hash)) && hashHonored(env, s);
}

/**
 * Gives API tokens from before credential marks the generation in force. It runs at the first
 * sign-in, token use or scheduled run after the upgrade, and with a passphrase change, so these
 * tokens end with the credential like any other. Nothing records which secret was in force before
 * the upgrade, so a secret replaced before the first of those events cannot be told apart.
 */
export const markOlderTokens = (db: D1Database, generation: string) => db.prepare('UPDATE api_tokens SET cred = ?1 WHERE cred IS NULL').bind(generation);

/**
 * What a passphrase change writes, for one D1 batch with whatever must succeed or fail with it.
 * Older tokens take the outgoing generation first, so the change ends them too. In a signed-in
 * request the session check has already derived the secret's value, so that part is memoized.
 */
export async function passphraseChangeStatements(env: Env, next: string, s: CredentialSettings): Promise<D1PreparedStatement[]> {
  const db = env.DB;
  return [
    // With no credential in force there is no generation: 'none' never matches one.
    markOlderTokens(db, (await credentialGeneration(env, s)) ?? 'none'),
    ...(await storePassphrase(env, next, s)),
    // Sign out every session. API tokens from before this stop at their next use.
    db.prepare('DELETE FROM sessions'),
    db.prepare('DELETE FROM known_devices'),
  ];
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** What D1 stores for a session or device: a digest, so a copy of the table is not a set of working cookies. */
const sessionKey = async (id: string) => hex(await digest(id));

/**
 * Identifies the credential in force. Sessions, API tokens and known devices remember the
 * generation that issued them, so changing the passphrase, replacing ADMIN_PASSPHRASE or removing
 * the stored hash ends them all, even when the change ran no code here. From the secret it is a
 * salted PBKDF2 value, so this column is no fast way to test guesses offline. Null: no credential.
 */
export async function credentialGeneration(env: Env, s: CredentialSettings): Promise<string | null> {
  if (await hashHonored(env, s)) return `hash$${hex(await digest(`hash:${s.passphrase_hash}`))}`;
  if (!env.ADMIN_PASSPHRASE || !s.cred_salt) return null;
  return `secret$${await secretDigest(env.ADMIN_PASSPHRASE, s.cred_salt)}`;
}

export async function hasSession(env: Env, cookieHeader: string | null): Promise<boolean> {
  const id = readCookie(cookieHeader, COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return false;
  const row = await env.DB.prepare(`SELECT cred, ${CREDENTIAL_COLUMNS} FROM sessions WHERE id = ?1 AND expires_at > ?2`)
    .bind(await sessionKey(id), new Date().toISOString())
    .first<CredentialSettings & { cred: string }>();
  return row != null && row.cred === (await credentialGeneration(env, row));
}

type Refusal = { ok: false; status: 401 | 429 | 500; error: string };
export type LoginResult = { ok: true; cookie: string; deviceCookie?: string } | Refusal;
/** What a sign-in can show during a pause, besides the passphrase. */
export type SignInProof = 'none' | 'turnstile' | 'device';

const LOCKED: Refusal = { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
const PAUSED: Refusal = {
  ok: false, status: 429,
  error: 'Too many failed sign-ins from different addresses. Sign-in is paused for up to 15 minutes. A browser that has signed in here before can still sign in.',
};
/** How far the window's count may go for each kind of proof. Past it the attempt adds no row. */
const CEILING: Record<SignInProof, number> = { none: GLOBAL_MAX_FAILS, turnstile: GLOBAL_ROW_CAP, device: Number.MAX_SAFE_INTEGER };

/** The attempt-limit key for a client: its IPv4 address, or its IPv6 /64, which one customer usually holds whole. */
export function attemptKey(ip: string): string {
  const addr = ip.split('%')[0].toLowerCase();
  if (!addr.includes(':')) return addr.slice(0, 64);
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const sides = addr.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const gap = 8 - left.length - right.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const groups = sides.length === 2 ? [...left, ...Array<string>(Math.max(gap, 0)).fill('0'), ...right] : left;
  const prefix = groups.slice(0, 4);
  if (sides.length > 2 || prefix.length < 4 || !prefix.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return addr.slice(0, 64);
  return `${prefix.map((g) => Number.parseInt(g, 16).toString(16)).join(':')}::/64`;
}

type AttemptRow = { ip: string; fails: number; window_start: number; locked_until: number };

/**
 * Counts one passphrase attempt for `key` before the passphrase is checked. The caller's row and
 * the install-wide row are read first, so a locked key or a paused sign-in is refused with no write.
 * Otherwise both are updated in one D1 transaction, so concurrent attempts are all counted, and a
 * new per-client row is added only while the window is under the ceiling: the table cannot grow
 * during an attack, and every attempt costs the same however many clients have been seen.
 * `global: false` (re-entering the passphrase in a session) uses the per-key limit alone.
 * Returns a refusal, or null when the caller should check the passphrase and then call
 * `attemptFailed` or `attemptSucceeded`.
 */
export async function reserveAttempt(env: Env, key: string, now = Date.now(), opts: { proof?: SignInProof; global?: boolean } = {}): Promise<Refusal | null> {
  const db = env.DB;
  const global = opts.global !== false;
  const ceiling = global ? CEILING[opts.proof ?? 'none'] : Number.MAX_SAFE_INTEGER;
  const rowsOf = (rows: unknown[]) => {
    const list = rows as AttemptRow[];
    return { mine: list.find((r) => r.ip === key), all: list.find((r) => r.ip === GLOBAL_KEY) };
  };
  const read = db.prepare('SELECT ip, fails, window_start, locked_until FROM login_attempts WHERE ip IN (?1, ?2)').bind(key, GLOBAL_KEY);
  const before = rowsOf((await read.all()).results);
  if (before.mine && before.mine.locked_until > now) return LOCKED;
  if (global && before.all && before.all.window_start > now - LOCK_MS && before.all.fails >= ceiling) return PAUSED;

  const out = await db.batch([
    ...(global
      ? [db.prepare(
          `INSERT INTO login_attempts (ip, fails, window_start, locked_until) VALUES ('${GLOBAL_KEY}', 1, ?1, 0)
           ON CONFLICT(ip) DO UPDATE SET
             fails = CASE WHEN window_start <= ?1 - ?2 THEN 1 ELSE fails + 1 END,
             window_start = CASE WHEN window_start <= ?1 - ?2 THEN ?1 ELSE window_start END`,
        ).bind(now, LOCK_MS)]
      : []),
    db.prepare(
      `INSERT INTO login_attempts (ip, fails, window_start, locked_until)
       SELECT ?1, 1, ?2, 0 WHERE COALESCE((SELECT fails FROM login_attempts WHERE ip = '${GLOBAL_KEY}'), 0) <= ?4
       ON CONFLICT(ip) DO UPDATE SET
         fails = CASE WHEN locked_until > ?2 THEN fails WHEN window_start <= ?2 - ?3 THEN 1 ELSE fails + 1 END,
         window_start = CASE WHEN locked_until > ?2 THEN window_start WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END`,
    ).bind(key, now, LOCK_MS, ceiling),
    read,
  ]);
  const { mine, all } = rowsOf(out[out.length - 1].results);
  // This attempt is already counted, hence ">" rather than ">=".
  if ((global && (all?.fails ?? 0) > ceiling) || !mine) return PAUSED;
  if (mine.locked_until > now) return LOCKED;
  if (mine.fails > MAX_FAILS) {
    await db.prepare('UPDATE login_attempts SET locked_until = ?2 WHERE ip = ?1 AND locked_until < ?2').bind(key, now + LOCK_MS).run();
    return LOCKED;
  }
  return null;
}

export async function attemptFailed(env: Env, key: string, now = Date.now()): Promise<void> {
  await env.DB.prepare('UPDATE login_attempts SET locked_until = ?3 WHERE ip = ?1 AND fails >= ?2 AND locked_until < ?3').bind(key, MAX_FAILS, now + LOCK_MS).run();
}

/** Clears the key's row and, for sign-in, takes this attempt back out of the window's count. */
function successStatements(db: D1Database, key: string, now: number, global: boolean): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(key),
    ...(global
      ? [db.prepare(`UPDATE login_attempts SET fails = MAX(fails - 1, 0) WHERE ip = '${GLOBAL_KEY}' AND window_start > ?1`).bind(now - LOCK_MS)]
      : []),
  ];
}

export async function attemptSucceeded(env: Env, key: string, now = Date.now(), opts: { global?: boolean } = {}): Promise<void> {
  await env.DB.batch(successStatements(env.DB, key, now, opts.global !== false));
}

/** Removes what sign-in no longer needs. Run by the cron, so it happens with no sign-in at all. */
export function sweepSignInState(db: D1Database, now = Date.now()) {
  return db.batch([
    db.prepare('DELETE FROM login_attempts WHERE window_start <= ?1 AND locked_until <= ?2').bind(now - LOCK_MS, now),
    db.prepare('DELETE FROM known_devices WHERE expires_at <= ?1').bind(now),
  ]);
}

/** Whether the request carries the marker of a browser that signed in under the current credential. */
async function knownDevice(env: Env, s: CredentialSettings, cookieHeader: string | null | undefined, now: number): Promise<boolean> {
  const id = readCookie(cookieHeader ?? null, DEVICE_COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return false;
  const row = await env.DB.prepare('SELECT cred FROM known_devices WHERE digest = ?1 AND expires_at > ?2').bind(await sessionKey(id), now).first<{ cred: string }>();
  return row != null && row.cred === (await credentialGeneration(env, s));
}

/** A new marker for this browser, plus keeping the table to current, recent entries. */
async function issueDevice(db: D1Database, generation: string, now: number) {
  const id = hex(crypto.getRandomValues(new Uint8Array(32)));
  return {
    cookie: `${DEVICE_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_DAYS * 86_400}`,
    statements: [
      db.prepare('INSERT INTO known_devices (digest, cred, expires_at) VALUES (?1, ?2, ?3)').bind(await sessionKey(id), generation, now + DEVICE_DAYS * 86_400_000),
      db.prepare('DELETE FROM known_devices WHERE expires_at <= ?1 OR cred <> ?2').bind(now, generation),
      db.prepare('DELETE FROM known_devices WHERE digest NOT IN (SELECT digest FROM known_devices ORDER BY expires_at DESC LIMIT ?1)').bind(MAX_DEVICES),
    ],
  };
}

export interface LoginOptions {
  /** Turnstile is configured and this request passed it. */
  turnstilePassed?: boolean;
  /** The request's Cookie header, for the known-device marker. */
  cookieHeader?: string | null;
}

/** `ip` is CF-Connecting-IP, which Cloudflare sets and clients cannot override. */
export async function login(env: Env, passphrase: string, ip: string, now = Date.now(), opts: LoginOptions = {}): Promise<LoginResult> {
  const db = env.DB;
  const s = await getSettings(db);
  if (!env.ADMIN_PASSPHRASE && !s.passphrase_hash) return { ok: false, status: 500, error: 'ADMIN_PASSPHRASE secret is not set.' };
  if ((env.ADMIN_PASSPHRASE ?? '').length < MIN_PASSPHRASE && !(await hashHonored(env, s))) {
    return {
      ok: false, status: 500,
      error: `The ADMIN_PASSPHRASE secret is shorter than ${MIN_PASSPHRASE} characters, so sign-in is off. Set a longer one with "npx wrangler secret put ADMIN_PASSPHRASE", or in the Cloudflare dashboard under your Worker › Settings › Variables and Secrets.`,
    };
  }
  const key = attemptKey(ip);
  const device = await knownDevice(env, s, opts.cookieHeader, now);
  const refused = await reserveAttempt(env, key, now, { proof: device ? 'device' : opts.turnstilePassed ? 'turnstile' : 'none' });
  if (refused) return refused;

  if (!(await checkPassphrase(env, passphrase, s))) {
    await attemptFailed(env, key, now);
    return { ok: false, status: 401, error: 'Wrong passphrase.' };
  }

  const salted = await ensureCredSalt(db, s);
  const generation = await credentialGeneration(env, salted);
  if (!generation) return { ok: false, status: 500, error: 'ADMIN_PASSPHRASE secret is not set.' };
  const honored = await hashHonored(env, salted);
  const id = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(now + SESSION_DAYS * 86_400_000);
  const issued = device ? null : await issueDevice(db, generation, now);
  await db.batch([
    db.prepare('INSERT INTO sessions (id, expires_at, cred) VALUES (?1, ?2, ?3)').bind(await sessionKey(id), expires.toISOString(), generation),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(new Date(now).toISOString()),
    ...successStatements(db, key, now, true),
    markOlderTokens(db, generation),
    // A hash from before bindings existed is bound now that it has been used.
    ...(honored && env.ADMIN_PASSPHRASE && !salted.passphrase_binding
      ? [setSettings(db, { passphrase_binding: await secretDigest(env.ADMIN_PASSPHRASE, salted.cred_salt!) })]
      : []),
    // Signed in with a replaced secret: the old Settings passphrase is gone for good, so putting
    // the previous secret back cannot revive it.
    ...(salted.passphrase_hash && !honored ? [db.prepare(`DELETE FROM settings WHERE key IN ('passphrase_hash', 'passphrase_binding')`)] : []),
    ...(issued?.statements ?? []),
    // Only here, past the passphrase: a refused sign-in writes nothing to this log.
    ...adminEventStatements(db, [{ action: 'signin', target: '' }], await handleOf(id), new Date(now)),
  ]);
  return {
    ok: true,
    cookie: `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`,
    ...(issued ? { deviceCookie: issued.cookie } : {}),
  };
}

export async function logout(env: Env, cookieHeader: string | null): Promise<string> {
  const id = readCookie(cookieHeader, COOKIE);
  if (id) await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sessionKey(id)).run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
