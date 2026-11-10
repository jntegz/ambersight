<!-- One finding: severity, sentence, evidence, action, acknowledge and snooze. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { Finding } from '../../../src/shared/types';
  import { timeAgo, workerId } from '../lib/api';
  import Icon, { type IconName } from './Icon.svelte';

  let { finding, onAcknowledge, onSnooze }: {
    finding: Finding;
    onAcknowledge: (id: string) => void;
    onSnooze: (id: string, days: 7 | 30 | 90) => void;
  } = $props();

  const LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;
  const MODULE_ICON: Record<Finding['module'], IconName> = {
    budget: 'budget', errors: 'errors', runaway: 'runaway', cron: 'cron', usage: 'usage',
    deprecation: 'deprecation', exposure: 'exposure', zombies: 'zombies', timeline: 'timeline',
  };
  const SNOOZE = [7, 30, 90] as const;
  let menu = $state(false);
  let menuEl = $state<HTMLDivElement>();
  function closeOnOutside(e: MouseEvent) {
    if (menu && menuEl && !menuEl.contains(e.target as Node)) menu = false;
  }
  const evidence = $derived(
    Object.entries(finding.evidence).map(([k, v]) => {
      const label = k.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
      return { label: label[0].toUpperCase() + label.slice(1), value: typeof v === 'number' ? v.toLocaleString('en-US') : v };
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
    <p class="action muted">
      {finding.action}
      {#if finding.docsUrl}<a href={finding.docsUrl} target="_blank" rel="noopener noreferrer">Docs <Icon name="external" size={12} /></a>{/if}
    </p>
    {#if evidence.length}
      <dl class="evidence">
        {#each evidence as e (e.label)}<div><dt>{e.label}</dt><dd class="num">{e.value}</dd></div>{/each}
      </dl>
    {/if}
  </div>
  <div class="buttons">
    <button type="button" onclick={() => onAcknowledge(finding.id)}><Icon name="check" size={16} /> Acknowledge</button>
    <div class="snooze" bind:this={menuEl}>
      <button type="button" aria-haspopup="menu" aria-expanded={menu} onclick={() => (menu = !menu)}>
        <Icon name="snooze" size={16} /> Snooze <span class="caret" class:open={menu}><Icon name="chevron" size={12} /></span>
      </button>
      {#if menu}
        <div class="menu" role="menu" aria-label="Snooze for">
          <p class="menu-title">Hide this finding for</p>
          {#each SNOOZE as days (days)}
            <button type="button" role="menuitem" onclick={() => { menu = false; onSnooze(finding.id, days); }}>
              {days} days <span class="muted">until {new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</li>

<svelte:window onclick={closeOnOutside} onkeydown={(e) => e.key === 'Escape' && (menu = false)} />

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
  .snooze { position: relative; }
  .caret { display: inline-flex; transition: transform 150ms; }
  .caret.open { transform: rotate(180deg); }
  .menu {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 200px; padding: 6px;
    display: grid; gap: 2px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--surface); box-shadow: var(--shadow-lift), 0 2px 6px rgba(0, 0, 0, 0.08);
  }
  .menu-title { font-size: 11px; line-height: 16px; padding: 4px 8px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .buttons .menu button { justify-content: space-between; width: 100%; border: 0; border-radius: 6px; color: var(--ink); font-weight: 500; }
  .buttons .menu button:hover { background: var(--row-tint); }
  .menu .muted { font-weight: 400; font-size: 12px; }
  @media (prefers-reduced-motion: no-preference) {
    .menu { animation: pop 140ms ease-out; transform-origin: top right; }
  }
  @keyframes pop { from { opacity: 0; transform: scale(0.96) translateY(-4px); } }
  @media (max-width: 640px) {
    .row { grid-template-columns: 20px 1fr; padding: 14px 16px; }
    .buttons { grid-column: 2; justify-content: flex-start; }
  }
</style>
