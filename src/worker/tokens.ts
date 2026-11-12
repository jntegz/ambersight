// Read-only tokens for Ambersight's own API. A token reads what the dashboard reads (GET only, no
// settings or setup); it cannot acknowledge, change settings or start a scan. Only its SHA-256
// digest is stored, and Cloudflare is never called with it.
// SPDX-License-Identifier: AGPL-3.0-only

export const MAX_TOKENS = 20;
const PREFIX = 'amb_';
const FORMAT = /^amb_[A-Za-z0-9_-]{43}$/;
/** GET routes a token may read. Settings, setup and the session are left out on purpose. */
const READABLE = /^\/api\/(overview|accounts|analytics|workers\/[^/]+|findings(\/[^/]+\/history)?|changes|timeline|resources|packages|self-cost|report|health)$/;

export interface TokenInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const digestOf = async (token: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const tokenMayRead = (method: string, path: string) => (method === 'GET' || method === 'HEAD') && READABLE.test(path);

/** Checks a bearer token; marks it used at most once an hour (one D1 write). */
export async function checkToken(db: D1Database, header: string | undefined, now = new Date()): Promise<boolean> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token || !FORMAT.test(token)) return false;
  const row = await db.prepare('SELECT id, last_used_at FROM api_tokens WHERE digest = ?1').bind(await digestOf(token)).first<{ id: string; last_used_at: string | null }>();
  if (!row) return false;
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > 3_600_000) {
    await db.prepare('UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1').bind(row.id, now.toISOString()).run();
  }
  return true;
}

export async function listTokens(db: D1Database): Promise<TokenInfo[]> {
  const { results } = await db.prepare('SELECT id, name, hint, created_at, last_used_at FROM api_tokens ORDER BY created_at').all<{
    id: string; name: string; hint: string; created_at: string; last_used_at: string | null;
  }>();
  return results.map((r) => ({ id: r.id, name: r.name, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

/** Creates a token and returns it once; it cannot be read again. */
export async function createToken(db: D1Database, name: string, now = new Date()): Promise<{ token: string; info: TokenInfo } | { error: string }> {
  const clean = name.trim();
  if (!clean || clean.length > 60 || /[\r\n<>]/.test(clean)) return { error: 'Give the token a name of up to 60 characters.' };
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<number>('n')) ?? 0;
  if (count >= MAX_TOKENS) return { error: `At most ${MAX_TOKENS} tokens. Revoke one you no longer use.` };
  const token = randomToken();
  const id = crypto.randomUUID();
  const info = { id, name: clean, hint: token.slice(-4), createdAt: now.toISOString(), lastUsedAt: null };
  await db.prepare('INSERT INTO api_tokens (id, name, digest, hint, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, clean, await digestOf(token), info.hint, info.createdAt).run();
  return { token, info };
}

export async function revokeToken(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM api_tokens WHERE id = ?1').bind(id).run();
  return (r.meta.changes ?? r.meta.rows_written ?? 0) > 0;
}
