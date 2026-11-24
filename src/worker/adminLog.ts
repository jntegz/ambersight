// The admin log: who changed what from the dashboard. One shared passphrase means there are no
// user names, so each entry carries a pseudonymous handle of the session that made the change. It
// tells sessions apart and says nothing else: it is derived from the cookie with a separate label,
// so it is neither the session id nor the digest stored in `sessions`, and a copy of the database
// cannot link one to the other. Growth is bounded by a row cap on every write and by age in the
// scheduled run.
// SPDX-License-Identifier: AGPL-3.0-only

import { ADMIN_EVENT_DAYS, MAX_ADMIN_EVENTS } from '../shared/adminLog';
import type { Config, InstantChannel, Thresholds } from '../shared/config';
import type { AdminLogView } from '../shared/types';
import { setSettings } from './db';
import { withoutEmails } from './redact';

const DAY = 86_400_000;
/** The same action on the same target by the same session within this time adds to one entry. */
const COALESCE_MS = 10 * 60_000;
const MAX_TARGET = 300;

export interface AdminEvent {
  action: string;
  /** A short description of what changed. Never an address, a token or a passphrase. */
  target: string;
  /** Also tell the operators (see adminNotice.ts). */
  notice?: boolean;
}

/** The handle shown for a session. `id` is the cookie value. */
export async function handleOf(id: string | null): Promise<string> {
  if (!id) return 'unknown session';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ambersight-admin-log:${id}`));
  return `session ${[...new Uint8Array(hash).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Every summary passes here on its way to the log and the notices. Names people chose can hold an
 * address: Cloudflare calls a new account "<email>'s Account". Removed first, so a cut cannot leave half of one.
 */
function clip(text: string): string {
  const s = withoutEmails(text);
  return s.length > MAX_TARGET ? `${s.slice(0, MAX_TARGET - 1)}…` : s;
}

/**
 * The statements that record these events, for the same batch as the change itself. Repeats within
 * a few minutes add to the newest entry, so reconfiguring leaves one line. `noticeTo` is who must
 * hear about the pending notices (see noticeAudience).
 */
export function adminEventStatements(db: D1Database, events: AdminEvent[], actor: string, now: Date, noticeTo: string[] = []): D1PreparedStatement[] {
  if (!events.length) return [];
  const at = now.toISOString();
  const since = new Date(now.getTime() - COALESCE_MS).toISOString();
  const newest = `id = (SELECT MAX(id) FROM admin_events) AND action = ?2 AND target = ?3 AND actor = ?4`;
  return [
    ...events.flatMap((e) => {
      const target = clip(e.target);
      const notice = e.notice ? 'pending' : null;
      return [
        db.prepare(
          `UPDATE admin_events SET count = count + 1, at = ?1, notice = COALESCE(?6, notice) WHERE ${newest} AND at >= ?5`,
        ).bind(at, e.action, target, actor, since, notice),
        db.prepare(
          `INSERT INTO admin_events (at, action, target, actor, notice)
           SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM admin_events WHERE ${newest} AND at = ?1)`,
        ).bind(at, e.action, target, actor, notice),
      ];
    }),
    // The ids only grow, so this needs no count or scan of the table. A notice that has not gone out
    // yet is kept: otherwise a burst of ordinary saves could push it out before the operators hear.
    db.prepare(`DELETE FROM admin_events WHERE id <= (SELECT MAX(id) FROM admin_events) - ?1 AND notice IS NOT 'pending'`).bind(MAX_ADMIN_EVENTS),
    ...(events.some((e) => e.notice) ? [setSettings(db, { admin_notice_pending: '1', admin_notice_to: JSON.stringify(noticeTo) })] : []),
  ];
}

/** Age limit, run by the scheduled housekeeping. */
export const pruneAdminEvents = (db: D1Database, now: Date) =>
  db.prepare('DELETE FROM admin_events WHERE at < ?1').bind(new Date(now.getTime() - ADMIN_EVENT_DAYS * DAY).toISOString());

export async function buildAdminLog(db: D1Database): Promise<AdminLogView> {
  const { results } = await db
    .prepare('SELECT id, at, action, target, actor, count, notice FROM admin_events ORDER BY id DESC LIMIT 200')
    .all<AdminLogView['events'][number]>();
  return { events: results, retentionDays: ADMIN_EVENT_DAYS, maxEvents: MAX_ADMIN_EVENTS };
}

const channels = (c: InstantChannel): string[] => (c === 'both' ? ['email', 'webhook'] : c === 'off' ? [] : [c]);
const added = (from: string[], to: string[]) => to.filter((x) => !from.includes(x));
const list = (items: string[], max = 8) => `${items.slice(0, max).join(', ')}${items.length > max ? ` and ${items.length - max} more` : ''}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Thresholds where a higher value means Ambersight speaks up later or less often. */
const LOOSER_WHEN_HIGHER = (k: string) => k !== 'deployWindowMinutes';

/**
 * What a settings save changed, split into what makes Ambersight see or say less and everything
 * else. Addresses are only counted, so the log and the notices never repeat them.
 */
export function configChanges(b: Config, a: Config): { reduced: string[]; other: string[] } {
  const reduced: string[] = [];
  const other: string[] = [];
  const note = (less: boolean, text: string) => (less ? reduced : other).push(text);

  for (const sev of ['critical', 'warning', 'info'] as const) {
    const [from, to] = [b.alerts[sev], a.alerts[sev]];
    if (from.instant !== to.instant) note(added(channels(to.instant), channels(from.instant)).length > 0, `${sev} instant alerts ${from.instant} → ${to.instant}`);
    if (from.digest !== to.digest) note(!to.digest, `${sev} findings ${to.digest ? 'added to' : 'left out of'} the digest`);
  }
  if (!same(b.alerts.quietHours, a.alerts.quietHours)) {
    const q = a.alerts.quietHours;
    note(q != null, q ? `quiet hours ${q.start} to ${q.end}` : 'quiet hours removed');
  }
  if (b.digest.frequency !== a.digest.frequency) note(a.digest.frequency === 'off', `digest ${b.digest.frequency} → ${a.digest.frequency}`);

  for (const k of Object.keys(a.modules) as (keyof Config['modules'])[]) {
    if (b.modules[k] !== a.modules[k]) note(!a.modules[k], `check ${k} turned ${a.modules[k] ? 'on' : 'off'}`);
  }
  const muted = added(b.mutedChecks, a.mutedChecks);
  const unmuted = added(a.mutedChecks, b.mutedChecks);
  if (muted.length) reduced.push(`checks muted: ${list(muted)}`);
  if (unmuted.length) other.push(`checks turned back on: ${list(unmuted)}`);

  const excluded = added(b.scope.exclude, a.scope.exclude);
  const readmitted = added(a.scope.exclude, b.scope.exclude);
  if (excluded.length) reduced.push(`scope excludes ${list(excluded)}`);
  if (readmitted.length) other.push(`scope no longer excludes ${list(readmitted)}`);
  if (!same(b.scope.include, a.scope.include)) {
    const narrower = a.scope.include.length > 0 && (b.scope.include.length === 0 || added(a.scope.include, b.scope.include).length > 0);
    note(narrower, a.scope.include.length ? `scope limited to ${list(a.scope.include)}` : 'scope limit removed');
  }

  const raised: string[] = [];
  const lowered: string[] = [];
  for (const k of Object.keys(a.thresholds) as (keyof Thresholds)[]) {
    if (a.thresholds[k] === b.thresholds[k]) continue;
    (a.thresholds[k] > b.thresholds[k] && LOOSER_WHEN_HIGHER(k) ? raised : lowered).push(`${k} ${b.thresholds[k]} → ${a.thresholds[k]}`);
  }
  if (raised.length) reduced.push(`thresholds raised: ${list(raised)}`);
  if (lowered.length) other.push(`thresholds changed: ${list(lowered)}`);

  // Compares what applies before and after, so removing a strict override counts as loosening it.
  const looser: string[] = [];
  for (const target of new Set([...Object.keys(b.overrides), ...Object.keys(a.overrides)])) {
    const [from, to] = [b.overrides[target] ?? {}, a.overrides[target] ?? {}];
    for (const k of new Set([...Object.keys(from), ...Object.keys(to)]) as Set<keyof Thresholds>) {
      const [was, now] = [from[k] ?? b.thresholds[k], to[k] ?? a.thresholds[k]];
      if (LOOSER_WHEN_HIGHER(k) && now > was) looser.push(`${target} ${k} ${now}`);
    }
  }
  if (looser.length) reduced.push(`overrides raised: ${list(looser)}`);
  else if (!same(b.overrides, a.overrides)) other.push('overrides changed');

  if (a.scanIntervalMinutes !== b.scanIntervalMinutes) note(a.scanIntervalMinutes > b.scanIntervalMinutes, `scan interval ${b.scanIntervalMinutes} → ${a.scanIntervalMinutes} minutes`);
  if (a.inventoryIntervalHours !== b.inventoryIntervalHours) note(a.inventoryIntervalHours > b.inventoryIntervalHours, `inventory refresh ${b.inventoryIntervalHours} → ${a.inventoryIntervalHours} hours`);
  if (a.inventoryHourUtc !== b.inventoryHourUtc) other.push(`inventory hour ${b.inventoryHourUtc} → ${a.inventoryHourUtc} UTC`);
  if (a.plan !== b.plan) other.push(`plan ${b.plan} → ${a.plan}`);
  if (a.retentionDays !== b.retentionDays) other.push(`history kept ${b.retentionDays} → ${a.retentionDays} days`);
  if (a.timeZone !== b.timeZone) other.push(`time zone ${b.timeZone} → ${a.timeZone}`);
  if (a.updateCheck !== b.updateCheck) other.push(`update check ${a.updateCheck ? 'on' : 'off'}`);
  // Not a loss of detection: no check reads who made a change, so the same findings are raised.
  if (a.recordAttribution !== b.recordAttribution) other.push(a.recordAttribution ? 'recording who made changes turned on' : 'recording who made changes turned off, stored names erased');
  if (!same(b.groups, a.groups)) other.push('groups changed');
  if (!same({ ...b.digest, frequency: '', groupRecipients: {} }, { ...a.digest, frequency: '', groupRecipients: {} })) other.push('digest schedule or summary changed');

  // A newly named recipient stops being an operator unless DIGEST_OPERATORS lists it.
  const addresses = (c: Config) => [...Object.values(c.accounts).flatMap((x) => x.digestTo ?? []), ...Object.values(c.digest.groupRecipients).flat()].map((x) => x.toLowerCase());
  const named = added(addresses(b), addresses(a));
  if (named.length) reduced.push(`${named.length} client or group digest ${named.length === 1 ? 'recipient' : 'recipients'} added`);
  else if (!same(addresses(b).sort(), addresses(a).sort())) other.push('client or group digest recipients removed');
  const stripped = (c: Config) => Object.fromEntries(Object.entries(c.accounts).map(([id, { digestTo: _, ...rest }]) => [id, rest]));
  if (!same(stripped(b), stripped(a))) other.push('account labels, plans or budgets changed');

  const repos = Object.keys({ ...b.packageRepos, ...a.packageRepos }).filter((k) => !same(b.packageRepos[k], a.packageRepos[k]));
  if (repos.length) other.push(`package repositories changed: ${list(repos.map((k) => `${k.slice(k.indexOf(':') + 1)} → ${a.packageRepos[k]?.repo ?? 'none'}`))}`);
  return { reduced, other };
}

/** The log entries for a settings save. Only the part that reduces detection is sent out. */
export function configEvents(before: Config, after: Config): AdminEvent[] {
  const { reduced, other } = configChanges(before, after);
  return [
    ...(reduced.length ? [{ action: 'config.reduced', target: reduced.join('; '), notice: true }] : []),
    ...(other.length ? [{ action: 'config.changed', target: other.join('; ') }] : []),
  ];
}
