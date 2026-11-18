// The findings inbox and a finding's history, read from D1 only.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FindingEvent, FindingListItem, Severity, SinceView } from '../shared/types';
import { toFinding, type FindingRow } from './overview';
import { plainSentence } from './tokenView';

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
/** Resolved findings shown in the inbox: the most recent ones. */
const RESOLVED_LIMIT = 200;

type Row = FindingRow & { last_seen: string; status_at: string | null; snooze_until: string | null; reopen_count: number | null };

/** Findings of one account with the given status, most serious and newest first. */
export async function buildFindingsList(db: D1Database, account: string, status: 'open' | 'acknowledged' | 'snoozed' | 'resolved'): Promise<FindingListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM findings WHERE account = ?1 AND status = ?2
       ORDER BY ${status === 'resolved' ? 'last_seen DESC' : 'first_seen DESC'} LIMIT ?3`,
    )
    .bind(account, status, status === 'resolved' ? RESOLVED_LIMIT : 2000)
    .all<Row>();
  const list = results.map((r) => ({
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
export async function buildChangesSince(db: D1Database, account: string, since: string, plain = false): Promise<SinceView> {
  const [counts, recent] = await db.batch([
    db.prepare(
      `SELECT kind, COUNT(*) AS n FROM finding_events WHERE account = ?1 AND at > ?2 AND kind IN ('opened', 'reopened', 'escalated', 'resolved') GROUP BY kind`,
    ).bind(account, since),
    db.prepare(
      `SELECT e.at, e.kind, e.severity, e.script, f.message, f.evidence, f.id FROM finding_events e LEFT JOIN findings f ON f.id = e.finding_id
       WHERE e.account = ?1 AND e.at > ?2 AND e.kind IN ('opened', 'reopened', 'escalated', 'resolved')
       ORDER BY CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.at DESC LIMIT 8`,
    ).bind(account, since),
  ]);
  const n = new Map((counts.results as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  return {
    since,
    opened: (n.get('opened') ?? 0) + (n.get('reopened') ?? 0),
    escalated: n.get('escalated') ?? 0,
    resolved: n.get('resolved') ?? 0,
    items: (recent.results as { at: string; kind: SinceView['items'][number]['kind']; severity: Severity | null; script: string | null; message: string | null; evidence: string | null; id: string | null }[])
      .map((r) => ({
        at: r.at, kind: r.kind, severity: r.severity, script: r.script,
        message: plain && r.message ? plainSentence(r.message, r.evidence ? (JSON.parse(r.evidence) as Record<string, unknown>) : {}) : r.message,
      })),
  };
}
