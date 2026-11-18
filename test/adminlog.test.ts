// The admin log and the notice that goes with changes that reduce detection.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type Config } from '../src/shared/config';
import { MAX_ADMIN_EVENTS } from '../src/shared/adminLog';
import { adminEventStatements, configChanges, handleOf, pruneAdminEvents } from '../src/worker/adminLog';
import { deliverAdminNotices, NOTICE_COOLDOWN_MS, noticeAudience } from '../src/worker/adminNotice';
import { login } from '../src/worker/auth';
import { getSettings, setAccountState, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import worker, { usageBuffer } from '../src/worker/index';
import { scheduledRun } from '../src/worker/scheduler';
import { createToken } from '../src/worker/tokens';
import { createD1 } from './d1';
import { fakeFetch, NOW } from './fixtures';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = 'correct horse battery';
const ORIGIN = 'https://ambersight.example';
const ME = 'me@example.com';
const background: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
const settled = () => Promise.allSettled(background.splice(0));
type Mail = { to: string | string[]; subject: string; text?: string };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  usageBuffer.reset();
});

function setup(over: Partial<Env> = {}) {
  const sent: Mail[] = [];
  const env: Env = {
    DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS,
    EMAIL_FROM: 'ambersight@example.com', DIGEST_TO: `${ME},client@example.com`, EMAIL: { send: async (m) => void sent.push(m) }, ...over,
  };
  return { env, sent };
}

async function session(env: Env) {
  const r = await login(env, PASS, '1.1.1.1');
  if (!r.ok) throw new Error(r.error);
  return r.cookie.split(';')[0];
}
async function send(env: Env, cookie: string, path: string, body: unknown, method = 'POST') {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
    method, body: JSON.stringify(body), headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
  }), env, ctx);
  await settled(); // the notice goes out after the response
  return res;
}
const get = (env: Env, headers: Record<string, string>, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, ctx);
const save = (env: Env, cookie: string, change: (c: Config) => void, base: Config = defaultConfig()) => {
  const c = JSON.parse(JSON.stringify(base)) as Config;
  change(c);
  return send(env, cookie, '/api/config', c, 'PUT');
};
const events = async (env: Env) => (await env.DB.prepare(`SELECT action, target, actor, count, notice FROM admin_events WHERE action <> 'signin' ORDER BY id`).all<{ action: string; target: string; actor: string; count: number; notice: string | null }>()).results;
const addFindings = (env: Env, n: number) => env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare(
  `INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
   VALUES (?1, 'acc1', 'w', 'errors', 'critical', 'e', 'm', '{}', 'a', 'x', 'x', 'open')`).bind(`f${i}`)));

