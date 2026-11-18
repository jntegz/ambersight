// The Free plan's 50 D1 queries are per invocation: what runs around a scan counts too.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/shared/config';
import { getAccountState, getSettings, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { metered } from '../src/worker/meter';
import { runScan } from '../src/worker/scan';
import { handleQueueMessage, scheduledRun } from '../src/worker/scheduler';
import { createD1 } from './d1';
import { fakeFetch, NOW } from './fixtures';

/** Stands in for the alert code at its limit: one query per message, plus the 11 it may use besides. */
const alerts = vi.hoisted(() => ({ budgets: [] as number[] }));
vi.mock('../src/worker/notify', async (original) => ({
  ...(await original<typeof import('../src/worker/notify')>()),
  sendAlerts: async (env: { DB: D1Database }, _now: Date, _config: unknown, budget: { left: number }) => {
    alerts.budgets.push(budget.left);
    for (let i = 0; i < budget.left + 11; i++) await env.DB.prepare('SELECT 1').run();
    return [];
  },
}));

const LIMIT = 50;

async function setup() {
  const { db, meter } = metered(createD1());
  const env: Env = {
    DB: db, ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery',
    EMAIL_FROM: 'ambersight@example.com', DIGEST_TO: 'me@example.com', EMAIL: { send: async () => {} },
  };
  await db.batch([
    upsertAccount(db, { id: 'acc1' }, NOW),
    setSettings(db, { setup_done: '1', config: JSON.stringify({ ...defaultConfig(), plan: 'free' }) }),
  ]);
  return { env, db, meter };
}

beforeEach(() => {
  alerts.budgets.length = 0;
  vi.stubGlobal('fetch', fakeFetch().fn);
});
afterEach(() => vi.unstubAllGlobals());

describe('the D1 queries left for alerts', () => {
  it('leaves out what ran before the scan and what must run after it', async () => {
    const free = await setup();
    await runScan(free.env, NOW, { account: 'acc1' });
    expect(alerts.budgets[0]).toBeGreaterThan(0);
    // Each alone leaves room; together they use up what the scan and its alert code do not need.
    for (const room of [{ d1Used: 19 }, { d1Reserve: 19 }]) {
      const some = await setup();
      await runScan(some.env, NOW, { account: 'acc1', ...room });
      expect(alerts.budgets.at(-1)).toBeGreaterThan(0);
    }
    const spent = await setup();
    await runScan(spent.env, NOW, { account: 'acc1', d1Used: 19, d1Reserve: 19 });
    expect(alerts.budgets.at(-1)).toBe(0);
  });

  it('keeps a whole cron run inside the limit, with notices and housekeeping after the scan', async () => {
    const { env, db, meter } = await setup();
    await db.batch([
      db.prepare(`INSERT INTO admin_events (at, action, target, actor, notice) VALUES (?1, 'config.reduced', 'x', 'session a', 'pending')`).bind(NOW.toISOString()),
      setSettings(db, { admin_notice_pending: '1' }),
    ]);
    meter.queries = 0;
    const run = await scheduledRun(env, NOW);
    expect(run).toMatchObject({ account: 'acc1', result: { workers: 4 } });
    expect(alerts.budgets[0]).toBeGreaterThan(0);
    expect(meter.queries).toBeLessThanOrEqual(LIMIT);
    // Everything after the alerts still ran: the scan's last batch, the notice, the housekeeping.
    expect((await getAccountState(db, 'acc1')).last_scan_at).toBe(NOW.toISOString());
    expect(await db.prepare('SELECT notice FROM admin_events').first()).toEqual({ notice: 'sent' });
    expect((await getSettings(db)).housekeeping_at).toBe(NOW.toISOString());
  });

  it('keeps a queued scan inside the limit too', async () => {
    const { env, meter } = await setup();
    meter.queries = 0;
    await handleQueueMessage(env, { kind: 'scan', account: 'acc1' }, NOW);
    expect(alerts.budgets[0]).toBeGreaterThan(0);
    expect(meter.queries).toBeLessThanOrEqual(LIMIT);
  });
});
