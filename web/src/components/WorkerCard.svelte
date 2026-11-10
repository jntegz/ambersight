<!-- Worker card: quiet when healthy, colored edge and top finding when not. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { WorkerSummary } from '../../../src/shared/types';
  import { num, pct, timeAgo, workerId } from '../lib/api';
  import Icon from './Icon.svelte';
  import Sparkline from './Sparkline.svelte';

  let { worker }: { worker: WorkerSummary } = $props();
  const hot = $derived(worker.score > 0);
  const critical = $derived(worker.topFinding?.severity === 'critical');
  // Route patterns like "example.com/api/*" link to their base; host wildcards are not linkable.
  const entryHref = $derived.by(() => {
    const ep = worker.entryPoints?.[0]?.replace(/\/\*$/, '');
    return ep && !ep.includes('*') ? `https://${ep}` : null;
  });
  const status = $derived(critical ? 'Critical' : hot ? 'Needs attention' : 'Healthy');
</script>

<article class="card worker" class:hot class:critical id={workerId(worker.name)}>
  <header>
    <span class="dot" title={status}><span class="sr-only">{status}</span></span>
    <h3 class="mono" title={worker.name}>{worker.name}</h3>
    {#if hot}<span class="score num" title="Attention score: critical 10, warning 3, info 1">{worker.score}</span>{/if}
  </header>
  <div class="stats">
    <div><p class="label muted">Requests 24 h</p><p class="value">{num(worker.requests24h)}</p></div>
    <div>
      <p class="label muted">Errors 24 h</p>
      <p class="value" class:bad={worker.errors24h > 0 && critical}>
        {num(worker.errors24h)}{#if worker.errors24h > 0}<span class="rate muted">{pct(worker.errors24h / Math.max(1, worker.requests24h))}</span>{/if}
      </p>
    </div>
  </div>
  <Sparkline values={worker.spark} {hot} label="Requests per day, last 7 days, for {worker.name}" />
  {#if worker.topFinding}
    <p class="top"><Icon name={worker.topFinding.severity} size={16} /> {worker.topFinding.message}</p>
  {/if}
  {#if worker.entryPoints?.length}
    <p class="entry muted">
      {#if entryHref}
        <a href={entryHref} target="_blank" rel="noopener noreferrer" title={worker.entryPoints.join('\n')}>
          <Icon name="exposure" size={12} /><span>{worker.entryPoints[0]}</span>
        </a>
      {:else}
        <span class="route" title={worker.entryPoints.join('\n')}><Icon name="exposure" size={12} /><span>{worker.entryPoints[0]}</span></span>
      {/if}
      {#if worker.entryPoints.length > 1}<span title={worker.entryPoints.slice(1).join('\n')}>+{worker.entryPoints.length - 1}</span>{/if}
    </p>
  {/if}
  <footer class="muted">
    {#each worker.groups ?? [] as g (g)}<span class="tag group">{g}</span>{/each}
    {#each worker.handlers as h (h)}<span class="tag">{#if h === 'scheduled'}<Icon name="cron" size={12} /> cron{:else}{h}{/if}</span>{/each}
    <span class="deployed">Deployed {timeAgo(worker.deployedOn)}</span>
  </footer>
</article>

<style>
  .worker {
    --tone: var(--healthy);
    position: relative; padding: 16px 18px; display: grid; gap: 14px; align-content: start;
    scroll-margin-top: 88px; transition: border-color 150ms, box-shadow 150ms, transform 150ms;
  }
  .worker:hover { border-color: color-mix(in srgb, var(--ink-muted) 60%, var(--line)); box-shadow: var(--shadow-lift); }
  .worker.hot { --tone: var(--accent); }
  .worker.critical { --tone: var(--critical); }
  .worker.hot::before { content: ''; position: absolute; left: -1px; top: 14px; bottom: 14px; width: 3px; border-radius: 0 3px 3px 0; background: var(--tone); }
  .worker:target { animation: flash 1.6s ease-out; }
  @keyframes flash { 0%, 40% { box-shadow: 0 0 0 3px var(--tone); } 100% { box-shadow: 0 0 0 3px transparent; } }
  header { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 20%, transparent); }
  h3 { flex: 1; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .score { min-width: 24px; padding: 0 8px; border-radius: 999px; background: var(--chip); color: var(--chip-text); font-size: 12px; line-height: 20px; font-weight: 600; text-align: center; cursor: help; }
  .critical .score { background: color-mix(in srgb, var(--critical) 14%, transparent); color: var(--critical); }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .label { font-size: 12px; line-height: 16px; }
  .value { font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
  .value.bad { color: var(--critical); }
  .rate { margin-left: 6px; font-size: 12px; font-weight: 500; letter-spacing: 0; }
  .top { display: flex; gap: 8px; align-items: start; font-size: 13px; line-height: 18px; padding: 8px 10px; border-radius: var(--radius-control); background: var(--row-tint); }
  .top :global(svg) { flex: none; margin-top: 1px; color: var(--tone); }
  footer { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; line-height: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
  .tag { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 4px; background: var(--line); font-size: 11px; }
  .deployed { margin-left: auto; }
  .tag.group { background: var(--chip); color: var(--chip-text); }
  .entry { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -4px; font-size: 12px; line-height: 16px; }
  .entry a { display: inline-flex; align-items: center; gap: 5px; min-width: 0; color: var(--ink-muted); text-decoration: none; }
  .entry a:hover { color: var(--accent-text); }
  .route { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
  .entry a span, .route span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
  .entry :global(svg) { flex: none; }
</style>
