// Groups findings by the check that raised them, for the grouped list and for muting a check.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Finding, Severity } from './types';

/** Codes that end in a resource id or name; the check is the prefix. */
const DYNAMIC = /^(unbound-(?:kv|d1|r2|queues)|bound-idle-(?:kv|d1|r2|queues)|ops-spike-(?:kv|d1|r2|queues|do)|idle-loop-(?:kv|d1|r2|queues|do)|new-resource-burst-(?:kv|d1|r2|queues|do)|storage-d1-db|orphan-route|orphan-domain|missing-service|missing-tail|deploy-failed|pages-dev-public|member-change|token-created|cert-failed|cert-pending|cert-expiring|dangling-pages|dangling-workers-dev|binding-removed|env-mismatch|d1-inefficient-query)-.+$/;

/** "module:code" with ids stripped, e.g. "zombies:unbound-queues". Stable across scans and Workers. */
export function checkOf(f: Pick<Finding, 'module' | 'code'>): string {
  return `${f.module}:${f.code.replace(DYNAMIC, '$1')}`;
}

export const CHECK_PATTERN = /^[a-z]+:[a-z0-9-]+$/;

/** Group headings. A check not listed here uses its first finding's message. */
export const CHECK_TITLES: Record<string, string> = {
  'budget:free-daily-requests': 'Free plan request budget',
  'budget:monthly-budget': 'Monthly budget',
  'budget:free-daily-d1-rows-read': 'Free D1 rows read running out',
  'budget:free-daily-d1-rows-written': 'Free D1 rows written running out',
  'budget:free-daily-kv-reads': 'Free KV reads running out',
  'budget:free-daily-kv-writes': 'Free KV writes running out',
  'budget:free-daily-kv-deletes': 'Free KV deletes running out',
  'budget:free-daily-kv-lists': 'Free KV list requests running out',
  'budget:free-daily-do-requests': 'Free Durable Object requests running out',
  'budget:free-daily-queue-ops': 'Free Queue operations running out',
  'budget:free-daily-workflow-steps': 'Free Workflow steps running out',
  'budget:free-daily-ai-neurons': 'Workers AI daily allocation',
  'budget:storage-d1-db': 'D1 databases close to their size limit',
  'budget:storage-d1-account': 'D1 storage close to the account limit',
  'budget:storage-kv-account': 'KV storage close to the account limit',
  'budget:storage-r2-account': 'R2 storage past the free amount',
  'budget:storage-do-account': 'Durable Object storage close to the account limit',
  'health:token-expiry': 'Ambersight\'s API token expires soon',
  'runaway:new-worker-burst': 'Traffic burst on a new Worker',
  'usage:new-resource-burst-kv': 'Burst on a new KV namespace',
  'usage:new-resource-burst-d1': 'Burst on a new D1 database',
  'usage:new-resource-burst-r2': 'Burst on a new R2 bucket',
  'usage:new-resource-burst-queues': 'Burst on a new queue',
  'usage:new-resource-burst-do': 'Burst on new Durable Objects',
  'usage:idle-loop-do': 'Durable Objects busy with no traffic (likely an alarm loop)',
  'usage:idle-loop-queues': 'Queue busy with no traffic (likely a retry loop)',
  'usage:idle-loop-d1': 'D1 busy with no traffic',
  'usage:idle-loop-kv': 'KV busy with no traffic',
  'usage:idle-loop-r2': 'R2 busy with no traffic',
  'usage:logs-free-allowance': 'Logs close to the free daily allowance',
  'usage:d1-inefficient-query': 'D1 queries reading far more rows than they return',
  'errors:subrequests-near-limit': 'Close to 50 subrequests per invocation',
  'pages:deploy-failed': 'Pages deploys that failed',
  'exposure:pages-dev-public': 'Pages projects also public on pages.dev',
  'security:member-change': 'Account members added or changed',
  'security:token-created': 'API tokens created',
  'security:cert-failed': 'Certificates expired or failed',
  'security:cert-pending': 'Certificates stuck in validation',
  'security:cert-expiring': 'Certificates expiring without renewal',
  'security:dangling-pages': 'DNS records pointing at Pages projects that do not exist',
  'security:dangling-workers-dev': 'DNS records pointing at deleted Workers',
  'deploys:stuck-rollout': 'Gradual rollouts left split',
  'drift:binding-removed': 'Bindings that disappeared',
  'drift:env-mismatch': 'Staging and production bindings differ',
  'drift:vars-near-limit': 'Close to 64 variables and secrets',
  'runaway:traffic-spike': 'Traffic spike',
  'runaway:cpu-spike': 'CPU time spike',
  'runaway:subrequest-spike': 'Subrequest spike',
  'errors:error-rate': 'High error rate',
  'errors:error-baseline': 'Error rate above the usual level',
  'errors:resource-limit': 'Runs hitting the CPU or memory limit',
  'errors:cpu-near-limit': 'CPU time close to the limit',
  'cron:missed-runs': 'Scheduled runs missed',
  'cron:failed-runs': 'Scheduled runs failing',
  'cron:cron-cpu-near-limit': 'Scheduled runs close to the CPU limit',
  'cron:cron-count': 'Cron Triggers close to the plan limit',
  'usage:logpush-on': 'Logpush enabled',
  'usage:logs-full-sampling': 'Logs sampled at 100%',
  'usage:ops-spike-kv': 'KV operations spike',
  'usage:ops-spike-d1': 'D1 queries spike',
  'usage:ops-spike-r2': 'R2 operations spike',
  'usage:ops-spike-queues': 'Queue operations spike',
  'usage:ops-spike-do': 'Durable Object requests spike',
  'deprecation:service-worker-syntax': 'Service Worker syntax',
  'deprecation:old-compat-date': 'Old compatibility date',
  'deprecation:legacy-usage-model': 'Legacy usage model',
  'deprecation:workers-sites': 'Workers Sites',
  'deprecation:redundant-flags': 'Redundant compatibility flags',
  'exposure:previews-without-workers-dev': 'Public preview URLs while workers.dev is off',
  'exposure:preview-urls': 'Public preview URLs',
  'exposure:workers-dev-duplicate': 'Also answers on workers.dev',
  'exposure:workers-dev-public': 'Public on workers.dev',
  'exposure:not-behind-access': 'Public URLs not behind Cloudflare Access',
  'zombies:never-deployed': 'Created but never deployed',
  'zombies:no-traffic': 'No traffic',
  'zombies:missing-service': 'Service bindings to Workers that no longer exist',
  'zombies:missing-tail': 'Tail consumers that no longer exist',
  'zombies:orphan-route': 'Routes pointing at deleted Workers',
  'zombies:orphan-domain': 'Custom domains pointing at deleted Workers',
  'zombies:unbound-kv': 'KV namespaces not bound to any Worker',
  'zombies:unbound-d1': 'D1 databases not bound to any Worker',
  'zombies:unbound-r2': 'R2 buckets not bound to any Worker',
  'zombies:unbound-queues': 'Queues not used by any Worker',
  'zombies:bound-idle-kv': 'KV namespaces bound but not used',
  'zombies:bound-idle-d1': 'D1 databases bound but not used',
  'zombies:bound-idle-r2': 'R2 buckets bound but not used',
  'zombies:bound-idle-queues': 'Queues bound but not used',
};

