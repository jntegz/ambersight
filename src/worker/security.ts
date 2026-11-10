// Checks on changes around the fleet: Pages, the audit log, certificates, DNS left pointing at
// deleted Workers or Pages projects, stuck gradual rollouts, config drift and expensive D1 queries.
// Pure functions over facts loaded by scan.ts.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config, Thresholds } from '../shared/config';
import type { Finding } from '../shared/types';
import { finding, fmt, type WorkerMeta } from './checks';

export interface ChangeFacts {
  /** Each Worker's latest deployment and its traffic split. */
  latestDeploys: { script: string; createdOn: string; versions: { id: string; percentage: number }[] }[];
  /** Bindings that disappeared at a detail refresh in the last 7 days. */
  removedBindings: { script: string; name: string; at: string }[];
  /** Audit log entries from the last 7 days, newest first. */
  audit: { id: string; at: string; actor: string | null; action: string; description: string | null; product: string | null; resourceType: string | null; resourceId: string | null }[];
  /** Pages projects; null until a listing has loaded once (so nothing looks dangling by mistake). */
  pages: { name: string; subdomain: string | null; domains: string[]; latest: { id: string; createdOn: string; status: string; stage: string; environment: string; branch: string | null } | null }[] | null;
  certs: { id: string; zone: string; type: string; status: string; hosts: string[]; expiresOn: string | null; errors: string[] }[];
  /** CNAME records pointing at workers.dev or pages.dev. */
  dns: { id: string; name: string; zone: string; target: string }[];
  d1Queries: { hash: string; database: string; query: string; rowsRead: number; rowsReturned: number; runs: number }[];
  /** Every Worker in the account, in scope or not: a DNS record to an out-of-scope Worker is not dangling. */
  workerNames: Set<string>;
  workersSubdomain: string | null;
}

const DOCS = {
  pages: 'https://developers.cloudflare.com/pages/configuration/preview-deployments/',
  pagesDomains: 'https://developers.cloudflare.com/pages/configuration/custom-domains/',
  audit: 'https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/',
  members: 'https://developers.cloudflare.com/fundamentals/manage-members/',
  certs: 'https://developers.cloudflare.com/ssl/edge-certificates/',
  dns: 'https://developers.cloudflare.com/dns/manage-dns-records/',
  rollouts: 'https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/',
  bindings: 'https://developers.cloudflare.com/workers/configuration/environment-variables/',
  limits: 'https://developers.cloudflare.com/workers/platform/limits/',
  d1: 'https://developers.cloudflare.com/d1/observability/find-expensive-queries/',
};

const DAY = 86_400_000;

// ---- Pages -------------------------------------------------------------------------------

export function pagesFindings(c: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  for (const p of c.pages ?? []) {
    const latest = p.latest;
    if (latest && latest.status === 'failure') {
      out.push(finding(
        'pages', '*', `deploy-failed-${p.name}`, latest.environment === 'production' ? 'warning' : 'info',
        `The latest ${latest.environment || ''} deploy of Pages project ${p.name} failed at the ${latest.stage || 'build'} step.`.replace('  ', ' '),
        { project: p.name, stage: latest.stage, deployedAt: latest.createdOn.slice(0, 16).replace('T', ' '), ...(latest.branch ? { branch: latest.branch } : {}) },
        'Open the deployment in Workers & Pages to read the build log. The site keeps serving the last deploy that worked.',
        DOCS.pages,
      ));
    }
    const custom = p.domains.filter((d) => !d.endsWith('.pages.dev'));
    if (p.subdomain && custom.length) {
      out.push(finding(
        'exposure', '*', `pages-dev-public-${p.name}`, 'info',
        `Pages project ${p.name} also answers on ${p.subdomain}, next to ${custom[0]}.`,
        { pagesDev: p.subdomain, alsoOn: custom.slice(0, 3).join(', ') },
        `Requests to ${p.subdomain} skip the WAF, bot and rate-limiting rules of your zone. If you do not use it, redirect it to your domain with a Bulk Redirect, or put it behind Cloudflare Access.`,
        DOCS.pagesDomains,
      ));
    }
  }
  return out;
}

// ---- Audit log ---------------------------------------------------------------------------

