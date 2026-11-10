<!-- Free plan daily request budget: used so far, where today's pace lands by midnight UTC, warn and critical ticks. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { BudgetStatus } from '../../../src/shared/types';
  import { compact, num } from '../lib/api';
  import Icon from './Icon.svelte';

  let { budget }: { budget: BudgetStatus } = $props();
  const share = $derived(Math.min(1, budget.share));
  // Straight-line pace: share used so far divided by the share of the UTC day that has passed.
  // Too early in the day the extrapolation is noise, so it is only shown after 02:00 UTC.
  const dayDone = (Date.now() % 86_400_000) / 86_400_000;
  const paceKnown = dayDone >= 1 / 12;
  const pace = $derived(paceKnown ? budget.share / dayDone : budget.share);
  // Thresholds come from the server config (thresholds.budgetWarn / budgetCritical).
  const warn = $derived(budget.warnAt ?? 0.7);
  const crit = $derived(budget.criticalAt ?? 0.9);
  const tone = $derived(budget.share >= crit || pace >= 1 ? 'critical' : budget.share >= warn || pace >= warn ? 'warning' : 'calm');
  const projected = $derived(budget.projectedLimitAt ? budget.projectedLimitAt.slice(11, 16) + ' UTC' : null);
</script>

<section class="budget card {tone}" aria-labelledby="budget-title">
  <div class="head">
    <span class="icon"><Icon name="budget" size={20} /></span>
    <div class="title">
      <h2 id="budget-title">Free requests today</h2>
      <p class="muted num">{num(budget.usedToday)} of {compact(budget.limit)}</p>
    </div>
    <span class="share">{Math.round(budget.share * 100)}<small>%</small></span>
  </div>

  <div>
    <div class="track" role="meter" aria-valuemin="0" aria-valuemax={budget.limit} aria-valuenow={budget.usedToday} aria-label="Share of today's free requests used">
      <div class="pace" style="width: {Math.min(1, pace) * 100}%"></div>
      <div class="fill" style="width: {share * 100}%"></div>
      <span class="tick" style="left: {warn * 100}%"></span>
      <span class="tick" style="left: {crit * 100}%"></span>
    </div>
    <div class="scale muted" aria-hidden="true"><span style="left: {warn * 100}%"><em>Warn </em>{Math.round(warn * 100)}%</span><span class:end={crit > 0.8} style="left: {crit * 100}%"><em>Critical </em>{Math.round(crit * 100)}%</span></div>
  </div>

  <dl class="facts">
    <div><dt class="muted">Used</dt><dd><span class="key fill-key"></span>{Math.round(budget.share * 100)}%</dd></div>
    {#if paceKnown}
      <div><dt class="muted">By midnight at this pace</dt><dd><span class="key pace-key"></span>{pace > 1 ? 'Over the limit' : Math.round(pace * 100) + '%'}</dd></div>
    {/if}
  </dl>

  <p class="note">
    {#if projected}
      <Icon name="warning" size={16} /> <span>Limit reached around <strong class="num">{projected}</strong>. Workers then return Error 1027 until midnight UTC.</span>
    {:else}
      <span class="muted">On track to stay under the limit. Resets at midnight UTC.</span>
    {/if}
  </p>
</section>

<style>
  .budget { --tone: var(--ink-muted); padding: 20px 24px; display: grid; gap: 14px; align-content: start; }
  .warning { --tone: var(--accent); }
  .critical { --tone: var(--critical); }
  .head { display: flex; align-items: center; gap: 12px; }
  .title { flex: 1; min-width: 0; }
  .title h2 { font-size: 15px; line-height: 20px; }
  .title p { font-size: 13px; line-height: 18px; }
  .icon { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
  .share { font-size: 32px; line-height: 36px; font-weight: 600; letter-spacing: -0.03em; }
  .share small { font-size: 18px; font-weight: 500; color: var(--ink-muted); margin-left: 1px; }
  .track { position: relative; height: 10px; border-radius: 999px; background: color-mix(in srgb, var(--tone) 12%, transparent); overflow: hidden; }
  .fill, .pace { position: absolute; inset: 0 auto 0 0; border-radius: 999px; }
  .pace { background: color-mix(in srgb, var(--tone) 30%, transparent); }
  .fill { background: var(--tone); box-shadow: 2px 0 0 var(--surface); }
  @media (prefers-reduced-motion: no-preference) {
    .fill, .pace { animation: grow 800ms cubic-bezier(0.2, 0.8, 0.2, 1) both; transform-origin: left; }
    .pace { animation-delay: 200ms; }
  }
  @keyframes grow { from { transform: scaleX(0); } }
  .tick { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--surface); }
  .scale { position: relative; height: 16px; margin-top: 4px; font-size: 11px; line-height: 16px; }
  .scale span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  /* Near the right edge, end the label at its tick so it never wraps or overflows. */
  .scale span.end { transform: translateX(calc(-100% + 6px)); }
  .scale em { font-style: normal; }
  /* On narrow screens the two labels would overlap; the numbers alone are enough. */
  @media (max-width: 640px) { .scale em { display: none; } }
  .facts { display: flex; gap: 24px; margin: 0; flex-wrap: wrap; }
  .facts dt { font-size: 12px; line-height: 16px; }
  .facts dd { margin: 2px 0 0; display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 600; }
  .key { width: 10px; height: 10px; border-radius: 3px; }
  .fill-key { background: var(--tone); }
  .pace-key { background: color-mix(in srgb, var(--tone) 30%, transparent); }
  .note { display: flex; gap: 8px; align-items: start; font-size: 13px; line-height: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
  .note :global(svg) { flex: none; color: var(--tone); margin-top: 1px; }
</style>
