<!-- One finding: severity, sentence, evidence, action, acknowledge and snooze. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { Finding } from '../../../src/shared/types';
  import Icon, { type IconName } from './Icon.svelte';

  let { finding, onAcknowledge, onSnooze }: {
    finding: Finding;
    onAcknowledge: (id: string) => void;
    onSnooze: (id: string, days: 7 | 30 | 90) => void;
  } = $props();

  const LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;
  const MODULE_ICON: Record<Finding['module'], IconName> = { budget: 'budget', errors: 'errors', runaway: 'runaway', cron: 'cron' };
  const evidence = $derived(
    Object.entries(finding.evidence)
      .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${typeof v === 'number' ? v.toLocaleString('en-US') : v}`)
      .join(' · '),
  );
</script>

<li class="row {finding.severity}">
  <span class="sev" title={LABEL[finding.severity]}>
    <Icon name={finding.severity} label={LABEL[finding.severity]} />
  </span>
  <div class="body">
    <p class="meta">
      <span class="label">{LABEL[finding.severity]}</span>
      <span class="mono">{finding.script === '*' ? 'Account' : finding.script}</span>
      <span class="module muted"><Icon name={MODULE_ICON[finding.module]} size={16} /></span>
    </p>
    <p class="message">{finding.message}</p>
    <p class="action muted">
      {finding.action}
      {#if finding.docsUrl}<a href={finding.docsUrl} target="_blank" rel="noopener noreferrer">Docs</a>{/if}
    </p>
    <p class="evidence muted num">{evidence}</p>
  </div>
  <div class="buttons">
    <button type="button" onclick={() => onAcknowledge(finding.id)}><Icon name="check" size={16} /> Acknowledge</button>
    <button type="button" onclick={() => onSnooze(finding.id, 7)}><Icon name="snooze" size={16} /> Snooze 7 d</button>
  </div>
</li>

<style>
  .row {
    display: grid; grid-template-columns: 24px 1fr auto; gap: 12px; align-items: start;
    padding: 14px 16px; border-bottom: 1px solid var(--line); border-left: 3px solid transparent;
  }
  .row:last-child { border-bottom: 0; }
  .row.critical { border-left-color: var(--critical); }
  .row.warning { border-left-color: var(--accent); background: var(--row-tint); }
  .sev { color: var(--ink-muted); display: inline-flex; }
  .critical .sev { color: var(--critical); }
  .warning .sev { color: var(--accent); }
  .meta { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; }
  .label { font-weight: 600; }
  .critical .label { color: var(--critical); }
  .warning .label { color: var(--warning-text); }
  .module { display: inline-flex; }
  .message { margin-top: 2px; }
  .action, .evidence { font-size: 14px; line-height: 20px; margin-top: 4px; }
  .action a { margin-left: 4px; }
  .evidence { font-size: 12px; line-height: 16px; }
  .buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .buttons button { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; }
  @media (max-width: 640px) {
    .row { grid-template-columns: 24px 1fr; }
    .buttons { grid-column: 2; justify-content: flex-start; }
  }
</style>
