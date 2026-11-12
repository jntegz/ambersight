<!-- One finding: severity, sentence, evidence, action, acknowledge and snooze. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { checkOf, cleanupFor, isHiddenEvidence } from '../../../src/shared/findings';
  import CheckExplain from './CheckExplain.svelte';
  import type { Finding, FindingEvent, FindingListItem } from '../../../src/shared/types';
  import { api, timeAgo, workerHref } from '../lib/api';
  import Icon, { type IconName } from './Icon.svelte';
  import SnoozeMenu from './SnoozeMenu.svelte';

  let { finding, onAcknowledge, onSnooze, onRestore, compact = false, showWorker = true }: {
    finding: Finding | FindingListItem;
    onAcknowledge: (id: string) => void;
    onSnooze: (id: string, days: 7 | 30 | 90) => void;
    /** Acknowledged and snoozed findings get a Restore button instead. */
    onRestore?: (id: string) => void;
    /** Inside a group: the group already shows the fix, so leave it out. */
    compact?: boolean;
    /** On a Worker's own page its name is already the title. */
    showWorker?: boolean;
  } = $props();
  const item = $derived('lastSeen' in finding ? finding : null);
  let history = $state<FindingEvent[] | null>(null);
  let historyOpen = $state(false);
  async function toggleHistory() {
    historyOpen = !historyOpen;
    if (historyOpen && !history) history = await api.history(finding.id).catch(() => []);
  }
  const EVENT: Record<FindingEvent['kind'], string> = {
    opened: 'Opened', reopened: 'Reopened', escalated: 'Got worse', eased: 'Eased', resolved: 'Resolved',
    acknowledged: 'Acknowledged', snoozed: 'Snoozed', restored: 'Restored', alerted: 'Alert sent',
  };

  const LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;
  const MODULE_ICON: Record<Finding['module'], IconName> = {
    budget: 'budget', errors: 'errors', runaway: 'runaway', cron: 'cron', usage: 'usage',
    deprecation: 'deprecation', exposure: 'exposure', zombies: 'zombies', timeline: 'timeline',
    health: 'key', pages: 'grid', security: 'shield', drift: 'list', deploys: 'timeline', packages: 'list',
  };
  // Timestamps in evidence (e.g. deployedAt) read better as "Nov 9, 19:58 UTC".
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const when = (iso: string) =>
    `${new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`;
  const cleanup = $derived(cleanupFor(finding));
  let copied = $state('');
  async function copy(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      copied = cmd;
      setTimeout(() => (copied = ''), 1500);
    } catch {}
  }
  const evidence = $derived(
    Object.entries(finding.evidence).filter(([k]) => !isHiddenEvidence(k)).map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, ' $1').toLowerCase(); // inARow -> in a row, d1 -> d1
      return { label: label[0].toUpperCase() + label.slice(1), value: typeof v === 'number' ? v.toLocaleString('en-US') : ISO.test(v) ? when(v) : v };
    }),
  );
</script>

