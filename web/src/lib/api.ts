// SPDX-License-Identifier: AGPL-3.0-only
import type { Overview } from '../../../src/shared/types';

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

export const api = {
  session: () => call<{ authenticated: boolean }>('/api/session'),
  login: (passphrase: string) => call<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ passphrase }) }),
  logout: () => call<{ ok: true }>('/api/logout', { method: 'POST' }),
  overview: () => call<Overview>('/api/overview'),
  scan: () => call<{ workers: number; findings: number; warnings: string[] }>('/api/scan', { method: 'POST' }),
  acknowledge: (id: string) => call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' }),
  snooze: (id: string, days: 7 | 30 | 90) =>
    call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/snooze`, { method: 'POST', body: JSON.stringify({ days }) }),
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
