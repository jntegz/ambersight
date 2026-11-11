// Markdown export of a findings list (Needs attention or Housekeeping), built in the browser.
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanupFor, isHiddenEvidence, type FindingGroup } from '../../../src/shared/findings';
import { helpFor } from '../../../src/shared/help';
import type { Finding } from '../../../src/shared/types';

const LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;

/** One line of plain text: no line breaks, and Markdown characters that could start markup escaped. */
const line = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/([\\`*_[\]<>#|])/g, '\\$1').trim();
const evidence = (f: Finding) => Object.entries(f.evidence).filter(([k]) => !isHiddenEvidence(k)).map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toLocaleString('en-US') : v}`).join(' · ');

export function findingsMarkdown(opts: {
  title: string;
  groups: FindingGroup[];
  account: { id: string; label: string } | null;
  scope?: string;
  now?: Date;
  /** One line under the header, e.g. what removing the unused storage frees. */
  summary?: string;
}): string {
  const now = opts.now ?? new Date();
  const total = opts.groups.reduce((n, g) => n + g.findings.length, 0);
  const out: string[] = [
    `# Ambersight · ${line(opts.title)}`,
    '',
    [
      opts.account ? `Account: ${line(opts.account.label)} (\`${opts.account.id}\`)` : null,
      opts.scope ? `Group: ${line(opts.scope)}` : null,
      `Exported ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      `${total} ${total === 1 ? 'finding' : 'findings'}`,
    ].filter(Boolean).join(' · '),
    '',
    ...(opts.summary ? [line(opts.summary), ''] : []),
  ];
  const cleanup: { f: Finding; commands: string[]; note: string }[] = [];
  for (const g of opts.groups) {
    out.push(`## ${LABEL[g.severity]} · ${line(g.title)} (${g.findings.length})`, '', `Check: \`${g.check}\``, '');
    const help = helpFor(g.check);
    if (help) {
      out.push(`**What this means.** ${line(help.what)}`, '', `**Why it matters.** ${line(help.why)}`, '', '**What to do**', '');
      help.steps.forEach((s, i) => out.push(`${i + 1}. ${line(s)}`));
      out.push('');
    }
    for (const f of g.findings) {
      out.push(`- [ ] **${f.script === '*' ? 'Account' : line(f.script)}**: ${line(f.message)}`);
      out.push(`  - Fix: ${line(f.action)}${f.docsUrl ? ` ([docs](${f.docsUrl}))` : ''}`);
      const ev = evidence(f);
      if (ev) out.push(`  - Evidence: ${line(ev)}`);
      if (f.firstSeen) out.push(`  - Open since ${f.firstSeen.slice(0, 10)}`);
      const c = cleanupFor(f);
      if (c) {
        cleanup.push({ f, ...c });
        out.push(`  - Remove: ${line(c.note)}`);
      }
    }
    out.push('');
  }
  const withCommands = cleanup.filter((c) => c.commands.length);
  if (withCommands.length) {
    out.push(
      '## Cleanup commands',
      '',
      'Review each one before you run it. They delete for good. Ambersight is read-only and never runs them. Run them with `npx wrangler login` done for this account.',
      '',
    );
    // Each step's description sits outside the code block. The block holds only the commands, built
    // from checked names and ids: no text from the Cloudflare API goes into what gets pasted into a
    // shell (zsh does not treat # as a comment when you paste, so a comment line would run).
    withCommands.forEach((c, i) => out.push(`${i + 1}. ${line(c.f.message)} ${c.commands.map((x) => `\`${x}\``).join(', then ')}`));
    out.push('', '```sh', ...(opts.account && /^[\w-]{1,64}$/.test(opts.account.id) ? [`export CLOUDFLARE_ACCOUNT_ID=${opts.account.id}`] : []));
    // A Worker can be both "never deployed" and "no traffic": each command goes in once.
    out.push(...new Set(withCommands.flatMap((c) => c.commands)));
    out.push('```', '');
  }
  return out.join('\n');
}
