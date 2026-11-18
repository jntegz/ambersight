// Who made a change: the deploy author and the audit-log actor Cloudflare reports. Recording them is
// an install-wide choice (Settings › General, on by default). With it off a scan drops them before
// anything is stored, and what is stored already is erased here: the names go, the rest of each row
// stays. No check depends on who made a change, so findings do not move with the switch.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Config } from '../shared/config';
import { DASHBOARD_ONLY_EVIDENCE } from '../shared/findings';
import type { Finding } from '../shared/types';
import type { AuditEvent, CfAlert, Deployment } from './cf';
import { configFrom, setSettings, type Settings } from './db';
import { bumpRevision } from './history';
import { NOT_NAMES, withoutEmails, withoutName, withoutPerson } from './redact';

/** Set while stored names may remain: holds when erasing started. */
export const ERASE_KEY = 'attribution_erase_at';
/** When recording was last turned on. A deploy from before then is stored without its author. */
export const RESUMED_KEY = 'attribution_resumed_at';
/** Rows per table in one round. An UPDATE of this size stays far from D1's per-query time limit. */
const ROWS_PER_ROUND = 1000;
/** Texts per column checked for e-mail addresses in one round. These are rewritten in code. */
const TEXTS_PER_ROUND = 200;
const REQUEST_ROUNDS = 3;
const CRON_ROUNDS = 4;
/** At most two batches per round, plus the one that finishes. A batch is one query (see meter.ts). */
export const ERASE_QUERIES = CRON_ROUNDS * 2 + 1;
/**
 * The marker outlives the erasing by this long, so that the next cron run also removes a view that
 * was being built, or a scan that was running, while the switch was turned off.
 */
const SETTLE_MS = 5 * 60_000;

// ---- What a scan keeps with recording off ---------------------------------------------------

/** A resource that is a person: an account member, a user, or anything identified by an address. */
const isPersonResource = (e: Pick<AuditEvent, 'product' | 'resourceType' | 'resourceId'>) =>
  /member|user/i.test(`${e.product ?? ''} ${e.resourceType ?? ''}`) || (e.resourceId ?? '').includes('@');

export const anonymousDeployment = (d: Deployment): Deployment => ({
  ...d, author: null, message: d.message == null ? null : withoutPerson(d.message, d.author),
});

export const anonymousAuditEvent = (e: AuditEvent): AuditEvent => ({
  ...e,
  actor: null,
  description: e.description == null ? null : withoutPerson(e.description, e.actor),
  resourceId: isPersonResource(e) ? null : e.resourceId,
});

export const anonymousAlert = (a: CfAlert): CfAlert => ({ ...a, name: withoutEmails(a.name), description: withoutEmails(a.description) });

export const anonymousFinding = (f: Finding): Finding => ({
  ...f, evidence: Object.fromEntries(Object.entries(f.evidence).filter(([k]) => !DASHBOARD_ONLY_EVIDENCE.has(k))),
});

// ---- Erasing what is stored ------------------------------------------------------------------

const NOT_NAMES_SQL = NOT_NAMES.map((a) => `'${a}'`).join(', ');
const namesSomeone = (who: string) => `(${who} IS NOT NULL AND length(${who}) >= 3 AND lower(${who}) NOT IN (${NOT_NAMES_SQL}))`;
/** Text that contains the name. SQL can only find it: code decides where it stands on its own. */
const quotes = (text: string, who: string) => `(${namesSomeone(who)} AND ${text} IS NOT NULL AND instr(${text}, ${who}) > 0)`;
const PERSON_RESOURCE = `(lower(COALESCE(product, '') || ' ' || COALESCE(resource_type, '')) LIKE '%member%'
  OR lower(COALESCE(product, '') || ' ' || COALESCE(resource_type, '')) LIKE '%user%' OR resource_id LIKE '%@%')`;
const CLEAR_PERSON_RESOURCE = `resource_id = CASE WHEN ${PERSON_RESOURCE} THEN NULL ELSE resource_id END`;
const CHANGED_BY = `json_extract(evidence, '$.changedBy')`;
const CHANGE_TEXT = `CASE WHEN json_type(evidence, '$.change') = 'text' THEN json_extract(evidence, '$.change') END`;
const PERSON_KEYS = [...DASHBOARD_ONLY_EVIDENCE].map((k) => `$.${k}`);
const PERSON_KEYS_SQL = PERSON_KEYS.map((k) => `'${k}'`).join(', ');
const HAS_PERSON_KEY = `(${PERSON_KEYS.map((k) => `json_type(evidence, '${k}') IS NOT NULL`).join(' OR ')})`;
const DEPLOY_QUOTES = quotes('message', 'author');
const AUDIT_QUOTES = quotes('description', 'actor');
// The sentence and `change` can quote the audit text, so the name goes from them too.
const FINDING_QUOTES = `(json_type(evidence, '$.changedBy') = 'text' AND (${quotes('message', CHANGED_BY)} OR ${quotes(CHANGE_TEXT, CHANGED_BY)}))`;
const validEvidence = (condition: string) => `CASE WHEN json_valid(evidence) THEN ${condition} ELSE 0 END`;

