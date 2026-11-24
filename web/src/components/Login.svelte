<!-- Sign-in. With passkeys: a passkey first, an e-mailed link as the fallback, and the passphrase only to recover. Without: the passphrase (the ADMIN_PASSPHRASE secret), or a link. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { passkeysSupported } from '../lib/passkey';
  import Logo from './Logo.svelte';

  let { onSignedIn, message = '', turnstileSiteKey = null, signIn = { passkeys: false, link: false }, onRetrySignOut = null, retrying = false }: {
    onSignedIn: () => void;
    message?: string;
    turnstileSiteKey?: string | null;
    /** Which ways in the server offers. */
    signIn?: { passkeys: boolean; link: boolean };
    /** Set while the server has not confirmed a sign-out. */
    onRetrySignOut?: (() => void) | null;
    retrying?: boolean;
  } = $props();
  let passphrase = $state('');
  let error = $state('');
  let busy = $state<'' | 'passkey' | 'passphrase' | 'link'>('');
  let linkSent = $state(false);
  let recoverOpen = $state(false);
  const supported = passkeysSupported();

  // ---- Optional Cloudflare Turnstile (TURNSTILE_SITE_KEY + TURNSTILE_SECRET on the Worker), for
  // the passphrase and for asking for a link. A passkey needs no browser check: it cannot be guessed.
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
  /** A Turnstile token works once: get a fresh one for the next try. */
  function resetCheck() {
    if (!turnstileSiteKey) return;
    token = '';
    (window as unknown as { turnstile?: Turnstile }).turnstile?.reset(widgetId);
  }
  const needsCheck = $derived(!!turnstileSiteKey && !token);

  async function withPasskey() {
    busy = 'passkey';
    error = '';
    try {
      await api.loginWithPasskey();
      onSignedIn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = '';
    }
  }

  async function withPassphrase(event: SubmitEvent) {
    event.preventDefault();
    busy = 'passphrase';
    error = '';
    try {
      const r = await api.login(passphrase, token || undefined);
      passphrase = '';
      // A recovery opens Security, where lost passkeys are replaced.
      if (r.recovery) location.hash = '#/settings?tab=security';
      onSignedIn();
    } catch (e) {
      error = (e as Error).message;
      resetCheck();
    } finally {
      busy = '';
    }
  }

  async function emailLink() {
    busy = 'link';
    error = '';
    try {
      await api.requestLink(token || undefined);
      linkSent = true;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      resetCheck();
      busy = '';
    }
  }
</script>

<main class="login">
  <div class="card">
    <div class="brand"><span class="draw"><Logo size={64} label="Ambersight" /></span><span class="wordmark">ambersight</span></div>
    <p class="muted">Every Worker on one page. {signIn.passkeys ? 'Sign in with your passkey.' : 'Sign in with the passphrase you set when you deployed.'}</p>
    {#if message}<p class="message" role="status">{message}</p>{/if}
    {#if onRetrySignOut}<button type="button" onclick={onRetrySignOut} disabled={retrying}>{retrying ? 'Signing out…' : 'Try signing out again'}</button>{/if}

    {#if signIn.passkeys}
      {#if supported}
        <button class="primary" type="button" onclick={withPasskey} disabled={!!busy}>{busy === 'passkey' ? 'Waiting for your passkey…' : 'Sign in with a passkey'}</button>
      {:else}
        <p class="message">This browser cannot use passkeys. Use a current browser, or an e-mailed link.</p>
      {/if}
    {:else}
      <form onsubmit={withPassphrase}>
        <label for="passphrase">Passphrase</label>
        <input id="passphrase" type="password" autocomplete="current-password" bind:value={passphrase} required />
        <button class="primary" type="submit" disabled={!!busy || !passphrase || needsCheck}>{busy === 'passphrase' ? 'Signing in…' : 'Sign in'}</button>
      </form>
    {/if}

    {#if turnstileSiteKey}<div class="turnstile" bind:this={widgetEl}></div>{/if}

    {#if signIn.link}
      {#if linkSent}
        <p class="message" role="status">Check the operators' inbox. The link works once, for 10 minutes, and only in this browser.</p>
      {:else}
        <button type="button" class={signIn.passkeys ? '' : 'ghost'} onclick={emailLink} disabled={!!busy || needsCheck}>{busy === 'link' ? 'Sending…' : 'E-mail me a sign-in link'}</button>
      {/if}
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if signIn.passkeys}
      <details bind:open={recoverOpen}>
        <summary>Lost every passkey?</summary>
        <p class="muted small">The passphrase signs in only after the <span class="mono">ADMIN_PASSPHRASE</span> secret was replaced in Cloudflare (your Worker › Settings › Variables and Secrets). Replace it, then sign in with the new one here. That works once, ends every session, and tells the operators.</p>
        <form onsubmit={withPassphrase}>
          <label for="recovery">New ADMIN_PASSPHRASE</label>
          <input id="recovery" type="password" autocomplete="off" bind:value={passphrase} required />
          <button type="submit" disabled={!!busy || !passphrase || needsCheck}>{busy === 'passphrase' ? 'Signing in…' : 'Recover'}</button>
        </form>
      </details>
    {/if}
  </div>
  <footer class="muted">Created by <a href="https://jantegze.com" target="_blank" rel="noopener">Jan Tegze</a></footer>
</main>

<style>
  .login { min-height: 100vh; display: grid; place-items: center; align-content: center; gap: 24px; padding: 24px; }
  footer { font-size: 12px; line-height: 16px; }
  .card { width: min(400px, 100%); padding: 32px; display: grid; gap: 12px; }
  form { display: grid; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .wordmark { font-size: 32px; font-weight: 600; letter-spacing: -0.03em; }
  label { font-size: 14px; font-weight: 500; margin-top: 8px; }
  input { height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--paper); }
  .error { color: var(--critical); font-size: 14px; }
  .message { font-size: 14px; line-height: 20px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--chip); color: var(--chip-text); }
  button { height: 44px; margin-top: 8px; }
  .turnstile { min-height: 65px; margin-top: 8px; }
  details { margin-top: 8px; font-size: 14px; }
  summary { cursor: pointer; color: var(--muted, inherit); }
  details[open] { display: grid; gap: 8px; }
  .small { font-size: 13px; line-height: 18px; }
</style>
