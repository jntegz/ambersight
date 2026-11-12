// Hash routes with query parameters, so every view can be bookmarked and shared:
// "#/worker/api?range=30d", "#/analytics?range=90d&tab=cost", "#/findings?status=snoozed".
// SPDX-License-Identifier: AGPL-3.0-only
import { RANGES, type Range } from '../../../src/shared/types';

export type Route = 'overview' | 'analytics' | 'findings' | 'worker' | 'timeline' | 'resources' | 'packages' | 'settings' | 'accounts';

export interface Location {
  route: Route;
  /** The Worker name on #/worker/<name>. */
  arg: string | null;
  params: URLSearchParams;
}

const PAGES: Route[] = ['analytics', 'findings', 'timeline', 'resources', 'packages', 'settings', 'accounts'];

export function parseHash(hash: string): Location {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'worker' && parts[1]) return { route: 'worker', arg: decodeURIComponent(parts.slice(1).join('/')), params };
  const page = PAGES.find((p) => p === parts[0]);
  return { route: page ?? 'overview', arg: null, params };
}

/** Changes one query parameter of the current view without adding a history entry or reloading. */
export function setParam(key: string, value: string | null) {
  const [path, query = ''] = location.hash.split('?');
  const params = new URLSearchParams(query);
  if (value == null || value === '') params.delete(key);
  else params.set(key, value);
  const q = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${location.search}${path || '#/'}${q ? `?${q}` : ''}`);
}

export const rangeParam = (params: URLSearchParams, fallback: Range): Range => {
  const r = params.get('range');
  return r && (RANGES as string[]).includes(r) ? (r as Range) : fallback;
};

export const RANGE_LABEL: Record<Range, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '365d': '12 months' };
export const RANGE_SHORT: Record<Range, string> = { '24h': '24h', '7d': '7d', '30d': '30d', '90d': '90d', '365d': '12m' };
