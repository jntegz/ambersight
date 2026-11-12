<!-- One number with its change against the period before. Up is red where up is bad (errors, cost). -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { change } from '../lib/api';

  let {
    label, value, now = null, before = null, upIsBad = false, hint = '', compare = 'the period before',
  }: { label: string; value: string; now?: number | null; before?: number | null; upIsBad?: boolean; hint?: string; compare?: string } = $props();
  const delta = $derived(now != null && before != null ? change(now, before) : null);
  const tone = $derived(!delta || delta.dir === 'flat' || delta.text === 'new' ? 'flat' : (delta.dir === 'up') === upIsBad ? 'bad' : 'good');
</script>

<div class="stat">
  <span class="label">{label}</span>
  <strong class="value num">{value}</strong>
  {#if delta?.text}
    <span class="delta {tone}" title="Compared with {compare}">
      {#if delta.dir === 'up'}▲{:else if delta.dir === 'down'}▼{/if} {delta.text}<span class="sr-only"> compared with {compare}</span>
    </span>
  {:else if hint}
    <span class="hint">{hint}</span>
  {/if}
</div>

<style>
  .stat { display: grid; gap: 2px; padding: 14px 16px; min-width: 0; }
  .label { font-size: 12px; line-height: 16px; color: var(--ink-muted); font-weight: 500; }
  .value { font-size: 22px; line-height: 30px; font-weight: 600; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .delta { font-size: 12px; line-height: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .delta.good { color: var(--healthy); }
  .delta.bad { color: var(--critical); }
  .delta.flat { color: var(--ink-muted); }
</style>
