// Client report: one account over 7 or 30 days, as printable HTML or, with the optional Browser
// Rendering binding (BROWSER), as a PDF rendered from the same HTML.
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

/** Renders the report HTML to an A4 PDF in Browser Rendering (free plan: 10 minutes a day). */
export async function reportPdf(env: Env, html: string): Promise<ArrayBuffer> {
  if (!env.BROWSER) throw new Error('PDF reports need the Browser Rendering binding (BROWSER in wrangler.jsonc).');
  // Loaded only when a PDF is asked for, so installs without the binding never run it.
  const { launch } = await import('@cloudflare/playwright');
  const browser = await launch(env.BROWSER as unknown as Parameters<typeof launch>[0]);
  try {
    const page = await browser.newPage();
    // setContent: no URL to fetch and no session cookie to hand over.
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
  } finally {
    await browser.close();
  }
}
