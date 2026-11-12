<!-- Read-only API tokens for Ambersight's own JSON API: create (shown once), list, revoke. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, timeAgo, type TokenInfo } from '../../lib/api';
  import Icon from '../Icon.svelte';

  let tokens = $state<TokenInfo[]>([]);
  let name = $state('');
  let created = $state<string | null>(null);
  let error = $state('');
  let busy = $state(false);
  let copied = $state(false);

  onMount(async () => {
    tokens = await api.tokens().catch(() => []);
  });
  async function create() {
    busy = true;
    error = '';
    try {
      const r = await api.createToken(name);
      created = r.token;
      tokens = [...tokens, r.info];
      name = '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function revoke(t: TokenInfo) {
    if (!confirm(`Revoke "${t.name}"? Anything using it stops working.`)) return;
    error = '';
    try {
      await api.revokeToken(t.id);
      tokens = tokens.filter((x) => x.id !== t.id);
    } catch (e) {
      // Keep it in the list: it still works until a revoke succeeds.
      error = `Not revoked: ${(e as Error).message}`;
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(created ?? '');
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {}
  }
</script>

<div class="tokens">
  <p class="hint">
    A token reads what the dashboard shows (overview, analytics, Worker pages, findings, timeline) as JSON, for Grafana, scripts or a status board.
    It cannot change anything, read settings or start a scan. Send it as <span class="mono">Authorization: Bearer amb_…</span>.
    See <a href="https://github.com/jntegz/ambersight/blob/main/docs/api.md" target="_blank" rel="noopener noreferrer">docs/api.md</a>.
  </p>
  {#if created}
    <div class="created" role="status">
      <p><strong>Copy this token now.</strong> It is shown only once.</p>
      <div class="row"><code class="mono">{created}</code><button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button><button type="button" class="ghost" onclick={() => (created = null)}>Done</button></div>
    </div>
  {/if}
  {#if tokens.length}
    <ul>
      {#each tokens as t (t.id)}
        <li>
          <Icon name="key" size={16} />
          <span class="name">{t.name}</span>
          <span class="muted mono">…{t.hint}</span>
          <span class="muted">{t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}</span>
          <button type="button" class="ghost danger" onclick={() => revoke(t)}>Revoke</button>
        </li>
      {/each}
    </ul>
  {/if}
  <form class="row" onsubmit={(e) => { e.preventDefault(); create(); }}>
    <input class="input" placeholder="Token name, e.g. Grafana" maxlength="60" aria-label="New token name" bind:value={name} />
    <button type="submit" disabled={busy || !name.trim()}><Icon name="plus" size={16} /> Create token</button>
  </form>
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}
</div>

<style>
  .tokens { display: grid; gap: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row .input { flex: 1; min-width: 180px; }
  .created { padding: 12px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 8px; background: var(--row-tint); display: grid; gap: 8px; font-size: 14px; }
  code { flex: 1; min-width: 0; overflow-x: auto; padding: 6px 10px; border-radius: 6px; background: var(--line); font-size: 12px; user-select: all; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  li { display: flex; align-items: center; gap: 10px; font-size: 14px; padding: 6px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .name { font-weight: 500; flex: 1; }
</style>
