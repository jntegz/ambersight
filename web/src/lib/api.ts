// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../../../src/shared/config';
import type { AccountSummary, Overview, SelfCost, SetupStatus, TimelineEntry } from '../../../src/shared/types';

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

export const api = {
  session: () => call<{ authenticated: boolean }>('/api/session'),
  login: (passphrase: string) => call<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  logout: () => call<{ ok: true }>('/api/logout', { method: 'POST' }),
  overview: (account?: string) => call<Overview>(`/api/overview${q(account)}`),
  /** The "All accounts" view. */
  accounts: () => call<AccountSummary[]>('/api/accounts'),
  /** The full set of accounts to watch. */
  saveAccounts: (ids: string[]) => call<AccountSummary[]>('/api/accounts', { method: 'PUT', body: JSON.stringify({ ids }) }),
  scan: (account?: string) => call<ScanResult>('/api/scan', { method: 'POST', body: JSON.stringify(account ? { account } : {}) }),
  timeline: (days: number, account?: string) => call<TimelineEntry[]>(`/api/timeline?days=${days}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
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
  /** A whole group at once. */
  bulk: (ids: string[], action: 'acknowledge' | 'snooze', days?: 7 | 30 | 90) =>
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

/** Stable DOM id for a Worker's card or table row, used by in-page links. */
export const workerId = (name: string) => `w-${name}`;
