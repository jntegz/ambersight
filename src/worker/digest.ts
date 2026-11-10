// The digest e-mail and the client report: one summary per account with open findings, free
// limit headroom, biggest movers, the estimated bill, deploys and fleet changes. Everything for
// every account comes from one D1 batch, which D1 counts as a single query.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope, type Config } from '../shared/config';
import { FREE_DAILY, type QuotaMetric, type StorageKind } from '../shared/limits';
import type { Severity } from '../shared/types';
import { estimate } from './cost';
import { isoHour, planFrom, utcMidnight } from './db';
import type { Env } from './env';
import { esc, evidenceText, FONT, label, n, type Row } from './notify';

const DAY = 86_400_000;
const MAX_ROWS = 25;

export interface AccountDigest {
  id: string;
  label: string;
  plan: 'free' | 'paid';
  rows: Row[];
  requests: number;
  errors: number;
  added: string[];
  removed: string[];
  deploys: { script: string; created_on: string; author: string | null }[];
  /** Highest daily share of each free limit in the period, Free plan only, largest first. */
  headroom: { label: string; peak: number }[];
  /** Workers whose requests changed most against the period before. */
  movers: { name: string; now: number; before: number }[];
  cost: { monthToDate: number; forecast: number } | null;
  cfAlerts: number;
  /** Worker name -> Cloudflare tags, for per-group digests. */
  tags: Map<string, string[]>;
}