/** Rows whose text contains the name, to be rewritten in code. */
const quotingRows = (db: D1Database) => [
  db.prepare(`SELECT rowid AS id, message AS text, author AS who FROM deployments WHERE ${DEPLOY_QUOTES} LIMIT ?1`),
  db.prepare(`SELECT rowid AS id, description AS text, actor AS who FROM audit_events WHERE ${AUDIT_QUOTES} LIMIT ?1`),
  db.prepare(`SELECT rowid AS id, message AS text, ${CHANGE_TEXT} AS note, ${CHANGED_BY} AS who FROM findings WHERE ${validEvidence(FINDING_QUOTES)} LIMIT ?1`),
].map((s) => s.bind(TEXTS_PER_ROUND));

/** All other rows: only the name itself has to go. */
const nameStatements = (db: D1Database) => [
  db.prepare(`UPDATE deployments SET author = NULL WHERE rowid IN (SELECT rowid FROM deployments WHERE author IS NOT NULL AND NOT ${DEPLOY_QUOTES} LIMIT ?1)`),
  db.prepare(
    `UPDATE audit_events SET actor = NULL, ${CLEAR_PERSON_RESOURCE}
     WHERE rowid IN (SELECT rowid FROM audit_events WHERE (actor IS NOT NULL OR (resource_id IS NOT NULL AND ${PERSON_RESOURCE})) AND NOT ${AUDIT_QUOTES} LIMIT ?1)`,
  ),
  db.prepare(
    `UPDATE findings SET evidence = json_remove(evidence, ${PERSON_KEYS_SQL})
     WHERE rowid IN (SELECT rowid FROM findings WHERE ${validEvidence(`${HAS_PERSON_KEY} AND NOT ${FINDING_QUOTES}`)} LIMIT ?1)`,
  ),
].map((s) => s.bind(ROWS_PER_ROUND));

interface QuotingRow { id: number; text: string; who: string; note?: string | null }

/** Writes back what `quotingRows` found, without the name. Each row leaves that list by this. */
function rewrites(db: D1Database, [deploys, audit, findings]: QuotingRow[][]): D1PreparedStatement[] {
  const write = (sql: string, rows: unknown[]) => (rows.length ? [db.prepare(sql).bind(JSON.stringify(rows))] : []);
  const plain = (rows: QuotingRow[]) => rows.map((r) => ({ id: r.id, text: withoutPerson(r.text, r.who) }));
  return [
    ...write(`UPDATE deployments SET message = json_extract(d.value, '$.text'), author = NULL FROM json_each(?1) AS d WHERE deployments.rowid = json_extract(d.value, '$.id')`, plain(deploys)),
    ...write(
      `UPDATE audit_events SET description = json_extract(d.value, '$.text'), actor = NULL, ${CLEAR_PERSON_RESOURCE}
       FROM json_each(?1) AS d WHERE audit_events.rowid = json_extract(d.value, '$.id')`,
      plain(audit),
    ),
    ...write(
      `UPDATE findings SET message = json_extract(d.value, '$.text'),
         evidence = json_remove(
           CASE WHEN json_type(d.value, '$.note') = 'text' THEN json_set(evidence, '$.change', json_extract(d.value, '$.note')) ELSE evidence END,
           ${PERSON_KEYS_SQL})
       FROM json_each(?1) AS d WHERE findings.rowid = json_extract(d.value, '$.id')`,
      findings.map((r) => ({ id: r.id, text: withoutName(r.text, r.who), note: r.note == null ? null : withoutName(r.note, r.who) })),
    ),
  ];
}

/** Free text that can hold an address, with no name to look for. */
const TEXT_COLUMNS = [['deployments', 'message'], ['audit_events', 'description'], ['cf_alerts', 'description'], ['cf_alerts', 'name']] as const;
/** Finds what withoutEmails replaces: a character of an address on both sides of an @. */
const NOT_IN_ADDRESS = ` \t\n\r\f\v@"'<>(),;:`;
const HAS_ADDRESS = `*[^${NOT_IN_ADDRESS}]@[^${NOT_IN_ADDRESS}]*`;

const clearViews = (db: D1Database) => db.prepare('DELETE FROM view_cache');