/** One fix for the whole group, where Cloudflare offers one. */
export const CHECK_GROUP_FIX: Record<string, string> = {
  'exposure:preview-urls':
    'Fix them all at once: Workers & Pages › Protect all Workers › Enable Access › Previews only. Or set preview_urls = false in each Worker.',
  'exposure:previews-without-workers-dev':
    'Fix them all at once: Workers & Pages › Protect all Workers › Enable Access › Previews only. Or set preview_urls = false in each Worker.',
};

export interface FindingGroup {
  check: string;
  title: string;
  severity: Severity;
  findings: Finding[];
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Groups by check, worst severity first, then the largest group. Order inside a group is kept. */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const f of findings) {
    const check = checkOf(f);
    const g = groups.get(check) ?? { check, title: CHECK_TITLES[check] ?? f.message, severity: f.severity, findings: [] };
    if (RANK[f.severity] < RANK[g.severity]) g.severity = f.severity;
    g.findings.push(f);
    groups.set(check, g);
  }
  return [...groups.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.findings.length - a.findings.length || a.title.localeCompare(b.title));
}

/**
 * How to remove a leftover by hand: wrangler commands for unused storage and Workers, a dashboard
 * path where wrangler has none. Ambersight is read-only and never runs these. Names go into a
 * shell command, so anything that is not a plain name gets no command at all.
 */
export interface Cleanup {
  /** Shell commands, in order. Destructive. */
  commands: string[];
  /** What to check or do first, or where to click when there is no command. */
  note: string;
}

