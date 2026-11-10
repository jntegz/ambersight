// Incidents from the public Cloudflare status page (cloudflarestatus.com, a Statuspage site).
// Contacted only when the "Cloudflare incidents" check is on; the request carries nothing about the account.
// SPDX-License-Identifier: AGPL-3.0-only

import { allowedFetch, OPTIONAL_HOSTS } from './net';

export interface Incident {
  id: string;
  name: string;
  impact: string | null;
  status: string | null;
  createdAt: string;
  resolvedAt: string | null;
  url: string | null;
}

/** Incidents from the public Cloudflare status page (Statuspage API). `unresolved` lists only open ones. */
export async function fetchIncidents(which: 'incidents' | 'unresolved'): Promise<Incident[]> {
  const path = which === 'unresolved' ? 'incidents/unresolved.json' : 'incidents.json';
  const res = await allowedFetch(`https://${OPTIONAL_HOSTS.incidents}/api/v2/${path}`, { headers: { Accept: 'application/json' } }, undefined, [OPTIONAL_HOSTS.incidents]);
  if (!res.ok) throw new Error(`The status page answered ${res.status}`);
  const body = (await res.json()) as { incidents?: { id: string; name: string; impact?: string; status?: string; created_at: string; resolved_at?: string | null; shortlink?: string }[] };
  return (body.incidents ?? []).slice(0, 50).map((i) => ({
    id: i.id, name: i.name.slice(0, 300), impact: i.impact ?? null, status: i.status ?? null, createdAt: i.created_at, resolvedAt: i.resolved_at ?? null, url: i.shortlink ?? null,
  }));
}
