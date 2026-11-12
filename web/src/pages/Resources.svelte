<!-- Resources: every KV namespace, D1 database, R2 bucket and queue, who binds it, size and last use. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { fmtBytes } from '../../../src/shared/limits';
  import type { ResourcesView } from '../../../src/shared/types';
  import Icon from '../components/Icon.svelte';
  import { api, workerHref, workerId } from '../lib/api';
  import { loadPrefs, savePrefs } from '../lib/prefs';

  let { query, account = null, onUnauthorized }: { query: string; account?: string | null; onUnauthorized: () => void } = $props();

  const prefs = loadPrefs('ambersight-resources', { onlyLeftovers: false });
  let onlyLeftovers = $state(prefs.onlyLeftovers);
  $effect(() => savePrefs('ambersight-resources', { onlyLeftovers }));

  let view = $state<ResourcesView | null>(null);
  let error = $state('');

  async function load(acct: string | null) {
    error = '';
    try {
      view = await api.resources(acct ?? undefined);
    } catch (e) {
      if ((e as { status?: number }).status === 401) onUnauthorized();
      else error = (e as Error).message;
    }
  }
  $effect(() => {
    load(account);
  });

  const KIND = { kv: 'KV', d1: 'D1', r2: 'R2', queues: 'Queue' } as const;
  const STATUS = {
    outside: { label: 'Used outside Workers', tip: 'Not bound to any Worker, but it had operations in the last two days. Something else uses it: do not delete it.' },
    unbound: { label: 'Not bound', tip: 'No Worker binds it. See Housekeeping for how to remove it.' },
    idle: { label: 'Idle', tip: 'Bound to a Worker, but no operations in the whole period.' },
    'in-use': { label: 'In use', tip: '' },
  } as const;

  const lastUsed = (r: ResourcesView['resources'][number]) => {
    if (r.lastActiveHour) return new Date(r.lastActiveHour).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return r.activity === 'quiet' ? `none in ${view?.windowDays} days` : 'not known yet';
  };

  const q = $derived(query.trim().toLowerCase());
  const rows = $derived(
    (view?.resources ?? []).filter((r) =>
      (!onlyLeftovers || r.status !== 'in-use') &&
      (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.boundBy.some((w) => w.toLowerCase().includes(q)))),
  );
  const counts = $derived(
    (view?.resources ?? []).reduce((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {} as Record<string, number>),
  );
  const COUNT_LABEL = { unbound: 'not bound', idle: 'idle', outside: 'used outside Workers' } as const;
  const summary = $derived(
    [`${view?.resources.length ?? 0} total`, ...(['unbound', 'idle', 'outside'] as const).filter((s) => counts[s]).map((s) => `${counts[s]} ${COUNT_LABEL[s]}`)].join(' · '),
  );
  const sizeText = (r: ResourcesView['resources'][number]) =>
    [r.bytes == null ? '–' : fmtBytes(r.bytes), r.objects ? `${r.objects.toLocaleString('en-US')} ${r.kind === 'kv' ? 'keys' : 'objects'}` : ''].filter(Boolean).join(' · ');
</script>

<header class="page-head">
  <div>
    <h1>Resources</h1>
    <p>Every KV namespace, D1 database, R2 bucket and queue in the account: which Workers bind it, how big it is and when it was last used, from any source. Check here before deleting anything.</p>
  </div>
</header>

{#if error}
  <div class="card empty"><p role="alert">{error}</p><button type="button" onclick={() => load(account)}>Try again</button></div>
{:else if !view}
  <div class="card empty muted" aria-busy="true"><p>Loading resources…</p></div>
{:else if !view.resources.length}
  <div class="card empty">
    <span class="empty-icon"><Icon name="zombies" size={24} /></span>
    <p>{view.ready ? 'This account has no KV namespaces, D1 databases, R2 buckets or queues.' : 'Not read yet. The list fills in after the next inventory refresh (once a day by default).'}</p>
  </div>
{:else}
  <div class="filters">
    <label class="flag-toggle"><input type="checkbox" bind:checked={onlyLeftovers} /><span>Only possible leftovers</span></label>
    <span class="muted hint">{summary}</span>
  </div>
  {#if !view.ready}
    <p class="muted hint">Some Workers' bindings are not read yet, so a resource may show as not bound when it is. This clears within a few scans.</p>
  {:else if view.resources.some((r) => r.activity === 'unknown')}
    <p class="muted hint">"Not known yet" means Ambersight has not read that kind's operations for a full {view.windowDays} days without a gap (or the usage checks are off), so it does not say "idle" or "none" yet.</p>
  {/if}
  <div class="card table-card">
    <table>
      <thead>
        <tr><th scope="col">Name</th><th scope="col">Bound to</th><th scope="col" class="num">Size</th><th scope="col">Last used</th><th scope="col">Status</th></tr>
      </thead>
      <tbody>
        {#each rows as r (r.kind + r.id)}
          <tr>
            <td><span class="kind">{KIND[r.kind]}</span> <span class="mono">{r.name}</span>{#if r.objects === 0 && (r.kind === 'kv' || r.kind === 'r2')} <span class="tag-chip">empty</span>{/if}</td>
            <td>
              {#if r.boundBy.length}
                {#each r.boundBy as w, i (w)}{#if i}, {/if}<a class="mono" href={workerHref(w)}>{w}</a>{/each}
              {:else if r.inUse}
                <span class="muted">a queue consumer</span>
              {:else}
                <span class="muted">nothing</span>
              {/if}
            </td>
            <td class="num">{sizeText(r)}</td>
            <td>{lastUsed(r)}</td>
            <td><span class="status {r.status}" title={STATUS[r.status].tip || undefined}>{STATUS[r.status].label}</span></td>
          </tr>
        {:else}
          <tr><td colspan="5" class="muted">Nothing matches.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .filters { display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; margin-bottom: 12px; }
  .flag-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--ink-muted); }
  .flag-toggle input { width: 16px; height: 16px; accent-color: var(--button); margin: 0; }
  .hint { font-size: 13px; }
  p.hint { margin-bottom: 12px; }
  .table-card { padding: 4px 12px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px; }
  th { text-align: left; font-weight: 500; font-size: 12px; color: var(--ink-muted); padding: 8px; border-bottom: 1px solid var(--line); }
  td { padding: 8px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .num { text-align: right; white-space: nowrap; }
  .kind { font-size: 11px; font-weight: 600; color: var(--ink-muted); letter-spacing: 0.03em; }
  td a { color: var(--ink); }
  .status { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 5px; white-space: nowrap; }
  .status.in-use { background: var(--line); color: var(--ink-muted); }
  .status.idle, .status.unbound { background: var(--chip); color: var(--chip-text); }
  .status.outside { background: color-mix(in srgb, var(--critical) 14%, transparent); color: var(--warning-text); }
</style>