/** One bounded step. Returns whether it changed anything, so false means nothing is left. */
async function eraseRound(db: D1Database): Promise<boolean> {
  const quoting = quotingRows(db);
  const names = nameStatements(db);
  const results = await db.batch([
    ...quoting,
    ...names,
    clearViews(db),
    bumpRevision(db),
    ...TEXT_COLUMNS.map(([table, col]) => db.prepare(`SELECT rowid AS id, ${col} AS text FROM ${table} WHERE ${col} GLOB ?1 LIMIT ?2`).bind(HAS_ADDRESS, TEXTS_PER_ROUND)),
  ]);
  const renamed = results.slice(quoting.length, quoting.length + names.length).some((r) => (r.meta.changes ?? r.meta.rows_written ?? 0) > 0);
  const addresses = TEXT_COLUMNS.flatMap(([table, col], i) => {
    const rows = (results[quoting.length + names.length + 2 + i].results as { id: number; text: string }[])
      .map((r) => ({ id: r.id, text: withoutEmails(r.text) === r.text ? null : withoutEmails(r.text) }))
      .filter((r) => r.text !== null);
    return rows.length
      ? [db.prepare(`UPDATE ${table} SET ${col} = json_extract(d.value, '$.text') FROM json_each(?1) AS d WHERE ${table}.rowid = json_extract(d.value, '$.id')`).bind(JSON.stringify(rows))]
      : [];
  });
  // Last, because these rows can also be among the addresses, and their new text has neither.
  const updates = [...addresses, ...rewrites(db, results.slice(0, quoting.length).map((r) => r.results as QuotingRow[]))];
  if (updates.length) await db.batch([...updates, clearViews(db), bumpRevision(db)]);
  return renamed || updates.length > 0;
}

/** Runs up to `rounds` rounds. True when nothing is left to erase. */
export async function eraseAttribution(db: D1Database, rounds: number): Promise<boolean> {
  for (let i = 0; i < rounds; i++) if (!(await eraseRound(db))) return true;
  return false;
}

/** The first rounds, in the request that turned recording off. What does not fit goes to the cron. */
export const eraseNow = (db: D1Database) => eraseAttribution(db, REQUEST_ROUNDS).catch((e) => {
  console.error(e);
  return false;
});

/** The cron's part: carries on until nothing is left, and until a late writer can no longer add any. */
export async function continueErasure(db: D1Database, now: Date, settings: Settings): Promise<void> {
  const since = settings[ERASE_KEY];
  if (!since) return;
  const drop = db.prepare('DELETE FROM settings WHERE key = ?1 AND value = ?2').bind(ERASE_KEY, since);
  if (configFrom(settings).recordAttribution) {
    await drop.run();
    return;
  }
  if ((await eraseAttribution(db, CRON_ROUNDS)) && now.getTime() - Date.parse(since) >= SETTLE_MS) await db.batch([clearViews(db), drop]);
}

/**
 * For a scan that started with recording on. Should the switch have been turned off in the meantime,
 * what the scan wrote is erased by the next cron run. Decided in D1, in the batch that writes.
 */
export const markIfSwitchedOff = (db: D1Database, stamp: string) => db.prepare(
  `INSERT INTO settings (key, value)
   SELECT ?1, ?2 WHERE (SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.recordAttribution') END FROM settings WHERE key = 'config') = 0
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).bind(ERASE_KEY, stamp);

// ---- Saving the setting ----------------------------------------------------------------------

export interface AttributionStep {
  refused?: { error: string; code: string };
  /** For the batch that saves the settings. */
  statements: D1PreparedStatement[];
  /** Recording was just turned off: start erasing once the settings are saved. */
  erase: boolean;
}

/**
 * What saving the settings means for recording. Both directions must be asked for explicitly, so that
 * a restored backup or a tab opened earlier does neither by accident. Erasing cannot be undone, so a
 * save that would erase without saying so is refused. One that would start collecting names again
 * without saying so keeps recording off, and the answer shows the value that was kept.
 */
export async function attributionStep(db: D1Database, body: unknown, before: Config, after: Config, settings: Settings, now: Date): Promise<AttributionStep> {
  const sent = body as { recordAttribution?: unknown; confirmErase?: unknown; confirmRecord?: unknown };
  // A backup or an open page from before this setting says nothing about it: it stays as it is.
  if (!Object.hasOwn(sent, 'recordAttribution')) after.recordAttribution = before.recordAttribution;
  if (before.recordAttribution && !after.recordAttribution) {
    if (sent.confirmErase !== true) {
      return { statements: [], erase: false, refused: { code: 'confirm_erase', error: 'Turning this off erases the stored names and cannot be undone. Confirm it in Settings.' } };
    }
    return { statements: [setSettings(db, { [ERASE_KEY]: now.toISOString() }), clearViews(db)], erase: true };
  }
  if (!before.recordAttribution && after.recordAttribution) {
    if (sent.confirmRecord !== true) {
      after.recordAttribution = false;
      return { statements: [], erase: false };
    }
    const resumed = setSettings(db, { [RESUMED_KEY]: now.toISOString() });
    if (!settings[ERASE_KEY]) return { statements: [resumed], erase: false };
    // New names must not be taken for old ones, so the erasing finishes first.
    if (!(await eraseNow(db))) return { statements: [], erase: false, refused: { code: 'erase_running', error: 'Stored names are still being erased. Try again in a few minutes.' } };
    return { statements: [resumed, db.prepare('DELETE FROM settings WHERE key = ?1').bind(ERASE_KEY)], erase: false };
  }
  return { statements: [], erase: false };
}
