<!-- Free plan daily request budget with 70% and 90% ticks. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { BudgetStatus } from '../../../src/shared/types';
  import { num } from '../lib/api';
  import Icon from './Icon.svelte';

  let { budget }: { budget: BudgetStatus } = $props();
  const share = $derived(Math.min(1, budget.share));
  const tone = $derived(budget.share >= 0.9 ? 'critical' : budget.share >= 0.7 ? 'warning' : 'calm');
  const projected = $derived(budget.projectedLimitAt ? budget.projectedLimitAt.slice(11, 16) + ' UTC' : null);
</script>

<section class="budget card" aria-labelledby="budget-title">
  <div class="head">
    <span class="icon {tone}"><Icon name="budget" /></span>
    <h2 id="budget-title">Free requests today</h2>
    <span class="value num">{num(budget.usedToday)} of {num(budget.limit)}</span>
  </div>
  <div class="track" role="meter" aria-valuemin="0" aria-valuemax={budget.limit} aria-valuenow={budget.usedToday} aria-label="Share of today's free requests used">
    <div class="fill {tone}" style="width: {share * 100}%"></div>
    <span class="tick" style="left: 70%"></span>
    <span class="tick red" style="left: 90%"></span>
  </div>
  <p class="note muted">
    {#if projected}
      At this pace you reach the limit around <strong class="num">{projected}</strong>; Workers then return Error 1027 until midnight UTC.
    {:else}
      On track to stay under the limit today. Resets at midnight UTC.
    {/if}
  </p>
</section>

<style>
  .budget { padding: 16px 20px; display: grid; gap: 12px; }
  .head { display: flex; align-items: center; gap: 10px; }
  .head h2 { font-size: 16px; line-height: 24px; flex: 1; }
  .value { font-weight: 600; }
  .icon { display: inline-flex; color: var(--ink-muted); }
  .icon.warning { color: var(--accent); }
  .icon.critical { color: var(--critical); }
  .track { position: relative; height: 10px; border: 1px solid var(--ink-muted); border-radius: 999px; }
  .fill { height: 100%; border-radius: 999px; background: var(--ink-muted); opacity: 0.35; }
  .fill.warning { background: var(--accent); opacity: 0.6; }
  .fill.critical { background: var(--critical); opacity: 0.7; }
  .tick { position: absolute; top: -6px; bottom: -6px; width: 1px; background: var(--ink-muted); }
  .tick.red { background: var(--critical); }
  .note { font-size: 14px; line-height: 20px; }
</style>
