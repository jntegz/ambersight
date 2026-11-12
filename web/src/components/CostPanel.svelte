<!-- Workers Paid: estimated bill so far this month, the month-end forecast, and what drives it. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { CostEstimate } from '../../../src/shared/types';
  import { workerHref, workerId } from '../lib/api';
  import Icon from './Icon.svelte';

  let { cost }: { cost: CostEstimate } = $props();
  const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const items = $derived(cost.breakdown.slice(0, 5));
  const max = $derived(Math.max(0.01, ...items.map((i) => i.amount)));
</script>

<section class="card cost" aria-labelledby="cost-title">
  <div class="head">
    <span class="icon"><Icon name="usage" size={20} /></span>
    <div>
      <h2 id="cost-title">Estimated bill</h2>
      <p class="muted">At list prices of {cost.pricesAsOf}. Not your invoice.</p>
    </div>
  </div>

  <div class="figures">
    <div><p class="muted label">So far this month</p><p class="value num">{usd(cost.monthToDate)}</p></div>
    <div><p class="muted label">Month end at this pace</p><p class="value num strong">{usd(cost.forecast)}</p></div>
  </div>

  {#if cost.budget}
    {@const used = cost.monthToDate / cost.budget}
    {@const ahead = cost.forecast / cost.budget}
    <div class="budget" class:over={used >= 1} class:warn={used < 1 && (used >= 0.8 || ahead >= 1)}>
      <div class="track" role="meter" aria-label="Share of the monthly budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)}>
        <span class="fill" style="width: {Math.min(100, used * 100)}%"></span>
        <span class="pace" style="left: {Math.min(100, ahead * 100)}%" title="Month end at this pace"></span>
      </div>
      <p class="muted">{Math.round(used * 100)}% of the {usd(cost.budget)} budget{ahead >= 1 ? `; on track for ${Math.round(ahead * 100)}% by month end` : ''}.</p>
    </div>
  {/if}

  {#if items.length}
    <ul class="items" aria-label="Forecast by product">
      {#each items as i (i.label)}
        <li>
          <span>{i.label}</span>
          <span class="bar-track"><span class="bar" style="width: {(i.amount / max) * 100}%"></span></span>
          <span class="num">{usd(i.amount)}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if cost.topWorkers.length}
    <p class="sub muted">Costliest Workers · requests and CPU, per month</p>
    <ul class="items" aria-label="Costliest Workers">
      {#each cost.topWorkers as w (w.name)}
        <li><a class="mono" href={workerHref(w.name)}>{w.name}</a><span></span><span class="num">{usd(w.amount)}</span></li>
      {/each}
    </ul>
  {/if}

  <p class="muted foot">
    {#if cost.partialMonth}Ambersight started tracking after the 1st, so the start of the month is extrapolated.{" "}{/if}R2 operations, logs and Cloudflare products outside Workers are not included. Check <strong>Billing › Billable Usage</strong> for the real number.
  </p>
</section>

<style>
  .cost { padding: 20px 24px; display: grid; gap: 14px; align-content: start; }
  .budget { display: grid; gap: 6px; font-size: 13px; }
  .track { position: relative; height: 8px; border-radius: 999px; background: var(--line); }
  .fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--healthy); }
  .warn .fill { background: var(--accent); }
  .over .fill { background: var(--critical); }
  .pace { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--ink-muted); }
  .head { display: flex; gap: 12px; align-items: flex-start; }
  .icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; flex: none; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  h2 { font-size: 16px; line-height: 22px; font-weight: 600; }
  .head p { font-size: 13px; line-height: 18px; }
  .figures { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .label { font-size: 12px; }
  .value { font-size: 22px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
  .value.strong { color: var(--accent); }
  .items { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 13px; }
  .items li { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto; gap: 10px; align-items: center; }
  .items li > :first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .bar { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
  .sub { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .foot { font-size: 12px; line-height: 18px; }
</style>
