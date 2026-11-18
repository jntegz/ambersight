// Ambersight Worker: JSON API for the dashboard plus the scheduled scan.
// Static assets (the Svelte UI) are served by Cloudflare before this code runs.
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono, type Context } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { ConfigError, defaultConfig, isValidTimeZone, parseConfig, type Config } from '../shared/config';
import { MAX_PASSPHRASE, passphraseProblem } from '../shared/passphrase';
import { adminEventStatements, buildAdminLog, configEvents, handleOf, type AdminEvent } from './adminLog';
import { confirmationValid, CURSOR_REFUSED, cursorValid, personRequest, previewPersonData, removePersonData, type PersonRequest, type PersonStepKind } from './personData';
import { deliverAdminNotices, noticeAudience } from './adminNotice';
import { attributionStep, eraseNow } from './attribution';
import { attemptFailed, attemptKey, attemptSucceeded, checkPassphrase, COOKIE, credentialGeneration, ensureCredSalt, hasSession, login, logout, passphraseChangeStatements, readCookie, reserveAttempt, turnstileOn, verifyTurnstile } from './auth';
import { CfClient } from './cf';
import { claimCooldown, configFrom, getSettings, listAccounts, pinnedAccounts, recordUsage, setSettings, upsertAccount, type AccountRow } from './db';
import type { Env, ScanMessage } from './env';
import { metered } from './meter';
import { buildAnalytics, buildWorkerDetail, parseRange } from './analytics';
import { bumpRevision } from './history';
import { buildChangesSince, buildFindingHistory, buildFindingsList } from './findingsView';
import { hashText } from './scan';
import { accountChoice, authorizeToken, createToken, DEFAULT_TOKEN_DAYS, listTokens, revokeToken, settleOlderTokens, tokenMayRead, type TokenGrant } from './tokens';
import { plainFinding, plainPackages, plainTimeline, plainWorker, tokenAccounts, tokenOverview, tokenSelfCost } from './tokenView';
import { sendTest, watchedAccountIds } from './notify';
import { buildAccounts, buildOverview, buildSelfCost, buildTimeline, pickAccount } from './overview';
import { buildPackages, repoAllowlist } from './packages';
import { buildResources } from './resources';
import { safeError } from './redact';
import { reportHtml } from './report';
import { handleQueueMessage, scanAccount, scheduledRun } from './scheduler';
import { setupStatus } from './setup';
import { VERSION } from './version';

type AppEnv = { Bindings: Env; Variables: { viaToken?: boolean; grant?: TokenGrant } };

const app = new Hono<AppEnv>();

// The app's own request count for the Self-cost panel, written in batches instead of one D1 row
// per request. Kept per isolate: at most USAGE_FLUSH_REQUESTS requests or USAGE_FLUSH_MS of
// counts can be lost when Cloudflare recycles the isolate, which the panel says.
const USAGE_FLUSH_REQUESTS = 10;
const USAGE_FLUSH_MS = 5 * 60_000;
const pendingUsage = { apiRequests: 0, rowsRead: 0, rowsWritten: 0, since: 0 };

/** Test only: the counts not written yet, and a way to flush them. */
export const usageBuffer = {
  pending: () => ({ ...pendingUsage }),
  reset: () => Object.assign(pendingUsage, { apiRequests: 0, rowsRead: 0, rowsWritten: 0, since: 0 }),
};

// Security headers on every API response, and the app's own request count for the Self-cost panel.
app.use('/api/*', async (c, next) => {
  const { db, meter } = metered(c.env.DB);
  const raw = c.env.DB;
  c.env = { ...c.env, DB: db };
  await next();
  // Only views read with an API token revalidate with an ETag; nothing else is ever stored, so the
  // browser's HTTP cache holds no dashboard data that signing out could not reach.
  if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  // The client report sets its own policy, which also forbids framing.
  if (!c.res.headers.get('Content-Security-Policy')) c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  const now = Date.now();
  pendingUsage.apiRequests++;
  pendingUsage.rowsRead += meter.rowsRead;
  pendingUsage.rowsWritten += meter.rowsWritten;
  pendingUsage.since ||= now;
  if (pendingUsage.apiRequests < USAGE_FLUSH_REQUESTS && now - pendingUsage.since < USAGE_FLUSH_MS) return;
  const u = { ...pendingUsage };
  usageBuffer.reset();
  const write = recordUsage(raw, new Date(now), u).run().catch(() => {});
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    await write; // no execution context (tests)
  }
});

const REFUSED_ORIGIN = 'Request refused: it did not come from this dashboard.';

// SameSite=Strict still lets same-site pages (other *.workers.dev Workers, other hosts in the zone)
// send the session cookie. Hono's csrf() only looks at form-like, text/plain and type-less requests
// and passes everything else, so every change must also show that it comes from this page: the
// browser's Sec-Fetch-Site says same-origin (or, where it is not sent, Origin is this origin) and
// the body type is JSON, which the dashboard always sends and another site cannot send without a
// preflight this API never answers. A request with neither signal is refused.
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const site = c.req.header('Sec-Fetch-Site');
  const sameOrigin = site ? site === 'same-origin' : c.req.header('Origin') === new URL(c.req.url).origin;
  if (!sameOrigin || !/^application\/json\s*(;|$)/i.test(c.req.header('Content-Type') ?? '')) throw new HTTPException(403, { message: REFUSED_ORIGIN });
  return next();
});
app.use('/api/*', csrf());

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

