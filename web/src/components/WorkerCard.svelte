<!-- Worker card: quiet when healthy, orange border and top finding when not. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { WorkerSummary } from '../../../src/shared/types';
  import { num, timeAgo } from '../lib/api';
  import Icon from './Icon.svelte';
  import Sparkline from './Sparkline.svelte';

  let { worker }: { worker: WorkerSummary } = $props();
  const hot = $derived(worker.score > 0);
  const critical = $derived(worker.topFinding?.severity === 'critical');
</script>

<article class="card worker" class:hot class:critical>
  <header>
    <span class="icon"><Icon name="worker" /></span>
    <h3 class="mono" title={worker.name}>{worker.name}</h3>
    {#if hot}<span class="score num" title="Attention score">{worker.score}</span>{/if}
  </header>
  <div class="stats">
    <div>
      <p class="num">{num(worker.requests24h)} <span class="muted">req 24 h</span></p>
      <p class="num">{num(worker.errors24h)} <span class="muted">errors</span></p>
    </div>
    <Sparkline values={worker.spark} {hot} label="Requests per day, last 7 days, for {worker.name}" />
  </div>
  {#if worker.topFinding}
    <p class="top">{worker.topFinding.message}</p>
  {/if}
  <footer class="muted">
    {#if worker.handlers.includes('scheduled')}<span class="tag"><Icon name="cron" size={16} /> cron</span>{/if}
    <span>Deployed {timeAgo(worker.deployedOn)}</span>
  </footer>
</article>

<style>
  .worker { padding: 16px; display: grid; gap: 12px; border-left: 1px solid var(--line); }
  .worker.hot { border-left: 3px solid var(--accent); }
  .worker.critical { border-left-color: var(--critical); }
  header { display: flex; align-items: center; gap: 10px; min-width: 0; }
  h3 { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon { display: inline-flex; color: var(--ink-muted); }
  .hot .icon { color: var(--accent); }
  .critical .icon { color: var(--critical); }
  .score { min-width: 28px; padding: 0 8px; border-radius: 999px; background: var(--chip); color: var(--chip-text); font-size: 13px; font-weight: 600; text-align: center; }
  .stats { display: flex; justify-content: space-between; align-items: end; gap: 12px; font-size: 14px; line-height: 20px; }
  .top { font-size: 14px; line-height: 20px; }
  footer { display: flex; gap: 12px; font-size: 12px; line-height: 16px; }
  .tag { display: inline-flex; align-items: center; gap: 4px; }
</style>
