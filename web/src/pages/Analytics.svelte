<!-- Fleet analytics over 24 hours to 12 months: trends and movers, cost, limits and storage growth, -->
<!-- reliability (time to resolve, alert quality) and deploys. Every chart and table exports as CSV. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { AnalyticsView, MetricTotals, Range } from '../../../src/shared/types';
  import Chart from '../components/Chart.svelte';
  import Icon from '../components/Icon.svelte';
  import RangePicker from '../components/RangePicker.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import Stat from '../components/Stat.svelte';
  import { api, ApiError, bytes, change, compact, ms, num, pct, usd, workerHref } from '../lib/api';
  import { RANGE_LABEL, rangeParam, setParam } from '../lib/route';

  type Tab = 'trends' | 'cost' | 'limits' | 'reliability';
  let { params, account, query, onUnauthorized }: { params: URLSearchParams; account: string | null; query: string; onUnauthorized: () => void } = $props();

  let range = $state<Range>(untrack(() => rangeParam(params, '30d')));
  let tab = $state<Tab>(untrack(() => (['trends', 'cost', 'limits', 'reliability'].includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'trends')));
  let data = $state<AnalyticsView | null>(null);
  let error = $state('');

  async function load() {
    error = '';
    try {
      data = await api.analytics(range, account ?? undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else error = (e as Error).message;
    }
  }
  $effect(() => {
    void range; void account;
    load();
  });
  function pickRange(r: Range) {
    range = r;
    setParam('range', r);
  }
  function pickTab(t: Tab) {
    tab = t;
    setParam('tab', t === 'trends' ? null : t);
  }

  const rate = (t: MetricTotals) => (t.requests ? t.errors / t.requests : 0);
  const cpuPer = (t: MetricTotals) => (t.requests ? t.cpuTimeUs / 1000 / t.requests : null);
  const compare = $derived(`the ${RANGE_LABEL[range]} before`);
  const labels = $derived(data?.series.map((p) => p.t) ?? []);

  // Workers table: sortable, filtered by the header search.
  type Col = 'name' | 'requests' | 'change' | 'errors' | 'rate' | 'cpu' | 'sub' | 'limits';
  let sort = $state<{ col: Col; desc: boolean }>({ col: 'requests', desc: true });
  const value = (w: AnalyticsView['workers'][number], col: Col): number | string => {
    switch (col) {
      case 'name': return w.name;
      case 'requests': return w.totals.requests;
      case 'change': return w.previous.requests ? (w.totals.requests - w.previous.requests) / w.previous.requests : w.totals.requests ? Infinity : 0;
      case 'errors': return w.totals.errors;
      case 'rate': return rate(w.totals);
      case 'cpu': return cpuPer(w.totals) ?? -1;
      case 'sub': return w.totals.requests ? w.totals.subrequests / w.totals.requests : -1;
      case 'limits': return w.totals.exceeded;
    }
  };
  const rows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.workers ?? []).filter((w) => !q || w.name.toLowerCase().includes(q) || w.groups.some((g) => g.toLowerCase().includes(q)));
    return [...list].sort((a, b) => {
      const x = value(a, sort.col), y = value(b, sort.col);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  });
  function by(col: Col) {
    sort = sort.col === col ? { col, desc: !sort.desc } : { col, desc: col !== 'name' };
  }
  const aria = (col: Col) => (sort.col === col ? (sort.desc ? 'descending' : 'ascending') : 'none');

  // Movers: the biggest changes in requests against the period before.
  const movers = $derived.by(() => {
    const list = (data?.workers ?? []).filter((w) => w.totals.requests + w.previous.requests >= 100).map((w) => ({ w, delta: w.totals.requests - w.previous.requests }));
    return {
      up: list.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5),
      down: list.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5),
    };
  });

  function csv(name: string, head: string[], body: (string | number | null)[][]) {
    const esc = (c: string | number | null) => (c == null ? '' : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head, ...body].map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = `ambersight-${name}-${range}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const workersCsv = () => csv('workers', ['worker', 'requests', 'requests_before', 'errors', 'error_rate', 'cpu_ms_per_request', 'subrequests', 'limit_hits'],
    rows.map((w) => [w.name, w.totals.requests, w.previous.requests, w.totals.errors, rate(w.totals).toFixed(5), cpuPer(w.totals)?.toFixed(3) ?? null, w.totals.subrequests, w.totals.exceeded]));

  // Limits: how often each quota ran high.
  const quotaSummary = (q: AnalyticsView['quotas'][number]) => {
    if (!q.limit) return null;
    const shares = q.days.map((d) => d.value / q.limit!);
    const peak = Math.max(0, ...shares);
    const hours = q.days.map((d) => d.peakHour).filter(Boolean) as string[];
    const usual = hours.length ? [...hours.reduce((m, h) => m.set(h, (m.get(h) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0][0] : null;
    return { peak, over70: shares.filter((s) => s >= 0.7).length, over90: shares.filter((s) => s >= 0.9).length, ranOut: shares.filter((s) => s >= 1).length, usual };
  };
  const capDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  // Reliability: checks people mostly silence are candidates to tune or turn off.
  const noisy = (c: AnalyticsView['reliability']['checks'][number]) => c.opened >= 3 && (c.acknowledged + c.snoozed) / c.opened >= 0.5;
  const sevLabel = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;
  const hours = (h: number | null) => (h == null ? '–' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${(h / 24).toFixed(1)} days`);
  const relTotals = $derived(data ? data.reliability.days.reduce((t, d) => ({ opened: t.opened + d.opened, resolved: t.resolved + d.resolved }), { opened: 0, resolved: 0 }) : { opened: 0, resolved: 0 });
