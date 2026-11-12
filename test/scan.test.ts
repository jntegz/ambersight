// End-to-end scans: fake Cloudflare API in, D1 rows and findings out.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/shared/config';
import { getAccountState, getSettings, setAccountState, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { buildOverview, buildSelfCost, buildTimeline } from '../src/worker/overview';
import { runScan } from '../src/worker/scan';
import { sendAlerts, sendWebhook } from '../src/worker/notify';
import { setupStatus } from '../src/worker/setup';
import { createD1 } from './d1';
import { fakeFetch, fleet, NEXT_RELEASE, NOW, type FakeOptions } from './fixtures';
import { VERSION } from '../src/worker/version';

function env(over: Partial<Env> = {}) {
  const sent: { to: string | string[]; subject: string; text?: string }[] = [];
  const e: Env = {
    DB: createD1(),
    ASSETS: {} as Fetcher,
    CF_API_TOKEN: 'test-token',
    ADMIN_PASSPHRASE: 'correct horse battery',
    EMAIL_FROM: 'ambersight@example.com',
    DIGEST_TO: 'me@example.com',
    EMAIL: { send: async (m) => void sent.push(m) },
    ...over,
  };
  return { env: e, sent };
}

function stub(opts: FakeOptions = {}) {
  const f = fakeFetch(opts);
  vi.stubGlobal('fetch', f.fn);
  return f;
}

async function openFindings(db: D1Database) {
  // IDs are stored as "<account>/<id>"; the tests compare the part after the account.
  const { results } = await db.prepare(`SELECT substr(id, length(account) + 2) AS id, severity, message, evidence FROM findings WHERE status = 'open' ORDER BY id`).all<{ id: string; severity: string; message: string; evidence: string }>();
  return results;
}

afterEach(() => vi.unstubAllGlobals());

/** Scans the test account, registering it first like the setup wizard does. */
async function scan(e: Env, now: Date, opts: { force?: boolean } = {}) {
  await upsertAccount(e.DB, { id: 'acc1', name: 'Test account' }, new Date('2026-11-01T00:00:00Z')).run();
  return runScan(e, now, { account: 'acc1', ...opts });
}

describe('first scan of a small fleet', () => {
  it('stores the inventory and raises hygiene, exposure and cron findings', async () => {
    const f = stub();
    const { env: e } = env();
    const r = await scan(e, NOW);
    expect(r.workers).toBe(4);
    expect(r.subrequests).toBeLessThanOrEqual(42);
    expect(f.calls.filter((c) => c.includes('api.cloudflare.com')).every((c) => c.startsWith('GET') || c.includes('/graphql'))).toBe(true);

    const ids = (await openFindings(e.DB)).map((x) => `${x.id}=${x.severity}`);
    expect(ids).toEqual(
      expect.arrayContaining([
        'exposure:api:previews-without-workers-dev=critical',
        'deprecation:api:redundant-flags=info',
        'deprecation:legacy:service-worker-syntax=warning',
        'deprecation:legacy:old-compat-date=warning',
        'deprecation:legacy:legacy-usage-model=warning',
        'deprecation:legacy:workers-sites=warning',
        'exposure:legacy:workers-dev-public=info',
        'zombies:api:missing-service-deleted-worker=info',
        'zombies:draft:never-deployed=info',
        'zombies:*:unbound-kv-ns-unused=info',
        'zombies:*:orphan-route-r2=info',
        'cron:cron-job:missed-runs=critical',
      ]),
    );
    // KV namespaces bound by api and legacy are not orphans.
    expect(ids.some((i) => i.includes('ns-used') || i.includes('ns-sites'))).toBe(false);
  });

  it('builds the overview, timeline and self-cost views', async () => {
    stub();
    const { env: e } = env();
    await scan(e, NOW);
    const o = await buildOverview(e, undefined, NOW);
    // Highest attention score first: legacy 4 warnings + 1 info, api 1 critical + 2 info, cron-job 1 critical, draft 1 info.
    expect(o.workers.map((w) => [w.name, w.score])).toEqual([['legacy', 13], ['api', 12], ['cron-job', 10], ['draft', 1]]);
    expect(o.workers.find((w) => w.name === 'api')?.groups).toEqual(['client-a']);
    expect(o.workers.find((w) => w.name === 'api')?.entryPoints).toEqual(['example.com/*']);
    expect(o.workers.find((w) => w.name === 'legacy')?.entryPoints).toEqual(['legacy.me.workers.dev']);
    expect(o.update).toEqual({ current: VERSION, latest: NEXT_RELEASE, url: `https://github.com/x/releases/${NEXT_RELEASE}` });

    const tl = await buildTimeline(e, 'acc1');
    expect(tl.map((t) => [t.script, t.author, t.message])).toEqual([['api', 'dev@example.com', 'Fix login']]);

    const cost = await buildSelfCost(e, 'acc1');
    expect(cost.days[0].cronRuns).toBe(1);
    expect(cost.days[0].rowsWritten).toBeGreaterThan(0);
  });

  it('respects scope and module switches', async () => {
    stub();
    const { env: e } = env();
    const config = defaultConfig();
    config.scope.exclude = ['legacy'];
    config.modules.zombies = false;
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await scan(e, NOW);
    const ids = (await openFindings(e.DB)).map((x) => x.id);
    expect(ids.some((i) => i.includes(':legacy:'))).toBe(false);
    expect(ids.some((i) => i.startsWith('zombies:'))).toBe(false);
    expect(ids).toContain('exposure:api:previews-without-workers-dev');
  });

  it('skips runs inside the scan interval unless forced', async () => {
    stub();
    const { env: e } = env();
    await scan(e, NOW);
    expect((await scan(e, new Date(NOW.getTime() + 15 * 60_000))).skipped).toBe(true);
    expect((await scan(e, new Date(NOW.getTime() + 15 * 60_000), { force: true })).skipped).toBeUndefined();
  });

  it('falls back when the CPU total field is not available', async () => {
    stub({ rejectCpuSum: true, hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 10, errors: 0 }] });
    const { env: e } = env();
    const r = await scan(e, NOW);
    expect(r.warnings).toContain('CPU totals unavailable; CPU runaway detection is off.');
    expect((await getAccountState(e.DB, 'acc1')).cpu_sum).toBe('unsupported');
  });
});