/** Digest data for the given accounts (all watched accounts when omitted), over the last `days`. */
export async function digestData(env: Env, now: Date, config: Config, days: number, only?: string[]): Promise<AccountDigest[]> {
  const db = env.DB;
  const since = new Date(now.getTime() - days * DAY);
  const before = new Date(since.getTime() - days * DAY);
  const monthStart = isoHour(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const sevs = (['critical', 'warning', 'info'] as const).filter((s) => config.alerts[s].digest);
  const accountsR = await db.prepare('SELECT id, name, detected_plan FROM accounts WHERE enabled = 1 ORDER BY added_at, id').all<{ id: string; name: string | null; detected_plan: string | null }>();
  const accounts = accountsR.results.filter((a) => !only || only.includes(a.id));
  // Installs from before multi-account support may have findings under "" until the first scan.
  const ids = JSON.stringify(accounts.length ? accounts.map((a) => a.id) : ['']);
  const [findings, totals, events, deploys, workers, quota, movers, month, storage, alerts] = await db.batch([
    db.prepare(
      `SELECT id, account, script, severity, message, action, evidence FROM findings
       WHERE status = 'open' AND account IN (SELECT value FROM json_each(?1)) AND severity IN (SELECT value FROM json_each(?2))
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_seen DESC LIMIT 500`,
    ).bind(ids, JSON.stringify(sevs)),
    db.prepare(
      `SELECT account, COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors FROM metrics_hourly
       WHERE hour >= ?2 AND account IN (SELECT value FROM json_each(?1)) GROUP BY account`,
    ).bind(ids, isoHour(since)),
    db.prepare(`SELECT account, kind, script FROM fleet_events WHERE at >= ?2 AND kind IN ('added','removed') AND account IN (SELECT value FROM json_each(?1)) ORDER BY at`).bind(ids, since.toISOString()),
    db.prepare(`SELECT account, script, created_on, author FROM deployments WHERE created_on >= ?2 AND account IN (SELECT value FROM json_each(?1)) ORDER BY created_on DESC LIMIT 200`).bind(ids, since.toISOString()),
    db.prepare(`SELECT account, name, tags FROM workers WHERE account IN (SELECT value FROM json_each(?1))`).bind(ids),
    db.prepare(
      `SELECT account, metric, substr(hour, 1, 10) AS day, SUM(value) AS v FROM quota_hourly
       WHERE hour >= ?2 AND account IN (SELECT value FROM json_each(?1)) GROUP BY account, metric, day`,
    ).bind(ids, isoHour(utcMidnight(since))),
    db.prepare(
      `SELECT account, script, SUM(CASE WHEN hour >= ?2 THEN requests ELSE 0 END) AS now, SUM(CASE WHEN hour < ?2 THEN requests ELSE 0 END) AS before
       FROM metrics_hourly WHERE hour >= ?3 AND account IN (SELECT value FROM json_each(?1)) GROUP BY account, script`,
    ).bind(ids, isoHour(since), isoHour(before)),
    db.prepare(
      `SELECT account, metric, SUM(value) AS v, MIN(hour) AS first FROM quota_hourly
       WHERE hour >= ?2 AND account IN (SELECT value FROM json_each(?1)) GROUP BY account, metric`,
    ).bind(ids, monthStart),
    db.prepare(`SELECT account, kind, SUM(bytes) AS bytes FROM storage_sizes WHERE account IN (SELECT value FROM json_each(?1)) GROUP BY account, kind`).bind(ids),
    db.prepare(`SELECT account, COUNT(*) AS n FROM cf_alerts WHERE sent >= ?2 AND account IN (SELECT value FROM json_each(?1)) GROUP BY account`).bind(ids, since.toISOString()),
  ]);
  const by = <T extends { account: string }>(rows: unknown[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows as T[]) m.set(r.account, [...(m.get(r.account) ?? []), r]);
    return m;
  };
  const F = by<Row & { account: string }>(findings.results);
  const T = new Map((totals.results as { account: string; requests: number; errors: number }[]).map((r) => [r.account, r]));
  const E = by<{ account: string; kind: string; script: string }>(events.results);
  const D = by<{ account: string; script: string; created_on: string; author: string | null }>(deploys.results);
  const W = by<{ account: string; name: string; tags: string | null }>(workers.results);
  const Q = by<{ account: string; metric: QuotaMetric; day: string; v: number }>(quota.results);
  const M = by<{ account: string; script: string; now: number; before: number }>(movers.results);
  const MT = by<{ account: string; metric: QuotaMetric; v: number; first: string }>(month.results);
  const S = by<{ account: string; kind: StorageKind; bytes: number }>(storage.results);
  const A = new Map((alerts.results as { account: string; n: number }[]).map((r) => [r.account, r.n]));
  const list = accounts.length ? accounts : [{ id: '', name: null, detected_plan: null }];
  return list.map((a) => {
    const plan = planFrom(config, a.detected_plan, env.PLAN, a.id);
    const tags = new Map((W.get(a.id) ?? []).map((w) => [w.name, w.tags ? (JSON.parse(w.tags) as string[]) : []]));
    const visible = (script: string) => script === '*' || !tags.has(script) || inScope(config, script, groupsFor(config, script, tags.get(script)));
    const peaks = new Map<QuotaMetric, number>();
    for (const r of Q.get(a.id) ?? []) peaks.set(r.metric, Math.max(peaks.get(r.metric) ?? 0, r.v));
    const headroom = plan === 'free'
      ? FREE_DAILY.filter((q) => peaks.has(q.metric)).map((q) => ({ label: q.label, peak: peaks.get(q.metric)! / q.limit })).filter((h) => h.peak >= 0.2).sort((x, y) => y.peak - x.peak)
      : [];
    const moved = (M.get(a.id) ?? [])
      .filter((m) => visible(m.script) && Math.max(m.now, m.before) >= 1_000 && m.before > 0)
      .map((m) => ({ name: m.script, now: m.now, before: m.before }))
      .filter((m) => m.now >= m.before * 2 || m.now <= m.before / 2)
      .sort((x, y) => Math.abs(Math.log(y.now / y.before)) - Math.abs(Math.log(x.now / x.before)))
      .slice(0, 5);
    let cost: AccountDigest['cost'] = null;
    if (plan === 'paid' && config.modules.cost) {
      const mt = MT.get(a.id) ?? [];
      const e = estimate(now, Object.fromEntries(mt.map((r) => [r.metric, r.v])), Object.fromEntries((S.get(a.id) ?? []).map((r) => [r.kind, r.bytes])), [], mt.reduce<string | null>((m, r) => (!m || r.first < m ? r.first : m), null));
      cost = { monthToDate: e.monthToDate, forecast: e.forecast };
    }
    const ev = E.get(a.id) ?? [];
    return {
      id: a.id,
      label: config.accounts[a.id]?.label ?? a.name ?? a.id,
      plan,
      rows: (F.get(a.id) ?? []).filter((r) => visible(r.script)),
      requests: T.get(a.id)?.requests ?? 0,
      errors: T.get(a.id)?.errors ?? 0,
      added: ev.filter((e) => e.kind === 'added').map((e) => e.script),
      removed: ev.filter((e) => e.kind === 'removed').map((e) => e.script),
      deploys: (D.get(a.id) ?? []).filter((d) => visible(d.script)),
      headroom,
      movers: moved,
      cost,
      cfAlerts: A.get(a.id) ?? 0,
      tags,
    };
  });
}

/** "3 Workers need attention", over the rows of one or more accounts. */
export function subjectFor(rows: Row[]): string {
  const workers = new Set(rows.filter((r) => r.script !== '*').map((r) => `${r.account ?? ''}|${r.script}`)).size;
  const k = workers || rows.length;
  return rows.length ? `${k} ${k === 1 ? 'Worker needs' : 'Workers need'} attention` : 'All Workers look healthy';
}

const usd = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctText = (x: number) => `${Math.round(x * 100)}%`;
const ratio = (now: number, before: number) => (now >= before ? `${(now / before).toFixed(1)}x up` : `${(before / Math.max(1, now)).toFixed(1)}x down`);

/**
 * HTML and text for a digest or a report. `periodLabel` is "This week", "Today" or "Last 30 days".
 * With several accounts, each gets its own section.
 */
export function renderDigest(
  title: string, intro: string, digests: AccountDigest[],
  opts: { periodLabel: string; summary?: string | null; report?: boolean } ,
): { html: string; text: string } {
  const multi = digests.length > 1;
  const H = (h: string) => `<tr><td style="font:600 15px/22px ${FONT};color:#2B211B;padding-top:20px">${h}</td></tr>`;
  const P = (body: string) => `<tr><td style="font:400 14px/22px ${FONT};color:#2B211B">${body}</td></tr>`;
  const html: string[] = [];
  const text: string[] = [title, intro, ''];
  if (opts.summary) {
    html.push(`<tr><td style="font:400 15px/23px ${FONT};color:#2B211B;background:#FBF1E6;border-radius:10px;padding:14px 16px">${esc(opts.summary)}<div style="font:400 12px/18px ${FONT};color:#6E6259;padding-top:6px">Summary written by Workers AI from the findings below.</div></td></tr>`);
    text.push(opts.summary, '');
  }
  for (const d of digests) {
    if (multi) {
      html.push(`<tr><td style="font:600 18px/26px ${FONT};color:#2B211B;padding-top:28px;border-bottom:2px solid #EADFD5">${esc(d.label)}</td></tr>`);
      text.push(`== ${d.label} ==`);
    }
    const rows = d.rows.slice(0, MAX_ROWS);
    html.push(...rows.map((r) => `<tr><td style="padding:12px 0;border-bottom:1px solid #EADFD5">
        <div style="font:600 14px/20px ${FONT};color:${r.severity === 'critical' ? '#C2361B' : r.severity === 'warning' ? '#B3440B' : '#6E6259'}">${label(r.severity as Severity)} · ${esc(r.script === '*' ? 'Account' : r.script)}</div>
        <div style="font:400 15px/22px ${FONT};color:#2B211B">${esc(r.message)}</div>
        <div style="font:400 13px/20px ${FONT};color:#6E6259">${esc(r.action)}</div>
        ${r.evidence ? `<div style="font:400 12px/18px ${FONT};color:#6E6259">${esc(evidenceText(r.evidence))}</div>` : ''}</td></tr>`));
    if (!rows.length) html.push(P('No open findings.'));
    if (d.rows.length > rows.length) html.push(P(`<span style="color:#6E6259">And ${n(d.rows.length - rows.length)} more in the dashboard.</span>`));
    text.push(...(rows.length ? rows.map((r) => `[${r.severity}] ${r.script === '*' ? 'Account' : r.script}: ${r.message}\n  ${r.action}`) : ['No open findings.']));

    html.push(H(opts.periodLabel), P(`${n(d.requests)} requests · ${n(d.errors)} errors${d.cfAlerts ? ` · ${n(d.cfAlerts)} Cloudflare notification${d.cfAlerts === 1 ? '' : 's'}` : ''}`));
    text.push('', `${opts.periodLabel}: ${n(d.requests)} requests, ${n(d.errors)} errors`);
    if (d.cost) {
      html.push(H('Estimated bill'), P(`${usd(d.cost.monthToDate)} so far this month, about ${usd(d.cost.forecast)} by month end at list prices.`));
      text.push(`Estimated bill: ${usd(d.cost.monthToDate)} so far, about ${usd(d.cost.forecast)} by month end`);
    }
    if (d.headroom.length) {
      html.push(H('Free plan limits, busiest day'), P(d.headroom.map((h) => `${esc(h.label)}: <strong>${pctText(h.peak)}</strong>`).join('<br>')));
      text.push('Free plan limits, busiest day:', ...d.headroom.map((h) => `  ${h.label}: ${pctText(h.peak)}`));
    }
    if (d.movers.length) {
      html.push(H('Biggest changes in traffic'), P(d.movers.map((m) => `${esc(m.name)}: ${n(m.now)} requests, ${ratio(m.now, m.before)}`).join('<br>')));
      text.push('Biggest changes in traffic:', ...d.movers.map((m) => `  ${m.name}: ${n(m.now)} requests, ${ratio(m.now, m.before)}`));
    }
    if (d.added.length || d.removed.length) {
      html.push(H('Fleet changes'), P([...d.added.map((s) => `+ ${esc(s)}`), ...d.removed.map((s) => `− ${esc(s)}`)].join('<br>')));
      text.push(...d.added.map((s) => `+ ${s}`), ...d.removed.map((s) => `- ${s}`));
    }
    if (d.deploys.length) {
      html.push(H(`Deploys (${d.deploys.length})`), P(d.deploys.slice(0, 15).map((x) => `${esc(x.created_on.slice(0, 16).replace('T', ' '))} UTC · ${esc(x.script)}${x.author ? ` · ${esc(x.author)}` : ''}`).join('<br>')));
      text.push(`Deploys: ${d.deploys.length}`);
    }
    text.push('');
  }
  const foot = opts.report
    ? 'Prepared by Ambersight, a read-only monitor running in this Cloudflare account. Costs are estimates at list prices.'
    : 'Sent by your Ambersight Worker. Read-only, running in your own Cloudflare account.';
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
    <style>@media print { body { padding: 0 !important; } @page { margin: 16mm; } }</style></head>
    <body style="margin:0;background:#FFFCF8;padding:24px">
    <table role="presentation" width="100%" style="max-width:640px;margin:0 auto;border-collapse:collapse">
    <tr><td style="font:600 20px/28px ${FONT};color:#2B211B;padding-bottom:4px">${esc(title)}</td></tr>
    <tr><td style="font:400 14px/20px ${FONT};color:#6E6259;padding-bottom:12px">${esc(intro)}</td></tr>
    ${html.join('')}
    <tr><td style="font:400 12px/18px ${FONT};color:#6E6259;padding-top:16px">${foot}</td></tr>
    </table></body></html>`;
  return { html: page, text: text.join('\n') };
}

/**
 * A few plain sentences on what to fix first, from Workers AI (optional AI binding). Only the
 * findings' text is sent, and Workers AI runs inside Cloudflare. Any failure skips the summary.
 */
export async function aiSummary(env: Env, config: Config, digests: AccountDigest[]): Promise<string | null> {
  if (!config.digest.aiSummary || !env.AI) return null;
  const rows = digests.flatMap((d) => d.rows.slice(0, 15).map((r) => `${digests.length > 1 ? `${d.label} / ` : ''}${r.severity} / ${r.script === '*' ? 'account' : r.script}: ${r.message}`));
  if (!rows.length) return null;
  try {
    const out = (await env.AI.run(config.digest.aiModel, {
      max_tokens: 220,
      messages: [
        { role: 'system', content: 'You summarise monitoring findings for a busy developer. Write 2 to 4 short plain sentences: what is most urgent and what to do first. No lists, no markdown, no greetings, no em dashes. Do not invent facts that are not in the findings.' },
        { role: 'user', content: rows.slice(0, 40).join('\n') },
      ],
    })) as { response?: string };
    const text = (out.response ?? '').replace(/\s+/g, ' ').replace(/—/g, ',').trim();
    return text ? text.slice(0, 800) : null;
  } catch {
    return null;
  }
}
