<!-- One finding: severity, sentence, evidence, action, acknowledge and snooze. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { Finding } from '../../../src/shared/types';
  import { timeAgo, workerId } from '../lib/api';
  import Icon, { type IconName } from './Icon.svelte';
  import SnoozeMenu from './SnoozeMenu.svelte';

  let { finding, onAcknowledge, onSnooze, compact = false }: {
    finding: Finding;
    onAcknowledge: (id: string) => void;
    onSnooze: (id: string, days: 7 | 30 | 90) => void;
    /** Inside a group: the group already shows the fix, so leave it out. */
    compact?: boolean;
  } = $props();

  const LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;
  const MODULE_ICON: Record<Finding['module'], IconName> = {
    budget: 'budget', errors: 'errors', runaway: 'runaway', cron: 'cron', usage: 'usage',
    deprecation: 'deprecation', exposure: 'exposure', zombies: 'zombies', timeline: 'timeline',
    health: 'key', pages: 'grid', security: 'shield', drift: 'list', deploys: 'timeline',
  };
  // Timestamps in evidence (e.g. deployedAt) read better as "Nov 9, 19:58 UTC".
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const when = (iso: string) =>
    `${new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`;
  const evidence = $derived(
    Object.entries(finding.evidence).map(([k, v]) => {
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
      {:else}
        <a class="script mono" href="#{workerId(finding.script)}" title="Show this Worker">{finding.script}</a>
      {/if}
      <span class="module muted">
        {#if MODULE_ICON[finding.module]}<Icon name={MODULE_ICON[finding.module]} size={14} />{/if}
        {finding.module}
      </span>
      {#if finding.firstSeen}<span class="age muted" title={finding.firstSeen}>· opened {timeAgo(finding.firstSeen)}</span>{/if}
    </p>
    <p class="message">{finding.message}</p>
    {#if !compact}
      <p class="action muted">
        {finding.action}
        {#if finding.docsUrl}<a href={finding.docsUrl} target="_blank" rel="noopener noreferrer">Docs <Icon name="external" size={12} /></a>{/if}
      </p>
    {/if}
    {#if evidence.length}
      <dl class="evidence">
        {#each evidence as e (e.label)}<div><dt>{e.label}</dt><dd class="num">{e.value}</dd></div>{/each}
      </dl>
    {/if}
  </div>
  <div class="buttons">
    <button type="button" onclick={() => onAcknowledge(finding.id)}><Icon name="check" size={16} /> Acknowledge</button>
    <SnoozeMenu onSnooze={(days) => onSnooze(finding.id, days)} />
  </div>
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
</style>