describe('runaway and deploy correlation', () => {
  it('flags a spike right after a deploy as critical and links the deploy', async () => {
    const { env: e } = env();
    // A week of quiet history for api: 100 requests an hour, no errors.
    const rows = [];
    for (let h = 7 * 24; h >= 2; h--) {
      const hour = new Date(Date.UTC(2026, 10, 9, 12) - h * 3_600_000).toISOString().replace('.000Z', 'Z');
      rows.push({ script: 'api', hour, requests: 100, errors: 0 });
    }
    await e.DB.prepare(
      `INSERT INTO metrics_hourly (account, script, hour, requests, errors) SELECT 'acc1', json_extract(value,'$.script'), json_extract(value,'$.hour'),
       json_extract(value,'$.requests'), json_extract(value,'$.errors') FROM json_each(?1)`,
    ).bind(JSON.stringify(rows)).run();
    await setAccountState(e.DB, 'acc1', { first_metrics_at: '2026-11-01T00:00:00Z' }).run();
    // 11:00 UTC, twenty minutes after the 10:40 deploy: 5,000 requests, 12% errors.
    stub({ hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 5000, errors: 600 }] });
    await scan(e, NOW);

    const found = await openFindings(e.DB);
    const spike = found.find((x) => x.id === 'runaway:api:traffic-spike');
    const errors = found.find((x) => x.id === 'errors:api:error-rate');
    expect(spike?.severity).toBe('critical');
    expect(JSON.parse(spike!.evidence).deployId).toBe('dep-api-1');
    expect(errors?.severity).toBe('critical');
    expect(errors?.message).toContain('right after a deploy');
    const tl = await buildTimeline(e, 'acc1');
    expect(tl[0].correlated).toEqual(expect.arrayContaining(['traffic-spike', 'error-rate']));
  });
});

