<!-- Read-only API tokens for Ambersight's own JSON API: create (shown once), list, revoke. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { AccountSummary } from '../../../../src/shared/types';
  import { api, timeAgo, type TokenInfo } from '../../lib/api';
  import Icon from '../Icon.svelte';

  let tokens = $state<TokenInfo[]>([]);
  let name = $state('');
  let days = $state(90);
  let passphrase = $state('');
  // Nothing is chosen at the start: every account, or person-linked data, takes a deliberate tick.
  let watched = $state<AccountSummary[]>([]);
  let allAccounts = $state(false);
  let picked = $state<string[]>([]);
  let people = $state(false);
  let created = $state<string | null>(null);
  let error = $state('');
  let busy = $state(false);
  let copied = $state(false);

  const chosen = $derived(allAccounts || picked.length > 0);
  const older = $derived(tokens.some((t) => t.olderScope));
  const accountName = (id: string) => watched.find((a) => a.id === id)?.label ?? id;
  const reach = (t: TokenInfo) => (t.accounts === 'all' ? 'all accounts' : t.accounts.map(accountName).join(', '));

  onMount(async () => {
    [tokens, watched] = await Promise.all([api.tokens().catch(() => []), api.accounts().catch(() => [])]);
  });
  async function create() {
    busy = true;
    error = '';
    try {
      const r = await api.createToken(name, days, passphrase, allAccounts ? 'all' : picked, people);
      created = r.token;
      tokens = [...tokens, r.info];
      name = '';
      passphrase = '';
      allAccounts = false;
      picked = [];
      people = false;
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
  const daysLeft = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
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
    A token expires, and stops working when the passphrase changes. It reads only the accounts you choose for it.
    The dashboard itself always shows every account: one shared passphrase cannot tell people apart.
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
          <span class="muted scope">{reach(t)} · {t.people ? 'with person-linked data' : 'no person-linked data'}{t.olderScope ? ' · from before token scopes' : ''}</span>
          {#if t.invalidated}
            <span class="stopped">Stopped: the passphrase changed</span>
          {:else if t.expired}
            <span class="stopped">Expired</span>
          {:else if t.expiresAt}
            <span class="muted">expires in {daysLeft(t.expiresAt)} d</span>
          {/if}
          <button type="button" class="ghost danger" onclick={() => revoke(t)}>Revoke</button>
        </li>
      {/each}
    </ul>
    {#if older}
      <p class="hint">Tokens from before token scopes keep every account, so what uses them keeps working, but they no longer receive person-linked data. To narrow one, or to give it that data, create a new token and revoke the old one.</p>
    {/if}
  {/if}
  <form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
    <fieldset disabled={busy}>
      <legend>Accounts this token may read</legend>
      <label class="check"><input type="checkbox" bind:checked={allAccounts} /> <span>All watched accounts, including any added later</span></label>
      {#if !allAccounts}
        {#each watched as a (a.id)}
          <label class="check"><input type="checkbox" value={a.id} bind:group={picked} /> <span>{a.label}</span></label>
        {/each}
      {/if}
    </fieldset>
    <label class="check">
      <input type="checkbox" bind:checked={people} />
      <span>Include person-linked data
        <span class="hint block">Who deployed or changed something: deploy authors and messages, audit log actors and descriptions, member ids, branch and repository names, and account names from Cloudflare. Leave this off unless the tool needs to know who did what. Without it, those fields are left out of every answer, and an account shows the label you set in Settings, or a neutral name.</span>
      </span>
    </label>
    <div class="row">
      <input class="input" placeholder="Token name, e.g. Grafana" maxlength="60" aria-label="New token name" bind:value={name} />
      <select class="select-input w-auto" aria-label="Token lifetime" bind:value={days}>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
        <option value={365}>365 days</option>
      </select>
      <input class="input" type="password" autocomplete="current-password" placeholder="Your passphrase" aria-label="Your passphrase, to confirm" bind:value={passphrase} />
      <button type="submit" disabled={busy || !name.trim() || !passphrase || !chosen}><Icon name="plus" size={16} /> Create token</button>
    </div>
  </form>
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}
</div>

<style>
  .tokens { display: grid; gap: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row .input { flex: 1; min-width: 180px; }
  .new { display: grid; gap: 10px; }
  fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 6px; }
  legend { padding: 0 0 4px; font-size: 14px; font-weight: 500; }
  .check { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; }
  .check input { margin-top: 3px; }
  .block { display: block; }
  .scope { flex-basis: 100%; font-size: 13px; }
  .created { padding: 12px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 8px; background: var(--row-tint); display: grid; gap: 8px; font-size: 14px; }
  code { flex: 1; min-width: 0; overflow-x: auto; padding: 6px 10px; border-radius: 6px; background: var(--line); font-size: 12px; user-select: all; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  li { display: flex; align-items: center; gap: 10px; font-size: 14px; padding: 6px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .name { font-weight: 500; flex: 1; }
  .w-auto { width: auto; }
  .stopped { color: var(--critical); font-weight: 600; font-size: 13px; }
</style>
