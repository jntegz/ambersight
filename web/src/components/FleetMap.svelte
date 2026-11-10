<!-- One cell per Worker, colored by its worst open finding. Cells link to the Worker below. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { WorkerSummary } from '../../../src/shared/types';
  import { num, workerId } from '../lib/api';

  let { workers }: { workers: WorkerSummary[] } = $props();

  const LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info', healthy: 'Healthy' } as const;
  type State = keyof typeof LABEL;
  const stateOf = (w: WorkerSummary): State => w.topFinding?.severity ?? 'healthy';
  // Fewer Workers get bigger cells, so a small fleet still reads as a map.
  const size = $derived(workers.length <= 24 ? 'lg' : workers.length <= 60 ? 'md' : 'sm');

  let wrap: HTMLDivElement;
  let tip = $state<{ w: WorkerSummary; x: number; y: number } | null>(null);

  function show(w: WorkerSummary, el: HTMLElement) {
    const a = el.getBoundingClientRect();
    const b = wrap.getBoundingClientRect();
    tip = { w, x: a.left - b.left + a.width / 2, y: a.top - b.top };
  }
</script>

<div class="map" bind:this={wrap}>
  <ul class="cells {size}" aria-label="Fleet map: one cell per Worker">
    {#each workers as w (w.name)}
      <li>
        <a
          class="cell {stateOf(w)}"
          href="#{workerId(w.name)}"
          aria-label="{w.name}: {LABEL[stateOf(w)]}"
          onpointerenter={(e) => show(w, e.currentTarget)}
          onpointerleave={() => (tip = null)}
          onfocus={(e) => show(w, e.currentTarget)}
          onblur={() => (tip = null)}
        ></a>
      </li>
    {/each}
  </ul>
  {#if tip}
    <div class="tip" class:edge={tip.x < 140} style="left: {tip.x}px; top: {tip.y}px" role="presentation">
      <span class="name mono">{tip.w.name}</span>
      <span class="row"><span class="swatch {stateOf(tip.w)}"></span>{tip.w.topFinding?.message ?? 'Healthy'}</span>
      <span class="row muted num">{num(tip.w.requests24h)} requests · {num(tip.w.errors24h)} errors · 24 h</span>
    </div>
  {/if}
</div>

<style>
  .map { position: relative; }
  .cells { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .cell {
    --c: var(--healthy);
    display: block; width: 22px; height: 22px; border-radius: 6px;
    background: color-mix(in srgb, var(--c) 30%, var(--surface));
    transition: transform 120ms ease-out, box-shadow 120ms ease-out;
  }
  .lg { gap: 6px; }
  .lg .cell { width: 30px; height: 30px; border-radius: 8px; }
  .sm .cell { width: 14px; height: 14px; border-radius: 4px; }
  .cell.critical { --c: var(--critical); background: var(--c); }
  .cell.warning { --c: var(--accent); background: var(--c); }
  .cell.info { --c: var(--ink-muted); background: var(--c); }
  .cell:hover, .cell:focus-visible { transform: translateY(-2px); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--c); outline: none; }
  .tip {
    position: absolute; z-index: 5; transform: translate(-50%, calc(-100% - 10px)); pointer-events: none;
    display: grid; gap: 2px; width: max-content; max-width: 280px; padding: 8px 10px;
    font-size: 12px; line-height: 16px; border-radius: 8px;
    background: var(--ink); color: var(--paper); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  }
  .tip.edge { transform: translate(-20px, calc(-100% - 10px)); }
  .tip .muted { color: color-mix(in srgb, var(--paper) 70%, transparent); }
  .name { font-size: 12px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 6px; }
  .swatch { flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--healthy); }
  .swatch.critical { background: var(--critical); }
  .swatch.warning { background: var(--accent); }
  .swatch.info { background: var(--ink-muted); }
</style>
