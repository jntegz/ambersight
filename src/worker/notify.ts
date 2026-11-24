// Instant alerts and the digest, by e-mail (send_email binding) and/or webhook.
// Recipients come only from configuration; no endpoint accepts an address or a URL.
// DIGEST_TO is the gate for every address. All-account mail goes only to operators; a client or
// group recipient gets its own digest, one message per address.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, type Config } from '../shared/config';
import { isDashboardOnlyEvidence, isHiddenEvidence, quoted, quoteNames } from '../shared/findings';
import type { Severity } from '../shared/types';
import { getSettings, setSettings, type AccountRow } from './db';
import type { Env } from './env';
import { aiSummary, digestData, renderDigest, subjectFor, type AccountDigest } from './digest';
import { fetchIncidents } from './incidents';
import { allowedFetch } from './net';
import { safeError } from './redact';
import { plainDigest } from './tokenView';
import { activeAccounts } from './scheduler';
import { digestDue, inQuietHours, localTime } from './time';

const DAY = 86_400_000;
const MAX_DIGEST_ROWS = 25;
const MAX_ALERT_ROWS = 50;
/** Lines one chat message shows, and how long one may be. */
const MAX_CHAT_ROWS = 20;
const MAX_CHAT_LINE = 500;
/**
 * How long a run holds findings or digest parts it is about to send. Shorter than the 13 minutes
 * between two scans of an account, so what a crashed run or a failed send left behind is retried
 * by the next scan, and long enough that an overlapping run cannot send the same thing.
 */
const CLAIM_MS = 10 * 60_000;
/** Sends allowed when the caller does not say: enough for any small install. */
const DEFAULT_SENDS = 40;

export const NO_OPERATOR = 'No alert or all-account digest was sent by e-mail: every DIGEST_TO address is a client or group recipient. Add your own address to DIGEST_TO, or list one in DIGEST_OPERATORS.';
/** Settings key: the UTC day a "scans are failing" alert last had no operator to go to. */
export const SYSTEM_ALERT_UNDELIVERED = 'system_alert_undelivered';

export interface Row {
  id: string;
  /** Account label, set only when the install watches more than one account. */
  account?: string;
  script: string;
  severity: Severity;
  message: string;
  action: string;
  evidence?: string;
  /** The check that raised it; the AI summary works from these instead of the message. */
  module?: string;
  code?: string;
}

/** How many more messages this run may send: each is a subrequest and a D1 write to record it. */
export interface SendBudget {
  left: number;
}