app.get('/api/session', async (c) =>
  c.json({
    authenticated: await hasSession(c.env, c.req.header('Cookie') ?? null),
    // Public by design: the site key is meant to be shown to every visitor of the sign-in page.
    turnstileSiteKey: turnstileOn(c.env) ? c.env.TURNSTILE_SITE_KEY : null,
  }),
);

app.post('/api/login', async (c) => {
  const body = await c.req.json<{ passphrase?: unknown; turnstile?: unknown }>().catch(() => ({ passphrase: undefined, turnstile: undefined }));
  if (typeof body.passphrase !== 'string' || body.passphrase.length > 512) return c.json({ error: 'Passphrase required.' }, 400);
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if (!(await verifyTurnstile(c.env, body.turnstile, ip))) return c.json({ error: 'The browser check did not pass. Try again.' }, 400);
  // Reaching this line with Turnstile configured means the check above passed.
  const result = await login(c.env, body.passphrase, ip, Date.now(), { turnstilePassed: turnstileOn(c.env), cookieHeader: c.req.header('Cookie') ?? null });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  c.header('Set-Cookie', result.cookie);
  if (result.deviceCookie) c.header('Set-Cookie', result.deviceCookie, { append: true });
  return c.json({ ok: true });
});

app.post('/api/logout', async (c) => {
  c.header('Set-Cookie', await logout(c.env, c.req.header('Cookie') ?? null));
  return c.json({ ok: true });
});

// Everything below requires a session, or a read-only API token for the GET routes it may read.
app.use('/api/*', async (c, next) => {
  if (await hasSession(c.env, c.req.header('Cookie') ?? null)) return next();
  const bearer = c.req.header('Authorization');
  if (bearer) {
    const grant = tokenMayRead(c.req.method, c.req.path) ? await authorizeToken(c.env, bearer) : null;
    if (grant) {
      c.set('viaToken', true);
      c.set('grant', grant);
      return next();
    }
    return c.json({ error: 'This token is not valid, or cannot read this route. API tokens are read-only.' }, 401);
  }
  return c.json({ error: 'Not signed in.', code: 'not_signed_in' }, 401);
});

/** The dashboard recognizes this refusal, forgets its remembered account and loads the default. */
const UNKNOWN_ACCOUNT = 'unknown_account';

/** A token limited to accounts of which none is watched now. */
const NO_PERMITTED_ACCOUNT = 'no_permitted_account';
const noPermittedAccount = () => new HTTPException(403, { message: 'This token may not read any account this install watches.', cause: NO_PERMITTED_ACCOUNT });

/**
 * The one way a request picks an account. A request that names one gets exactly that watched
 * account or a 404 with no account data; only a request naming none gets the first watched one.
 * For a token limited to some accounts, the others do not exist: naming one gets the same 404, and
 * naming none gets the first watched account it may read.
 */
async function resolveAccount(c: Context<AppEnv>, requested: string | undefined): Promise<AccountRow | null> {
  const { account, accounts } = await pickAccount(c.env, requested || undefined);
  const allowed = c.get('grant')?.accounts;
  const refused = allowed && account && !allowed.includes(account.id);
  if (requested && (!account || refused)) throw new HTTPException(404, { message: 'That account is not watched by this install.', cause: UNKNOWN_ACCOUNT });
  if (!allowed || requested) return account;
  const first = accounts.find((a) => allowed.includes(a.id));
  if (!first) throw noPermittedAccount();
  return first;
}

/** For a token, the ids of the watched accounts it may read. Undefined for a session. */
async function tokenAccountIds(c: Context<AppEnv>): Promise<string[] | undefined> {
  const grant = c.get('grant');
  if (!grant) return undefined;
  const ids = (await pickAccount(c.env)).accounts.map((a) => a.id).filter((id) => !grant.accounts || grant.accounts.includes(id));
  if (grant.accounts && !ids.length) throw noPermittedAccount();
  return ids;
}

/** A token without the person-linked grant. Sessions and tokens with it read the full view. */
const withoutPeople = (c: Context<AppEnv>) => c.get('grant')?.people === false;

/** The resolved account id for routes that need one. */
async function accountOf(c: Context<AppEnv>, requested: string | undefined): Promise<string> {
  const account = await resolveAccount(c, requested);
  if (!account) throw new HTTPException(400, { message: 'No account is set up yet.' });
  return account.id;
}

/** The same for views that also render before setup: '' when no account exists yet. */
const viewAccount = async (c: Context<AppEnv>, requested: string | undefined) => (await resolveAccount(c, requested))?.id ?? '';

/** Timeline lengths the dashboard offers. Any other value rounds up to one of these. */
const TIMELINE_DAYS = [7, 14, 30];
function timelineDays(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return 14;
  return TIMELINE_DAYS.find((d) => d >= n) ?? 30;
}