/** A plain name that is safe inside a shell command. */
export const SAFE_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
const SAFE = SAFE_NAME;
const KV_ID = /^[a-f0-9]{32}$/;

const STORAGE_NOTE: Record<string, string> = {
  kv: 'Export any keys you still need first (npx wrangler kv key list --namespace-id=…).',
  d1: 'The first command saves a backup of the database.',
  r2: 'A bucket must be empty before it can be deleted: empty it in the dashboard (R2 › bucket › Settings) or with an object lifecycle rule. Check it is not used from outside Workers (S3 clients, public bucket URL).',
  queues: 'Messages still in the queue are lost.',
};

/** The delete commands for one resource: a KV namespace by id, the rest by a shell-safe name. */
function storageCommands(kind: string, ref: string): string[] | null {
  if (kind === 'kv') return KV_ID.test(ref) ? [`npx wrangler kv namespace delete --namespace-id=${ref}`] : null;
  if (!SAFE.test(ref)) return null;
  if (kind === 'd1') return [`npx wrangler d1 export ${ref} --remote --output=${ref}-backup.sql`, `npx wrangler d1 delete ${ref}`];
  if (kind === 'r2') return [`npx wrangler r2 bucket delete ${ref}`];
  if (kind === 'queues') return [`npx wrangler queues delete ${ref}`];
  return null;
}

/** Evidence keys starting with "_" carry data for the cleanup commands, not for people. */
export const isHiddenEvidence = (key: string) => key.startsWith('_');

export function cleanupFor(f: Pick<Finding, 'module' | 'code' | 'script' | 'evidence'>): Cleanup | null {
  if (f.module !== 'zombies') return null;
  const check = checkOf(f);
  const storage = /^zombies:(unbound|bound-idle)-(kv|d1|r2|queues)$/.exec(check);
  if (storage) {
    const [, which, kind] = storage;
    if (f.evidence.stillUsed === 'yes') {
      return { commands: [], note: 'It still had operations in the last two days, so there is no delete command yet. Check what uses it first.' };
    }
    const ref = kind === 'kv' ? f.code.slice(`${which}-kv-`.length) : typeof f.evidence[kind] === 'string' ? (f.evidence[kind] as string) : '';
    const commands = storageCommands(kind, ref);
    if (!commands) return null;
    const unbind = which === 'bound-idle' ? 'First remove the binding from each Worker that has it, and redeploy, or those Workers fail when they next use it. ' : '';
    return { commands, note: `${unbind}${STORAGE_NOTE[kind]}` };
  }
  if (check === 'zombies:no-traffic' || check === 'zombies:never-deployed') {
    if (!SAFE.test(f.script)) return null;
    const leaves = typeof f.evidence.leavesBehind === 'string' ? f.evidence.leavesBehind : '';
    const refs = typeof f.evidence._cleanup === 'string' ? f.evidence._cleanup.split(' ').filter(Boolean) : [];
    const extra = refs.map((r) => storageCommands(r.slice(0, r.indexOf(':')), r.slice(r.indexOf(':') + 1)));
    const commands = [`npx wrangler delete --name ${f.script}`, ...extra.flatMap((c) => c ?? [])];
    if (!leaves) {
      return { commands, note: 'Deleting a Worker leaves its KV, D1, R2 and Queues in place: they show up here as unused on a later scan, after the next inventory refresh.' };
    }
    const parts = [`Deleting the Worker leaves behind storage only it uses: ${leaves}.`];
    if (commands.length > 1) parts.push('The commands after the first one delete that storage (a D1 database gets a backup first; an R2 bucket must be emptied first).');
    if (typeof f.evidence.stillUsed === 'string') parts.push(`${f.evidence.stillUsed} still had operations in the last two days, so it has no delete command.`);
    if (extra.some((c) => !c)) parts.push('Some names are not safe to put in a shell command; delete those in the dashboard.');
    return { commands, note: parts.join(' ') };
  }
  if (check === 'zombies:orphan-route') return { commands: [], note: 'Delete it in the dashboard: your zone › Workers Routes.' };
  if (check === 'zombies:orphan-domain') {
    const id = f.code.slice('orphan-domain-'.length);
    return { commands: [], note: `Remove it with the API (a token with Workers Scripts Edit, not Ambersight's): DELETE /accounts/{account_id}/workers/domains/${SAFE.test(id) ? id : '{domain_id}'}.` };
  }
  return null;
}
