// Ambersight Worker: JSON API for the dashboard plus the scheduled scan.
// Static assets (the Svelte UI) are served by Cloudflare before this code runs.
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { ConfigError, defaultConfig, isValidTimeZone, parseConfig } from '../shared/config';
import { attemptFailed, attemptSucceeded, hasSession, hashPassphrase, checkPassphrase, login, logout, reserveAttempt } from './auth';
import { configFrom, getSettings, recordUsage, setSettings } from './db';
import type { Env } from './env';
import { metered } from './meter';
import { sendTest } from './notify';
import { buildOverview, buildSelfCost, buildTimeline } from './overview';
import { runScan } from './scan';
import { setupStatus } from './setup';
import { VERSION } from './version';

const app = new Hono<{ Bindings: Env }>();

// Security headers on every API response, and the app's own request count for the Self-cost panel.
app.use('/api/*', async (c, next) => {
  const { db, meter } = metered(c.env.DB);
  const raw = c.env.DB;
  c.env = { ...c.env, DB: db };
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  const write = recordUsage(raw, new Date(), { apiRequests: 1, rowsRead: meter.rowsRead, rowsWritten: meter.rowsWritten }).run().catch(() => {});
  try {
    c.executionCtx.waitUntil(write);
  } catch {
    await write; // no execution context (tests)
  }
});

// SameSite=Strict still lets same-site pages (other *.workers.dev Workers, other hosts in the zone)
// send the session cookie. Refuse form-like or body-less POSTs that do not come from this origin.
app.use('/api/*', csrf());

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

app.get('/api/session', async (c) => c.json({ authenticated: await hasSession(c.env, c.req.header('Cookie') ?? null) }));

app.post('/api/login', async (c) => {
  const body = await c.req.json<{ passphrase?: unknown }>().catch(() => ({ passphrase: undefined }));
  if (typeof body.passphrase !== 'string' || body.passphrase.length > 512) return c.json({ error: 'Passphrase required.' }, 400);
  const result = await login(c.env, body.passphrase, c.req.header('CF-Connecting-IP') ?? 'unknown');
  if (!result.ok) return c.json({ error: result.error }, result.status);
  c.header('Set-Cookie', result.cookie);
  return c.json({ ok: true });
});

app.post('/api/logout', async (c) => {
  c.header('Set-Cookie', await logout(c.env, c.req.header('Cookie') ?? null));
  return c.json({ ok: true });
});

// Everything below requires a session.
app.use('/api/*', async (c, next) => {
  if (!(await hasSession(c.env, c.req.header('Cookie') ?? null))) return c.json({ error: 'Not signed in.' }, 401);
  await next();
});

app.get('/api/overview', async (c) => c.json(await buildOverview(c.env)));
app.get('/api/timeline', async (c) => c.json(await buildTimeline(c.env, Math.min(30, Math.max(1, Number(c.req.query('days')) || 14)))));
app.get('/api/self-cost', async (c) => c.json(await buildSelfCost(c.env)));

app.post('/api/scan', async (c) => c.json(await runScan(c.env, new Date(), { force: true })));

app.post('/api/findings/:id/acknowledge', async (c) => {
  await c.env.DB.prepare(`UPDATE findings SET status = 'acknowledged' WHERE id = ?1 AND status = 'open'`).bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

app.post('/api/findings/:id/snooze', async (c) => {
  const { days } = await c.req.json<{ days?: number }>().catch(() => ({ days: 7 }));
  const allowed = [7, 30, 90].includes(Number(days)) ? Number(days) : 7;
  const until = new Date(Date.now() + allowed * 86_400_000).toISOString();
  await c.env.DB.prepare(`UPDATE findings SET status = 'snoozed', snooze_until = ?2 WHERE id = ?1 AND status = 'open'`)
    .bind(c.req.param('id'), until)
    .run();
  return c.json({ ok: true, until });
});

/** Acknowledge or snooze many findings at once (a whole group). */
app.post('/api/findings/bulk', async (c) => {
  const body = await c.req.json<{ ids?: unknown; action?: string; days?: number }>().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length || (body?.action !== 'acknowledge' && body?.action !== 'snooze')) return c.json({ error: 'Send ids and an action.' }, 400);
  const days = [7, 30, 90].includes(Number(body.days)) ? Number(body.days) : 7;
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  const stmt = body.action === 'acknowledge'
    ? c.env.DB.prepare(`UPDATE findings SET status = 'acknowledged' WHERE status = 'open' AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids))
    : c.env.DB.prepare(`UPDATE findings SET status = 'snoozed', snooze_until = ?2 WHERE status = 'open' AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids), until);
  const r = await stmt.run();
  return c.json({ ok: true, changed: r.meta.rows_written ?? 0 });
});