/**
 * A view built once per change and served from one D1 row until the next: the ETag carries the
 * change counter (bumped by every scan, acknowledge, snooze and settings save) and the hour, so an
 * API client that already has it gets a 304 after one small read. A signed-in browser gets neither
 * the ETag nor a 304: these bodies name people, and a copy in its HTTP cache would outlive sign-out.
 * `view` and `key` must come from fixed sets and resolved ids, never from request text, or requests
 * could add rows at will. Tokens therefore share a few fixed copies of a view, one per kind of grant,
 * never one per token. The ETag a token gets also carries its grant, so that no two grants validate
 * each other's copy. The counter moves with every account, so a token limited to some accounts gets
 * a tag made from the body it receives instead, and never sees the counter or when others change.
 * `narrow` cuts the stored body down for this request, after the cache.
 */
async function cachedJson(c: Context<AppEnv>, view: string, key: string, build: () => Promise<unknown>, narrow?: (body: string) => string) {
  const db = c.env.DB;
  const rev = (await db.prepare(`SELECT value FROM settings WHERE key = 'data_rev'`).first<string>('value')) ?? '0';
  const stamp = `${VERSION}.${rev}.${new Date().toISOString().slice(0, 13)}`;
  const etag = `W/"${stamp}.${hashText(`${view}|${key}`)}"`;
  const viaToken = c.get('viaToken') === true;
  const grant = c.get('grant');
  const scope = grant ? `${view}|${key}|${grant.people ? 'people' : 'plain'}|${grant.accounts?.join(',') ?? '*'}` : '';
  const limited = Boolean(grant?.accounts);
  const clientTag = grant ? `W/"${stamp}.${hashText(scope)}"` : etag;
  const headersFor = (tag: string): Record<string, string> => (viaToken ? { ETag: tag, 'Cache-Control': 'private, no-cache' } : { 'Cache-Control': 'no-store' });
  if (viaToken && !limited && c.req.header('If-None-Match') === clientTag) return c.body(null, 304, headersFor(clientTag));
  const cached = await db.prepare('SELECT etag, body FROM view_cache WHERE account = ?1 AND view = ?2').bind(key, view).first<{ etag: string; body: string }>();
  let body = cached?.etag === etag ? cached.body : null;
  if (body === null) {
    body = JSON.stringify(await build());
    // D1 rows are limited to 2 MB; a fleet that large is simply built on every request.
    if (body.length < 1_500_000) {
      const write = db.prepare(
        `INSERT INTO view_cache (account, view, etag, body) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(account, view) DO UPDATE SET etag = excluded.etag, body = excluded.body`,
      ).bind(key, view, etag, body).run().catch(() => {});
      try {
        c.executionCtx.waitUntil(write);
      } catch {
        await write;
      }
    }
  }
  const sent = narrow ? narrow(body) : body;
  const headers = headersFor(limited ? await bodyTag(scope, sent) : clientTag);
  if (limited && c.req.header('If-None-Match') === headers.ETag) return c.body(null, 304, headers);
  return c.body(sent, 200, { ...headers, 'Content-Type': 'application/json; charset=UTF-8' });
}