describe('notifications', () => {
  it('sends instant criticals once and the digest when due', async () => {
    stub();
    const { env: e, sent } = env();
    const config = defaultConfig();
    config.digest = { ...config.digest, frequency: 'daily', weekday: 1, hour: 0, groupRecipients: { 'client-a': ['me@example.com', 'stranger@example.com'] } };
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await scan(e, NOW);
    const subjects = sent.map((s) => s.subject);
    expect(subjects[0]).toMatch(/^Ambersight: 2 critical findings/);
    expect(subjects).toContain('Ambersight · client-a: 1 Worker needs attention');
    expect(sent.find((s) => s.subject.includes('client-a'))?.to).toEqual(['me@example.com']); // stranger is not in DIGEST_TO
    expect(subjects.some((s) => /Workers need attention$/.test(s))).toBe(true);

    sent.length = 0;
    await scan(e, new Date(NOW.getTime() + 2 * 3_600_000));
    expect(sent).toEqual([]); // already notified, digest already sent today
  });

  it('holds instant alerts during quiet hours', async () => {
    stub();
    const { env: e, sent } = env();
    const config = defaultConfig();
    config.alerts.quietHours = { start: '11:00', end: '13:00' };
    config.digest.frequency = 'off';
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await scan(e, NOW);
    expect(sent).toEqual([]);
  });

  it('posts to a Slack webhook when configured', async () => {
    const f = stub();
    const { env: e } = env({ EMAIL: undefined, WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' });
    const config = defaultConfig();
    config.alerts.critical.instant = 'webhook';
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await scan(e, NOW);
    expect(f.calls).toContain('POST hooks.slack.com/services/T/B/x');
  });
});

describe('alert hardening', () => {
  const capture = () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('ok');
    });
    return bodies;
  };
  const row = (message: string) => ({ id: 'x', script: '*', severity: 'info' as const, message, action: 'a', evidence: '{}' });

  it('neutralises chat markup from resource names in webhook alerts', async () => {
    const bodies = capture();
    await sendWebhook('https://hooks.slack.com/services/T/B/x', 't', [row('KV <!channel> <https://evil.example|dash>\n• [Critical] forged')]);
    const slack = JSON.parse(bodies[0]).text as string;
    expect(slack).not.toContain('<!channel>');
    expect(slack).not.toContain('<https://');
    expect(slack.split('\n')).toHaveLength(2);
    await sendWebhook('https://discord.com/api/webhooks/1/x', 't', [row('@everyone [dash](https://evil.example)')]);
    const discord = JSON.parse(bodies[1]);
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(discord.content).not.toContain('[dash](');
  });

  it('skips alerts routed to a channel that is not set up, so they cannot block deliverable ones', async () => {
    const bodies = capture();
    const { env: e } = env({ EMAIL: undefined, WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' });
    const config = defaultConfig(); // critical -> email, which this deployment does not have
    config.alerts.warning.instant = 'webhook';
    config.alerts.quietHours = null;
    const ins = (id: string, severity: string) =>
      e.DB.prepare(`INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
        VALUES (?1, 'acc1', 'w', 'exposure', ?2, 'c', 'm', '{}', 'a', ?3, ?3, 'open')`).bind(id, severity, NOW.toISOString()).run();
    for (let i = 0; i < 50; i++) await ins(`exposure:w${i}:c`, 'critical');
    await ins('errors:api:error-rate', 'warning');
    await sendAlerts(e, NOW, config);
    expect(bodies).toHaveLength(1);
  });
});

describe('setup wizard', () => {
  it('reports a read-only token', async () => {
    stub();
    const s = await setupStatus(env().env);
    expect(s).toMatchObject({ tokenActive: true, accountId: 'acc1', writeScopes: [], detectedPlan: 'free' });
  });
  it('detects write scopes', async () => {
    stub({ tokenPolicies: [{ name: 'Workers Scripts Read' }, { name: 'Workers Scripts Write' }] });
    expect((await setupStatus(env().env)).writeScopes).toEqual(['Workers Scripts Write']);
  });
  it('lists the accounts the token can see, and reports pinning and Access', async () => {
    stub();
    const s = await setupStatus(env().env, { behindAccess: true });
    expect(s.accounts).toEqual([{ id: 'acc1', name: 'Test account' }]);
    expect(s.accountPinned).toBe(false);
    expect(s.behindAccess).toBe(true);
    expect((await setupStatus(env({ CF_ACCOUNT_ID: 'acc1' }).env)).accountPinned).toBe(true);
  });

  it('says so when the token cannot read its own permissions', async () => {
    stub({ tokenPolicies: null });
    expect((await setupStatus(env().env)).writeScopes).toBeNull();
  });
});

describe('cron data gaps', () => {
  const cronIds = async (db: D1Database) => (await openFindings(db)).map((x) => x.id).filter((id) => id.startsWith('cron:'));

  it('pauses cron checks instead of flagging every cron when Cloudflare returns no runs', async () => {
    stub({ cronRuns: [] });
    const { env: e } = env();
    const r = await scan(e, NOW);
    expect(await cronIds(e.DB)).toEqual([]);
    expect(r.warnings.join(' ')).toContain('returned no scheduled runs');
  });

  it('does not judge crons on stored runs when this scan could not fetch them', async () => {
    // Every hourly run present up to 10:00, then the next scan's cron query fails.
    const full = Array.from({ length: 24 }, (_, i) => ({ scriptName: 'cron-job', status: 'success', datetime: new Date(Date.UTC(2026, 10, 8, 11 + i, 0, 1)).toISOString() }));
    stub({ cronRuns: full });
    const { env: e } = env();
    await scan(e, NOW);
    expect(await cronIds(e.DB)).toEqual([]);
    stub({ cronError: true });
    const r = await scan(e, new Date(NOW.getTime() + 2 * 3_600_000), { force: true });
    expect(await cronIds(e.DB)).toEqual([]);
    expect(r.warnings.join(' ')).toContain('Cron runs unavailable');
  });

  it('pauses cron checks when the run query hits its row limit, without marking the dataset unavailable', async () => {
    stub({ cronRuns: Array.from({ length: 10_000 }, () => ({ scriptName: 'cron-job', status: 'success', datetime: '2026-11-09T07:00:01Z' })) });
    const { env: e } = env();
    const r = await scan(e, NOW);
    expect(await cronIds(e.DB)).toEqual([]);
    expect(r.warnings.join(' ')).toContain('too many to count');
    expect((await getAccountState(e.DB, 'acc1')).cron_dataset).toBe('available');
  });
});

describe('queues without bindings', () => {
  it('does not flag consumed queues or dead-letter queues as unbound', async () => {
    stub({
      queues: [
        { queue_id: 'q-jobs', queue_name: 'jobs', producers: [], consumers: [{ type: 'worker', script_name: 'cron-job', dead_letter_queue: 'jobs-dlq' }] },
        { queue_id: 'q-dlq', queue_name: 'jobs-dlq', producers: [], consumers: [] },
        { queue_id: 'q-old', queue_name: 'old', producers: [], consumers: [] },
      ],
    });
    const { env: e } = env();
    await scan(e, NOW);
    const ids = (await openFindings(e.DB)).map((x) => x.id).filter((id) => id.includes('unbound-queues'));
    expect(ids).toEqual(['zombies:*:unbound-queues-q-old']);
  });
});

describe('cron runs after a deploy', () => {
  it('expects runs only from the first full hour after the last deploy', async () => {
    const cronJob = fleet.workers.find((w) => w.name === 'cron-job')!;
    const before = cronJob.deployed_on;
    try {
      // Deployed at 10:30; the window ends at 11:00, so no full hour has passed yet.
      cronJob.deployed_on = '2026-11-09T10:30:00Z';
      stub();
      const { env: e } = env();
      await scan(e, NOW);
      expect((await openFindings(e.DB)).filter((f) => f.id.startsWith('cron:cron-job'))).toEqual([]);

      // Deployed at 07:30: 08:00, 09:00 and 10:00 were all missed, whatever ran before the deploy.
      cronJob.deployed_on = '2026-11-09T07:30:00Z';
      const { env: e2 } = env();
      await scan(e2, NOW);
      const missed = (await openFindings(e2.DB)).find((f) => f.id === 'cron:cron-job:missed-runs');
      expect(JSON.parse(missed!.evidence)).toMatchObject({ expected: 3, observed: 0 });
    } finally {
      cronJob.deployed_on = before;
    }
  });
});

describe('muted checks', () => {
  it('drops findings of a check the user switched off, so open ones resolve', async () => {
    stub();
    const { env: e } = env();
    await scan(e, NOW);
    expect((await openFindings(e.DB)).some((f) => f.id === 'exposure:api:previews-without-workers-dev')).toBe(true);
    const config = defaultConfig();
    config.mutedChecks = ['exposure:previews-without-workers-dev', 'zombies:unbound-kv'];
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await scan(e, new Date(NOW.getTime() + 3_600_000), { force: true });
    const ids = (await openFindings(e.DB)).map((f) => f.id);
    expect(ids.some((id) => id.startsWith('exposure:api:previews-without-workers-dev') || id.includes('unbound-kv'))).toBe(false);
    expect(ids).toContain('deprecation:legacy:service-worker-syntax');
  });
});
