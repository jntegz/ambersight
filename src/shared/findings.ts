// Groups findings by the check that raised them, for the grouped list and for muting a check.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Finding, Severity } from './types';

/** Codes that end in a resource id or name; the check is the prefix. */
const DYNAMIC = /^(unbound-(?:kv|d1|r2|queues)|ops-spike-(?:kv|d1|r2|queues|do)|idle-loop-(?:kv|d1|r2|queues|do)|new-resource-burst-(?:kv|d1|r2|queues|do)|storage-d1-db|orphan-route|orphan-domain|missing-service|missing-tail)-.+$/;

/** "module:code" with ids stripped, e.g. "zombies:unbound-queues". Stable across scans and Workers. */
export function checkOf(f: Pick<Finding, 'module' | 'code'>): string {
  return `${f.module}:${f.code.replace(DYNAMIC, '$1')}`;
}

export const CHECK_PATTERN = /^[a-z]+:[a-z0-9-]+$/;

/** Group headings. A check not listed here uses its first finding's message. */
export const CHECK_TITLES: Record<string, string> = {
  'budget:free-daily-requests': 'Free plan request budget',
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