const spend = (b: SendBudget) => {
  if (b.left <= 0) return false;
  b.left--;
  return true;
};

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const label = (s: Severity) => (s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Info');
/** Whom a line is about, always first and always quoted: names are chosen by people in the account. */
export const who = (script: string, account?: string) => {
  const name = script === '*' ? 'Account' : quoted(script);
  return account ? `${quoted(account)} · ${name}` : name;
};
export const n = (x: number) => x.toLocaleString('en-US');
export const FONT = 'Inter,Arial,sans-serif';

const evidenceOf = (e?: string): Record<string, unknown> => {
  if (!e) return {};
  try {
    return JSON.parse(e) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The finding's sentence with the names in it quoted. */
export const messageText = (r: Pick<Row, 'message' | 'evidence'>) => quoteNames(r.message, evidenceOf(r.evidence));

export function evidenceText(e?: string): string {
  return Object.entries(evidenceOf(e))
    .filter(([k]) => !isHiddenEvidence(k) && !isDashboardOnlyEvidence(k))
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${typeof v === 'number' ? n(v) : v}`)
    .join(' · ');
}

/** One finding as a table row, for alert and digest e-mail. */
export function findingHtml(r: Row): string {
  const facts = evidenceText(r.evidence);
  return `<tr><td style="padding:12px 0;border-bottom:1px solid #EADFD5">
        <div style="font:600 14px/20px ${FONT};color:${r.severity === 'critical' ? '#C2361B' : r.severity === 'warning' ? '#B3440B' : '#6E6259'}">${label(r.severity)} · ${esc(who(r.script, r.account))}</div>
        <div style="font:400 15px/22px ${FONT};color:#2B211B">${esc(messageText(r))}</div>
        <div style="font:400 13px/20px ${FONT};color:#6E6259">${esc(r.action)}</div>
        ${facts ? `<div style="font:400 12px/18px ${FONT};color:#6E6259">${esc(facts)}</div>` : ''}</td></tr>`;
}

/** The same finding as plain text. */
export const findingText = (r: Row) => `[${r.severity}] ${who(r.script, r.account)}: ${messageText(r)}\n  ${r.action}`;

export function render(title: string, intro: string, rows: Row[]): { html: string; text: string } {
  const html = `<!doctype html><html><body style="margin:0;background:#FFFCF8;padding:24px">
    <table role="presentation" width="100%" style="max-width:600px;margin:0 auto">
    <tr><td style="font:600 20px/28px ${FONT};color:#2B211B;padding-bottom:4px">${esc(title)}</td></tr>
    <tr><td style="font:400 14px/20px ${FONT};color:#6E6259;padding-bottom:12px">${esc(intro)}</td></tr>
    ${rows.map(findingHtml).join('')}
    <tr><td style="font:400 12px/18px ${FONT};color:#6E6259;padding-top:16px">Sent by your Ambersight Worker. Read-only, running in your own Cloudflare account.</td></tr>
    </table></body></html>`;
  return { html, text: [title, intro, '', ...rows.map(findingText)].join('\n') };
}

export function webhookKind(url: string): 'slack' | 'discord' | 'telegram' | 'ntfy' | 'json' {
  const h = new URL(url).hostname;
  if (h === 'hooks.slack.com') return 'slack';
  if (h === 'discord.com' || h === 'discordapp.com') return 'discord';
  if (h === 'api.telegram.org') return 'telegram';
  if (h === 'ntfy.sh' || h.startsWith('ntfy.')) return 'ntfy';
  return 'json';
}

/**
 * Finding text carries names other people in the account choose (KV titles, route patterns), so
 * neutralise chat markup: no forged lines, no Slack <!channel> or <url|label>, no Discord masked links.
 */
function chatSafe(s: string, kind: ReturnType<typeof webhookKind>): string {
  const flat = s.replace(/[\r\n\u2028\u2029]+/g, ' ');
  if (kind === 'slack') return flat.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (kind === 'discord') return flat.replace(/[\\[\]()*_~`|>#@]/g, '\\$&');
  return flat;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export interface WebhookResult {
  /** Findings the message really showed. Only these count as delivered on this channel. */
  delivered: string[];
  /** Findings left out, including `more` the caller did not pass. */
  omitted: number;
}

/**
 * Posts one message. Chat services get what fits their limits, and a last line saying how many
 * findings did not; the JSON format carries every row. `more` counts findings due beyond `rows`.
 */
export async function sendWebhook(url: string, title: string, rows: Row[], note?: string, more = 0): Promise<WebhookResult> {
  const kind = webhookKind(url);
  const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let shown = rows;
  let init: RequestInit;
  if (kind === 'json') {
    init = json({
      title, ...(note ? { note } : {}), ...(more ? { more } : {}),
      findings: rows.map((r) => ({ id: r.id, ...(r.account ? { account: r.account } : {}), worker: r.script, severity: r.severity, message: messageText(r), action: r.action })),
    });
  } else {
    // ntfy counts bytes and has no separate title line in the body; the others count characters.
    const size = (s: string) => (kind === 'ntfy' ? new TextEncoder().encode(s).length : s.length);
    const limit = (kind === 'discord' ? 1900 : 3900) - 100; // room for the "more" line
    const head = kind === 'ntfy' ? [] : [clip(title, 300), ...(note ? [clip(chatSafe(note, kind), 400)] : [])];
    const lines: string[] = [];
    let used = size(head.join('\n'));
    shown = [];
    for (const r of rows.slice(0, MAX_CHAT_ROWS)) {
      const line = clip(`• [${label(r.severity)}] ${chatSafe(`${who(r.script, r.account)}: ${messageText(r)}`, kind)}`, MAX_CHAT_LINE);
      if (used + size(line) + 1 > limit) break;
      used += size(line) + 1;
      lines.push(line);
      shown.push(r);
    }
    const left = rows.length - shown.length + more;
    const tail = left ? [`…and ${n(left)} more not shown here. They stay due and follow in the next alert.`] : [];
    const text = [...head, ...lines, ...tail].join('\n');
    init =
      kind === 'slack' ? json({ text })
      : kind === 'discord' ? json({ content: text, allowed_mentions: { parse: [] } })
      : kind === 'telegram' ? json({ chat_id: new URL(url).searchParams.get('chat_id'), text })
      : { method: 'POST', headers: { Title: title.slice(0, 200) }, body: text || title };
  }
  const res = await allowedFetch(url, init, url);
  if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
  return { delivered: shown.map((r) => r.id), omitted: rows.length - shown.length + more };
}

const addresses = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const addressKey = (a: string) => a.toLowerCase();

/** Every address allowed to receive mail: DIGEST_TO, the deployment's gate. */
export function recipients(env: Env): string[] {
  const seen = new Set<string>();
  return addresses(env.DIGEST_TO).filter((a) => !seen.has(addressKey(a)) && Boolean(seen.add(addressKey(a))));
}

/** IDs of the watched accounts. None when they cannot be read, which only makes the operator list stricter. */
export const watchedAccountIds = async (env: Env, now = new Date()): Promise<string[]> =>
  (await activeAccounts(env, now).catch(() => [])).map((a) => a.id);

/**
 * Who gets all-account mail: DIGEST_TO without the addresses named as a client or group recipient.
 * DIGEST_OPERATORS keeps an address in. So does having the per-account digest of every watched
 * account: all-account mail covers nothing that address does not already get, which is the usual
 * one-account install. A group recipient gets no such exception. There is no other fallback: with
 * no operator left, that mail is not sent, because the only people who could get it are clients.
 */
export function operatorAddresses(env: Env, config: Config, watched: readonly string[]): string[] {
  const grouped = new Set(Object.values(config.digest.groupRecipients).flat().map(addressKey));
  const assigned = new Map<string, Set<string>>();
  for (const [id, account] of Object.entries(config.accounts)) {
    for (const to of account.digestTo ?? []) {
      const key = addressKey(to);
      assigned.set(key, (assigned.get(key) ?? new Set<string>()).add(id));
    }
  }
  const marked = new Set(addresses(env.DIGEST_OPERATORS).map(addressKey));
  return recipients(env).filter((a) => {
    const key = addressKey(a);
    if (marked.has(key)) return true;
    if (grouped.has(key)) return false;
    const own = assigned.get(key);
    return !own || (watched.length > 0 && watched.every((id) => own.has(id)));
  });
}

/** The configured addresses that DIGEST_TO allows, once each, spelled as in DIGEST_TO. */
function allowedAddresses(env: Env, list: string[]): string[] {
  const wanted = new Set(list.map(addressKey));
  return recipients(env).filter((a) => wanted.has(addressKey(a)));
}

export const emailReady = (env: Env) => Boolean(env.EMAIL && env.EMAIL_FROM && recipients(env).length);

export async function sendEmail(env: Env, to: string[], subject: string, body: { html: string; text: string }) {
  // Subjects can carry an account name set in Cloudflare: keep them to one line.
  const oneLine = subject.replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 200);
  await env.EMAIL!.send({ to, from: env.EMAIL_FROM!, subject: oneLine, ...body });
}

type Channel = 'email' | 'webhook';
const COLUMNS = {
  email: { sent: 'notified_email_at', claim: 'claim_email_until' },
  webhook: { sent: 'notified_webhook_at', claim: 'claim_webhook_until' },
} as const;
const CHANNELS = ['email', 'webhook'] as const;
const SEVERITIES = ['critical', 'warning', 'info'] as const;

/**
 * Sends what is due and returns warnings for the scan. A channel that fails costs only its own
 * delivery: the other channel and the digest still go out, and what failed is retried next scan.
 */
export async function sendAlerts(env: Env, now: Date, config: Config, budget: SendBudget = { left: DEFAULT_SENDS }): Promise<string[]> {
  const warnings: string[] = [];
  const canEmail = emailReady(env);
  if (!canEmail && !env.WEBHOOK_URL) return warnings;
  // The same list scanning uses, so an account taken off the list stops alerting.
  const active = await activeAccounts(env, now);
  const operators = canEmail ? operatorAddresses(env, config, active.map((a) => a.id)) : [];
  if (canEmail && !operators.length) warnings.push(NO_OPERATOR);
  await sendInstant(env, now, config, active, operators, budget, warnings).catch((e: Error) => warnings.push(`Alerts failed: ${safeError(e.message)}`));
  if (canEmail) await sendDigests(env, now, config, active, operators, budget, warnings).catch((e: Error) => warnings.push(`Digest failed: ${safeError(e.message)}`));
  return warnings;
}

type AlertRow = Row & { account: string; due_total: number };

/**
 * Instant alerts: open findings a channel has not carried yet, or carried more than 24 h ago. Each
 * channel keeps its own record and reads its own window of rows, so one that keeps failing cannot
 * crowd out the other. Rows are claimed in one atomic write before anything is sent, so runs that
 * overlap cannot send the same finding twice. Only severities with a working channel are read:
 * undeliverable rows would fill the window on every scan and crowd out the ones that can go.
 */
async function sendInstant(env: Env, now: Date, config: Config, active: AccountRow[], operators: string[], budget: SendBudget, warnings: string[]): Promise<void> {
  const db = env.DB;
  const stamp = now.toISOString();
  const routed = (c: Channel) => SEVERITIES.filter((s) => config.alerts[s].instant === c || config.alerts[s].instant === 'both');
  const on: Record<Channel, readonly Severity[]> = { email: operators.length ? routed('email') : [], webhook: env.WEBHOOK_URL ? routed('webhook') : [] };
  const channels = CHANNELS.filter((c) => on[c].length);
  if (!active.length || !channels.length || inQuietHours(now, config.timeZone, config.alerts.quietHours)) return;

  const dayAgo = new Date(now.getTime() - DAY).toISOString();
  const accountIds = JSON.stringify(active.map((a) => a.id));
  const selected = await db.batch(channels.map((c) => db.prepare(
    `SELECT id, account, script, severity, message, action, evidence, COUNT(*) OVER () AS due_total
     FROM findings
     WHERE status = 'open' AND account IN (SELECT value FROM json_each(?1)) AND severity IN (SELECT value FROM json_each(?2))
       AND (${COLUMNS[c].sent} IS NULL OR ${COLUMNS[c].sent} < ?3) AND (${COLUMNS[c].claim} IS NULL OR ${COLUMNS[c].claim} <= ?4)
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_seen, id LIMIT ${MAX_ALERT_ROWS}`,
  ).bind(accountIds, JSON.stringify(on[c]), dayAgo, stamp)));
  const dueOn = (c: Channel) => (selected[channels.indexOf(c)]?.results ?? []) as AlertRow[];
  /** Findings due on this channel beyond the ones read. */
  const moreOn = (c: Channel) => Math.max(0, (dueOn(c)[0]?.due_total ?? 0) - dueOn(c).length);
  const wanted = channels.filter((c) => dueOn(c).length && spend(budget));
  if (!wanted.length) return;

  const until = new Date(now.getTime() + CLAIM_MS).toISOString();
  const claims = await db.batch(wanted.map((c) => db.prepare(
    `UPDATE findings SET ${COLUMNS[c].claim} = ?1
     WHERE id IN (SELECT value FROM json_each(?2)) AND status = 'open' AND (${COLUMNS[c].sent} IS NULL OR ${COLUMNS[c].sent} < ?3)
       AND (${COLUMNS[c].claim} IS NULL OR ${COLUMNS[c].claim} <= ?4)
     RETURNING id`,
  ).bind(until, JSON.stringify(dueOn(c).map((r) => r.id)), dayAgo, stamp)));
  const labels = accountLabels(active, config);
  const claimed = (c: Channel): Row[] => {
    const ids = new Set((claims[wanted.indexOf(c)]?.results as { id: string }[] | undefined)?.map((r) => r.id));
    return dueOn(c).filter((r) => ids.has(r.id)).map((r) => ({ ...r, account: labels(r.account) }));
  };
  const viaEmail = claimed('email');
  const viaHook = claimed('webhook');

  const crit = (rows: Row[]) => rows.filter((r) => r.severity === 'critical').length;
  const title = (rows: Row[]) =>
    crit(rows) ? `${crit(rows)} critical ${crit(rows) === 1 ? 'finding' : 'findings'} in your Workers` : `${rows.length} new ${rows.length === 1 ? 'finding' : 'findings'} in your Workers`;
  // "Is it us or Cloudflare?": name an active Cloudflare incident next to the alert (opt-in).
  let note = '';
  if (config.modules.incidents && (viaEmail.length || viaHook.length) && spend(budget)) {
    const open = await fetchIncidents('unresolved').catch(() => []);
    if (open.length) note = `Cloudflare reports ${open.length === 1 ? 'an active incident' : `${open.length} active incidents`}: ${open[0].name}. Some of this may be on Cloudflare's side.`;
  }

  const delivered: Partial<Record<Channel, string[]>> = {};
  if (viaEmail.length) {
    const waiting = moreOn('email') ? ` ${n(moreOn('email'))} more are waiting and follow in the next alert.` : '';
    try {
      await sendEmail(env, operators, `Ambersight: ${title(viaEmail)}`, render(title(viaEmail), `${note || 'Ambersight found something that needs attention.'}${waiting}`, viaEmail));
      delivered.email = viaEmail.map((r) => r.id);
    } catch (e) {
      warnings.push(`E-mail alert failed: ${safeError((e as Error).message)}`);
    }
  }
  if (viaHook.length) {
    try {
      delivered.webhook = (await sendWebhook(env.WEBHOOK_URL!, `Ambersight: ${title(viaHook)}`, viaHook, note || undefined, moreOn('webhook'))).delivered;
    } catch (e) {
      warnings.push(`Webhook alert failed: ${safeError((e as Error).message)}`);
    }
  }

  const all = [...new Set(Object.values(delivered).flat())];
  if (!all.length) return;
  await db.batch([
    // The alert in the finding's history, for alert-quality analytics.
    db.prepare(
      `INSERT INTO finding_events (account, finding_id, at, kind, severity, check_id, script)
       SELECT account, id, ?1, 'alerted', severity, module || ':' || code, script FROM findings WHERE id IN (SELECT value FROM json_each(?2))`,
    ).bind(stamp, JSON.stringify(all)),
    ...(Object.entries(delivered) as [Channel, string[]][]).filter(([, ids]) => ids.length).map(([c, ids]) => db.prepare(
      `UPDATE findings SET ${COLUMNS[c].sent} = ?1, ${COLUMNS[c].claim} = NULL, notified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))`,
    ).bind(stamp, JSON.stringify(ids))),
  ]);
}

/**
 * The rows of a group's digest. Cloudflare tags are set by people inside each account, so the same
 * tag says nothing about who owns the Workers once the group reaches into a second account, by the
 * tag or by the group's patterns. Tags then count for nothing, and only the patterns in Settings
 * do. That keeps one client's findings out of another's mail.
 */
function groupRows(config: Config, group: string, digests: AccountDigest[]): { rows: Row[]; ambiguous: boolean } {
  const inPatterns = (script: string) => script !== '*' && groupsFor(config, script).includes(group);
  const tagged = digests.filter((d) => [...d.tags.values()].some((t) => t.includes(group)));
  // Every Worker counts here, not only those with findings today.
  const reached = tagged.length ? digests.filter((d) => tagged.includes(d) || [...d.tags.keys(), ...d.rows.map((r) => r.script)].some(inPatterns)) : [];
  const useTags = reached.length === 1;
  const parts = digests.map((d) => ({
    d,
    rows: d.rows.filter((r) => r.script !== '*' && (inPatterns(r.script) || (useTags && (d.tags.get(r.script) ?? []).includes(group)))),
  })).filter((p) => p.rows.length);
  return {
    rows: parts.flatMap(({ d, rows }) => rows.map((r) => ({ ...r, account: parts.length > 1 ? d.label : undefined }))),
    ambiguous: tagged.length > 0 && !useTags,
  };
}

interface DigestPart {
  key: string;
  to: string[];
  /** Where it goes, for a warning. Never an address. */
  label: string;
  mail: (digests: AccountDigest[], summary: string | null) => { subject: string; body: { html: string; text: string } } | null;
}

const HASHED_PART = 'h1:';
/** More than a period's recipients: older rows are taken in rounds if there ever were more. */
const MAX_PLAIN_PARTS = 200;

export interface StoredDigestPart {
  period: string;
  part: string;
  claim_until: string | null;
  sent_at: string | null;
}

/** A record written before keys were hashed: it can name a group and a recipient. */
const isPlainPart = (part: string) => part !== 'operators' && !part.startsWith(HASHED_PART);

/**
 * Delivery records name no one: a part is stored as an HMAC of the period, its account or group and
 * the address, so removing a person never has to rename one and a record keeps counting as sent.
 * The key is the CF_API_TOKEN secret, which every scan needs and D1 does not hold, so a copy of the
 * database cannot be used to test addresses. ADMIN_PASSPHRASE stands in only where there is no token.
 * Replacing the key during an unfinished digest loses that digest's records: each client or group
 * recipient can get it once more, and never more than once, because the new key's record then counts.
 * Null: neither secret is set.
 */
async function digestPartHasher(env: Env) {
  const secret = env.CF_API_TOKEN || env.ADMIN_PASSPHRASE;
  if (!secret) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async (period: string, part: string) => {
    if (!isPlainPart(part)) return part;
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`ambersight-digest-part:${period}:${part}`));
    return `${HASHED_PART}${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  };
}

/** Records still in the older form. `full`: there may be more than these. */
export async function plainDigestParts(db: D1Database): Promise<{ rows: StoredDigestPart[]; full: boolean }> {
  const { results } = await db.prepare(
    `SELECT period, part, claim_until, sent_at FROM digest_parts WHERE part <> 'operators' AND part NOT LIKE '${HASHED_PART}%' LIMIT ?1`,
  ).bind(MAX_PLAIN_PARTS).all<StoredDigestPart>();
  return { rows: results, full: results.length === MAX_PLAIN_PARTS };
}

/**
 * Statements turning older records into hashed ones, keeping whether they were sent or claimed.
 * With no secret to hash with, no scan can run either, so nothing depends on them and they go.
 */
export async function hashDigestParts(env: Env, rows: StoredDigestPart[]): Promise<D1PreparedStatement[]> {
  if (!rows.length) return [];
  const db = env.DB;
  const hash = await digestPartHasher(env);
  const list = JSON.stringify(await Promise.all(rows.map(async (r) => ({ ...r, hashed: hash ? await hash(r.period, r.part) : null }))));
  return [
    ...(hash ? [db.prepare(
      `INSERT INTO digest_parts (period, part, claim_until, sent_at)
       SELECT json_extract(value, '$.period'), json_extract(value, '$.hashed'), json_extract(value, '$.claim_until'), json_extract(value, '$.sent_at')
       FROM json_each(?1) WHERE true
       ON CONFLICT(period, part) DO UPDATE SET
         sent_at = COALESCE(digest_parts.sent_at, excluded.sent_at),
         claim_until = COALESCE(digest_parts.claim_until, excluded.claim_until)`,
    ).bind(list)] : []),
    db.prepare(`DELETE FROM digest_parts WHERE (period, part) IN (SELECT json_extract(value, '$.period'), json_extract(value, '$.part') FROM json_each(?1))`).bind(list),
  ];
}

/**
 * The digest, as separate parts: the main digest for operators, and one message per client or
 * group address, so those recipients never see each other. Each part is claimed and recorded on
 * its own: a failed or postponed part is retried by later scans that day without repeating the
 * others. The digest counts as done only when every part went out.
 */
async function sendDigests(env: Env, now: Date, config: Config, active: AccountRow[], operators: string[], budget: SendBudget, warnings: string[]): Promise<void> {
  const db = env.DB;
  const stamp = now.toISOString();
  const settings = await getSettings(db);
  const d = config.digest;
  if (!digestDue(now, config.timeZone, d.frequency, d.weekday, d.hour, settings.last_digest_at ?? null)) return;
  const period = localTime(now, config.timeZone).date;
  const days = d.frequency === 'daily' ? 1 : d.frequency === 'monthly' ? 30 : 7;
  const periodLabel = d.frequency === 'daily' ? 'Last 24 hours' : d.frequency === 'monthly' ? 'Last 30 days' : 'This week';

  const parts: DigestPart[] = [];
  if (operators.length) {
    parts.push({
      key: 'operators', to: operators, label: 'operators',
      mail: (digests, summary) => {
        const multi = digests.length > 1;
        const rows = digests.flatMap((x) => x.rows.map((r) => ({ ...r, account: multi ? x.label : undefined })));
        return { subject: `Ambersight: ${subjectFor(rows)}`, body: renderDigest(subjectFor(rows), `Your ${d.frequency} Ambersight digest.`, digests, { periodLabel, summary, authors: config.recordAttribution }) };
      },
    });
  }
  // A client's own report, and a group's: rendered once, sent to each address separately.
  const once = <T>(make: (digests: AccountDigest[]) => T) => {
    let made: { value: T } | undefined;
    return (digests: AccountDigest[]) => (made ??= { value: make(digests) }).value;
  };
  for (const a of active) {
    const name = config.accounts[a.id]?.label ?? a.name ?? a.id;
    const mail = once((digests) => {
      const found = digests.find((x) => x.id === a.id);
      if (!found) return null;
      const dg = plainDigest(found, config);
      const title = `${quoted(dg.label)}: ${subjectFor(dg.rows)}`;
      return { subject: `Ambersight · ${title}`, body: renderDigest(title, `Your ${d.frequency} Ambersight digest for ${quoted(dg.label)}.`, [dg], { periodLabel }) };
    });
    for (const to of allowedAddresses(env, config.accounts[a.id]?.digestTo ?? [])) parts.push({ key: `account:${a.id}:${addressKey(to)}`, to: [to], label: `account ${name}`, mail });
  }
  for (const [group, list] of Object.entries(d.groupRecipients)) {
    const mail = once((digests) => {
      const { rows, ambiguous } = groupRows(config, group, digests.map((x) => plainDigest(x, config)));
      if (ambiguous) warnings.push(`The group ${quoted(group)} reaches more than one account through its Cloudflare tag or Worker patterns, so the tag was ignored for its digest. Add Worker patterns to the group in Settings to include those Workers.`);
      const title = `${quoted(group)}: ${subjectFor(rows)}`;
      return { subject: `Ambersight · ${title}`, body: render(title, `Your ${d.frequency} Ambersight digest for ${quoted(group)}.`, rows.slice(0, MAX_DIGEST_ROWS)) };
    });
    for (const to of allowedAddresses(env, list)) parts.push({ key: `group:${group}:${addressKey(to)}`, to: [to], label: `group ${group}`, mail });
  }
  // The plain keys above exist only during this run: what is stored is their hash.
  const hash = await digestPartHasher(env);
  if (!hash) throw new Error('Neither CF_API_TOKEN nor ADMIN_PASSPHRASE is set.');
  for (const p of parts) p.key = await hash(period, p.key);
  const { results: stored } = await db.prepare('SELECT period, part, claim_until, sent_at FROM digest_parts').all<StoredDigestPart>();
  // A record from before hashing still counts as sent, and stops naming anyone here.
  const upgrades = await hashDigestParts(env, stored.filter((r) => isPlainPart(r.part)));
  if (upgrades.length) await db.batch(upgrades);
  const done = new Set(await Promise.all(stored.filter((r) => r.period === period && r.sent_at).map((r) => hash(r.period, r.part))));
  const open = parts.filter((p) => !done.has(p.key));
  const finish = () => setSettings(db, { last_digest_at: stamp }).run();
  if (!open.length) {
    await finish();
    return;
  }

  // Claim what this run has room to send. Earlier digests' rows go in the same write.
  const until = new Date(now.getTime() + CLAIM_MS).toISOString();
  const wanted = open.slice(0, Math.max(0, budget.left));
  const [, claimResult] = await db.batch([
    db.prepare('DELETE FROM digest_parts WHERE period <> ?1').bind(period),
    db.prepare(
      `INSERT INTO digest_parts (period, part, claim_until)
       SELECT ?1, value, ?2 FROM json_each(?3) WHERE true
       ON CONFLICT(period, part) DO UPDATE SET claim_until = excluded.claim_until
       WHERE digest_parts.sent_at IS NULL AND (digest_parts.claim_until IS NULL OR digest_parts.claim_until <= ?4)
       RETURNING part`,
    ).bind(period, until, JSON.stringify(wanted.map((p) => p.key)), stamp),
  ]);
  const claimed = new Set((claimResult.results as { part: string }[]).map((r) => r.part));
  const mine = wanted.filter((p) => claimed.has(p.key));
  let delivered = 0;
  if (mine.length) {
    const digests = await digestData(env, now, config, days);
    // Only the operators' digest carries the summary, and the call counts as a send.
    const summary = mine.some((p) => p.key === 'operators') && config.digest.aiSummary && env.AI && spend(budget) ? await aiSummary(env, config, digests) : null;
    for (const p of mine) {
      if (!spend(budget)) break;
      try {
        const m = p.mail(digests, summary);
        if (m) await sendEmail(env, p.to, m.subject, m.body);
        await db.prepare('UPDATE digest_parts SET sent_at = ?1, claim_until = NULL WHERE period = ?2 AND part = ?3').bind(stamp, period, p.key).run();
        delivered++;
      } catch (e) {
        warnings.push(`Digest for ${p.label} failed: ${safeError((e as Error).message)}`);
      }
    }
  }
  const left = open.length - delivered;
  if (!left) await finish();
  else if (mine.length || wanted.length < open.length) warnings.push(`${n(left)} digest ${left === 1 ? 'message is' : 'messages are'} still to go out; the next scan continues.`);
}

/**
 * Maps an account ID to its display label when the install watches more than one account,
 * and to undefined otherwise, so single-account alerts look exactly as before.
 */
export function accountLabels(active: Pick<AccountRow, 'id' | 'name'>[], config: Config): (id: string | undefined) => string | undefined {
  if (active.length < 2) return () => undefined;
  const names = new Map(active.map((a) => [a.id, config.accounts[a.id]?.label ?? a.name ?? a.id]));
  return (id) => (id ? (names.get(id) ?? id) : undefined);
}

/**
 * An alert about Ambersight itself (scans failing), sent on the channel set for critical findings.
 * There is no finding behind it: a scan that fails cannot store one. True if any channel carried it,
 * so a broken webhook cannot make the e-mail repeat. With e-mail set up but no operator to send to,
 * it notes the day for Settings: no scan warning can say so while scans fail. The note changes once
 * a day at most, so failing scans repeating this write nothing.
 */
export async function sendSystemAlert(env: Env, now: Date, config: Config, message: string, action: string): Promise<boolean> {
  const route = config.alerts.critical.instant;
  if (route === 'off' || inQuietHours(now, config.timeZone, config.alerts.quietHours)) return false;
  const rows: Row[] = [{ id: 'ambersight-health', script: '*', severity: 'critical', message, action }];
  const byEmail = (route === 'email' || route === 'both') && emailReady(env);
  const operators = byEmail ? operatorAddresses(env, config, await watchedAccountIds(env, now)) : [];
  if (byEmail && !operators.length) {
    await setSettings(env.DB, { [SYSTEM_ALERT_UNDELIVERED]: now.toISOString().slice(0, 10) }).run().catch((e: Error) => console.error(safeError(e.message)));
  }
  let sent = false;
  if (operators.length) {
    try {
      await sendEmail(env, operators, 'Ambersight: scans are failing', render('Scans are failing', 'Ambersight cannot read your account.', rows));
      sent = true;
    } catch (e) {
      console.error(safeError((e as Error).message));
    }
  }
  if ((route === 'webhook' || route === 'both') && env.WEBHOOK_URL) {
    try {
      await sendWebhook(env.WEBHOOK_URL, 'Ambersight: scans are failing', rows);
      sent = true;
    } catch (e) {
      console.error(safeError((e as Error).message));
    }
  }
  return sent;
}

/**
 * The notice about a change made from the dashboard (adminNotice.ts). Deliberately not routed by
 * severity and not held for quiet hours: the session that made the change can set both. True if
 * any channel carried it.
 */
export async function sendAdminNotice(env: Env, to: string[], rows: Row[], more = 0): Promise<boolean> {
  const title = 'Detection or access settings changed';
  let sent = false;
  if (to.length && emailReady(env)) {
    try {
      const intro = `Made from a dashboard session. If it was you, there is nothing to do.${more ? ` ${n(more)} more follow in the next notice.` : ''}`;
      await sendEmail(env, to, `Ambersight: ${title.toLowerCase()}`, render(title, intro, rows));
      sent = true;
    } catch (e) {
      console.error(safeError((e as Error).message));
    }
  }
  if (env.WEBHOOK_URL) {
    try {
      await sendWebhook(env.WEBHOOK_URL, `Ambersight: ${title.toLowerCase()}`, rows, 'Made from a dashboard session. If it was you, there is nothing to do.', more);
      sent = true;
    } catch (e) {
      console.error(safeError((e as Error).message));
    }
  }
  return sent;
}

/** Settings › Test message. E-mail goes to the operators, like the alerts it stands in for. */
export async function sendTest(env: Env, channel: Channel, config: Config): Promise<void> {
  const rows: Row[] = [{ id: 'test', script: '*', severity: 'info', message: 'This is a test message from Ambersight.', action: 'Nothing to do. Alerts will arrive here.' }];
  if (channel === 'email') {
    if (!emailReady(env)) throw new Error('E-mail is not configured: set EMAIL_FROM, DIGEST_TO and the send_email binding in wrangler.jsonc.');
    const operators = operatorAddresses(env, config, await watchedAccountIds(env));
    if (!operators.length) throw new Error(NO_OPERATOR);
    await sendEmail(env, operators, 'Ambersight: test message', render('Test message', 'E-mail alerts work.', rows));
  } else {
    if (!env.WEBHOOK_URL) throw new Error('No webhook configured: add the WEBHOOK_URL secret.');
    await sendWebhook(env.WEBHOOK_URL, 'Ambersight: test message', rows);
  }
}
