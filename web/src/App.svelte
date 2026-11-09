<!-- Ambersight overview: totals, free budget, ranked findings, then every Worker. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Overview, Severity } from '../../src/shared/types';
  import BudgetMeter from './components/BudgetMeter.svelte';
  import FindingRow from './components/FindingRow.svelte';
  import Icon from './components/Icon.svelte';
  import Login from './components/Login.svelte';
  import Logo from './components/Logo.svelte';
  import WorkerCard from './components/WorkerCard.svelte';
  import { api, ApiError, num, timeAgo } from './lib/api';

  type View = 'loading' | 'login' | 'ready' | 'error';
  let view = $state<View>('loading');
  let data = $state<Overview | null>(null);
  let error = $state('');
  let scanning = $state(false);
  let notice = $state('');
  let query = $state('');
  let severity = $state<'all' | Severity>('all');

  const q = $derived(query.trim().toLowerCase());
  const findings = $derived(
    (data?.findings ?? []).filter(
      (f) => (severity === 'all' || f.severity === severity) && (!q || f.script.toLowerCase().includes(q) || f.message.toLowerCase().includes(q)),
    ),
  );
  const workers = $derived((data?.workers ?? []).filter((w) => !q || w.name.toLowerCase().includes(q)));
  const counts = $derived({
    critical: data?.findings.filter((f) => f.severity === 'critical').length ?? 0,
    warning: data?.findings.filter((f) => f.severity === 'warning').length ?? 0,
    info: data?.findings.filter((f) => f.severity === 'info').length ?? 0,
  });

  async function load() {
    try {
      data = await api.overview();
      view = 'ready';
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) view = 'login';
      else {
        error = (e as Error).message;
        view = 'error';
      }
    }
  }

  async function scanNow() {
    scanning = true;
    notice = '';
    try {
      const r = await api.scan();
      notice = `Scanned ${r.workers} Workers.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`;
      await load();
    } catch (e) {
      notice = (e as Error).message;
    } finally {
      scanning = false;
    }
  }

  async function acknowledge(id: string) {
    await api.acknowledge(id);
    await load();
  }

  async function snooze(id: string, days: 7 | 30 | 90) {
    await api.snooze(id, days);
    await load();
  }

  async function signOut() {
    await api.logout();
    data = null;
    view = 'login';
  }

  onMount(async () => {
    const s = await api.session().catch(() => ({ authenticated: false }));
    if (s.authenticated) await load();
    else view = 'login';
  });
</script>

