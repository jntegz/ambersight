// What an API token gets instead of the dashboard's view. Every token sees scan trouble only as a
// general status. A token without the person-linked grant also gets no deploy authors, audit actors,
// member ids, repository owners or branch names, no Cloudflare account names, and none of the free
// text that can carry them: deploy messages, audit descriptions, Cloudflare notification bodies. Those
// fields are left out, not blanked. Names chosen in Cloudflare for Workers and resources stay: they
// are what the API is about.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config } from '../shared/config';
import { DASHBOARD_ONLY_EVIDENCE } from '../shared/findings';
import type { AccountSummary, Finding, Overview, PackagesView, SelfCost, TimelineEntry, WorkerDetail } from '../shared/types';
import type { Row } from './notify';
import { coarseAccounts, coarseOverview, coarseSelfCost } from './overview';
import type { TokenGrant } from './tokens';

/** Evidence naming a person, or a place named after one (a repository owner, a branch), or quoting the audit log. */
export const PERSON_EVIDENCE = new Set([...DASHBOARD_ONLY_EVIDENCE, 'branch', 'repo', 'change']);
/**
 * The evidence a token without the person-linked grant reads: what the checks emit, minus the above.
 * Any other key is left out, so a new one stays private until it is added here. test/tokenscope.test.ts
 * fails when a check emits a key that is in neither list.
 */
export const PLAIN_EVIDENCE = new Set([
  '_cleanup', 'action', 'ageMonths', 'alsoOn', 'at', 'averageSubrequests', 'binding', 'boundTo', 'budget', 'changedAt', 'compatibilityDate',
  'cpuMaxMs', 'cpuP99Ms', 'd1', 'database', 'days', 'deployId', 'deployed', 'deployedAt', 'domain', 'error', 'errors', 'estimatedGbPerDay',
  'estimatedGbPerMonth', 'exceeded', 'expected', 'expiresOn', 'extraPerHour', 'failures', 'flags', 'forecast', 'format', 'freeAllocation',
  'freeGbPerDay', 'historyHours', 'hosts', 'inARow', 'keys', 'kv', 'largest', 'lastHour', 'lastUsed', 'leavesBehind', 'limit', 'limitMonths',
  'limitMs', 'logpush', 'major', 'missingInOther', 'missingInProduction', 'monthToDate', 'noticed', 'objects', 'observed', 'opsPerHour', 'other',
  'outdated', 'pagesDev', 'permissions', 'previews', 'production', 'project', 'projectedLimitAt', 'query', 'queues', 'r2', 'record', 'requests',
  'requests24h', 'requestsInThoseHours', 'resource', 'route', 'rowsRead', 'runs', 'samplingRate', 'since', 'size', 'split', 'stage', 'status',
  'stillUsed', 'stored', 'tailConsumer', 'target', 'threshold', 'total', 'type', 'uncovered', 'usageModel', 'used', 'usedToday', 'usualHour',
  'usualRate', 'variables', 'worker', 'workersDev', 'zone',
]);
/** The one kind of change note that comes from Ambersight's own facts and not from the audit log. */
const BINDING_CHANGE = /^binding .* was removed$/;
/** The sentence `addChangeContext` adds, unless it is about a removed binding. */
const AUDIT_CONTEXT = / Shortly before, (?!binding [^\n]* was removed\.$)[\s\S]*$/;
/** Needs a dotted domain, so that `package@1.2.3` is left alone. */
const ADDRESS = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[A-Za-z]{2,}/g;
/** A stored lockfile error can name a repository the Worker was mapped to earlier, so none of it is shown. */
const PACKAGES_UNREADABLE = "Ambersight could not read this Worker's packages.";
const PACKAGES_FINDING = /^Ambersight could not read this Worker's packages: [\s\S]*$/;

const noAddress = (s: string) => (s.includes('@') ? s.replace(ADDRESS, '[email]') : s);

/** A copy without one field. The result still has the view's type: API clients treat it as absent. */
function without<T extends object>(o: T, key: keyof T): T {
  const copy = { ...o };
  delete (copy as Record<PropertyKey, unknown>)[key];
  return copy;
}

/**
 * The label set in Settings, or a neutral one. The name from Cloudflare is never used: it is often a
 * person's, as "<email>'s Account" or in whatever form someone renamed it, and that cannot be detected.
 */
