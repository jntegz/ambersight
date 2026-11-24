// The findings inbox and a finding's history, read from D1 only.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope, type Config } from '../shared/config';
import type { FindingEvent, FindingListItem, Severity, SinceView } from '../shared/types';
import { toFinding, type FindingRow } from './overview';
import { plainSentence } from './tokenView';

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
/** Resolved findings shown in the inbox: the most recent ones. */
const RESOLVED_LIMIT = 200;

type Row = FindingRow & { last_seen: string; status_at: string | null; snooze_until: string | null; reopen_count: number | null };

/**
 * Whether a finding's Worker is in scope. Account-wide findings ('*') always are. A Worker that is
 * gone has no tags left, so only its name and name-based groups decide: an exclude rule still holds
 * for the history it left behind.
 */
async function scopeFilter(db: D1Database, account: string, config: Config): Promise<(script: string | null) => boolean> {
  const { results } = await db.prepare('SELECT name, tags FROM workers WHERE account = ?1').bind(account).all<{ name: string; tags: string | null }>();
  const tags = new Map(results.map((w) => [w.name, w.tags ? (JSON.parse(w.tags) as string[]) : []]));
  return (script) => !script || script === '*' || inScope(config, script, groupsFor(config, script, tags.get(script) ?? []));
}

/** Findings of one account with the given status, most serious and newest first. Out-of-scope Workers are left out. */
export async function buildFindingsList(db: D1Database, account: string, status: 'open' | 'acknowledged' | 'snoozed' | 'resolved', config: Config): Promise<FindingListItem[]> {
  const [{ results }, visible] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM findings WHERE account = ?1 AND status = ?2
         ORDER BY ${status === 'resolved' ? 'last_seen DESC' : 'first_seen DESC'} LIMIT ?3`,
      )
      .bind(account, status, status === 'resolved' ? RESOLVED_LIMIT : 2000)
      .all<Row>(),
    scopeFilter(db, account, config),
  ]);
  const list = results.filter((r) => visible(r.script)).map((r) => ({
    ...toFinding(r),
    lastSeen: r.last_seen,
    statusAt: r.status_at ?? null,
    snoozeUntil: r.snooze_until ?? null,
    reopenCount: r.reopen_count ?? 0,
  }));
  return status === 'resolved' ? list : list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * Every recorded change of one finding, oldest first. With `accounts`, only if the finding belongs
 * to one of them: a finding outside the list reads exactly like one that does not exist.
 */
export async function buildFindingHistory(db: D1Database, id: string, accounts?: string[]): Promise<FindingEvent[]> {
  const query = db.prepare(`SELECT at, kind, severity FROM finding_events WHERE finding_id = ?1${accounts ? ' AND account IN (SELECT value FROM json_each(?2))' : ''} ORDER BY at LIMIT 500`);
  const { results } = await (accounts ? query.bind(id, JSON.stringify(accounts)) : query.bind(id))
    .all<{ at: string; kind: FindingEvent['kind']; severity: Severity | null }>();
  return results.map((r) => ({ at: r.at, kind: r.kind, severity: r.severity }));
}

/**
 * What changed since a time: findings opened, reopened, got worse or were resolved, newest first.
 * `plain` takes person-linked text out of the sentences, for a token without that grant.
 */
export async function buildChangesSince(db: D1Database, account: string, since: string, config: Config, plain = false): Promise<SinceView> {
  const [[counts, recent], visible] = await Promise.all([
    db.batch([
      // Per Worker, so out-of-scope Workers can be left out of the counts too.
      db.prepare(
        `SELECT kind, script, COUNT(*) AS n FROM finding_events WHERE account = ?1 AND at > ?2 AND kind IN ('opened', 'reopened', 'escalated', 'resolved') GROUP BY kind, script`,
      ).bind(account, since),
      db.prepare(
        `SELECT e.at, e.kind, e.severity, e.script, f.message, f.evidence, f.id FROM finding_events e LEFT JOIN findings f ON f.id = e.finding_id
         WHERE e.account = ?1 AND e.at > ?2 AND e.kind IN ('opened', 'reopened', 'escalated', 'resolved')
         ORDER BY CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.at DESC LIMIT 200`,
      ).bind(account, since),
    ]),
    scopeFilter(db, account, config),
  ]);
  const n = new Map<string, number>();
  for (const r of counts.results as { kind: string; script: string | null; n: number }[]) {
    if (visible(r.script)) n.set(r.kind, (n.get(r.kind) ?? 0) + r.n);
  }
  return {
    since,
    opened: (n.get('opened') ?? 0) + (n.get('reopened') ?? 0),
    escalated: n.get('escalated') ?? 0,
    resolved: n.get('resolved') ?? 0,
    items: (recent.results as { at: string; kind: SinceView['items'][number]['kind']; severity: Severity | null; script: string | null; message: string | null; evidence: string | null; id: string | null }[])
      .filter((r) => visible(r.script))
      .slice(0, 8)
      .map((r) => ({
        at: r.at, kind: r.kind, severity: r.severity, script: r.script,
        message: plain && r.message ? plainSentence(r.message, r.evidence ? (JSON.parse(r.evidence) as Record<string, unknown>) : {}) : r.message,
      })),
  };
}
