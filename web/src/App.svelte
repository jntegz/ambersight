<!-- Ambersight shell: sign-in, first-run setup, header and navigation, then the Overview, Timeline or Settings page. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Config } from '../../src/shared/config';
  import type { Overview as OverviewData } from '../../src/shared/types';
  import Icon, { type IconName } from './components/Icon.svelte';
  import Login from './components/Login.svelte';
  import Logo from './components/Logo.svelte';
  import Overview from './pages/Overview.svelte';
  import Settings from './pages/Settings.svelte';
  import Setup from './pages/Setup.svelte';
  import Timeline from './pages/Timeline.svelte';
  import { api, ApiError, num, timeAgo } from './lib/api';
  import { currentTheme, setTheme, type Theme } from './lib/theme';

  type View = 'loading' | 'login' | 'ready' | 'error';
  type Route = 'overview' | 'timeline' | 'settings';
  let view = $state<View>('loading');
  let data = $state<OverviewData | null>(null);
  let config = $state<Config | null>(null);
  let error = $state('');
  let loginMessage = $state('');
  let scanning = $state(false);
  let notice = $state<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  let query = $state('');
  let theme = $state<Theme>(currentTheme());
  let searchEl = $state<HTMLInputElement>();

  // ---- Routing: "#/timeline" and "#/settings" are pages; any other hash (like "#w-name") is an anchor on the overview.
  const routeFrom = (hash: string): Route => (hash === '#/timeline' ? 'timeline' : hash === '#/settings' ? 'settings' : 'overview');
  let route = $state<Route>(routeFrom(location.hash));
  async function onHash() {
    const next = routeFrom(location.hash);
    const anchor = location.hash.startsWith('#w-') || location.hash === '#attention-title';
    if (next !== route) {
      route = next;
      query = '';
      if (!anchor) scrollTo(0, 0);
    }
    if (anchor) {
      // The target may only exist once the overview has rendered.
      await tick();
      const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      el?.scrollIntoView({ block: 'start' });
      // Re-trigger :target highlighting after a page switch.
      if (el) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
    }
  }
  const NAV: { route: Route; href: string; label: string; icon: IconName }[] = [
    { route: 'overview', href: '#/', label: 'Overview', icon: 'overview' },
    { route: 'timeline', href: '#/timeline', label: 'Timeline', icon: 'timeline' },
    { route: 'settings', href: '#/settings', label: 'Settings', icon: 'settings' },
  ];

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(theme);
  }

  async function load() {
    try {
      data = await api.overview();
      view = 'ready';
      loginMessage = '';
      if (!config && data.setupDone !== false) api.config().then((c) => (config = c), () => {});
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
    notice = null;
    try {
      const r = await api.scan();
      const parts = r.skipped
        ? ['A scan just ran, so this one was skipped.']
        : [
            `Scanned ${num(r.workers)} Workers, ${num(r.findings)} open ${r.findings === 1 ? 'finding' : 'findings'}, ${num(r.subrequests)} API calls.`,
            ...(r.detailRemaining ? [`${num(r.detailRemaining)} Workers still need a detailed look; the next scans finish them.`] : []),
            ...r.warnings,
          ];
      notice = { text: parts.join(' '), tone: r.warnings.length ? 'warn' : 'ok' };
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) view = 'login';
      else notice = { text: (e as Error).message, tone: 'warn' };
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

  async function bulk(ids: string[], action: 'acknowledge' | 'snooze', days?: 7 | 30 | 90) {
    await api.bulk(ids, action, days);
    await load();
  }

  /** Switch one check off. Its findings disappear now and resolve on the next scan. */
  async function mute(check: string) {
    try {
      const current = config ?? (await api.config());
      config = await api.saveConfig({ ...current, mutedChecks: [...new Set([...(current.mutedChecks ?? []), check])] });
      notice = { text: 'Check turned off. Turn it back on in Settings › Checks.', tone: 'ok' };
    } catch (e) {
      notice = { text: (e as Error).message, tone: 'warn' };
    }
  }

  function signedOut(message = '') {
    data = null;
    config = null;
    loginMessage = message;
    view = 'login';
  }

  async function signOut() {
    await api.logout().catch(() => {});
    signedOut();
  }

  // ---- Update notice, dismissable per version.
  const DISMISS = 'ambersight-update-dismissed';
  let dismissed = $state((() => { try { return localStorage.getItem(DISMISS) ?? ''; } catch { return ''; } })());
  function dismissUpdate(version: string) {
    dismissed = version;
    try { localStorage.setItem(DISMISS, version); } catch {}
  }

  function onKey(e: KeyboardEvent) {
    const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && searchEl) {
      e.preventDefault();
      searchEl.focus();
    } else if (e.key === 'Escape' && e.target === searchEl) {
      query = '';
      searchEl?.blur();
    }
  }

  onMount(async () => {
    const s = await api.session().catch(() => ({ authenticated: false }));
    if (s.authenticated) await load();
    else view = 'login';
  });

  const searchable = $derived(route !== 'settings');
</script>

<svelte:window onkeydown={onKey} onhashchange={onHash} />

{#if view === 'login'}
  <Login onSignedIn={load} message={loginMessage} />
{:else if view === 'loading'}
  <main class="center muted"><span class="draw"><Logo size={64} /></span><p>Reading your Workers…</p></main>
{:else if view === 'error'}
  <main class="center"><p role="alert">{error}</p><button onclick={load}>Try again</button></main>
{:else if data && data.setupDone === false}
  <Setup onDone={load} onSignedOut={signedOut} onUnauthorized={() => signedOut()} />
{:else if data}
  <header class="top">
    <div class="top-inner">
      <a class="brand" href="#/" aria-label="Ambersight overview"><Logo size={28} /><span class="wordmark">ambersight</span></a>
      <nav class="nav" aria-label="Main">
        {#each NAV as n (n.route)}
          <a href={n.href} aria-current={route === n.route ? 'page' : undefined}><Icon name={n.icon} size={16} /><span>{n.label}</span></a>
        {/each}
      </nav>

      {#if searchable}
        <div class="search" class:filled={!!query}>
          <label class="search-field">
            <span class="sr-only">{route === 'timeline' ? 'Search deploys' : 'Search Workers'}</span>
            <Icon name="search" size={16} />
            <input type="search" placeholder={route === 'timeline' ? 'Search deploys' : 'Search Workers'} autocomplete="off" spellcheck="false" bind:value={query} bind:this={searchEl} />
          </label>
          {#if query}
            <button type="button" class="clear" aria-label="Clear search" onclick={() => { query = ''; searchEl?.focus(); }}><Icon name="close" size={14} /></button>
          {:else}
            <kbd aria-hidden="true">/</kbd>
          {/if}
        </div>
      {/if}

      <div class="scan" class:busy={scanning}>
        <span class="scanned" title={data.lastScanAt ? `Last scan ${new Date(data.lastScanAt).toUTCString()}` : 'No scan yet'}>
          <span class="live" class:stale={!data.lastScanAt}></span>{timeAgo(data.lastScanAt)}
        </span>
        <button type="button" class="scan-btn" onclick={scanNow} disabled={scanning} aria-live="polite">
          <span class="scan-icon" class:spin={scanning}><Icon name="refresh" size={16} /></span>
          <span>{scanning ? 'Scanning' : 'Scan now'}</span>
        </button>
      </div>

      <span class="divider" aria-hidden="true"></span>

      <button type="button" class="theme" role="switch" aria-checked={theme === 'dark'} aria-label="Dark theme" title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onclick={toggleTheme}>
        <span class="thumb" aria-hidden="true"></span>
        <span class="opt" class:on={theme === 'light'} aria-hidden="true"><Icon name="sun" size={14} /></span>
        <span class="opt" class:on={theme === 'dark'} aria-hidden="true"><Icon name="moon" size={14} /></span>
      </button>
      <button type="button" class="icon-btn" onclick={signOut} aria-label="Sign out" title="Sign out"><Icon name="logout" size={16} /></button>
    </div>
  </header>

  {#if data.update && dismissed !== data.update.latest}
    <div class="banner">
      <div class="banner-inner update" role="status">
        <Icon name="download" size={18} />
        <p class="banner-text">Ambersight <strong>{data.update.latest}</strong> is out; you run {data.update.current}. <a href={data.update.url} target="_blank" rel="noopener noreferrer">What's new</a></p>
        <button type="button" class="icon-btn" aria-label="Dismiss update notice" onclick={() => dismissUpdate(data!.update!.latest)}><Icon name="close" size={14} /></button>
      </div>
    </div>
  {/if}
  {#if notice}
    <div class="banner">
      <div class="banner-inner {notice.tone}" role="status">
        <Icon name={notice.tone === 'ok' ? 'healthy' : 'warning'} size={18} />
        <p class="banner-text">{notice.text}</p>
        <button type="button" class="icon-btn" aria-label="Dismiss" onclick={() => (notice = null)}><Icon name="close" size={14} /></button>
      </div>
    </div>
  {/if}

  <main class="page">
    {#if route === 'timeline'}
      <Timeline groups={data.groups ?? []} {query} onUnauthorized={() => signedOut()} />
    {:else if route === 'settings'}
      <Settings
        workers={data.workers.map((w) => w.name)}
        groups={data.groups ?? []}
        onSaved={(c) => { config = c; load(); }}
        onSignedOut={signedOut}
        onUnauthorized={() => signedOut()}
      />
    {:else}
      <Overview {data} {query} scanInterval={config?.scanIntervalMinutes ?? null} mutedChecks={config?.mutedChecks ?? []} onAcknowledge={acknowledge} onSnooze={snooze} onBulk={bulk} onMute={mute} />
    {/if}

    <footer class="foot muted">
      Last scan {timeAgo(data.lastScanAt)} · Read-only · Runs in your own Cloudflare account ·
      <a href="https://github.com/jntegz/ambersight" target="_blank" rel="noopener noreferrer">Source (AGPL-3.0)</a>
      <br />Created by <a href="https://jantegze.com" target="_blank" rel="noopener">Jan Tegze</a>
    </footer>
  </main>
{/if}

<style>
  .foot { font-size: 12px; line-height: 18px; text-align: center; padding: 24px 0; margin-top: 16px; }
  .center { min-height: 100vh; display: grid; place-content: center; justify-items: center; gap: 16px; }

  /* Header */
  .top {
    position: sticky; top: 0; z-index: 10; border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--paper) 82%, transparent); backdrop-filter: saturate(1.4) blur(12px);
  }
  .top-inner { max-width: 1200px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 8px; }
  .brand { display: flex; align-items: center; gap: 10px; flex: 1; }
  .wordmark { font-size: 19px; font-weight: 600; letter-spacing: -0.03em; }
  /* Every header control is a 36px pill on the same surface + hairline. */
  .search, .scan, .theme, .icon-btn { height: 36px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); }

  .search {
    display: flex; align-items: center; padding: 0 6px 0 12px; margin-right: 4px; color: var(--ink-muted);
    transition: border-color 150ms, box-shadow 150ms;
  }
  .search:hover { border-color: color-mix(in srgb, var(--ink-muted) 45%, var(--line)); }
  .search:focus-within { border-color: color-mix(in srgb, var(--accent) 70%, var(--line)); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent); }
  .search-field { display: flex; align-items: center; gap: 8px; height: 100%; cursor: text; }
  .search input {
    width: 180px; height: 100%; padding: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 14px;
    transition: width 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .search:focus-within input, .search.filled input { width: 240px; }
  .search input::placeholder { color: var(--ink-muted); opacity: 1; }
  .search input::-webkit-search-cancel-button { display: none; }
  .search :global(svg) { flex: none; }
  kbd {
    display: grid; place-items: center; width: 22px; height: 22px; margin-left: 4px;
    font: 500 12px/1 var(--font); color: var(--ink-muted);
    border: 1px solid var(--line); border-radius: 6px; background: var(--paper);
  }
  .search:focus-within kbd { opacity: 0; }
  .clear {
    display: grid; place-items: center; width: 22px; min-height: 22px; height: 22px; margin-left: 4px; padding: 0;
    border: 0; border-radius: 50%; background: var(--line); color: var(--ink);
  }
  .clear:hover { background: color-mix(in srgb, var(--ink-muted) 40%, var(--line)); }

  /* Scan: last-scan status and the action share one pill. */
  .scan { display: flex; align-items: center; padding: 3px; gap: 2px; }
  .scanned { display: inline-flex; align-items: center; gap: 8px; padding: 0 10px 0 9px; font-size: 13px; color: var(--ink-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .live { width: 7px; height: 7px; border-radius: 50%; background: var(--healthy); box-shadow: 0 0 0 3px color-mix(in srgb, var(--healthy) 22%, transparent); }
  .live.stale { background: var(--ink-muted); box-shadow: none; }
  .busy .live { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  @media (prefers-reduced-motion: no-preference) { .busy .live { animation: pulse 1s ease-in-out infinite alternate; } }
  @keyframes pulse { to { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 10%, transparent); } }
  .scan-btn {
    display: inline-flex; align-items: center; gap: 6px; height: 28px; min-height: 28px; padding: 0 12px 0 10px; min-width: 104px; justify-content: center;
    border: 0; border-radius: 999px; background: var(--button); color: var(--button-text); font-size: 13px; font-weight: 600;
    transition: background 150ms, transform 100ms;
  }
  .scan-btn:hover { background: var(--button-hover); }
  .scan-btn:active { transform: scale(0.97); }
  .scan-btn:disabled { opacity: 1; background: color-mix(in srgb, var(--button) 75%, var(--surface)); }
  .scan-icon { display: inline-flex; }
  .scan-icon :global(svg) { display: block; }

  .divider { width: 1px; height: 20px; margin: 0 4px; background: var(--line); }

  /* Theme switch: sliding thumb behind sun/moon. */
  .theme { position: relative; display: inline-flex; align-items: center; gap: 0; width: 64px; padding: 3px; min-height: 36px; }
  .theme:hover { border-color: color-mix(in srgb, var(--ink-muted) 45%, var(--line)); }
  .thumb {
    position: absolute; top: 3px; left: 3px; width: 28px; height: 28px; border-radius: 50%;
    background: var(--chip); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
    transition: transform 220ms cubic-bezier(0.3, 1.3, 0.5, 1);
  }
  .theme[aria-checked='true'] .thumb { transform: translateX(28px); }
  .opt { position: relative; display: grid; place-items: center; width: 28px; height: 28px; color: var(--ink-muted); transition: color 150ms; }
  .opt.on { color: var(--chip-text); }
  .opt :global(svg) { display: block; }

  .icon-btn { display: grid; place-items: center; width: 36px; padding: 0; color: var(--ink-muted); transition: color 150ms, border-color 150ms; }
  .icon-btn:hover { color: var(--ink); border-color: color-mix(in srgb, var(--ink-muted) 45%, var(--line)); }
  .icon-btn :global(svg) { display: block; }
  .spin { display: inline-flex; }
  @media (prefers-reduced-motion: no-preference) { .spin { animation: spin 900ms linear infinite; } }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Navigation */
  .nav { display: flex; align-items: center; gap: 2px; margin-left: 20px; flex: 1; }
  .nav a {
    display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; border-radius: 999px;
    font-size: 14px; font-weight: 500; color: var(--ink-muted); text-decoration: none; transition: color 150ms, background 150ms;
  }
  .nav a:hover { color: var(--ink); background: color-mix(in srgb, var(--ink-muted) 10%, transparent); }
  .nav a[aria-current='page'] { color: var(--ink); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
  .nav a[aria-current='page'] :global(svg) { color: var(--accent); }
  .brand { flex: none; text-decoration: none; color: var(--ink); }

  /* Banners under the header */
  .banner { max-width: 1200px; margin: 16px auto 0; padding: 0 24px; }
  .banner-inner {
    display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 14px; border-radius: var(--radius-card);
    font-size: 14px; line-height: 20px; border: 1px solid var(--line); background: var(--surface);
  }
  .banner-inner.update { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
  .banner-inner.update > :global(svg) { color: var(--accent); flex: none; }
  .banner-inner.warn > :global(svg) { color: var(--accent); flex: none; }
  .banner-inner.ok > :global(svg) { color: var(--healthy); flex: none; }
  .banner-text { flex: 1; }
  .banner-text a { font-weight: 600; }
  .banner .icon-btn { width: 30px; height: 30px; border-color: transparent; background: transparent; }

  @media (max-width: 1100px) {
    .search input { width: 130px; }
    .search:focus-within input, .search.filled input { width: 180px; }
    .nav a { padding: 0 10px; }
  }
  @media (max-width: 900px) {
    .nav a span { display: none; }
    .nav { margin-left: 8px; }
  }
  @media (max-width: 760px) {
    .top-inner { flex-wrap: wrap; padding: 10px 16px; }
    .scanned, .divider { display: none; }
    .search { order: 3; width: 100%; margin: 0; }
    .search-field { flex: 1; }
    .search input, .search:focus-within input, .search.filled input { width: 100%; }
    kbd { display: none; }
    .banner { padding: 0 16px; }
  }
</style>