describe('what a settings change counts as', () => {
  const change = (edit: (c: Config) => void) => {
    const after = defaultConfig();
    edit(after);
    return configChanges(defaultConfig(), after);
  };

  it('finds everything that reduces detection', () => {
    const cases: [(c: Config) => void, string][] = [
      [(c) => { c.alerts.critical.instant = 'off'; }, 'critical instant alerts'],
      [(c) => { c.alerts.critical.instant = 'webhook'; }, 'critical instant alerts'],
      [(c) => { c.alerts.critical.digest = false; }, 'left out of the digest'],
      [(c) => { c.alerts.quietHours = { start: '00:00', end: '23:59' }; }, 'quiet hours'],
      [(c) => { c.digest.frequency = 'off'; }, 'digest'],
      [(c) => { c.modules.errors = false; }, 'check errors turned off'],
      [(c) => { c.mutedChecks = ['errors:error-rate']; }, 'checks muted'],
      [(c) => { c.scope.exclude = ['api-*']; }, 'scope excludes api-*'],
      [(c) => { c.scope.include = ['api-*']; }, 'scope limited'],
      [(c) => { c.thresholds.errorCritical = 0.4; }, 'thresholds raised'],
      [(c) => { c.overrides = { api: { errorCritical: 0.4 } }; }, 'overrides raised'],
      [(c) => { c.scanIntervalMinutes = 1440; }, 'scan interval'],
      [(c) => { c.digest.groupRecipients = { g: [ME] }; }, 'digest recipient'],
    ];
    for (const [edit, text] of cases) expect(change(edit).reduced.join(' '), text).toContain(text);
  });

  it('does not call the opposite changes reductions', () => {
    const b = defaultConfig();
    b.alerts.warning.instant = 'off';
    b.mutedChecks = ['errors:error-rate'];
    b.scope.exclude = ['x'];
    const a = defaultConfig();
    a.alerts.warning.instant = 'email';
    a.retentionDays = 14;
    a.thresholds.errorCritical = 0.05;
    expect(configChanges(b, a).reduced).toEqual([]);
    expect(configChanges(b, a).other.join(' ')).toContain('history kept 30 → 14 days');
    expect(configChanges(defaultConfig(), defaultConfig())).toEqual({ reduced: [], other: [] });
  });

  it('never puts an address in the log', () => {
    const { reduced } = change((c) => { c.accounts = { a1: { digestTo: [ME] } }; });
    expect(reduced.join(' ')).not.toContain(ME);
  });

  it('counts removing a strict override as a reduction, and removing a lenient one as not', () => {
    const removed = (value: number) => {
      const b = defaultConfig();
      b.overrides = { api: { errorCritical: value } };
      return configChanges(b, defaultConfig());
    };
    const strict = removed(defaultConfig().thresholds.errorCritical / 2);
    expect(strict.reduced.join(' ')).toContain(`overrides raised: api errorCritical ${defaultConfig().thresholds.errorCritical}`);
    const lenient = removed(defaultConfig().thresholds.errorCritical * 2);
    expect(lenient.reduced).toEqual([]);
    expect(lenient.other).toContain('overrides changed');
  });

  it('records a repository mapping change', () => {
    expect(change((c) => { c.packageRepos = { 'a1:api': { repo: 'acme/api' } }; }).other.join(' ')).toContain('api → acme/api');
  });
});

