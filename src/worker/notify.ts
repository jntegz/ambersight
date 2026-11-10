// Instant alerts and the digest, by e-mail (send_email binding) and/or webhook.
// Recipients come only from configuration; no endpoint accepts an address or a URL.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, type Config } from '../shared/config';
import type { Severity } from '../shared/types';
import { getSettings, isoHour, setSettings } from './db';
import type { Env } from './env';
import { allowedFetch } from './net';
import { digestDue, inQuietHours } from './time';

const DAY = 86_400_000;
const MAX_DIGEST_ROWS = 25;

interface Row {
  id: string;
  script: string;
  severity: Severity;
  message: string;
  action: string;
  evidence?: string;
}

export interface DigestExtras {
  requests: number;
  errors: number;
  added: string[];
  removed: string[];
  deploys: { script: string; created_on: string; author: string | null }[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const label = (s: Severity) => (s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Info');
const who = (script: string) => (script === '*' ? 'Account' : script);
const n = (x: number) => x.toLocaleString('en-US');
const FONT = 'Inter,Arial,sans-serif';

function evidenceText(e?: string): string {
  if (!e) return '';
  try {
    return Object.entries(JSON.parse(e) as Record<string, unknown>)
      .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${typeof v === 'number' ? n(v) : v}`)
      .join(' · ');
  } catch {
    return '';
  }
}

export function render(title: string, intro: string, rows: Row[], extras?: DigestExtras): { html: string; text: string } {
  const items = rows
    .map(
      (r) => `<tr><td style="padding:12px 0;border-bottom:1px solid #EADFD5">
        <div style="font:600 14px/20px ${FONT};color:${r.severity === 'critical' ? '#C2361B' : r.severity === 'warning' ? '#B3440B' : '#6E6259'}">${label(r.severity)} · ${esc(who(r.script))}</div>
        <div style="font:400 15px/22px ${FONT};color:#2B211B">${esc(r.message)}</div>
        <div style="font:400 13px/20px ${FONT};color:#6E6259">${esc(r.action)}</div>
        ${r.evidence ? `<div style="font:400 12px/18px ${FONT};color:#6E6259">${esc(evidenceText(r.evidence))}</div>` : ''}</td></tr>`,
    )
    .join('');
  const section = (h: string, body: string) =>
    `<tr><td style="font:600 15px/22px ${FONT};color:#2B211B;padding-top:20px">${h}</td></tr><tr><td style="font:400 14px/22px ${FONT};color:#2B211B">${body}</td></tr>`;
  const ex = extras
    ? [
        section('This week', `${n(extras.requests)} requests · ${n(extras.errors)} errors`),
        extras.added.length || extras.removed.length
          ? section('Fleet changes', [
              ...extras.added.map((s) => `+ ${esc(s)}`),
              ...extras.removed.map((s) => `− ${esc(s)}`),
            ].join('<br>'))
          : '',
        extras.deploys.length
          ? section(`Deploys (${extras.deploys.length})`, extras.deploys.slice(0, 15).map((d) => `${esc(d.created_on.slice(0, 16).replace('T', ' '))} UTC · ${esc(d.script)}${d.author ? ` · ${esc(d.author)}` : ''}`).join('<br>'))
          : '',
      ].join('')
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#FFFCF8;padding:24px">
    <table role="presentation" width="100%" style="max-width:600px;margin:0 auto">
    <tr><td style="font:600 20px/28px ${FONT};color:#2B211B;padding-bottom:4px">${esc(title)}</td></tr>
    <tr><td style="font:400 14px/20px ${FONT};color:#6E6259;padding-bottom:12px">${esc(intro)}</td></tr>
    ${items}${ex}
    <tr><td style="font:400 12px/18px ${FONT};color:#6E6259;padding-top:16px">Sent by your Ambersight Worker. Read-only, running in your own Cloudflare account.</td></tr>
    </table></body></html>`;
  const text = [
    title, intro, '',
    ...rows.map((r) => `[${r.severity}] ${who(r.script)}: ${r.message}\n  ${r.action}`),
    ...(extras
      ? [
          '', `This week: ${n(extras.requests)} requests, ${n(extras.errors)} errors`,
          ...extras.added.map((s) => `+ ${s}`), ...extras.removed.map((s) => `- ${s}`),
          ...(extras.deploys.length ? ['', `Deploys: ${extras.deploys.length}`] : []),
        ]
      : []),
  ].join('\n');
  return { html, text };
}

export function webhookKind(url: string): 'slack' | 'discord' | 'telegram' | 'ntfy' | 'json' {
  const h = new URL(url).hostname;
  if (h === 'hooks.slack.com') return 'slack';
  if (h === 'discord.com' || h === 'discordapp.com') return 'discord';
  if (h === 'api.telegram.org') return 'telegram';
  if (h === 'ntfy.sh' || h.startsWith('ntfy.')) return 'ntfy';
  return 'json';
}

export async function sendWebhook(url: string, title: string, rows: Row[]): Promise<void> {
  const lines = rows.slice(0, 20).map((r) => `• [${label(r.severity)}] ${who(r.script)}: ${r.message}`);
  const text = [title, ...lines].join('\n').slice(0, 3900);
  const kind = webhookKind(url);
  const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const init: RequestInit =
    kind === 'slack' ? json({ text })
    : kind === 'discord' ? json({ content: text.slice(0, 1900) })
    : kind === 'telegram' ? json({ chat_id: new URL(url).searchParams.get('chat_id'), text })
    : kind === 'ntfy' ? { method: 'POST', headers: { Title: title.slice(0, 200) }, body: lines.join('\n') || title }
    : json({ title, findings: rows.map((r) => ({ id: r.id, worker: r.script, severity: r.severity, message: r.message, action: r.action })) });
  const res = await allowedFetch(url, init, url);
  if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
}

function recipients(env: Env): string[] {
  return (env.DIGEST_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const emailReady = (env: Env) => Boolean(env.EMAIL && env.EMAIL_FROM && recipients(env).length);

async function sendEmail(env: Env, to: string[], subject: string, body: { html: string; text: string }) {
  await env.EMAIL!.send({ to, from: env.EMAIL_FROM!, subject, ...body });
}

export async function sendAlerts(env: Env, now: Date, config: Config): Promise<void> {
  const db = env.DB;
  const stamp = now.toISOString();
  const canEmail = emailReady(env);
  const canHook = Boolean(env.WEBHOOK_URL);
  if (!canEmail && !canHook) return;

  // Instant: open findings never sent, or sent more than 24 h ago and still open.
  const sevs = (['critical', 'warning', 'info'] as const).filter((s) => config.alerts[s].instant !== 'off');
  if (sevs.length && !inQuietHours(now, config.timeZone, config.alerts.quietHours)) {
    const { results } = await db
      .prepare(
        `SELECT id, script, severity, message, action, evidence FROM findings
         WHERE status = 'open' AND severity IN (SELECT value FROM json_each(?2)) AND (notified_at IS NULL OR notified_at < ?1)
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 50`,
      )
      .bind(new Date(now.getTime() - DAY).toISOString(), JSON.stringify(sevs))
      .all<Row>();
    const viaEmail = results.filter((r) => ['email', 'both'].includes(config.alerts[r.severity].instant));
    const viaHook = results.filter((r) => ['webhook', 'both'].includes(config.alerts[r.severity].instant));
    const sent: string[] = [];
    const crit = (rows: Row[]) => rows.filter((r) => r.severity === 'critical').length;
    const title = (rows: Row[]) =>
      crit(rows) ? `${crit(rows)} critical ${crit(rows) === 1 ? 'finding' : 'findings'} in your Workers` : `${rows.length} new ${rows.length === 1 ? 'finding' : 'findings'} in your Workers`;
    if (canEmail && viaEmail.length) {
      await sendEmail(env, recipients(env), `Ambersight: ${title(viaEmail)}`, render(title(viaEmail), 'Ambersight found something that needs attention.', viaEmail));
      sent.push(...viaEmail.map((r) => r.id));
    }
    if (canHook && viaHook.length) {
      await sendWebhook(env.WEBHOOK_URL!, `Ambersight: ${title(viaHook)}`, viaHook);
      sent.push(...viaHook.map((r) => r.id));
    }
    if (sent.length) {
      await db.prepare(`UPDATE findings SET notified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))`).bind(stamp, JSON.stringify([...new Set(sent)])).run();
    }
  }

  // Digest.
  if (!canEmail) return;
  const settings = await getSettings(db);
  const d = config.digest;
  if (!digestDue(now, config.timeZone, d.frequency, d.weekday, d.hour, settings.last_digest_at ?? null)) return;
  const { rows, extras, tags } = await digestData(db, now, config, d.frequency === 'daily' ? 1 : 7);
  const period = d.frequency === 'daily' ? 'daily' : 'weekly';
  const to = recipients(env);
  const subject = (list: Row[]) => {
    const workers = new Set(list.filter((r) => r.script !== '*').map((r) => r.script)).size;
    return list.length ? `${workers || list.length} ${(workers || list.length) === 1 ? 'Worker needs' : 'Workers need'} attention` : 'All Workers look healthy';
  };
  await sendEmail(env, to, `Ambersight: ${subject(rows)}`, render(subject(rows), `Your ${period} Ambersight digest.`, rows.slice(0, MAX_DIGEST_ROWS), extras));

  // Per-group digests (agency use): only to addresses that are also allowed in DIGEST_TO.
  for (const [group, list] of Object.entries(d.groupRecipients)) {
    const allowed = list.filter((a) => to.includes(a));
    if (!allowed.length) continue;
    const mine = rows.filter((r) => r.script !== '*' && groupsFor(config, r.script, tags.get(r.script) ?? []).includes(group));
    await sendEmail(env, allowed, `Ambersight · ${group}: ${subject(mine)}`, render(`${group}: ${subject(mine)}`, `Your ${period} Ambersight digest for ${group}.`, mine.slice(0, MAX_DIGEST_ROWS)));
  }
  await setSettings(db, { last_digest_at: stamp }).run();
}

async function digestData(db: D1Database, now: Date, config: Config, days: number) {
  const since = new Date(now.getTime() - days * DAY);
  const sevs = (['critical', 'warning', 'info'] as const).filter((s) => config.alerts[s].digest);
  const [findings, totals, events, deploys, workers] = await db.batch([
    db.prepare(
      `SELECT id, script, severity, message, action, evidence FROM findings WHERE status = 'open' AND severity IN (SELECT value FROM json_each(?1))
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_seen DESC LIMIT 100`,
    ).bind(JSON.stringify(sevs)),
    db.prepare('SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors FROM metrics_hourly WHERE hour >= ?1').bind(isoHour(since)),
    db.prepare('SELECT kind, script FROM fleet_events WHERE at >= ?1 ORDER BY at').bind(since.toISOString()),
    db.prepare('SELECT script, created_on, author FROM deployments WHERE created_on >= ?1 ORDER BY created_on DESC LIMIT 50').bind(since.toISOString()),
    db.prepare('SELECT name, tags FROM workers'),
  ]);
  const t = totals.results[0] as { requests: number; errors: number };
  const ev = events.results as { kind: string; script: string }[];
  return {
    rows: findings.results as unknown as Row[],
    extras: {
      requests: t.requests,
      errors: t.errors,
      added: ev.filter((e) => e.kind === 'added').map((e) => e.script),
      removed: ev.filter((e) => e.kind === 'removed').map((e) => e.script),
      deploys: deploys.results as DigestExtras['deploys'],
    },
    tags: new Map((workers.results as { name: string; tags: string | null }[]).map((w) => [w.name, w.tags ? (JSON.parse(w.tags) as string[]) : []])),
  };
}

/** Settings › Test message. */
export async function sendTest(env: Env, channel: 'email' | 'webhook'): Promise<void> {
  const rows: Row[] = [{ id: 'test', script: '*', severity: 'info', message: 'This is a test message from Ambersight.', action: 'Nothing to do. Alerts will arrive here.' }];
  if (channel === 'email') {
    if (!emailReady(env)) throw new Error('E-mail is not configured: set EMAIL_FROM, DIGEST_TO and the send_email binding in wrangler.jsonc.');
    await sendEmail(env, recipients(env), 'Ambersight: test message', render('Test message', 'E-mail alerts work.', rows));
  } else {
    if (!env.WEBHOOK_URL) throw new Error('No webhook configured: add the WEBHOOK_URL secret.');
    await sendWebhook(env.WEBHOOK_URL, 'Ambersight: test message', rows);
  }
}