/** The ETag of one grant's copy of a body: it changes only when what this token reads changes. */
async function bodyTag(scope: string, body: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${VERSION}|${scope}|${body}`));
  return `W/"${[...new Uint8Array(hash).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

/**
 * A view that names people: tokens without the grant read their own copy, with the people taken out.
 * The mark goes in front: a view name can end in a Worker's name, which could itself end in "-plain".
 */
function peopleView<T>(c: Context<AppEnv>, view: string, key: string, build: () => Promise<T>, plain: (v: T) => T) {
  return withoutPeople(c) ? cachedJson(c, `plain-${view}`, key, async () => plain(await build())) : cachedJson(c, view, key, build);
}

/** The account list cut down to a token's accounts. It is small, so this costs less than a copy per grant. */
function onlyAccounts(body: string, allowed: string[]): string {
  const list = (JSON.parse(body) as { id: string }[]).filter((a) => allowed.includes(a.id));
  if (!list.length) throw noPermittedAccount();
  return JSON.stringify(list);
}

app.get('/api/overview', async (c) => {
  const account = await viewAccount(c, c.req.query('account'));
  const grant = c.get('grant');
  if (!grant) return cachedJson(c, 'overview', account, () => buildOverview(c.env, account || undefined));
  // API tokens get their own cached copies: at most four per account, one per kind of grant.
  const view = `overview-token${grant.accounts ? '-limited' : ''}${grant.people ? '' : '-plain'}`;
  return cachedJson(c, view, account, async () => tokenOverview(await buildOverview(c.env, account || undefined), grant, configFrom(await getSettings(c.env.DB))));
});
app.get('/api/accounts', (c) => {
  const grant = c.get('grant');
  if (!grant) return cachedJson(c, 'accounts', '', () => buildAccounts(c.env));
  const allowed = grant.accounts;
  return cachedJson(c, grant.people ? 'accounts-token' : 'accounts-token-plain', '', async () => tokenAccounts(await buildAccounts(c.env), grant, configFrom(await getSettings(c.env.DB))),
    allowed ? (body) => onlyAccounts(body, allowed) : undefined);
});
app.get('/api/timeline', async (c) => {
  const account = await accountOf(c, c.req.query('account'));
  const days = timelineDays(c.req.query('days'));
  return peopleView(c, `timeline-${days}`, account, () => buildTimeline(c.env, account, days), plainTimeline);
});
app.get('/api/packages', async (c) => {
  const account = await accountOf(c, c.req.query('account'));
  return peopleView(c, 'packages', account, async () => buildPackages(c.env.DB, account, configFrom(await getSettings(c.env.DB)), Boolean(c.env.GITHUB_TOKEN), repoAllowlist(c.env.GITHUB_REPO_ALLOWLIST)), plainPackages);
});
app.get('/api/resources', async (c) => {
  const account = await accountOf(c, c.req.query('account'));
  return cachedJson(c, 'resources', account, async () => buildResources(c.env.DB, account, configFrom(await getSettings(c.env.DB))));
});
/** Fleet analytics: trends, cost, limits, storage growth and reliability for one range. */
app.get('/api/analytics', async (c) => {
  const range = parseRange(c.req.query('range'), '30d');
  const account = await viewAccount(c, c.req.query('account'));
  return cachedJson(c, `analytics-${range}`, account, () => buildAnalytics(c.env, account || undefined, range));
});
/** Everything about one Worker over one range. Only Workers in the inventory are stored. */
app.get('/api/workers/:name', async (c) => {
  const range = parseRange(c.req.query('range'), '7d');
  const name = c.req.param('name');
  if (name.length > 200) return c.json({ error: 'Unknown Worker.' }, 400);
  const account = await viewAccount(c, c.req.query('account'));
  const build = () => buildWorkerDetail(c.env, account || undefined, name, range);
  const known = await c.env.DB.prepare('SELECT 1 AS ok FROM workers WHERE account = ?1 AND name = ?2').bind(account, name).first('ok');
  if (known) return peopleView(c, `worker-${range}-${name}`, account, build, plainWorker);
  const detail = await build();
  return c.json(withoutPeople(c) ? plainWorker(detail) : detail);
});
app.get('/api/self-cost', async (c) => {
  const cost = await buildSelfCost(c.env, await accountOf(c, c.req.query('account')));
  const grant = c.get('grant');
  return c.json(grant ? tokenSelfCost(cost, grant) : cost);
});

/** Acknowledging or snoozing at least this many findings at once also tells the operators. */
const BULK_NOTICE_AT = 10;

/**
 * The admin log statements for a change made by this session, to go in the batch that makes it.
 * `configs` are the settings before and after, whose operators hear about it.
 */
async function adminLog(c: Context<AppEnv>, events: AdminEvent[], configs: Config[] = []): Promise<D1PreparedStatement[]> {
  if (!events.length) return [];
  let to: string[] = [];
  if (events.some((e) => e.notice)) {
    const settings = await getSettings(c.env.DB);
    to = noticeAudience(c.env, configs.length ? configs : [configFrom(settings)], settings.admin_notice_to, await watchedAccountIds(c.env));
  }
  return adminEventStatements(c.env.DB, events, await handleOf(readCookie(c.req.header('Cookie') ?? null, COOKIE)), new Date(), to);
}

/** Sends the notice once the change is stored. A failure never fails the change: the cron tries again. */
async function sendNotices(c: Context<AppEnv>, events: AdminEvent[]) {
  if (!events.some((e) => e.notice)) return;
  const run = deliverAdminNotices(c.env).catch((e) => console.error(e));
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    await run; // no execution context (tests)
  }
}

/** Records changes that were already stored. The log must not undo or fail them. */
async function logAfter(c: Context<AppEnv>, events: AdminEvent[]) {
  try {
    const statements = await adminLog(c, events);
    if (statements.length) await c.env.DB.batch(statements);
    await sendNotices(c, events);
  } catch (e) {
    console.error(e);
  }
}

/** A manual scan of one account, and a test message on one channel, run at most this often. */
const SCAN_COOLDOWN_MS = 60_000;
const NOTIFY_TEST_COOLDOWN_MS = 60_000;

app.post('/api/scan', async (c) => {
  const body = await c.req.json<{ account?: unknown }>().catch(() => ({}) as { account?: unknown });
  const account = await accountOf(c, typeof body.account === 'string' ? body.account : undefined);
  const now = new Date();
  if (!(await claimCooldown(c.env.DB, `cooldown:scan:${account}`, now, SCAN_COOLDOWN_MS))) {
    return c.json({ skipped: true, workers: 0, findings: 0, subrequests: 0, warnings: [] });
  }
  const r = await scanAccount(c.env, account, now, true);
  return 'error' in r ? c.json({ error: `The scan failed: ${r.error}` }, 502) : c.json(r);
});

/** Client report for one account: printable HTML. */
app.get('/api/report', async (c) => {
  const days = c.req.query('days') === '30' ? 30 : 7;
  const { html } = await reportHtml(c.env, await accountOf(c, c.req.query('account')), days, undefined, withoutPeople(c));
  // The report is static HTML with inline styles: no scripts at all.
  return c.html(html, 200, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
});
/** Choose which accounts to watch (Settings › Accounts). Only accounts the token can see. */
app.put('/api/accounts', async (c) => {
  if (pinnedAccounts(c.env.CF_ACCOUNT_ID)) return c.json({ error: 'CF_ACCOUNT_ID pins the accounts. Change it in wrangler.jsonc.' }, 400);
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === 'string'))].slice(0, 50) : [];
  if (!ids.length) return c.json({ error: 'Watch at least one account.' }, 400);
  const visible = await CfClient.accounts(c.env.CF_API_TOKEN);
  const byId = new Map(visible.map((a) => [a.id, a]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) return c.json({ error: 'The token cannot see one of those accounts.' }, 400);
  const known = await listAccounts(c.env.DB, true);
  const events = accountEvents(known, ids, (id) => byId.get(id)?.name);
  await c.env.DB.batch([
    ...ids.map((id) => upsertAccount(c.env.DB, { id, name: byId.get(id)!.name, enabled: true })),
    ...known.filter((a) => !ids.includes(a.id)).map((a) => upsertAccount(c.env.DB, { id: a.id, enabled: false })),
    bumpRevision(c.env.DB),
    ...(await adminLog(c, events)),
  ]);
  await sendNotices(c, events);
  return c.json(await buildAccounts(c.env));
});