const text = (e: ChangeFacts['audit'][number]) => `${e.product ?? ''} ${e.resourceType ?? ''} ${e.description ?? ''}`.toLowerCase();

/** New or changed account members, and new API tokens, in the last 7 days. */
export function auditFindings(c: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  for (const e of c.audit) {
    const t = text(e);
    const who = e.actor ? ` by ${e.actor}` : '';
    const when = e.at.slice(0, 16).replace('T', ' ');
    if (/member/.test(t) && ['create', 'update', 'delete'].includes(e.action)) {
      const verb = e.action === 'create' ? 'added' : e.action === 'delete' ? 'removed' : 'changed';
      out.push(finding(
        'security', '*', `member-change-${e.id}`, e.action === 'delete' ? 'info' : 'warning',
        `An account member was ${verb}${who} on ${when} UTC.`,
        { action: e.action, ...(e.actor ? { actor: e.actor } : {}), ...(e.resourceId ? { member: e.resourceId } : {}), at: when },
        'If you did not expect this, check Manage Account › Members and the audit log. Acknowledge this finding once you have.',
        DOCS.members,
      ));
    }
    if (/token/.test(t) && e.action === 'create') {
      out.push(finding(
        'security', '*', `token-created-${e.id}`, 'info',
        `An API token was created${who} on ${when} UTC.`,
        { ...(e.actor ? { actor: e.actor } : {}), at: when },
        'If you did not expect a new token, review it under API Tokens, check its permissions, and roll it if needed.',
        DOCS.audit,
      ));
    }
  }
  return out;
}

// ---- Certificates and DNS ----------------------------------------------------------------

const FAILED = /timed_out|expired|deleted|inactive|deactivating/;

export function certFindings(now: Date, c: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  for (const cert of c.certs) {
    const host = cert.hosts[0] ?? cert.id;
    if (FAILED.test(cert.status)) {
      // An expired or timed-out pack of a host that has another active pack is housekeeping, not an outage.
      const covered = c.certs.some((o) => o.id !== cert.id && o.status === 'active' && cert.hosts.every((h) => o.hosts.includes(h)));
      if (covered) continue;
      out.push(finding(
        'security', '*', `cert-failed-${cert.id}`, cert.status === 'expired' ? 'critical' : 'warning',
        `The certificate for ${host} is ${cert.status.replace(/_/g, ' ')}.`,
        { hosts: cert.hosts.slice(0, 3).join(', '), status: cert.status, zone: cert.zone, ...(cert.errors[0] ? { error: cert.errors[0] } : {}) },
        'Visitors get TLS errors on these hostnames. Check SSL/TLS › Edge Certificates for the zone: DNS validation records, CAA records and whether the hostname is still proxied.',
        DOCS.certs,
      ));
      continue;
    }
    if (cert.status.startsWith('pending') && cert.errors.length) {
      out.push(finding(
        'security', '*', `cert-pending-${cert.id}`, 'warning',
        `The certificate for ${host} is stuck in ${cert.status.replace(/_/g, ' ')}: ${cert.errors[0]}`,
        { hosts: cert.hosts.slice(0, 3).join(', '), status: cert.status, zone: cert.zone },
        'Fix the validation error shown (usually a missing TXT record or a CAA record that does not allow the certificate authority).',
        DOCS.certs,
      ));
      continue;
    }
    if (cert.status === 'active' && cert.expiresOn) {
      const days = (new Date(cert.expiresOn).getTime() - now.getTime()) / DAY;
      if (days <= 7) {
        out.push(finding(
          'security', '*', `cert-expiring-${cert.id}`, days <= 2 ? 'critical' : 'warning',
          `The certificate for ${host} expires on ${cert.expiresOn.slice(0, 10)}.`,
          { hosts: cert.hosts.slice(0, 3).join(', '), expiresOn: cert.expiresOn.slice(0, 10), type: cert.type, zone: cert.zone },
          cert.type === 'custom' || cert.type === 'legacy_custom'
            ? 'This is a certificate you uploaded: upload the renewed one before it expires.'
            : 'Cloudflare renews managed certificates about 30 days before they expire, so this one is not renewing. Check its validation status in SSL/TLS › Edge Certificates.',
          DOCS.certs,
        ));
      }
    }
  }
  return out;
}

