// Passphrase login with server-side sessions. The passphrase is a Worker secret,
// never stored; sessions are random ids, kept in D1 only as SHA-256 digests and bound to the
// credential that issued them. Five failed attempts lock that client IP out for 15 minutes;
// 50 failures from any mix of IPs in 15 minutes pause sign-in for everyone.
// SPDX-License-Identifier: AGPL-3.0-only

import { getSettings } from './db';
import type { Env } from './env';
import { allowedFetch, OPTIONAL_HOSTS } from './net';

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
const SESSION_DAYS = 7;
const MAX_FAILS = 5;
const GLOBAL_MAX_FAILS = 50;
const LOCK_MS = 15 * 60_000;
/** Shortest ADMIN_PASSPHRASE secret Ambersight accepts; the Settings form enforces the same. */
export const MIN_PASSPHRASE = 12;

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

/** Constant-time comparison of two strings via their SHA-256 digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}

const PBKDF2_ITERATIONS = 50_000; // ~4 ms: keeps sign-in inside the Free plan's 10 ms CPU per request

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

/** A passphrase changed in Settings (PBKDF2 hash in D1) replaces the ADMIN_PASSPHRASE secret. */
export async function checkPassphrase(env: Env, passphrase: string, storedHash?: string): Promise<boolean> {
  if (storedHash) return verifyPassphrase(passphrase, storedHash);
  return safeEqual(passphrase, env.ADMIN_PASSPHRASE);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** What D1 stores for a session: a digest, so a copy of the table is not a set of working cookies. */
const sessionKey = async (id: string) => hex(await digest(id));

/**
 * Fingerprint of the credential sign-in currently accepts. Sessions remember the fingerprint they
 * were issued under, so rotating ADMIN_PASSPHRASE or removing the stored hash signs everyone out.
 */
export async function credentialFingerprint(env: Env, storedHash?: string | null): Promise<string> {
  return hex(await digest(storedHash ? `hash:${storedHash}` : `env:${env.ADMIN_PASSPHRASE ?? ''}`));
}

export async function hasSession(env: Env, cookieHeader: string | null): Promise<boolean> {
  const id = readCookie(cookieHeader, COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return false;
  const row = await env.DB.prepare(
    `SELECT cred, (SELECT value FROM settings WHERE key = 'passphrase_hash') AS stored FROM sessions WHERE id = ?1 AND expires_at > ?2`,
  )
    .bind(await sessionKey(id), new Date().toISOString())
    .first<{ cred: string; stored: string | null }>();
  return row != null && row.cred === (await credentialFingerprint(env, row.stored));
}

type Refusal = { ok: false; status: 401 | 429 | 500; error: string };
export type LoginResult = { ok: true; cookie: string } | Refusal;

/**
 * Counts one passphrase attempt for `key` before the passphrase is checked, in a single D1
 * transaction, so concurrent attempts cannot all read the same count. Returns a refusal when the
 * key is locked or sign-in is paused; otherwise the caller checks the passphrase and then calls
 * `attemptFailed` or `attemptSucceeded`.
 */
export async function reserveAttempt(env: Env, key: string, now = Date.now()): Promise<Refusal | null> {
  const [, mine, all] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, window_start, locked_until) VALUES (?1, 1, ?2, 0)
       ON CONFLICT(ip) DO UPDATE SET
         fails = CASE WHEN locked_until > ?2 THEN fails WHEN window_start <= ?2 - ?3 THEN 1 ELSE fails + 1 END,
         window_start = CASE WHEN locked_until > ?2 THEN window_start WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END`,
    ).bind(key, now, LOCK_MS),
    env.DB.prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?1').bind(key),
    env.DB.prepare('SELECT COALESCE(SUM(fails), 0) AS n FROM login_attempts WHERE window_start > ?1').bind(now - LOCK_MS),
  ]);
  const row = mine.results[0] as { fails: number; locked_until: number };
  if (row.locked_until > now) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
  if (row.fails > MAX_FAILS) {
    await env.DB.prepare('UPDATE login_attempts SET locked_until = ?2 WHERE ip = ?1 AND locked_until < ?2').bind(key, now + LOCK_MS).run();
    return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
  }
  // This attempt is already counted in the sum, hence ">" rather than ">=".
  if (Number((all.results[0] as { n: number }).n) > GLOBAL_MAX_FAILS) {
    // Do not let attempts refused by the pause extend it.
    await env.DB.prepare('UPDATE login_attempts SET fails = fails - 1 WHERE ip = ?1 AND fails > 0').bind(key).run();
    return { ok: false, status: 429, error: 'Too many failed sign-ins from different addresses. Sign-in is paused for 15 minutes.' };
  }
  return null;
}

export async function attemptFailed(env: Env, key: string, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE login_attempts SET locked_until = ?3 WHERE ip = ?1 AND fails >= ?2 AND locked_until < ?3').bind(key, MAX_FAILS, now + LOCK_MS),
    env.DB.prepare('DELETE FROM login_attempts WHERE window_start < ?1 AND locked_until < ?2').bind(now - 86_400_000, now),
  ]);
}

export async function attemptSucceeded(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(key).run();
}

/** `ip` is CF-Connecting-IP, which Cloudflare sets and clients cannot override. */
export async function login(env: Env, passphrase: string, ip: string, now = Date.now()): Promise<LoginResult> {
  const s = await getSettings(env.DB);
  if (!env.ADMIN_PASSPHRASE && !s.passphrase_hash) return { ok: false, status: 500, error: 'ADMIN_PASSPHRASE secret is not set.' };
  if (!s.passphrase_hash && env.ADMIN_PASSPHRASE.length < MIN_PASSPHRASE) {
    return {
      ok: false, status: 500,
      error: `The ADMIN_PASSPHRASE secret is shorter than ${MIN_PASSPHRASE} characters, so sign-in is off. Set a longer one with "npx wrangler secret put ADMIN_PASSPHRASE", or in the Cloudflare dashboard under your Worker › Settings › Variables and Secrets.`,
    };
  }
  const refused = await reserveAttempt(env, ip, now);
  if (refused) return refused;

  if (!(await checkPassphrase(env, passphrase, s.passphrase_hash))) {
    await attemptFailed(env, ip, now);
    return { ok: false, status: 401, error: 'Wrong passphrase.' };
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const id = hex(bytes);
  const expires = new Date(now + SESSION_DAYS * 86_400_000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id, expires_at, cred) VALUES (?1, ?2, ?3)')
      .bind(await sessionKey(id), expires.toISOString(), await credentialFingerprint(env, s.passphrase_hash)),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(new Date(now).toISOString()),
  ]);
  await attemptSucceeded(env, ip);
  return {
    ok: true,
    cookie: `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`,
  };
}

export async function logout(env: Env, cookieHeader: string | null): Promise<string> {
  const id = readCookie(cookieHeader, COOKIE);
  if (id) await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sessionKey(id)).run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
