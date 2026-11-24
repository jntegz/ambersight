// Finds one person's e-mail address or name in what Ambersight stores and replaces it with a marker.
// Rows stay, so history, counts and finding identity survive. The work runs in bounded steps: rows
// are walked by rowid, a signed cursor says where to go on, and a row already replaced no longer
// matches, so repeating a step or a whole run changes nothing more. The identifier arrives with each
// request and is held nowhere: not in D1, not in logs and not in any response. A cursor or
// confirmation holds only a keyed hash that depends on it.
//
// Not touched, on purpose: finding_events and the daily tables hold check names and counts, not free
// text; d1_queries holds query shapes without values; finding ids hold Cloudflare's event ids;
// a finding's advice is Ambersight's own text; digest_parts holds keyed hashes (see notify.ts).
// SPDX-License-Identifier: AGPL-3.0-only

import { isHiddenEvidence } from '../shared/findings';
import {
  cleanIdentifier, identifierProblem, isAddress, NOT_REACHABLE, REMOVED_MARKER,
  type PersonDataClass, type PersonDataCounts, type PersonDataEntry, type PersonDataStep,
} from '../shared/personData';
import type { AdminEvent } from './adminLog';
import { anonymousAuditEvent } from './attribution';
import { safeEqual } from './auth';
import type { Settings } from './db';
import type { Env } from './env';
import { bumpRevision } from './history';
import { hashDigestParts, plainDigestParts } from './notify';

/** Rows looked at closely per step, which bounds CPU time and the size of the write. */
export const MAX_ROWS_PER_STEP = 100;
/** Rows one read walks through. A step makes at most MAX_SCANS reads, so at most 20,000 rows read. */
const WINDOW = 2000;
const MAX_SCANS = 10;
const HOUR = 3_600_000;
/** How long a cursor stays good. Each step issues a new one, so only a pause this long ends a run. */
const CURSOR_MS = { preview: HOUR, remove: 15 * 60_000 };

export type PersonStepKind = keyof typeof CURSOR_MS;

interface Target {
  cls: PersonDataClass;
  table: string;
  text: string[];
  /** Columns holding JSON: parsed and rewritten value by value. */
  json?: string[];
  where?: string;
  /** Counted in the preview, never changed. */
  reportOnly?: boolean;
  /** Also read, only to decide what happens to the row. */
  context?: string[];
  /** A column is considered only in the rows this accepts. */
  only?: Record<string, (row: Row) => boolean>;
  /** A column with its own rule for what may be replaced. */
  rewrite?: Record<string, (text: string, m: PersonMatcher) => string>;
}

/**
 * resource_id joins an audit entry to its Worker, so it changes only when it identifies a person.
 * The rule is the one a scan applies with "Record who made changes" off.
 */
const isPersonRow = (row: Row) => anonymousAuditEvent({
  id: '', at: '', actor: null, action: '', description: null, result: null,
  product: row.product as string | null, resourceType: row.resource_type as string | null, resourceId: row.resource_id as string | null,
}).resourceId === null;

const AUDIT_CONTEXT = ['product', 'resource_type'];

