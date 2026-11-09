// Ambersight Worker: JSON API for the dashboard plus the hourly scan.
// Static assets (the Svelte UI) are served by Cloudflare before this code runs.
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import { hasSession, login, logout } from './auth';
import type { Env } from './env';
import { buildOverview } from './overview';
import { runScan } from './scan';

const app = new Hono<{ Bindings: Env }>();

// Security headers on every API response.
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/session', async (c) => c.json({ authenticated: await hasSession(c.env, c.req.header('Cookie') ?? null) }));

app.post('/api/login', async (c) => {
  const body = await c.req.json<{ passphrase?: unknown }>().catch(() => ({ passphrase: undefined }));
  if (typeof body.passphrase !== 'string' || body.passphrase.length > 512) return c.json({ error: 'Passphrase required.' }, 400);
  const result = await login(c.env, body.passphrase);
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

app.post('/api/scan', async (c) => {
  const result = await runScan(c.env);
  return c.json(result);
});

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

app.notFound((c) => c.json({ error: 'Not found.' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong. Check the Worker logs.' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScan(env).then((r) => console.log(JSON.stringify({ scan: r }))));
  },
} satisfies ExportedHandler<Env>;
