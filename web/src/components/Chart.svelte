<!-- Time-series chart: axes with units, gridlines, lines, areas or bars, deploy markers, a limit line and a -->
<!-- tooltip that works with the pointer and the arrow keys. The data is one click away as a table. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts" module>
  export type Tone = 'accent' | 'ink' | 'muted' | 'critical' | 'healthy' | 'warning';
  export interface ChartSeries {
    label: string;
    values: (number | null)[];
    tone?: Tone;
    kind?: 'line' | 'area' | 'bar';
    dashed?: boolean;
  }
  export interface ChartMarker {
    index: number;
    label: string;
    tone?: 'critical' | 'muted';
  }

  /** "Nov 9" or "14:00" from an ISO day or hour. */
  export function bucketLabel(t: string, granularity: 'hour' | 'day', long = false): string {
    const d = new Date(granularity === 'day' ? `${t}T00:00:00Z` : t);
    const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (granularity === 'day') return long ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : day;
    const hour = `${String(d.getUTCHours()).padStart(2, '0')}:00`;
    return long ? `${day}, ${hour} UTC` : hour === '00:00' ? day : hour;
  }

  /** Round tick values from 0 to at least max. */
  function ticks(max: number, integer: boolean, count = 4): number[] {
    if (max <= 0) return [0, 1];
    const raw = integer ? Math.max(1, max / count) : max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
    const top = Math.ceil(max / step) * step;
    return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toPrecision(12));
  }
</script>

