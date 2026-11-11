// The Resources page: every KV namespace, D1 database, R2 bucket and queue, the Workers that bind
// it, its size and when it was last used. Read from D1 only when the page is opened; no Cloudflare
// API calls. Status comes from the same helpers as the unused-storage checks.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config } from '../shared/config';
import type { ResourcesView } from '../shared/types';
import { activityOf, boundByMap, storageStatus, type InventoryFacts, type StorageFact, type StorageKind4 } from './hygiene';


export async function buildResources(db: D1Database, account: string, config: Config, now = new Date()): Promise<ResourcesView> {
  const [resR, workersR, sizesR, activityR, stateR] = await db.batch([
    db.prepare(`SELECT kind, id, name, extra FROM resources WHERE account = ?1 AND kind IN ('kv','d1','r2','queues')`).bind(account),
    db.prepare('SELECT name, bindings, detail_checked_at FROM workers WHERE account = ?1').bind(account),
    db.prepare(`SELECT kind, id, bytes, objects FROM storage_sizes WHERE account = ?1 AND kind IN ('kv','d1','r2')`).bind(account),
    db.prepare('SELECT kind, resource, last_active_hour FROM resource_activity WHERE account = ?1').bind(account),
    db.prepare(`SELECT key, value FROM account_state WHERE account = ?1 AND key IN ('ops_since','inventory_at')`).bind(account),
  ]);
  const settings = Object.fromEntries((stateR.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const res = resR.results as { kind: StorageKind4; id: string; name: string | null; extra: string | null }[];
  const workers = workersR.results as { name: string; bindings: string | null; detail_checked_at: string | null }[];
  const owners = boundByMap(workers.map((w) => ({ name: w.name, bindings: w.detail_checked_at && w.bindings ? JSON.parse(w.bindings) : null })), res);
  const sizes = new Map((sizesR.results as { kind: string; id: string; bytes: number; objects: number | null }[]).map((z) => [`${z.kind}|${z.id}`, z]));
  const last = new Map((activityR.results as { kind: string; resource: string; last_active_hour: string }[]).map((a) => [`${a.kind}|${a.resource}`, a.last_active_hour]));

  const inv: Pick<InventoryFacts, 'activitySince'> = { activitySince: settings.ops_since ? JSON.parse(settings.ops_since) : {} };
  const windowDays = Math.min(config.thresholds.zombieDays, config.retentionDays);

  const resources = res.map((r) => {
    const key = `${r.kind}|${r.id}`;
    const fact: StorageFact = {
      kind: r.kind, id: r.id, name: r.name,
      inUse: r.extra ? (JSON.parse(r.extra) as { inUse?: boolean }).inUse === true : false,
      boundBy: owners.get(key) ?? [],
      lastActiveHour: last.get(key) ?? null,
      bytes: sizes.get(key)?.bytes ?? null,
      objects: sizes.get(key)?.objects ?? null,
    };
    const activity = activityOf(fact, inv, now, windowDays);
    return {
      kind: r.kind, id: r.id, name: r.name ?? r.id, boundBy: fact.boundBy!, inUse: fact.inUse!,
      lastActiveHour: fact.lastActiveHour!, activity, bytes: fact.bytes!, objects: fact.objects!,
      status: storageStatus(fact, activity),
    };
  });
  const ORDER = { outside: 0, unbound: 1, idle: 2, 'in-use': 3 } as const;
  resources.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return {
    ready: (Boolean(settings.inventory_at) || res.length > 0) && workers.every((w) => w.detail_checked_at),
    windowDays,
    resources,
  };
}