// Every table is an ordinary rowid table. The order is part of the cursor: add new ones at the end.
const TARGETS: readonly Target[] = [
  { cls: 'deployments', table: 'deployments', text: ['author', 'message'] },
  { cls: 'auditEvents', table: 'audit_events', text: ['actor', 'description', 'resource_id'], context: AUDIT_CONTEXT, only: { resource_id: isPersonRow } },
  { cls: 'findings', table: 'findings', text: ['message'], json: ['evidence'], rewrite: { message: scrubSentence, evidence: scrubEvidence } },
  { cls: 'adminLog', table: 'admin_events', text: ['target'] },
  { cls: 'cloudflareAlerts', table: 'cf_alerts', text: ['name', 'description'] },
  { cls: 'accountNames', table: 'accounts', text: ['name'] },
  { cls: 'apiTokenNames', table: 'api_tokens', text: ['name'] },
  { cls: 'scanNotes', table: 'account_state', text: [], json: ['value'], where: `key IN ('last_scan_error', 'last_scan_warnings')` },
  { cls: 'infrastructure', table: 'workers', text: ['name'], json: ['tags', 'bindings'], reportOnly: true },
  { cls: 'infrastructure', table: 'zones', text: ['name'], reportOnly: true },
  { cls: 'infrastructure', table: 'resources', text: ['name'], json: ['extra'], reportOnly: true },
  { cls: 'infrastructure', table: 'fleet_events', text: ['detail'], reportOnly: true },
  { cls: 'infrastructure', table: 'account_state', text: ['value'], where: `key = 'workers_subdomain'`, reportOnly: true },
  { cls: 'infrastructure', table: 'audit_events', text: ['resource_id'], context: AUDIT_CONTEXT, only: { resource_id: (row) => !isPersonRow(row) }, reportOnly: true },
  { cls: 'passkeyNames', table: 'passkeys', text: ['name'] },
];

export interface PersonMatcher {
  /** An address matches in any case. A name matches exactly as typed. */
  address: boolean;
  has(text: string): boolean;
  scrub(text: string): string;
  /** A LIKE pattern (escape character: backslash) that every match satisfies. It may match more. */
  like: string;
}

const WORD = '\\p{L}\\p{M}\\p{N}_';
const escapeRegex = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/**
 * Candidates for the exact check. JSON text writes quotes and backslashes with an escape, so those
 * become a wildcard here. LIKE folds ASCII only: for an address, which matches in any case, other
 * cased letters become a wildcard too. A name matches as typed, so its letters stay, and a name in
 * another script narrows the search like any other. `%` and `_` typed by the operator stay literal.
 */
function likePattern(identifier: string, anyCase: boolean): string {
  let out = '%';
  let open = true;
  for (const ch of identifier) {
    const unknown = ch === '\\' || ch === '"' || /\s/u.test(ch) || (anyCase && ch > '\x7f' && ch.toLowerCase() !== ch.toUpperCase());
    if (unknown) {
      if (!open) out += '%';
      open = true;
    } else {
      out += ch === '%' || ch === '_' ? `\\${ch}` : ch;
      open = false;
    }
  }
  return open ? out : `${out}%`;
}

/**
 * Matches whole identifiers: an address in any case, a name exactly as typed, so that the name Will
 * leaves "will" alone. An address must not be part of a longer one, so removing ann@example.com
 * leaves joann@example.com and ann@example.com.au alone. A name must not be part of a word, or of a
 * compound like Ann-Marie, Ann.Lee or Ann@example.com; "Ann's account" does match.
 */
export function personMatcher(identifier: string): PersonMatcher {
  const address = isAddress(identifier);
  const body = identifier.split(/\s+/u).map(escapeRegex).join('\\s+');
  const pattern = address
    ? `(?<![${WORD}.%+-])${body}(?![${WORD}%+-])(?!\\.[${WORD}])`
    : `(?<![${WORD}])(?<![${WORD}][.@+-])${body}(?![${WORD}])(?![.@+-][${WORD}])`;
  const re = new RegExp(pattern, address ? 'giu' : 'gu');
  return {
    address,
    has: (text) => text.search(re) >= 0,
    scrub: (text) => text.replace(re, REMOVED_MARKER),
    like: likePattern(identifier, address),
  };
}

/** Only values change. Keys are names the code reads, such as the evidence keys sw.js removes. */
function scrubValue(value: unknown, m: PersonMatcher): unknown {
  if (typeof value === 'string') return m.scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, m));
  if (value === null || typeof value !== 'object') return value;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, m);
  return out;
}