<script lang="ts">
  let {
    labels, granularity, series, format, title, height = 200, markers = [], limit = null, stacked = false, partialLast = true, csvName = '',
  }: {
    labels: string[];
    granularity: 'hour' | 'day';
    series: ChartSeries[];
    format: (v: number) => string;
    title: string;
    height?: number;
    markers?: ChartMarker[];
    limit?: { value: number; label: string } | null;
    stacked?: boolean;
    /** The last bucket is still filling up: drawn faded. */
    partialLast?: boolean;
    /** File name for the CSV download; no button when empty. */
    csvName?: string;
  } = $props();

  let width = $state(600);
  const PAD = { top: 12, right: 12, bottom: 24, left: 52 };
  const n = $derived(labels.length);
  const plotW = $derived(Math.max(10, width - PAD.left - PAD.right));
  const plotH = $derived(height - PAD.top - PAD.bottom);
  const hasBars = $derived(series.some((s) => s.kind === 'bar'));
  const slot = $derived(plotW / Math.max(1, n));
  const x = (i: number) => PAD.left + (hasBars ? slot * (i + 0.5) : n > 1 ? (plotW * i) / (n - 1) : plotW / 2);

  // Stacked bars add up per bucket; everything else is drawn on its own values.
  const stackTops = $derived(stacked ? labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)) : []);
  const max = $derived(Math.max(limit?.value ?? 0, ...(stacked ? stackTops : series.flatMap((s) => s.values.map((v) => v ?? 0)))));
  // Counts (deploys, findings, runs) get whole-number ticks.
  const integer = $derived(series.every((s) => s.values.every((v) => v == null || Number.isInteger(v))));
  const yTicks = $derived(ticks(max, integer));
  const top = $derived(yTicks.at(-1) || 1);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  const COLOR: Record<Tone, string> = {
    accent: 'var(--accent)', ink: 'var(--ink)', muted: 'color-mix(in srgb, var(--ink-muted) 55%, transparent)',
    critical: 'var(--critical)', healthy: 'var(--healthy)', warning: 'var(--warning-text)',
  };

  function path(values: (number | null)[], from = 0, to = values.length) {
    let d = '';
    let pen = false;
    for (let i = from; i < to; i++) {
      const v = values[i];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  }

  // X labels: about one per 90 px, counted back from the newest bucket.
  const every = $derived(Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90)))));
  // Hourly ranges longer than a day label midnights ("Nov 9") rather than the same hour every day.
  const xLabels = $derived.by(() => {
    if (granularity === 'hour' && every >= 12) {
      const days = Math.ceil(every / 24);
      const mids = labels.map((t, i) => ({ t, i })).filter((l) => l.t.slice(11, 13) === '00');
      return mids.filter((_, k) => (mids.length - 1 - k) % days === 0).map((l) => ({ i: l.i, text: bucketLabel(l.t, granularity) }));
    }
    return labels.map((t, i) => ({ i, text: (n - 1 - i) % every === 0 ? bucketLabel(t, granularity) : '' })).filter((l) => l.text);
  });

  let active = $state<number | null>(null);
  function pick(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - r.left - PAD.left;
    const i = hasBars ? Math.floor(px / slot) : Math.round((px / plotW) * (n - 1));
    active = Math.max(0, Math.min(n - 1, i));
  }
  function key(e: KeyboardEvent) {
    if (!n) return;
    const step = e.shiftKey ? Math.max(1, Math.round(n / 10)) : 1;
    if (e.key === 'ArrowLeft') active = Math.max(0, (active ?? n) - step);
    else if (e.key === 'ArrowRight') active = Math.min(n - 1, (active ?? -1) + step);
    else if (e.key === 'Home') active = 0;
    else if (e.key === 'End') active = n - 1;
    else if (e.key === 'Escape') active = null;
    else return;
    e.preventDefault();
  }
  const markerAt = $derived(new Map(markers.map((m) => [m.index, m])));
  const empty = $derived(series.every((s) => s.values.every((v) => !v)));
  /** What a screen reader says for one bucket. */
  function readout(i: number): string {
    if (i < 0 || !labels[i]) return 'No data';
    const vals = series.map((s) => `${s.label} ${s.values[i] == null ? 'no data' : format(s.values[i]!)}`).join(', ');
    const m = markerAt.get(i);
    return `${bucketLabel(labels[i], granularity, true)}: ${vals}${m ? `. ${m.label}` : ''}`;
  }

  let showTable = $state(false);
  function csv() {
    const head = ['time', ...series.map((s) => s.label)];
    const rows = labels.map((t, i) => [t, ...series.map((s) => s.values[i] ?? '')]);
    const text = [head, ...rows].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `${csvName}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
</script>

<figure class="chart">
  {#if series.length > 1 || limit}
    <figcaption class="legend">
      {#each series as s (s.label)}
        <span class="key"><i class:bar={s.kind === 'bar'} class:dashed={s.dashed} style="--c: {COLOR[s.tone ?? 'accent']}"></i>{s.label}</span>
      {/each}
      {#if limit}<span class="key"><i class="dashed" style="--c: var(--critical)"></i>{limit.label}</span>{/if}
    </figcaption>
  {/if}
  <div class="plot" bind:clientWidth={width} style="height: {height}px">
    <svg
      {width} {height} role="slider" tabindex="0" aria-label="{title}. Use the arrow keys to read each {granularity}."
      aria-valuemin={0} aria-valuemax={Math.max(0, n - 1)} aria-valuenow={active ?? Math.max(0, n - 1)} aria-valuetext={readout(active ?? n - 1)}
      onpointermove={pick} onpointerleave={() => (active = null)} onkeydown={key} onblur={() => (active = null)}
    >
      <g class="grid">
        {#each yTicks as t (t)}
          <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} />
          <text x={PAD.left - 8} y={y(t) + 4} text-anchor="end">{format(t)}</text>
        {/each}
      </g>
      <g class="xaxis">
        {#each xLabels as l (l.i)}<text x={x(l.i)} y={height - 6} text-anchor="middle">{l.text}</text>{/each}
      </g>
      {#each markers as m (m.index)}
        <line class="marker" class:critical={m.tone === 'critical'} x1={x(m.index)} x2={x(m.index)} y1={PAD.top} y2={PAD.top + plotH} />
        <path class="marker-head" class:critical={m.tone === 'critical'} d="M{x(m.index) - 4} {PAD.top} h8 l-4 6z" />
      {/each}
      {#if limit}
        <line class="limit" x1={PAD.left} x2={PAD.left + plotW} y1={y(limit.value)} y2={y(limit.value)} />
      {/if}
      {#each series as s, si (s.label)}
        {#if s.kind === 'bar'}
          {@const bw = Math.max(1, Math.min(28, slot * (stacked ? 0.72 : 0.72 / series.filter((z) => z.kind === 'bar').length)))}
          {@const bi = series.filter((z) => z.kind === 'bar').indexOf(s)}
          {#each s.values as v, i (i)}
            {#if v}
              {@const base = stacked ? series.slice(0, si).reduce((sum, z) => sum + (z.values[i] ?? 0), 0) : 0}
              <rect
                class="bar" class:partial={partialLast && i === n - 1} class:dim={active !== null && active !== i}
                x={stacked ? x(i) - bw / 2 : x(i) - (bw * series.filter((z) => z.kind === 'bar').length) / 2 + bi * bw}
                y={y(base + v)} width={bw} height={Math.max(1, y(base) - y(base + v))} rx={Math.min(3, bw / 3)} fill={COLOR[s.tone ?? 'accent']}
              />
            {/if}
          {/each}
        {:else}
          {#if s.kind === 'area'}
            <path class="area" d="{path(s.values)} L{x(n - 1)} {y(0)} L{x(0)} {y(0)} Z" fill={COLOR[s.tone ?? 'accent']} />
          {/if}
          <path class="line" class:dashed={s.dashed} d={path(s.values, 0, partialLast ? n - 1 : n)} stroke={COLOR[s.tone ?? 'accent']} />
          {#if partialLast && n > 1}<path class="line partial" d={path(s.values, n - 2, n)} stroke={COLOR[s.tone ?? 'accent']} />{/if}
        {/if}
      {/each}
      {#if active !== null}
        <line class="rule" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} />
        {#each series as s (s.label)}
          {#if s.kind !== 'bar' && s.values[active] != null}
            <circle cx={x(active)} cy={y(s.values[active]!)} r="3.5" fill="var(--surface)" stroke={COLOR[s.tone ?? 'accent']} stroke-width="2" />
          {/if}
        {/each}
      {/if}
    </svg>
    {#if empty}<p class="nodata">No data in this range.</p>{/if}
    {#if active !== null}
      <div class="tip" class:right={x(active) > width / 2} style="left: {x(active)}px" aria-live="polite">
        <strong>{bucketLabel(labels[active], granularity, true)}{partialLast && active === n - 1 ? ' (so far)' : ''}</strong>
        {#each series as s (s.label)}
          <span><i style="--c: {COLOR[s.tone ?? 'accent']}"></i>{s.label} <b class="num">{s.values[active] == null ? '–' : format(s.values[active]!)}</b></span>
        {/each}
        {#if markerAt.get(active)}<span class="mk">{markerAt.get(active)!.label}</span>{/if}
      </div>
    {/if}
  </div>
  <div class="tools">
    <button type="button" class="link" aria-expanded={showTable} onclick={() => (showTable = !showTable)}>{showTable ? 'Hide data' : 'Show data'}</button>
    {#if csvName}<button type="button" class="link" onclick={csv}>Download CSV</button>{/if}
  </div>
  {#if showTable}
    <div class="table-wrap">
      <table>
        <caption class="sr-only">{title}</caption>
        <thead><tr><th scope="col">{granularity === 'hour' ? 'Hour (UTC)' : 'Day (UTC)'}</th>{#each series as s (s.label)}<th scope="col">{s.label}</th>{/each}</tr></thead>
        <tbody>
          {#each labels as t, i (t)}
            <tr><th scope="row">{bucketLabel(t, granularity, true)}</th>{#each series as s (s.label)}<td class="num">{s.values[i] == null ? '–' : format(s.values[i]!)}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</figure>

<style>
  .chart { margin: 0; display: grid; gap: 6px; min-width: 0; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; line-height: 16px; color: var(--ink-muted); }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .key i, .tip i { display: inline-block; width: 12px; height: 2px; border-radius: 2px; background: var(--c); }
  .key i.bar { height: 10px; width: 10px; border-radius: 3px; }
  .key i.dashed { background: repeating-linear-gradient(90deg, var(--c) 0 3px, transparent 3px 5px); }
  /* The SVG is sized from the box, never the other way round, so a chart cannot widen the page. */
  .plot { position: relative; width: 100%; min-width: 0; }
  svg { position: absolute; inset: 0 auto auto 0; display: block; overflow: visible; }
  svg:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
  .grid line { stroke: var(--line); stroke-width: 1; }
  .grid text, .xaxis text { fill: var(--ink-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .line.dashed { stroke-dasharray: 4 4; stroke-width: 1.5; }
  .line.partial { stroke-dasharray: 2 3; opacity: 0.7; }
  .area { opacity: 0.1; }
  .bar { transition: opacity 120ms; }
  .bar.partial { opacity: 0.55; }
  .bar.dim { opacity: 0.45; }
  .limit { stroke: var(--critical); stroke-dasharray: 5 4; stroke-width: 1.25; }
  .marker { stroke: color-mix(in srgb, var(--ink-muted) 50%, transparent); stroke-dasharray: 2 3; }
  .marker.critical { stroke: var(--critical); }
  .marker-head { fill: var(--ink-muted); }
  .marker-head.critical { fill: var(--critical); }
  .rule { stroke: var(--ink-muted); stroke-width: 1; }
  .nodata { position: absolute; inset: 0 0 24px 52px; display: grid; place-items: center; font-size: 13px; color: var(--ink-muted); pointer-events: none; }
  .tip {
    position: absolute; top: 0; transform: translateX(12px); z-index: 5; pointer-events: none;
    display: grid; gap: 2px; width: max-content; max-width: 260px; padding: 8px 10px; border-radius: 8px;
    font-size: 12px; line-height: 16px; background: var(--ink); color: var(--paper); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  }
  .tip.right { transform: translateX(calc(-100% - 12px)); }
  .tip span { display: flex; align-items: center; gap: 6px; color: color-mix(in srgb, var(--paper) 80%, transparent); }
  .tip b { margin-left: auto; padding-left: 12px; color: var(--paper); }
  .tip .mk { color: var(--orange-200); }
  .tools { display: flex; gap: 12px; justify-content: flex-end; }
  .link { min-height: 0; padding: 0; border: 0; background: none; font-size: 12px; color: var(--accent-text); }
  .link:hover { text-decoration: underline; }
  .table-wrap { max-height: 280px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 4px 10px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th[scope='row'], thead th:first-child { text-align: left; font-weight: 500; }
  thead th { position: sticky; top: 0; background: var(--surface); font-weight: 600; }
</style>
