<!-- Dense table view of the fleet. Same data as the cards, easier to scan at 50+ Workers. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { WorkerSummary } from '../../../src/shared/types';
  import { num, pct, timeAgo, workerId } from '../lib/api';
  import Sparkline from './Sparkline.svelte';

  let { workers }: { workers: WorkerSummary[] } = $props();
  const tone = (w: WorkerSummary) => w.topFinding?.severity ?? 'healthy';
</script>

<div class="card wrap">
  <table>
    <thead>
      <tr>
        <th scope="col">Worker</th>
        <th scope="col" class="r">Requests 24 h</th>
        <th scope="col" class="r">Errors 24 h</th>
        <th scope="col" class="r">Error rate</th>
        <th scope="col" class="trend">Last 7 days</th>
        <th scope="col" class="dep">Deployed</th>
      </tr>
    </thead>
    <tbody>
      {#each workers as w (w.name)}
        <tr id={workerId(w.name)} class={tone(w)}>
          <th scope="row">
            <span class="name">
              <span class="dot" aria-hidden="true"></span>
              <span class="mono">{w.name}</span>
            </span>
            {#if w.topFinding}<span class="finding muted">{w.topFinding.message}</span>{/if}
          </th>
          <td class="r num">{num(w.requests24h)}</td>
          <td class="r num" class:bad={w.errors24h > 0 && tone(w) === 'critical'}>{num(w.errors24h)}</td>
          <td class="r num muted">{w.errors24h ? pct(w.errors24h / Math.max(1, w.requests24h)) : '—'}</td>
          <td class="trend"><Sparkline values={w.spark} hot={w.score > 0} height={24} label="Requests per day, last 7 days, for {w.name}" /></td>
          <td class="dep muted">{timeAgo(w.deployedOn)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 20px; }
  th, td { padding: 12px 16px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--line); white-space: nowrap; }
  tbody tr:last-child > * { border-bottom: 0; }
  thead th { font-size: 12px; font-weight: 500; color: var(--ink-muted); padding-top: 10px; padding-bottom: 10px; }
  tbody th { font-weight: 400; max-width: 360px; }
  tbody tr { scroll-margin-top: 88px; transition: background 120ms; }
  tbody tr:hover { background: var(--row-tint); }
  tbody tr:target { animation: flash 1.6s ease-out; }
  @keyframes flash { 0%, 40% { background: var(--chip); } 100% { background: transparent; } }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .trend { width: 140px; }
  .name { display: flex; align-items: center; gap: 10px; font-weight: 600; }
  .name .mono { font-size: 13px; }
  .finding { display: block; margin-left: 18px; font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--healthy); }
  .critical .dot { background: var(--critical); }
  .warning .dot { background: var(--accent); }
  .info .dot { background: var(--ink-muted); }
  .bad { color: var(--critical); font-weight: 600; }
  @media (max-width: 760px) {
    .trend, .dep { display: none; }
    th, td { padding: 10px 12px; }
  }
</style>
