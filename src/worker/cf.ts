// Read-only Cloudflare API client. Every method is a GET or a GraphQL query.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuotaMetric, StorageKind } from '../shared/limits';

const API = 'https://api.cloudflare.com/client/v4';

export class CfApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The cron-run query hit its row limit, so per-Worker counts would be arbitrary. */
export class CronRunsTruncated extends Error {
  constructor(readonly limit: number) {
    super(`More than ${limit.toLocaleString('en-US')} scheduled runs in 24 hours, too many to count in one query.`);
  }
}

const CRON_RUNS_LIMIT = 10_000;

export interface ApiWorker {
  name: string;
  created_on?: string;
  updated_on?: string;
  deployed_on?: string | null;
  logpush?: boolean;
  observability?: { enabled?: boolean; head_sampling_rate?: number; logs?: { enabled?: boolean } };
  subdomain?: { enabled?: boolean; previews_enabled?: boolean };
  tags?: string[];
}

export interface ApiScript {
  id: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  handlers?: string[];
  has_modules?: boolean;
  usage_model?: string;
  created_on?: string;
  modified_on?: string;
}

/** One binding, reduced to what the checks need. */
export interface Binding {
  type: string;
  name: string;
  /** Resource the binding points at: KV namespace id, D1 id, bucket, queue or service name. */
  target?: string;
}

export interface ScriptSettings {
  bindings: Binding[];
  compatibility_flags: string[];
  tail_consumers: string[];
}

export interface Deployment {
  id: string;
  created_on: string;
  author: string | null;
  message: string | null;
  source: string | null;
  /** Traffic split between versions; more than one entry is a gradual rollout. */
  versions: { id: string; percentage: number }[];
}

export interface Zone {
  id: string;
  name: string;
}

export interface CertPack {
  id: string;
  type: string;
  status: string;
  hosts: string[];
  /** Earliest expiry among the pack's certificates. */
  expiresOn: string | null;
  errors: string[];
}

export interface DnsTarget {
  id: string;
  name: string;
  target: string;
}

export interface PagesProject {
  name: string;
  subdomain: string | null;
  domains: string[];
  productionScript: string | null;
  usesFunctions: boolean;
  latest: { id: string; createdOn: string; status: string; stage: string; environment: string; branch: string | null } | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  description: string | null;
  product: string | null;
  resourceType: string | null;
  resourceId: string | null;
  result: string | null;
}

export interface D1Query {
  databaseId: string;
  query: string;
  rowsRead: number;
  rowsReturned: number;
  runs: number;
}

export interface HourlyRow {
  script: string;
  hour: string;
  requests: number;
  errors: number;
  subrequests: number;
  cpuP99: number | null;
  cpuTimeUs: number;
}

export interface CronRunRow {
  script: string;
  hour: string;
  runs: number;
  failures: number;
  cpuMaxMs: number | null;
}

export interface ResourceOps {
  kind: 'd1' | 'kv' | 'r2' | 'do' | 'queues';
  resource: string;
  hour: string;
  ops: number;
  /** Quota usage carried by the same rows: D1 rows, KV operations by type, Queue operations. */
  metrics?: Partial<Record<QuotaMetric, number>>;
  /** The operation split the richer queries return, kept per resource (D1 and KV). */
  split?: OpsSplit;
}

/** D1: rows read and written, read and write queries. KV: reads, writes, deletes, lists. */
export interface OpsSplit {
  rowsRead?: number;
  rowsWritten?: number;
  reads?: number;
  writes?: number;
  deletes?: number;
  lists?: number;
}

/** Invocations that hit a limit, per Worker and hour, by limit. */
export interface ExceededRow {
  script: string;
  hour: string;
  count: number;
  cpu: number;
  memory: number;
}

/** Account-wide usage for one metric and hour. */
export interface QuotaRow {
  metric: QuotaMetric;
  hour: string;
  value: number;
}

export interface StorageSize {
  kind: StorageKind;
  /** Database ID, namespace ID or bucket name; "*" for the account total (Durable Objects). */
  id: string;
  bytes: number;
  objects?: number;
}

export interface CfAlert {
  id: string;
  sent: string;
  alertType: string;
  name: string;
  description: string;
}

export interface InventoryItem {
  kind: 'kv' | 'd1' | 'r2' | 'queues' | 'route' | 'domain' | 'access' | 'pages' | 'cert' | 'dns';
  id: string;
  name: string | null;
  script: string | null;
  extra?: Record<string, unknown>;
}

const enc = encodeURIComponent;

export class CfClient {
  /** Subrequests made by this client in the current invocation. */
  calls = 0;

  constructor(private readonly token: string, readonly accountId: string) {}

