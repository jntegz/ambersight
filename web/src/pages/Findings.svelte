<!-- The findings inbox: open, acknowledged, snoozed and recently resolved findings, each with its -->
<!-- history. Acknowledged and snoozed findings can be restored to "Needs attention". -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { FindingListItem } from '../../../src/shared/types';
  import FindingRow from '../components/FindingRow.svelte';
  import Icon from '../components/Icon.svelte';
  import { api, ApiError, num } from '../lib/api';
  import { setParam } from '../lib/route';

  type Status = 'open' | 'acknowledged' | 'snoozed' | 'resolved';
  let { params, account, query, onUnauthorized, onChanged }: {
    params: URLSearchParams; account: string | null; query: string; onUnauthorized: () => void;
    /** A status changed here: the overview's counts are stale. */
    onChanged: () => void;
  } = $props();

  const TABS: { id: Status; label: string; empty: string }[] = [
    { id: 'open', label: 'Open', empty: 'Nothing needs attention.' },
    { id: 'acknowledged', label: 'Acknowledged', empty: 'No acknowledged findings. Acknowledge one to keep it out of "Needs attention" until it changes.' },
    { id: 'snoozed', label: 'Snoozed', empty: 'No snoozed findings.' },
    { id: 'resolved', label: 'Resolved', empty: 'Nothing resolved yet. Findings resolve on their own when a scan no longer sees the problem.' },
  ];
  let status = $state<Status>(untrack(() => (TABS.some((t) => t.id === params.get('status')) ? (params.get('status') as Status) : 'open')));
  let list = $state<FindingListItem[] | null>(null);
  let error = $state('');

  async function load() {
    error = '';
    try {
      list = await api.findings(status, account ?? undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else error = (e as Error).message;
    }
  }
  $effect(() => {
    void status; void account;
    list = null;
    load();
  });
  function pick(s: Status) {
    status = s;
    setParam('status', s === 'open' ? null : s);
  }
  async function act(p: Promise<unknown>) {
    await p;
    onChanged();
    await load();
  }
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter((f) => !q || f.script.toLowerCase().includes(q) || f.message.toLowerCase().includes(q) || `${f.module}:${f.code}`.includes(q));
  });
  let busy = $state(false);
  async function restoreAll() {
    busy = true;
    try {
      await act(api.bulk(shown.map((f) => f.id), 'restore'));
    } finally {
      busy = false;
    }
  }
</script>

<section class="inbox">
  <div class="page-head">
    <div>
      <h1>Findings</h1>
      <p>Everything Ambersight found, by status. Each finding keeps its history: opened, alerted, acknowledged, resolved.</p>
    </div>
  </div>
  <div class="bar">
    <div class="seg tabs" role="tablist" aria-label="Status">
      {#each TABS as t (t.id)}
        <button type="button" role="tab" aria-selected={status === t.id} onclick={() => pick(t.id)}>{t.label}</button>
      {/each}
    </div>
    {#if (status === 'acknowledged' || status === 'snoozed') && shown.length}
      <button type="button" disabled={busy} onclick={restoreAll}><Icon name="undo" size={16} /> Restore {shown.length === 1 ? 'it' : `all ${num(shown.length)}`}</button>
    {/if}
  </div>

  {#if error}
    <div class="card empty" role="alert"><p>{error}</p><button type="button" onclick={load}>Try again</button></div>
  {:else if !list}
    <div class="card empty muted"><p>Loading…</p></div>
  {:else if !shown.length}
    <div class="card empty"><span class="empty-icon"><Icon name="healthy" size={24} /></span><p>{query ? 'No finding matches the search.' : TABS.find((t) => t.id === status)!.empty}</p></div>
  {:else}
    <ul class="card list">
      {#each shown as f (f.id)}
        <FindingRow finding={f} compact={status === 'resolved'}
          onAcknowledge={(id) => act(api.acknowledge(id))} onSnooze={(id, d) => act(api.snooze(id, d))} onRestore={(id) => act(api.restore(id))} />
      {/each}
    </ul>
    {#if status === 'resolved'}<p class="hint">The {num(shown.length)} most recently resolved.</p>{/if}
  {/if}
</section>

<style>
  .inbox { display: grid; gap: 16px; min-width: 0; }
  /* Wide tables scroll inside their card instead of widening the page. */
  .inbox > :global(*) { min-width: 0; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .tabs { width: fit-content; max-width: 100%; overflow-x: auto; }
  .tabs button[aria-selected='true'] { background: var(--chip); color: var(--chip-text); font-weight: 600; }
  .list { list-style: none; margin: 0; padding: 0; overflow: hidden; }
</style>
