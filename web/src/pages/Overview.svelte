<!-- Overview: fleet status and budget, traffic, ranked findings, then every Worker. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { Overview, Severity, WorkerSummary } from '../../../src/shared/types';
  import BudgetMeter from '../components/BudgetMeter.svelte';
  import CostPanel from '../components/CostPanel.svelte';
  import LimitsPanel from '../components/LimitsPanel.svelte';
  import { checkOf, groupFindings } from '../../../src/shared/findings';
  import { fmtBytes } from '../../../src/shared/limits';
  import FindingGroup from '../components/FindingGroup.svelte';
  import FindingRow from '../components/FindingRow.svelte';
  import FleetMap from '../components/FleetMap.svelte';
  import GroupFilter from '../components/GroupFilter.svelte';
  import Icon from '../components/Icon.svelte';
  import TrendBars from '../components/TrendBars.svelte';
  import WorkerCard from '../components/WorkerCard.svelte';
  import WorkerTable from '../components/WorkerTable.svelte';
  import { compact, num, pct, timeAgo, workerHref, workerId } from '../lib/api';
  import { download } from '../lib/download';
  import { findingsMarkdown } from '../lib/exportMd';
  import { loadPrefs, savePrefs } from '../lib/prefs';

  let { data, query, scanInterval, mutedChecks = [], onAcknowledge, onSnooze, onBulk, onMute }: {
    data: Overview;
    query: string;
    /** Minutes between scans, from the config; null when unknown. */
    scanInterval: number | null;
    /** Checks switched off; hidden right away, resolved by the next scan. */
    mutedChecks?: string[];
    onAcknowledge: (id: string) => void;
    onSnooze: (id: string, days: 7 | 30 | 90) => void;
    onBulk: (ids: string[], action: 'acknowledge' | 'snooze', days?: 7 | 30 | 90) => void;
    onMute: (check: string) => void;
  } = $props();

  type Sort = 'attention' | 'requests' | 'errors' | 'name';
  type Layout = 'grid' | 'table';
  const prefs = loadPrefs('ambersight-workers-view', { sort: 'attention' as Sort, layout: 'grid' as Layout, group: '' });
  let sort = $state<Sort>(prefs.sort);
  let layout = $state<Layout>(prefs.layout);
  let group = $state(prefs.group);
  let severity = $state<'all' | Severity>('all');
  let showHealthy = $state(false);
  let showHousekeeping = $state(false);
  $effect(() => savePrefs('ambersight-workers-view', { sort, layout, group }));
  // A group that no longer exists (renamed in Settings) falls back to all.
  $effect(() => {
    if (group && !data.groups.includes(group)) group = '';
  });

  const SORTS: Record<Sort, (a: WorkerSummary, b: WorkerSummary) => number> = {
    attention: (a, b) => b.score - a.score || (b.latestFindingAt ?? '').localeCompare(a.latestFindingAt ?? '') || b.requests24h - a.requests24h || a.name.localeCompare(b.name),
    requests: (a, b) => b.requests24h - a.requests24h || a.name.localeCompare(b.name),
    errors: (a, b) => b.errors24h - a.errors24h || b.requests24h - a.requests24h || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
  };

  const q = $derived(query.trim().toLowerCase());
  // Everything below is scoped to the selected group.
  const scoped = $derived(group ? data.workers.filter((w) => w.groups?.includes(group)) : data.workers);
  const scopedNames = $derived(new Set(scoped.map((w) => w.name)));
  const muted = $derived(new Set(mutedChecks));
  const scopedFindings = $derived(
    data.findings.filter((f) => (f.script === '*' ? !group : scopedNames.has(f.script)) && !muted.has(checkOf(f))),
  );
  const findings = $derived(
    scopedFindings.filter(
      (f) => (severity === 'all' || f.severity === severity) && (!q || f.script.toLowerCase().includes(q) || f.message.toLowerCase().includes(q)),
    ),
  );
  // One row per check: critical and warning groups first, info ("housekeeping") collapsed below.
  const groups = $derived(groupFindings(findings));
  const urgent = $derived(groups.filter((g) => g.severity !== 'info'));
  const housekeeping = $derived(groups.filter((g) => g.severity === 'info'));
  const housekeepingCount = $derived(housekeeping.reduce((n, g) => n + g.findings.length, 0));
  const housekeepingOpen = $derived(showHousekeeping || severity === 'info' || Boolean(q));
  const workers = $derived(scoped.filter((w) => !q || w.name.toLowerCase().includes(q)).sort(SORTS[sort]));
  const hot = $derived(workers.filter((w) => w.score > 0));
  const healthyCount = $derived(workers.length - hot.length);
  // Healthy Workers stay collapsed unless asked for, or a search is narrowing the list.
  const shown = $derived(showHealthy || q ? workers : hot);

  const counts = $derived({
    critical: scopedFindings.filter((f) => f.severity === 'critical').length,
    warning: scopedFindings.filter((f) => f.severity === 'warning').length,
    info: scopedFindings.filter((f) => f.severity === 'info').length,
  });
  const fleet = $derived.by(() => {
    const c = { critical: 0, warning: 0, info: 0, healthy: 0 };
    for (const w of scoped) c[w.topFinding?.severity ?? 'healthy']++;
    return c;
  });
  const needAttention = $derived(scoped.filter((w) => w.score > 0).length);
  const tone = $derived(counts.critical ? 'critical' : needAttention > 0 || counts.warning ? 'warning' : 'healthy');
  const trend = $derived.by(() => {
    const out = Array<number>(7).fill(0);
    for (const w of scoped) w.spark.forEach((v, i) => (out[i] += v));
    return out;
  });
  const weekTotal = $derived(trend.reduce((a, b) => a + b, 0));
  // Account-wide numbers are "today" (since midnight UTC); a group view sums each Worker's last 24 hours.
  const requests = $derived(group ? scoped.reduce((s, w) => s + w.requests24h, 0) : data.totals.requestsToday);
  const errors = $derived(group ? scoped.reduce((s, w) => s + w.errors24h, 0) : data.totals.errorsToday);
  const period = $derived(group ? 'last 24 h' : 'today');
  const errorSources = $derived(scoped.filter((w) => w.errors24h > 0).sort((a, b) => b.errors24h - a.errors24h).slice(0, 4));
  const errorMax = $derived(Math.max(1, ...errorSources.map((w) => w.errors24h)));
  const interval = $derived(
    scanInterval == null ? null : scanInterval % 1440 === 0 ? `${scanInterval / 1440 === 1 ? 'day' : `${scanInterval / 1440} days`}` : scanInterval % 60 === 0 ? (scanInterval === 60 ? 'hour' : `${scanInterval / 60} hours`) : `${scanInterval} min`,
  );
  const top = $derived(scopedFindings[0]);

  // Export: every finding in the current group scope, whatever the severity filter or search shows.
  const allGroups = $derived(groupFindings(scopedFindings));
  function exportMd(kind: 'attention' | 'housekeeping') {
    const list = allGroups.filter((g) => (kind === 'housekeeping' ? g.severity === 'info' : g.severity !== 'info'));
    // The summary is account-wide, so it is left out of an export limited to one group.
    const summary = kind === 'housekeeping' && !group ? hkSummary : '';
    const md = findingsMarkdown({ title: kind === 'housekeeping' ? 'Housekeeping' : 'Needs attention', groups: list, account: data.account, scope: group || undefined, summary });
    const slug = (data.account?.label ?? 'account').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
    download(`ambersight-${kind === 'housekeeping' ? 'housekeeping' : 'needs-attention'}-${slug}-${new Date().toISOString().slice(0, 10)}.md`, md);
  }
  const attentionExportable = $derived(allGroups.some((g) => g.severity !== 'info'));
  const PRODUCT = { d1: 'D1', kv: 'KV', r2: 'R2', do: 'Durable Objects' } as const;
  // "Removing the unused storage below frees 120 MB of D1 (2.4% of the allowance). 3 resolved in the last 7 days."
  const hkSummary = $derived.by(() => {
    const h = data.housekeeping;
    if (!h) return '';
    const parts: string[] = [];
    if (h.frees.length) {
      const each = h.frees.map((f) => `${fmtBytes(f.bytes)} of ${PRODUCT[f.kind]}${f.share != null && f.share >= 0.01 ? ` (${pct(f.share)} of the allowance)` : ''}`);
      const saving = h.monthlySaving ? `, about $${h.monthlySaving.toFixed(2)} a month` : '';
      parts.push(`Removing the unused storage below frees ${each.join(', ')}${saving}.`);
    }
    if (h.resolvedThisWeek) parts.push(`${num(h.resolvedThisWeek)} resolved in the last 7 days.`);
    return parts.join(' ');
  });
  const housekeepingExportable = $derived(allGroups.some((g) => g.severity === 'info'));
