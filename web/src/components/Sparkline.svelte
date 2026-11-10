<!-- 7-day request sparkline. Orange only when the Worker has an open finding. Hover shows each day. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { dayLabels, num } from '../lib/api';

  let { values, hot = false, label, height = 32 }: { values: number[]; hot?: boolean; label: string; height?: number } = $props();
  const W = 120;
  const H = $derived(height);
  const max = $derived(Math.max(1, ...values));
  const step = $derived(values.length > 1 ? W / (values.length - 1) : W);
  const y = (v: number) => H - 3 - (v / max) * (H - 6);
  const pts = $derived(values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`));
  const points = $derived(pts.join(' '));
  // The last value is today so far, so its segment is drawn faded rather than read as a drop.
  const done = $derived(pts.slice(0, -1).join(' '));
  const partial = $derived(pts.slice(-2).join(' '));
  const days = $derived(dayLabels(values.length));
  const last = $derived(values.length - 1);

  let hover = $state<number | null>(null);
  function move(e: PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    hover = Math.max(0, Math.min(last, Math.round(((e.clientX - r.left) / r.width) * last)));
  }
  const shown = $derived(hover ?? last);
</script>

<div class="spark" class:hot style="height: {H}px" onpointermove={move} onpointerleave={() => (hover = null)} role="img" aria-label={label}>
  <!-- Stretches to its container; non-scaling strokes keep the line 2px. -->
  <svg width="100%" height={H} viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,{H} {points} {W},{H}" class="area" />
    <polyline points={done} class="line" vector-effect="non-scaling-stroke" />
    <polyline points={partial} class="line today" vector-effect="non-scaling-stroke" />
  </svg>
  {#if values.length}
    {#if hover !== null}<span class="rule" style="left: {(shown / (last || 1)) * 100}%"></span>{/if}
    <span class="dot" class:open={shown === last} style="left: {(shown / (last || 1)) * 100}%; top: {y(values[shown])}px"></span>
    {#if hover !== null}
      <span class="tip" class:right={shown > last / 2} style="left: {(shown / (last || 1)) * 100}%"><strong class="num">{num(values[shown])}</strong> · {days[shown]}{shown === last ? ' so far' : ''}</span>
    {/if}
  {/if}
</div>

<style>
  .spark { --c: var(--ink-muted); position: relative; cursor: crosshair; }
  .spark.hot { --c: var(--accent); }
  svg { display: block; overflow: visible; }
  .area { fill: var(--c); opacity: 0.08; }
  .hot .area { opacity: 0.1; }
  .line { fill: none; stroke: var(--c); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .dot {
    position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
    background: var(--c); box-shadow: 0 0 0 2px var(--surface); pointer-events: none;
  }
  .line.today { opacity: 0.4; }
  .dot.open { background: var(--surface); box-shadow: inset 0 0 0 2px var(--c); }
  .rule { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line); pointer-events: none; }
  .tip {
    position: absolute; bottom: calc(100% + 6px); transform: translateX(-12px); z-index: 5; pointer-events: none;
    width: max-content; padding: 4px 8px; border-radius: 6px; font-size: 11px; line-height: 16px;
    background: var(--ink); color: var(--paper);
  }
  .tip.right { transform: translateX(calc(-100% + 12px)); }
</style>
