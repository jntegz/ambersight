// Tells the operators when someone with a dashboard session reduced detection or changed access.
// The point is to reach them even if that session is not theirs, so nothing here reads the alert
// routes or quiet hours, which the same session can change: it goes to every channel the deployment
// configured. Notices are grouped: the first goes out at once, and whatever follows within the
// cooldown waits for the scheduled run, so reconfiguring produces one message and not twenty.
// SPDX-License-Identifier: AGPL-3.0-only

import { adminActionLabel } from '../shared/adminLog';
import type { Config } from '../shared/config';
import { claimCooldown, configFrom, getSettings } from './db';
import type { Env } from './env';
import { emailReady, operatorAddresses, recipients, sendAdminNotice, watchedAccountIds, type Row } from './notify';

const HOUR = 3_600_000;
export const NOTICE_COOLDOWN_MS = HOUR / 2;
/** A notice no channel has accepted for this long is given up on; the log still shows it. */
const GIVE_UP_MS = 24 * HOUR;
const MAX_ROWS = 20;
const COOLDOWN_KEY = 'cooldown:admin-notice';

function storedAudience(value: string | undefined): string[] {
  try {
    const list = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Who hears about a change: the operators under each given config, plus anyone still waiting for a
 * notice. A save that names an operator as a client recipient takes them off the operator list, so
 * the list from before the save counts too. Every address is still one DIGEST_TO allows.
 */
export function noticeAudience(env: Env, configs: Config[], stored?: string, watched: readonly string[] = []): string[] {
  if (!emailReady(env)) return [];
  const allowed = new Set(configs.flatMap((c) => operatorAddresses(env, c, watched)));
  const everyone = recipients(env);
  for (const a of storedAudience(stored)) if (everyone.includes(a)) allowed.add(a);
  return [...allowed];
}

interface Pending { id: number; at: string; action: string; target: string; actor: string; count: number }

const rowOf = (e: Pending): Row => ({
  id: `admin-${e.id}`,
  script: '*',
  severity: 'warning',
  message: `${adminActionLabel(e.action)}${e.target ? `: ${e.target}` : ''}${e.count > 1 ? ` (${e.count} times)` : ''}. By ${e.actor} at ${e.at.slice(0, 16).replace('T', ' ')} UTC.`,
  action: 'If this was not you, sign in, undo it, and end every other session in Settings › Security. If a passkey was added that is not yours, remove it there; if you cannot sign in, replace the ADMIN_PASSPHRASE secret in Cloudflare, which ends every session and lets you recover.',
});

/** Sends what is waiting, at most once per cooldown. Never throws for a failed channel. */
export async function deliverAdminNotices(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  const settings = await getSettings(db);
  if (settings.admin_notice_pending !== '1') return;
  if (!(await claimCooldown(db, COOLDOWN_KEY, now, NOTICE_COOLDOWN_MS))) return;
  const { results } = await db
    .prepare(`SELECT id, at, action, target, actor, count FROM admin_events WHERE notice = 'pending' ORDER BY id LIMIT ?1`)
    .bind(MAX_ROWS + 1)
    .all<Pending>();
  const rows = results.slice(0, MAX_ROWS);
  // Sending takes time, and another change can land meanwhile. It may add to one of these rows, so
  // only a row still as it was read is settled; the changed one waits for the next notice.
  const mark = (state: string, list: Pending[] = rows) => db
    .prepare(
      `UPDATE admin_events SET notice = ?1 FROM json_each(?2) AS s
       WHERE admin_events.id = json_extract(s.value,'$.id') AND admin_events.at = json_extract(s.value,'$.at')
         AND admin_events.count = json_extract(s.value,'$.count') AND admin_events.notice = 'pending'`,
    )
    .bind(state, JSON.stringify(list.map(({ id, at, count }) => ({ id, at, count }))));
  // Runs after `mark` in the same batch, so the flag stays up while anything is still waiting.
  const clear = db.prepare(
    `UPDATE settings SET value = CASE key WHEN 'admin_notice_to' THEN '[]' ELSE '' END
     WHERE key IN ('admin_notice_pending', 'admin_notice_to') AND NOT EXISTS (SELECT 1 FROM admin_events WHERE notice = 'pending')`,
  );
  if (!rows.length) {
    await clear.run();
    return;
  }
  const to = noticeAudience(env, [configFrom(settings)], settings.admin_notice_to, await watchedAccountIds(env, now));
  if (!to.length && !env.WEBHOOK_URL) {
    await db.batch([mark('none'), clear]);
    return;
  }
  if (await sendAdminNotice(env, to, rows.map(rowOf), results.length - rows.length)) {
    await db.batch([mark('sent'), clear]);
    return;
  }
  // Nothing accepted it: try again after the cooldown, and stop once it is too old to matter.
  const expired = rows.filter((r) => now.getTime() - Date.parse(r.at) > GIVE_UP_MS);
  if (expired.length) await db.batch([mark('failed', expired), clear]);
}