/** The new text, or the original when nothing changed, so that its formatting stays. */
const jsonAfter = (text: string, parsed: unknown, scrubbed: unknown) => {
  const after = JSON.stringify(scrubbed);
  return after === JSON.stringify(parsed) ? text : after;
};

/** Rewrites JSON value by value, so it stays valid. Text that is not JSON is treated as plain text. */
export function scrubJson(text: string, m: PersonMatcher): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return m.scrub(text);
  }
  return jsonAfter(text, parsed, scrubValue(parsed, m));
}

const QUOTED = /"[^"\r\n]*"/g;

/**
 * A finding's sentence is Ambersight's own text with what others wrote in quotes. No sentence of ours
 * contains an address, but any word of it could be someone's name, so a name changes only in quotes.
 */
function scrubSentence(text: string, m: PersonMatcher): string {
  return m.address ? m.scrub(text) : text.replace(QUOTED, (q) => m.scrub(q));
}

/** A finding's evidence: `change` repeats part of the sentence, and hidden keys are for the code. */
function scrubEvidence(text: string, m: PersonMatcher): string {
  if (m.address) return scrubJson(text, m);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return m.scrub(text);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonAfter(text, parsed, scrubValue(parsed, m));
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(parsed)) {
    out[k] = isHiddenEvidence(k) ? v : k === 'change' && typeof v === 'string' ? scrubSentence(v, m) : scrubValue(v, m);
  }
  return jsonAfter(text, parsed, out);
}

// ---- Requests --------------------------------------------------------------

interface Position { target: number; rowid: number }

export interface PersonRequest {
  identifier: string;
  matcher: PersonMatcher;
  start: Position;
  /** The first step of a run: no cursor was sent. */
  first: boolean;
  /** What the cursor claims. It counts only once `cursorValid` has checked it. */
  signed?: { expires: number; mac: string };
}

function parseCursor(value: unknown): Pick<PersonRequest, 'start' | 'signed'> | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,16})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return null;
  const [target, rowid, expires] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return target <= TARGETS.length && Number.isSafeInteger(rowid) && Number.isSafeInteger(expires)
    ? { start: { target, rowid }, signed: { expires, mac: m[4] } }
    : null;
}

/** Reads what a request asks for. Refusals are fixed sentences: they never repeat the input. */
export function personRequest(body: { identifier?: unknown; cursor?: unknown }): PersonRequest | { error: string } {
  if (typeof body.identifier !== 'string') return { error: 'Enter an e-mail address or name.' };
  const identifier = cleanIdentifier(body.identifier);
  const problem = identifierProblem(identifier);
  if (problem) return { error: problem };
  const matcher = personMatcher(identifier);
  // It would also match the marker this leaves behind.
  if (matcher.has(REMOVED_MARKER)) return { error: 'That word is used by the removal marker, so it cannot be searched for.' };
  const first = body.cursor == null;
  const cursor = first ? { start: { target: 0, rowid: 0 } } : parseCursor(body.cursor);
  if (!cursor) return { error: CURSOR_REFUSED };
  return { identifier, matcher, first, ...cursor };
}

export const CURSOR_REFUSED = 'Start again: this search can no longer continue.';

/** The same identifier for what is signed: addresses match in any case, names do not. */
const signedForm = (identifier: string) => (isAddress(identifier) ? identifier.toLowerCase() : identifier);

