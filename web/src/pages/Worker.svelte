<!-- One Worker: traffic, errors, CPU, limits, cron runs and deploys over a chosen range, with before and -->
<!-- after for each deploy, its findings and history, recent changes and its configuration. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { MetricTotals, Range, WorkerDetail } from '../../../src/shared/types';
  import Chart, { bucketLabel } from '../components/Chart.svelte';
  import FindingRow from '../components/FindingRow.svelte';
  import Icon from '../components/Icon.svelte';
  import RangePicker from '../components/RangePicker.svelte';
  import Stat from '../components/Stat.svelte';
  import { api, ApiError, change, compact, ms, num, pct, timeAgo, usd } from '../lib/api';
  import { RANGE_LABEL, rangeParam, setParam } from '../lib/route';

  let { name, params, account, onUnauthorized, onAcknowledge, onSnooze, onRestore }: {
    name: string;
    params: URLSearchParams;
    account: string | null;
    onUnauthorized: () => void;
    onAcknowledge: (id: string) => Promise<void>;
    onSnooze: (id: string, days: 7 | 30 | 90) => Promise<void>;
    onRestore: (id: string) => Promise<void>;
  } = $props();

  // The URL sets the starting range; the picker changes it from then on.
  let range = $state<Range>(untrack(() => rangeParam(params, '7d')));
  let data = $state<WorkerDetail | null>(null);
  let error = $state('');
  let loading = $state(false);

  async function load() {
    loading = true;
    error = '';
    try {
      data = await api.worker(name, range, account ?? undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void name; void range; void account;
    load();
  });
  function pickRange(r: Range) {
    range = r;
    setParam('range', r);
  }
  async function act(p: Promise<void>) {
    await p;
    await load();
  }

  const rate = (t: MetricTotals) => (t.requests ? t.errors / t.requests : 0);
  const cpuPer = (t: MetricTotals) => (t.requests ? t.cpuTimeUs / 1000 / t.requests : null);
  const subPer = (t: MetricTotals) => (t.requests ? t.subrequests / t.requests : null);
  const labels = $derived(data?.series.map((p) => p.t) ?? []);
  // Deploys on the charts: the bucket each one falls in.
  const markers = $derived(
    (data?.deploys ?? []).flatMap((d) => {
      const key = data!.granularity === 'hour' ? `${d.createdOn.slice(0, 13)}:00:00Z` : d.createdOn.slice(0, 10);
      const index = labels.indexOf(key);
      return index < 0 ? [] : [{ index, label: `Deploy ${d.id.slice(0, 8)}${d.message ? `: ${d.message}` : ''}`, tone: d.correlated.length ? ('critical' as const) : ('muted' as const) }];
    }),
  );
  const SEV = { critical: 0, warning: 1, info: 2 } as const;
  const open = $derived((data?.findings.filter((f) => f.status !== 'resolved') ?? []).sort((a, b) => SEV[a.severity] - SEV[b.severity]));
  const resolved = $derived(data?.findings.filter((f) => f.status === 'resolved') ?? []);
  const isCron = $derived(data?.handlers.includes('scheduled') ?? false);
  const csvBase = $derived(`ambersight-${name}-${range}`);
  const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }) + ' UTC';
  const noHistory = $derived(data && !data.historyStart);
</script>

