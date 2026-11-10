// End-to-end scans: fake Cloudflare API in, D1 rows and findings out.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/shared/config';
import { getSettings, setSettings } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { buildOverview, buildSelfCost, buildTimeline } from '../src/worker/overview';
import { runScan } from '../src/worker/scan';
import { setupStatus } from '../src/worker/setup';
import { createD1 } from './d1';
import { fakeFetch, NOW, type FakeOptions } from './fixtures';

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
  const { results } = await db.prepare(`SELECT id, severity, message, evidence FROM findings WHERE status = 'open' ORDER BY id`).all<{ id: string; severity: string; message: string; evidence: string }>();
  return results;
}

afterEach(() => vi.unstubAllGlobals());

describe('first scan of a small fleet', () => {
  it('stores the inventory and raises hygiene, exposure and cron findings', async () => {
    const f = stub();
    const { env: e } = env();
    const r = await runScan(e, NOW);
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
    await runScan(e, NOW);
    const o = await buildOverview(e, NOW);
    // Highest attention score first: legacy 4 warnings + 1 info, api 1 critical + 2 info, cron-job 1 critical, draft 1 info.
    expect(o.workers.map((w) => [w.name, w.score])).toEqual([['legacy', 13], ['api', 12], ['cron-job', 10], ['draft', 1]]);
    expect(o.workers.find((w) => w.name === 'api')?.groups).toEqual(['client-a']);
    expect(o.workers.find((w) => w.name === 'api')?.entryPoints).toEqual(['example.com/*']);
    expect(o.workers.find((w) => w.name === 'legacy')?.entryPoints).toEqual(['legacy.me.workers.dev']);
    expect(o.update).toEqual({ current: '0.1.0', latest: 'v0.2.0', url: 'https://github.com/x/releases/v0.2.0' });
    expect(o.workers[0].spark24).toHaveLength(24);

    const tl = await buildTimeline(e);
    expect(tl.map((t) => [t.script, t.author, t.message])).toEqual([['api', 'dev@example.com', 'Fix login']]);

    const cost = await buildSelfCost(e);
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
    await runScan(e, NOW);
    const ids = (await openFindings(e.DB)).map((x) => x.id);
    expect(ids.some((i) => i.includes(':legacy:'))).toBe(false);
    expect(ids.some((i) => i.startsWith('zombies:'))).toBe(false);
    expect(ids).toContain('exposure:api:previews-without-workers-dev');
  });

  it('skips runs inside the scan interval unless forced', async () => {
    stub();
    const { env: e } = env();
    await runScan(e, NOW);
    expect((await runScan(e, new Date(NOW.getTime() + 15 * 60_000))).skipped).toBe(true);
    expect((await runScan(e, new Date(NOW.getTime() + 15 * 60_000), { force: true })).skipped).toBeUndefined();
  });

  it('falls back when the CPU total field is not available', async () => {
    stub({ rejectCpuSum: true, hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 10, errors: 0 }] });
    const { env: e } = env();
    const r = await runScan(e, NOW);
    expect(r.warnings).toContain('CPU totals unavailable; CPU runaway detection is off.');
    expect((await getSettings(e.DB)).cpu_sum).toBe('unsupported');
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
      `INSERT INTO metrics_hourly (script, hour, requests, errors) SELECT json_extract(value,'$.script'), json_extract(value,'$.hour'),
       json_extract(value,'$.requests'), json_extract(value,'$.errors') FROM json_each(?1)`,
    ).bind(JSON.stringify(rows)).run();
    await setSettings(e.DB, { first_metrics_at: '2026-11-01T00:00:00Z' }).run();
    // 11:00 UTC, twenty minutes after the 10:40 deploy: 5,000 requests, 12% errors.
    stub({ hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 5000, errors: 600 }] });
    await runScan(e, NOW);

    const found = await openFindings(e.DB);
    const spike = found.find((x) => x.id === 'runaway:api:traffic-spike');
    const errors = found.find((x) => x.id === 'errors:api:error-rate');
    expect(spike?.severity).toBe('critical');
    expect(JSON.parse(spike!.evidence).deployId).toBe('dep-api-1');
    expect(errors?.severity).toBe('critical');
    expect(errors?.message).toContain('right after a deploy');
    const tl = await buildTimeline(e);
    expect(tl[0].correlated).toEqual(expect.arrayContaining(['traffic-spike', 'error-rate']));
  });
});

describe('notifications', () => {
  it('sends instant criticals once and the digest when due', async () => {
    stub();
    const { env: e, sent } = env();
    const config = defaultConfig();
    config.digest = { frequency: 'daily', weekday: 1, hour: 0, groupRecipients: { 'client-a': ['me@example.com', 'stranger@example.com'] } };
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await runScan(e, NOW);
    const subjects = sent.map((s) => s.subject);
    expect(subjects[0]).toMatch(/^Ambersight: 2 critical findings/);
    expect(subjects).toContain('Ambersight · client-a: 1 Worker needs attention');
    expect(sent.find((s) => s.subject.includes('client-a'))?.to).toEqual(['me@example.com']); // stranger is not in DIGEST_TO
    expect(subjects.some((s) => /Workers need attention$/.test(s))).toBe(true);

    sent.length = 0;
    await runScan(e, new Date(NOW.getTime() + 2 * 3_600_000));
    expect(sent).toEqual([]); // already notified, digest already sent today
  });

  it('holds instant alerts during quiet hours', async () => {
    stub();
    const { env: e, sent } = env();
    const config = defaultConfig();
    config.alerts.quietHours = { start: '11:00', end: '13:00' };
    config.digest.frequency = 'off';
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await runScan(e, NOW);
    expect(sent).toEqual([]);
  });

  it('posts to a Slack webhook when configured', async () => {
    const f = stub();
    const { env: e } = env({ EMAIL: undefined, WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' });
    const config = defaultConfig();
    config.alerts.critical.instant = 'webhook';
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await runScan(e, NOW);
    expect(f.calls).toContain('POST hooks.slack.com/services/T/B/x');
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
  it('says so when the token cannot read its own permissions', async () => {
    stub({ tokenPolicies: null });
    expect((await setupStatus(env().env)).writeScopes).toBeNull();
  });
});
