// Hygiene checks: M2 deprecation radar, M3 exposure audit, M7 zombies and orphans.
// Pure functions over Worker metadata and the account inventory.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config, Thresholds } from '../shared/config';
import { SAFE_NAME } from '../shared/findings';
import { fmtBytes } from '../shared/limits';
import type { Finding } from '../shared/types';
import { finding, type WorkerMeta, type WorkerStats } from './checks';

export type StorageKind4 = 'kv' | 'd1' | 'r2' | 'queues';

/** One KV namespace, D1 database, R2 bucket or queue, with what Ambersight knows about its use. */
export interface StorageFact {
  kind: StorageKind4;
  id: string;
  name: string | null;
  /** Used without a binding (a queue with a consumer or producer, or a dead-letter queue). */
  inUse?: boolean;
  /** Every Worker that binds it, in scope or not. Undefined when not worked out (older callers). */
  boundBy?: string[];
  /** Last hour with any operation (from the hourly operations, not reread each scan). */
  lastActiveHour?: string | null;
  bytes?: number | null;
  /** Keys (KV) or objects (R2), when Cloudflare reports them. */
  objects?: number | null;
}

export interface InventoryFacts {
  /** False until every in-scope Worker's settings (bindings) have been fetched once. */
  bindingsComplete: boolean;
  /** False until the first full inventory refresh has run. */
  refreshed: boolean;
  storage: StorageFact[];
  /** Per kind, since when its operations are known without a gap (ISO time). Missing kind: no activity claims. */
  activitySince?: Partial<Record<StorageKind4, string>>;
  routes: { id: string; pattern: string; script: string | null }[];
  domains: { id: string; hostname: string; script: string | null }[];
  /** null = Access check off or not readable. */
  accessDomains: string[] | null;
  workersSubdomain: string | null;
  /** Days since Ambersight first stored metrics for this account. */
  trackingDays: number;
  retentionDays: number;
}