/** An HMAC keyed by the session cookie, so what it signs is good for this session only. */
async function sessionMac(session: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(session), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const confirmationAt = (session: string, identifier: string, hour: number) =>
  sessionMac(session, `ambersight-personal-data:${hour}:${signedForm(identifier)}`);

/** Ties a removal to a finished preview of the same identifier by the same session, with nothing stored. */
export async function confirmationValid(session: string, identifier: string, value: unknown, now = Date.now()): Promise<boolean> {
  if (typeof value !== 'string') return false;
  const hour = Math.floor(now / HOUR);
  return (await safeEqual(value, await confirmationAt(session, identifier, hour))) || safeEqual(value, await confirmationAt(session, identifier, hour - 1));
}

const cursorMac = (session: string, kind: PersonStepKind, identifier: string, p: Position, expires: number) =>
  sessionMac(session, `ambersight-personal-data-cursor:${kind}:${p.target}.${p.rowid}:${expires}:${signedForm(identifier)}`);

async function signCursor(session: string, kind: PersonStepKind, identifier: string, p: Position, now: number): Promise<string> {
  const expires = now + CURSOR_MS[kind];
  return `${p.target}.${p.rowid}.${expires}.${await cursorMac(session, kind, identifier, p, expires)}`;
}

/**
 * Whether this step may go on from its cursor. Cursors come only from an earlier step of the same
 * kind, session and identifier, so a preview that ends has walked everything from the start, and a
 * removal step follows one that passed the passphrase check. No cursor: the first step, which is free
 * to start but, for a removal, must prove itself.
 */
export async function cursorValid(session: string, kind: PersonStepKind, req: PersonRequest, now = Date.now()): Promise<boolean> {
  if (req.first) return true;
  if (!req.signed || req.signed.expires <= now || req.signed.expires > now + CURSOR_MS[kind]) return false;
  return safeEqual(req.signed.mac, await cursorMac(session, kind, req.identifier, req.start, req.signed.expires));
}

// ---- Walking the tables ----------------------------------------------------

type Row = Record<string, unknown> & { s: number; r: number; n: number };
interface Change { r: number; o: Record<string, string>; n: Record<string, string> }

function changeOf(t: Target, row: Row, m: PersonMatcher): Change | null {
  const change: Change = { r: row.r, o: {}, n: {} };
  const consider = (col: string, plain: (text: string, m: PersonMatcher) => string) => {
    const before = row[col];
    if (typeof before !== 'string' || t.only?.[col]?.(row) === false) return;
    const after = (t.rewrite?.[col] ?? plain)(before, m);
    if (after !== before) {
      change.o[col] = before;
      change.n[col] = after;
    }
  };
  for (const col of t.text) consider(col, (s) => m.scrub(s));
  for (const col of t.json ?? []) consider(col, scrubJson);
  return Object.keys(change.n).length ? change : null;
}

/** One window of rows: a summary row (s = 0) saying how far it reached, then the candidates in it. */
function readWindow(db: D1Database, t: Target, m: PersonMatcher, after: number, room: number) {
  const searched = [...t.text, ...(t.json ?? [])];
  const cols = [...searched, ...(t.context ?? [])];
  const candidate = searched.map((c) => `${c} LIKE ?3 ESCAPE '\\'`).join(' OR ');
  return db.prepare(
    `WITH w AS (SELECT rowid AS r, ${cols.join(', ')} FROM ${t.table} WHERE rowid > ?1 ${t.where ? `AND ${t.where}` : ''} ORDER BY rowid LIMIT ?2)
     SELECT 0 AS s, MAX(r) AS r, COUNT(*) AS n, ${cols.map((c) => `NULL AS ${c}`).join(', ')} FROM w
     UNION ALL
     SELECT * FROM (SELECT 1, r, 0, ${cols.join(', ')} FROM w WHERE ${candidate} ORDER BY r LIMIT ?4)`,
  ).bind(after, WINDOW, m.like, room);
}

async function walk(db: D1Database, m: PersonMatcher, start: Position, skipReportOnly: boolean) {
  const found = new Map<Target, Change[]>();
  let { target, rowid } = start;
  let looked = 0;
  let scans = 0;
  while (target < TARGETS.length && scans < MAX_SCANS && looked < MAX_ROWS_PER_STEP) {
    const t = TARGETS[target];
    if (t.reportOnly && skipReportOnly) {
      target++;
      rowid = 0;
      continue;
    }
    scans++;
    const room = MAX_ROWS_PER_STEP - looked;
    const { results } = await readWindow(db, t, m, rowid, room).all<Row>();
    const head = results.find((x) => x.s === 0);
    const rows = results.filter((x) => x.s === 1);
    looked += rows.length;
    for (const row of rows) {
      const change = changeOf(t, row, m);
      if (change) found.set(t, [...(found.get(t) ?? []), change]);
    }
    if (rows.length === room) rowid = rows.at(-1)!.r; // stopped at the limit, inside the window
    else if (head?.n === WINDOW) rowid = head.r;
    else {
      target++;
      rowid = 0;
    }
  }
  return { found, position: { target, rowid } };
}

// ---- What is only reported --------------------------------------------------

function configLabel(path: string[]): string {
  if (path[0] === 'accounts') return path[2] === 'digestTo' ? 'Digest recipients of an account' : path[2] === 'label' ? 'Label of an account' : 'Settings of an account';
  if (path[0] === 'digest' && path[1] === 'groupRecipients') return 'Digest recipients of a group';
  if (path[0] === 'groups') return 'Group definition';
  if (path[0] === 'scope') return 'Scope rule';
  if (path[0] === 'overrides') return 'Override rule';
  if (path[0] === 'packageRepos') return 'Package repository mapping';
  return 'Another setting';
}

function configHits(value: unknown, m: PersonMatcher, path: string[], add: (label: string) => void) {
  if (typeof value === 'string') {
    if (m.has(value)) add(configLabel(path));
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => configHits(v, m, [...path, String(i)], add));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (m.has(k)) add(configLabel([...path, k]));
      configHits(v, m, [...path, k], add);
    }
  }
}