/**
 * DNS records left pointing at something that no longer exists. A *.pages.dev name is global:
 * once a project is deleted, anyone can create one with the same name and serve your hostname.
 */
export function dnsFindings(c: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  const projects = c.pages ? new Set(c.pages.map((p) => p.name)) : null;
  for (const r of c.dns) {
    if (r.target.endsWith('.pages.dev') && projects) {
      const labels = r.target.slice(0, -'.pages.dev'.length).split('.');
      const project = labels[labels.length - 1];
      if (!projects.has(project)) {
        out.push(finding(
          'security', '*', `dangling-pages-${r.id}`, 'critical',
          `${r.name} points at ${r.target}, but there is no Pages project ${project} in this account.`,
          { record: r.name, target: r.target, zone: r.zone },
          'Anyone can create a Pages project with that name and serve content on your hostname. Delete the DNS record, or point it at a project you own.',
          DOCS.dns,
        ));
      }
    }
    if (r.target.endsWith('.workers.dev') && c.workersSubdomain) {
      const suffix = `.${c.workersSubdomain}.workers.dev`;
      if (!r.target.endsWith(suffix)) continue; // another account's subdomain: not ours to judge
      const worker = r.target.slice(0, -suffix.length);
      if (worker && !c.workerNames.has(worker)) {
        out.push(finding(
          'security', '*', `dangling-workers-dev-${r.id}`, 'warning',
          `${r.name} points at ${r.target}, but there is no Worker ${worker} any more.`,
          { record: r.name, target: r.target, zone: r.zone },
          'Requests to this hostname fail. Delete the DNS record, or deploy the Worker again.',
          DOCS.dns,
        ));
      }
    }
  }
  return out;
}

// ---- Deploys and drift -------------------------------------------------------------------