/** The log entry for a change of watched accounts. Accounts that stop being watched stop alerting. */
function accountEvents(known: AccountRow[], watch: string[], nameOf: (id: string) => string | undefined): AdminEvent[] {
  const label = (id: string) => nameOf(id) ?? known.find((a) => a.id === id)?.name ?? id;
  const before = known.filter((a) => a.enabled).map((a) => a.id);
  const stopped = before.filter((id) => !watch.includes(id));
  const started = watch.filter((id) => !before.includes(id));
  if (!stopped.length && !started.length) return [];
  const parts = [...(stopped.length ? [`stopped watching ${stopped.map(label).join(', ')}`] : []), ...(started.length ? [`started watching ${started.map(label).join(', ')}`] : [])];
  return [{ action: 'accounts.changed', target: parts.join('; '), notice: stopped.length > 0 }];
}

/**
 * Status changes by a person, in one batch: the change itself, its event in the finding's history
 * and the change counter. `from` is the status a finding must have for the change to apply.
 */
function statusChange(db: D1Database, ids: string[], to: 'acknowledged' | 'snoozed' | 'open', until: string | null) {
  const from = to === 'open' ? ['acknowledged', 'snoozed'] : ['open'];
  const kind = to === 'open' ? 'restored' : to;
  const now = new Date().toISOString();
  const json = JSON.stringify(ids);
  return db.batch([
    db.prepare(
      `INSERT INTO finding_events (account, finding_id, at, kind, severity, check_id, script)
       SELECT account, id, ?2, ?3, severity, module || ':' || code, script FROM findings
       WHERE id IN (SELECT value FROM json_each(?1)) AND status IN (SELECT value FROM json_each(?4))`,
    ).bind(json, now, kind, JSON.stringify(from)),
    db.prepare(
      `UPDATE findings SET status = ?2, snooze_until = ?3, status_at = ?5
       WHERE id IN (SELECT value FROM json_each(?1)) AND status IN (SELECT value FROM json_each(?4))`,
    ).bind(json, to, until, JSON.stringify(from), now),
    bumpRevision(db),
  ]).then((r) => r[1].meta.changes ?? r[1].meta.rows_written ?? 0);
}

const snoozeUntil = (days: unknown) => new Date(Date.now() + ([7, 30, 90].includes(Number(days)) ? Number(days) : 7) * 86_400_000).toISOString();

/** Log entry for findings taken out of "Needs attention" by a person. */
function quietedEvents(to: 'acknowledged' | 'snoozed' | 'open', changed: number): AdminEvent[] {
  if (to === 'open' || !changed) return [];
  return [{ action: `findings.${to}`, target: `${changed} ${changed === 1 ? 'finding' : 'findings'}`, notice: changed >= BULK_NOTICE_AT }];
}

app.post('/api/findings/:id/acknowledge', async (c) => {
  await logAfter(c, quietedEvents('acknowledged', await statusChange(c.env.DB, [c.req.param('id')], 'acknowledged', null)));
  return c.json({ ok: true });
});

app.post('/api/findings/:id/snooze', async (c) => {
  const { days } = await c.req.json<{ days?: number }>().catch(() => ({ days: 7 }));
  const until = snoozeUntil(days);
  await logAfter(c, quietedEvents('snoozed', await statusChange(c.env.DB, [c.req.param('id')], 'snoozed', until)));
  return c.json({ ok: true, until });
});

/** Undo an acknowledge or a snooze: the finding is back in "Needs attention". */
app.post('/api/findings/:id/restore', async (c) => {
  await statusChange(c.env.DB, [c.req.param('id')], 'open', null);
  return c.json({ ok: true });
});

/** Acknowledge, snooze or restore many findings at once (a whole group). */
app.post('/api/findings/bulk', async (c) => {
  const body = await c.req.json<{ ids?: unknown; action?: string; days?: number }>().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 500) : [];
  const actions: Record<string, 'acknowledged' | 'snoozed' | 'open'> = { acknowledge: 'acknowledged', snooze: 'snoozed', restore: 'open' };
  const to = Object.hasOwn(actions, body?.action ?? '') ? actions[body!.action!] : undefined;
  if (!ids.length || !to) return c.json({ error: 'Send ids and an action.' }, 400);
  const changed = await statusChange(c.env.DB, ids, to, to === 'snoozed' ? snoozeUntil(body!.days) : null);
  await logAfter(c, quietedEvents(to, changed));
  return c.json({ ok: true, changed });
});

/** The findings inbox: open, acknowledged, snoozed or recently resolved findings of one account. */
app.get('/api/findings', async (c) => {
  const account = await accountOf(c, c.req.query('account'));
  const status = c.req.query('status') ?? 'open';
  if (!['open', 'acknowledged', 'snoozed', 'resolved'].includes(status)) return c.json({ error: 'Unknown status.' }, 400);
  const list = await buildFindingsList(c.env.DB, account, status as 'open');
  return c.json(withoutPeople(c) ? list.map(plainFinding) : list);
});

