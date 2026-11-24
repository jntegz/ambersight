// Sign-in by e-mailed link, for when no passkey is at hand. The link goes only to the operator
// addresses from the configuration (DIGEST_TO, see notify.ts); nothing on the sign-in page takes an
// address. It is hardened against the usual ways such links are lost:
//   - A token of 256 bits, stored only as a SHA-256 digest. It expires after 10 minutes and works
//     once. Asking for another link does not end an earlier one, so nobody can cancel the link an
//     operator is about to use by asking for their own.
//   - It works only in the browser that asked for it: that browser gets a random cookie, whose
//     digest is stored with the link. A forwarded, leaked or scanned link signs nobody in, and a
//     link someone else asked for cannot sign this browser into their session.
//   - The token is in the URL fragment, which browsers never send to a server, and the page asks
//     for a click before it is used, so a mail scanner that opens links cannot spend it.
//   - Asking is limited per client (two links an hour from one address or IPv6 /64) and install-wide
//     (one link a minute and five an hour), and Turnstile applies when it is set up. The per-client
//     limit comes first, so one client cannot spend the install's hourly allowance. Refused
//     requests send nothing.
// A link session is shorter (one day), and while passkeys exist it cannot confirm sensitive steps
// on its own: those need a passkey (index.ts).
// SPDX-License-Identifier: AGPL-3.0-only

import { adminEventStatements, handleOf } from './adminLog';
import { attemptKey, credentialGeneration, ensureCredSalt, newSession, readCookie, type LoginResult } from './auth';
import { claimCooldown, configFrom, getSettings } from './db';
import type { Env } from './env';
import { emailReady, esc, operatorAddresses, sendEmail, watchedAccountIds } from './notify';
import { safeError } from './redact';

export const LINK_COOKIE = '__Host-as_link';
const LINK_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;
const HOUR = 3_600_000;
const PER_HOUR = 5;
const PER_CLIENT_HOUR = 2;
/** The login_attempts row that counts links sent this hour. Client keys never start with #. */
const HOURLY_KEY = '#signin-link';
/** Prefix of the rows that count one client's link requests this hour (see sweepSignInState). */
export const CLIENT_LINK_PREFIX = '#link:';

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const digest = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/** Who a link would go to. Empty when e-mail is not set up or every address is a client's. */
export async function linkRecipients(env: Env): Promise<string[]> {
  if (!emailReady(env)) return [];
  return operatorAddresses(env, configFrom(await getSettings(env.DB)), await watchedAccountIds(env));
}

type Refusal = { ok: false; status: 409 | 429 | 502; error: string };

/** Claims one of this hour's links. Atomic, so concurrent requests cannot pass the limit together. */
async function claimHourly(db: D1Database, now: number, key = HOURLY_KEY, limit = PER_HOUR): Promise<boolean> {
  const row = await db.prepare(
    `INSERT INTO login_attempts (ip, fails, window_start, locked_until) VALUES (?3, 1, ?1, 0)
     ON CONFLICT(ip) DO UPDATE SET
       fails = CASE WHEN window_start <= ?1 - ?2 THEN 1 ELSE fails + 1 END,
       window_start = CASE WHEN window_start <= ?1 - ?2 THEN ?1 ELSE window_start END
     RETURNING fails`,
  ).bind(now, HOUR, key).first<{ fails: number }>();
  return (row?.fails ?? limit + 1) <= limit;
}

/**
 * Sends a sign-in link to the operators. `origin` is the dashboard's own (the request URL), so the
 * link opens where it was asked for. Returns the cookie that ties the link to this browser.
 */
