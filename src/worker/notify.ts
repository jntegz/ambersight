// Instant alerts for critical findings and the weekly digest, via the send_email binding.
// The recipient comes only from configuration; no endpoint accepts an address.
// SPDX-License-Identifier: AGPL-3.0-only

import { getSettings, setSettings } from './db';
import type { Env } from './env';

const DAY = 86_400_000;

interface Row {
  id: string;
  script: string;
  severity: string;
  message: string;
  action: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function render(title: string, intro: string, rows: Row[]): { html: string; text: string } {
  const items = rows
    .map(
      (r) => `<tr><td style="padding:12px 0;border-bottom:1px solid #EADFD5">
        <div style="font:600 14px/20px Inter,Arial,sans-serif;color:${r.severity === 'critical' ? '#C2361B' : '#B3440B'}">${r.severity === 'critical' ? 'Critical' : r.severity === 'warning' ? 'Warning' : 'Info'} · ${esc(r.script === '*' ? 'Account' : r.script)}</div>
        <div style="font:400 15px/22px Inter,Arial,sans-serif;color:#2B211B">${esc(r.message)}</div>
        <div style="font:400 13px/20px Inter,Arial,sans-serif;color:#6E6259">${esc(r.action)}</div></td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#FFFCF8;padding:24px">
    <table role="presentation" width="100%" style="max-width:600px;margin:0 auto">
    <tr><td style="font:600 20px/28px Inter,Arial,sans-serif;color:#2B211B;padding-bottom:4px">${esc(title)}</td></tr>
    <tr><td style="font:400 14px/20px Inter,Arial,sans-serif;color:#6E6259;padding-bottom:12px">${esc(intro)}</td></tr>
    ${items}
    <tr><td style="font:400 12px/18px Inter,Arial,sans-serif;color:#6E6259;padding-top:16px">Sent by your Ambersight Worker. Read-only, running in your own Cloudflare account.</td></tr>
    </table></body></html>`;
  const text = [title, intro, '', ...rows.map((r) => `[${r.severity}] ${r.script === '*' ? 'Account' : r.script}: ${r.message}\n  ${r.action}`)].join('\n');
  return { html, text };
}

export async function sendAlerts(env: Env, now: Date): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.DIGEST_TO) return;
  const db = env.DB;
  const stamp = now.toISOString();
  const to = env.DIGEST_TO.split(',').map((s) => s.trim()).filter(Boolean);

  // Instant: open critical findings never sent, or sent more than 24 h ago and still open.
  const { results: critical } = await db
    .prepare(
      `SELECT id, script, severity, message, action FROM findings
       WHERE status = 'open' AND severity = 'critical' AND (notified_at IS NULL OR notified_at < ?1)`,
    )
    .bind(new Date(now.getTime() - DAY).toISOString())
    .all<Row>();
  if (critical.length) {
    const { html, text } = render(
      `${critical.length} critical ${critical.length === 1 ? 'finding' : 'findings'} in your Workers`,
      'Ambersight found something that needs attention now.',
      critical,
    );
    await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject: `Ambersight: ${critical.length} critical`, html, text });
    await db
      .prepare(`UPDATE findings SET notified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))`)
      .bind(stamp, JSON.stringify(critical.map((c) => c.id)))
      .run();
  }

  // Weekly digest: Mondays at 08:00 UTC, at most once every 6 days.
  const settings = await getSettings(db);
  const lastDigest = settings.last_digest_at ? new Date(settings.last_digest_at).getTime() : 0;
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 8 || now.getTime() - lastDigest < 6 * DAY) return;
  const { results: open } = await db
    .prepare(
      `SELECT id, script, severity, message, action FROM findings WHERE status = 'open'
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 15`,
    )
    .all<Row>();
  const subject = open.length ? `${open.length} ${open.length === 1 ? 'Worker needs' : 'findings need'} attention` : 'All Workers look healthy';
  const { html, text } = render(subject, 'Your weekly Ambersight digest.', open);
  await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject: `Ambersight: ${subject}`, html, text });
  await setSettings(db, { last_digest_at: stamp }).run();
}
