// Passphrase login with server-side sessions. The passphrase is a Worker secret,
// never stored; sessions are random ids in D1; failed logins lock out for 15 minutes.
// SPDX-License-Identifier: AGPL-3.0-only

import { getSettings, setSettings } from './db';
import type { Env } from './env';

export const COOKIE = 'as_session';
const SESSION_DAYS = 7;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

/** Constant-time comparison of two strings via their SHA-256 digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function hasSession(env: Env, cookieHeader: string | null): Promise<boolean> {
  const id = readCookie(cookieHeader, COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return false;
  const row = await env.DB.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?1 AND expires_at > ?2')
    .bind(id, new Date().toISOString())
    .first();
  return row != null;
}

export type LoginResult = { ok: true; cookie: string } | { ok: false; status: 401 | 429 | 500; error: string };

export async function login(env: Env, passphrase: string): Promise<LoginResult> {
  if (!env.ADMIN_PASSPHRASE) return { ok: false, status: 500, error: 'ADMIN_PASSPHRASE secret is not set.' };
  const now = Date.now();
  const s = await getSettings(env.DB);
  const fails = Number(s.login_fails ?? 0);
  const lockedUntil = Number(s.login_locked_until ?? 0);
  if (lockedUntil > now) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };

  if (!(await safeEqual(passphrase, env.ADMIN_PASSPHRASE))) {
    const next = fails + 1;
    await setSettings(env.DB, {
      login_fails: String(next >= MAX_FAILS ? 0 : next),
      login_locked_until: String(next >= MAX_FAILS ? now + LOCK_MS : 0),
    }).run();
    return { ok: false, status: 401, error: 'Wrong passphrase.' };
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expires = new Date(now + SESSION_DAYS * 86_400_000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id, expires_at) VALUES (?1, ?2)').bind(id, expires.toISOString()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(new Date(now).toISOString()),
    setSettings(env.DB, { login_fails: '0', login_locked_until: '0' }),
  ]);
  return {
    ok: true,
    cookie: `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`,
  };
}

export async function logout(env: Env, cookieHeader: string | null): Promise<string> {
  const id = readCookie(cookieHeader, COOKIE);
  if (id) await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