export async function requestLink(env: Env, origin: string, ip: string, now = Date.now()): Promise<{ ok: true; cookie: string } | Refusal> {
  const db = env.DB;
  const to = await linkRecipients(env);
  if (!to.length) return { ok: false, status: 409, error: 'Sign-in links are off: e-mail is not set up, or no address in DIGEST_TO gets all-account mail.' };
  if (!(await claimHourly(db, now, `${CLIENT_LINK_PREFIX}${attemptKey(ip)}`, PER_CLIENT_HOUR))) {
    return { ok: false, status: 429, error: 'Two links were asked for from this address in the last hour. Check your inbox, or try again later.' };
  }
  if (!(await claimCooldown(db, 'cooldown:signin-link', new Date(now), COOLDOWN_MS))) {
    return { ok: false, status: 429, error: 'A link was sent less than a minute ago. Check your inbox, or try again in a minute.' };
  }
  if (!(await claimHourly(db, now))) return { ok: false, status: 429, error: 'Five links were sent in the last hour. Try again later.' };

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const browser = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenDigest = await digest(token);
  // Only expired links go: an open one may be the link an operator is about to use.
  await db.batch([
    db.prepare('DELETE FROM signin_links WHERE expires_at <= ?1').bind(now),
    db.prepare('INSERT INTO signin_links (digest, browser, expires_at) VALUES (?1, ?2, ?3)').bind(tokenDigest, await digest(browser), now + LINK_MS),
  ]);
  const url = `${origin}/#/link/${token}`;
  const when = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  const from = ip && ip !== 'unknown' ? ip : 'an unknown address';
  const text = [
    'Someone asked to sign in to your Ambersight dashboard.',
    '',
    `Sign in: ${url}`,
    '',
    `Asked for at ${when} UTC from ${from}. The link works once, for 10 minutes, and only in the browser where it was asked for.`,
    '',
    'If this was not you, do not open the link. Nobody can use it from another browser. If these keep arriving, put Cloudflare Access in front of the dashboard.',
  ].join('\n');
  const html = `<p>Someone asked to sign in to your Ambersight dashboard.</p>
<p><a href="${esc(url)}">Sign in to Ambersight</a></p>
<p>Asked for at ${esc(when)} UTC from ${esc(from)}. The link works once, for 10 minutes, and only in the browser where it was asked for.</p>
<p>If this was not you, do not open the link. Nobody can use it from another browser. If these keep arriving, put Cloudflare Access in front of the dashboard.</p>`;
  try {
    await sendEmail(env, to, 'Sign in to Ambersight', { html, text });
  } catch (e) {
    await db.prepare('DELETE FROM signin_links WHERE digest = ?1').bind(tokenDigest).run();
    console.error(safeError((e as Error).message));
    return { ok: false, status: 502, error: 'The e-mail could not be sent. Check the e-mail setup, or sign in another way.' };
  }
  return { ok: true, cookie: `${LINK_COOKIE}=${browser}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${LINK_MS / 1000}` };
}

/** Clears the browser's link cookie, after any attempt to use a link. */
export const CLEAR_LINK_COOKIE = `${LINK_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

const NO_LINK = 'This link is used or expired. Ask for a new link.';
const OTHER_BROWSER = 'This link only works in the browser where it was asked for. Ask for a new link here.';

/**
 * Signs in with an e-mailed link. The link is spent by any attempt that names it, even one from
 * another browser: a link that turns up somewhere else is not trusted again.
 */
export async function confirmLink(env: Env, token: unknown, cookieHeader: string | null, now = Date.now()): Promise<LoginResult> {
  const db = env.DB;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { ok: false, status: 401, error: NO_LINK };
  const row = await db.prepare('DELETE FROM signin_links WHERE digest = ?1 RETURNING browser, expires_at').bind(await digest(token)).first<{ browser: string; expires_at: number }>();
  if (!row || row.expires_at <= now) return { ok: false, status: 401, error: NO_LINK };
  const browser = readCookie(cookieHeader, LINK_COOKIE);
  if (!browser || !/^[a-f0-9]{64}$/.test(browser)) return { ok: false, status: 401, error: OTHER_BROWSER };
  const [want, got] = [new TextEncoder().encode(row.browser), new TextEncoder().encode(await digest(browser))];
  if (want.length !== got.length || !crypto.subtle.timingSafeEqual(want, got)) return { ok: false, status: 401, error: OTHER_BROWSER };
  const generation = await credentialGeneration(env, await ensureCredSalt(db, await getSettings(db)));
  if (!generation) return { ok: false, status: 500, error: 'Sign-in is off: the ADMIN_PASSPHRASE secret is not set.' };
  const session = await newSession(db, { generation, method: 'link', now });
  await db.batch([
    ...session.statements,
    ...adminEventStatements(db, [{ action: 'signin', target: 'e-mailed link' }], await handleOf(session.id), new Date(now)),
  ]);
  return { ok: true, cookie: session.cookie };
}
