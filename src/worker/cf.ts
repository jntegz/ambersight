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
  kind: 'kv' | 'd1' | 'r2' | 'queues' | 'route' | 'domain' | 'access';
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

  private static async request<T>(token: string, path: string): Promise<{ result: T; status: number }> {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({ success: false }))) as { success: boolean; result: T; errors?: { message: string }[] };
    if (!body.success) throw new CfApiError(body.errors?.[0]?.message ?? `GET ${path} failed (${res.status})`, res.status);
    return { result: body.result, status: res.status };
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
      deployments?: { id: string; created_on: string; source?: string; author_email?: string; annotations?: Record<string, string> }[];
    };
    const r = await this.get<Raw>(`/accounts/${this.accountId}/workers/scripts/${enc(script)}/deployments`);
    return (r.deployments ?? []).map((d) => ({
      id: d.id,
      created_on: d.created_on,
      author: d.author_email ?? null,
      message: d.annotations?.['workers/message'] ?? null,
      source: d.source ?? null,
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

  /** Routes across the account's zones (first `maxZones` zones). */
  async routes(maxZones: number): Promise<{ items: InventoryItem[]; zonesSkipped: number; zonesChecked: string[] }> {
    const zones = await this.get<{ id: string; name: string }[]>(`/zones?account.id=${this.accountId}&per_page=50`);
    const items: InventoryItem[] = [];
    const checked = zones.slice(0, maxZones);
    for (const z of checked) {
      const routes = await this.get<{ id: string; pattern: string; script?: string | null }[]>(`/zones/${z.id}/workers/routes`);
      for (const r of routes) items.push({ kind: 'route', id: r.id, name: r.pattern, script: r.script ?? null, extra: { zone: z.name } });
    }
    return { items, zonesSkipped: Math.max(0, zones.length - maxZones), zonesChecked: checked.map((z) => z.name) };
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
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }) {
          dimensions { scriptName datetimeHour }
          sum { requests errors subrequests${withCpuSum ? ' cpuTimeUs' : ''} }
          quantiles { cpuTimeP99 }
        }
      } }
    }`;
    type R = {
      viewer: { accounts: { workersInvocationsAdaptive: {
        dimensions: { scriptName: string; datetimeHour: string };
        sum: { requests: number; errors: number; subrequests: number; cpuTimeUs?: number };
        quantiles: { cpuTimeP99: number | null };
      }[] }[] };
    };
    const data = await this.graphql<R>(query, this.window(since, until));
    return (data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []).map((r) => ({
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

  /** Invocations that hit the CPU or memory limit, per Worker per hour. */
  async exceededByHour(since: Date, until: Date): Promise<{ script: string; hour: string; count: number }[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        workersInvocationsAdaptive(limit: 10000, filter: {
          datetime_geq: $since, datetime_lt: $until,
          status_in: ["exceededCpu", "exceededMemory", "exceededResources"]
        }) {
          dimensions { scriptName datetimeHour }
          sum { requests }
        }
      } }
    }`;
    type R = { viewer: { accounts: { workersInvocationsAdaptive: { dimensions: { scriptName: string; datetimeHour: string }; sum: { requests: number } }[] }[] } };
    const data = await this.graphql<R>(query, this.window(since, until));
    return (data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []).map((r) => ({
      script: r.dimensions.scriptName,
      hour: r.dimensions.datetimeHour,
      count: r.sum.requests,
    }));
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
   */
  async resourceOps(
    since: Date, until: Date, kinds: ResourceOps['kind'][], simple: Set<string> = new Set(),
  ): Promise<{ rows: ResourceOps[]; failed: string[]; downgraded: string[] }> {
    type Spec = { dataset: string; dims: string; fields: string; read: (r: Row) => { ops: number; metrics?: ResourceOps['metrics'] } };
    type Row = { dimensions: Record<string, string>; sum?: Record<string, number>; count?: number };
    const s = (r: Row, k: string) => r.sum?.[k] ?? 0;
    const kvMetric: Record<string, QuotaMetric> = { read: 'kv.read', write: 'kv.write', delete: 'kv.delete', list: 'kv.list' };
    const specs: Record<ResourceOps['kind'], { rich?: Spec; plain: Spec; idDim: string }> = {
      d1: {
        idDim: 'databaseId',
        rich: { dataset: 'd1AnalyticsAdaptiveGroups', dims: 'databaseId datetimeHour', fields: 'sum { readQueries writeQueries rowsRead rowsWritten }',
          read: (r) => ({ ops: s(r, 'readQueries') + s(r, 'writeQueries'), metrics: { 'd1.rowsRead': s(r, 'rowsRead'), 'd1.rowsWritten': s(r, 'rowsWritten') } }) },
        plain: { dataset: 'd1AnalyticsAdaptiveGroups', dims: 'databaseId datetimeHour', fields: 'sum { readQueries writeQueries }', read: (r) => ({ ops: s(r, 'readQueries') + s(r, 'writeQueries') }) },
      },
      kv: {
        idDim: 'namespaceId',
        rich: { dataset: 'kvOperationsAdaptiveGroups', dims: 'namespaceId datetimeHour actionType', fields: 'sum { requests }',
          read: (r) => {
            const m = kvMetric[r.dimensions.actionType];
            return { ops: s(r, 'requests'), metrics: m ? { [m]: s(r, 'requests') } : {} };
          } },
        plain: { dataset: 'kvOperationsAdaptiveGroups', dims: 'namespaceId datetimeHour', fields: 'sum { requests }', read: (r) => ({ ops: s(r, 'requests') }) },
      },
      r2: { idDim: 'bucketName', plain: { dataset: 'r2OperationsAdaptiveGroups', dims: 'bucketName datetimeHour', fields: 'sum { requests }', read: (r) => ({ ops: s(r, 'requests') }) } },
      do: {
        idDim: 'scriptName',
        plain: { dataset: 'durableObjectsInvocationsAdaptiveGroups', dims: 'scriptName datetimeHour', fields: 'sum { requests }',
          read: (r) => ({ ops: s(r, 'requests'), metrics: { 'do.requests': s(r, 'requests') } }) },
      },
      queues: {
        idDim: 'queueID',
        // Field names from the Queues metrics docs: queueID and billableOperations.
        rich: { dataset: 'queueMessageOperationsAdaptiveGroups', dims: 'queueID datetimeHour', fields: 'sum { billableOperations }',
          read: (r) => ({ ops: s(r, 'billableOperations'), metrics: { 'queues.ops': s(r, 'billableOperations') } }) },
        plain: { dataset: 'queueMessageOperationsAdaptiveGroups', dims: 'queueId datetimeHour', fields: 'count', read: (r) => ({ ops: r.count ?? 0, metrics: { 'queues.ops': r.count ?? 0 } }) },
      },
    };
    const rows: ResourceOps[] = [];
    const failed: string[] = [];
    const downgraded: string[] = [];
    const run = async (kind: ResourceOps['kind'], spec: Spec, idDim: string) => {
      const query = `query($account: string!, $since: Time!, $until: Time!) {
        viewer { accounts(filter: { accountTag: $account }) {
          ${spec.dataset}(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }) {
            dimensions { ${spec.dims} }
            ${spec.fields}
          }
        } }
      }`;
      const data = await this.graphql<{ viewer: { accounts: Record<string, Row[]>[] } }>(query, this.window(since, until));
      // KV comes back once per action type: merge into one row per namespace and hour.
      const merged = new Map<string, ResourceOps>();
      for (const r of data.viewer.accounts[0]?.[spec.dataset] ?? []) {
        const resource = r.dimensions[idDim] ?? r.dimensions[idDim.replace('ID', 'Id')];
        const key = `${resource}|${r.dimensions.datetimeHour}`;
        const v = spec.read(r);
        const row = merged.get(key) ?? { kind, resource, hour: r.dimensions.datetimeHour, ops: 0, metrics: {} };
        row.ops += v.ops;
        for (const [m, n] of Object.entries(v.metrics ?? {})) row.metrics![m as QuotaMetric] = (row.metrics![m as QuotaMetric] ?? 0) + (n ?? 0);
        merged.set(key, row);
      }
      rows.push(...merged.values());
    };
    for (const kind of kinds) {
      const sp = specs[kind];
      try {
        if (sp.rich && !simple.has(kind)) {
          try {
            await run(kind, sp.rich, sp.idDim);
            continue;
          } catch {
            downgraded.push(kind);
          }
        }
        await run(kind, sp.plain, sp.plain.dims.split(' ')[0]);
      } catch {
        failed.push(kind);
      }
    }
    return { rows, failed, downgraded };
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

  /** Current storage per D1 database, KV namespace and R2 bucket, and the Durable Object total. */
  async storageSizes(kinds: StorageKind[], now: Date): Promise<{ sizes: StorageSize[]; failed: StorageKind[] }> {
    const day = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const since = new Date(now.getTime() - 86_400_000).toISOString();
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
    type Row = { dimensions?: Record<string, string>; max: Record<string, number> };
    const sizes: StorageSize[] = [];
    const failed: StorageKind[] = [];
    for (const kind of kinds) {
      const sp = specs[kind];
      const query = `query($account: string!) {
        viewer { accounts(filter: { accountTag: $account }) {
          ${sp.dataset}(limit: 10000, filter: { ${sp.filter} }) { ${sp.dims} ${sp.fields} }
        } }
      }`;
      try {
        const data = await this.graphql<{ viewer: { accounts: Record<string, Row[]>[] } }>(query, { account: this.accountId });
        // Several rows per resource (one per day): keep the largest.
        const best = new Map<string, StorageSize>();
        for (const r of data.viewer.accounts[0]?.[sp.dataset] ?? []) {
          const v = sp.read(r);
          if (!best.has(v.id) || best.get(v.id)!.bytes < v.bytes) best.set(v.id, v);
        }
        sizes.push(...best.values());
      } catch {
        failed.push(kind);
      }
    }
    return { sizes, failed };
  }
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