  private static async request<T>(token: string, path: string): Promise<{ result: T; status: number; info?: { cursor?: string; total_pages?: number } }> {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({ success: false }))) as { success: boolean; result: T; result_info?: { cursor?: string; total_pages?: number }; errors?: { message: string }[] };
    if (!body.success) throw new CfApiError(body.errors?.[0]?.message ?? `GET ${path} failed (${res.status})`, res.status);
    return { result: body.result, status: res.status, info: body.result_info };
  }

  /** Accounts the token can see (first page). */
  static async accounts(token: string): Promise<{ id: string; name: string }[]> {
    return (await CfClient.request<{ id: string; name: string }[]>(token, '/accounts?per_page=20')).result;
  }

  /** Finds the account the token belongs to (first one if several). */
  static async resolveAccountId(token: string): Promise<string> {
    const list = await CfClient.accounts(token);
    if (!list.length) throw new CfApiError('The token cannot see any account', 403);
    return list[0].id;
  }

  private async get<T>(path: string): Promise<T> {
    this.calls++;
    return (await CfClient.request<T>(this.token, path)).result;
  }

  private async getPaged<T>(path: string) {
    this.calls++;
    return CfClient.request<T>(this.token, path);
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    this.calls++;
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] | null };
    if (body.errors?.length || !body.data) throw new CfApiError(body.errors?.[0]?.message ?? 'GraphQL query failed', res.status);
    return body.data;
  }

  private window(since: Date, until: Date) {
    return { account: this.accountId, since: since.toISOString(), until: until.toISOString() };
  }

  // ---- Token -------------------------------------------------------------

  /** Verifies the token. User tokens and account-owned tokens use different endpoints. */
  async verifyToken(): Promise<{ id: string; status: string; owner: 'user' | 'account'; expiresOn: string | null }> {
    type R = { id: string; status: string; expires_on?: string | null };
    try {
      const r = await this.get<R>('/user/tokens/verify');
      return { id: r.id, status: r.status, owner: 'user', expiresOn: r.expires_on ?? null };
    } catch (e) {
      const r = await this.get<R>(`/accounts/${this.accountId}/tokens/verify`);
      return { id: r.id, status: r.status, owner: 'account', expiresOn: r.expires_on ?? null };
    }
  }

  /** Cloudflare's own notifications sent to this account (Notifications Read). */
  async alertHistory(since: Date): Promise<CfAlert[]> {
    type R = { id: string; sent: string; alert_type?: string; name?: string; description?: string; alert_body?: string };
    const r = await this.get<R[]>(`/accounts/${this.accountId}/alerting/v3/history?per_page=50&since=${enc(since.toISOString())}`);
    return (r ?? []).map((a) => ({
      id: a.id,
      sent: a.sent,
      alertType: a.alert_type ?? '',
      name: a.name ?? a.alert_type ?? 'Cloudflare notification',
      description: (a.description || a.alert_body || '').slice(0, 500),
    }));
  }

  /**
   * Permission group names of this token. Only works if the token may read its own details
   * (API Tokens Read); otherwise returns null and the wizard asks the user to confirm.
   */
  async tokenPermissions(tokenId: string, owner: 'user' | 'account'): Promise<string[] | null> {
    const path = owner === 'user' ? `/user/tokens/${enc(tokenId)}` : `/accounts/${this.accountId}/tokens/${enc(tokenId)}`;
    try {
      const t = await this.get<{ policies?: { effect?: string; permission_groups?: { name: string }[] }[] }>(path);
      return (t.policies ?? []).filter((p) => p.effect !== 'deny').flatMap((p) => (p.permission_groups ?? []).map((g) => g.name));
    } catch {
      return null;
    }
  }

  /** Best effort: "paid" if the account has a paid Workers subscription. Needs Billing Read; null if unknown. */
  async detectPlan(): Promise<'free' | 'paid' | null> {
    try {
      const subs = await this.get<{ rate_plan?: { id?: string; public_name?: string }; price?: number; state?: string }[]>(
        `/accounts/${this.accountId}/subscriptions`,
      );
      const workers = subs.filter((s) => /workers/i.test(`${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`));
      return workers.some((s) => (s.price ?? 0) > 0 && s.state !== 'Cancelled') ? 'paid' : 'free';
    } catch {
      return null;
    }
  }

  // ---- Inventory ---------------------------------------------------------

  /** Beta Workers list: subdomain, preview, observability and deploy metadata. */
  async listWorkers(): Promise<ApiWorker[]> {
    const out: ApiWorker[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.get<ApiWorker[]>(`/accounts/${this.accountId}/workers/workers?page=${page}&per_page=100`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  /** Scripts list: compatibility date and flags, handlers, module format, usage model. */
  listScripts(): Promise<ApiScript[]> {
    return this.get<ApiScript[]>(`/accounts/${this.accountId}/workers/scripts`);
  }

  async schedules(script: string): Promise<string[]> {
    const result = await this.get<{ schedules?: { cron: string }[] }>(`/accounts/${this.accountId}/workers/scripts/${enc(script)}/schedules`);
    return (result.schedules ?? []).map((s) => s.cron);
  }

  async scriptSettings(script: string): Promise<ScriptSettings> {
    type Raw = {
      bindings?: Record<string, unknown>[];
      compatibility_flags?: string[];
      tail_consumers?: { service?: string }[] | null;
    };
    const r = await this.get<Raw>(`/accounts/${this.accountId}/workers/scripts/${enc(script)}/settings`);
    return {
      bindings: (r.bindings ?? []).map(toBinding),
      compatibility_flags: r.compatibility_flags ?? [],
      tail_consumers: (r.tail_consumers ?? []).map((t) => t.service ?? '').filter(Boolean),
    };
  }

  async deployments(script: string): Promise<Deployment[]> {
    type Raw = {
      deployments?: { id: string; created_on: string; source?: string; author_email?: string; annotations?: Record<string, string>; versions?: { version_id?: string; percentage?: number }[] }[];
    };
    const r = await this.get<Raw>(`/accounts/${this.accountId}/workers/scripts/${enc(script)}/deployments`);
    return (r.deployments ?? []).map((d) => ({
      id: d.id,
      created_on: d.created_on,
      author: d.author_email ?? null,
      message: d.annotations?.['workers/message'] ?? null,
      source: d.source ?? null,
      versions: (d.versions ?? []).map((v) => ({ id: v.version_id ?? '', percentage: v.percentage ?? 0 })),
    }));
  }

  async workersSubdomain(): Promise<string | null> {
    try {
      return (await this.get<{ subdomain?: string }>(`/accounts/${this.accountId}/workers/subdomain`)).subdomain ?? null;
    } catch {
      return null;
    }
  }

  async customDomains(): Promise<InventoryItem[]> {
    const r = await this.get<{ id: string; hostname: string; service: string }[]>(`/accounts/${this.accountId}/workers/domains`);
    return r.map((d) => ({ kind: 'domain', id: d.id, name: d.hostname, script: d.service }));
  }

  /** The account's zones, up to 250. */
  async listZones(): Promise<Zone[]> {
    const out: Zone[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.get<{ id: string; name: string }[]>(`/zones?account.id=${enc(this.accountId)}&per_page=50&page=${page}`);
      out.push(...batch.map((z) => ({ id: z.id, name: z.name })));
      if (batch.length < 50) break;
    }
    return out;
  }

  async zoneRoutes(zone: Zone): Promise<InventoryItem[]> {
    const routes = await this.get<{ id: string; pattern: string; script?: string | null }[]>(`/zones/${zone.id}/workers/routes`);
    return routes.map((r) => ({ kind: 'route', id: r.id, name: r.pattern, script: r.script ?? null, extra: { zone: zone.name } }));
  }

  /** Every certificate pack in a zone, whatever its status (SSL and Certificates Read). */
  async certPacks(zone: Zone): Promise<CertPack[]> {
    type R = { id: string; type?: string; status?: string; hosts?: string[]; certificates?: { expires_on?: string }[]; validation_errors?: { message?: string }[] };
    const packs = await this.get<R[]>(`/zones/${zone.id}/ssl/certificate_packs?status=all&per_page=50`);
    return packs.map((p) => {
      const exp = (p.certificates ?? []).map((c) => c.expires_on).filter((x): x is string => !!x).sort()[0] ?? null;
      return { id: p.id, type: p.type ?? '', status: p.status ?? '', hosts: p.hosts ?? [], expiresOn: exp, errors: (p.validation_errors ?? []).map((e) => e.message ?? '').filter(Boolean) };
    });
  }

  /** CNAME records that point at workers.dev or pages.dev (DNS Read). */
  async cnameTargets(zone: Zone): Promise<DnsTarget[]> {
    const records = await this.get<{ id: string; name: string; content?: string }[]>(`/zones/${zone.id}/dns_records?type=CNAME&per_page=1000`);
    return records
      .map((r) => ({ id: r.id, name: r.name, target: (r.content ?? '').toLowerCase().replace(/\.$/, '') }))
      .filter((r) => r.target.endsWith('.workers.dev') || r.target.endsWith('.pages.dev'));
  }

  /** Pages projects with their latest deployment (Pages Read). */
  async pagesProjects(): Promise<PagesProject[]> {
    type R = {
      name: string; subdomain?: string; domains?: string[]; production_script_name?: string; uses_functions?: boolean;
      latest_deployment?: { id: string; created_on: string; environment?: string; latest_stage?: { name?: string; status?: string }; deployment_trigger?: { metadata?: { branch?: string } } } | null;
    };
    const out: PagesProject[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.get<R[]>(`/accounts/${this.accountId}/pages/projects?per_page=10&page=${page}`);
      out.push(...batch.map((p) => ({
        name: p.name,
        subdomain: p.subdomain ?? null,
        domains: p.domains ?? [],
        productionScript: p.production_script_name ?? null,
        usesFunctions: p.uses_functions === true,
        latest: p.latest_deployment
          ? {
              id: p.latest_deployment.id,
              createdOn: p.latest_deployment.created_on,
              status: p.latest_deployment.latest_stage?.status ?? '',
              stage: p.latest_deployment.latest_stage?.name ?? '',
              environment: p.latest_deployment.environment ?? '',
              branch: p.latest_deployment.deployment_trigger?.metadata?.branch ?? null,
            }
          : null,
      })));
      if (batch.length < 10) break;
    }
    return out;
  }

  /** Audit Logs v2 since a time, oldest first, without "view" actions. Returns a cursor when there is more. */
  async auditLogs(since: Date, until: Date, cursor?: string): Promise<{ events: AuditEvent[]; cursor: string | null }> {
    type R = {
      id: string;
      action?: { type?: string; description?: string; result?: string; time?: string };
      actor?: { email?: string; token_name?: string; type?: string };
      resource?: { product?: string; type?: string; id?: string };
    };
    const q = `since=${enc(since.toISOString())}&before=${enc(until.toISOString())}&direction=asc&limit=200&action_type.not=view${cursor ? `&cursor=${enc(cursor)}` : ''}`;
    const r = await this.getPaged<R[]>(`/accounts/${this.accountId}/logs/audit?${q}`);
    return {
      events: (r.result ?? []).map((e) => ({
        id: e.id,
        at: e.action?.time ?? '',
        actor: e.actor?.email ?? e.actor?.token_name ?? e.actor?.type ?? null,
        action: (e.action?.type ?? '').toLowerCase(),
        description: e.action?.description ?? null,
        product: e.resource?.product ?? null,
        resourceType: e.resource?.type ?? null,
        resourceId: e.resource?.id ?? null,
        result: e.action?.result ?? null,
      })).filter((e) => e.at),
      cursor: (r.result ?? []).length && r.info?.cursor ? r.info.cursor : null,
    };
  }

  /**
   * Top D1 queries by rows read over 24 hours (d1QueriesAdaptiveGroups). The dataset is in the
   * docs; the field names follow the D1 insights output and are read defensively.
   */
  async d1TopQueries(now: Date): Promise<D1Query[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        d1QueriesAdaptiveGroups(limit: 10, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [sum_rowsRead_DESC]) {
          count
          dimensions { query databaseId }
          sum { rowsRead rowsReturned }
        }
      } }
    }`;
    type R = { viewer: { accounts: { d1QueriesAdaptiveGroups: { count: number; dimensions: { query: string; databaseId: string }; sum: { rowsRead: number; rowsReturned: number } }[] }[] } };
    const data = await this.graphql<R>(query, this.window(new Date(now.getTime() - 86_400_000), now));
    return (data.viewer.accounts[0]?.d1QueriesAdaptiveGroups ?? []).map((r) => ({
      databaseId: r.dimensions.databaseId, query: r.dimensions.query ?? '', rowsRead: r.sum.rowsRead ?? 0, rowsReturned: r.sum.rowsReturned ?? 0, runs: r.count ?? 0,
    }));
  }

  async storage(): Promise<{ items: InventoryItem[]; failed: string[] }> {
    const items: InventoryItem[] = [];
    const failed: string[] = [];
    const a = `/accounts/${this.accountId}`;
    const tries: [string, () => Promise<InventoryItem[]>][] = [
      ['KV', async () => (await this.get<{ id: string; title: string }[]>(`${a}/storage/kv/namespaces?per_page=100`)).map((n) => ({ kind: 'kv', id: n.id, name: n.title, script: null }))],
      ['D1', async () => (await this.get<{ uuid: string; name: string }[]>(`${a}/d1/database?per_page=100`)).map((d) => ({ kind: 'd1', id: d.uuid, name: d.name, script: null }))],
      ['R2', async () => ((await this.get<{ buckets?: { name: string }[] }>(`${a}/r2/buckets`)).buckets ?? []).map((b) => ({ kind: 'r2', id: b.name, name: b.name, script: null }))],
      ['Queues', async () => {
        // Queues are used without a binding too: by a consumer Worker, or as another queue's dead-letter queue.
        type Q = { queue_id: string; queue_name: string; producers?: unknown[]; producers_total_count?: number; consumers?: { dead_letter_queue?: string }[]; consumers_total_count?: number };
        const queues = await this.get<Q[]>(`${a}/queues`);
        const deadLetter = new Set(queues.flatMap((q) => (q.consumers ?? []).map((c) => c.dead_letter_queue).filter(Boolean)));
        return queues.map((q) => ({
          kind: 'queues' as const, id: q.queue_id, name: q.queue_name, script: null,
          extra: {
            inUse: Math.max(q.producers?.length ?? 0, q.producers_total_count ?? 0) > 0
              || Math.max(q.consumers?.length ?? 0, q.consumers_total_count ?? 0) > 0
              || deadLetter.has(q.queue_name),
          },
        }));
      }],
    ];
    for (const [label, run] of tries) {
      try {
        items.push(...(await run()));
      } catch {
        failed.push(label);
      }
    }
    return { items, failed };
  }

  async accessApps(): Promise<InventoryItem[]> {
    const apps = await this.get<{ id: string; name: string; type?: string; domain?: string; self_hosted_domains?: string[]; destinations?: { uri?: string }[] }[]>(
      `/accounts/${this.accountId}/access/apps`,
    );
    // Only self-hosted applications gate traffic to a hostname; bookmarks, SaaS and launcher apps do not.
    const gating = new Set(['self_hosted', 'ssh', 'vnc', 'rdp']);
    return apps.filter((app) => !app.type || gating.has(app.type)).map((app) => ({
      kind: 'access',
      id: app.id,
      name: app.name,
      script: null,
      extra: {
        domains: [
          ...(app.domain ? [app.domain] : []),
          ...(app.self_hosted_domains ?? []),
          ...(app.destinations ?? []).map((d) => d.uri ?? '').filter(Boolean),
        ],
      },
    }));
  }

  // ---- Analytics ---------------------------------------------------------

  /**
   * Requests, errors, subrequests, CPU per Worker per hour, all Workers in one query.
   * `withCpuSum` asks for total CPU time; pass false if the account's schema rejects that field.
   */
  async hourlyMetrics(since: Date, until: Date, withCpuSum = true): Promise<HourlyRow[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        ${HOURLY_FIELDS('workersInvocationsAdaptive', withCpuSum)}
      } }
    }`;
    const data = await this.graphql<{ viewer: { accounts: Record<string, InvocationRow[]>[] } }>(query, this.window(since, until));
    return readHourly(data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []);
  }

  /** Invocations that hit the CPU, memory or resource limit, per Worker per hour. */
  async exceededByHour(since: Date, until: Date): Promise<ExceededRow[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        ${EXCEEDED_FIELDS('workersInvocationsAdaptive')}
      } }
    }`;
    const data = await this.graphql<{ viewer: { accounts: Record<string, ExceededGql[]>[] } }>(query, this.window(since, until));
    return readExceeded(data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []);
  }

  /**
   * hourlyMetrics and exceededByHour in one request (two aliased fields): one subrequest instead
   * of two on every scan. Throws when the account rejects the combined query; callers fall back.
   */
  async invocations(since: Date, until: Date, withCpuSum = true): Promise<{ hourly: HourlyRow[]; exceeded: ExceededRow[] }> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        ${HOURLY_FIELDS('totals: workersInvocationsAdaptive', withCpuSum)}
        ${EXCEEDED_FIELDS('limits: workersInvocationsAdaptive')}
      } }
    }`;
    const data = await this.graphql<{ viewer: { accounts: Record<string, unknown[]>[] } }>(query, this.window(since, until));
    const acc = data.viewer.accounts[0] ?? {};
    if (!Array.isArray(acc.totals) || !Array.isArray(acc.limits)) throw new CfApiError('Combined invocations query returned no data', 200);
    return { hourly: readHourly(acc.totals as InvocationRow[]), exceeded: readExceeded(acc.limits as ExceededGql[]) };
  }

  /**
   * Scheduled (cron) invocations. EXPERIMENTAL: availability and field names of this dataset
   * on the Free plan are an open question in the PRD; callers must tolerate failure.
   */
  async cronRuns(since: Date, until: Date, withCpu = true): Promise<CronRunRow[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        workersInvocationsScheduled(limit: ${CRON_RUNS_LIMIT}, filter: { datetime_geq: $since, datetime_lt: $until }) {
          scriptName
          status
          datetime${withCpu ? '\n          cpuTimeUs' : ''}
        }
      } }
    }`;
    type R = { viewer: { accounts: { workersInvocationsScheduled: { scriptName: string; status: string; datetime: string; cpuTimeUs?: number }[] }[] } };
    const data = await this.graphql<R>(query, this.window(since, until));
    const rows = data.viewer.accounts[0]?.workersInvocationsScheduled ?? [];
    if (rows.length >= CRON_RUNS_LIMIT) throw new CronRunsTruncated(CRON_RUNS_LIMIT);
    return bucketCronRuns(rows);
  }

  /**
   * Storage and Durable Object operations per resource per hour, plus the quota usage the same
   * rows carry. Each kind is tried in its richer form first (D1 rows, KV operations by type) and
   * falls back to the plain count; `simple` lists kinds whose richer form the account rejected.
   * With `merge`, every kind goes into one request (aliased fields), one subrequest instead of up
   * to five; if the account rejects that, the kinds are read one by one as before.
   */
  async resourceOps(
    since: Date, until: Date, kinds: ResourceOps['kind'][], simple: Set<string> = new Set(), merge = false,
  ): Promise<{ rows: ResourceOps[]; failed: string[]; downgraded: string[]; merged: boolean | null }> {
    const rows: ResourceOps[] = [];
    const failed: string[] = [];
    const downgraded: string[] = [];
    const variables = this.window(since, until);
    const field = (spec: OpsSpec, alias?: string) => `${alias ? `${alias}: ` : ''}${spec.dataset}(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }) {
            dimensions { ${spec.dims} }
            ${spec.fields}
          }`;
    const wrap = (body: string) => `query($account: string!, $since: Time!, $until: Time!) {
        viewer { accounts(filter: { accountTag: $account }) {
          ${body}
        } }
      }`;
    const specOf = (kind: ResourceOps['kind']) => {
      const sp = OPS_SPECS[kind];
      return sp.rich && !simple.has(kind) ? { spec: sp.rich, idDim: sp.idDim } : { spec: sp.plain, idDim: sp.plain.dims.split(' ')[0] };
    };
    let merged: boolean | null = null;
    if (merge && kinds.length > 1) {
      try {
        const data = await this.graphql<{ viewer: { accounts: Record<string, OpsRow[]>[] } }>(wrap(kinds.map((k) => field(specOf(k).spec, `ops_${k}`)).join('\n          ')), variables);
        const acc = data.viewer.accounts[0] ?? {};
        for (const k of kinds) {
          const { spec, idDim } = specOf(k);
          rows.push(...mergeOps(k, spec, idDim, acc[`ops_${k}`] ?? []));
        }
        return { rows, failed, downgraded, merged: true };
      } catch {
        merged = false; // read them one by one below
      }
    }
    for (const kind of kinds) {
      const sp = OPS_SPECS[kind];
      const run = async (spec: OpsSpec, idDim: string) => {
        const data = await this.graphql<{ viewer: { accounts: Record<string, OpsRow[]>[] } }>(wrap(field(spec)), variables);
        rows.push(...mergeOps(kind, spec, idDim, data.viewer.accounts[0]?.[spec.dataset] ?? []));
      };
      try {
        if (sp.rich && !simple.has(kind)) {
          try {
            await run(sp.rich, sp.idDim);
            continue;
          } catch {
            downgraded.push(kind);
          }
        }
        await run(sp.plain, sp.plain.dims.split(' ')[0]);
      } catch {
        failed.push(kind);
      }
    }
    return { rows, failed, downgraded, merged };
  }

  /** Workflow steps started per hour (workflowsAdaptiveGroups, eventType STEP_START). */
  async workflowSteps(since: Date, until: Date): Promise<QuotaRow[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        workflowsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until, eventType: "STEP_START" }) {
          count
          dimensions { datetimeHour }
        }
      } }
    }`;
    type R = { viewer: { accounts: { workflowsAdaptiveGroups: { count: number; dimensions: { datetimeHour: string } }[] }[] } };
    const data = await this.graphql<R>(query, this.window(since, until));
    return (data.viewer.accounts[0]?.workflowsAdaptiveGroups ?? []).map((r) => ({ metric: 'workflows.steps', hour: r.dimensions.datetimeHour, value: r.count }));
  }

  /**
   * Workers AI neurons per hour. UNVERIFIED: the dataset and field are not in Cloudflare's docs;
   * this follows the naming of the other adaptive datasets and the caller tolerates failure.
   */
  async aiNeurons(since: Date, until: Date): Promise<QuotaRow[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        aiInferenceAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }) {
          sum { totalNeurons }
          dimensions { datetimeHour }
        }
      } }
    }`;
    type R = { viewer: { accounts: { aiInferenceAdaptiveGroups: { sum: { totalNeurons: number }; dimensions: { datetimeHour: string } }[] }[] } };
    const data = await this.graphql<R>(query, this.window(since, until));
    return (data.viewer.accounts[0]?.aiInferenceAdaptiveGroups ?? []).map((r) => ({ metric: 'ai.neurons', hour: r.dimensions.datetimeHour, value: r.sum.totalNeurons }));
  }

  /**
   * Current storage per D1 database, KV namespace and R2 bucket, and the Durable Object total.
   * With `merge`, all kinds go into one request; if the account rejects that, one per kind.
   */
  async storageSizes(kinds: StorageKind[], now: Date, merge = false): Promise<{ sizes: StorageSize[]; failed: StorageKind[]; merged: boolean | null }> {
    const day = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    type Row = { dimensions?: Record<string, string>; max: Record<string, number> };
    const specs: Record<StorageKind, { dataset: string; filter: string; dims: string; fields: string; read: (r: Row) => StorageSize }> = {
      d1: { dataset: 'd1StorageAdaptiveGroups', filter: `date_geq: "${day}"`, dims: 'dimensions { databaseId }', fields: 'max { databaseSizeBytes }',
        read: (r) => ({ kind: 'd1', id: r.dimensions!.databaseId, bytes: r.max.databaseSizeBytes ?? 0 }) },
      kv: { dataset: 'kvStorageAdaptiveGroups', filter: `date_geq: "${day}"`, dims: 'dimensions { namespaceId }', fields: 'max { byteCount keyCount }',
        read: (r) => ({ kind: 'kv', id: r.dimensions!.namespaceId, bytes: r.max.byteCount ?? 0, objects: r.max.keyCount }) },
      r2: { dataset: 'r2StorageAdaptiveGroups', filter: `datetime_geq: "${since}"`, dims: 'dimensions { bucketName }', fields: 'max { payloadSize metadataSize objectCount }',
        read: (r) => ({ kind: 'r2', id: r.dimensions!.bucketName, bytes: (r.max.payloadSize ?? 0) + (r.max.metadataSize ?? 0), objects: r.max.objectCount }) },
      do: { dataset: 'durableObjectsStorageGroups', filter: `date_geq: "${day}"`, dims: '', fields: 'max { storedBytes }',
        read: (r) => ({ kind: 'do', id: '*', bytes: r.max.storedBytes ?? 0 }) },
    };
    const field = (kind: StorageKind, alias?: string) => {
      const sp = specs[kind];
      return `${alias ? `${alias}: ` : ''}${sp.dataset}(limit: 10000, filter: { ${sp.filter} }) { ${sp.dims} ${sp.fields} }`;
    };
    const wrap = (body: string) => `query($account: string!) {
        viewer { accounts(filter: { accountTag: $account }) {
          ${body}
        } }
      }`;
    // Several rows per resource (one per day): keep the largest.
    const largest = (kind: StorageKind, rows: Row[]) => {
      const best = new Map<string, StorageSize>();
      for (const r of rows) {
        const v = specs[kind].read(r);
        if (!best.has(v.id) || best.get(v.id)!.bytes < v.bytes) best.set(v.id, v);
      }
      return [...best.values()];
    };
    const sizes: StorageSize[] = [];
    const failed: StorageKind[] = [];
    let merged: boolean | null = null;
    if (merge && kinds.length > 1) {
      try {
        const data = await this.graphql<{ viewer: { accounts: Record<string, Row[]>[] } }>(wrap(kinds.map((k) => field(k, `size_${k}`)).join('\n          ')), { account: this.accountId });
        const acc = data.viewer.accounts[0] ?? {};
        for (const k of kinds) sizes.push(...largest(k, acc[`size_${k}`] ?? []));
        return { sizes, failed, merged: true };
      } catch {
        merged = false;
      }
    }
    for (const kind of kinds) {
      try {
        const data = await this.graphql<{ viewer: { accounts: Record<string, Row[]>[] } }>(wrap(field(kind)), { account: this.accountId });
        sizes.push(...largest(kind, data.viewer.accounts[0]?.[specs[kind].dataset] ?? []));
      } catch {
        failed.push(kind);
      }
    }
    return { sizes, failed, merged };
  }

}

type OpsRow = { dimensions: Record<string, string>; sum?: Record<string, number>; count?: number };
type OpsSpec = { dataset: string; dims: string; fields: string; read: (r: OpsRow) => { ops: number; metrics?: ResourceOps['metrics']; split?: OpsSplit } };
const opsSum = (r: OpsRow, k: string) => r.sum?.[k] ?? 0;
const KV_ACTIONS: Record<string, [QuotaMetric, keyof OpsSplit]> = {
  read: ['kv.read', 'reads'], write: ['kv.write', 'writes'], delete: ['kv.delete', 'deletes'], list: ['kv.list', 'lists'],
};
const OPS_SPECS: Record<ResourceOps['kind'], { rich?: OpsSpec; plain: OpsSpec; idDim: string }> = {
  d1: {
    idDim: 'databaseId',
    rich: { dataset: 'd1AnalyticsAdaptiveGroups', dims: 'databaseId datetimeHour', fields: 'sum { readQueries writeQueries rowsRead rowsWritten }',
      read: (r) => ({
        ops: opsSum(r, 'readQueries') + opsSum(r, 'writeQueries'),
        metrics: { 'd1.rowsRead': opsSum(r, 'rowsRead'), 'd1.rowsWritten': opsSum(r, 'rowsWritten') },
        split: { rowsRead: opsSum(r, 'rowsRead'), rowsWritten: opsSum(r, 'rowsWritten'), reads: opsSum(r, 'readQueries'), writes: opsSum(r, 'writeQueries') },
      }) },
    plain: { dataset: 'd1AnalyticsAdaptiveGroups', dims: 'databaseId datetimeHour', fields: 'sum { readQueries writeQueries }',
      read: (r) => ({ ops: opsSum(r, 'readQueries') + opsSum(r, 'writeQueries'), split: { reads: opsSum(r, 'readQueries'), writes: opsSum(r, 'writeQueries') } }) },
  },
  kv: {
    idDim: 'namespaceId',
    rich: { dataset: 'kvOperationsAdaptiveGroups', dims: 'namespaceId datetimeHour actionType', fields: 'sum { requests }',
      read: (r) => {
        const a = KV_ACTIONS[r.dimensions.actionType];
        const n = opsSum(r, 'requests');
        return { ops: n, metrics: a ? { [a[0]]: n } : {}, split: a ? { [a[1]]: n } : {} };
      } },
    plain: { dataset: 'kvOperationsAdaptiveGroups', dims: 'namespaceId datetimeHour', fields: 'sum { requests }', read: (r) => ({ ops: opsSum(r, 'requests') }) },
  },
  r2: { idDim: 'bucketName', plain: { dataset: 'r2OperationsAdaptiveGroups', dims: 'bucketName datetimeHour', fields: 'sum { requests }', read: (r) => ({ ops: opsSum(r, 'requests') }) } },
  do: {
    idDim: 'scriptName',
    plain: { dataset: 'durableObjectsInvocationsAdaptiveGroups', dims: 'scriptName datetimeHour', fields: 'sum { requests }',
      read: (r) => ({ ops: opsSum(r, 'requests'), metrics: { 'do.requests': opsSum(r, 'requests') } }) },
  },
  queues: {
    idDim: 'queueID',
    // Field names from the Queues metrics docs: queueID and billableOperations.
    rich: { dataset: 'queueMessageOperationsAdaptiveGroups', dims: 'queueID datetimeHour', fields: 'sum { billableOperations }',
      read: (r) => ({ ops: opsSum(r, 'billableOperations'), metrics: { 'queues.ops': opsSum(r, 'billableOperations') } }) },
    plain: { dataset: 'queueMessageOperationsAdaptiveGroups', dims: 'queueId datetimeHour', fields: 'count', read: (r) => ({ ops: r.count ?? 0, metrics: { 'queues.ops': r.count ?? 0 } }) },
  },
};

/** One row per resource and hour: KV comes back once per action type and is added up here. */
function mergeOps(kind: ResourceOps['kind'], spec: OpsSpec, idDim: string, data: OpsRow[]): ResourceOps[] {
  const merged = new Map<string, ResourceOps>();
  for (const r of data) {
    const resource = r.dimensions[idDim] ?? r.dimensions[idDim.replace('ID', 'Id')];
    const key = `${resource}|${r.dimensions.datetimeHour}`;
    const v = spec.read(r);
    const row = merged.get(key) ?? { kind, resource, hour: r.dimensions.datetimeHour, ops: 0, metrics: {} };
    row.ops += v.ops;
    for (const [m, n] of Object.entries(v.metrics ?? {})) row.metrics![m as QuotaMetric] = (row.metrics![m as QuotaMetric] ?? 0) + (n ?? 0);
    if (v.split) {
      row.split ??= {};
      for (const [k, n] of Object.entries(v.split)) row.split[k as keyof OpsSplit] = (row.split[k as keyof OpsSplit] ?? 0) + (n ?? 0);
    }
    merged.set(key, row);
  }
  return [...merged.values()];
}

type InvocationRow = {
  dimensions: { scriptName: string; datetimeHour: string };
  sum: { requests: number; errors: number; subrequests: number; cpuTimeUs?: number };
  quantiles: { cpuTimeP99: number | null };
};
type ExceededGql = { dimensions: { scriptName: string; datetimeHour: string; status?: string }; sum: { requests: number } };

const HOURLY_FIELDS = (field: string, withCpuSum: boolean) => `${field}(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }) {
          dimensions { scriptName datetimeHour }
          sum { requests errors subrequests${withCpuSum ? ' cpuTimeUs' : ''} }
          quantiles { cpuTimeP99 }
        }`;

const EXCEEDED_FIELDS = (field: string) => `${field}(limit: 10000, filter: {
          datetime_geq: $since, datetime_lt: $until,
          status_in: ["exceededCpu", "exceededMemory", "exceededResources"]
        }) {
          dimensions { scriptName datetimeHour status }
          sum { requests }
        }`;

function readHourly(rows: InvocationRow[]): HourlyRow[] {
  return rows.map((r) => ({
    script: r.dimensions.scriptName,
    hour: r.dimensions.datetimeHour,
    requests: r.sum.requests,
    errors: r.sum.errors,
    subrequests: r.sum.subrequests,
    // cpuTime is reported in microseconds.
    cpuP99: r.quantiles.cpuTimeP99 == null ? null : r.quantiles.cpuTimeP99 / 1000,
    cpuTimeUs: r.sum.cpuTimeUs ?? 0,
  }));
}

/** One row per Worker and hour, with the CPU and memory hits split out of the total. */
export function readExceeded(rows: ExceededGql[]): ExceededRow[] {
  const out = new Map<string, ExceededRow>();
  for (const r of rows) {
    const key = `${r.dimensions.scriptName}|${r.dimensions.datetimeHour}`;
    const row = out.get(key) ?? { script: r.dimensions.scriptName, hour: r.dimensions.datetimeHour, count: 0, cpu: 0, memory: 0 };
    row.count += r.sum.requests;
    if (r.dimensions.status === 'exceededCpu') row.cpu += r.sum.requests;
    if (r.dimensions.status === 'exceededMemory') row.memory += r.sum.requests;
    out.set(key, row);
  }
  return [...out.values()];
}

export function bucketCronRuns(rows: { scriptName: string; status: string; datetime: string; cpuTimeUs?: number }[]): CronRunRow[] {
  const buckets = new Map<string, CronRunRow>();
  for (const r of rows) {
    const hour = `${r.datetime.slice(0, 13)}:00:00Z`;
    const key = `${r.scriptName}|${hour}`;
    const row = buckets.get(key) ?? { script: r.scriptName, hour, runs: 0, failures: 0, cpuMaxMs: null };
    row.runs++;
    if (r.status !== 'success') row.failures++;
    if (r.cpuTimeUs != null) row.cpuMaxMs = Math.max(row.cpuMaxMs ?? 0, r.cpuTimeUs / 1000);
    buckets.set(key, row);
  }
  return [...buckets.values()];
}

export function toBinding(b: Record<string, unknown>): Binding {
  const type = String(b.type ?? '');
  const name = String(b.name ?? '');
  const target =
    type === 'kv_namespace' ? b.namespace_id
    : type === 'd1' ? (b.id ?? b.database_id)
    : type === 'r2_bucket' ? b.bucket_name
    : type === 'queue' ? (b.queue_name ?? b.queue)
    : type === 'service' ? b.service
    : type === 'durable_object_namespace' ? (b.script_name ?? undefined)
    : undefined;
  return target ? { type, name, target: String(target) } : { type, name };
}