/** Findings opened, worse or resolved since a time (the overview's "Since your last visit"). */
app.get('/api/changes', async (c) => {
  const account = await accountOf(c, c.req.query('account'));
  const since = c.req.query('since') ?? '';
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return c.json({ error: 'since must be an ISO time.' }, 400);
  // At most 30 days back; older visits read as "a while ago".
  return c.json(await buildChangesSince(c.env.DB, account, new Date(Math.max(t, Date.now() - 30 * 86_400_000)).toISOString(), withoutPeople(c)));
});

/** One finding's history: every open, resolve, acknowledge, snooze and alert. A token reads only its own accounts' findings. */
app.get('/api/findings/:id/history', async (c) => c.json(await buildFindingHistory(c.env.DB, c.req.param('id'), await tokenAccountIds(c))));

// ---- Setup wizard ----------------------------------------------------------

// Cloudflare adds Cf-Access-Jwt-Assertion to requests that passed Access. Shown as a status only.
const behindAccess = (h: string | undefined) => Boolean(h);

/** The wizard's new passphrase, with the current one that authorizes the change. */
function replacementIn(value: unknown): { current: string; next: string } | null {
  const r = value as { current?: unknown; next?: unknown } | null | undefined;
  return typeof r?.current === 'string' && r.current && r.current.length <= MAX_PASSPHRASE && typeof r.next === 'string' ? { current: r.current, next: r.next } : null;
}

app.get('/api/setup', async (c) =>
  c.json(await setupStatus(c.env, { accountId: c.req.query('account') || undefined, behindAccess: behindAccess(c.req.header('Cf-Access-Jwt-Assertion')) })),
);

app.post('/api/setup/complete', async (c) => {
  const body = await c.req.json<{ timeZone?: unknown; confirmReadOnly?: unknown; accountId?: unknown; accountIds?: unknown; replacePassphrase?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  // accountIds: every account to watch. accountId: older single-account wizards.
  const list = Array.isArray(body.accountIds)
    ? body.accountIds.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 50)
    : typeof body.accountId === 'string' && body.accountId ? [body.accountId] : [];
  const chosen = list[0];
  const status = await setupStatus(c.env, { accountId: chosen });
  const visible = new Set(status.accounts.map((a) => a.id));
  if (!status.accountPinned && list.some((id) => !visible.has(id))) return c.json({ error: 'The token cannot see that account.' }, 400);
  if (!status.tokenActive) return c.json({ error: status.tokenError ?? 'The API token is not active.' }, 400);
  if (status.writeScopes?.length) {
    return c.json({ error: `The token has write permissions (${status.writeScopes.join(', ')}). Create a read-only token and update CF_API_TOKEN.` }, 400);
  }
  if (status.writeScopes == null && body.confirmReadOnly !== true) {
    return c.json({ error: 'Ambersight cannot read this token\'s permissions. Confirm that it has read permissions only.' }, 400);
  }
  const settings = await getSettings(c.env.DB);
  const firstSetup = settings.setup_done !== '1';
  // A passphrase chosen in the wizard is applied in the same D1 batch as the rest of setup, so a
  // weak deploy-time passphrase cannot stay behind a finished setup.
  const replacement = replacementIn(body.replacePassphrase);
  if (body.replacePassphrase !== undefined && !replacement) return c.json({ error: 'Current and new passphrase required.' }, 400);
  if (firstSetup && status.passphraseWeak && !replacement) {
    return c.json({ error: 'The ADMIN_PASSPHRASE secret is too easy to guess. Choose a stronger passphrase in the "Protect the dashboard" step.' }, 400);
  }
  if (replacement) {
    const problem = passphraseProblem(replacement.next);
    if (problem) return c.json({ error: problem }, 400);
    const refused = await reauthenticate(c, replacement.current);
    if (refused) return refused;
  }
  const config = settings.config ? configFrom(settings) : defaultConfig();
  if (typeof body.timeZone === 'string' && isValidTimeZone(body.timeZone)) config.timeZone = body.timeZone;
  if (status.detectedPlan === 'paid' && config.scanIntervalMinutes === 60 && !settings.config) config.scanIntervalMinutes = 15;
  const pinned = pinnedAccounts(c.env.CF_ACCOUNT_ID);
  const watch = pinned ?? (list.length ? list : status.accountId ? [status.accountId] : []);
  const names = new Map(status.accounts.map((a) => [a.id, a.name]));
  // Plan detection for the other accounts: one Billing Read call each.
  const plans = await Promise.all(
    watch.map((id) => (id === status.accountId ? Promise.resolve(status.detectedPlan) : new CfClient(c.env.CF_API_TOKEN, id).detectPlan())),
  );
  const known = await listAccounts(c.env.DB, true);
  const confirmedByHand = status.writeScopes == null ? ', read-only confirmed by hand' : '';
  const events: AdminEvent[] = [
    { action: 'setup.completed', target: `${watch.length} ${watch.length === 1 ? 'account' : 'accounts'} watched${confirmedByHand}` },
    ...(firstSetup ? [] : accountEvents(known, watch, (id) => names.get(id))),
    ...(replacement ? [{ action: 'passphrase.changed', target: '', notice: true } satisfies AdminEvent] : []),
  ];
  await c.env.DB.batch([
    setSettings(c.env.DB, { setup_done: '1', config: JSON.stringify(config) }),
    ...watch.map((id, i) => upsertAccount(c.env.DB, { id, name: names.get(id) ?? null, enabled: true, detectedPlan: plans[i] })),
    ...known.filter((a) => !watch.includes(a.id)).map((a) => upsertAccount(c.env.DB, { id: a.id, enabled: false })),
    bumpRevision(c.env.DB),
    ...(replacement ? await passphraseChangeStatements(c.env, replacement.next, settings) : []),
    ...(await adminLog(c, events)),
  ]);
  await sendNotices(c, events);
  // First scan of the first account runs in the background; the scheduler picks up the others.
  // Completing setup again starts nothing: the schedule already covers every watched account.
  const now = new Date();
  if (watch[0] && firstSetup && (await claimCooldown(c.env.DB, `cooldown:scan:${watch[0]}`, now, SCAN_COOLDOWN_MS))) {
    c.executionCtx.waitUntil(scanAccount(c.env, watch[0], now, true).catch((e) => console.error(e)));
  }
  return c.json({ ok: true });
});