export function plainLabel(id: string, config: Pick<Config, 'accounts'>): string {
  const label = config.accounts[id]?.label;
  return label ? noAddress(label) : `Account ${id.slice(0, 8)}`;
}

function plainEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(evidence)) {
    if (k === 'change' ? !BINDING_CHANGE.test(String(v)) : !PLAIN_EVIDENCE.has(k)) continue;
    out[k] = typeof v === 'string' ? noAddress(v) : v;
  }
  return out;
}

/** A finding's sentence or advice, with the audit text, the repository and any address taken out. */
export function plainSentence(text: string, evidence: Record<string, unknown>): string {
  if (PACKAGES_FINDING.test(text)) return PACKAGES_UNREADABLE;
  const repo = evidence.repo;
  const named = typeof repo === 'string' && repo ? text.split(repo).join('the repository') : text;
  return noAddress(named.replace(AUDIT_CONTEXT, ' A change was recorded shortly before.'));
}

export const plainFinding = <T extends Finding>(f: T): T => ({
  ...f,
  message: plainSentence(f.message, f.evidence),
  action: plainSentence(f.action, f.evidence),
  evidence: plainEvidence(f.evidence) as Finding['evidence'],
});

/** The same for a finding as the client report reads it, with its evidence still as JSON text. */
export function plainRow(r: Row): Row {
  let evidence: Record<string, unknown> = {};
  try {
    evidence = r.evidence ? (JSON.parse(r.evidence) as Record<string, unknown>) : {};
  } catch { /* unreadable evidence is dropped below */ }
  return { ...r, message: plainSentence(r.message, evidence), action: plainSentence(r.action, evidence), evidence: JSON.stringify(plainEvidence(evidence)) };
}

const plainOverview = (o: Overview, config: Pick<Config, 'accounts'>): Overview => ({
  ...o,
  account: o.account && { ...o.account, label: plainLabel(o.account.id, config) },
  findings: o.findings.map(plainFinding),
  workers: o.workers.map((w) => ({ ...w, topFinding: w.topFinding && plainFinding(w.topFinding) })),
  pages: o.pages.map((p) => (p.latest ? { ...p, latest: without(p.latest, 'branch') } : p)),
});

/** The overview for one kind of token. A token limited to some accounts is not told how many others exist. */
export function tokenOverview(o: Overview, grant: TokenGrant, config: Pick<Config, 'accounts'>): Overview {
  const coarse = coarseOverview(o);
  const sized = grant.accounts ? without(coarse, 'accountCount') : coarse;
  return grant.people ? sized : plainOverview(sized, config);
}

export function tokenAccounts(list: AccountSummary[], grant: TokenGrant, config: Pick<Config, 'accounts'>): AccountSummary[] {
  const coarse = coarseAccounts(list);
  return grant.people ? coarse : coarse.map((a) => ({ ...a, label: plainLabel(a.id, config) }));
}

/** The daily figures add up every account's scans, so they would tell a limited token how many there are. */
export function tokenSelfCost(cost: SelfCost, grant: TokenGrant): SelfCost {
  const coarse = coarseSelfCost(cost);
  return grant.accounts ? { ...coarse, days: [] } : coarse;
}

function plainEntry(e: TimelineEntry): TimelineEntry {
  const rest = { ...without(e, 'author'), source: e.source && noAddress(e.source) };
  // A status page incident is public text. A Pages line is built here, and only its branch is a name.
  if (e.kind === 'incident') return rest;
  if (e.kind === 'pages') return { ...rest, message: e.message && e.message.replace(/ of "[^"]*"/, '') };
  return without(rest, 'message');
}

export const plainTimeline = (list: TimelineEntry[]) => list.map(plainEntry);

export const plainWorker = (w: WorkerDetail): WorkerDetail => ({
  ...w,
  deploys: w.deploys.map((d) => without(without(d, 'author'), 'message')),
  findings: w.findings.map(plainFinding),
  changes: w.changes.map((c) => (c.kind === 'audit' ? without(c, 'detail') : c)),
});

export const plainPackages = (v: PackagesView): PackagesView => ({
  ...v,
  workers: v.workers.map((w) => ({ ...without(w, 'repo'), error: w.error && PACKAGES_UNREADABLE })),
});