describe('the admin log', () => {
  it('names the session by a handle that is not its id or stored digest', async () => {
    const { env } = setup();
    const cookie = await session(env);
    await save(env, cookie, (c) => { c.retentionDays = 14; });
    const [e] = await events(env);
    const id = cookie.split('=')[1];
    const stored = (await env.DB.prepare('SELECT id FROM sessions').first<{ id: string }>())!.id;
    expect(e.action).toBe('config.changed');
    expect(e.actor).toBe(await handleOf(id));
    expect(e.actor).toMatch(/^session [0-9a-f]{8}$/);
    expect(id).not.toContain(e.actor.slice(8));
    expect(stored).not.toContain(e.actor.slice(8));
  });

  it('records sign-in only when it succeeds', async () => {
    const { env } = setup();
    expect((await login(env, 'wrong passphrase here', '2.2.2.2')).ok).toBe(false);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_events').first<{ n: number }>())!.n).toBe(0);
    await session(env);
    expect(await env.DB.prepare('SELECT action FROM admin_events').all()).toMatchObject({ results: [{ action: 'signin' }] });
  });

  it('covers tokens, the passphrase, accounts and findings', async () => {
    const { env } = setup();
    vi.stubGlobal('fetch', fakeFetch({ fleets: { acc2: { workers: [], scripts: [] } } }).fn);
    await env.DB.batch([upsertAccount(env.DB, { id: 'acc1' }, NOW), upsertAccount(env.DB, { id: 'acc2', name: 'Second' }, NOW)]);
    const cookie = await session(env);
    const made = await (await send(env, cookie, '/api/tokens', { name: 'Grafana', days: 30, passphrase: PASS, accounts: 'all' })).json() as { info: { id: string } };
    await send(env, cookie, `/api/tokens/${made.info.id}`, {}, 'DELETE');
    await addFindings(env, 2);
    await send(env, cookie, '/api/findings/f0/acknowledge', {});
    await send(env, cookie, '/api/findings/bulk', { ids: ['f1'], action: 'snooze', days: 7 });
    await send(env, cookie, '/api/accounts', { ids: ['acc1'] }, 'PUT');
    await send(env, cookie, '/api/passphrase', { current: PASS, next: 'violet anchor quietly mends' });
    const log = await events(env);
    expect(log.map((e) => e.action)).toEqual(['token.created', 'token.revoked', 'findings.acknowledged', 'findings.snoozed', 'accounts.changed', 'passphrase.changed']);
    expect(log[0].target).toContain('Grafana');
    expect(log[4].target).toBe('stopped watching Account acc2');
    expect(JSON.stringify(log)).not.toContain('amb_');
    expect(JSON.stringify(log)).not.toContain(PASS);
  });

  it('adds repeats to one entry, and starts a new one later or for something else', async () => {
    const { env } = setup();
    const add = (target: string, at: Date) => env.DB.batch(adminEventStatements(env.DB, [{ action: 'findings.acknowledged', target }], 'session a', at));
    await add('1 finding', NOW);
    await add('1 finding', new Date(NOW.getTime() + 60_000));
    await add('2 findings', new Date(NOW.getTime() + 120_000));
    await add('2 findings', new Date(NOW.getTime() + 3_600_000));
    expect((await events(env)).map((e) => [e.target, e.count])).toEqual([['1 finding', 2], ['2 findings', 1], ['2 findings', 1]]);
  });

  it('keeps addresses out of every entry and out of the notice', async () => {
    const { env, sent } = setup();
    const cookie = await session(env);
    // Cloudflare's default name for an account, as the accounts route would log it.
    await env.DB.batch(adminEventStatements(env.DB, [{ action: 'accounts.changed', target: "stopped watching jan.novak@example.org's Account", notice: true }], 'session a', new Date()));
    // A free-text name, through the real route.
    await send(env, cookie, '/api/tokens', { name: 'ops@example.org laptop', days: 30, passphrase: PASS, accounts: 'all' });
    // An address across the length limit must not survive as a fragment.
    await env.DB.batch(adminEventStatements(env.DB, [{ action: 'x', target: `${'y'.repeat(290)} someone@example.org` }], 'session a', new Date()));
    const log = await events(env);
    expect(log[0].target).toBe("stopped watching [email]'s Account");
    expect(log[1].target).toContain('[email] laptop');
    expect(log[2].target).not.toContain('someone');
    expect(JSON.stringify(log)).not.toContain('example.org');
    await deliverAdminNotices(env, new Date(Date.now() + NOTICE_COOLDOWN_MS + 60_000));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((m) => m.text).join(' ')).toContain("[email]'s Account");
    expect(sent.map((m) => `${m.subject} ${m.text}`).join(' ')).not.toContain('example.org');
  });

  it('stays within its limits', async () => {
    const { env } = setup();
    const db = env.DB;
    await db.prepare(`INSERT INTO admin_events (id, at, action, actor) VALUES (?1, ?2, 'old', 's')`).bind(5, new Date(NOW.getTime() - 91 * 86_400_000).toISOString()).run();
    await db.prepare(`INSERT INTO admin_events (id, at, action, actor) VALUES (?1, ?2, 'kept', 's')`).bind(6, NOW.toISOString()).run();
    await pruneAdminEvents(db, NOW).run();
    expect(await db.prepare('SELECT action FROM admin_events').all()).toMatchObject({ results: [{ action: 'kept' }] });
    await db.prepare(`INSERT INTO admin_events (id, at, action, actor) VALUES (?1, ?2, 'last', 's')`).bind(5000, NOW.toISOString()).run();
    await db.batch(adminEventStatements(db, [{ action: 'x', target: 'y' }], 's', NOW));
    const ids = (await db.prepare('SELECT id FROM admin_events ORDER BY id').all<{ id: number }>()).results.map((r) => r.id);
    expect(ids).toEqual([5000, 5001]);
    expect(MAX_ADMIN_EVENTS).toBe(1000);
  });

  it('can be read with a session only', async () => {
    const { env } = setup();
    const cookie = await session(env);
    await save(env, cookie, (c) => { c.retentionDays = 14; });
    const r = await get(env, { Cookie: cookie }, '/api/admin-events');
    const body = await r.json() as { events: { action: string }[]; retentionDays: number };
    expect(body.events.map((e) => e.action)).toEqual(['config.changed', 'signin']);
    expect(body.retentionDays).toBe(90);
    const generation = (await env.DB.prepare('SELECT cred FROM sessions').first<{ cred: string }>())!.cred;
    const made = await createToken(env.DB, 'reader', { days: 30, generation, accounts: 'all', people: false });
    if ('error' in made) throw new Error(made.error);
    expect((await get(env, { Authorization: `Bearer ${made.token}` }, '/api/admin-events')).status).toBe(401);
    expect((await get(env, {}, '/api/admin-events')).status).toBe(401);
  });
});