// ---- Settings --------------------------------------------------------------

app.get('/api/config', async (c) => c.json(configFrom(await getSettings(c.env.DB))));

app.put('/api/config', async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const config = parseConfig(body);
    const settings = await getSettings(c.env.DB);
    const before = configFrom(settings);
    const attribution = await attributionStep(c.env.DB, body, before, config, settings, new Date());
    if (attribution.refused) return c.json(attribution.refused, 409);
    const events = configEvents(before, config);
    await c.env.DB.batch([setSettings(c.env.DB, { config: JSON.stringify(config) }), ...attribution.statements, bumpRevision(c.env.DB), ...(await adminLog(c, events, [before, config]))]);
    await sendNotices(c, events);
    // Erased after the save, so a scan starting now already leaves the names out.
    if (attribution.erase) return c.json({ ...config, attributionErasure: (await eraseNow(c.env.DB)) ? 'done' : 'running' });
    return c.json(config);
  } catch (e) {
    if (e instanceof ConfigError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.post('/api/notify/test', async (c) => {
  const { channel } = await c.req.json<{ channel?: string }>().catch(() => ({ channel: '' }));
  if (channel !== 'email' && channel !== 'webhook') return c.json({ error: 'channel must be email or webhook.' }, 400);
  if (!(await claimCooldown(c.env.DB, `cooldown:notify:${channel}`, new Date(), NOTIFY_TEST_COOLDOWN_MS))) {
    return c.json({ error: 'A test message was just sent. Try again in a minute.' }, 429);
  }
  try {
    await sendTest(c.env, channel, configFrom(await getSettings(c.env.DB)));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: safeError((e as Error).message) }, 400);
  }
});

// ---- Read-only API tokens (managed with a session only: the token routes are not readable by tokens).

/**
 * Asks a signed-in person for the passphrase again, before something a stolen session should not
 * do alone. Limited per client like sign-in, but outside the install-wide pause: that pause must
 * not stop someone with a session from changing the passphrase during an attack.
 */
async function reauthenticate(c: Context<AppEnv>, passphrase: string): Promise<Response | null> {
  const key = `passphrase:${attemptKey(c.req.header('CF-Connecting-IP') ?? 'unknown')}`;
  const refused = await reserveAttempt(c.env, key, Date.now(), { global: false });
  if (refused) return c.json({ error: refused.error }, refused.status);
  if (!(await checkPassphrase(c.env, passphrase, await getSettings(c.env.DB)))) {
    await attemptFailed(c.env, key);
    return c.json({ error: 'The current passphrase is wrong.' }, 401);
  }
  await attemptSucceeded(c.env, key, Date.now(), { global: false });
  return null;
}

/** Settings › Security: the admin log. Session only: API tokens cannot read this route. */
app.get('/api/admin-events', async (c) => c.json(await buildAdminLog(c.env.DB)));

app.get('/api/tokens', async (c) => c.json(await listTokens(c.env)));
app.post('/api/tokens', async (c) => {
  const body = await c.req.json<{ name?: unknown; days?: unknown; passphrase?: unknown; accounts?: unknown; people?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.passphrase !== 'string' || !body.passphrase || body.passphrase.length > MAX_PASSPHRASE) return c.json({ error: 'Enter your passphrase to create a token.' }, 400);
  const refused = await reauthenticate(c, body.passphrase);
  if (refused) return refused;
  const generation = await credentialGeneration(c.env, await ensureCredSalt(c.env.DB, await getSettings(c.env.DB)));
  if (!generation) return c.json({ error: 'ADMIN_PASSPHRASE secret is not set.' }, 500);
  const days = body.days === undefined ? DEFAULT_TOKEN_DAYS : Number(body.days);
  const accounts = accountChoice(body.accounts, (await pickAccount(c.env)).accounts.map((a) => a.id));
  if (accounts !== 'all' && !Array.isArray(accounts)) return c.json({ error: accounts.error }, 400);
  const people = body.people === true;
  const r = await createToken(c.env.DB, typeof body.name === 'string' ? body.name : '', { days, generation, accounts, people });
  if ('error' in r) return c.json({ error: r.error }, 400);
  const reach = accounts === 'all' ? 'all accounts' : `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`;
  await logAfter(c, [{ action: 'token.created', target: `${r.info.name} (…${r.info.hint}, ${days} days, ${reach}${people ? ', with person-linked data' : ''})`, notice: true }]);
  return c.json(r);
});
app.delete('/api/tokens/:id', async (c) => {
  const id = c.req.param('id');
  const t = await c.env.DB.prepare('SELECT name, hint FROM api_tokens WHERE id = ?1').bind(id).first<{ name: string; hint: string }>();
  if (!t || !(await revokeToken(c.env.DB, id))) return c.json({ error: 'No such token.' }, 404);
  await logAfter(c, [{ action: 'token.revoked', target: `${t.name} (…${t.hint})` }]);
  return c.json({ ok: true });
});

