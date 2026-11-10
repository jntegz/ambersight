<!-- Deploy timeline: every deploy, newest first, grouped by day; deploys followed by a new finding are flagged. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { TimelineEntry } from '../../../src/shared/types';
  import GroupFilter from '../components/GroupFilter.svelte';
  import Icon from '../components/Icon.svelte';
  import TrendBars from '../components/TrendBars.svelte';
  import { api, num, timeAgo, workerId } from '../lib/api';
  import { loadPrefs, savePrefs } from '../lib/prefs';

  let { groups, query, account = null, onUnauthorized }: { groups: string[]; query: string; account?: string | null; onUnauthorized: () => void } = $props();

  const prefs = loadPrefs('ambersight-timeline', { days: 14, group: '', onlyFlagged: false });
  let days = $state([7, 14, 30].includes(prefs.days) ? prefs.days : 14);
  let group = $state(prefs.group);
  let onlyFlagged = $state(prefs.onlyFlagged);
  $effect(() => savePrefs('ambersight-timeline', { days, group, onlyFlagged }));

  let entries = $state<TimelineEntry[] | null>(null);
  let error = $state('');
  let loading = $state(false);

  async function load(d: number, acct: string | null) {
    loading = true;
    error = '';
    try {
      entries = await api.timeline(d, acct ?? undefined);
    } catch (e) {
      if ((e as { status?: number }).status === 401) onUnauthorized();
      else error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    load(days, account);
  });

  const q = $derived(query.trim().toLowerCase());
  const visible = $derived(
    (entries ?? []).filter(
      (e) =>
        (!group || e.groups.includes(group)) &&
        (!onlyFlagged || e.correlated.length) &&
        (!q || e.script.toLowerCase().includes(q) || (e.message ?? '').toLowerCase().includes(q) || (e.author ?? '').toLowerCase().includes(q)),
    ),
  );
  const flagged = $derived(visible.filter((e) => e.correlated.length).length);
  const workersTouched = $derived(new Set(visible.map((e) => e.script)).size);

  const dayKey = (iso: string) => iso.slice(0, 10);
  const byDay = $derived.by(() => {
    const out: { day: string; items: TimelineEntry[] }[] = [];
    for (const e of visible) {
      const k = dayKey(e.createdOn);
      if (out.at(-1)?.day !== k) out.push({ day: k, items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  });
  // Deploys per day for the chart, oldest first, ending today (UTC).
  const perDay = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const e of visible) counts.set(dayKey(e.createdOn), (counts.get(dayKey(e.createdOn)) ?? 0) + 1);
    return Array.from({ length: days }, (_, i) => counts.get(new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10)) ?? 0);
  });

  function dayTitle(day: string) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (day === today) return 'Today';
    if (day === yesterday) return 'Yesterday';
    return new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const codeLabel = (code: string) => code.replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
</script>

