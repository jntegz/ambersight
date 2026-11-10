<!-- Passphrase sign-in. The passphrase is the ADMIN_PASSPHRASE Worker secret. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import Logo from './Logo.svelte';

  let { onSignedIn, message = '', turnstileSiteKey = null }: { onSignedIn: () => void; message?: string; turnstileSiteKey?: string | null } = $props();
  let passphrase = $state('');
  let error = $state('');
  let busy = $state(false);

  // ---- Optional Cloudflare Turnstile (TURNSTILE_SITE_KEY + TURNSTILE_SECRET on the Worker).
  type Turnstile = { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id?: string) => void };
  let widgetEl = $state<HTMLElement>();
  let widgetId: string | undefined;
  let token = $state('');
  const TS_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  onMount(() => {
    if (!turnstileSiteKey) return;
    const render = () => {
      const ts = (window as unknown as { turnstile?: Turnstile }).turnstile;
      if (!ts || !widgetEl) return;
      widgetId = ts.render(widgetEl, {
        sitekey: turnstileSiteKey,
        theme: 'auto',
        callback: (t: string) => (token = t),
        'expired-callback': () => (token = ''),
        'error-callback': () => (token = ''),
      });
    };
    if ((window as unknown as { turnstile?: Turnstile }).turnstile) return render();
    const script = Object.assign(document.createElement('script'), { src: TS_SRC, async: true, defer: true });
    script.onload = render;
    script.onerror = () => (error = 'The browser check could not load. Check your connection or ad blocker.');
    document.head.appendChild(script);
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await api.login(passphrase, token || undefined);
      passphrase = '';
      onSignedIn();
    } catch (e) {
      error = (e as Error).message;
      // A Turnstile token works once: get a fresh one for the next try.
      if (turnstileSiteKey) {
        token = '';
        (window as unknown as { turnstile?: Turnstile }).turnstile?.reset(widgetId);
      }
    } finally {
      busy = false;
    }
  }
</script>

<main class="login">
  <form class="card" onsubmit={submit}>
    <div class="brand"><span class="draw"><Logo size={64} label="Ambersight" /></span><span class="wordmark">ambersight</span></div>
    <p class="muted">Every Worker on one page. Sign in with the passphrase you set when you deployed.</p>
    {#if message}<p class="message" role="status">{message}</p>{/if}
    <label for="passphrase">Passphrase</label>
    <input id="passphrase" type="password" autocomplete="current-password" bind:value={passphrase} required />
    {#if turnstileSiteKey}<div class="turnstile" bind:this={widgetEl}></div>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class="primary" type="submit" disabled={busy || !passphrase || (!!turnstileSiteKey && !token)}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form>
  <footer class="muted">Created by <a href="https://jantegze.com" target="_blank" rel="noopener">Jan Tegze</a></footer>
</main>

<style>
  .login { min-height: 100vh; display: grid; place-items: center; align-content: center; gap: 24px; padding: 24px; }
  footer { font-size: 12px; line-height: 16px; }
  form { width: min(400px, 100%); padding: 32px; display: grid; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .wordmark { font-size: 32px; font-weight: 600; letter-spacing: -0.03em; }
  label { font-size: 14px; font-weight: 500; margin-top: 8px; }
  input { height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--paper); }
  .error { color: var(--critical); font-size: 14px; }
  .message { font-size: 14px; line-height: 20px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--chip); color: var(--chip-text); }
  button { height: 44px; margin-top: 8px; }
  .turnstile { min-height: 65px; margin-top: 8px; }
</style>