app.post('/api/passphrase', async (c) => {
  const body = await c.req.json<{ current?: unknown; next?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.current !== 'string' || typeof body.next !== 'string') return c.json({ error: 'Current and new passphrase required.' }, 400);
  const problem = passphraseProblem(body.next);
  if (problem) return c.json({ error: problem }, 400);
  // Limited per client, so a stolen session cannot guess the passphrase without limit.
  const refused = await reauthenticate(c, body.current);
  if (refused) return refused;
  const events: AdminEvent[] = [{ action: 'passphrase.changed', target: '', notice: true }];
  await c.env.DB.batch([
    ...(await passphraseChangeStatements(c.env, body.next, await getSettings(c.env.DB))),
    ...(await adminLog(c, events)),
  ]);
  await sendNotices(c, events);
  return c.json({ ok: true });
});

// ---- One person's stored data: session only, and the identifier is neither logged nor stored.

type PersonBody = { identifier?: unknown; cursor?: unknown; passphrase?: unknown; confirmation?: unknown };

/** The shared part of both steps. A failure is logged without its message, which could quote the input. */
async function personDataRoute(c: Context<AppEnv>, kind: PersonStepKind, run: (req: PersonRequest, session: string, body: PersonBody) => Promise<Response>) {
  const session = readCookie(c.req.header('Cookie') ?? null, COOKIE);
  if (c.get('viaToken') || !session) return c.json({ error: 'This needs a signed-in dashboard session.' }, 403);
  const body = await c.req.json<PersonBody>().catch(() => ({}) as PersonBody);
  const req = personRequest(body);
  if ('error' in req) return c.json({ error: req.error }, 400);
  try {
    if (!(await cursorValid(session, kind, req))) return c.json({ error: CURSOR_REFUSED }, 400);
    return await run(req, session, body);
  } catch {
    console.error('A personal data step failed.');
    return c.json({ error: 'That step failed. Nothing more was changed; you can safely run it again.' }, 500);
  }
}

/** Step 1: how many stored records hold this identifier, per kind of data. Never the records. */
app.post('/api/personal-data/preview', (c) => personDataRoute(c, 'preview', async (req, session) => {
  const step = await previewPersonData(c.env, req, await getSettings(c.env.DB), session);
  if (step.done) await logAfter(c, [{ action: 'personal-data.previewed', target: '' }]);
  return c.json(step);
}));

/**
 * Step 2: replaces it, one bounded step per request. The first step needs the passphrase and a
 * finished preview of the same identifier. PBKDF2 takes most of a Free plan request's CPU, so later
 * steps instead show the signed cursor the step before them returned.
 */
app.post('/api/personal-data/remove', (c) => personDataRoute(c, 'remove', async (req, session, body) => {
  if (req.first) {
    if (typeof body.passphrase !== 'string' || !body.passphrase || body.passphrase.length > MAX_PASSPHRASE) return c.json({ error: 'Enter your passphrase to confirm.' }, 400);
    if (!(await confirmationValid(session, req.identifier, body.confirmation))) return c.json({ error: 'Preview this identifier first.' }, 400);
    const refused = await reauthenticate(c, body.passphrase);
    if (refused) return refused;
  }
  const { step, events } = await removePersonData(c.env, req, session, (e) => adminLog(c, e));
  await sendNotices(c, events);
  return c.json(step);
}));

app.notFound((c) => c.json({ error: 'Not found.' }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException && err.cause === NO_PERMITTED_ACCOUNT) return c.json({ error: err.message, code: NO_PERMITTED_ACCOUNT }, 403);
  if (err instanceof HTTPException && err.status === 403) return c.json({ error: REFUSED_ORIGIN }, 403);
  if (err instanceof HTTPException && err.status === 400) return c.json({ error: err.message }, 400);
  if (err instanceof HTTPException && err.status === 404) return c.json({ error: err.message, code: err.cause }, 404);
  console.error(err);
  return c.json({ error: 'Something went wrong. Check the Worker logs.' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(settleOlderTokens(env).catch((e) => console.error(e)));
    ctx.waitUntil(scheduledRun(env).then((r) => (r ? console.log(JSON.stringify({ scan: r })) : undefined)));
  },
  // Optional scan queue (SCAN_QUEUE in wrangler.jsonc). Batches are one message each.
  async queue(batch: MessageBatch<ScanMessage>, env: Env) {
    for (const msg of batch.messages) {
      await handleQueueMessage(env, msg.body);
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, ScanMessage>;