<header class="page-head">
  <div>
    <h1>Deploy timeline</h1>
    <p>Every deploy in the last {days} days. Deploys followed by a new problem within the correlation window are flagged.</p>
  </div>
  <div class="controls">
    <div class="seg" role="group" aria-label="Time range">
      {#each [7, 14, 30] as d (d)}
        <button type="button" aria-pressed={days === d} onclick={() => (days = d)}>{d} days</button>
      {/each}
    </div>
  </div>
</header>

<div class="filters">
  <GroupFilter {groups} bind:value={group} />
  <label class="flag-toggle">
    <input type="checkbox" bind:checked={onlyFlagged} />
    <span>Only deploys followed by a problem</span>
  </label>
</div>

{#if error}
  <div class="card empty"><p role="alert">{error}</p><button type="button" onclick={() => load(days, account)}>Try again</button></div>
{:else if !entries}
  <div class="card empty muted" aria-busy="true"><p>Loading deploys…</p></div>
{:else}
  <div class="summary card" class:stale={loading}>
    <dl class="facts">
      <div><dt>Deploys</dt><dd>{num(visible.length)}</dd></div>
      <div><dt>Workers deployed</dt><dd>{num(workersTouched)}</dd></div>
      <div><dt>Followed by a problem</dt><dd class:bad={flagged > 0}>{num(flagged)}</dd></div>
    </dl>
    <div class="chart">
      <TrendBars values={perDay} unit="deploys" label="Deploys per day" />
    </div>
  </div>

  {#if !visible.length}
    <div class="card empty">
      <span class="empty-icon"><Icon name="timeline" size={24} /></span>
      <p>{entries.length ? 'No deploys match these filters.' : `No deploys in the last ${days} days.`}</p>
    </div>
  {:else}
    <div class="days" class:stale={loading}>
      {#each byDay as d (d.day)}
        <section class="day" aria-label={dayTitle(d.day)}>
          <h2 class="day-title">{dayTitle(d.day)} <span class="count">{d.items.length}</span></h2>
          <ol class="card entries">
            {#each d.items as e (e.script + e.id)}
              <li class="entry" class:flagged={e.correlated.length > 0}>
                <time datetime={e.createdOn} title={new Date(e.createdOn).toUTCString()}>{time(e.createdOn)}<span class="muted"> UTC</span></time>
                <span class="node" aria-hidden="true"></span>
                <div class="body">
                  <p class="line1">
                    <a class="script mono" href="#{workerId(e.script)}">{e.script}</a>
                    {#if e.source}<span class="tag-chip">{e.source}</span>{/if}
                    {#each e.groups as g (g)}<span class="tag-chip accent">{g}</span>{/each}
                    <span class="ago muted">{timeAgo(e.createdOn)}</span>
                  </p>
                  <p class="msg" class:muted={!e.message}>{e.message ?? 'No deploy message'}</p>
                  {#if e.author}<p class="author muted">by {e.author}</p>{/if}
                  {#if e.correlated.length}
                    <p class="followed">
                      <Icon name="critical" size={14} />
                      <span>Followed by</span>
                      {#each e.correlated as c (c)}<span class="problem">{codeLabel(c)}</span>{/each}
                    </p>
                  {/if}
                </div>
                <span class="id mono muted" title="Deployment ID">{e.id.slice(0, 8)}</span>
              </li>
            {/each}
          </ol>
        </section>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .controls { display: flex; gap: 8px; }
  .filters { display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; }
  .flag-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--ink-muted); }
  .flag-toggle input { width: 16px; height: 16px; accent-color: var(--button); margin: 0; }
  .flag-toggle:hover { color: var(--ink); }
  .stale { opacity: 0.55; transition: opacity 150ms; }

  .summary { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 32px; align-items: end; padding: 20px 24px; }
  .facts { display: flex; gap: 32px; margin: 0; }
  .facts dt { font-size: 13px; line-height: 18px; color: var(--ink-muted); white-space: nowrap; }
  .facts dd { margin: 4px 0 0; font-size: 30px; line-height: 36px; font-weight: 600; letter-spacing: -0.02em; }
  .facts dd.bad { color: var(--critical); }
  .chart { min-width: 0; }

  .days { display: grid; gap: 24px; }
  .day-title { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; font-weight: 600; margin-bottom: 8px; color: var(--ink-muted); }
  .entries { list-style: none; margin: 0; padding: 4px 0; }
  .entry {
    position: relative; display: grid; grid-template-columns: 78px 16px minmax(0, 1fr) auto; gap: 0 14px; align-items: start;
    padding: 12px 20px; transition: background 120ms;
  }
  .entry:hover { background: var(--row-tint); }
  /* The rail: a hairline through every node of the day. */
  .entry::before { content: ''; position: absolute; left: calc(20px + 78px + 14px + 7.5px); top: 0; bottom: 0; width: 1px; background: var(--line); }
  .entry:first-child::before { top: 20px; }
  .entry:last-child::before { bottom: calc(100% - 20px); }
  .entry:only-child::before { display: none; }
  time { font-size: 13px; line-height: 20px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  time .muted { font-weight: 400; font-size: 11px; margin-left: 3px; }
  .node { position: relative; z-index: 1; width: 9px; height: 9px; margin: 6px 0 0 3.5px; border-radius: 50%; background: var(--surface); box-shadow: inset 0 0 0 2px var(--ink-muted); }
  .flagged .node { background: var(--critical); box-shadow: 0 0 0 3px color-mix(in srgb, var(--critical) 20%, transparent); }
  .line1 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; line-height: 20px; }
  .script { font-size: 13px; font-weight: 600; color: var(--ink); text-decoration: none; }
  .script:hover { color: var(--accent-text); text-decoration: underline; }
  .ago { font-size: 12px; }
  .msg { margin-top: 2px; font-size: 14px; line-height: 20px; overflow-wrap: anywhere; }
  .author { font-size: 12px; line-height: 16px; margin-top: 2px; }
  .followed { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; font-size: 12px; line-height: 16px; color: var(--critical); }
  .followed :global(svg) { flex: none; }
  .problem { padding: 2px 8px; border-radius: 5px; font-weight: 600; background: color-mix(in srgb, var(--critical) 12%, transparent); }
  .id { font-size: 11px; line-height: 20px; }

  @media (max-width: 760px) {
    .summary { grid-template-columns: 1fr; gap: 16px; }
    .facts { gap: 20px; }
    .facts dd { font-size: 24px; line-height: 30px; }
    .entry { grid-template-columns: 52px 16px minmax(0, 1fr); padding: 12px 14px; gap: 0 10px; }
    .entry::before { left: calc(14px + 52px + 10px + 7.5px); }
    time .muted, .id { display: none; }
  }
</style>
