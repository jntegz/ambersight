// Tier 2 checks: Pages, audit log, certificates, dangling DNS, stuck rollouts, config drift,
// expensive D1 queries, subrequests near 50, the zone cursor and Cloudflare incidents.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THRESHOLDS, defaultConfig } from '../src/shared/config';
import { checkOf } from '../src/shared/findings';
import { runChecks, type WorkerMeta, type WorkerStats } from '../src/worker/checks';
import { upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { sendAlerts } from '../src/worker/notify';
import { buildOverview, buildTimeline } from '../src/worker/overview';
import { runScan } from '../src/worker/scan';
import { auditFindings, certFindings, d1QueryFindings, dnsFindings, driftFindings, pagesFindings, rolloutFindings, type ChangeFacts } from '../src/worker/security';
import { createD1 } from './d1';
import { fakeFetch, NOW } from './fixtures';

const now = new Date('2026-11-09T12:00:00Z');
const tf = () => DEFAULT_THRESHOLDS;
const facts = (over: Partial<ChangeFacts> = {}): ChangeFacts => ({
  latestDeploys: [], removedBindings: [], audit: [], pages: [], certs: [], dns: [], d1Queries: [],
  workerNames: new Set(['api']), workersSubdomain: 'me', ...over,
});
const meta = (over: Partial<WorkerMeta> = {}): WorkerMeta => ({
  name: 'api', groups: [], handlers: ['fetch'], hasModules: true, compatibilityDate: '2026-09-01', compatibilityFlags: [], usageModel: 'standard',
  bindings: [], workersDev: false, previewsEnabled: false, logsEnabled: false, samplingRate: 1, logpush: false, deployedOn: '2026-11-01', listed: true, deployments: [], ...over,
});
const latest = (status: string, environment = 'production') => ({ id: 'd1', createdOn: '2026-11-09T10:00:00Z', status, stage: 'build', environment, branch: 'main' });

describe('Pages', () => {
  it('flags a failed production deploy as a warning and a failed preview as info', () => {
    const f = pagesFindings(facts({ pages: [{ name: 'site', subdomain: 'site.pages.dev', domains: [], latest: latest('failure') }] }));
    expect(f).toMatchObject([{ id: 'pages:*:deploy-failed-site', severity: 'warning' }]);
    expect(checkOf(f[0])).toBe('pages:deploy-failed');
    expect(pagesFindings(facts({ pages: [{ name: 'site', subdomain: null, domains: [], latest: latest('failure', 'preview') }] }))[0].severity).toBe('info');
    expect(pagesFindings(facts({ pages: [{ name: 'site', subdomain: null, domains: [], latest: latest('success') }] }))).toEqual([]);
  });
  it('notes that pages.dev skips the zone rules when a custom domain is used', () => {
    const [f] = pagesFindings(facts({ pages: [{ name: 'site', subdomain: 'site.pages.dev', domains: ['site.pages.dev', 'www.example.com'], latest: null }] }));
    expect(f).toMatchObject({ module: 'exposure', code: 'pages-dev-public-site', severity: 'info' });
    expect(f.message).toContain('www.example.com');
  });
});

describe('audit log', () => {
  it('flags new members and new API tokens, and ignores the rest', () => {
    const f = auditFindings(facts({
      audit: [
        { id: 'a1', at: '2026-11-09T09:00:00Z', actor: 'boss@example.com', action: 'create', description: 'Invited a member', product: 'account', resourceType: 'account.member', resourceId: 'x@example.com' },
        { id: 'a2', at: '2026-11-09T09:05:00Z', actor: 'boss@example.com', action: 'create', description: 'Created token', product: 'iam', resourceType: 'account.api_token', resourceId: 't1' },
        { id: 'a3', at: '2026-11-09T09:10:00Z', actor: 'dev@example.com', action: 'update', description: 'Deployed script', product: 'workers', resourceType: 'workers.script', resourceId: 'api' },
      ],
    }));
    expect(f.map((x) => [checkOf(x), x.severity])).toEqual([['security:member-change', 'warning'], ['security:token-created', 'info']]);
    expect(f[0].message).toContain('boss@example.com');
  });
});

describe('certificates', () => {
  const cert = (over: Partial<ChangeFacts['certs'][number]>) => ({ id: 'c1', zone: 'example.com', type: 'universal', status: 'active', hosts: ['example.com', '*.example.com'], expiresOn: '2027-01-01T00:00:00Z', errors: [], ...over });
  it('warns about a managed certificate that expires within a week, critical at 2 days', () => {
    expect(certFindings(now, facts({ certs: [cert({})] }))).toEqual([]);
    expect(certFindings(now, facts({ certs: [cert({ expiresOn: '2026-11-14T00:00:00Z' })] }))[0]).toMatchObject({ code: 'cert-expiring-c1', severity: 'warning' });
    expect(certFindings(now, facts({ certs: [cert({ expiresOn: '2026-11-10T00:00:00Z' })] }))[0].severity).toBe('critical');
  });
  it('flags expired and timed-out packs, unless another active pack covers the hosts', () => {
    expect(certFindings(now, facts({ certs: [cert({ status: 'expired' })] }))[0]).toMatchObject({ code: 'cert-failed-c1', severity: 'critical' });
    expect(certFindings(now, facts({ certs: [cert({ status: 'validation_timed_out' }), cert({ id: 'c2' })] }))).toEqual([]);
  });
  it('flags a pack stuck in validation with an error', () => {
    const [f] = certFindings(now, facts({ certs: [cert({ status: 'pending_validation', errors: ['CAA record prevents issuance'] })] }));
    expect(f).toMatchObject({ code: 'cert-pending-c1', severity: 'warning' });
    expect(f.message).toContain('CAA');
  });
});

describe('dangling DNS', () => {
  const dns = (target: string) => [{ id: 'r1', name: 'shop.example.com', zone: 'example.com', target }];
  it('is critical for a pages.dev target with no such project in the account', () => {
    const [f] = dnsFindings(facts({ dns: dns('old-shop.pages.dev'), pages: [{ name: 'site', subdomain: null, domains: [], latest: null }] }));
    expect(f).toMatchObject({ code: 'dangling-pages-r1', severity: 'critical' });
    expect(dnsFindings(facts({ dns: dns('preview.site.pages.dev'), pages: [{ name: 'site', subdomain: null, domains: [], latest: null }] }))).toEqual([]);
  });
  it('says nothing about pages.dev until a Pages listing has loaded', () => {
    expect(dnsFindings(facts({ dns: dns('old-shop.pages.dev'), pages: null }))).toEqual([]);
  });
  it('warns about our own workers.dev subdomain pointing at a deleted Worker, and leaves other accounts alone', () => {
    expect(dnsFindings(facts({ dns: dns('gone.me.workers.dev') }))[0]).toMatchObject({ code: 'dangling-workers-dev-r1', severity: 'warning' });
    expect(dnsFindings(facts({ dns: dns('api.me.workers.dev') }))).toEqual([]);
    expect(dnsFindings(facts({ dns: dns('gone.someone-else.workers.dev') }))).toEqual([]);
  });
});

describe('stuck rollouts', () => {
  const split = [{ id: 'v1', percentage: 90 }, { id: 'v2', percentage: 10 }];
  it('warns when traffic has been split for longer than the threshold', () => {
    const [f] = rolloutFindings(now, facts({ latestDeploys: [{ script: 'api', createdOn: '2026-11-07T12:00:00Z', versions: split }] }), tf);
    expect(f).toMatchObject({ id: 'deploys:api:stuck-rollout', severity: 'warning' });
    expect(f.message).toContain('90% / 10%');
    expect(rolloutFindings(now, facts({ latestDeploys: [{ script: 'api', createdOn: '2026-11-09T06:00:00Z', versions: split }] }), tf)).toEqual([]);
    expect(rolloutFindings(now, facts({ latestDeploys: [{ script: 'api', createdOn: '2026-11-01T00:00:00Z', versions: [{ id: 'v1', percentage: 100 }] }] }), tf)).toEqual([]);
  });
});

describe('config drift', () => {
  it('flags a binding that disappeared and is still missing', () => {
    const removed = [{ script: 'api', name: 'STRIPE_KEY', at: '2026-11-08T10:00:00Z' }];
    const [f] = driftFindings([meta({ bindings: [{ type: 'kv_namespace', name: 'CACHE' }] })], facts({ removedBindings: removed }));
    expect(f).toMatchObject({ code: 'binding-removed-STRIPE_KEY', severity: 'warning' });
    expect(checkOf(f)).toBe('drift:binding-removed');
    expect(driftFindings([meta({ bindings: [{ type: 'secret_text', name: 'STRIPE_KEY' }] })], facts({ removedBindings: removed }))).toEqual([]);
  });
  it('compares staging and production binding names', () => {
    const f = driftFindings([
      meta({ name: 'api', bindings: [{ type: 'kv_namespace', name: 'CACHE' }] }),
      meta({ name: 'api-staging', bindings: [{ type: 'kv_namespace', name: 'CACHE' }, { type: 'secret_text', name: 'NEW_FLAG' }] }),
    ], facts());
    expect(f).toMatchObject([{ script: 'api', code: 'env-mismatch-api-staging', severity: 'info' }]);
    expect(f[0].message).toContain('NEW_FLAG');
  });
  it('warns close to 64 variables and secrets', () => {
    const vars = (n: number) => Array.from({ length: n }, (_, i) => ({ type: i % 2 ? 'secret_text' : 'plain_text', name: `V${i}` }));
    expect(driftFindings([meta({ bindings: vars(57) })], facts())).toEqual([]);
    expect(driftFindings([meta({ bindings: vars(60) })], facts())[0]).toMatchObject({ code: 'vars-near-limit', severity: 'info' });
    expect(driftFindings([meta({ bindings: vars(64) })], facts())[0].severity).toBe('warning');
  });
});

describe('expensive D1 queries', () => {
  it('flags a query that reads far more rows than it returns', () => {
    const [f] = d1QueryFindings(facts({ d1Queries: [{ hash: 'ab12', database: 'main', query: 'SELECT * FROM orders WHERE email = ?', rowsRead: 40_000_000, rowsReturned: 2_000, runs: 2_000 }] }));
    expect(f).toMatchObject({ code: 'd1-inefficient-query-ab12', severity: 'info' });
    expect(f.evidence.query).toBe('SELECT * FROM orders WHERE email = ?');
    expect(d1QueryFindings(facts({ d1Queries: [{ hash: 'x', database: 'main', query: 'q', rowsRead: 40_000_000, rowsReturned: 4_000_000, runs: 1 }] }))).toEqual([]);
  });
});

describe('subrequests per invocation on Free', () => {
  it('warns when the average gets close to 50', () => {
    const w = (sub: number): WorkerStats => ({ name: 'api', requests24h: 1000, subrequests24h: sub, errors24h: 0, requestsPrev: 0, errorsPrev: 0, exceeded24h: 0, cpuP99Max24h: 1, lastHourRequests: 40, hourlyMedian7d: 40, lastHourCpuUs: 0, hourlyMedianCpuUs7d: 0, lastHourSubrequests: 0, hourlyMedianSubrequests7d: 0, historyHours: 168 });
    const free = runChecks({ now, plan: 'free', accountRequestsToday: 0, workers: [w(45_000)], crons: null });
    expect(free.map((f) => f.code)).toContain('subrequests-near-limit');
    expect(runChecks({ now, plan: 'free', accountRequestsToday: 0, workers: [w(20_000)], crons: null })).toEqual([]);
    expect(runChecks({ now, plan: 'paid', accountRequestsToday: 0, workers: [w(45_000)], crons: null })).toEqual([]);
  });
});

describe('module switches', () => {
  it('drops security and drift findings when those modules are off', () => {
    const config = defaultConfig();
    config.modules.security = false;
    config.modules.drift = false;
    const out = runChecks({
      now, plan: 'free', accountRequestsToday: 0, workers: [], crons: null, config, meta: [meta({ bindings: Array.from({ length: 64 }, (_, i) => ({ type: 'plain_text', name: `V${i}` })) })],
      changes: facts({ dns: [{ id: 'r1', name: 'a.example.com', zone: 'example.com', target: 'gone.pages.dev' }] }),
    });
    expect(out).toEqual([]);
  });
});

// ---- End to end -----------------------------------------------------------------------------

type Handler = (url: URL, init?: RequestInit) => Response | null;
function stubWith(handler: Handler) {
  const base = fakeFetch();
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.hostname}${url.pathname}`);
    return handler(url, init) ?? base.fn(input, init);
  });
  return calls;
}
const ok = (result: unknown, info?: unknown) => new Response(JSON.stringify({ success: true, result, errors: [], ...(info ? { result_info: info } : {}) }));
const newEnv = (over: Partial<Env> = {}): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery', ...over });

describe('Tier 2 end to end', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('covers many zones over several scans instead of stopping at 20', async () => {
    const zones = Array.from({ length: 30 }, (_, i) => ({ id: `z${i}`, name: `site${i}.com` }));
    stubWith((url) => {
      const p = url.pathname.replace('/client/v4', '');
      if (p === '/zones') return ok(zones);
      const m = p.match(/^\/zones\/(z\d+)\/(workers\/routes|ssl\/certificate_packs|dns_records)$/);
      if (m) return ok(m[2] === 'workers/routes' ? [{ id: `route-${m[1]}`, pattern: `${m[1]}.example/*`, script: 'api' }] : []);
      return null;
    });
    const e = newEnv();
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    const first = await runScan(e, NOW, { account: 'acc1' });
    expect(first.warnings.join(' ')).toMatch(/\d+ zone checks will run on the next scans/);
    expect(first.subrequests).toBeLessThanOrEqual(42);
    for (let h = 1; h <= 20; h++) await runScan(e, new Date(NOW.getTime() + h * 3_600_000), { account: 'acc1' });
    const routes = await e.DB.prepare(`SELECT COUNT(*) AS n FROM resources WHERE account = 'acc1' AND kind = 'route'`).first<{ n: number }>();
    expect(routes!.n).toBe(30);
    const pending = await e.DB.prepare(`SELECT COUNT(*) AS n FROM zones WHERE account = 'acc1' AND (routes_at IS NULL OR certs_at IS NULL OR dns_at IS NULL)`).first<{ n: number }>();
    expect(pending!.n).toBe(0);
  });

  it('finds a DNS record pointing at a deleted Pages project, and shows the audit log on the timeline', async () => {
    stubWith((url) => {
      const p = url.pathname.replace('/client/v4', '');
      if (p === '/zones/z1/dns_records') return ok([{ id: 'rec1', name: 'shop.example.com', type: 'CNAME', content: 'old-shop.pages.dev' }]);
      if (p === '/zones/z1/ssl/certificate_packs') return ok([{ id: 'cp1', type: 'universal', status: 'active', hosts: ['example.com'], certificates: [{ expires_on: '2026-11-12T00:00:00Z' }] }]);
      if (p === '/accounts/acc1/pages/projects') {
        return ok([{ name: 'site', subdomain: 'site.pages.dev', domains: ['site.pages.dev', 'www.example.com'], production_script_name: 'pages-worker--1-production',
          latest_deployment: { id: 'pd1', created_on: '2026-11-09T09:00:00Z', environment: 'production', latest_stage: { name: 'build', status: 'failure' } } }]);
      }
      if (p === '/accounts/acc1/logs/audit') {
        return ok([{ id: 'au1', action: { type: 'update', time: '2026-11-09T10:41:00Z', description: 'Uploaded script' }, actor: { email: 'ci@example.com' }, resource: { product: 'workers', type: 'workers.script', id: 'api' } }]);
      }
      return null;
    });
    const e = newEnv();
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    await runScan(e, NOW, { account: 'acc1' });
    const { results } = await e.DB.prepare(`SELECT code, severity FROM findings WHERE account = 'acc1' AND status = 'open'`).all<{ code: string; severity: string }>();
    const codes = Object.fromEntries(results.map((r) => [r.code, r.severity]));
    expect(codes['dangling-pages-rec1']).toBe('critical');
    expect(codes['cert-expiring-cp1']).toBe('warning');
    expect(codes['deploy-failed-site']).toBe('warning');
    expect(codes['pages-dev-public-site']).toBe('info');

    vi.setSystemTime(NOW);
    const tl = await buildTimeline(e, 'acc1', 7);
    const o = await buildOverview(e, 'acc1', NOW);
    vi.useRealTimers();
    expect(tl.find((x) => x.kind === 'audit')).toMatchObject({ script: 'api', author: 'ci@example.com', message: 'Uploaded script' });
    expect(tl.find((x) => x.kind === 'pages')).toMatchObject({ script: 'site', correlated: ['deploy-failed'] });
    // The fixture deploy of api at 10:40 has an author; the audit log fills it in only when missing.
    expect(tl.find((x) => x.kind === 'deploy' && x.script === 'api')?.author).toBe('dev@example.com');
    expect(o.pages).toMatchObject([{ name: 'site', latest: { status: 'failure' } }]);
  });

  it('records a removed binding as drift', async () => {
    let bindings = [{ type: 'kv_namespace', name: 'CACHE', namespace_id: 'ns-used' }, { type: 'secret_text', name: 'STRIPE_KEY' }];
    stubWith((url) => (url.pathname.endsWith('/workers/scripts/api/settings') ? ok({ bindings }) : null));
    const e = newEnv();
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    await runScan(e, NOW, { account: 'acc1' });
    bindings = [bindings[0]];
    await runScan(e, new Date(NOW.getTime() + 7 * 3_600_000), { account: 'acc1' });
    const f = await e.DB.prepare(`SELECT severity FROM findings WHERE account = 'acc1' AND code = 'binding-removed-STRIPE_KEY' AND status = 'open'`).first<{ severity: string }>();
    expect(f?.severity).toBe('warning');
  });

  it('names an active Cloudflare incident on alerts only when the check is on', async () => {
    const calls = stubWith((url) =>
      url.hostname === 'www.cloudflarestatus.com'
        ? new Response(JSON.stringify({ incidents: [{ id: 'i1', name: 'Workers elevated errors', impact: 'major', status: 'investigating', created_at: '2026-11-09T11:00:00Z' }] }))
        : null,
    );
    const sent: { subject: string; text?: string }[] = [];
    const e = newEnv({ EMAIL_FROM: 'a@example.com', DIGEST_TO: 'me@example.com', EMAIL: { send: async (m) => void sent.push(m) } });
    await e.DB.prepare(`INSERT INTO findings (id, account, script, module, severity, code, message, evidence, action, first_seen, last_seen, status)
      VALUES ('acc1/errors:api:error-rate', 'acc1', 'api', 'errors', 'critical', 'error-rate', '12% of requests failed', '{}', 'a', ?1, ?1, 'open')`).bind(NOW.toISOString()).run();
    const config = defaultConfig();
    await sendAlerts(e, NOW, config);
    expect(calls.some((c) => c.startsWith('www.cloudflarestatus.com'))).toBe(false);
    config.modules.incidents = true;
    await e.DB.prepare(`UPDATE findings SET notified_at = NULL`).run();
    await sendAlerts(e, NOW, config);
    expect(sent.at(-1)!.text).toContain('Cloudflare reports an active incident: Workers elevated errors');
  });
});
