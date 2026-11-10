// Recorded-style Cloudflare API responses for a small fleet, served by a fake fetch.
// Shapes follow the public API docs; they are not captured from a live account.
// SPDX-License-Identifier: AGPL-3.0-only

export const NOW = new Date('2026-11-09T12:20:00Z');
const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { 'Content-Type': 'application/json' } });
const gql = (data: unknown) => new Response(JSON.stringify({ data, errors: null }), { headers: { 'Content-Type': 'application/json' } });

/**
 * Fleet:
 * - api: modules, recent compat date, fetch; previews ON, workers.dev OFF (critical exposure);
 *   binds KV ns-used and a service binding to a Worker that no longer exists; route on example.com.
 * - cron-job: scheduled every hour, misses the last 3 runs.
 * - legacy: Service Worker syntax, compat date 2023, Workers Sites binding, workers.dev ON.
 * - draft: created but never deployed.
 */
export const fleet = {
  workers: [
    { name: 'api', deployed_on: '2026-11-01T10:00:00Z', subdomain: { enabled: false, previews_enabled: true }, observability: { enabled: true, head_sampling_rate: 1 }, tags: ['client-a'] },
    { name: 'cron-job', deployed_on: '2026-10-01T10:00:00Z', subdomain: { enabled: false, previews_enabled: false } },
    { name: 'legacy', deployed_on: '2023-05-01T10:00:00Z', subdomain: { enabled: true, previews_enabled: false } },
    { name: 'draft', deployed_on: null, subdomain: { enabled: false, previews_enabled: false } },
  ],
  scripts: [
    { id: 'api', has_modules: true, compatibility_date: '2026-09-01', handlers: ['fetch'], usage_model: 'standard' },
    { id: 'cron-job', has_modules: true, compatibility_date: '2026-09-01', handlers: ['scheduled'], usage_model: 'standard' },
    { id: 'legacy', has_modules: false, compatibility_date: '2023-01-01', handlers: ['fetch'], usage_model: 'bundled' },
    { id: 'draft', has_modules: true, compatibility_date: '2026-09-01', handlers: ['fetch'] },
  ],
  settings: {
    api: { bindings: [{ type: 'kv_namespace', name: 'CACHE', namespace_id: 'ns-used' }, { type: 'service', name: 'AUTH', service: 'deleted-worker' }], compatibility_flags: ['nodejs_compat', 'nodejs_compat_v2'] },
    'cron-job': { bindings: [] },
    legacy: { bindings: [{ type: 'kv_namespace', name: '__STATIC_CONTENT', namespace_id: 'ns-sites' }] },
    draft: { bindings: [] },
  } as Record<string, unknown>,
  deployments: {
    api: { deployments: [{ id: 'dep-api-1', created_on: '2026-11-09T10:40:00Z', source: 'wrangler', author_email: 'dev@example.com', annotations: { 'workers/message': 'Fix login' } }] },
  } as Record<string, unknown>,
};

export interface FakeOptions {
  /** Hourly invocation rows to return from workersInvocationsAdaptive. */
  hourly?: { scriptName: string; datetimeHour: string; requests: number; errors: number; subrequests?: number; cpuTimeUs?: number }[];
  cronRuns?: { scriptName: string; status: string; datetime: string }[];
  /** Reject the cpuTimeUs field like an older schema would. */
  rejectCpuSum?: boolean;
  tokenPolicies?: { name: string }[] | null;
}

export function fakeFetch(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace('/client/v4', '');
    calls.push(`${init?.method ?? 'GET'} ${url.hostname}${path}`);
    if (url.hostname === 'api.github.com') return new Response(JSON.stringify({ tag_name: 'v0.2.0', html_url: 'https://github.com/x/releases/v0.2.0' }));
    if (url.hostname === 'hooks.slack.com') return new Response('ok');
    if (path === '/graphql') {
      const q = JSON.parse(String(init?.body)).query as string;
      if (q.includes('workersInvocationsScheduled')) return gql({ viewer: { accounts: [{ workersInvocationsScheduled: opts.cronRuns ?? [] }] } });
      if (q.includes('status_in')) return gql({ viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } });
      if (q.includes('workersInvocationsAdaptive')) {
        if (opts.rejectCpuSum && q.includes('cpuTimeUs')) return new Response(JSON.stringify({ data: null, errors: [{ message: 'unknown field cpuTimeUs' }] }));
        const rows = (opts.hourly ?? []).map((h) => ({
          dimensions: { scriptName: h.scriptName, datetimeHour: h.datetimeHour },
          sum: { requests: h.requests, errors: h.errors, subrequests: h.subrequests ?? 0, cpuTimeUs: h.cpuTimeUs ?? 0 },
          quantiles: { cpuTimeP99: 1500 },
        }));
        return gql({ viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } });
      }
      return new Response(JSON.stringify({ data: null, errors: [{ message: 'dataset not available' }] }));
    }
    const a = '/accounts/acc1';
    const m = path.match(/^\/accounts\/acc1\/workers\/scripts\/([^/]+)\/(settings|deployments|schedules)$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (m[2] === 'settings') return ok(fleet.settings[name] ?? { bindings: [] });
      if (m[2] === 'deployments') return ok(fleet.deployments[name] ?? { deployments: [] });
      return ok({ schedules: name === 'cron-job' ? [{ cron: '0 * * * *' }] : [] });
    }
    switch (path) {
      case '/accounts': return ok([{ id: 'acc1', name: 'Test account' }]);
      case '/user/tokens/verify': return ok({ id: 'tok1', status: 'active' });
      case '/user/tokens/tok1':
        return opts.tokenPolicies === null
          ? new Response(JSON.stringify({ success: false, errors: [{ message: 'forbidden' }] }), { status: 403 })
          : ok({ policies: [{ effect: 'allow', permission_groups: opts.tokenPolicies ?? [{ name: 'Workers Scripts Read' }, { name: 'Account Analytics Read' }] }] });
      case `${a}/subscriptions`: return ok([]);
      case `${a}/workers/workers`: return ok(fleet.workers);
      case `${a}/workers/scripts`: return ok(fleet.scripts);
      case `${a}/workers/subdomain`: return ok({ subdomain: 'me' });
      case `${a}/workers/domains`: return ok([]);
      case '/zones': return ok([{ id: 'z1', name: 'example.com' }]);
      case '/zones/z1/workers/routes': return ok([{ id: 'r1', pattern: 'example.com/*', script: 'api' }, { id: 'r2', pattern: 'old.example.com/*', script: 'gone' }]);
      case `${a}/storage/kv/namespaces`: return ok([{ id: 'ns-used', title: 'cache' }, { id: 'ns-sites', title: 'sites' }, { id: 'ns-unused', title: 'forgotten' }]);
      case `${a}/d1/database`: return ok([]);
      case `${a}/r2/buckets`: return ok({ buckets: [] });
      case `${a}/queues`: return ok([]);
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: `no fixture for ${path}` }] }), { status: 404 });
  };
  return { fn: fn as typeof fetch, calls };
}