<li class="row {finding.severity}">
  <span class="sev"><Icon name={finding.severity} size={20} label={LABEL[finding.severity]} /></span>
  <div class="body">
    <p class="meta">
      <span class="label">{LABEL[finding.severity]}</span>
      {#if finding.script === '*'}
        <span class="script mono">Account</span>
      {:else if showWorker}
        <a class="script mono" href={workerHref(finding.script)} title="Show this Worker">{finding.script}</a>
      {/if}
      <span class="module muted">
        {#if MODULE_ICON[finding.module]}<Icon name={MODULE_ICON[finding.module]} size={14} />{/if}
        {finding.module}
      </span>
      {#if finding.status === 'resolved' && item}
        <span class="age muted" title={item.lastSeen}>· resolved {timeAgo(item.lastSeen)}</span>
      {:else if finding.firstSeen}<span class="age muted" title={finding.firstSeen}>· opened {timeAgo(finding.firstSeen)}</span>{/if}
      {#if finding.status === 'snoozed' && item?.snoozeUntil}<span class="pill">Snoozed until {new Date(item.snoozeUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>{/if}
      {#if finding.status === 'acknowledged'}<span class="pill">Acknowledged{item?.statusAt ? ` ${timeAgo(item.statusAt)}` : ''}</span>{/if}
      {#if item?.reopenCount}<span class="pill recur" title="Resolved and came back">Came back {item.reopenCount}×</span>{/if}
    </p>
    <p class="message">{finding.message}</p>
    {#if !compact}
      <p class="action muted">
        {finding.action}
        {#if finding.docsUrl}<a href={finding.docsUrl} target="_blank" rel="noopener noreferrer">Docs <Icon name="external" size={12} /></a>{/if}
      </p>
      <CheckExplain check={checkOf(finding)} />
    {/if}
    {#if evidence.length}
      <dl class="evidence">
        {#each evidence as e (e.label)}<div><dt>{e.label}</dt><dd class="num">{e.value}</dd></div>{/each}
      </dl>
    {/if}
    {#if cleanup}
      <details class="cleanup">
        <summary>How to remove it</summary>
        <p class="hint">{cleanup.note}{#if cleanup.commands.length}{' '}Ambersight is read-only and never runs these; they delete for good.{/if}</p>
        {#each cleanup.commands as c (c)}
          <div class="cmd"><code class="mono">{c}</code><button type="button" class="ghost small" onclick={() => copy(c)}>{copied === c ? 'Copied' : 'Copy'}</button></div>
        {/each}
      </details>
    {/if}
  </div>
  <div class="buttons">
    {#if (finding.status === 'acknowledged' || finding.status === 'snoozed') && onRestore}
      <button type="button" onclick={() => onRestore(finding.id)}><Icon name="undo" size={16} /> Restore</button>
    {:else if finding.status !== 'resolved'}
      <button type="button" onclick={() => onAcknowledge(finding.id)}><Icon name="check" size={16} /> Acknowledge</button>
      <SnoozeMenu onSnooze={(days) => onSnooze(finding.id, days)} />
    {/if}
    {#if item}
      <button type="button" aria-expanded={historyOpen} onclick={toggleHistory}><Icon name="timeline" size={16} /> History</button>
    {/if}
  </div>
  {#if historyOpen}
    <ol class="history" aria-label="History of this finding">
      {#if !history}<li class="muted">Loading…</li>{:else if !history.length}<li class="muted">No history recorded yet.</li>{/if}
      {#each history ?? [] as h, i (i)}
        <li><span class="ev {h.kind}">{EVENT[h.kind] ?? h.kind}</span>{#if h.severity && (h.kind === 'opened' || h.kind === 'reopened' || h.kind === 'escalated' || h.kind === 'eased')}<span class="muted"> as {h.severity}</span>{/if}<time class="muted num" datetime={h.at}>{new Date(h.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC</time></li>
      {/each}
    </ol>
  {/if}
</li>

<style>
  .row {
    position: relative; display: grid; grid-template-columns: 20px 1fr auto; gap: 14px; align-items: start;
    padding: 16px 20px; border-bottom: 1px solid var(--line);
  }
  .row:last-child { border-bottom: 0; }
  .row::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0; background: transparent; }
  .critical::before { background: var(--critical); }
  .warning::before { background: var(--accent); }
  .sev { color: var(--ink-muted); display: inline-flex; margin-top: 1px; }
  /* Long cleanup commands scroll inside their box instead of widening the page. */
  .body { min-width: 0; }
  .critical .sev { color: var(--critical); }
  .warning .sev { color: var(--accent); }
  .meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; line-height: 20px; }
  .label { font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; }
  .critical .label { color: var(--critical); }
  .warning .label { color: var(--warning-text); }
  .script { font-size: 13px; padding: 0 6px; border-radius: 4px; background: var(--line); color: var(--ink); text-decoration: none; }
  a.script:hover { background: var(--chip); color: var(--chip-text); }
  .module { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
  .age { font-size: 12px; margin-left: -4px; }
  .row { transition: background 120ms; }
  .row:hover { background: var(--row-tint); }
  .message { margin-top: 4px; font-weight: 500; }
  .action { font-size: 14px; line-height: 20px; margin-top: 2px; }
  .action a { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; font-weight: 500; text-decoration: none; }
  .action a:hover { text-decoration: underline; }
  .evidence { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
  .evidence div { display: inline-flex; gap: 6px; font-size: 12px; line-height: 22px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; }
  .evidence dt { color: var(--ink-muted); }
  .evidence dd { margin: 0; font-weight: 600; }
  .buttons { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .buttons button { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; min-height: 32px; padding: 0 10px; background: transparent; color: var(--ink-muted); }
  .buttons button:hover { color: var(--ink); background: var(--surface); }
  @media (max-width: 640px) {
    .row { grid-template-columns: 20px 1fr; padding: 14px 16px; }
    .buttons { grid-column: 2; justify-content: flex-start; }
  }
  .pill { font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; background: var(--line); color: var(--ink-muted); }
  .pill.recur { background: var(--chip); color: var(--chip-text); font-weight: 600; }
  .history { grid-column: 2 / -1; margin: 0; padding: 0 0 0 14px; list-style: none; border-left: 2px solid var(--line); display: grid; gap: 4px; font-size: 13px; }
  .history li { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
  .history time { margin-left: auto; font-size: 12px; }
  .ev { font-weight: 600; }
  .ev.resolved, .ev.restored { color: var(--healthy); }
  .ev.opened, .ev.reopened, .ev.escalated { color: var(--warning-text); }
  .cleanup { margin-top: 10px; font-size: 13px; }
  .cleanup summary { cursor: pointer; color: var(--ink-muted); font-weight: 500; width: fit-content; }
  .cleanup summary:hover { color: var(--ink); }
  .cleanup .hint { margin: 6px 0; }
  .cmd { display: flex; align-items: center; gap: 8px; margin-top: 6px; min-width: 0; }
  .cmd button { min-height: 28px; padding: 0 8px; font-size: 12px; }
  .cmd code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; padding: 6px 10px; border-radius: 6px; background: var(--line); font-size: 12px; user-select: all; }
</style>
