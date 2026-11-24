<!-- Opened from an e-mailed sign-in link. Asks for a click before the link is used, so a mail scanner that opens links cannot spend it. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { api } from '../lib/api';
  import Logo from './Logo.svelte';

  let { token, onSignedIn, onCancel }: { token: string; onSignedIn: () => void; onCancel: () => void } = $props();
  let busy = $state(false);
  let error = $state('');

  async function confirm() {
    busy = true;
    error = '';
    try {
      await api.confirmLink(token);
      onSignedIn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="login">
  <div class="card panel">
    <div class="brand"><span class="draw"><Logo size={64} label="Ambersight" /></span><span class="wordmark">ambersight</span></div>
    <h1>Sign in with this link?</h1>
    <p class="muted">The link works once, for 10 minutes after it was sent, and only in the browser where you asked for it.</p>
    {#if error}
      <p class="error" role="alert">{error}</p>
      <button type="button" class="primary" onclick={onCancel}>Back to sign-in</button>
    {:else}
      <button type="button" class="primary" onclick={confirm} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <button type="button" class="ghost" onclick={onCancel} disabled={busy}>Cancel</button>
    {/if}
  </div>
</main>

<style>
  .login { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .panel { width: min(400px, 100%); padding: 32px; display: grid; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .wordmark { font-size: 32px; font-weight: 600; letter-spacing: -0.03em; }
  h1 { font-size: 20px; line-height: 28px; margin: 0; }
  .error { color: var(--critical); font-size: 14px; }
  button { height: 44px; }
</style>
