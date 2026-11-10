<!-- Several findings from the same check: one heading, one fix, bulk actions, expandable list. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { CHECK_GROUP_FIX, type FindingGroup } from '../../../src/shared/findings';
  import type { Finding } from '../../../src/shared/types';
  import { num, workerId } from '../lib/api';
  import FindingRow from './FindingRow.svelte';
  import Icon, { type IconName } from './Icon.svelte';
  import SnoozeMenu from './SnoozeMenu.svelte';

  let { group, onAcknowledge, onSnooze, onBulk, onMute }: {
    group: FindingGroup;
    onAcknowledge: (id: string) => void;
    onSnooze: (id: string, days: 7 | 30 | 90) => void;
    onBulk: (ids: string[], action: 'acknowledge' | 'snooze', days?: 7 | 30 | 90) => void;
    /** Switch the check off for every Worker. */
    onMute: (check: string) => void;
  } = $props();

  const LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;
  const MODULE_ICON: Record<Finding['module'], IconName> = {
    budget: 'budget', errors: 'errors', runaway: 'runaway', cron: 'cron', usage: 'usage',
    deprecation: 'deprecation', exposure: 'exposure', zombies: 'zombies', timeline: 'timeline',
    health: 'key', pages: 'grid', security: 'shield', drift: 'list', deploys: 'timeline',
  };
  const CHIPS = 6;

  let open = $state(false);
  let confirmMute = $state(false);
  const first = $derived(group.findings[0]);
  const ids = $derived(group.findings.map((f) => f.id));
  const accountWide = $derived(group.findings.every((f) => f.script === '*'));
  const scripts = $derived([...new Set(group.findings.filter((f) => f.script !== '*').map((f) => f.script))]);
  const noun = $derived(accountWide ? (group.findings.length === 1 ? 'item' : 'items') : scripts.length === 1 ? 'Worker' : 'Workers');
  const count = $derived(accountWide ? group.findings.length : scripts.length);
  const fix = $derived(CHECK_GROUP_FIX[group.check] ?? first.action);
</script>

<li class="group {group.severity}">
  <span class="sev"><Icon name={group.severity} size={20} label={LABEL[group.severity]} /></span>
  <div class="body">
    <p class="meta">
      <span class="label">{LABEL[group.severity]}</span>
      <span class="module muted">
        {#if MODULE_ICON[first.module]}<Icon name={MODULE_ICON[first.module]} size={14} />{/if}
        {first.module}
      </span>
    </p>
    <p class="title">{group.title} <span class="affected">· {num(count)} {noun}</span></p>
    {#if scripts.length}
      <p class="chips">
        {#each scripts.slice(0, CHIPS) as s (s)}<a class="script mono" href="#{workerId(s)}" title="Show this Worker">{s}</a>{/each}
        {#if scripts.length > CHIPS}<button type="button" class="more" onclick={() => (open = true)}>+{scripts.length - CHIPS} more</button>{/if}
      </p>
    {/if}
    <p class="action muted">
      {fix}
      {#if first.docsUrl}<a href={first.docsUrl} target="_blank" rel="noopener noreferrer">Docs <Icon name="external" size={12} /></a>{/if}
    </p>
    <button type="button" class="toggle" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="caret" class:open><Icon name="chevron" size={12} /></span>
      {open ? 'Hide details' : `Show all ${num(group.findings.length)}`}
    </button>
  </div>
  <div class="buttons">
    <button type="button" onclick={() => onBulk(ids, 'acknowledge')}><Icon name="check" size={16} /> Acknowledge all</button>
    <SnoozeMenu label="Snooze all" title="Hide these findings for" onSnooze={(days) => onBulk(ids, 'snooze', days)} />
    {#if confirmMute}
      <span class="confirm" role="group" aria-label="Confirm stop checking">
        <span class="muted">Stop this check for every Worker?</span>
        <button type="button" class="danger" onclick={() => { confirmMute = false; onMute(group.check); }}>Stop checking</button>
        <button type="button" onclick={() => (confirmMute = false)}>Cancel</button>
      </span>
    {:else}
      <button type="button" title="Turn this check off. You can turn it back on in Settings › Checks." onclick={() => (confirmMute = true)}>
        <Icon name="close" size={16} /> Stop checking
      </button>
    {/if}
  </div>
  {#if open}
    <ul class="items">
      {#each group.findings as finding (finding.id)}
        <FindingRow {finding} {onAcknowledge} {onSnooze} compact />
      {/each}
    </ul>
  {/if}
</li>

<style>
  .group {
    position: relative; display: grid; grid-template-columns: 20px 1fr auto; gap: 14px; align-items: start;
    padding: 16px 20px; border-bottom: 1px solid var(--line);
  }
  .group:last-child { border-bottom: 0; }
  .group::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0; background: transparent; }
  .critical::before { background: var(--critical); }
  .warning::before { background: var(--accent); }
  .sev { color: var(--ink-muted); display: inline-flex; margin-top: 1px; }
  .critical .sev { color: var(--critical); }
  .warning .sev { color: var(--accent); }
  .meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; line-height: 20px; }
  .label { font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; }
  .critical .label { color: var(--critical); }
  .warning .label { color: var(--warning-text); }
  .module { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
  .title { margin-top: 4px; font-weight: 600; }
  .affected { font-weight: 500; color: var(--ink-muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .script { font-size: 13px; padding: 0 6px; border-radius: 4px; background: var(--line); color: var(--ink); text-decoration: none; line-height: 22px; }
  a.script:hover { background: var(--chip); color: var(--chip-text); }
  .more { font-size: 13px; line-height: 22px; min-height: 0; padding: 0 6px; border: 0; background: transparent; color: var(--ink-muted); }
  .more:hover { color: var(--ink); text-decoration: underline; }
  .action { font-size: 14px; line-height: 20px; margin-top: 8px; }
  .action a { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; font-weight: 500; text-decoration: none; }
  .action a:hover { text-decoration: underline; }
  .toggle { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; min-height: 28px; padding: 0 8px 0 4px; border: 0; background: transparent; color: var(--ink-muted); font-size: 13px; font-weight: 500; }
  .toggle:hover { color: var(--ink); }
  .caret { display: inline-flex; transform: rotate(-90deg); transition: transform 150ms; }
  .caret.open { transform: rotate(0deg); }
  .buttons { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; align-items: center; max-width: 360px; }
  .buttons button { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; min-height: 32px; padding: 0 10px; background: transparent; color: var(--ink-muted); }
  .buttons button:hover { color: var(--ink); background: var(--surface); }
  .confirm { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; }
  .buttons button.danger { color: var(--critical); border-color: var(--critical); }
  .items { grid-column: 1 / -1; list-style: none; margin: 4px -20px -16px; padding: 0; border-top: 1px solid var(--line); background: var(--row-tint); }
  .items :global(li) { padding-left: 44px; }
  @media (max-width: 640px) {
    .group { grid-template-columns: 20px 1fr; padding: 14px 16px; }
    .buttons { grid-column: 2; justify-content: flex-start; max-width: none; }
    .items { margin: 4px -16px -14px; }
    .items :global(li) { padding-left: 16px; }
  }
</style>
