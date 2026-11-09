// Read-only Cloudflare API client. Every method is a GET or a GraphQL query.
// SPDX-License-Identifier: AGPL-3.0-only

const API = 'https://api.cloudflare.com/client/v4';

export class CfApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

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
  handlers?: string[];
  has_modules?: boolean;
  usage_model?: string;
  created_on?: string;
  modified_on?: string;
}

export interface HourlyRow {
  script: string;
  hour: string;
  requests: number;
  errors: number;
  subrequests: number;
  cpuP99: number | null;
}

export interface CronRunRow {
  script: string;
  hour: string;
  runs: number;
  failures: number;
}

export class CfClient {
  /** Subrequests made by this client in the current invocation. */
  calls = 0;

  constructor(private readonly token: string, readonly accountId: string) {}

  /** Finds the account the token belongs to (first one if several). */
  static async resolveAccountId(token: string): Promise<string> {
    const res = await fetch(`${API}/accounts?per_page=5`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { success: boolean; result?: { id: string }[]; errors?: { message: string }[] };
    if (!body.success || !body.result?.length) {
      throw new CfApiError(body.errors?.[0]?.message ?? 'The token cannot see any account', res.status);
    }
    return body.result[0].id;
  }

  private async get<T>(path: string): Promise<T> {
    this.calls++;
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${this.token}` } });
    const body = (await res.json()) as { success: boolean; result: T; errors?: { message: string }[] };
    if (!body.success) throw new CfApiError(body.errors?.[0]?.message ?? `GET ${path} failed`, res.status);
    return body.result;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    this.calls++;
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] | null };
    if (body.errors?.length || !body.data) throw new CfApiError(body.errors?.[0]?.message ?? 'GraphQL query failed', res.status);
    return body.data;
  }

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

  /** Scripts list: compatibility date, handlers, module format, usage model. */
  listScripts(): Promise<ApiScript[]> {
    return this.get<ApiScript[]>(`/accounts/${this.accountId}/workers/scripts`);
  }

  async schedules(script: string): Promise<string[]> {
    const result = await this.get<{ schedules?: { cron: string }[] }>(
      `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(script)}/schedules`,
    );
    return (result.schedules ?? []).map((s) => s.cron);
  }

  /** Requests, errors, subrequests and p99 CPU per Worker per hour, all Workers in one query. */
  async hourlyMetrics(since: Date, until: Date): Promise<HourlyRow[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }) {
          dimensions { scriptName datetimeHour }
          sum { requests errors subrequests }
          quantiles { cpuTimeP99 }
        }
      } }
    }`;
    type R = {
      viewer: { accounts: { workersInvocationsAdaptive: {
        dimensions: { scriptName: string; datetimeHour: string };
        sum: { requests: number; errors: number; subrequests: number };
        quantiles: { cpuTimeP99: number | null };
      }[] }[] };
    };
    const data = await this.graphql<R>(query, { account: this.accountId, since: since.toISOString(), until: until.toISOString() });
    const rows = data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
    return rows.map((r) => ({
      script: r.dimensions.scriptName,
      hour: r.dimensions.datetimeHour,
      requests: r.sum.requests,
      errors: r.sum.errors,
      subrequests: r.sum.subrequests,
      // cpuTime is reported in microseconds.
      cpuP99: r.quantiles.cpuTimeP99 == null ? null : r.quantiles.cpuTimeP99 / 1000,
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
    const data = await this.graphql<R>(query, { account: this.accountId, since: since.toISOString(), until: until.toISOString() });
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
  async cronRuns(since: Date, until: Date): Promise<CronRunRow[]> {
    const query = `query($account: string!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        workersInvocationsScheduled(limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }) {
          scriptName
          status
          datetime
        }
      } }
    }`;
    type R = { viewer: { accounts: { workersInvocationsScheduled: { scriptName: string; status: string; datetime: string }[] }[] } };
    const data = await this.graphql<R>(query, { account: this.accountId, since: since.toISOString(), until: until.toISOString() });
    const buckets = new Map<string, CronRunRow>();
    for (const r of data.viewer.accounts[0]?.workersInvocationsScheduled ?? []) {
      const hour = `${r.datetime.slice(0, 13)}:00:00Z`;
      const key = `${r.scriptName}|${hour}`;
      const row = buckets.get(key) ?? { script: r.scriptName, hour, runs: 0, failures: 0 };
      row.runs++;
      if (r.status !== 'success') row.failures++;
      buckets.set(key, row);
    }
    return [...buckets.values()];
  }
}
