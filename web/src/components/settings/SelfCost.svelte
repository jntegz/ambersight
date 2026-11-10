<!-- What Ambersight itself costs to run: today's usage against the free allowances, the last scan, and a 7-day trend. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { SelfCost } from '../../../../src/shared/types';
  import { api, compact, num, pct, timeAgo } from '../../lib/api';
  import TrendBars from '../TrendBars.svelte';

  let cost = $state<SelfCost | null>(null);
  let error = $state('');
  api.selfCost().then((c) => (cost = c), (e) => (error = (e as Error).message));

  const today = $derived(cost?.days.at(-1) ?? null);
  const meters = $derived(
    cost && today
      ? [
          { label: 'Worker requests', used: today.apiRequests + today.cronRuns, limit: cost.allowances.requestsPerDay, note: `${num(today.cronRuns)} cron runs + ${num(today.apiRequests)} dashboard calls` },
          { label: 'D1 rows read', used: today.rowsRead, limit: cost.allowances.rowsReadPerDay, note: 'Free plan daily allowance' },
          { label: 'D1 rows written', used: today.rowsWritten, limit: cost.allowances.rowsWrittenPerDay, note: 'Free plan daily allowance' },
          { label: 'Subrequests, last scan', used: cost.lastScan.subrequests, limit: cost.allowances.subrequestsPerRun, note: 'Per scan run' },
        ]
      : [],
  );
  const tone = (share: number) => (share >= 0.9 ? 'critical' : share >= 0.6 ? 'warning' : 'calm');
</script>

{#if error}
  <p class="error-text" role="alert">{error}</p>
{:else if !cost}
  <p class="muted loading" aria-busy="true">Measuring…</p>
{:else}
  <div class="self">
    <div class="meters">
      {#each meters as m (m.label)}
        {@const share = m.used / Math.max(1, m.limit)}
        <div class="meter {tone(share)}">
          <div class="m-head">
            <span class="m-label">{m.label}</span>
            <span class="m-value"><strong>{compact(m.used)}</strong><span class="muted">&nbsp;/ {compact(m.limit)}</span></span>
          </div>
          <div class="track" role="meter" aria-label={m.label} aria-valuemin="0" aria-valuemax={m.limit} aria-valuenow={m.used}>
            <span class="fill" style="width: {Math.min(1, share) * 100}%"></span>
          </div>
          <p class="m-note muted">{pct(share)} used · {m.note}</p>
        </div>
      {/each}
    </div>

    <div class="side">
      <dl class="scan">
        <div><dt>Last scan</dt><dd>{timeAgo(cost.lastScan.at)}</dd></div>
        <div><dt>Duration</dt><dd>{(cost.lastScan.durationMs / 1000).toFixed(1)} s</dd></div>
      </dl>
      {#if cost.lastScan.warnings.length}
        <ul class="warnings">{#each cost.lastScan.warnings as w (w)}<li>{w}</li>{/each}</ul>
      {/if}
      {#if cost.days.length > 1}
        <div>
          <p class="trend-title muted">Requests used by Ambersight per day</p>
          <TrendBars values={cost.days.map((d) => d.apiRequests + d.cronRuns)} unit="requests" label="Ambersight's own requests per day" />
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .loading { font-size: 14px; }
  .self { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 28px; }
  .meters { display: grid; gap: 18px; }
  .meter { --tone: var(--healthy); }
  .meter.warning { --tone: var(--accent); }
  .meter.critical { --tone: var(--critical); }
  .m-head { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; line-height: 18px; }
  .m-label { font-weight: 500; }
  .m-value strong { font-weight: 600; }
  .track { height: 6px; margin: 6px 0 4px; border-radius: 999px; background: color-mix(in srgb, var(--tone) 14%, transparent); overflow: hidden; }
  .fill { display: block; height: 100%; min-width: 2px; border-radius: 999px; background: var(--tone); }
  .m-note { font-size: 12px; line-height: 16px; }
  .side { display: grid; gap: 18px; align-content: start; }
  .scan { display: flex; gap: 28px; margin: 0; }
  .scan dt { font-size: 12px; color: var(--ink-muted); }
  .scan dd { margin: 2px 0 0; font-size: 20px; line-height: 26px; font-weight: 600; }
  .warnings { margin: 0; padding: 10px 12px 10px 28px; border-radius: var(--radius-control); background: var(--row-tint); font-size: 13px; line-height: 18px; }
  .trend-title { font-size: 12px; line-height: 16px; margin-bottom: 8px; }
  @media (max-width: 760px) { .self { grid-template-columns: 1fr; } }
</style>