/** A gradual rollout left half-done: traffic still split between versions after rolloutMaxHours. */
export function rolloutFindings(now: Date, c: ChangeFacts, tf: (n: string) => Thresholds): Finding[] {
  const out: Finding[] = [];
  for (const d of c.latestDeploys) {
    const split = d.versions.filter((v) => v.percentage > 0 && v.percentage < 100);
    if (split.length < 2) continue;
    const hours = (now.getTime() - new Date(d.createdOn).getTime()) / 3_600_000;
    const limit = tf(d.script).rolloutMaxHours;
    if (hours < limit) continue;
    const share = split.map((v) => `${v.percentage}%`).join(' / ');
    out.push(finding(
      'deploys', d.script, 'stuck-rollout', 'warning',
      `A gradual rollout has split traffic ${share} for ${hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`}.`,
      { split: share, since: d.createdOn.slice(0, 16).replace('T', ' ') },
      'Finish the rollout (wrangler versions deploy at 100%) or roll back. While it is split, users see different versions and errors are hard to compare.',
      DOCS.rollouts,
    ));
  }
  return out;
}

const VAR_TYPES = new Set(['plain_text', 'secret_text', 'json']);
const ENV_SUFFIX = /^(.+?)[-_](staging|stage|dev|development|preview|test|qa)$/;
const ENV_PREFIX = /^(staging|stage|dev|development|preview|test|qa)[-_](.+)$/;

export function driftFindings(meta: WorkerMeta[], c: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  const byName = new Map(meta.map((m) => [m.name, m]));

  // 1. A binding that disappeared at a deploy and is still missing.
  const seen = new Set<string>();
  for (const e of c.removedBindings) {
    const m = byName.get(e.script);
    if (!m?.bindings || m.bindings.some((b) => b.name === e.name) || seen.has(`${e.script}|${e.name}`)) continue;
    seen.add(`${e.script}|${e.name}`);
    out.push(finding(
      'drift', e.script, `binding-removed-${e.name}`, 'warning',
      `Binding ${e.name} disappeared from this Worker on ${e.at.slice(0, 10)}.`,
      { binding: e.name, noticed: e.at.slice(0, 16).replace('T', ' ') },
      'If you did not remove it on purpose, a deploy probably dropped it: variables and secrets set only in the dashboard are replaced by the next wrangler deploy unless they are in your config (or kept with --keep-vars). Add it back.',
      DOCS.bindings,
    ));
  }

  // 2. Staging and production that differ in binding names.
  for (const m of meta) {
    const match = m.name.match(ENV_SUFFIX) ?? m.name.match(ENV_PREFIX);
    if (!match) continue;
    const base = m.name.match(ENV_SUFFIX) ? match[1] : match[2];
    const prod = byName.get(base);
    if (!prod?.bindings || !m.bindings) continue;
    const a = new Set(prod.bindings.filter((b) => b.type !== 'tail_consumer').map((b) => b.name));
    const b = new Set(m.bindings.filter((x) => x.type !== 'tail_consumer').map((x) => x.name));
    const onlyOther = [...b].filter((n) => !a.has(n));
    const onlyProd = [...a].filter((n) => !b.has(n));
    if (!onlyOther.length && !onlyProd.length) continue;
    const parts = [
      onlyOther.length ? `${m.name} has ${onlyOther.slice(0, 4).join(', ')}${onlyOther.length > 4 ? ` and ${onlyOther.length - 4} more` : ''} that ${base} does not` : '',
      onlyProd.length ? `${base} has ${onlyProd.slice(0, 4).join(', ')}${onlyProd.length > 4 ? ` and ${onlyProd.length - 4} more` : ''} that ${m.name} does not` : '',
    ].filter(Boolean);
    out.push(finding(
      'drift', base, `env-mismatch-${m.name}`, 'info',
      `${parts.join('; ')}.`,
      { production: base, other: m.name, ...(onlyOther.length ? { missingInProduction: onlyOther.slice(0, 6).join(', ') } : {}), ...(onlyProd.length ? { missingInOther: onlyProd.slice(0, 6).join(', ') } : {}) },
      'Bindings that differ between environments are a common cause of "works in staging". Compare the two configs; secrets are compared by name only.',
      DOCS.bindings,
    ));
  }

  // 3. Close to the 64 environment variables and secrets per Worker.
  for (const m of meta) {
    const n = (m.bindings ?? []).filter((b) => VAR_TYPES.has(b.type)).length;
    if (n < 58) continue;
    out.push(finding(
      'drift', m.name, 'vars-near-limit', n >= 64 ? 'warning' : 'info',
      `This Worker has ${n} of the 64 environment variables and secrets allowed.`,
      { variables: n, limit: 64 },
      'Deploys that add more will fail. Group related settings into one JSON variable, or move configuration to KV.',
      DOCS.limits,
    ));
  }
  return out;
}

// ---- D1 ----------------------------------------------------------------------------------

/** Queries that read far more rows than they return: usually a missing index. Rows read are what D1 bills. */
export function d1QueryFindings(c: ChangeFacts): Finding[] {
  const out: Finding[] = [];
  for (const q of c.d1Queries) {
    if (q.rowsRead < 1_000_000) continue;
    const ratio = q.rowsRead / Math.max(1, q.rowsReturned);
    if (ratio < 100) continue;
    const short = q.query.replace(/\s+/g, ' ').trim();
    out.push(finding(
      'usage', '*', `d1-inefficient-query-${q.hash}`, q.rowsRead >= 100_000_000 ? 'warning' : 'info',
      `A query on ${q.database} read ${fmt(q.rowsRead)} rows in 24 hours to return ${fmt(q.rowsReturned)} (${fmt(ratio)} read per row returned).`,
      { database: q.database, query: short.length > 160 ? `${short.slice(0, 157)}...` : short, rowsRead: Math.round(q.rowsRead), runs: q.runs },
      'Add an index on the columns in its WHERE or ORDER BY clause. D1 bills rows read, and on the Free plan they count toward 5 million a day.',
      DOCS.d1,
    ));
  }
  return out;
}

/** Everything in this file, respecting the module switches. */
export function changeFindings(now: Date, meta: WorkerMeta[], c: ChangeFacts, config: Config, tf: (n: string) => Thresholds): Finding[] {
  const m = config.modules;
  const out: Finding[] = [];
  if (m.pages) out.push(...pagesFindings(c).filter((f) => m.exposure || f.module !== 'exposure'));
  if (m.security) out.push(...auditFindings(c), ...certFindings(now, c), ...dnsFindings(c));
  if (m.timeline) out.push(...rolloutFindings(now, c, tf));
  if (m.drift) out.push(...driftFindings(meta, c));
  if (m.usage) out.push(...d1QueryFindings(c));
  return out;
}
