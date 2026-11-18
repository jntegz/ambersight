// Read-only tokens for Ambersight's own API. A token reads what the dashboard reads (GET only, no
// settings or setup); it cannot acknowledge, change settings or start a scan. Only its SHA-256
// digest is stored, and Cloudflare is never called with it. A token expires, and it remembers the
// credential generation that issued it, so it stops working when the passphrase or the
// ADMIN_PASSPHRASE secret changes, however that change was made. A token from before generations
// existed takes the one in force at the first sign-in, token use or scheduled run after the upgrade.
// A token also carries what it may read: some or all watched accounts, and whether person-linked data
// is included. index.ts enforces the accounts on every route, tokenView.ts removes the people.
// SPDX-License-Identifier: AGPL-3.0-only

import { CREDENTIAL_COLUMNS, credentialGeneration, ensureCredSalt, markOlderTokens, type CredentialSettings } from './auth';
import { getSettings } from './db';
import type { Env } from './env';

export const MAX_TOKENS = 20;
/** Lifetimes offered when creating a token, in days. */
export const TOKEN_DAYS = [30, 90, 365];
export const DEFAULT_TOKEN_DAYS = 90;
const DAY = 86_400_000;
const PREFIX = 'amb_';
const FORMAT = /^amb_[A-Za-z0-9_-]{43}$/;
/** GET routes a token may read. Settings, setup and the session are left out on purpose. */
const READABLE = /^\/api\/(overview|accounts|analytics|workers\/[^/]+|findings(\/[^/]+\/history)?|changes|timeline|resources|packages|self-cost|report|health)$/;

/** Accounts as chosen when creating a token: every watched account, or these. */
export type AccountChoice = 'all' | string[];

/** What one token may read. `accounts` is null for every watched account. */
export interface TokenGrant {
  accounts: string[] | null;
  /** Deploy authors, audit actors and the free text that can carry them. */
  people: boolean;
}

export interface TokenInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  /** Issued under a passphrase or secret that has since changed, so it no longer works. */
  invalidated: boolean;
  accounts: AccountChoice;
  people: boolean;
  /** Created before tokens had a scope: it keeps every account, without person-linked data. */
  olderScope: boolean;
}

const ALL_ACCOUNTS = '*';

