<!-- Packages: each mapped Worker's direct npm dependencies, locked version → latest on npm. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { PackagesView } from '../../../src/shared/types';
  import Icon from '../components/Icon.svelte';
  import { api, timeAgo, workerId } from '../lib/api';
  import { loadPrefs, savePrefs } from '../lib/prefs';

  let { query, account = null, onUnauthorized }: { query: string; account?: string | null; onUnauthorized: () => void } = $props();

  const prefs = loadPrefs('ambersight-packages', { onlyOutdated: true, showDev: true });
  let onlyOutdated = $state(prefs.onlyOutdated);
  let showDev = $state(prefs.showDev);
  $effect(() => savePrefs('ambersight-packages', { onlyOutdated, showDev }));

  let view = $state<PackagesView | null>(null);
  let error = $state('');

  async function load(acct: string | null) {
    error = '';
    try {
      view = await api.packages(acct ?? undefined);
    } catch (e) {
      if ((e as { status?: number }).status === 401) onUnauthorized();
      else error = (e as Error).message;
    }
  }
  $effect(() => {
    load(account);
  });

  const BEHIND = new Set(['major', 'minor', 'patch']);
  const q = $derived(query.trim().toLowerCase());
  const workers = $derived(
    (view?.workers ?? []).map((w) => ({
      ...w,
      behind: w.packages.filter((p) => BEHIND.has(p.gap)).length,
      shown: w.packages.filter((p) => (showDev || !p.dev) && (!onlyOutdated || BEHIND.has(p.gap)) && (!q || p.name.includes(q) || w.name.toLowerCase().includes(q))),
    })).filter((w) => !q || w.name.toLowerCase().includes(q) || w.shown.length),
  );
</script>

<header class="page-head">
  <div>
    <h1>Packages</h1>
    <p>Direct npm dependencies of each mapped Worker: the version locked in package-lock.json, and the latest on npm. Read once a day.</p>
  </div>
</header>

{#if error}
  <div class="card empty"><p role="alert">{error}</p><button type="button" onclick={() => load(account)}>Try again</button></div>
{:else if !view}
  <div class="card empty muted" aria-busy="true"><p>Loading packages…</p></div>
{:else if !view.enabled || !view.github || !view.workers.length}
  <div class="card empty">
    <span class="empty-icon"><Icon name="list" size={24} /></span>
    {#if !view.github}
      <p>Set a GitHub token first: <span class="mono">npx wrangler secret put GITHUB_TOKEN</span>. Use a fine-grained token with <strong>Contents: Read</strong> on the repositories only.</p>
    {:else if !view.enabled}
      <p>The Packages check is off. Turn it on in <a href="#/settings">Settings › Checks</a>.</p>
    {:else}
      <p>No Worker is mapped to a repository yet. Add them in <a href="#/settings">Settings › Checks › Packages</a>.</p>
    {/if}
  </div>
{:else}
  <div class="filters">
    <label class="flag-toggle"><input type="checkbox" bind:checked={onlyOutdated} /><span>Only outdated</span></label>
    <label class="flag-toggle"><input type="checkbox" bind:checked={showDev} /><span>Include devDependencies</span></label>
  </div>
  <div class="list">
    {#each workers as w (w.name)}
      <section class="card worker" aria-labelledby="pk-{w.name}">
        <header class="w-head">
          <h2 id="pk-{w.name}"><a class="mono" href="#{workerId(w.name)}">{w.name}</a></h2>
          <span class="muted hint">{w.repo}{w.dir ? `/${w.dir}` : ''} · read {timeAgo(w.checkedAt)}</span>
          {#if !w.error && w.packages.length}<span class="tag-chip" class:warn={w.behind > 0}>{w.behind} of {w.packages.length} behind</span>{/if}
        </header>
        {#if w.error}
          <p class="err"><Icon name="warning" size={14} /> {w.error}</p>
        {:else if !w.checkedAt}
          <p class="muted hint">Not read yet. It will be on one of the next scans.</p>
        {:else if !w.shown.length}
          <p class="muted hint">{onlyOutdated ? 'Every direct dependency is on the latest release.' : 'No dependencies match.'}</p>
        {:else}
          <table>
            <thead><tr><th scope="col">Package</th><th scope="col">Locked</th><th scope="col">Latest</th><th scope="col"><span class="sr-only">Behind by</span></th></tr></thead>
            <tbody>
              {#each w.shown as p (p.name)}
                <tr>
                  <td class="mono">{p.name}{#if p.dev} <span class="tag-chip">dev</span>{/if}</td>
                  <td class="mono">{p.locked}</td>
                  <td class="mono">{p.latest ?? '…'}</td>
                  <td>{#if BEHIND.has(p.gap)}<span class="gap {p.gap}">{p.gap}</span>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .filters { display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; }
  .flag-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--ink-muted); }
  .flag-toggle input { width: 16px; height: 16px; accent-color: var(--button); margin: 0; }
  .list { display: grid; gap: 16px; }
  .worker { padding: 16px 20px; min-width: 0; }
  .w-head { display: flex; align-items: baseline; gap: 6px 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .w-head h2 { font-size: 15px; font-weight: 600; }
  .w-head a { color: var(--ink); text-decoration: none; }
  .w-head a:hover { text-decoration: underline; }
  .tag-chip.warn { background: color-mix(in srgb, var(--critical) 14%, transparent); color: var(--warning-text); }
  .err { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--warning-text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
  th { text-align: left; font-weight: 500; font-size: 12px; color: var(--ink-muted); padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  td.mono { font-size: 13px; }
  th:first-child { width: 46%; }
  th:last-child { width: 72px; }
  tr:last-child td { border-bottom: 0; }
  .gap { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 5px; text-transform: uppercase; letter-spacing: 0.03em; }
  .gap.major { background: color-mix(in srgb, var(--critical) 16%, transparent); color: var(--critical); }
  .gap.minor { background: var(--chip); color: var(--chip-text); }
  .gap.patch { background: var(--line); color: var(--ink-muted); }
</style>