</script>

<section class="analytics">
  <div class="page-head">
    <div>
      <h1>Analytics</h1>
      <p>{data?.historyStart ? `History from ${capDay(data.historyStart)}. ` : ''}Read from Ambersight's own database: no extra Cloudflare API calls.</p>
    </div>
    <RangePicker value={range} onChange={pickRange} />
  </div>

  <div class="seg tabs" role="tablist" aria-label="Analytics views">
    {#each [['trends', 'Trends'], ['cost', 'Cost'], ['limits', 'Limits and storage'], ['reliability', 'Reliability']] as [id, label] (id)}
      <button type="button" role="tab" aria-selected={tab === id} onclick={() => pickTab(id as Tab)}>{label}</button>
    {/each}
  </div>

  {#if error}
    <div class="card empty" role="alert"><p>{error}</p><button type="button" onclick={load}>Try again</button></div>
  {:else if !data}
    <div class="skeleton card" aria-label="Loading"></div>
  {:else if !data.historyStart}
    <div class="card empty"><span class="empty-icon"><Icon name="chart" size={24} /></span><p>No history yet. Charts fill in after the first scans; daily history builds up from there for 13 months.</p></div>
  {:else if tab === 'trends'}
    {#if data.historyStart > data.from.slice(0, 10) || data.historyStart > new Date(Date.parse(data.from) - (Date.parse(data.to) - Date.parse(data.from))).toISOString().slice(0, 10)}
      <p class="note">History starts on {capDay(data.historyStart)}, so the comparison with {compare} is partial: changes look larger than they are.</p>
    {/if}
    <div class="stats card">
      <Stat label="Requests" value={compact(data.totals.requests)} now={data.totals.requests} before={data.previous.requests} {compare} />
      <Stat label="Errors" value={compact(data.totals.errors)} now={data.totals.errors} before={data.previous.errors} upIsBad {compare} />
      <Stat label="Error rate" value={pct(rate(data.totals))} now={rate(data.totals)} before={rate(data.previous)} upIsBad {compare} />
      <Stat label="CPU per request" value={ms(cpuPer(data.totals))} now={cpuPer(data.totals)} before={cpuPer(data.previous)} upIsBad {compare} />
      <Stat label="Subrequests" value={compact(data.totals.subrequests)} now={data.totals.subrequests} before={data.previous.subrequests} upIsBad {compare} />
      <Stat label="Limit hits" value={num(data.totals.exceeded)} now={data.totals.exceeded} before={data.previous.exceeded} upIsBad {compare} />
    </div>
    <div class="grid2">
      <article class="card panel">
        <h2>Requests and errors, whole account</h2>
        <Chart {labels} granularity={data.granularity} title="Requests and errors" csvName="ambersight-fleet-{range}"
          series={[
            { label: 'Requests', values: data.series.map((p) => p.requests), tone: 'muted', kind: 'bar' },
            { label: 'Errors', values: data.series.map((p) => p.errors), tone: 'critical', kind: 'bar' },
          ]}
          format={compact} />
      </article>
      <article class="card panel">
        <h2>Error rate and CPU per request</h2>
        <Chart {labels} granularity={data.granularity} title="Error rate" csvName="ambersight-error-rate-{range}"
          series={[{ label: 'Error rate', values: data.series.map((p) => (p.requests ? p.errors / p.requests : null)), tone: 'critical', kind: 'area' }]}
          format={(v) => pct(v)} height={120} />
        <Chart {labels} granularity={data.granularity} title="CPU per request" csvName="ambersight-cpu-{range}"
          series={[{ label: 'CPU per request', values: data.series.map((p) => (p.requests ? p.cpuTimeUs / 1000 / p.requests : null)), tone: 'accent' }]}
          format={(v) => ms(v)} height={120} />
      </article>
    </div>
    <div class="grid2">
      {#each [['Growing fastest', movers.up], ['Shrinking fastest', movers.down]] as [title, list] (title)}
        <article class="card panel">
          <h2>{title}</h2>
          {#if (list as typeof movers.up).length}
            <ol class="movers">
              {#each list as typeof movers.up as m (m.w.name)}
                {@const c = change(m.w.totals.requests, m.w.previous.requests)}
                <li><a class="mono" href={workerHref(m.w.name)}>{m.w.name}</a><span class="num muted">{compact(m.w.previous.requests)} → {compact(m.w.totals.requests)}</span><strong class="num {c.dir}">{c.text}</strong></li>
              {/each}
            </ol>
          {:else}<p class="muted">No Worker changed by much against {compare}.</p>{/if}
        </article>
      {/each}
    </div>
    <article class="card">
      <div class="section-head pad">
        <h2>Workers <span class="count">{rows.length}</span></h2>
        <button type="button" class="ghost" onclick={workersCsv}><Icon name="download" size={16} /> CSV</button>
      </div>
      <div class="scroll">
        <table class="t">
          <thead>
            <tr>
              {#each [['name', 'Worker'], ['requests', 'Requests'], ['change', 'Change'], ['errors', 'Errors'], ['rate', 'Error rate'], ['cpu', 'CPU / request'], ['sub', 'Subreq. / request'], ['limits', 'Limit hits']] as [col, label] (col)}
                <th class:r={col !== 'name'} aria-sort={aria(col as Col)}><button type="button" class="sort" onclick={() => by(col as Col)}>{label}{#if sort.col === col}<span aria-hidden="true">{sort.desc ? ' ↓' : ' ↑'}</span>{/if}</button></th>
              {/each}
              <th class="spark-col">Trend</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as w (w.name)}
              {@const c = change(w.totals.requests, w.previous.requests)}
              {@const er = rate(w.totals)}
              <tr>
                <td><a class="mono" href="{workerHref(w.name)}?range={range}">{w.name}</a>{#each w.groups as g (g)} <span class="tag-chip">{g}</span>{/each}</td>
                <td class="r num">{num(w.totals.requests)}</td>
                <td class="r num {c.dir}">{c.text}</td>
                <td class="r num">{num(w.totals.errors)}</td>
                <td class="r num" class:hot={er >= 0.02}>{pct(er)}</td>
                <td class="r num">{ms(cpuPer(w.totals))}</td>
                <td class="r num">{w.totals.requests ? (w.totals.subrequests / w.totals.requests).toFixed(2) : '–'}</td>
                <td class="r num" class:hot={w.totals.exceeded > 0}>{num(w.totals.exceeded)}</td>
                <td class="spark-col"><Sparkline values={w.spark} label="Requests for {w.name}" height={24} /></td>
              </tr>
            {:else}
              <tr><td colspan="9" class="muted">No Worker matches.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>
  {:else if tab === 'cost'}
    {#if !data.cost}
      <div class="card empty"><span class="empty-icon"><Icon name="budget" size={24} /></span><p>This account is on Workers Free: there is no bill. The risk on Free is running out of a daily limit; see <button type="button" class="linkish" onclick={() => pickTab('limits')}>Limits and storage</button>.</p></div>
    {:else}
      <div class="grid2">
        <article class="card panel">
          <h2>Bill per month</h2>
          <Chart labels={data.cost.months.map((m) => `${m.month}-01`)} granularity="day" title="Estimated bill per month" csvName="ambersight-bill-by-month"
            series={[{ label: 'Estimated bill', values: data.cost.months.map((m) => m.amount), tone: 'accent', kind: 'bar' }]} format={usd} />
          <p class="hint">Estimated from usage at list prices of {data.cost.pricesAsOf}, with the monthly included usage and the $5 subscription. Months Ambersight did not watch in full are partial.</p>
        </article>
        <article class="card panel">
          <h2>Usage at list price per day</h2>
          <Chart labels={data.cost.days.map((d) => d.day)} granularity="day" title="Usage at list price per day" csvName="ambersight-cost-by-day-{range}"
            series={[{ label: 'List price', values: data.cost.days.map((d) => d.amount), tone: 'accent', kind: 'bar' }]} format={usd} />
          <p class="hint">Before included usage, so a day here can cost nothing on the bill. Use it to see which days drive the spend.</p>
        </article>
      </div>
      <article class="card">
        <div class="section-head pad">
          <h2>Workers by cost, scaled to a month</h2>
          <button type="button" class="ghost" onclick={() => csv('cost-by-worker', ['worker', 'usd_per_month', 'usd_per_million_requests'], data!.cost!.perWorker.map((w) => [w.name, w.amount, w.perMillion]))}><Icon name="download" size={16} /> CSV</button>
        </div>
        <table class="t">
          <thead><tr><th>Worker</th><th class="r">Per month at this pace</th><th class="r">Per million requests</th></tr></thead>
          <tbody>
            {#each data.cost.perWorker as w (w.name)}
              <tr><td><a class="mono" href={workerHref(w.name)}>{w.name}</a></td><td class="r num">{usd(w.amount)}</td><td class="r num">{w.perMillion == null ? '–' : usd(w.perMillion)}</td></tr>
            {:else}<tr><td colspan="3" class="muted">No Worker cost more than a cent in this range.</td></tr>{/each}
          </tbody>
        </table>
        <p class="hint pad">Requests and CPU time at list price. Storage, KV, D1 and other products are billed per account, so they are in the monthly bill, not here.</p>
      </article>
    {/if}
  {:else if tab === 'limits'}
    <div class="quota-grid">
      {#each data.quotas as q (q.metric)}
        {@const s = quotaSummary(q)}
        <article class="card panel">
          <h2>{q.label}</h2>
          <Chart labels={q.days.map((d) => d.day)} granularity="day" title="{q.label} per day" height={140} csvName="ambersight-{q.metric}-{range}"
            limit={q.limit ? { value: q.limit, label: 'Free daily limit' } : null}
            series={[{ label: q.label, values: q.days.map((d) => d.value), tone: s && s.peak >= 0.9 ? 'critical' : s && s.peak >= 0.7 ? 'warning' : 'muted', kind: 'bar' }]}
            format={compact} />
          {#if s}
            <p class="hint">
              Peak {pct(s.peak)} of the limit.
              {#if s.ranOut}<strong class="bad">Ran out on {s.ranOut} {s.ranOut === 1 ? 'day' : 'days'}.</strong>{:else if s.over90}{s.over90} {s.over90 === 1 ? 'day' : 'days'} above 90%.{:else if s.over70}{s.over70} {s.over70 === 1 ? 'day' : 'days'} above 70%.{:else}Never above 70%.{/if}
              {#if s.usual}Usually busiest at {s.usual} UTC.{/if}
            </p>
          {/if}
        </article>
      {:else}
        <div class="card empty"><p>No daily usage recorded yet.</p></div>
      {/each}
    </div>
    <article class="card">
      <div class="section-head pad">
        <h2>Storage growth</h2>
        <button type="button" class="ghost" onclick={() => csv('storage', ['kind', 'name', 'bytes', 'bytes_per_day', 'limit', 'reaches_limit'], data!.storage.map((s) => [s.kind, s.label, s.bytes, s.growthPerDay == null ? null : Math.round(s.growthPerDay), s.limit, s.capDate]))}><Icon name="download" size={16} /> CSV</button>
      </div>
      <div class="scroll">
        <table class="t">
          <thead><tr><th>Storage</th><th class="r">Size</th><th class="r">Growth per day</th><th class="r">Limit</th><th class="r">Reaches it around</th><th class="spark-col">Size</th></tr></thead>
          <tbody>
            {#each data.storage as s (`${s.kind}|${s.id}`)}
              <tr>
                <td><span class="tag-chip">{s.kind.toUpperCase()}</span> {s.label}</td>
                <td class="r num">{bytes(s.bytes)}</td>
                <td class="r num">{s.growthPerDay == null ? '–' : `${s.growthPerDay >= 0 ? '+' : '−'}${bytes(Math.abs(s.growthPerDay))}`}</td>
                <td class="r num">{s.limit ? bytes(s.limit) : 'None'}</td>
                <td class="r num" class:hot={!!s.capDate}>{s.capDate ? capDay(s.capDate) : '–'}</td>
                <td class="spark-col">{#if s.days.length > 1}<Sparkline values={s.days.map((d) => d.bytes)} label="Size of {s.label}" height={24} hot={!!s.capDate} />{/if}</td>
              </tr>
            {:else}<tr><td colspan="6" class="muted">Storage sizes are read once a day; the first ones appear after the next daily refresh.</td></tr>{/each}
          </tbody>
        </table>
      </div>
      <p class="hint pad">Growth is the average over the last 30 days of daily sizes. "Reaches it around" assumes that pace continues.</p>
    </article>
  {:else}
    <div class="stats card">
      <Stat label="Findings opened" value={num(relTotals.opened)} />
      <Stat label="Resolved" value={num(relTotals.resolved)} />
      {#each ['critical', 'warning', 'info'] as const as s (s)}
        <Stat label="Time to resolve, {sevLabel[s].toLowerCase()}" value={hours(data.reliability.mttrHours[s])} hint="median" />
      {/each}
    </div>
    <div class="grid2">
      <article class="card panel">
        <h2>Opened and resolved per day</h2>
        <Chart labels={data.reliability.days.map((d) => d.day)} granularity="day" title="Findings opened and resolved per day" csvName="ambersight-findings-{range}"
          series={[
            { label: 'Opened', values: data.reliability.days.map((d) => d.opened), tone: 'warning', kind: 'bar' },
            { label: 'Resolved', values: data.reliability.days.map((d) => d.resolved), tone: 'healthy', kind: 'bar' },
          ]} format={num} />
      </article>
      <article class="card panel">
        <h2>Deploys per day</h2>
        {#if data.deploys.length}
          {@const days = data.reliability.days.map((d) => d.day)}
          {@const by = new Map(data.deploys.map((d) => [d.day, d]))}
          <Chart labels={days} granularity="day" title="Deploys per day" stacked csvName="ambersight-deploys-{range}"
            series={[
              { label: 'Deploys', values: days.map((d) => (by.get(d)?.count ?? 0) - (by.get(d)?.followedByFinding ?? 0)), tone: 'muted', kind: 'bar' },
              { label: 'Followed by a finding within 2 h', values: days.map((d) => by.get(d)?.followedByFinding ?? 0), tone: 'critical', kind: 'bar' },
            ]} format={num} />
        {:else}<p class="muted">No deploys recorded in this range.</p>{/if}
      </article>
    </div>
    <article class="card">
      <div class="section-head pad">
        <h2>Alert quality by check</h2>
        <button type="button" class="ghost" onclick={() => csv('alert-quality', ['check', 'opened', 'alerted', 'acknowledged', 'snoozed', 'resolved', 'reopened', 'median_open_hours'], data!.reliability.checks.map((c) => [c.check, c.opened, c.alerted, c.acknowledged, c.snoozed, c.resolved, c.reopened, c.medianOpenHours]))}><Icon name="download" size={16} /> CSV</button>
      </div>
      <div class="scroll">
        <table class="t">
          <thead><tr><th>Check</th><th class="r">Opened</th><th class="r">Alerts sent</th><th class="r">Acknowledged</th><th class="r">Snoozed</th><th class="r">Resolved</th><th class="r">Came back</th><th class="r">Open for</th></tr></thead>
          <tbody>
            {#each data.reliability.checks as c (c.check)}
              <tr>
                <td><span class="mono">{c.check}</span>{#if noisy(c)}<span class="flag" title="Most of these were acknowledged or snoozed rather than fixed">Mostly silenced: raise its threshold or turn it off in Settings › Checks</span>{/if}</td>
                <td class="r num">{c.opened}</td><td class="r num">{c.alerted}</td><td class="r num">{c.acknowledged}</td><td class="r num">{c.snoozed}</td>
                <td class="r num">{c.resolved}</td><td class="r num" class:hot={c.reopened > 1}>{c.reopened}</td><td class="r num">{hours(c.medianOpenHours)}</td>
              </tr>
            {:else}<tr><td colspan="8" class="muted">No findings opened or closed in this range.</td></tr>{/each}
          </tbody>
        </table>
      </div>
      <p class="hint pad">"Open for" is the median time from open to resolved. A check whose findings are mostly acknowledged or snoozed is noise to you: tune it so the alerts that remain are worth reading.</p>
    </article>
  {/if}
</section>

<style>
  .analytics { display: grid; gap: 16px; min-width: 0; }
  /* Wide tables scroll inside their card instead of widening the page. */
  .analytics > :global(*) { min-width: 0; }
  .tabs { width: fit-content; max-width: 100%; overflow-x: auto; }
  .note { font-size: 13px; color: var(--ink-muted); padding: 8px 12px; border: 1px dashed var(--line); border-radius: 8px; }
  .tabs button[aria-selected='true'] { background: var(--chip); color: var(--chip-text); font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .stats > :global(*) { border-right: 1px solid var(--line); }
  .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .quota-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .panel { padding: 16px; display: grid; gap: 8px; align-content: start; min-width: 0; }
  .panel h2, .section-head h2 { font-size: 16px; }
  .pad { padding: 14px 16px 0; }
  p.pad { padding-bottom: 14px; }
  .section-head .ghost { min-height: 30px; font-size: 13px; }
  .scroll { overflow-x: auto; }
  .t { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .t th, .t td { padding: 7px 16px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
  .t th { font-size: 12px; font-weight: 600; color: var(--ink-muted); white-space: nowrap; }
  .t .r { text-align: right; }
  .t tbody tr:hover { background: var(--row-tint); }
  .sort { min-height: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
  .sort:hover { color: var(--ink); }
  .spark-col { width: 120px; }
  .up { color: var(--critical); }
  td.up, .movers .up { color: var(--ink); }
  .hot { color: var(--critical); font-weight: 600; }
  .bad { color: var(--critical); }
  .flag { display: block; font-size: 12px; color: var(--warning-text); }
  .movers { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
  .movers li { display: grid; grid-template-columns: 1fr auto 64px; gap: 10px; align-items: baseline; }
  .movers a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .movers strong { text-align: right; }
  .linkish { display: inline; min-height: 0; padding: 0; border: 0; background: none; color: var(--accent-text); text-decoration: underline; font-size: inherit; }
  .skeleton { height: 420px; background: linear-gradient(90deg, var(--surface), var(--row-tint), var(--surface)); background-size: 200% 100%; }
  @media (prefers-reduced-motion: no-preference) { .skeleton { animation: shimmer 1.2s linear infinite; } }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (max-width: 900px) { .grid2 { grid-template-columns: minmax(0, 1fr); } }
</style>