{#if view === 'login'}
  <Login onSignedIn={load} />
{:else if view === 'loading'}
  <main class="center muted"><span class="draw"><Logo size={64} /></span><p>Reading your Workers…</p></main>
{:else if view === 'error'}
  <main class="center"><p role="alert">{error}</p><button onclick={load}>Try again</button></main>
{:else if data}
  <header class="top">
    <div class="brand"><Logo size={32} label="Ambersight" /><span class="wordmark">ambersight</span></div>
    <label class="search">
      <span class="sr-only">Search Workers</span>
      <Icon name="search" size={16} />
      <input type="search" placeholder="Search Workers" bind:value={query} />
    </label>
    <button type="button" onclick={scanNow} disabled={scanning}><Icon name="refresh" size={16} /> {scanning ? 'Scanning…' : 'Scan now'}</button>
    <button type="button" onclick={signOut} aria-label="Sign out"><Icon name="logout" size={16} /></button>
  </header>

  <main class="page">
    {#if notice}<p class="notice muted" role="status">{notice}</p>{/if}

    <section class="totals" aria-label="Fleet totals">
      <div class="card tile"><p class="muted">Workers</p><p class="big num">{num(data.totals.workers)}</p></div>
      <div class="card tile" class:alert={data.totals.needAttention > 0}><p class="muted">Need attention</p><p class="big num">{num(data.totals.needAttention)}</p></div>
      <div class="card tile"><p class="muted">Requests today</p><p class="big num">{num(data.totals.requestsToday)}</p></div>
      <div class="card tile"><p class="muted">Errors today</p><p class="big num">{num(data.totals.errorsToday)}</p></div>
    </section>

    {#if data.budget}<BudgetMeter budget={data.budget} />{/if}

    <section aria-labelledby="attention-title">
      <div class="section-head">
        <h2 id="attention-title">Needs attention</h2>
        <div class="chips" role="group" aria-label="Filter by severity">
          <button type="button" class:on={severity === 'all'} onclick={() => (severity = 'all')}>All</button>
          <button type="button" class:on={severity === 'critical'} onclick={() => (severity = 'critical')}>Critical <span class="num">{counts.critical}</span></button>
          <button type="button" class:on={severity === 'warning'} onclick={() => (severity = 'warning')}>Warning <span class="num">{counts.warning}</span></button>
          <button type="button" class:on={severity === 'info'} onclick={() => (severity = 'info')}>Info <span class="num">{counts.info}</span></button>
        </div>
      </div>
      {#if findings.length}
        <ul class="card list">
          {#each findings as finding (finding.id)}
            <FindingRow {finding} onAcknowledge={acknowledge} onSnooze={snooze} />
          {/each}
        </ul>
      {:else}
        <div class="card empty">
          <span class="healthy"><Icon name="healthy" size={48} /></span>
          <p>
            {#if data.lastScanAt}
              {data.findings.length ? 'Nothing matches this filter.' : `All ${data.totals.workers} Workers look healthy.`}
            {:else}
              The first scan has not run yet. Press Scan now, or wait for the next full hour.
            {/if}
          </p>
        </div>
      {/if}
    </section>

    <section aria-labelledby="workers-title">
      <div class="section-head"><h2 id="workers-title">All Workers</h2></div>
      <div class="grid">
        {#each workers as worker (worker.name)}<WorkerCard {worker} />{/each}
      </div>
    </section>

    <footer class="foot muted">
      Last scan {timeAgo(data.lastScanAt)} · Read-only · Runs in your own Cloudflare account ·
      <a href="https://github.com/jntegz/ambersight-dev" target="_blank" rel="noopener noreferrer">Source (AGPL-3.0)</a>
    </footer>
  </main>
{/if}

<style>
  .center { min-height: 100vh; display: grid; place-content: center; justify-items: center; gap: 16px; }
  .top {
    position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px;
    padding: 12px 24px; background: var(--paper); border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 10px; flex: 1; }
  .wordmark { font-size: 20px; font-weight: 600; letter-spacing: -0.03em; }
  .search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-muted); }
  .search input { border: 0; outline: 0; background: transparent; width: 180px; color: var(--ink); }
  .top button { display: inline-flex; align-items: center; gap: 6px; }
  .page { max-width: 1200px; margin: 0 auto; padding: 24px; display: grid; gap: 32px; }
  .notice { font-size: 14px; }
  .totals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .tile { padding: 16px; }
  .tile p:first-child { font-size: 14px; }
  .big { font-size: 28px; line-height: 32px; font-weight: 600; margin-top: 4px; }
  .tile.alert .big { color: var(--accent-text); }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chips button { border-radius: 999px; font-size: 14px; min-height: 32px; }
  .chips button.on { background: var(--chip); color: var(--chip-text); border-color: transparent; font-weight: 600; }
  .list { list-style: none; margin: 0; padding: 0; overflow: hidden; }
  .empty { padding: 32px; display: grid; justify-items: center; gap: 12px; text-align: center; }
  .healthy { color: var(--healthy); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .foot { font-size: 12px; line-height: 16px; text-align: center; padding-bottom: 24px; }
  @media (max-width: 760px) {
    .totals { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .top { flex-wrap: wrap; padding: 12px 16px; }
    .search { order: 3; width: 100%; }
    .search input { width: 100%; }
    .page { padding: 16px; }
  }
</style>