<section class="worker-page" aria-busy={loading}>
  <div class="page-head">
    <div>
      <a class="back" href="#/"><Icon name="arrow" size={14} /> Overview</a>
      <h1 class="mono">{name}</h1>
      {#if data?.exists}
        <p>
          {#if data.handlers.length}{data.handlers.join(', ')}{/if}
          {#if data.deployedOn} · deployed {timeAgo(data.deployedOn)}{/if}
          {#if data.compatibilityDate} · compatibility date {data.compatibilityDate}{/if}
          {#each data.groups as g (g)} <span class="tag-chip">{g}</span>{/each}
        </p>
      {/if}
    </div>
    <RangePicker value={range} onChange={pickRange} />
  </div>

  {#if error}
    <div class="card empty" role="alert"><p>{error}</p><button type="button" onclick={load}>Try again</button></div>
  {:else if !data}
    <div class="skeleton card" aria-label="Loading"></div>
  {:else if !data.exists && !data.totals.requests}
    <div class="card empty"><p>No Worker called <span class="mono">{name}</span> in this account. It may have been deleted or renamed.</p><a href="#/">Back to the overview</a></div>
  {:else}
    {#if !data.exists}<p class="note">This Worker no longer exists; its history is shown until it ages out.</p>{/if}
    {#if noHistory}<p class="note">No metrics yet. They appear after the next scan.</p>{:else if data.historyStart && data.historyStart > data.from.slice(0, 10)}
      <p class="note">History starts on {new Date(`${data.historyStart}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}, so the comparison with the {RANGE_LABEL[range]} before is partial.</p>
    {/if}

    <div class="stats card">
      <Stat label="Requests" value={compact(data.totals.requests)} now={data.totals.requests} before={data.previous.requests} compare="the {RANGE_LABEL[range]} before" />
      <Stat label="Error rate" value={pct(rate(data.totals))} now={rate(data.totals)} before={rate(data.previous)} upIsBad compare="the {RANGE_LABEL[range]} before" />
      <Stat label="CPU per request" value={ms(cpuPer(data.totals))} now={cpuPer(data.totals)} before={cpuPer(data.previous)} upIsBad hint="average" compare="the {RANGE_LABEL[range]} before" />
      <Stat label="Highest CPU p99" value={ms(data.totals.cpuP99)} now={data.totals.cpuP99} before={data.previous.cpuP99} upIsBad compare="the {RANGE_LABEL[range]} before" />
      <Stat label="Subrequests per request" value={subPer(data.totals) == null ? '–' : subPer(data.totals)!.toFixed(2)} now={subPer(data.totals)} before={subPer(data.previous)} upIsBad compare="the {RANGE_LABEL[range]} before" />
      <Stat label="Limit hits" value={num(data.totals.exceeded)} now={data.totals.exceeded} before={data.previous.exceeded} upIsBad compare="the {RANGE_LABEL[range]} before" />
      {#if data.cost}<Stat label="List price" value={usd(data.cost.amount)} hint={data.cost.perMillion != null ? `${usd(data.cost.perMillion)} per million requests` : ''} />{/if}
    </div>

    <div class="grid2">
      <article class="card panel">
        <h2>Requests and errors</h2>
        <Chart
          {labels} granularity={data.granularity} title="Requests and errors for {name}" {markers} csvName="{csvBase}-requests"
          series={[
            { label: 'Requests', values: data.series.map((p) => p.requests), tone: 'muted', kind: 'bar' },
            { label: 'Errors', values: data.series.map((p) => p.errors), tone: 'critical', kind: 'bar' },
          ]}
          format={compact}
        />
      </article>
      <article class="card panel">
        <h2>Error rate</h2>
        <Chart
          {labels} granularity={data.granularity} title="Error rate for {name}" {markers} csvName="{csvBase}-error-rate"
          series={[{ label: 'Error rate', values: data.series.map((p) => (p.requests ? p.errors / p.requests : null)), tone: 'critical', kind: 'area' }]}
          format={(v) => pct(v)}
        />
      </article>
      <article class="card panel">
        <h2>CPU time</h2>
        <Chart
          {labels} granularity={data.granularity} title="CPU time for {name}" {markers} csvName="{csvBase}-cpu"
          series={[
            { label: 'Highest p99', values: data.series.map((p) => p.cpuP99), tone: 'accent' },
            { label: 'Average per request', values: data.series.map((p) => (p.requests ? p.cpuTimeUs / 1000 / p.requests : null)), tone: 'ink', dashed: true },
          ]}
          format={(v) => ms(v)}
        />
      </article>
      <article class="card panel">
        <h2>Subrequests and limit hits</h2>
        {#if data.totals.exceeded === 0}
          <p class="muted">No invocation hit the CPU, memory or other limits in the last {RANGE_LABEL[range]}.</p>
        {:else}
        <Chart
          {labels} granularity={data.granularity} title="Subrequests per request and limit hits for {name}" stacked csvName="{csvBase}-limits"
          series={[
            { label: 'CPU limit', values: data.series.map((p) => p.exceededCpu), tone: 'critical', kind: 'bar' },
            { label: 'Memory limit', values: data.series.map((p) => p.exceededMemory), tone: 'warning', kind: 'bar' },
            { label: 'Other limits', values: data.series.map((p) => Math.max(0, p.exceeded - p.exceededCpu - p.exceededMemory)), tone: 'muted', kind: 'bar' },
          ]}
          format={compact}
        />
        {/if}
        <p class="hint">Subrequests per request: {subPer(data.totals) == null ? '–' : subPer(data.totals)!.toFixed(2)} on average ({compact(data.totals.subrequests)} in total).</p>
      </article>
      {#if isCron}
        <article class="card panel">
          <h2>Cron runs</h2>
          {#if data.crons.length}<p class="hint">Schedule: <span class="mono">{data.crons.join(', ')}</span></p>{/if}
          {#if data.cron.length}
            <Chart
              labels={data.cron.map((c) => c.t)} granularity={data.granularity} title="Cron runs for {name}" stacked csvName="{csvBase}-cron"
              series={[
                { label: 'Succeeded', values: data.cron.map((c) => c.runs - c.failures), tone: 'healthy', kind: 'bar' },
                { label: 'Failed', values: data.cron.map((c) => c.failures), tone: 'critical', kind: 'bar' },
              ]}
              format={num}
            />
          {:else}<p class="muted">No runs recorded in this range.</p>{/if}
        </article>
      {/if}
    </div>

    <article class="card">
      <div class="section-head pad"><h2>Deploys <span class="count">{data.deploys.length}</span></h2></div>
      {#if data.deploys.length}
        <div class="scroll">
          <table class="t">
            <thead><tr><th>When</th><th>By</th><th>Message</th><th class="r">Error rate before → after</th><th class="r">CPU per request</th><th class="r">Requests</th></tr></thead>
            <tbody>
              {#each data.deploys as d (d.id)}
                {@const imp = data.deployImpact.find((x) => x.id === d.id)}
                <tr class:bad={d.correlated.length > 0}>
                  <td class="num nowrap" title={d.createdOn}>{when(d.createdOn)}</td>
                  <td>{d.author ?? '–'}{#if d.source}<span class="muted">{' '}· {d.source}</span>{/if}</td>
                  <td>{d.message ?? ''}{#if d.correlated.length}<span class="flag">Followed by {d.correlated.join(', ')}</span>{/if}</td>
                  {#if imp}
                    {@const er = change(rate(imp.after), rate(imp.before))}
                    {@const cp = change(cpuPer(imp.after) ?? 0, cpuPer(imp.before) ?? 0)}
                    <td class="r num nowrap">{pct(rate(imp.before))} → {pct(rate(imp.after))}{#if er.text && er.dir === 'up' && rate(imp.after) > 0.01}<span class="up"> ▲</span>{/if}</td>
                    <td class="r num nowrap">{ms(cpuPer(imp.before))} → {ms(cpuPer(imp.after))}{#if cp.text && cp.dir !== 'flat'}<span class="muted"> ({cp.text})</span>{/if}</td>
                    <td class="r num nowrap">{compact(imp.before.requests)} → {compact(imp.after.requests)}</td>
                  {:else}
                    <td class="r muted" colspan="3">Older than the hourly history</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="hint pad">Before and after compare the 24 hours either side of the deploy's hour. The newest deploy's "after" grows until a day has passed.</p>
      {:else}
        <p class="muted pad">No deploys in the last {RANGE_LABEL[range]}.</p>
      {/if}
    </article>

    <article class="card">
      <div class="section-head pad"><h2>Findings <span class="count">{open.length}</span></h2></div>
      {#if open.length}
        <ul class="list">
          {#each open as f (f.id)}
            <FindingRow finding={f} showWorker={false} onAcknowledge={(id) => act(onAcknowledge(id))} onSnooze={(id, d) => act(onSnooze(id, d))} onRestore={(id) => act(onRestore(id))} />
          {/each}
        </ul>
      {:else}
        <p class="muted pad">Nothing open for this Worker.</p>
      {/if}
      {#if resolved.length}
        <details class="resolved">
          <summary>{resolved.length} resolved in the last {RANGE_LABEL[range]}</summary>
          <ul class="list">
            {#each resolved as f (f.id)}
              <FindingRow finding={f} showWorker={false} compact onAcknowledge={() => {}} onSnooze={() => {}} />
            {/each}
          </ul>
        </details>
      {/if}
    </article>

    <div class="grid2">
      <article class="card">
        <div class="section-head pad"><h2>Changes</h2></div>
        {#if data.changes.length}
          <ul class="changes">
            {#each data.changes as c, i (i)}
              <li><time class="num muted" datetime={c.at}>{when(c.at)}</time><span>{c.detail ?? c.kind}</span></li>
            {/each}
          </ul>
        {:else}
          <p class="muted pad">No recorded changes in this range besides deploys.</p>
        {/if}
      </article>
      <article class="card">
        <div class="section-head pad"><h2>Configuration</h2></div>
        <dl class="conf">
          <div><dt>Entry points</dt><dd>{#each data.entryPoints as e (e)}<span class="mono">{e}</span>{:else}<span class="muted">None found</span>{/each}</dd></div>
          <div><dt>workers.dev</dt><dd>{data.workersDev == null ? '–' : data.workersDev ? 'On' : 'Off'}{#if data.previewsEnabled}{' '}· previews public{/if}</dd></div>
          <div><dt>Workers Logs</dt><dd>{data.logsEnabled == null ? '–' : data.logsEnabled ? 'On' : 'Off'}</dd></div>
          <div><dt>Usage model</dt><dd>{data.usageModel ?? '–'}</dd></div>
          {#if data.createdOn}<div><dt>Created</dt><dd>{new Date(data.createdOn).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</dd></div>{/if}
          <div>
            <dt>Bindings</dt>
            <dd>
              {#if data.bindings == null}<span class="muted">Read on a later scan</span>
              {:else if !data.bindings.length}<span class="muted">None</span>
              {:else}
                <ul class="bindings">{#each data.bindings as b (b.name)}<li><span class="mono">{b.name}</span> <span class="muted">{b.type.replace(/_/g, ' ')}{b.target ? ` → ${b.target}` : ''}</span></li>{/each}</ul>
              {/if}
            </dd>
          </div>
        </dl>
      </article>
    </div>
    <p class="hint">Times in UTC. {data.granularity === 'hour' ? 'One bar per hour' : 'One bar per day'}; the last one is still filling up. Updated after each scan.{#if data.series.length}{' '}Showing {bucketLabel(data.series[0].t, data.granularity, true)} to now.{/if}</p>
  {/if}
</section>

<style>
  .worker-page { display: grid; gap: 16px; min-width: 0; }
  /* Wide tables scroll inside their card instead of widening the page. */
  .worker-page > :global(*) { min-width: 0; }
  .back { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; text-decoration: none; color: var(--ink-muted); }
  .back :global(svg) { transform: rotate(180deg); }
  .back:hover { color: var(--ink); }
  h1.mono { font-size: 24px; word-break: break-all; }
  .note { font-size: 13px; color: var(--ink-muted); padding: 8px 12px; border: 1px dashed var(--line); border-radius: 8px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .stats > :global(*) { border-right: 1px solid var(--line); }
  .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .panel { padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  .panel h2, .section-head h2 { font-size: 16px; }
  .pad { padding: 14px 16px 0; }
  p.pad { padding-bottom: 14px; }
  .scroll { overflow-x: auto; }
  .t { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .t th, .t td { padding: 8px 16px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  .t th { font-size: 12px; font-weight: 600; color: var(--ink-muted); }
  .t .r { text-align: right; }
  .nowrap { white-space: nowrap; }
  tr.bad td:first-child { box-shadow: inset 3px 0 0 var(--critical); }
  .flag { display: block; font-size: 12px; color: var(--critical); font-weight: 600; }
  .up { color: var(--critical); }
  .list { list-style: none; margin: 8px 0 0; padding: 0; }
  .resolved { border-top: 1px solid var(--line); }
  .resolved summary { padding: 12px 16px; cursor: pointer; color: var(--ink-muted); font-size: 14px; }
  .changes { list-style: none; margin: 8px 0 0; padding: 0 16px 14px; display: grid; gap: 6px; font-size: 13px; max-height: 320px; overflow: auto; }
  .changes li { display: grid; grid-template-columns: 130px 1fr; gap: 10px; }
  .conf { margin: 8px 0 0; padding: 0 16px 14px; display: grid; gap: 8px; font-size: 13px; }
  .conf div { display: grid; grid-template-columns: 120px 1fr; gap: 10px; }
  .conf dt { color: var(--ink-muted); }
  .conf dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; min-width: 0; word-break: break-word; }
  .bindings { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .skeleton { height: 420px; background: linear-gradient(90deg, var(--surface), var(--row-tint), var(--surface)); background-size: 200% 100%; }
  @media (prefers-reduced-motion: no-preference) { .skeleton { animation: shimmer 1.2s linear infinite; } }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (max-width: 900px) { .grid2 { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 640px) { .changes li, .conf div { grid-template-columns: 1fr; gap: 2px; } }
</style>
