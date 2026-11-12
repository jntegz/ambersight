<!-- Two to four Workers on shared axes: requests, error rate and CPU per request over the same range. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { Range, WorkerDetail } from '../../../src/shared/types';
  import { api, compact, ms, pct } from '../lib/api';
  import Chart, { type Tone } from './Chart.svelte';
  import Icon from './Icon.svelte';

  let { names, range, account, onClear }: { names: string[]; range: Range; account: string | null; onClear: () => void } = $props();
  const TONES: Tone[] = ['accent', 'ink', 'healthy', 'critical'];
  let details = $state<WorkerDetail[]>([]);
  let error = $state('');
  let seq = 0;
  $effect(() => {
    const list = [...names];
    const mine = ++seq;
    error = '';
    details = [];
    Promise.all(list.map((n) => api.worker(n, range, account ?? undefined))).then(
      (d) => { if (mine === seq) details = d; },
      (e: Error) => { if (mine === seq) error = e.message; },
    );
  });
  const labels = $derived(details[0]?.series.map((p) => p.t) ?? []);
  const gran = $derived(details[0]?.granularity ?? 'day');
  const series = (pick: (p: WorkerDetail['series'][number]) => number | null) =>
    details.map((d, i) => ({ label: d.name, values: d.series.map(pick), tone: TONES[i % TONES.length] }));
</script>

<article class="card compare" aria-labelledby="cmp-title">
  <div class="head">
    <h2 id="cmp-title">Comparing {names.length} Workers</h2>
    <button type="button" class="ghost" onclick={onClear}><Icon name="close" size={14} /> Clear</button>
  </div>
  {#if error}<p class="error-text" role="alert">{error}</p>
  {:else if details.length !== names.length}<p class="muted">Loading…</p>
  {:else}
    <div class="grid">
      <div><h3>Requests</h3><Chart {labels} granularity={gran} title="Requests by Worker" series={series((p) => p.requests)} format={compact} height={170} csvName="ambersight-compare-requests-{range}" /></div>
      <div><h3>Error rate</h3><Chart {labels} granularity={gran} title="Error rate by Worker" series={series((p) => (p.requests ? p.errors / p.requests : null))} format={(v) => pct(v)} height={170} csvName="ambersight-compare-error-rate-{range}" /></div>
      <div><h3>CPU per request</h3><Chart {labels} granularity={gran} title="CPU per request by Worker" series={series((p) => (p.requests ? p.cpuTimeUs / 1000 / p.requests : null))} format={(v) => ms(v)} height={170} csvName="ambersight-compare-cpu-{range}" /></div>
    </div>
  {/if}
</article>

<style>
  .compare { padding: 16px; display: grid; gap: 12px; }
  .head { display: flex; justify-content: space-between; align-items: center; }
  h2 { font-size: 16px; }
  h3 { font-size: 13px; font-weight: 600; color: var(--ink-muted); margin-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .ghost { min-height: 30px; font-size: 13px; }
  @media (max-width: 1000px) { .grid { grid-template-columns: minmax(0, 1fr); } }
</style>
