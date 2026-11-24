<!-- Passkeys: list, add on this device, remove, and sign out every other session. Used by Settings and the setup wizard. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError, timeAgo, type PasskeyInfo } from '../../lib/api';
  import { auth } from '../../lib/auth.svelte';
  import { passkeysSupported, suggestedName } from '../../lib/passkey';
  import Icon from '../Icon.svelte';

  let { compact = false, onChanged }: {
    /** The setup wizard: no session controls. */
    compact?: boolean;
    /** After a passkey was added or removed, with how many are left. */
    onChanged?: (count: number) => void;
  } = $props();

  let list = $state<PasskeyInfo[]>([]);
  let loaded = $state(false);
  let name = $state(suggestedName());
  let passphrase = $state('');
  let needPassphrase = $state(false);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  const supported = passkeysSupported();

  async function load() {
    try {
      const r = await api.passkeys();
      list = r.passkeys;
      auth.passkeys = list.length > 0;
      auth.method = r.method;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loaded = true;
    }
  }
  onMount(load);

  async function add() {
    busy = true;
    error = '';
    notice = '';
    try {
      const r = await api.addPasskey(name.trim(), async () => {
        if (!passphrase) {
          needPassphrase = true;
          throw new Error(auth.method === 'link'
            ? 'A session from an e-mailed link cannot add a passkey on its own. Enter your passphrase, then add the passkey again.'
            : 'This session signed in more than 10 minutes ago. Enter your passphrase, then add the passkey again.');
        }
        return { passphrase };
      });
      passphrase = '';
      needPassphrase = false;
      name = suggestedName();
      notice = r.first
        ? 'Passkey added. The passphrase no longer signs in, and every other session was signed out. Keep the ADMIN_PASSPHRASE secret: it is how you recover if you lose every passkey.'
        : 'Passkey added.';
      await load();
      onChanged?.(list.length);
    } catch (e) {
      error = (e as Error).message;
      if (e instanceof ApiError && e.status === 401 && needPassphrase) passphrase = '';
    } finally {
      busy = false;
    }
  }

  async function remove(p: PasskeyInfo) {
    const last = list.length === 1;
    const warning = last
      ? `Remove "${p.name}"? It is the last passkey: the passphrase will sign in again.`
      : `Remove "${p.name}"? Sessions it signed in on other devices end now.`;
    if (!confirm(warning)) return;
    busy = true;
    error = '';
    notice = '';
    try {
      const r = await api.removePasskey(p.id);
      notice = r.last ? 'Passkey removed. With none left, the passphrase signs in again.' : 'Passkey removed.';
      await load();
      onChanged?.(list.length);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function endOthers() {
    if (!confirm('Sign out every other session, on every device? This one stays signed in.')) return;
    busy = true;
    error = '';
    notice = '';
    try {
      const r = await api.endOtherSessions();
      notice = r.ended === 1 ? 'One other session was signed out.' : `${r.ended} other sessions were signed out.`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="passkeys">
  {#if auth.method === 'recovery'}
    <p class="callout-warn" role="status"><Icon name="warning" size={16} /> <span><strong>You signed in with the recovery passphrase.</strong> For the next 10 minutes you can add a passkey and remove lost ones without a passkey check. Remove any passkey you do not recognize.</span></p>
  {:else if auth.method === 'link' && list.length}
    <p class="hint">You signed in with an e-mailed link. Adding or removing passkeys, creating API tokens and other sensitive steps ask for one of your passkeys.</p>
  {/if}

  {#if !compact}
    <p class="hint">
      A passkey signs in with this device's fingerprint, face or PIN, and cannot be phished: it only works on this site.
      Once you add one, the passphrase stops signing in and is kept only for recovery. Add a second passkey, or use a synced one, so that losing a device does not lock you out.
      {#if auth.link}You can also sign in with a link e-mailed to the operators.{/if}
    </p>
  {/if}

  {#if loaded && list.length}
    <ul>
      {#each list as p (p.id)}
        <li>
          <Icon name="key" size={16} />
          <span class="name">{p.name}</span>
          {#if p.current}<span class="badge">This session</span>{/if}
          <span class="muted">{p.backedUp ? 'synced' : 'on one device'}</span>
          <span class="muted">added {timeAgo(p.createdAt)} · {p.lastUsedAt ? `used ${timeAgo(p.lastUsedAt)}` : 'not used yet'}</span>
          <button type="button" class="ghost danger" disabled={busy} onclick={() => remove(p)}>Remove</button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if !supported}
    <p class="hint">This browser cannot use passkeys. Open the dashboard in a current browser on a device with a screen lock.</p>
  {:else}
    <form class="row" onsubmit={(e) => { e.preventDefault(); add(); }}>
      <input class="input" maxlength="60" placeholder="Name, e.g. MacBook" aria-label="Name for the new passkey" bind:value={name} />
      {#if needPassphrase}
        <input class="input" type="password" autocomplete="current-password" placeholder="Your passphrase" aria-label="Your passphrase, to confirm" bind:value={passphrase} />
      {/if}
      <button type="submit" class={list.length ? '' : 'primary'} disabled={busy || (needPassphrase && !passphrase)}><Icon name="plus" size={16} /> {busy ? 'Waiting for the passkey…' : list.length ? 'Add another passkey' : 'Add a passkey'}</button>
    </form>
  {/if}

  {#if notice}<p class="success-text" role="status">{notice}</p>{/if}
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}

  {#if !compact}
    <div class="row sessions">
      <p class="hint">Lost a device, or signed in somewhere you should not have been?</p>
      <button type="button" class="ghost" disabled={busy} onclick={endOthers}><Icon name="logout" size={16} /> Sign out every other session</button>
    </div>
  {/if}
</div>

<style>
  .passkeys { display: grid; gap: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row .input { flex: 1; min-width: 160px; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  li { display: flex; align-items: center; gap: 10px; font-size: 14px; padding: 6px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .name { font-weight: 500; flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--chip-text); }
  .sessions { justify-content: space-between; }
  .sessions .hint { margin: 0; flex: 1; min-width: 200px; }
  .callout-warn { display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: 10px 12px; border-radius: var(--radius-control); background: var(--chip); color: var(--chip-text); font-size: 14px; line-height: 20px; }
</style>