/**
 * Settings holding the identifier, by where they are. Editing them here could silently change who
 * gets mail, and the pending notice list must not be something a session can shorten.
 */
export function reportedEntries(m: PersonMatcher, settings: Settings, env: Env): PersonDataEntry[] {
  const counts = new Map<string, number>();
  const add = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
  try {
    configHits(JSON.parse(settings.config ?? '{}'), m, [], add);
  } catch {
    if (m.has(settings.config ?? '')) add('Settings');
  }
  if (settings.admin_notice_to && m.has(settings.admin_notice_to)) add('Recipients of a waiting admin notice (cleared once it is delivered)');
  for (const name of ['DIGEST_TO', 'DIGEST_OPERATORS', 'EMAIL_FROM'] as const) {
    if ((env[name] ?? '').split(',').some((v) => m.has(v.trim()))) add(`Worker variable ${name}`);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

// ---- The two operations -----------------------------------------------------

const countsFrom = (found: Map<Target, Change[]>): PersonDataCounts => {
  const counts: PersonDataCounts = {};
  for (const [t, list] of found) counts[t.cls] = (counts[t.cls] ?? 0) + list.length;
  return counts;
};

const finished = (p: Position) => p.target >= TARGETS.length;
const changesOf = (meta: { changes?: number; rows_written?: number }) => meta.changes ?? meta.rows_written ?? 0;

/** Counts one step's matches. Reads only. */
export async function previewPersonData(env: Env, req: PersonRequest, settings: Settings, session: string, now = Date.now()): Promise<PersonDataStep> {
  const db = env.DB;
  const m = req.matcher;
  const { found, position } = await walk(db, m, req.start, false);
  const done = finished(position);
  const step: PersonDataStep = { counts: countsFrom(found), done, cursor: done ? null : await signCursor(session, 'preview', req.identifier, position, now), notReachable: NOT_REACHABLE };
  if (!done) return step;
  const named = (await plainDigestParts(db)).rows.filter((r) => m.has(r.part)).length;
  if (named) step.counts.digestDelivery = named;
  // Cached views are all cleared, so a rough count is enough and no large body reaches this Worker.
  step.cachedViews = (await db.prepare(`SELECT COUNT(*) AS n FROM view_cache WHERE body LIKE ?1 ESCAPE '\\'`).bind(m.like).first<number>('n')) ?? 0;
  step.reported = reportedEntries(m, settings, env);
  step.confirmation = await confirmationAt(session, req.identifier, Math.floor(now / HOUR));
  return step;
}

function updateStatement(db: D1Database, t: Target, changes: Change[]): D1PreparedStatement {
  const cols = [...t.text, ...(t.json ?? [])];
  const set = cols.map((c) => `${c} = CASE WHEN json_type(s.value, '$.n.${c}') IS NULL THEN ${t.table}.${c} ELSE json_extract(s.value, '$.n.${c}') END`);
  // Only a value still as it was read is replaced. A scan may have rewritten it meanwhile.
  const same = cols.map((c) => `(json_type(s.value, '$.o.${c}') IS NULL OR ${t.table}.${c} IS json_extract(s.value, '$.o.${c}'))`);
  return db.prepare(
    `UPDATE ${t.table} SET ${set.join(', ')} FROM json_each(?1) AS s
     WHERE ${t.table}.rowid = json_extract(s.value, '$.r') AND ${same.join(' AND ')}`,
  ).bind(JSON.stringify(changes));
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * Replaces one step's matches. The change, the log entry and, at the end, clearing the cached views
 * are one D1 batch. A row that changed after it was read keeps the step from counting as finished,
 * so it is read again. Delivery records are not edited: the last step only hashes any still in the
 * older form, all of them, which keeps them counting as sent and leaves no address in that table.
 */
export async function removePersonData(
  env: Env, req: PersonRequest, session: string, logStatements: (events: AdminEvent[]) => Promise<D1PreparedStatement[]>, now = Date.now(),
): Promise<{ step: PersonDataStep; events: AdminEvent[] }> {
  const db = env.DB;
  const m = req.matcher;
  const { found, position } = await walk(db, m, req.start, true);
  const reachedEnd = finished(position);
  const digest = reachedEnd ? await plainDigestParts(db) : { full: false, rows: [] };
  const done = reachedEnd && !digest.full;
  const digestNamed = digest.rows.filter((r) => m.has(r.part)).length;
  const digestWrites = await hashDigestParts(env, digest.rows);
  const updates = [...found].map(([t, changes]) => ({ cls: t.cls, planned: changes.length, statement: updateStatement(db, t, changes) }));
  const planned = updates.reduce((sum, u) => sum + u.planned, digestNamed);

  // Counts only: the entry must not say whose data this was.
  const events: AdminEvent[] = planned || done
    ? [{ action: 'personal-data.removed', target: `${plural(planned, 'stored record')} changed${done ? ', cached views cleared' : ''}`, notice: true }]
    : [];
  const clearViews = done ? [db.prepare('DELETE FROM view_cache')] : [];
  const statements = [
    ...updates.map((u) => u.statement),
    ...digestWrites,
    ...(planned || done ? [bumpRevision(db)] : []),
    ...clearViews,
    ...(await logStatements(events)),
  ];
  const results = statements.length ? await db.batch(statements) : [];

  const counts: PersonDataCounts = {};
  if (digestNamed) counts.digestDelivery = digestNamed;
  let raced = false;
  updates.forEach((u, i) => {
    const changed = changesOf(results[i].meta);
    if (changed) counts[u.cls] = (counts[u.cls] ?? 0) + changed;
    if (changed < u.planned) raced = true;
  });
  const complete = done && !raced;
  const next = raced ? req.start : position;
  const step: PersonDataStep = { counts, done: complete, cursor: complete ? null : await signCursor(session, 'remove', req.identifier, next, now), notReachable: NOT_REACHABLE };
  if (done) step.cachedViews = changesOf(results[updates.length + digestWrites.length + 1].meta);
  if (complete) step.reported = reportedEntries(m, await settingsFor(db), env);
  return { step, events };
}

async function settingsFor(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key IN ('config', 'admin_notice_to')`).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}