/** The stored account list. NULL is a token from before scopes. Anything unreadable grants nothing. */
function accountsFrom(stored: string | null): string[] | null {
  if (stored === null || stored === ALL_ACCOUNTS) return null;
  try {
    const list: unknown = JSON.parse(stored);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The accounts a new token asks for, which must be said outright: "all", or a list of watched
 * accounts. Leaving it out is an error, so that no client gets every account by default.
 */
export function accountChoice(value: unknown, watched: string[]): AccountChoice | { error: string } {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || !value.length) return { error: 'Choose the accounts this token may read.' };
  const ids = [...new Set(value as unknown[])];
  if (!ids.every((id): id is string => typeof id === 'string' && watched.includes(id))) return { error: 'This install does not watch one of those accounts.' };
  return ids;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const digestOf = async (token: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const tokenMayRead = (method: string, path: string) => (method === 'GET' || method === 'HEAD') && READABLE.test(path);

const isExpired = (expiresAt: string | null, now: Date) => expiresAt != null && Date.parse(expiresAt) <= now.getTime();

/**
 * Checks a bearer token and returns what it may read, or null: it must exist, be unexpired and come
 * from the credential in force. A token from before these checks may have no generation or expiry
 * yet: it takes them now, and every other such token takes the generation with it. Marks the token
 * used at most once an hour (one D1 write).
 */
export async function authorizeToken(env: Env, header: string | undefined, now = new Date()): Promise<TokenGrant | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token || !FORMAT.test(token)) return null;
  const db = env.DB;
  const row = await db.prepare(`SELECT id, last_used_at, expires_at, cred, accounts, people, ${CREDENTIAL_COLUMNS} FROM api_tokens WHERE digest = ?1`)
    .bind(await digestOf(token))
    .first<CredentialSettings & { id: string; last_used_at: string | null; expires_at: string | null; cred: string | null; accounts: string | null; people: number }>();
  if (!row || isExpired(row.expires_at, now)) return null;
  const generation = await credentialGeneration(env, row.cred ? row : await ensureCredSalt(db, row));
  if (!generation || (row.cred && row.cred !== generation)) return null;
  const stale = !row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > 3_600_000;
  if (stale || !row.cred || !row.expires_at) {
    await db.batch([
      ...(row.cred ? [] : [markOlderTokens(db, generation)]),
      db.prepare('UPDATE api_tokens SET last_used_at = ?2, cred = COALESCE(cred, ?3), expires_at = COALESCE(expires_at, ?4) WHERE id = ?1')
        .bind(row.id, now.toISOString(), generation, new Date(now.getTime() + DEFAULT_TOKEN_DAYS * DAY).toISOString()),
    ]);
  }
  return { accounts: accountsFrom(row.accounts), people: row.people === 1 };
}

export const checkToken = async (env: Env, header: string | undefined, now = new Date()) => (await authorizeToken(env, header, now)) !== null;

/** For the scheduled run: marks older tokens soon after an upgrade, even if nobody signs in. One small read otherwise. */
export async function settleOlderTokens(env: Env): Promise<void> {
  const db = env.DB;
  if (!(await db.prepare('SELECT 1 AS found FROM api_tokens WHERE cred IS NULL LIMIT 1').first('found'))) return;
  const generation = await credentialGeneration(env, await ensureCredSalt(db, await getSettings(db)));
  if (generation) await markOlderTokens(db, generation).run();
}

export async function listTokens(env: Env, now = new Date()): Promise<TokenInfo[]> {
  const generation = await credentialGeneration(env, await getSettings(env.DB));
  const { results } = await env.DB.prepare('SELECT id, name, hint, created_at, last_used_at, expires_at, cred, accounts, people FROM api_tokens ORDER BY created_at').all<{
    id: string; name: string; hint: string; created_at: string; last_used_at: string | null; expires_at: string | null; cred: string | null; accounts: string | null; people: number;
  }>();
  return results.map((r) => ({
    id: r.id, name: r.name, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at, expired: isExpired(r.expires_at, now), invalidated: r.cred != null && r.cred !== generation,
    accounts: accountsFrom(r.accounts) ?? 'all', people: r.people === 1, olderScope: r.accounts === null,
  }));
}

/** Creates a token and returns it once; it cannot be read again. `generation` is the credential in force. */
export async function createToken(
  db: D1Database, name: string, opts: { days: number; generation: string; accounts: AccountChoice; people: boolean }, now = new Date(),
): Promise<{ token: string; info: TokenInfo } | { error: string }> {
  const clean = name.trim();
  if (!clean || clean.length > 60 || /[\r\n<>]/.test(clean)) return { error: 'Give the token a name of up to 60 characters.' };
  if (!TOKEN_DAYS.includes(opts.days)) return { error: `A token lasts ${TOKEN_DAYS.join(', ')} days.` };
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<number>('n')) ?? 0;
  if (count >= MAX_TOKENS) return { error: `At most ${MAX_TOKENS} tokens. Revoke one you no longer use.` };
  const token = randomToken();
  const id = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + opts.days * DAY).toISOString();
  const info: TokenInfo = {
    id, name: clean, hint: token.slice(-4), createdAt: now.toISOString(), lastUsedAt: null, expiresAt, expired: false, invalidated: false,
    accounts: opts.accounts, people: opts.people, olderScope: false,
  };
  await db.prepare('INSERT INTO api_tokens (id, name, digest, hint, created_at, expires_at, cred, accounts, people) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(id, clean, await digestOf(token), info.hint, info.createdAt, expiresAt, opts.generation, opts.accounts === 'all' ? ALL_ACCOUNTS : JSON.stringify(opts.accounts), opts.people ? 1 : 0).run();
  return { token, info };
}

export async function revokeToken(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM api_tokens WHERE id = ?1').bind(id).run();
  return (r.meta.changes ?? r.meta.rows_written ?? 0) > 0;
}