// ---- Setup wizard ----------------------------------------------------------

// Cloudflare adds Cf-Access-Jwt-Assertion to requests that passed Access. Shown as a status only.
const behindAccess = (h: string | undefined) => Boolean(h);

app.get('/api/setup', async (c) =>
  c.json(await setupStatus(c.env, { accountId: c.req.query('account') || undefined, behindAccess: behindAccess(c.req.header('Cf-Access-Jwt-Assertion')) })),
);

app.post('/api/setup/complete', async (c) => {
  const body = await c.req.json<{ timeZone?: unknown; confirmReadOnly?: unknown; accountId?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const chosen = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined;
  const status = await setupStatus(c.env, { accountId: chosen });
  if (chosen && !status.accountPinned && status.accountId !== chosen) return c.json({ error: 'The token cannot see that account.' }, 400);
  if (!status.tokenActive) return c.json({ error: status.tokenError ?? 'The API token is not active.' }, 400);
  if (status.writeScopes?.length) {
    return c.json({ error: `The token has write permissions (${status.writeScopes.join(', ')}). Create a read-only token and update CF_API_TOKEN.` }, 400);
  }
  if (status.writeScopes == null && body.confirmReadOnly !== true) {
    return c.json({ error: 'Ambersight cannot read this token\'s permissions. Confirm that it has read permissions only.' }, 400);
  }
  const settings = await getSettings(c.env.DB);
  const config = settings.config ? configFrom(settings) : defaultConfig();
  if (typeof body.timeZone === 'string' && isValidTimeZone(body.timeZone)) config.timeZone = body.timeZone;
  if (status.detectedPlan === 'paid' && config.scanIntervalMinutes === 60 && !settings.config) config.scanIntervalMinutes = 15;
  await setSettings(c.env.DB, {
    setup_done: '1',
    config: JSON.stringify(config),
    account_id: status.accountId ?? '',
    ...(status.detectedPlan ? { detected_plan: status.detectedPlan } : {}),
  }).run();
  // First scan runs in the background; the overview fills in as results arrive.
  c.executionCtx.waitUntil(runScan(c.env, new Date(), { force: true }).catch((e) => console.error(e)));
  return c.json({ ok: true });
});

// ---- Settings --------------------------------------------------------------

app.get('/api/config', async (c) => c.json(configFrom(await getSettings(c.env.DB))));

app.put('/api/config', async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const config = parseConfig(body);
    await setSettings(c.env.DB, { config: JSON.stringify(config) }).run();
    return c.json(config);
  } catch (e) {
    if (e instanceof ConfigError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.post('/api/notify/test', async (c) => {
  const { channel } = await c.req.json<{ channel?: string }>().catch(() => ({ channel: '' }));
  if (channel !== 'email' && channel !== 'webhook') return c.json({ error: 'channel must be email or webhook.' }, 400);
  try {
    await sendTest(c.env, channel);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/passphrase', async (c) => {
  const body = await c.req.json<{ current?: unknown; next?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.current !== 'string' || typeof body.next !== 'string') return c.json({ error: 'Current and new passphrase required.' }, 400);
  if (body.next.length < 12 || body.next.length > 512) return c.json({ error: 'The new passphrase needs at least 12 characters.' }, 400);
  // Same attempt limits as sign-in, so a stolen session cannot guess the passphrase without limit.
  const key = `passphrase:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
  const refused = await reserveAttempt(c.env, key);
  if (refused) return c.json({ error: refused.error }, refused.status);
  const settings = await getSettings(c.env.DB);
  if (!(await checkPassphrase(c.env, body.current, settings.passphrase_hash))) {
    await attemptFailed(c.env, key);
    return c.json({ error: 'The current passphrase is wrong.' }, 401);
  }
  await attemptSucceeded(c.env, key);
  await c.env.DB.batch([
    setSettings(c.env.DB, { passphrase_hash: await hashPassphrase(body.next) }),
    // Sign out every other session.
    c.env.DB.prepare('DELETE FROM sessions'),
  ]);
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: 'Not found.' }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 403) return c.json({ error: 'Request refused: it did not come from this dashboard.' }, 403);
  console.error(err);
  return c.json({ error: 'Something went wrong. Check the Worker logs.' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScan(env).then((r) => (r.skipped ? undefined : console.log(JSON.stringify({ scan: r })))));
  },
} satisfies ExportedHandler<Env>;
