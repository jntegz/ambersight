<!-- 7-day column chart. Today (the last column) is in the accent; earlier days are recessive. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { dayLabels, num } from '../lib/api';

  let { values, unit, label }: { values: number[]; unit: string; label: string } = $props();
  const max = $derived(Math.max(1, ...values));
  const days = $derived(dayLabels(values.length));
  // Long ranges label every few days, counted back from today, so the axis never crowds.
  const every = $derived(values.length > 10 ? Math.ceil(values.length / 6) : 1);
  let hover = $state<number | null>(null);
</script>

<figure class="trend" aria-label={label}>
  <div class="plot" role="list" onpointerleave={() => (hover = null)}>
    {#each values as v, i (i)}
      <div
        class="col"
        class:today={i === values.length - 1}
        class:dim={hover !== null && hover !== i}
        role="listitem"
        aria-label="{days[i]}: {num(v)} {unit}"
        onpointerenter={() => (hover = i)}
      >
        <span class="bar" style="height: {Math.max(2, (v / max) * 100)}%"></span>
        {#if hover === i}<span class="tip"><strong class="num">{num(v)}</strong> {unit}<br /><span>{days[i]}{i === values.length - 1 ? ' so far' : ''}</span></span>{/if}
      </div>
    {/each}
  </div>
  <figcaption class="axis muted" aria-hidden="true">
    {#each days as d, i (i)}
      <span>{#if i === days.length - 1}Today{:else if (days.length - 1 - i) % every === 0}{days.length > 10 ? d.split(', ')[1] : d.slice(0, 3)}{/if}</span>
    {/each}
  </figcaption>
</figure>

<style>
  .trend { margin: 0; display: grid; gap: 6px; }
  .plot { height: 64px; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; border-bottom: 1px solid var(--line); }
  .col { position: relative; display: flex; align-items: flex-end; justify-content: center; outline: none; cursor: default; }
  .bar {
    width: min(24px, 70%); border-radius: 4px 4px 0 0;
    background: color-mix(in srgb, var(--ink-muted) 35%, transparent);
    transition: opacity 120ms, background 120ms;
  }
  /* Today is still filling up: accent outline, lighter fill. */
  .today .bar { background: color-mix(in srgb, var(--accent) 65%, transparent); box-shadow: inset 0 2px 0 var(--accent); }
  .col:hover .bar { background: color-mix(in srgb, var(--ink-muted) 60%, transparent); }
  .today:hover .bar { background: color-mix(in srgb, var(--accent) 85%, transparent); }
  .dim .bar { opacity: 0.5; }
  .tip {
    position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 5; pointer-events: none;
    width: max-content; padding: 6px 9px; border-radius: 8px; font-size: 12px; line-height: 16px;
    background: var(--ink); color: var(--paper); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  }
  .tip span { color: color-mix(in srgb, var(--paper) 70%, transparent); }
  .axis span { white-space: nowrap; }
  .axis { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2px; text-align: center; font-size: 11px; line-height: 14px; }
</style>