const DOCS = {
  modules: 'https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/',
  compat: 'https://developers.cloudflare.com/workers/configuration/compatibility-dates/',
  flags: 'https://developers.cloudflare.com/workers/configuration/compatibility-flags/',
  sites: 'https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-workers-sites/',
  pricing: 'https://developers.cloudflare.com/workers/platform/pricing/',
  previews: 'https://developers.cloudflare.com/workers/configuration/previews/',
  workersDev: 'https://developers.cloudflare.com/workers/configuration/routing/workers-dev/',
  access: 'https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/',
  bindings: 'https://developers.cloudflare.com/workers/runtime-apis/bindings/',
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Operations this recent on an unbound resource mean something may still use it. */
const RECENT_HOURS = 48;

const BINDING_TYPE: Record<StorageKind4, string> = { kv: 'kv_namespace', d1: 'd1', r2: 'r2_bucket', queues: 'queue' };
export const STORAGE_LABEL: Record<StorageKind4, string> = { kv: 'KV namespace', d1: 'D1 database', r2: 'R2 bucket', queues: 'Queue' };

/** The Workers that bind each resource, keyed "kind|id". Queues are bound by name, the rest by id. */
export function boundByMap(
  workers: { name: string; bindings: { type: string; target?: string }[] | null }[],
  storage: Pick<StorageFact, 'kind' | 'id' | 'name'>[],
): Map<string, string[]> {
  const byTarget = new Map<string, Set<string>>();
  for (const w of workers) {
    for (const b of w.bindings ?? []) {
      if (!b.target) continue;
      const k = `${b.type}|${b.target}`;
      (byTarget.get(k) ?? byTarget.set(k, new Set()).get(k)!).add(w.name);
    }
  }
  const out = new Map<string, string[]>();
  for (const s of storage) {
    const target = s.kind === 'queues' ? s.name : s.id;
    out.set(`${s.kind}|${s.id}`, [...(byTarget.get(`${BINDING_TYPE[s.kind]}|${target}`) ?? [])].sort());
  }
  return out;
}

/**
 * How recently a resource had operations. recent: within 48 hours. earlier: inside the window.
 * quiet: none in the whole window (only claimed once this kind's operations have been read without
 * a gap for that long). unknown: not collected, or not for long enough.
 */
export type Activity = 'recent' | 'earlier' | 'quiet' | 'unknown';

export function activityOf(s: StorageFact, inv: Pick<InventoryFacts, 'activitySince'>, now: Date, windowDays: number): Activity {
  const since = inv.activitySince?.[s.kind];
  if (!since) return 'unknown';
  const age = s.lastActiveHour ? now.getTime() - Date.parse(s.lastActiveHour) : Infinity;
  if (age < RECENT_HOURS * HOUR_MS) return 'recent';
  if (age < windowDays * DAY_MS) return 'earlier';
  return now.getTime() - Date.parse(since) >= windowDays * DAY_MS ? 'quiet' : 'unknown';
}

/** in-use, idle (bound, no operations), unbound, outside (unbound but still has operations). */
export type StorageStatus4 = 'in-use' | 'idle' | 'unbound' | 'outside';

export function storageStatus(s: StorageFact, activity: Activity): StorageStatus4 {
  const bound = (s.boundBy?.length ?? 0) > 0;
  if (!bound && !s.inUse) return activity === 'recent' ? 'outside' : 'unbound';
  return bound && activity === 'quiet' ? 'idle' : 'in-use';
}

/** Size, key or object count, and "empty", for a finding's evidence and message. */
function sizeFacts(s: StorageFact): { evidence: Record<string, string | number>; empty: boolean } {
  const evidence: Record<string, string | number> = {};
  if (s.bytes != null) evidence.size = fmtBytes(s.bytes);
  if (s.objects != null && (s.kind === 'kv' || s.kind === 'r2')) evidence[s.kind === 'kv' ? 'keys' : 'objects'] = s.objects;
  return { evidence, empty: (s.kind === 'kv' || s.kind === 'r2') && s.objects === 0 };
}

const day = (hour: string) => hour.slice(0, 10);

/**
 * Flags that do nothing once the compatibility date is on or after `since`, because the
 * behaviour became the default. Extend this list as Cloudflare graduates flags.
 * From 2026-08-04 Node.js compatibility is on by default (workers changelog 2026-08-04-nodejs-compat-default).
 */
export const REDUNDANT_FLAGS: { flag: string; since: string; note: string }[] = [
  { flag: 'nodejs_compat_v2', since: '2024-09-23', note: 'nodejs_compat includes v2 behaviour from 2024-09-23' },
  { flag: 'nodejs_compat', since: '2026-08-04', note: 'Node.js compatibility is the default from 2026-08-04' },
];

export function deprecationFindings(now: Date, meta: WorkerMeta[], tf: (n: string) => Thresholds): Finding[] {
  const out: Finding[] = [];
  for (const w of meta) {
    if (w.hasModules === false) {
      out.push(finding(
        'deprecation', w.name, 'service-worker-syntax', 'warning',
        'This Worker still uses the Service Worker syntax.',
        { format: 'service-worker' },
        'Migrate to ES modules: new features such as Durable Objects, Workflows and most bindings need it.',
        DOCS.modules,
      ));
    }
    if (w.compatibilityDate) {
      const months = monthsBetween(new Date(`${w.compatibilityDate}T00:00:00Z`), now);
      const limit = tf(w.name).compatAgeMonths;
      if (months >= limit) {
        out.push(finding(
          'deprecation', w.name, 'old-compat-date', 'warning',
          `The compatibility date ${w.compatibilityDate} is ${months} months old.`,
          { compatibilityDate: w.compatibilityDate, ageMonths: months, limitMonths: limit },
          'Read the compatibility flags changelog since that date, update compatibility_date and test.',
          DOCS.compat,
        ));
      }
    }
    if (w.usageModel && ['bundled', 'unbound'].includes(w.usageModel)) {
      out.push(finding(
        'deprecation', w.name, 'legacy-usage-model', 'warning',
        `This Worker reports the legacy "${w.usageModel}" usage model.`,
        { usageModel: w.usageModel },
        'Bundled and Unbound were replaced by Standard pricing. Remove usage_model from your Wrangler config and redeploy.',
        DOCS.pricing,
      ));
    }
    if (w.bindings?.some((b) => b.name === '__STATIC_CONTENT')) {
      out.push(finding(
        'deprecation', w.name, 'workers-sites', 'warning',
        'This Worker serves files with Workers Sites, which is deprecated.',
        { binding: '__STATIC_CONTENT' },
        'Move to Workers Static Assets: replace the [site] block with an assets directory.',
        DOCS.sites,
      ));
    }
    if (w.compatibilityDate) {
      const redundant = REDUNDANT_FLAGS.filter((r) => w.compatibilityFlags.includes(r.flag) && w.compatibilityDate! >= r.since);
      if (redundant.length) {
        out.push(finding(
          'deprecation', w.name, 'redundant-flags', 'info',
          `${redundant.length === 1 ? 'A compatibility flag is' : 'Compatibility flags are'} redundant at this compatibility date: ${redundant.map((r) => r.flag).join(', ')}.`,
          { flags: redundant.map((r) => r.flag).join(', '), compatibilityDate: w.compatibilityDate },
          'Remove the flag from compatibility_flags; the behaviour is already the default.',
          DOCS.flags,
        ));
      }
    }
  }
  return out;
}

/** Host part of a route pattern or URL, keeping a leading wildcard: "*.example.com/*" → "*.example.com". */
export function hostOf(pattern: string): string {
  return pattern.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
}

/**
 * True if Access application domains cover every host an entry point (route pattern, hostname)
 * serves. An app scoped to a path protects only that path, so it does not count; "*.host" covers
 * subdomains but not the apex; a route "*host/*" serves the apex and every subdomain.
 */
export function accessCovers(appDomains: string[], entry: string): boolean {
  const host = hostOf(entry);
  const needed = host.startsWith('*.') ? [host] : host.startsWith('*') ? [host.slice(1), `*.${host.slice(1)}`] : [host];
  const apps = appDomains
    .map((d) => d.replace(/^https?:\/\//, '').toLowerCase().split('/'))
    .filter(([, ...path]) => ['', '*'].includes(path.join('/')))
    .map(([h]) => h);
  const covers = (app: string, h: string) =>
    app === h || (app.startsWith('*.') && (h.startsWith('*.') ? h.slice(1) : h).endsWith(app.slice(1)));
  return needed.every((h) => apps.some((app) => covers(app, h)));
}

/** Public entry points per Worker: routes, custom domains and workers.dev. */
export function entryPoints(meta: WorkerMeta[], inv: InventoryFacts): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (script: string | null, host: string) => {
    if (!script) return;
    const list = out.get(script) ?? [];
    if (!list.includes(host)) list.push(host);
    out.set(script, list);
  };
  for (const r of inv.routes) add(r.script, r.pattern);
  for (const d of inv.domains) add(d.script, d.hostname);
  for (const m of meta) if (m.workersDev && inv.workersSubdomain) add(m.name, `${m.name}.${inv.workersSubdomain}.workers.dev`);
  return out;
}

export function exposureFindings(meta: WorkerMeta[], inv: InventoryFacts, accessCheck: boolean): Finding[] {
  const out: Finding[] = [];
  const entries = entryPoints(meta, inv);
  for (const w of meta) {
    if (!w.listed) continue;
    const zoneEntries = [...inv.routes.filter((r) => r.script === w.name).map((r) => r.pattern), ...inv.domains.filter((d) => d.script === w.name).map((d) => d.hostname)];
    if (w.previewsEnabled && w.workersDev === false) {
      out.push(finding(
        'exposure', w.name, 'previews-without-workers-dev', 'critical',
        'Preview URLs are public although workers.dev is switched off.',
        { previews: 'on', workersDev: 'off' },
        'Turn off preview URLs (preview_urls = false) or protect them with Cloudflare Access. Disabling workers.dev does not disable previews.',
        DOCS.previews,
      ));
    } else if (w.previewsEnabled) {
      out.push(finding(
        'exposure', w.name, 'preview-urls', 'warning',
        'Every version of this Worker gets a public preview URL.',
        { previews: 'on' },
        'Set preview_urls = false unless you share previews on purpose.',
        DOCS.previews,
      ));
    }
    if (w.workersDev && w.handlers.includes('fetch')) {
      const host = inv.workersSubdomain ? `${w.name}.${inv.workersSubdomain}.workers.dev` : 'workers.dev';
      if (zoneEntries.length) {
        out.push(finding(
          'exposure', w.name, 'workers-dev-duplicate', 'warning',
          `This Worker also answers on ${host}, next to ${zoneEntries[0]}.`,
          { workersDev: host, alsoOn: zoneEntries.slice(0, 3).join(', ') },
          'Requests on workers.dev skip your zone settings such as WAF and Access. Set workers_dev = false if you do not use it.',
          DOCS.workersDev,
        ));
      } else {
        out.push(finding(
          'exposure', w.name, 'workers-dev-public', 'info',
          `This Worker is public on ${host}.`,
          { workersDev: host },
          'Fine if intended. Set workers_dev = false for internal Workers.',
          DOCS.workersDev,
        ));
      }
    }
    if (accessCheck && inv.accessDomains) {
      const open = (entries.get(w.name) ?? []).filter((e) => !accessCovers(inv.accessDomains!, e));
      if (open.length) {
        out.push(finding(
          'exposure', w.name, 'not-behind-access', 'warning',
          `${open.length === 1 ? 'One public URL is' : `${open.length} public URLs are`} not covered by a Cloudflare Access application.`,
          { uncovered: open.slice(0, 3).join(', ') },
          'Ignore for public sites. For internal tools, add a self-hosted Access application for these hostnames.',
          DOCS.access,
        ));
      }
    }
  }
  return out;
}

const QUIET_HANDLERS = new Set(['fetch']);

/**
 * The storage only this Worker binds, for "deleting it leaves behind ...". Two evidence keys:
 * leavesBehind for people, and _cleanup ("kind:id-or-name" separated by spaces) for the delete
 * commands. Storage that still had operations in the last 48 hours stays out of the commands.
 */
function leavesBehind(only: StorageFact[] | undefined, activity: (s: StorageFact) => Activity): Record<string, string> {
  if (!only?.length) return {};
  const ev: Record<string, string> = { leavesBehind: only.map((s) => `${STORAGE_LABEL[s.kind]} ${s.name ?? s.id}`).join(', ') };
  const busy = only.filter((s) => activity(s) === 'recent');
  if (busy.length) ev.stillUsed = busy.map((s) => s.name ?? s.id).join(', ');
  const keep = only.filter((s) => !busy.includes(s));
  // Names come from the Cloudflare API: one that is not a plain name becomes "?", which gets no command.
  const ref = (s: StorageFact) => (s.kind === 'kv' ? s.id : (s.name ?? s.id));
  if (keep.length) ev._cleanup = keep.map((s) => `${s.kind}:${SAFE_NAME.test(ref(s)) ? ref(s) : '?'}`).join(' ');
  return ev;
}

export function zombieFindings(now: Date, meta: WorkerMeta[], stats: WorkerStats[], inv: InventoryFacts, tf: (n: string) => Thresholds): Finding[] {
  const out: Finding[] = [];
  const byName = new Map(stats.map((s) => [s.name, s]));
  const names = new Set(meta.map((m) => m.name));
  // Storage facts are only trusted once every Worker's bindings and the inventory are in.
  const storageKnown = inv.refreshed && inv.bindingsComplete;
  // Callers that do not work out boundBy (from every Worker) fall back to the in-scope Workers.
  const fallback = inv.storage.some((s) => !s.boundBy) ? boundByMap(meta, inv.storage) : null;
  const storage = storageKnown ? inv.storage.map((s) => (s.boundBy ? s : { ...s, boundBy: fallback!.get(`${s.kind}|${s.id}`) ?? [] })) : [];
  const resWindow = Math.min(tf('*').zombieDays, inv.retentionDays);
  const activity = (s: StorageFact) => activityOf(s, inv, now, resWindow);
  const unused = new Set<string>();
  // Storage bound by exactly one Worker, per Worker, worked out once.
  const onlyOf = new Map<string, StorageFact[]>();
  for (const s of storage) {
    if (s.inUse || s.boundBy?.length !== 1) continue;
    onlyOf.set(s.boundBy[0], [...(onlyOf.get(s.boundBy[0]) ?? []), s]);
  }

  for (const w of meta) {
    const window = Math.min(tf(w.name).zombieDays, inv.retentionDays);
    const s = byName.get(w.name);
    const onlyFetch = w.handlers.length > 0 && w.handlers.every((h) => QUIET_HANDLERS.has(h));
    if (onlyFetch && inv.trackingDays >= window && (s?.requestsWindow ?? 0) === 0) {
      unused.add(w.name);
      out.push(finding(
        'zombies', w.name, 'no-traffic', 'info',
        `No requests in the last ${window} days.`,
        { days: window, ...leavesBehind(onlyOf.get(w.name), activity) },
        'If nobody uses it, delete the Worker and any storage only it uses.',
        DOCS.bindings,
      ));
    }
    if (w.listed && !w.deployedOn) {
      unused.add(w.name);
      out.push(finding(
        'zombies', w.name, 'never-deployed', 'info',
        'This Worker was created but never deployed.',
        { deployed: 'never', ...leavesBehind(onlyOf.get(w.name), activity) },
        'Deploy it or delete it.',
        DOCS.bindings,
      ));
    }
    for (const b of w.bindings ?? []) {
      if (b.type === 'service' && b.target && !names.has(b.target)) {
        out.push(finding(
          'zombies', w.name, `missing-service-${b.target}`, 'info',
          `Service binding ${b.name} points at ${b.target}, which no longer exists.`,
          { binding: b.name, target: b.target },
          'Remove the binding or deploy the missing Worker; calls through it fail.',
          DOCS.bindings,
        ));
      }
      if (b.type === 'tail_consumer' && b.target && !names.has(b.target)) {
        out.push(finding(
          'zombies', w.name, `missing-tail-${b.target}`, 'info',
          `Tail consumer ${b.target} no longer exists.`,
          { tailConsumer: b.target },
          'Remove it from tail_consumers.',
          DOCS.bindings,
        ));
      }
    }
  }

  if (inv.refreshed) {
    for (const r of inv.routes) {
      if (r.script && !names.has(r.script)) {
        out.push(finding(
          'zombies', '*', `orphan-route-${r.id}`, 'info',
          `Route ${r.pattern} points at ${r.script}, which no longer exists.`,
          { route: r.pattern, worker: r.script },
          'Delete the route in the zone\'s Workers Routes.',
          DOCS.bindings,
        ));
      }
    }
    for (const d of inv.domains) {
      if (d.script && !names.has(d.script)) {
        out.push(finding(
          'zombies', '*', `orphan-domain-${d.id}`, 'info',
          `Custom domain ${d.hostname} points at ${d.script}, which no longer exists.`,
          { domain: d.hostname, worker: d.script },
          'Remove the custom domain.',
          DOCS.bindings,
        ));
      }
    }
  }

  for (const s of storage) {
    if (s.inUse) continue;
    const name = s.name ?? s.id;
    const act = activity(s);
    const { evidence: size, empty } = sizeFacts(s);
    const isEmpty = empty ? ' It is empty.' : '';
    const owners = s.boundBy ?? [];
    if (!owners.length) {
      const base = `${STORAGE_LABEL[s.kind]} ${name} is not bound to any Worker.`;
      if (act === 'recent') {
        out.push(finding(
          'zombies', '*', `unbound-${s.kind}-${s.id}`, 'info',
          `${STORAGE_LABEL[s.kind]} ${name} is not bound to any Worker, but it had operations on ${day(s.lastActiveHour!)}.`,
          { [s.kind]: name, lastUsed: day(s.lastActiveHour!), stillUsed: 'yes', ...size },
          'Something outside Workers may use it (the API, an S3 client, a public URL), or a Worker that used it was removed in the last two days. Do not delete it yet: if no new operations show up for a few days, it is safe to remove.',
          DOCS.bindings,
        ));
        continue;
      }
      const seen = act === 'quiet' ? ` No operations in the last ${resWindow} days.` : act === 'earlier' ? ` Last operations on ${day(s.lastActiveHour!)}, none since.` : '';
      out.push(finding(
        'zombies', '*', `unbound-${s.kind}-${s.id}`, 'info',
        `${base}${seen}${isEmpty}`,
        { [s.kind]: name, ...(act === 'quiet' ? { lastUsed: `none in ${resWindow} days` } : act === 'earlier' ? { lastUsed: day(s.lastActiveHour!) } : {}), ...size },
        act === 'unknown'
          ? 'It may still be used from outside Workers (API, S3 client). If not, export what you need and delete it.'
          : 'Nothing outside Workers used it recently either. Export what you need and delete it.',
        DOCS.bindings,
      ));
      continue;
    }
    // Bound but idle. A resource bound only to one unused Worker is listed on that Worker's finding instead.
    if (act !== 'quiet' || (owners.length === 1 && unused.has(owners[0]))) continue;
    const shown = owners.length > 5 ? `${owners.slice(0, 5).join(', ')} and ${owners.length - 5} more` : owners.join(', ');
    const allUnused = owners.every((o) => unused.has(o));
    out.push(finding(
      'zombies', '*', `bound-idle-${s.kind}-${s.id}`, 'info',
      `${STORAGE_LABEL[s.kind]} ${name} had no operations in the last ${resWindow} days, though ${owners.length === 1 ? `${shown} binds it` : `${shown} bind it`}.${allUnused ? ` ${owners.length === 1 ? 'That Worker is' : 'Those Workers are'} unused too.` : ''}${isEmpty}`,
      { [s.kind]: name, boundTo: shown, lastUsed: `none in ${resWindow} days`, ...size },
      'If nothing needs it, remove the binding from each Worker\'s Wrangler config and redeploy, then delete it. Yearly jobs and backups can look idle.',
      DOCS.bindings,
    ));
  }
  return out;
}

export function hygieneFindings(
  now: Date, meta: WorkerMeta[], stats: WorkerStats[], inv: InventoryFacts, config: Config, tf: (n: string) => Thresholds,
): Finding[] {
  const out: Finding[] = [];
  if (config.modules.deprecation) out.push(...deprecationFindings(now, meta, tf));
  if (config.modules.exposure) out.push(...exposureFindings(meta, inv, config.modules.access));
  if (config.modules.zombies) out.push(...zombieFindings(now, meta, stats, inv, tf));
  return out;
}

export function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
}
