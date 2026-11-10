// Hygiene checks: M2 deprecation radar, M3 exposure audit, M7 zombies and orphans.
// Pure functions over Worker metadata and the account inventory.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config, Thresholds } from '../shared/config';
import type { Finding } from '../shared/types';
import { finding, type WorkerMeta, type WorkerStats } from './checks';

export interface InventoryFacts {
  /** False until every in-scope Worker's settings (bindings) have been fetched once. */
  bindingsComplete: boolean;
  /** False until the first full inventory refresh has run. */
  refreshed: boolean;
  /** inUse: used without a binding (a queue with a consumer or producer, or a dead-letter queue). */
  storage: { kind: 'kv' | 'd1' | 'r2' | 'queues'; id: string; name: string | null; inUse?: boolean }[];
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

/**
 * Flags that do nothing once the compatibility date is on or after `since`, because the
 * behaviour became the default. Extend this list as Cloudflare graduates flags.
 * TODO(PRD M2): confirm which nodejs_compat flags become redundant on 2026-08-04 and add them here.
 */
export const REDUNDANT_FLAGS: { flag: string; since: string; note: string }[] = [
  { flag: 'nodejs_compat_v2', since: '2024-09-23', note: 'nodejs_compat includes v2 behaviour from 2024-09-23' },
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

export function zombieFindings(meta: WorkerMeta[], stats: WorkerStats[], inv: InventoryFacts, tf: (n: string) => Thresholds): Finding[] {
  const out: Finding[] = [];
  const byName = new Map(stats.map((s) => [s.name, s]));
  const names = new Set(meta.map((m) => m.name));

  for (const w of meta) {
    const window = Math.min(tf(w.name).zombieDays, inv.retentionDays);
    const s = byName.get(w.name);
    const onlyFetch = w.handlers.length > 0 && w.handlers.every((h) => QUIET_HANDLERS.has(h));
    if (onlyFetch && inv.trackingDays >= window && (s?.requestsWindow ?? 0) === 0) {
      out.push(finding(
        'zombies', w.name, 'no-traffic', 'info',
        `No requests in the last ${window} days.`,
        { days: window },
        'If nobody uses it, delete the Worker and any storage only it uses.',
        DOCS.bindings,
      ));
    }
    if (w.listed && !w.deployedOn) {
      out.push(finding(
        'zombies', w.name, 'never-deployed', 'info',
        'This Worker was created but never deployed.',
        { deployed: 'never' },
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

  if (inv.refreshed && inv.bindingsComplete) {
    const bindingType = { kv: 'kv_namespace', d1: 'd1', r2: 'r2_bucket', queues: 'queue' } as const;
    const label = { kv: 'KV namespace', d1: 'D1 database', r2: 'R2 bucket', queues: 'Queue' } as const;
    const used = new Set(meta.flatMap((m) => (m.bindings ?? []).map((b) => `${b.type}|${b.target}`)));
    for (const s of inv.storage) {
      const key = s.kind === 'queues' ? `${bindingType.queues}|${s.name}` : `${bindingType[s.kind]}|${s.id}`;
      if (s.inUse || used.has(key)) continue;
      out.push(finding(
        'zombies', '*', `unbound-${s.kind}-${s.id}`, 'info',
        `${label[s.kind]} ${s.name ?? s.id} is not bound to any Worker.`,
        { [s.kind]: s.name ?? s.id },
        'It may still be used from outside Workers (API, S3 client). If not, export what you need and delete it.',
        DOCS.bindings,
      ));
    }
  }
  return out;
}

export function hygieneFindings(
  now: Date, meta: WorkerMeta[], stats: WorkerStats[], inv: InventoryFacts, config: Config, tf: (n: string) => Thresholds,
): Finding[] {
  const out: Finding[] = [];
  if (config.modules.deprecation) out.push(...deprecationFindings(now, meta, tf));
  if (config.modules.exposure) out.push(...exposureFindings(meta, inv, config.modules.access));
  if (config.modules.zombies) out.push(...zombieFindings(meta, stats, inv, tf));
  return out;
}

export function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
}
