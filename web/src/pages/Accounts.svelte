<!-- All accounts: one card per watched Cloudflare account with what needs attention. Choosing one opens its overview. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { AccountSummary } from '../../../src/shared/types';
  import Icon from '../components/Icon.svelte';
  import { compact, num, pct, timeAgo } from '../lib/api';

  let { accounts, selected, query, onSelect }: {
    accounts: AccountSummary[] | null;
    selected: string | null;
    query: string;
    onSelect: (id: string) => void;
  } = $props();

  const q = $derived(query.trim().toLowerCase());
  const visible = $derived(
    (accounts ?? [])
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.id.includes(q))
      .sort((a, b) => b.findings.critical - a.findings.critical || b.findings.warning - a.findings.warning || a.label.localeCompare(b.label)),
  );
  const totals = $derived({
    critical: (accounts ?? []).reduce((n, a) => n + a.findings.critical, 0),
    warning: (accounts ?? []).reduce((n, a) => n + a.findings.warning, 0),
    workers: (accounts ?? []).reduce((n, a) => n + a.workers, 0),
  });
  const tone = (a: AccountSummary) => (a.scanFailures > 0 || a.findings.critical ? 'critical' : a.findings.warning ? 'warning' : 'calm');
</script>

<header class="page-head">
  <div>
    <h1>All accounts</h1>
    <p>
      {#if accounts}
        {num(accounts.length)} accounts · {num(totals.workers)} Workers ·
        {#if totals.critical}<strong class="crit">{num(totals.critical)} critical</strong>{:else}no critical findings{/if}{#if totals.warning}{' '}· {num(totals.warning)} warnings{/if}
      {:else}Loading…{/if}
    </p>
  </div>
</header>

{#if !accounts}
  <div class="card empty muted" aria-busy="true"><p>Loading accounts…</p></div>
{:else if !visible.length}
  <div class="card empty muted"><p>No account matches "{query}".</p></div>
{:else}
  <ul class="grid">
    {#each visible as a (a.id)}
      <li>
        <button type="button" class="card acct {tone(a)}" class:current={a.id === selected} onclick={() => onSelect(a.id)} aria-label="Open {a.label}">
          <span class="head">
            <span class="name">{a.label}</span>
            <span class="plan">{a.plan === 'paid' ? 'Workers Paid' : 'Free'}</span>
          </span>
          <span class="counts">
            <span class="c crit"><Icon name="critical" size={14} /> {num(a.findings.critical)}</span>
            <span class="c warn"><Icon name="warning" size={14} /> {num(a.findings.warning)}</span>
            <span class="c info"><Icon name="info" size={14} /> {num(a.findings.info)}</span>
          </span>
          <span class="stats muted">
            {num(a.workers)} Workers · {compact(a.requestsToday)} requests today{#if a.requestsToday}{' '}· {pct(a.errorsToday / Math.max(1, a.requestsToday))} errors{/if}
          </span>
          {#if a.budgetShare != null}
            <span class="bar" aria-label="Free request budget used today: {pct(a.budgetShare)}"><span style="width: {Math.min(100, a.budgetShare * 100)}%"></span></span>
          {/if}
          <span class="foot muted">
            {#if a.scanFailures}<span class="crit">Last {a.scanFailures === 1 ? 'scan' : `${a.scanFailures} scans`} failed</span>{:else}Scanned {timeAgo(a.lastScanAt)}{/if}
            <Icon name="arrow" size={14} />
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .acct {
    width: 100%; display: grid; gap: 10px; padding: 16px 18px; text-align: left; cursor: pointer;
    /* Undo the global button centring: this is a card. */
    justify-content: stretch; justify-items: stretch; align-items: start; height: auto;
    border: 1px solid var(--line); border-left: 4px solid var(--line); font: inherit; color: var(--ink);
    transition: border-color 150ms, transform 100ms, box-shadow 150ms;
  }
  .acct:hover { border-color: color-mix(in srgb, var(--ink-muted) 45%, var(--line)); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06); }
  .acct:active { transform: scale(0.995); }
  .acct.critical { border-left-color: var(--critical); }
  .acct.warning { border-left-color: var(--warning-text); }
  .acct.calm { border-left-color: var(--healthy); }
  .acct.current { box-shadow: inset 0 0 0 1px var(--accent); }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .name { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
  .plan { font-size: 12px; color: var(--ink-muted); white-space: nowrap; }
  .counts { display: flex; gap: 14px; font-size: 14px; font-variant-numeric: tabular-nums; }
  .c { display: inline-flex; align-items: center; gap: 4px; }
  .crit { color: var(--critical); }
  .warn { color: var(--warning-text); }
  .info { color: var(--ink-muted); }
  .stats { font-size: 13px; }
  .bar { display: block; height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
  .foot { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
</style>
