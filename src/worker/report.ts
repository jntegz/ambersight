// Client report: one account over 7 or 30 days, as printable HTML (the browser's Print saves it as PDF).
// SPDX-License-Identifier: AGPL-3.0-only

import { configFrom, getSettings } from './db';
import { digestData, renderDigest, subjectFor } from './digest';
import type { Env } from './env';

export async function reportHtml(env: Env, account: string, days: 7 | 30, now = new Date()): Promise<{ html: string; title: string }> {
  const config = configFrom(await getSettings(env.DB));
  const [d] = await digestData(env, now, config, days, [account]);
  if (!d) throw new Error('No such account.');
  const from = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const title = `${d.label}: ${subjectFor(d.rows)}`;
  const { html } = renderDigest(title, `Report for ${from} to ${now.toISOString().slice(0, 10)}.`, [d], {
    periodLabel: days === 7 ? 'Last 7 days' : 'Last 30 days',
    report: true,
  });
  return { html, title: `${d.label} ${now.toISOString().slice(0, 10)}` };
}