</script>

{#if data.groups.length}
  <div class="scope">
    <GroupFilter groups={data.groups} bind:value={group} />
    {#if group}<span class="muted scope-note">Showing {num(scoped.length)} of {num(data.workers.length)} Workers in <strong>{group}</strong>. The request budget stays account-wide.</span>{/if}
  </div>
{/if}

<div class="hero" class:solo={!data.budget}>
  <section class="card status {tone}" aria-labelledby="status-title">
    <div class="status-head">
      <span class="status-icon"><Icon name={tone === 'healthy' ? 'healthy' : tone} size={24} /></span>
      <div>
        <p class="eyebrow muted">{group ? `Group · ${group}` : 'Fleet status'}</p>
        <h1 id="status-title">
          {#if !data.lastScanAt}Waiting for the first scan
          {:else if needAttention}{num(needAttention)} of {num(scoped.length)} Workers need attention
          {:else}All {num(scoped.length)} Workers look healthy{/if}
        </h1>
      </div>
    </div>
    {#if scoped.length}
      <div class="map-area">
        <FleetMap workers={scoped} />
        {#if top}
          <a class="urgent {top.severity}" href={top.script === '*' ? '#attention-title' : workerHref(top.script)}>
            <Icon name={top.severity} size={16} />
            <span><span class="urgent-label">Most urgent</span> <span class="mono">{top.script === '*' ? 'Account' : top.script}</span> · {top.message}</span>
          </a>
        {/if}
      </div>
      <div class="status-foot">
        <ul class="legend muted" aria-label="Fleet map legend">
          {#each [['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info'], ['healthy', 'Healthy']] as const as [k, label] (k)}
            {#if k === 'healthy' || fleet[k]}<li><span class="swatch {k}"></span>{label} <span class="num">{fleet[k]}</span></li>{/if}
          {/each}
        </ul>
        <span class="foot-right">
          {#if data.account}
            {@const a = encodeURIComponent(data.account.id)}
            <span class="report muted">
              Report:
              <a href="/api/report?account={a}&days=7" target="_blank" rel="noopener">7 days</a> ·
              <a href="/api/report?account={a}&days=30" target="_blank" rel="noopener">30 days</a>
            </span>
          {/if}
          {#if interval}<span class="next muted">Scans every {interval}</span>{/if}
        </span>
      </div>
    {/if}
  </section>
  {#if data.budget}<BudgetMeter budget={data.budget} />{/if}
</div>

<div class="kpis">
  <section class="card kpi" aria-labelledby="req-title">
    <div>
      <h2 id="req-title" class="kpi-label">Requests {period}</h2>
      <p class="kpi-value">{num(requests)}</p>
      <p class="kpi-sub muted">{compact(weekTotal)} in the last 7 days</p>
    </div>
    <TrendBars values={trend} unit="requests" label="Requests per day, last 7 days" />
  </section>

  <section class="card kpi" aria-labelledby="err-title">
    <div>
      <h2 id="err-title" class="kpi-label">Errors {period}</h2>
      <p class="kpi-value" class:bad={errors > 0}>{num(errors)}</p>
      <p class="kpi-sub muted">{pct(errors / Math.max(1, requests))} of requests failed</p>
    </div>
    {#if errorSources.length}
      <div class="sources">
        <p class="sources-title muted">Top sources · 24 h</p>
        <ul>
          {#each errorSources as w (w.name)}
            <li>
              <a class="mono" href={workerHref(w.name)}>{w.name}</a>
              <span class="bar-track"><span class="bar" class:hot={w.topFinding?.severity === 'critical'} style="width: {(w.errors24h / errorMax) * 100}%"></span></span>
              <span class="num">{num(w.errors24h)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="clean"><Icon name="healthy" size={20} /> No errors in the last 24 hours.</p>
    {/if}
  </section>
</div>

{#if !group}
  {@const capped = (data.storage ?? []).some((s) => s.limit != null)}
  {@const showLimits = (data.quotas ?? []).length > 0 || capped}
  {#if showLimits || data.cost}
    <div class="extras" class:pair={showLimits && data.cost}>
      {#if showLimits}<LimitsPanel quotas={data.quotas ?? []} storage={data.storage ?? []} paid={data.account?.plan === 'paid'} warnAt={data.budget?.warnAt} criticalAt={data.budget?.criticalAt} />{/if}
      {#if data.cost}<CostPanel cost={data.cost} />{/if}
    </div>
  {/if}
{/if}

<section aria-labelledby="attention-title">
  <div class="section-head">
    <h2 id="attention-title">Needs attention <span class="count">{scopedFindings.length}</span></h2>
    <div class="head-actions">
    {#if attentionExportable}
      <button type="button" class="export" title="Critical and warning findings as a Markdown checklist" onclick={() => exportMd('attention')}><Icon name="download" size={14} /> Export .md</button>
    {/if}
    <div class="seg" role="group" aria-label="Filter by severity">
      <button type="button" aria-pressed={severity === 'all'} onclick={() => (severity = 'all')}>All</button>
      <button type="button" aria-pressed={severity === 'critical'} onclick={() => (severity = 'critical')}>Critical <span class="num">{counts.critical}</span></button>
      <button type="button" aria-pressed={severity === 'warning'} onclick={() => (severity = 'warning')}>Warning <span class="num">{counts.warning}</span></button>
      <button type="button" aria-pressed={severity === 'info'} onclick={() => (severity = 'info')}>Info <span class="num">{counts.info}</span></button>
    </div>
    </div>
  </div>
  {#snippet groupList(list: typeof groups)}
    <ul class="card list">
      {#each list as g (g.check)}
        {#if g.findings.length === 1}
          <FindingRow finding={g.findings[0]} {onAcknowledge} {onSnooze} />
        {:else}
          <FindingGroup group={g} {onAcknowledge} {onSnooze} {onBulk} {onMute} />
        {/if}
      {/each}
    </ul>
  {/snippet}
  {#if findings.length}
    {#if urgent.length}{@render groupList(urgent)}{/if}
    {#if housekeeping.length}
      <div class="housekeeping" class:spaced={urgent.length > 0}>
        <div class="hk-head">
        <button type="button" class="hk-toggle" aria-expanded={housekeepingOpen} onclick={() => (showHousekeeping = !showHousekeeping)} disabled={severity === 'info' || Boolean(q)}>
          <span class="caret" class:open={housekeepingOpen}><Icon name="chevron" size={12} /></span>
          Housekeeping <span class="count">{num(housekeepingCount)}</span>
          <span class="muted hk-note">Info only: tidy-ups and things to confirm. Nothing here is urgent.</span>
        </button>
        {#if housekeepingExportable}
          <button type="button" class="export" title="Housekeeping findings and cleanup commands as Markdown" onclick={() => exportMd('housekeeping')}><Icon name="download" size={14} /> Export .md</button>
        {/if}
        </div>
        {#if hkSummary}<p class="muted hk-summary">{hkSummary}</p>{/if}
        {#if housekeepingOpen}{@render groupList(housekeeping)}{/if}
      </div>
    {/if}
  {:else}
    <div class="card empty">
      <span class="empty-icon"><Icon name="healthy" size={28} /></span>
      <p>
        {#if data.lastScanAt}
          {scopedFindings.length ? 'Nothing matches this filter.' : `All ${scoped.length} Workers look healthy.`}
        {:else}
          The first scan has not run yet. Press Scan now, or wait for the next scheduled scan.
        {/if}
      </p>
    </div>
  {/if}
</section>

<section aria-labelledby="workers-title">
  <div class="section-head">
    <h2 id="workers-title">{group ? `Workers in ${group}` : 'All Workers'} <span class="count">{workers.length}</span></h2>
    <div class="tools">
      <label class="select-pill">
        <span class="muted">Sort</span>
        <select bind:value={sort}>
          <option value="attention">Attention</option>
          <option value="requests">Requests</option>
          <option value="errors">Errors</option>
          <option value="name">Name</option>
        </select>
      </label>
      <div class="seg icons" role="group" aria-label="Layout">
        <button type="button" aria-pressed={layout === 'grid'} aria-label="Cards" title="Cards" onclick={() => (layout = 'grid')}><Icon name="grid" size={16} /></button>
        <button type="button" aria-pressed={layout === 'table'} aria-label="Table" title="Table" onclick={() => (layout = 'table')}><Icon name="list" size={16} /></button>
      </div>
    </div>
  </div>
  {#if !workers.length}
    <p class="card empty muted">{q ? `No Workers match “${query.trim()}”.` : 'No Workers found yet.'}</p>
  {:else}
    {#if shown.length}
      {#if layout === 'table'}
        <WorkerTable workers={shown} />
      {:else}
        <div class="grid">
          {#each shown as worker (worker.name)}<WorkerCard {worker} />{/each}
        </div>
      {/if}
    {/if}
    {#if healthyCount && !q}
      <button type="button" class="healthy-toggle" class:alone={!shown.length} aria-expanded={showHealthy} onclick={() => (showHealthy = !showHealthy)}>
        <span class="ht-icon"><Icon name="healthy" size={16} /></span>
        <span class="ht-text">
          {#if showHealthy}Hide {num(healthyCount)} healthy {healthyCount === 1 ? 'Worker' : 'Workers'}
          {:else}{num(healthyCount)} healthy {healthyCount === 1 ? 'Worker' : 'Workers'} <span class="muted">· no open findings</span>{/if}
        </span>
        <span class="ht-action">{showHealthy ? 'Hide' : 'Show'} <span class="caret" class:open={showHealthy}><Icon name="chevron" size={14} /></span></span>
      </button>
    {/if}
  {/if}
</section>

{#if !group && data.pages?.length}
  {@const pagesShown = data.pages.filter((p) => !q || p.name.toLowerCase().includes(q))}
  <section aria-labelledby="pages-title">
    <div class="section-head"><h2 id="pages-title">Pages projects <span class="count">{data.pages.length}</span></h2></div>
    <ul class="card pages-list">
      {#each pagesShown as p (p.name)}
        <li class:failed={p.latest?.status === 'failure'}>
          <span class="p-name mono">{p.name}</span>
          <span class="p-host muted">{p.domains.find((d) => !d.endsWith('.pages.dev')) ?? p.subdomain ?? ''}</span>
          <span class="p-state">
            {#if !p.latest}<span class="muted">No deploys</span>
            {:else if p.latest.status === 'failure'}<Icon name="critical" size={14} /> Last deploy failed
            {:else}<span class="muted">Deployed {timeAgo(p.latest.createdOn)}</span>{/if}
          </span>
          <span class="p-req num muted">{p.requests24h ? `${compact(p.requests24h)} function requests · 24 h` : ''}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .foot-right { display: inline-flex; align-items: center; gap: 16px; flex-wrap: wrap; justify-content: flex-end; }
  .report { font-size: 13px; }
  .report a { font-weight: 500; }
  .pages-list { list-style: none; margin: 0; padding: 4px 0; }
  .pages-list li {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto auto; gap: 8px 16px; align-items: center;
    padding: 10px 20px; border-top: 1px solid var(--line); font-size: 14px;
  }
  .pages-list li:first-child { border-top: 0; }
  .p-name, .p-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p-state { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .failed .p-state { color: var(--critical); font-weight: 500; }
  .p-req { font-size: 12px; white-space: nowrap; }
  @media (max-width: 760px) {
    .pages-list li { grid-template-columns: minmax(0, 1fr) auto; padding: 10px 16px; }
    .p-host, .p-req { grid-column: 1 / -1; }
  }
  .scope { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .scope-note { font-size: 13px; }
  .scope-note strong { color: var(--ink); font-weight: 600; }

  .hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 20px; }
  .hero.solo { grid-template-columns: 1fr; }
  .status { padding: 24px; display: grid; gap: 20px; grid-template-rows: auto 1fr auto; }
  .status.healthy { --glow: var(--healthy); }
  .status.warning { --glow: var(--accent); }
  .status.critical { --glow: var(--critical); }
  .status-head { display: flex; gap: 16px; align-items: center; }
  .eyebrow { font-size: 12px; line-height: 16px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; }
  .status h1 { margin-top: 2px; font-size: 24px; line-height: 30px; font-weight: 600; letter-spacing: -0.02em; text-wrap: balance; }
  .status-icon { flex: none; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 14px; color: var(--glow); background: color-mix(in srgb, var(--glow) 14%, transparent); }
  .map-area { display: grid; gap: 16px; align-content: start; }
  .urgent {
    --c: var(--ink-muted);
    display: flex; gap: 10px; align-items: start; padding: 10px 12px; border-radius: var(--radius-control);
    font-size: 13px; line-height: 18px; color: var(--ink); text-decoration: none;
    background: color-mix(in srgb, var(--c) 9%, transparent); border: 1px solid color-mix(in srgb, var(--c) 22%, transparent);
    transition: background 120ms;
  }
  .urgent:hover { color: var(--ink); background: color-mix(in srgb, var(--c) 15%, transparent); }
  .urgent.critical { --c: var(--critical); }
  .urgent.warning { --c: var(--accent); }
  .urgent :global(svg) { flex: none; margin-top: 1px; color: var(--c); }
  .urgent-label { font-weight: 600; }
  .urgent .mono { font-size: 12px; }
  .status-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--line); }
  .next { font-size: 12px; line-height: 16px; }
  .legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; line-height: 16px; }
  .legend li { display: inline-flex; align-items: center; gap: 6px; }
  .legend .num { color: var(--ink); font-weight: 600; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; }
  .swatch.critical { background: var(--critical); }
  .swatch.warning { background: var(--accent); }
  .swatch.info { background: var(--ink-muted); }
  .swatch.healthy { background: color-mix(in srgb, var(--healthy) 30%, var(--surface)); }

  .kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
  .extras { display: grid; gap: 20px; }
  .extras.pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi { padding: 20px 24px; display: grid; gap: 16px; align-content: space-between; }
  .kpi-label { font-size: 13px; line-height: 18px; font-weight: 500; color: var(--ink-muted); }
  .kpi-value { margin-top: 4px; font-size: 36px; line-height: 40px; font-weight: 600; letter-spacing: -0.03em; }
  .kpi-value.bad { color: var(--critical); }
  .kpi-sub { margin-top: 4px; font-size: 13px; line-height: 18px; }
  .sources-title { font-size: 12px; line-height: 16px; margin-bottom: 8px; }
  .sources ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .sources li { display: grid; grid-template-columns: minmax(0, 140px) 1fr auto; align-items: center; gap: 12px; font-size: 13px; line-height: 18px; }
  .sources a { color: var(--ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .sources a:hover { color: var(--accent-text); text-decoration: underline; }
  .sources .num { font-weight: 600; font-variant-numeric: tabular-nums; min-width: 48px; text-align: right; }
  .bar-track { height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .bar { display: block; height: 100%; border-radius: 999px; background: var(--ink-muted); }
  .bar.hot { background: var(--critical); }
  .clean { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--healthy); }

  section { margin-top: 16px; min-width: 0; }
  .hero section, .kpis section { margin-top: 0; }
  .tools { display: flex; align-items: center; gap: 8px; }
  /* No overflow clipping, so the snooze menu can open past the last row. */
  .list { list-style: none; margin: 0; padding: 0; }
  .housekeeping.spaced { margin-top: 16px; }
  .hk-toggle {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px; width: 100%; min-height: 44px; padding: 8px 12px;
    margin-bottom: 8px; border: 1px dashed var(--line); border-radius: var(--radius-card); background: transparent;
    color: var(--ink); font-size: 14px; font-weight: 600; text-align: left; justify-content: flex-start;
  }
  .hk-toggle:disabled { opacity: 1; cursor: default; }
  .hk-toggle:not(:disabled):hover { border-color: var(--ink-muted); }
  .hk-note { font-weight: 400; font-size: 13px; }
  .hk-summary { font-size: 13px; margin: 6px 0 2px; }
  .housekeeping .caret { display: inline-flex; transform: rotate(-90deg); transition: transform 150ms; }
  .housekeeping .caret.open { transform: rotate(0deg); }
  .list :global(li:first-child) { border-radius: var(--radius-card) var(--radius-card) 0 0; }
  .list :global(li:last-child) { border-radius: 0 0 var(--radius-card) var(--radius-card); }
  .list :global(li:only-child) { border-radius: var(--radius-card); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }

  .healthy-toggle {
    width: 100%; min-height: 52px; margin-top: 16px; padding: 0 16px; justify-content: flex-start; gap: 12px;
    border: 1px dashed var(--line); border-radius: var(--radius-card); background: transparent; text-align: left;
  }
  .healthy-toggle.alone { margin-top: 0; border-style: solid; background: var(--surface); }
  .healthy-toggle:hover { border-color: color-mix(in srgb, var(--healthy) 50%, var(--line)); background: color-mix(in srgb, var(--healthy) 5%, transparent); }
  .ht-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: var(--healthy); background: color-mix(in srgb, var(--healthy) 14%, transparent); }
  .ht-text { flex: 1; font-size: 14px; font-weight: 500; }
  .ht-action { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; color: var(--accent-text); }
  .caret { display: inline-flex; transition: transform 150ms; }
  .caret.open { transform: rotate(180deg); }

  @media (max-width: 960px) { .hero, .extras.pair { grid-template-columns: 1fr; } }
  @media (max-width: 760px) {
    .kpis { grid-template-columns: 1fr; gap: 16px; }
    .status, .kpi { padding: 18px; }
    .status h1 { font-size: 20px; line-height: 26px; }
    .kpi-value { font-size: 30px; line-height: 36px; }
  }
  .head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .export { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 10px; font-size: 13px; }
  .hk-head { display: flex; align-items: stretch; gap: 8px; }
  .hk-head .hk-toggle { flex: 1; min-width: 0; }
</style>