describe('the notice', () => {
  const silenced = () => {
    const c = defaultConfig();
    c.alerts.critical.instant = 'off';
    c.alerts.quietHours = { start: '00:00', end: '23:59' };
    return c;
  };

  it('reaches the operators even with every alert route off and in quiet hours', async () => {
    const { env, sent } = setup({ WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' });
    const f = fakeFetch();
    vi.stubGlobal('fetch', f.fn);
    await setSettings(env.DB, { config: JSON.stringify({ ...silenced(), digest: { ...defaultConfig().digest, groupRecipients: { g: ['client@example.com'] } } }) }).run();
    const cookie = await session(env);
    await save(env, cookie, (c) => { c.mutedChecks = ['errors:error-rate']; }, { ...silenced(), digest: { ...defaultConfig().digest, groupRecipients: { g: ['client@example.com'] } } });
    expect(sent).toHaveLength(1);
    // Not the client recipient: this is about the whole install.
    expect(sent[0].to).toEqual([ME]);
    expect(sent[0].text).toContain('checks muted: errors:error-rate');
    expect(f.calls).toContain('POST hooks.slack.com/services/T/B/x');
    expect((await events(env))[0].notice).toBe('sent');
  });

  it('still reaches an operator the same save turns into a client recipient', async () => {
    const { env, sent } = setup({ DIGEST_TO: ME });
    const cookie = await session(env);
    await save(env, cookie, (c) => { c.digest.groupRecipients = { g: [ME] }; });
    expect(sent.map((m) => m.to)).toEqual([[ME]]);
  });

  it('is sent once for a burst of changes, and the rest follow together', async () => {
    const { env, sent } = setup();
    const cookie = await session(env);
    await save(env, cookie, (c) => { c.modules.errors = false; });
    await save(env, cookie, (c) => { c.modules.errors = false; c.modules.cron = false; });
    await save(env, cookie, (c) => { c.modules.errors = false; c.modules.cron = false; c.modules.usage = false; });
    expect(sent).toHaveLength(1);
    expect((await events(env)).map((e) => e.notice)).toEqual(['sent', 'pending', 'pending']);
    await deliverAdminNotices(env, new Date(Date.now() + NOTICE_COOLDOWN_MS - 60_000));
    expect(sent).toHaveLength(1);
    await deliverAdminNotices(env, new Date(Date.now() + NOTICE_COOLDOWN_MS + 60_000));
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('check usage turned off');
    expect((await events(env)).map((e) => e.notice)).toEqual(['sent', 'sent', 'sent']);
    expect((await getSettings(env.DB)).admin_notice_pending).toBe('');
  });

  describe('when another change lands while one is being sent', () => {
    const record = (env: Env, target: string, at: Date) =>
      env.DB.batch(adminEventStatements(env.DB, [{ action: 'config.reduced', target, notice: true }], 'session a', at, [ME]));
    /** Sends the first notice, with `during` running at the moment the message goes out. */
    function racing(during: (env: Env) => Promise<unknown>) {
      const sent: Mail[] = [];
      const box = setup({ EMAIL: { send: async (m) => {
        sent.push(m);
        if (sent.length === 1) await during(box.env);
      } } });
      return { env: box.env, sent };
    }
    const after = () => new Date(Date.now() + NOTICE_COOLDOWN_MS + 60_000);

    it('keeps a new entry waiting, and the cron still delivers it', async () => {
      const { env, sent } = racing(async (e) => {
        await record(e, 'second change', new Date());
        await deliverAdminNotices(e); // what the second save does: it hits the cooldown
      });
      await record(env, 'first change', new Date());
      await deliverAdminNotices(env);
      expect((await events(env)).map((e) => [e.target, e.notice])).toEqual([['first change', 'sent'], ['second change', 'pending']]);
      const waiting = await getSettings(env.DB);
      expect(waiting.admin_notice_pending).toBe('1');
      expect(waiting.admin_notice_to).toBe(JSON.stringify([ME]));
      await deliverAdminNotices(env, after());
      expect(sent).toHaveLength(2);
      expect(sent[1].text).toContain('second change');
      expect((await getSettings(env.DB)).admin_notice_pending).toBe('');
    });

    it('does not mark as sent a repeat that joined the entry being sent', async () => {
      const { env, sent } = racing((e) => record(e, 'same change', new Date(Date.now() + 1_000)));
      await record(env, 'same change', new Date());
      await deliverAdminNotices(env);
      expect((await events(env)).map((e) => [e.count, e.notice])).toEqual([[2, 'pending']]);
      expect((await getSettings(env.DB)).admin_notice_pending).toBe('1');
      await deliverAdminNotices(env, after());
      expect(sent[1].text).toContain('(2 times)');
      expect((await events(env))[0].notice).toBe('sent');
    });
  });

  it('is delivered by the cron when it had to wait', async () => {
    const { env, sent } = setup();
    vi.stubGlobal('fetch', fakeFetch().fn);
    await env.DB.batch([upsertAccount(env.DB, { id: 'acc1' }, NOW), setAccountState(env.DB, 'acc1', { last_scan_at: new Date().toISOString() }), setSettings(env.DB, { setup_done: '1' })]);
    const cookie = await session(env);
    await save(env, cookie, (c) => { c.modules.errors = false; });
    await save(env, cookie, (c) => { c.modules.errors = false; c.modules.cron = false; });
    expect(sent).toHaveLength(1);
    await scheduledRun(env, new Date(Date.now() + NOTICE_COOLDOWN_MS + 60_000));
    expect(sent).toHaveLength(2);
  });

  it('goes out for a large bulk acknowledge, not for a small one', async () => {
    const { env, sent } = setup();
    const cookie = await session(env);
    await addFindings(env, 12);
    await send(env, cookie, '/api/findings/bulk', { ids: ['f0', 'f1'], action: 'acknowledge' });
    expect(sent).toHaveLength(0);
    await send(env, cookie, '/api/findings/bulk', { ids: Array.from({ length: 10 }, (_, i) => `f${i + 2}`), action: 'acknowledge' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('10 findings');
  });

  it('does not fail the change when it cannot be delivered, and tries again', async () => {
    let broken = true;
    const sent: Mail[] = [];
    const { env } = setup({ EMAIL: { send: async (m) => { if (broken) throw new Error('mail down'); sent.push(m); } } });
    const cookie = await session(env);
    expect((await save(env, cookie, (c) => { c.modules.errors = false; })).status).toBe(200);
    expect((await events(env))[0].notice).toBe('pending');
    broken = false;
    await deliverAdminNotices(env, new Date(Date.now() + NOTICE_COOLDOWN_MS + 60_000));
    expect(sent).toHaveLength(1);
  });

  it('gives up after a day, and records when no channel exists', async () => {
    const { env } = setup({ EMAIL: { send: async () => { throw new Error('down'); } } });
    const cookie = await session(env);
    await save(env, cookie, (c) => { c.modules.errors = false; });
    await deliverAdminNotices(env, new Date(Date.now() + 25 * 3_600_000));
    expect((await events(env))[0].notice).toBe('failed');
    expect((await getSettings(env.DB)).admin_notice_pending).toBe('');

    const none = setup({ EMAIL: undefined, DIGEST_TO: '' });
    const c2 = await session(none.env);
    await save(none.env, c2, (c) => { c.modules.errors = false; });
    expect((await events(none.env))[0].notice).toBe('none');
  });

  it('never sends to an address DIGEST_TO no longer allows', () => {
    const { env } = setup();
    expect(noticeAudience(env, [defaultConfig()], JSON.stringify(['gone@example.com', ME]))).toEqual([ME, 'client@example.com']);
    const c = defaultConfig();
    c.digest.groupRecipients = { g: ['client@example.com'] };
    expect(noticeAudience(env, [c], JSON.stringify(['gone@example.com']))).toEqual([ME]);
  });
});
