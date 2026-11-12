// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../../../src/shared/config';
import type { AccountSummary, AnalyticsView, FindingEvent, FindingListItem, Overview, PackagesView, Range, ResourcesView, SelfCost, SetupStatus, SinceView, TimelineEntry, WorkerDetail } from '../../../src/shared/types';

export interface ScanResult {
  skipped?: boolean;
  workers: number;
  findings: number;
  subrequests: number;
  warnings: string[];
  detailRemaining?: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? res.statusText, res.status);
  return body as T;
}

const q = (account?: string) => (account ? `?account=${encodeURIComponent(account)}` : '');

export interface TokenInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const api = {
  tokens: () => call<TokenInfo[]>('/api/tokens'),
  createToken: (name: string) => call<{ token: string; info: TokenInfo }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeToken: (id: string) => call<{ ok: true }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  session: () => call<{ authenticated: boolean; turnstileSiteKey?: string | null }>('/api/session'),
  login: (passphrase: string, turnstile?: string) =>
    call<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ passphrase, ...(turnstile ? { turnstile } : {}) }) }),
  logout: () => call<{ ok: true }>('/api/logout', { method: 'POST' }),
  overview: (account?: string) => call<Overview>(`/api/overview${q(account)}`),
  /** The "All accounts" view. */
  accounts: () => call<AccountSummary[]>('/api/accounts'),
  /** The full set of accounts to watch. */
  saveAccounts: (ids: string[]) => call<AccountSummary[]>('/api/accounts', { method: 'PUT', body: JSON.stringify({ ids }) }),
  scan: (account?: string) => call<ScanResult>('/api/scan', { method: 'POST', body: JSON.stringify(account ? { account } : {}) }),
  timeline: (days: number, account?: string) => call<TimelineEntry[]>(`/api/timeline?days=${days}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  packages: (account?: string) => call<PackagesView>(`/api/packages${q(account)}`),
  resources: (account?: string) => call<ResourcesView>(`/api/resources${q(account)}`),
  selfCost: (account?: string) => call<SelfCost>(`/api/self-cost${q(account)}`),
  setup: (account?: string) => call<SetupStatus>(account ? `/api/setup?account=${encodeURIComponent(account)}` : '/api/setup'),
  completeSetup: (body: { timeZone: string; confirmReadOnly?: true; accountId?: string; accountIds?: string[] }) =>
    call<{ ok: true }>('/api/setup/complete', { method: 'POST', body: JSON.stringify(body) }),
  config: () => call<Config>('/api/config'),
  saveConfig: (config: Config) => call<Config>('/api/config', { method: 'PUT', body: JSON.stringify(config) }),
  testNotify: (channel: 'email' | 'webhook') => call<{ ok: true }>('/api/notify/test', { method: 'POST', body: JSON.stringify({ channel }) }),
  /** Signs out every session, including this one. */
  changePassphrase: (current: string, next: string) =>
    call<{ ok: true }>('/api/passphrase', { method: 'POST', body: JSON.stringify({ current, next }) }),
  acknowledge: (id: string) => call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' }),
  snooze: (id: string, days: 7 | 30 | 90) =>
    call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/snooze`, { method: 'POST', body: JSON.stringify({ days }) }),
  /** Undo an acknowledge or a snooze. */
  restore: (id: string) => call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  findings: (status: 'open' | 'acknowledged' | 'snoozed' | 'resolved', account?: string) =>
    call<FindingListItem[]>(`/api/findings?status=${status}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  changes: (since: string, account?: string) =>
    call<SinceView>(`/api/changes?since=${encodeURIComponent(since)}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  history: (id: string) => call<FindingEvent[]>(`/api/findings/${encodeURIComponent(id)}/history`),
  analytics: (range: Range, account?: string) => call<AnalyticsView>(`/api/analytics?range=${range}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  worker: (name: string, range: Range, account?: string) =>
    call<WorkerDetail>(`/api/workers/${encodeURIComponent(name)}?range=${range}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  /** A whole group at once. */
  bulk: (ids: string[], action: 'acknowledge' | 'snooze' | 'restore', days?: 7 | 30 | 90) =>
    call<{ ok: true; changed: number }>('/api/findings/bulk', { method: 'POST', body: JSON.stringify({ ids, action, days }) }),
};

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export const num = (n: number) => n.toLocaleString('en-US');

export const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** Percentage with one decimal under 10%, "<0.1%" for tiny non-zero shares. */
export const pct = (share: number) => {
  const p = share * 100;
  return (p > 0 && p < 0.1 ? '<0.1' : p.toFixed(p < 10 ? 1 : 0)) + '%';
};

/** UTC day labels for a series of `n` days ending today (matches WorkerSummary.spark). */
export function dayLabels(n = 7, now = Date.now()): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now - (n - 1 - i) * 86_400_000);
    return i === n - 1 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  });
}

/** Stable DOM id for a Worker's card or table row. */
export const workerId = (name: string) => `w-${name}`;

/** The Worker page. */
export const workerHref = (name: string) => `#/worker/${encodeURIComponent(name)}`;

/** Signed change against the period before: "+12%", "−3%", "new" or "" when both are zero. */
export function change(now: number, before: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (!before) return now ? { text: 'new', dir: 'up' } : { text: '', dir: 'flat' };
  const r = (now - before) / before;
  if (Math.abs(r) < 0.005) return { text: '0%', dir: 'flat' };
  const p = Math.abs(r) * 100;
  return { text: `${r > 0 ? '+' : '−'}${p >= 100 ? Math.round(p).toLocaleString('en-US') : p.toFixed(p < 10 ? 1 : 0)}%`, dir: r > 0 ? 'up' : 'down' };
}

export const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** "1.2 ms" style durations from milliseconds. */
export const ms = (n: number | null) => (n == null ? '–' : n < 1 ? `${n.toFixed(2)} ms` : n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n).toLocaleString('en-US')} ms`);

export const bytes = (n: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toPrecision(2)} ${units[i]}`;
};
