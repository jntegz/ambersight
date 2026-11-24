<!-- Settings: the config document (edited as a draft, validated, then saved), plus actions that apply immediately. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { ConfigError, DEFAULT_THRESHOLDS, parseConfig, THRESHOLD_RANGES, type Config, type InstantChannel } from '../../../src/shared/config';
  import { CHECK_TITLES } from '../../../src/shared/findings';
  import type { BuildSource, RepoLayout, SetupStatus } from '../../../src/shared/types';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import MapEditor from '../components/settings/MapEditor.svelte';
  import NotifyChannels from '../components/settings/NotifyChannels.svelte';
  import OverridesEditor from '../components/settings/OverridesEditor.svelte';
  import AdminLog from '../components/settings/AdminLog.svelte';
  import ApiTokens from '../components/settings/ApiTokens.svelte';
  import PassphraseForm from '../components/settings/PassphraseForm.svelte';
  import Passkeys from '../components/settings/Passkeys.svelte';
  import PersonalData from '../components/settings/PersonalData.svelte';
  import SelfCost from '../components/settings/SelfCost.svelte';
  import Switch from '../components/Switch.svelte';
  import { api, ApiError } from '../lib/api';
  import { auth } from '../lib/auth.svelte';
  import { clearOfflineCopies } from '../lib/offline';
  import { mappingFrom, mappingProblem, suggestFor, type MappingProblem } from '../lib/repoMatch';
  import { setParam } from '../lib/route';
  import { fromDisplay, inputStep, rangeText, THRESHOLD_GROUPS, toDisplay, type ThresholdKey } from '../lib/thresholds';

  let { params = null, workers, groups, account = null, accountCount = 1, features = null, onSaved, onAccountsChanged, onSignedOut, onUnauthorized }: {
    params?: URLSearchParams | null;
    workers: string[];
    groups: string[];
    /** Optional bindings present on this install (from the overview). */
    features?: { queue: boolean; ai: boolean; turnstile: boolean; github: boolean } | null;
    /** The account selected in the header, for the Self-cost panel. */
    account?: string | null;
    accountCount?: number;
    onAccountsChanged?: () => void;
    onSaved: (config: Config) => void;
    onSignedOut: (message: string) => void;
    onUnauthorized: () => void;
  } = $props();

  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  let saved = $state<Config | null>(null);
  let draft = $state<Config | null>(null);
  let status = $state<SetupStatus | null>(null);
  let githubRepos = $state<string[]>([]);
  let githubOwner = $state<string | null>(null);
  let githubReposError = $state('');
  let githubReposLoaded = $state(false);
  let loadError = $state('');
  let saveError = $state('');
  let saving = $state(false);
  let toast = $state('');
  /** Bumped when the draft is replaced wholesale, so list editors reload from it. */
  let version = $state(0);
  let toastTimer: ReturnType<typeof setTimeout>;

  const dirty = $derived(!!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft));
  /** This save turns off recording who made changes, which erases the stored names. */
  const erasesNames = $derived(!!saved?.recordAttribution && draft?.recordAttribution === false);
  /** The switch was turned on here, from the off this page read from the server. */
  const resumesNames = $derived(saved?.recordAttribution === false && draft?.recordAttribution === true);
  let confirmErase = $state(false);
  $effect(() => {
    if (!erasesNames) confirmErase = false;
  });

  $effect(() => {
    if (features?.github && !githubReposLoaded) {
      githubReposLoaded = true;
      api.githubRepos().then((r) => {
        githubRepos = r.repos;
        githubOwner = r.owner;
        githubReposError = r.error ?? '';
      }, () => {});
    }
  });

  onMount(async () => {
    try {
      const [c, s] = await Promise.all([api.config(), api.setup().catch(() => null)]);
      // Every watched account gets an entry, so its label and plan fields have something to bind to.
      for (const id of s?.watched ?? []) c.accounts[id] ??= {};
      saved = c;
      draft = clone(c);
      status = s;
      watch = [...(s?.watched ?? [])];
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else loadError = (e as Error).message;
    }
  });

  function flash(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 3200);
  }

  const VALID_GH_REPO = /^[A-Za-z0-9-]{1,39}\/[\w.-]{1,100}$/;
  function normalizeRepo(raw: string): string {
    const s = raw.trim().replace(/^@/, '');
    const url = /^(?:https?:\/\/|ssh:\/\/git@)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)/i.exec(s)
      ?? /^git@github\.com:([^/\s]+)\/([^/\s?#]+)/i.exec(s);
    if (url) return `${url[1]}/${url[2].replace(/\.git$/i, '')}`;
    return s.replace(/\s*\/\s*/, '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  }
  const repoProblem = (raw: string) => {
    const n = normalizeRepo(raw);
    if (!n) return 'Enter owner/name (for example jntegz/ambersight), or pick from the list.';
    if (!VALID_GH_REPO.test(n) || n.split('/').some((p) => p === '.' || p === '..')) return `"${n}" is not owner/name (needs owner/repo, e.g. jntegz/ambersight).`;
    return '';
  };

  async function save() {
    if (!draft) return;
    saveError = '';
    for (const r of Object.values(draft.packageRepos)) r.repo = normalizeRepo(r.repo);
    let valid: Config;
    try {
      valid = parseConfig(clone(draft));
    } catch (e) {
      saveError = e instanceof ConfigError ? e.message : 'The settings are not valid.';
      return;
    }
    // Erasing cannot be undone: the save bar asks first.
    if (erasesNames && !confirmErase) {
      confirmErase = true;
      return;
    }
    saving = true;
    try {
      const { attributionErasure, ...stored } = await api.saveConfig(valid, erasesNames ? 'erase' : resumesNames ? 'resume' : 'keep');
      // The offline copies of views on this device still hold the names that were just erased.
      if (erasesNames) await clearOfflineCopies();
      saved = stored;
      draft = clone(stored);
      version++;
      onSaved(stored);
      flash(attributionErasure === 'done' ? 'Settings saved. The stored names are erased.'
        : attributionErasure ? 'Settings saved. The remaining names are being erased in the background.'
        : stored.recordAttribution !== valid.recordAttribution ? `Settings saved. Recording who made changes stays ${stored.recordAttribution ? 'on' : 'off'}: it was changed elsewhere.`
        : 'Settings saved. They apply from the next scan.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else saveError = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  function discard() {
    if (!saved) return;
    draft = clone(saved);
    saveError = '';
    version++;
  }

  // ---- Backup ----
  function exportConfig() {
    if (!saved) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2) + '\n'], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'ambersight-config.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  let importError = $state('');
  async function importConfig(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    importError = '';
    try {
      const imported = JSON.parse(await file.text());
      const next = parseConfig(imported);
      // A backup from before this setting says nothing about it, and no backup turns recording on.
      const staysOff = saved?.recordAttribution === false && next.recordAttribution && Object.hasOwn(imported, 'recordAttribution');
      if (saved && (staysOff || !Object.hasOwn(imported, 'recordAttribution'))) next.recordAttribution = saved.recordAttribution;
      draft = next;
      version++;
      flash(`Loaded ${file.name}. Review the changes, then save.${staysOff ? ' Recording who made changes stays off unless you turn it on.' : ''}`);
    } catch (err) {
      importError = err instanceof SyntaxError ? `${file.name} is not valid JSON.` : (err as Error).message;
    }
  }

  // ---- Accounts (applies right away, like Security) ----
  let watch = $state<string[]>([]);
  let accountsBusy = $state(false);
  let accountsError = $state('');
  const watchChanged = $derived(!!status && JSON.stringify([...watch].sort()) !== JSON.stringify([...status.watched].sort()));
  const accountName = (id: string) => status?.accounts.find((a) => a.id === id)?.name ?? id;
  async function saveAccounts() {
    accountsBusy = true;
    accountsError = '';
    try {
      await api.saveAccounts(watch);
      status = await api.setup();
      for (const id of status.watched) {
        saved!.accounts[id] ??= {};
        draft!.accounts[id] ??= {};
      }
      flash('Accounts saved. New accounts are scanned in turn from the next cron run.');
      onAccountsChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else accountsError = (e as Error).message;
    } finally {
      accountsBusy = false;
    }
  }
  const watchedCount = $derived(Math.max(accountCount, status?.watched.length ?? 0));

  async function changePassphrase(current: string, next: string) {
    await api.changePassphrase(current, next);
    onSignedOut('Passphrase changed. Every session was signed out; sign in with the new passphrase.');
  }

  // ---- Field helpers ----
  const INTERVALS = [15, 30, 60, 120, 180, 360, 720, 1440];
  const intervalLabel = (m: number) => (m < 60 ? `Every ${m} minutes` : m === 60 ? 'Every hour' : m < 1440 ? `Every ${m / 60} hours` : 'Once a day');
  const timeZones: string[] = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  })();
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const CHANNELS: { v: InstantChannel; label: string }[] = [
    { v: 'off', label: 'Off' }, { v: 'email', label: 'Email' }, { v: 'webhook', label: 'Webhook' }, { v: 'both', label: 'Both' },
  ];
  const MODULES: { key: keyof Config['modules']; title: string; text: string; icon: IconName }[] = [
    { key: 'errors', title: 'Errors', text: 'Error-rate spikes and sustained errors per Worker.', icon: 'errors' },
    { key: 'usage', title: 'Usage and limits', text: 'Free plan limits, runaway usage, idle loops, storage caps and log volume.', icon: 'usage' },
    { key: 'cron', title: 'Cron triggers', text: 'Scheduled Workers that stop running or keep failing.', icon: 'cron' },
    { key: 'deprecation', title: 'Deprecations', text: 'Old compatibility dates and deprecated settings.', icon: 'deprecation' },
    { key: 'exposure', title: 'Exposure', text: 'Public preview URLs and forgotten workers.dev hostnames.', icon: 'exposure' },
    { key: 'zombies', title: 'Unused Workers', text: 'Workers with no traffic for a long time.', icon: 'zombies' },
    { key: 'timeline', title: 'Deploy timeline', text: 'Deploy history and deploy-to-problem correlation.', icon: 'timeline' },
    { key: 'cost', title: 'Cost estimate', text: 'Estimated bill in dollars on Workers Paid, and the cost of runaway usage.', icon: 'usage' },
    { key: 'cfAlerts', title: 'Cloudflare notifications', text: 'Notifications Cloudflare sent to the account, on the timeline. Needs Notifications Read.', icon: 'mail' },
    { key: 'pages', title: 'Pages', text: 'Failed Pages deploys and public pages.dev addresses. Needs Pages Read.', icon: 'grid' },
    { key: 'security', title: 'Security', text: 'Audit log (new members, new tokens), certificates and DNS records left pointing at deleted Workers or Pages. Needs SSL and DNS Read.', icon: 'shield' },
    { key: 'drift', title: 'Config drift', text: 'Bindings that disappeared after a deploy, staging and production that differ, Workers near the limit on variables and secrets.', icon: 'list' },
    { key: 'incidents', title: 'Cloudflare incidents', text: 'Adds active incidents from cloudflarestatus.com to alerts and the timeline. Contacts that public site; sends nothing about your account.', icon: 'info' },
  ];
  let addPackageWorker = $state('');
  let addPackageRepo = $state('');
  // Mappings are per account ("<account id>:<Worker>"), so two accounts can each have a Worker of
  // the same name. A key with only the Worker name (older configs) applies in every account.
  const repoKey = (w: string) => (account ? `${account}:${w}` : w);
  const repoKeys = $derived(draft ? Object.keys(draft.packageRepos).filter((k) => !k.includes(':') || (account && k.startsWith(`${account}:`))).sort() : []);
  const workerOf = (k: string) => k.slice(k.indexOf(':') + 1);
  const unmapped = $derived(draft ? workers.filter((w) => !draft!.packageRepos[repoKey(w)] && !draft!.packageRepos[w]) : []);
  const defaultOwner = $derived.by(() => {
    if (githubOwner) return githubOwner;
    if (draft) {
      for (const r of Object.values(draft.packageRepos)) {
        const n = normalizeRepo(r.repo);
        if (VALID_GH_REPO.test(n)) return n.split('/')[0];
      }
    }
    return null;
  });
  // The repository Cloudflare builds each Worker from, read when this tab is open and the check is
  // on. It needs the optional Workers CI Read permission; without it only names are left to go on.
  let buildSources = $state<Record<string, BuildSource>>({});
  let buildSourcesReason = $state('');
  let buildUnchecked = $state(0);
  let buildSourcesLoaded = $state<string | null>(null);
  $effect(() => {
    const key = account ?? '';
    if (active !== 'packages' || !draft?.modules.packages || buildSourcesLoaded === key) return;
    buildSourcesLoaded = key;
    buildSources = {};
    buildSourcesReason = '';
    buildUnchecked = 0;
    api.buildSources(account ?? undefined).then((r) => {
      if (buildSourcesLoaded !== key) return;
      // A Worker picked before this arrived still shows the guess from its name: replace that, not something typed.
      const guessed = addPackageWorker ? (suggestFor(addPackageWorker, undefined, githubRepos)?.repo ?? '') : '';
      const fromCloudflare = addPackageWorker ? suggestFor(addPackageWorker, r.sources[addPackageWorker], githubRepos) : null;
      if (addPackageWorker && r.sources[addPackageWorker] && (!addPackageRepo || addPackageRepo === guessed)) addPackageRepo = fromCloudflare?.repo ?? '';
      buildSources = r.sources;
      buildSourcesReason = r.available ? '' : (r.reason ?? 'Cloudflare did not answer.');
      buildUnchecked = r.unchecked;
    }, () => {});
  });
  const suggestions = $derived(unmapped.map((w) => ({ worker: w, s: suggestFor(w, buildSources[w], githubRepos) })));
  /** Workers whose repository Cloudflare reports, and those with only a repository of the same name. */
  const confirmedMatches = $derived(suggestions.flatMap((m) => (m.s?.from === 'cloudflare' ? [{ worker: m.worker, source: m.s }] : [])));
  const guessedMatches = $derived(suggestions.flatMap((m) => (m.s?.from === 'name' ? [{ worker: m.worker, repo: m.s.repo }] : [])));
  /** Saved mappings that point somewhere else than Cloudflare builds from. Shown, never changed. */
  const mappingProblems = $derived.by(() => {
    const out: Record<string, MappingProblem> = {};
    if (!draft) return out;
    for (const k of repoKeys) {
      const p = mappingProblem(draft.packageRepos[k], buildSources[workerOf(k)]);
      if (p) out[k] = p;
    }
    return out;
  });
  const problemCount = $derived(Object.keys(mappingProblems).length);
  const where = (s: { repo: string; rootDir: string }) => `${s.repo}${s.rootDir ? `, folder ${s.rootDir}` : ''}`;

  /** One GitHub lookup per repository and folder: which lockfile it holds, and where. */
  const layouts = new Map<string, Promise<RepoLayout | null>>();
  function layoutOf(repo: string, rootDir: string): Promise<RepoLayout | null> {
    const key = `${repo}|${rootDir}`;
    if (!layouts.has(key)) layouts.set(key, features?.github ? api.repoLayout(repo, rootDir).catch(() => null) : Promise.resolve(null));
    return layouts.get(key)!;
  }
  let pkgNotes = $state<Record<string, string>>({});
  let mappingBusy = $state(false);
  /** Puts Cloudflare's repository in the draft for one key. Nothing is saved until Save. */
  async function applySource(key: string, source: { repo: string; rootDir: string }) {
    const layout = await layoutOf(source.repo, source.rootDir);
    if (!draft) return;
    draft.packageRepos[key] = mappingFrom(source, layout, draft.packageRepos[key]);
    pkgNotes[key] = layout?.found
      ? ''
      : `${layout?.error ?? `No lockfile found in ${where(source)}.`} Set the lockfile format${source.rootDir ? ', folder or workspace' : ''} under Options.`;
  }
  async function useSource(key: string) {
    const p = mappingProblems[key];
    if (!p || mappingBusy) return;
    mappingBusy = true;
    try {
      await applySource(key, p.source);
    } finally {
      mappingBusy = false;
    }
  }
  const addSuggestion = $derived(addPackageWorker ? suggestFor(addPackageWorker, buildSources[addPackageWorker], githubRepos) : null);
  const addSource = $derived(addPackageWorker ? buildSources[addPackageWorker] : undefined);
  const sameRepo = (a: string, b: string) => normalizeRepo(a).toLowerCase() === b.toLowerCase();
  function pickAddWorker(w: string) {
    addPackageWorker = w;
    addPackageRepo = w ? (suggestFor(w, buildSources[w], githubRepos)?.repo ?? '') : '';
  }
  async function mapWorker() {
    const repo = normalizeRepo(addPackageRepo);
    if (!draft || !addPackageWorker || !repo || mappingBusy) return;
    const key = repoKey(addPackageWorker);
    const s = addSuggestion;
    mappingBusy = true;
    try {
      // Cloudflare's repository comes with its folder and lockfile; anything typed is saved as typed.
      if (s?.from === 'cloudflare' && sameRepo(repo, s.repo)) await applySource(key, s);
      else draft.packageRepos[key] = { repo };
    } finally {
      mappingBusy = false;
    }
    addPackageWorker = '';
    addPackageRepo = '';
  }
  async function autoMapConfirmed() {
    if (!draft || mappingBusy) return;
    mappingBusy = true;
    try {
      for (const m of confirmedMatches) await applySource(repoKey(m.worker), m.source);
    } finally {
      mappingBusy = false;
    }
  }
  function autoMapGuessed() {
    if (!draft) return;
    for (const m of guessedMatches) draft.packageRepos[repoKey(m.worker)] = { repo: m.repo };
  }
  const listText = (l: string[]) => l.join(', ');
  const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

  function setThreshold(key: ThresholdKey, shown: number) {
    if (draft && Number.isFinite(shown)) draft.thresholds[key] = fromDisplay(key, shown);
  }
  function outOfRange(key: ThresholdKey, v: number) {
    const [min, max] = THRESHOLD_RANGES[key];
    return !(v >= min && v <= max);
  }

  // ---- Navigation ----
  const SECTIONS = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'accounts', label: 'Accounts', icon: 'grid' },
    { id: 'modules', label: 'Checks', icon: 'healthy' },
    { id: 'packages', label: 'npm Packages', icon: 'package' },
    { id: 'thresholds', label: 'Thresholds', icon: 'budget' },
    { id: 'groups', label: 'Groups & scope', icon: 'grid' },
    { id: 'overrides', label: 'Overrides', icon: 'list' },
    { id: 'alerts', label: 'Alerts', icon: 'snooze' },
    { id: 'digest', label: 'Digest', icon: 'mail' },
    { id: 'security', label: 'Security', icon: 'shield' },
    { id: 'cost', label: 'Self-cost', icon: 'usage' },
    { id: 'backup', label: 'Backup', icon: 'download' },
  ] as const satisfies readonly { id: string; label: string; icon: IconName }[];
  type SectionId = (typeof SECTIONS)[number]['id'];
  const isSection = (v: string | null | undefined): v is SectionId => Boolean(v && SECTIONS.some((s) => s.id === v));
  let active = $state<SectionId>('general');
  $effect(() => {
    const t = params?.get('tab');
    if (isSection(t)) active = t;
  });
  function go(id: SectionId) {
    active = id;
    setParam('tab', id === 'general' ? null : id);
    scrollTo({ top: 0, behavior: 'auto' });
  }

  let pkgFilter = $state('');
  let expandedPkg = $state<Record<string, boolean>>({});
  const filteredRepoKeys = $derived.by(() => {
    const q = pkgFilter.trim().toLowerCase();
    if (!q || !draft) return repoKeys;
    return repoKeys.filter((k) => workerOf(k).toLowerCase().includes(q) || (draft!.packageRepos[k]?.repo ?? '').toLowerCase().includes(q));
  });
  const hasExtraOpts = (r: { dir?: string; workspace?: string; ref?: string }) => Boolean(r.dir || r.workspace || r.ref);

  const targets = $derived([...groups.map((g) => `group:${g}`), ...workers]);
  const overrideCount = $derived(draft ? Object.keys(draft.overrides).length : 0);
</script>

<svelte:window onbeforeunload={(e) => { if (dirty) e.preventDefault(); }} />

<header class="page-head">
  <div>
    <h1>Settings</h1>
    <p>Changes are saved together and apply from the next scan. Security and backup actions apply right away.</p>
  </div>
</header>

{#if loadError}
  <div class="card empty"><p role="alert">{loadError}</p></div>
{:else if !draft}
  <div class="card empty muted" aria-busy="true"><p>Loading settings…</p></div>
{:else}
  <div class="layout">
    <div class="nav" role="tablist" aria-label="Settings sections">
      {#each SECTIONS as s (s.id)}
        <button type="button" role="tab" aria-selected={active === s.id} class:on={active === s.id} onclick={() => go(s.id)}>
          <Icon name={s.icon} size={16} /> {s.label}
          {#if s.id === 'packages' && repoKeys.length}<span class="count">{repoKeys.length}</span>{/if}
          {#if s.id === 'overrides' && overrideCount}<span class="count">{overrideCount}</span>{/if}
        </button>
      {/each}
    </div>

    <div class="sections" role="tabpanel">
      {#if active === 'general'}
      <!-- General -->
      <section id="s-general" class="card sec" aria-labelledby="h-general">
        <h2 id="h-general">General</h2>
        <div class="rows">
          <div class="row">
            <div class="row-text"><p class="label">Cloudflare plan</p><p class="hint">Sets the request budget and CPU limits.{#if status?.detectedPlan}{' '}Detected: <strong>{status.detectedPlan}</strong>.{/if}</p></div>
            <div class="seg" role="group" aria-label="Cloudflare plan">
              {#each ['auto', 'free', 'paid'] as const as p (p)}
                <button type="button" aria-pressed={draft.plan === p} onclick={() => (draft!.plan = p)}>{p === 'auto' ? 'Detect' : p === 'free' ? 'Free' : 'Paid'}</button>
              {/each}
            </div>
          </div>
          <div class="row">
            <div class="row-text"><p class="label">Scan frequency</p><p class="hint">The cron fires every 15 minutes; runs in between are skipped. More often costs more requests.</p></div>
            <select class="select-input w-auto" aria-label="Scan frequency" bind:value={draft.scanIntervalMinutes}>
              {#each INTERVALS.includes(draft.scanIntervalMinutes) ? INTERVALS : [...INTERVALS, draft.scanIntervalMinutes].sort((a, b) => a - b) as m (m)}
                <option value={m}>{intervalLabel(m)}</option>
              {/each}
            </select>
          </div>
          <div class="row">
            <div class="row-text"><p class="label">Time zone</p><p class="hint">Used for the digest, quiet hours and day boundaries in emails.</p></div>
            <div class="tz">
              <input class="input" list="tz-list" aria-label="Time zone" bind:value={draft.timeZone} spellcheck="false" />
              {#if draft.timeZone !== browserZone}<button type="button" class="ghost small" onclick={() => (draft!.timeZone = browserZone)}>Use {browserZone}</button>{/if}
              <datalist id="tz-list">{#each timeZones as z (z)}<option value={z}></option>{/each}</datalist>
            </div>
          </div>
          <div class="row">
            <div class="row-text"><p class="label">Keep history for</p><p class="hint">Hourly metrics, cron runs, storage operations, deploys and their authors, the audit log, Cloudflare notifications and resolved findings older than this are deleted. Kept longer: daily totals and each finding's event history, which hold counts and check names (400 days); scan records and the admin log (90 days); hourly account totals (at least 35 days). Open findings stay until they resolve.</p></div>
            <div class="range">
              <input type="range" min="7" max="90" step="1" aria-label="Retention in days" bind:value={draft.retentionDays} />
              <span class="range-value">{draft.retentionDays} days</span>
            </div>
          </div>
          <div class="row">
            <div class="row-text"><p class="label">Check for updates</p><p class="hint">Shows a notice when a new Ambersight release is out. Sends no data about your account.</p></div>
            <Switch label="Check for updates" bind:checked={draft.updateCheck} />
          </div>
          <div class="row">
            <div class="row-text">
              <p class="label">Record who made changes</p>
              <p class="hint">Stores the e-mail address or token name Cloudflare gives for each deploy and audit-log change, so you know who to ask when a change breaks something. It is shown in this dashboard and to API tokens allowed to read person-linked data, and the main digest e-mail lists deploy authors. Client digests, reports, alerts and webhooks leave it out. Off: new scans leave it out, and the checks work the same.</p>
              {#if erasesNames}<p class="hint erase-note">Saving this erases the names already stored. This cannot be undone. Turning it back on only affects future scans.</p>{/if}
            </div>
            <Switch label="Record who made changes" bind:checked={draft.recordAttribution} />
          </div>
          <details class="advanced">
            <summary><Icon name="chevron" size={14} /> Advanced</summary>
            <div class="row">
              <div class="row-text"><p class="label">Inventory refresh</p><p class="hint">Storage, routes, domains and Access are re-read this often.</p></div>
              <span class="inline">
                every <input class="input short" type="number" min="6" max="168" aria-label="Hours between inventory refreshes" bind:value={draft.inventoryIntervalHours} /> hours, preferably at
                <select class="select-input w-auto" aria-label="Preferred UTC hour" bind:value={draft.inventoryHourUtc}>
                  {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}<option value={h}>{String(h).padStart(2, '0')}:00 UTC</option>{/each}
                </select>
              </span>
            </div>
          </details>
        </div>
      </section>

      {:else if active === 'accounts'}
      <!-- Accounts -->
      <section id="s-accounts" class="card sec" aria-labelledby="h-accounts">
        <h2 id="h-accounts">Accounts</h2>
        <p class="sec-intro">One Ambersight can watch every account its token can see. Each cron run scans the account that is most overdue.</p>
        <div class="rows">
          {#if status?.accountPinned}
            <div class="row"><div class="row-text"><p class="hint"><span class="mono">CF_ACCOUNT_ID</span> in <span class="mono">wrangler.jsonc</span> pins the accounts. Change the list there.</p></div></div>
          {:else if status && !status.tokenActive}
            <div class="row"><div class="row-text"><p class="hint">Ambersight cannot list the accounts this token can see: {status.tokenError ?? 'the token does not work'}.</p></div></div>
          {:else if status && status.accounts.length > 1}
            <div class="row">
              <div class="row-text"><p class="label">Accounts to watch <span class="now">Applies right away</span></p><p class="hint">The token can see {status.accounts.length} accounts. An account you untick is no longer scanned or alerted on. A daily cleanup deletes its history on the schedule under <strong>Keep history for</strong>, and once its last scan is older than that, its findings and inventory too. Its daily totals go after 400 days.</p></div>
              <fieldset class="acct-pick" disabled={accountsBusy}>
                <legend class="sr-only">Accounts to watch</legend>
                {#each status.accounts as a (a.id)}
                  <label><input type="checkbox" value={a.id} bind:group={watch} /> {a.name}</label>
                {/each}
              </fieldset>
            </div>
            {#if watchChanged}
              <div class="inline">
                <button type="button" class="primary small" disabled={accountsBusy || !watch.length} onclick={saveAccounts}>Save accounts</button>
                <button type="button" class="ghost small" onclick={() => (watch = [...status!.watched])}>Undo</button>
                {#if !watch.length}<span class="error-text">Watch at least one account.</span>{/if}
              </div>
            {/if}
            {#if accountsError}<p class="error-text" role="alert">{accountsError}</p>{/if}
          {:else}
            <div class="row"><div class="row-text"><p class="hint">This token can see one account. To watch more, give the token access to them (or use one token per install).</p></div></div>
          {/if}
          {#each status?.watched ?? [] as id (id)}
            {#if draft.accounts[id]}
              <div class="row">
                <div class="row-text">
                  <p class="label">{accountName(id)}</p><p class="hint mono">{id}</p>
                  <input class="input acct-digest" aria-label="Digest recipients for {accountName(id)}" placeholder="Client digest to (optional, comma-separated)"
                    value={(draft.accounts[id].digestTo ?? []).join(', ')}
                    onchange={(e) => { const l = splitList(e.currentTarget.value); draft!.accounts[id].digestTo = l.length ? l : undefined; }} />
                  <label class="budget">
                    <span class="hint">Monthly budget (Workers Paid), USD</span>
                    <input class="input short" type="number" min="5" step="1" inputmode="decimal" placeholder="None"
                      aria-label="Monthly budget in US dollars for {accountName(id)}"
                      value={draft.accounts[id].budgetUsd ?? ''}
                      onchange={(e) => { const v = Number(e.currentTarget.value); draft!.accounts[id].budgetUsd = e.currentTarget.value && v >= 5 ? v : undefined; }} />
                  </label>
                </div>
                <div class="inline">
                  <input class="input" aria-label="Label for {accountName(id)}" placeholder="Label (optional)" maxlength="60"
                    value={draft.accounts[id].label ?? ''} oninput={(e) => (draft!.accounts[id].label = e.currentTarget.value.trim() || undefined)} />
                  <div class="seg" role="group" aria-label="Plan for {accountName(id)}">
                    {#each ['auto', 'free', 'paid'] as const as p (p)}
                      <button type="button" aria-pressed={(draft.accounts[id].plan ?? 'auto') === p} onclick={() => (draft!.accounts[id].plan = p === 'auto' ? undefined : p)}>{p === 'auto' ? 'Default' : p === 'free' ? 'Free' : 'Paid'}</button>
                    {/each}
                  </div>
                </div>
              </div>
            {/if}
          {/each}
          {#if watchedCount > 1 && features?.queue}
            <div class="row"><div class="row-text"><p class="hint">The scan queue is on: every account is scanned at the interval you chose, each in its own run.</p></div></div>
          {:else if watchedCount > 1}
            <div class="row"><div class="row-text"><p class="hint">With {watchedCount} accounts and one scan per 15-minute cron run, each account is scanned about every <strong>{intervalLabel(Math.max(draft.scanIntervalMinutes, watchedCount * 15)).replace('Every ', '').replace('Once a day', 'day')}</strong>. Add the scan queue in <span class="mono">wrangler.jsonc</span> to scan them all on time.</p></div></div>
          {/if}
          {#if (status?.watched.length ?? 0) > 0}
            <div class="row"><div class="row-text"><p class="hint">A client digest sends that account's own digest to each address given, on the digest schedule. Each address must also be in <span class="mono">DIGEST_TO</span>. From then on it gets only that digest, not your alerts or the all-account digest, unless it is also in <span class="mono">DIGEST_OPERATORS</span> or has the digest of every watched account.</p></div></div>
          {/if}
        </div>
      </section>

      {:else if active === 'modules'}
      <!-- Modules -->
      <section id="s-modules" class="card sec" aria-labelledby="h-modules">
        <h2 id="h-modules">Checks</h2>
        <p class="sec-intro">Budget and runaway-traffic checks are always on. Turn off the ones you do not need.</p>
        <div class="modules">
          {#each MODULES as m (m.key)}
            <div class="module" class:off={!draft.modules[m.key]}>
              <span class="m-icon"><Icon name={m.icon} size={18} /></span>
              <div><p class="label">{m.title}</p><p class="hint">{m.text}</p></div>
              <Switch label={m.title} bind:checked={draft.modules[m.key]} />
            </div>
            {#if m.key === 'exposure'}
              <div class="module sub" class:off={!draft.modules.access || !draft.modules.exposure}>
                <span></span>
                <div><p class="label">Cloudflare Access coverage</p><p class="hint">Also flag public URLs that are not behind Access. Needs the token permission <span class="mono">Access: Apps and Policies Read</span>, which the pre-filled token link leaves out: add it to the token by hand.</p></div>
                <Switch label="Cloudflare Access coverage" disabled={!draft.modules.exposure} bind:checked={draft.modules.access} />
              </div>
            {/if}
          {/each}
        </div>
        {#if draft.mutedChecks.length}
          <h3 class="muted-title">Switched off from the overview</h3>
          <ul class="muted-list">
            {#each draft.mutedChecks as c (c)}
              <li>
                <span>{CHECK_TITLES[c] ?? c} <span class="mono hint">{c}</span></span>
                <button type="button" class="ghost small" onclick={() => (draft!.mutedChecks = draft!.mutedChecks.filter((x) => x !== c))}>Turn back on</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {:else if active === 'packages'}
      <!-- npm Packages & Security -->
      <section id="s-packages" class="card sec" aria-labelledby="h-packages">
        <h2 id="h-packages">npm Packages &amp; Security</h2>
        <p class="sec-intro">
          Tracks which Workers have outdated npm dependencies or known security vulnerabilities. Once a day, Ambersight reads each mapped Worker's lockfile
          (<span class="mono">package-lock.json</span>, <span class="mono">pnpm-lock.yaml</span>, <span class="mono">yarn.lock</span> or <span class="mono">bun.lock</span>) from GitHub with your read-only <span class="mono">GITHUB_TOKEN</span>,
          compares public packages with <span class="mono">registry.npmjs.org</span>, and optionally checks CVEs via <a href="https://osv.dev" target="_blank" rel="noopener noreferrer">OSV.dev</a>. Results show on the <a href="#/packages">Packages</a> page and on each Worker's page.
        </p>

        <div class="modules">
          <div class="module" class:off={!draft.modules.packages}>
            <span class="m-icon"><Icon name="package" size={18} /></span>
            <div>
              <p class="label">Track outdated npm packages</p>
              <p class="hint">Compares direct dependencies from each mapped Worker's lockfile against the latest release on npm. Private packages are never sent anywhere.</p>
            </div>
            <Switch label="Track outdated npm packages" disabled={!features?.github && !draft.modules.packages} bind:checked={draft.modules.packages} />
          </div>

          {#if !features?.github}
            <div class="module sub pkg-setup">
              <span></span>
              <div class="callout-box">
                <p class="label">How to set up <span class="mono">GITHUB_TOKEN</span> (read-only, selected repos only)</p>
                <ol class="setup-steps">
                  <li>
                    Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub › Fine-grained personal access tokens</a>
                    (<strong>Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token</strong>).
                  </li>
                  <li>
                    Under <strong>Repository access</strong>, pick <strong>Only select repositories</strong> and choose only the Worker repos you want to track — do not grant access to all repositories.
                  </li>
                  <li>
                    Under <strong>Permissions › Repository permissions</strong>, set <strong>Contents</strong> to <strong>Read-only</strong> (GitHub adds <em>Metadata: Read-only</em> automatically). Leave every other permission on <strong>No access</strong>, then click <strong>Generate token</strong>.
                  </li>
                  <li>
                    Save the token as a Worker secret named <span class="mono">GITHUB_TOKEN</span>:
                    <ul>
                      <li><strong>Cloudflare Dashboard:</strong> <strong>Workers &amp; Pages ›</strong> this Worker <strong>› Settings › Variables and Secrets › Add › Secret</strong>, name <span class="mono">GITHUB_TOKEN</span>, paste the token, and deploy.</li>
                      <li><strong>Terminal:</strong> <span class="mono">npx wrangler secret put GITHUB_TOKEN</span> (add <span class="mono">--name &lt;worker&gt;</span> if renamed).</li>
                    </ul>
                  </li>
                  <li>Reload this page, turn <strong>Track outdated npm packages</strong> on above, and map your Workers below.</li>
                </ol>
              </div>
              <span></span>
            </div>
          {/if}

          <div class="module sub" class:off={!draft.modules.packagesOsv || !draft.modules.packages}>
            <span></span>
            <div>
              <p class="label">Check known security vulnerabilities (OSV.dev)</p>
              <p class="hint">
                <strong>No API key or account needed</strong> — <a href="https://osv.dev" target="_blank" rel="noopener noreferrer">OSV.dev</a> is a free public vulnerability database.
                Turn this on once package tracking is enabled and Ambersight checks locked public-registry packages once a day against <span class="mono">api.osv.dev</span> in one batch query. Raises <span class="mono">packages:vulnerable</span> findings.
              </p>
            </div>
            <Switch label="Check known security vulnerabilities (OSV.dev)" disabled={!draft.modules.packages} bind:checked={draft.modules.packagesOsv} />
          </div>
        </div>

        {#if draft.modules.packages}
          <div class="pkg-section">
            <h3 class="sub-h">Workers and their GitHub repositories</h3>
            {#if githubReposError}
              <p class="field-err" role="status">{githubReposError}</p>
            {:else if githubRepos.length}
              <p class="hint"><span class="mono">GITHUB_TOKEN</span> can read <strong>{githubRepos.length}</strong> {githubRepos.length === 1 ? 'repository' : 'repositories'} on GitHub. Select a Worker below to see the repository suggested for it.</p>
            {:else if features?.github}
              <p class="hint">Map each Worker to its GitHub repository (<span class="mono">owner/name</span> or paste a GitHub URL). Optional fields cover pnpm/yarn/bun lockfiles, subfolders, monorepo workspaces, and branches.</p>
            {/if}
            {#if status?.githubRepoAllowlist}
              <p class="hint"><span class="mono">GITHUB_REPO_ALLOWLIST</span> limits reads to: <span class="mono">{status.githubRepoAllowlist.join(', ')}</span>.</p>
            {:else}
              <p class="hint">Anyone signed in can map any repository <span class="mono">GITHUB_TOKEN</span> can read, so scope that token only to the repositories you mean to track, or set <span class="mono">GITHUB_REPO_ALLOWLIST</span>.</p>
            {/if}
            {#if buildSourcesReason}
              <p class="hint" role="status">
                Cloudflare was not asked which repository each Worker is built from: {buildSourcesReason}
                Until then a repository is suggested only when it has the Worker's name, which can be the wrong one.
                To fix it, add <strong>Account › Workers CI › Read</strong> to <span class="mono">CF_API_TOKEN</span> under <strong>My Profile › API Tokens</strong> in the Cloudflare dashboard. It is optional, and read only on this page.
              </p>
            {:else if buildUnchecked}
              <p class="hint" role="status">This account has more Workers than one request can ask Cloudflare about. {buildUnchecked} were not checked, so they get a suggestion from their name at most.</p>
            {/if}
            {#if problemCount}
              <p class="pkg-warn" role="status">
                <Icon name="warning" size={14} />
                <span><strong>{problemCount}</strong> mapped {problemCount === 1 ? 'Worker points' : 'Workers point'} at a different repository or folder than the one Cloudflare builds {problemCount === 1 ? 'it' : 'them'} from. Nothing was changed: review {problemCount === 1 ? 'it' : 'them'} below.</span>
              </p>
            {/if}
            <details class="hint-details">
              <summary>Need to rotate or limit <span class="mono">GITHUB_TOKEN</span>?</summary>
              <ol class="setup-steps">
                <li>Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained GitHub token</a> with <strong>Only select repositories</strong> and <strong>Repository permissions › Contents: Read-only</strong> (leave everything else on <strong>No access</strong>).</li>
                <li>Add or replace the <span class="mono">GITHUB_TOKEN</span> secret in <strong>Workers &amp; Pages ›</strong> this Worker <strong>› Settings › Variables and Secrets</strong>, or run <span class="mono">npx wrangler secret put GITHUB_TOKEN</span>.</li>
              </ol>
            </details>

            {#if githubRepos.length}
              <datalist id="ambersight-gh-repos">
                {#each githubRepos as r (r)}<option value={r}></option>{/each}
              </datalist>
            {/if}

            {#if unmapped.length}
              <div class="pkg-add">
                <div class="pkg-add-row">
                  <select class="input" aria-label="Worker to map" value={addPackageWorker} onchange={(e) => pickAddWorker(e.currentTarget.value)}>
                    <option value="">Select a Worker to track…</option>
                    {#each unmapped as w (w)}<option value={w}>{w}</option>{/each}
                  </select>
                  {#if addPackageWorker}
                    {#if githubRepos.length}
                      <select
                        class="input"
                        aria-label="Pick GitHub repository"
                        value={githubRepos.includes(addPackageRepo) ? addPackageRepo : ''}
                        onchange={(e) => { if (e.currentTarget.value) addPackageRepo = e.currentTarget.value; }}
                      >
                        <option value="">Pick GitHub repo…</option>
                        {#each githubRepos as r (r)}<option value={r}>{r}</option>{/each}
                      </select>
                    {/if}
                    <input
                      class="input"
                      list={githubRepos.length ? 'ambersight-gh-repos' : undefined}
                      aria-label="Repository for {addPackageWorker}"
                      placeholder={defaultOwner ? `${defaultOwner}/${addPackageWorker}` : 'owner/name or GitHub URL'}
                      bind:value={addPackageRepo}
                      onblur={() => (addPackageRepo = normalizeRepo(addPackageRepo))}
                    />
                  {/if}
                  <button type="button" class="primary small" disabled={!addPackageWorker || !normalizeRepo(addPackageRepo) || mappingBusy} onclick={mapWorker}>Add</button>
                </div>
                {#if addPackageWorker}
                  {#if addSuggestion?.from === 'cloudflare'}
                    <p class="hint">
                      Cloudflare builds <span class="mono">{addPackageWorker}</span> from <span class="mono">{where(addSuggestion)}</span>.
                      {#if addPackageRepo && !sameRepo(addPackageRepo, addSuggestion.repo)}The repository entered here is a different one.{/if}
                    </p>
                  {:else if addSource}
                    <p class="hint">Cloudflare builds <span class="mono">{addPackageWorker}</span> from a repository that is not on GitHub ({addSource.provider}). The Packages check reads GitHub only.</p>
                  {:else if addSuggestion?.from === 'name' && sameRepo(addPackageRepo, addSuggestion.repo)}
                    <p class="hint">Suggested because the repository has the Worker's name. Check that <span class="mono">{addPackageWorker}</span> is deployed from it before you add it.</p>
                  {/if}
                {/if}
                {#if confirmedMatches.length}
                  <div class="pkg-auto">
                    <button type="button" class="ghost small" disabled={mappingBusy} onclick={autoMapConfirmed}>
                      Map {confirmedMatches.length} {confirmedMatches.length === 1 ? 'Worker' : 'Workers'} to the repository Cloudflare builds {confirmedMatches.length === 1 ? 'it' : 'them'} from
                    </button>
                    <ul class="pkg-pairs">
                      {#each confirmedMatches as m (m.worker)}<li><span class="mono">{m.worker}</span> → <span class="mono">{where(m.source)}</span></li>{/each}
                    </ul>
                  </div>
                {/if}
                {#if guessedMatches.length}
                  <div class="pkg-auto">
                    <button type="button" class="ghost small" onclick={autoMapGuessed}>
                      Map {guessedMatches.length} {guessedMatches.length === 1 ? 'Worker' : 'Workers'} by name (a guess)
                    </button>
                    <ul class="pkg-pairs">
                      {#each guessedMatches as m (m.worker)}<li><span class="mono">{m.worker}</span> → <span class="mono">{m.repo}</span></li>{/each}
                    </ul>
                    <span class="hint">A repository with the Worker's name is not always the one it is deployed from. Check each pair.</span>
                  </div>
                {/if}
              </div>
            {/if}

            {#if repoKeys.length}
              <div class="pkg-list-head">
                <span class="hint"><strong>{repoKeys.length}</strong> mapped {repoKeys.length === 1 ? 'Worker' : 'Workers'}{#if pkgFilter.trim()} (showing {filteredRepoKeys.length}){/if}</span>
                {#if repoKeys.length >= 4}
                  <input class="input pkg-search" type="search" placeholder="Filter {repoKeys.length} mapped Workers…" aria-label="Filter mapped Workers" bind:value={pkgFilter} />
                {/if}
              </div>
              <div class="pkg-table">
                {#each filteredRepoKeys as name (name)}
                  {@const entry = draft.packageRepos[name]}
                  {@const badRepo = repoProblem(entry.repo)}
                  {@const problem = mappingProblems[name]}
                  {@const extraOpen = Boolean(expandedPkg[name])}
                  {@const hasExtra = hasExtraOpts(entry)}
                  <div class="pkg-item" class:invalid-row={!!badRepo}>
                    <div class="pkg-item-main">
                      <span class="mono pkg-name" title={workerOf(name)}>
                        {workerOf(name)}{#if !name.includes(':') && accountCount > 1} <span class="hint">(all)</span>{/if}
                      </span>
                      <div class="pkg-repo-inputs">
                        {#if githubRepos.length}
                          <select
                            class="input pkg-repo-pick"
                            aria-label="Pick repository for {workerOf(name)}"
                            value={githubRepos.includes(entry.repo) ? entry.repo : ''}
                            onchange={(e) => { if (e.currentTarget.value) draft!.packageRepos[name].repo = e.currentTarget.value; }}
                          >
                            <option value="">GitHub repo…</option>
                            {#each githubRepos as r (r)}<option value={r}>{r}</option>{/each}
                          </select>
                        {/if}
                        <input
                          class="input"
                          class:invalid={!!badRepo}
                          list={githubRepos.length ? 'ambersight-gh-repos' : undefined}
                          aria-label="Repository for {workerOf(name)}"
                          placeholder={defaultOwner ? `${defaultOwner}/${workerOf(name)}` : 'owner/name or GitHub URL'}
                          bind:value={draft.packageRepos[name].repo}
                          onblur={() => (draft!.packageRepos[name].repo = normalizeRepo(draft!.packageRepos[name].repo))}
                        />
                      </div>
                      <select
                        class="input pkg-kind-sel"
                        aria-label="Lockfile format for {workerOf(name)}"
                        value={entry.lockfile ?? 'npm'}
                        onchange={(e) => { const v = e.currentTarget.value; draft!.packageRepos[name].lockfile = v === 'npm' ? undefined : (v as 'pnpm' | 'yarn' | 'bun'); }}
                      >
                        <option value="npm">npm</option>
                        <option value="pnpm">pnpm</option>
                        <option value="yarn">yarn</option>
                        <option value="bun">bun</option>
                      </select>
                      <button
                        type="button"
                        class="ghost small pkg-opt-btn"
                        class:has-extra={hasExtra}
                        aria-expanded={extraOpen}
                        title="Lockfile folder, monorepo workspace, or branch"
                        onclick={() => (expandedPkg[name] = !extraOpen)}
                      >
                        {extraOpen ? 'Hide options' : hasExtra ? 'Options •' : 'Options'}
                      </button>
                      <button type="button" class="ghost small" onclick={() => delete draft!.packageRepos[name]}>Remove</button>
                    </div>
                    {#if badRepo}<p class="field-err pkg-row-err">{badRepo}</p>{/if}
                    {#if problem}
                      <p class="pkg-warn pkg-row-err" role="status">
                        <Icon name="warning" size={14} />
                        <span>
                          {#if problem.kind === 'repo'}
                            Cloudflare builds this Worker from <span class="mono">{where(problem.source)}</span>, not from this repository.
                          {:else}
                            Cloudflare builds this Worker from the folder <span class="mono">{problem.source.rootDir}</span>, which this mapping does not read.
                          {/if}
                        </span>
                        <button type="button" class="ghost small" disabled={mappingBusy} onclick={() => useSource(name)}>Use Cloudflare's repository</button>
                      </p>
                    {/if}
                    {#if pkgNotes[name]}<p class="hint pkg-row-err" role="status">{pkgNotes[name]}</p>{/if}
                    {#if !extraOpen && hasExtra}
                      <p class="pkg-extra-summary muted">
                        {#if entry.dir}folder: <span class="mono">{entry.dir}</span>{' '}{/if}
                        {#if entry.workspace}workspace: <span class="mono">{entry.workspace}</span>{' '}{/if}
                        {#if entry.ref}branch: <span class="mono">{entry.ref}</span>{/if}
                      </p>
                    {/if}
                    {#if extraOpen}
                      <div class="pkg-extra">
                        <label class="pkg-field">
                          <span>Lockfile folder <span class="muted">(optional)</span></span>
                          <input class="input" aria-label="Folder for {workerOf(name)}" placeholder="root" value={entry.dir ?? ''} oninput={(e) => (draft!.packageRepos[name].dir = e.currentTarget.value.trim() || undefined)} />
                        </label>
                        <label class="pkg-field">
                          <span>Workspace <span class="muted">(monorepo)</span></span>
                          <input class="input" aria-label="Workspace for {workerOf(name)}" placeholder="e.g. workers/api" value={entry.workspace ?? ''} oninput={(e) => (draft!.packageRepos[name].workspace = e.currentTarget.value.trim() || undefined)} />
                        </label>
                        <label class="pkg-field">
                          <span>Branch <span class="muted">(optional)</span></span>
                          <input class="input" aria-label="Branch for {workerOf(name)}" placeholder="default" value={entry.ref ?? ''} oninput={(e) => (draft!.packageRepos[name].ref = e.currentTarget.value.trim() || undefined)} />
                        </label>
                      </div>
                    {/if}
                  </div>
                {:else}
                  <p class="hint pkg-empty">No mapped Workers match "{pkgFilter}".</p>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </section>

      {:else if active === 'thresholds'}
      <!-- Thresholds -->
      <section id="s-thresholds" class="card sec" aria-labelledby="h-thresholds">
        <h2 id="h-thresholds">Thresholds</h2>
        <p class="sec-intro">Global defaults. Use overrides to change them for one Worker or group.</p>
        {#each THRESHOLD_GROUPS as g (g.title)}
          <fieldset class="tgroup">
            <legend>{g.title}</legend>
            {#each g.items as m (m.key)}
              {@const v = draft.thresholds[m.key]}
              <div class="row">
                <div class="row-text"><p class="label">{m.label}</p><p class="hint">{m.help} Range {rangeText(m.key)}.</p></div>
                <span class="with-unit">
                  {#if v !== DEFAULT_THRESHOLDS[m.key]}
                    <button type="button" class="ghost small" title="Back to {toDisplay(m.key, DEFAULT_THRESHOLDS[m.key])}{m.unit}" onclick={() => (draft!.thresholds[m.key] = DEFAULT_THRESHOLDS[m.key])}>Reset</button>
                  {/if}
                  <input class="input short" type="number" step={inputStep(m.key)} aria-label={m.label} aria-invalid={outOfRange(m.key, v)}
                    value={toDisplay(m.key, v)} oninput={(e) => setThreshold(m.key, e.currentTarget.valueAsNumber)} />
                  <span class="unit muted">{m.unit}</span>
                </span>
              </div>
            {/each}
          </fieldset>
        {/each}
      </section>

      {:else if active === 'groups'}
      <!-- Groups & scope -->
      <section id="s-groups" class="card sec" aria-labelledby="h-groups">
        <h2 id="h-groups">Groups & scope</h2>
        <p class="sec-intro">Group Workers by name pattern (<span class="mono">*</span> is a wildcard). Cloudflare tags become groups automatically.</p>
        {#key version}
          <MapEditor bind:value={draft.groups} keyLabel="Group" listLabel="Worker name patterns" keyPlaceholder="api" listPlaceholder="api-*, auth-gateway" addLabel="Add group" />
        {/key}
        <div class="scope-fields">
          <label class="field">
            <span class="label">Only watch</span>
            <input class="input mono-input" placeholder="Everything" value={listText(draft.scope.include)} oninput={(e) => (draft!.scope.include = splitList(e.currentTarget.value))} />
            <span class="hint">Patterns or <span class="mono">group:name</span>, comma separated. Empty watches every Worker. Patterns match the whole name; <span class="mono">*</span> stands for any characters.</span>
          </label>
          <label class="field">
            <span class="label">Ignore</span>
            <input class="input mono-input" placeholder="Nothing" value={listText(draft.scope.exclude)} oninput={(e) => (draft!.scope.exclude = splitList(e.currentTarget.value))} />
            <span class="hint">Ignored Workers get no findings or Worker page, and their deploys, deploy authors and package files are not collected. Ambersight still reads their name, tags, traffic totals, schedule and storage bindings, because account limits and the unused-storage checks count them.</span>
          </label>
        </div>
      </section>

      {:else if active === 'overrides'}
      <!-- Overrides -->
      <section id="s-overrides" class="card sec" aria-labelledby="h-overrides">
        <h2 id="h-overrides">Overrides</h2>
        <p class="sec-intro">Different thresholds for one Worker or a whole group. A Worker override beats a group override, which beats the global value.</p>
        {#key version}
          <OverridesEditor bind:value={draft.overrides} defaults={draft.thresholds} {targets} />
        {/key}
      </section>

      {:else if active === 'alerts'}
      <!-- Alerts -->
      <section id="s-alerts" class="card sec" aria-labelledby="h-alerts">
        <h2 id="h-alerts">Alerts</h2>
        <p class="sec-intro">How each severity reaches you: right away, in the digest, or both.</p>
        <div class="routes" role="table" aria-label="Alert routing">
          <div class="r-row r-head" role="row"><span role="columnheader">Severity</span><span role="columnheader">Instant alert</span><span role="columnheader">In digest</span></div>
          {#each ['critical', 'warning', 'info'] as const as sev (sev)}
            <div class="r-row" role="row">
              <span class="sev {sev}" role="cell"><Icon name={sev} size={16} /> {sev[0].toUpperCase() + sev.slice(1)}</span>
              <span role="cell">
                <span class="seg" role="group" aria-label="Instant alert for {sev}">
                  {#each CHANNELS as c (c.v)}
                    <button type="button" aria-pressed={draft.alerts[sev].instant === c.v} onclick={() => (draft!.alerts[sev].instant = c.v)}>{c.label}</button>
                  {/each}
                </span>
              </span>
              <span role="cell"><Switch label="Include {sev} in digest" bind:checked={draft.alerts[sev].digest} /></span>
            </div>
          {/each}
        </div>
        <div class="row quiet">
          <div class="row-text"><p class="label">Quiet hours</p><p class="hint">Instant alerts wait until quiet hours end ({draft.timeZone}).</p></div>
          <span class="inline">
            {#if draft.alerts.quietHours}
              <input class="input time" type="time" aria-label="Quiet hours start" bind:value={draft.alerts.quietHours.start} />
              <span class="muted">to</span>
              <input class="input time" type="time" aria-label="Quiet hours end" bind:value={draft.alerts.quietHours.end} />
            {/if}
            <Switch label="Quiet hours" checked={!!draft.alerts.quietHours}
              onchange={(on) => (draft!.alerts.quietHours = on ? { start: '22:00', end: '07:00' } : null)} />
          </span>
        </div>
        {#if status}
          <h3 class="sub-title">Channels</h3>
          <NotifyChannels {status} />
        {/if}
      </section>

      {:else if active === 'digest'}
      <!-- Digest -->
      <section id="s-digest" class="card sec" aria-labelledby="h-digest">
        <h2 id="h-digest">Digest</h2>
        <div class="rows">
          <div class="row">
            <div class="row-text"><p class="label">Send a summary</p><p class="hint">Open findings, free plan headroom, biggest traffic changes, the estimated bill and deploys, by email. Monthly goes out on the 1st.</p></div>
            <span class="inline">
              <span class="seg" role="group" aria-label="Digest frequency">
                {#each ['daily', 'weekly', 'monthly', 'off'] as const as f (f)}
                  <button type="button" aria-pressed={draft.digest.frequency === f} onclick={() => (draft!.digest.frequency = f)}>{f[0].toUpperCase() + f.slice(1)}</button>
                {/each}
              </span>
            </span>
          </div>
          {#if draft.digest.frequency !== 'off'}
            <div class="row">
              <div class="row-text"><p class="label">When</p><p class="hint">In {draft.timeZone}.</p></div>
              <span class="inline">
                {#if draft.digest.frequency === 'weekly'}
                  <select class="select-input w-auto" aria-label="Weekday" bind:value={draft.digest.weekday}>
                    {#each WEEKDAYS as d, i (d)}<option value={i}>{d}</option>{/each}
                  </select>
                  <span class="muted">at</span>
                {/if}
                <select class="select-input w-auto" aria-label="Hour" bind:value={draft.digest.hour}>
                  {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}<option value={h}>{String(h).padStart(2, '0')}:00</option>{/each}
                </select>
              </span>
            </div>
            <div class="row">
              <div class="row-text">
                <p class="label">Plain-language summary</p>
                <p class="hint">
                  {#if features?.ai}A few sentences at the top on what to fix first, written by Workers AI from each check's name, severity, count and Worker names. Uses a little of the account's free 10,000 neurons a day.
                  {:else}Needs the <span class="mono">AI</span> binding in <span class="mono">wrangler.jsonc</span> (Workers AI, free allocation of 10,000 neurons a day).{/if}
                </p>
              </div>
              <Switch label="Plain-language summary" disabled={!features?.ai} bind:checked={draft.digest.aiSummary} />
            </div>
            {#if draft.digest.aiSummary}
              <div class="row">
                <div class="row-text"><p class="label">Workers AI model</p><p class="hint">A small text model is enough. Some models need Workers Paid.</p></div>
                <input class="input" aria-label="Workers AI model" spellcheck="false" bind:value={draft.digest.aiModel} />
              </div>
            {/if}
            <div class="field">
              <p class="label">Extra digest per group</p>
              <p class="hint">Sends a group-only digest to each of these addresses. Each must also be in <span class="mono">DIGEST_TO</span>, and then gets only this digest unless it is also in <span class="mono">DIGEST_OPERATORS</span>.</p>
              {#key version}
                <MapEditor bind:value={draft.digest.groupRecipients} keyLabel="Group" listLabel="Email addresses" keyPlaceholder="api" listPlaceholder="team@example.com" addLabel="Add group digest" keyOptions={groups} />
              {/key}
            </div>
          {/if}
        </div>
      </section>

      {:else if active === 'security'}
      <!-- Security -->
      <section id="s-security" class="card sec" aria-labelledby="h-security">
        <h2 id="h-security">Security <span class="now">Applies right away</span></h2>
        <div class="callout">
          <Icon name="shield" size={18} />
          {#if status?.behindAccess}
            <p><strong>Protected by Cloudflare Access.</strong> This visit came through Access. Other addresses of this Worker (such as workers.dev) are only protected if your Access application covers them too.</p>
          {:else}
            <p><strong>Not behind Cloudflare Access.</strong> Anyone who finds this URL can reach the sign-in page. In the Cloudflare dashboard open this Worker's <strong>Access</strong> tab and choose <strong>Protect this Worker behind Access</strong> (free for small teams, with MFA or passkeys from your identity provider). <a href="https://developers.cloudflare.com/workers/configuration/cloudflare-access/" target="_blank" rel="noopener noreferrer">How it works</a></p>
          {/if}
        </div>
        <h3 class="sub-h">Passkeys</h3>
        <Passkeys />
        <h3 class="sub-h">Passphrase</h3>
        {#if auth.passkeys}
          <p class="hint">The passphrase no longer signs in: it is kept for recovery. If you lose every passkey, replace the <span class="mono">ADMIN_PASSPHRASE</span> secret in Cloudflare (your Worker › Settings › Variables and Secrets, or <span class="mono">npx wrangler secret put ADMIN_PASSPHRASE</span>) and sign in with the new one. That works once, ends every session and API token, and tells the operators.</p>
        {:else}
          {#if status?.passphraseFromSettings === false}
            <p class="hint">The passphrase currently comes from the <span class="mono">ADMIN_PASSPHRASE</span> secret. Changing it here stores a new one that takes over until that secret is replaced.</p>
          {/if}
          <PassphraseForm onSubmit={changePassphrase} note="Signs out every session, including this one, and stops every API token." />
        {/if}
        <h3 class="sub-h">Read-only API tokens</h3>
        <ApiTokens />
        <h3 class="sub-h">Admin activity</h3>
        <AdminLog />
        <h3 class="sub-h">Remove one person from stored data</h3>
        <PersonalData />
      </section>

      {:else if active === 'cost'}
      <!-- Self-cost -->
      <section id="s-cost" class="card sec" aria-labelledby="h-cost">
        <h2 id="h-cost">Self-cost</h2>
        <p class="sec-intro">What Ambersight itself uses today, against the free plan allowances.</p>
        <SelfCost {account} />
      </section>

      {:else if active === 'backup'}
      <!-- Backup -->
      <section id="s-backup" class="card sec" aria-labelledby="h-backup">
        <h2 id="h-backup">Backup</h2>
        <p class="sec-intro">Export the saved settings as JSON, or load a file to review before saving.</p>
        <div class="inline">
          <button type="button" onclick={exportConfig}><Icon name="download" size={16} /> Export config.json</button>
          <label class="file-btn">
            <Icon name="upload" size={16} /> Import…
            <input type="file" accept="application/json,.json" onchange={importConfig} />
          </label>
        </div>
        {#if importError}<p class="error-text" role="alert">{importError}</p>{/if}
      </section>
      {/if}
    </div>
  </div>

  {#if dirty || saveError}
    <div class="savebar" role="region" aria-label="Unsaved changes">
      <div class="savebar-inner" class:confirming={confirmErase}>
        <span class="sb-dot" class:bad={!!saveError || confirmErase}></span>
        {#if confirmErase}
          <p class="sb-text">{#if saveError}<span class="error-text">{saveError}</span>{:else}This erases every stored name of who deployed or changed something. It cannot be undone.{/if}</p>
          <button type="button" class="ghost" onclick={() => (confirmErase = false)} disabled={saving}>Cancel</button>
          <button type="button" class="danger" onclick={save} disabled={saving}>{saving ? 'Erasing…' : 'Erase names and save'}</button>
        {:else}
          <p class="sb-text">{#if saveError}<span class="error-text">{saveError}</span>{:else}You have unsaved changes.{/if}</p>
          <button type="button" class="ghost" onclick={discard} disabled={saving}>Discard</button>
          <button type="button" class="primary" onclick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save changes'}</button>
        {/if}
      </div>
    </div>
  {/if}
{/if}

{#if toast}<div class="toast" role="status"><Icon name="check" size={16} /> {toast}</div>{/if}

<style>
  .layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 28px; align-items: start; }
  .nav { position: sticky; top: 84px; display: grid; gap: 2px; }
  .nav button { justify-content: flex-start; gap: 10px; min-height: 34px; padding: 0 12px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--ink-muted); font-size: 14px; text-align: left; }
  .nav button:hover { color: var(--ink); background: var(--surface); }
  .nav button.on { color: var(--ink); background: var(--surface); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
  .nav .count { margin-left: auto; }
  .sections { display: grid; gap: 20px; padding-bottom: 96px; }
  .sec { padding: 24px; display: grid; gap: 16px; scroll-margin-top: 84px; }
  .sec h2 { display: flex; align-items: center; gap: 10px; font-size: 18px; line-height: 24px; letter-spacing: -0.01em; }
  .now { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--line); color: var(--ink-muted); letter-spacing: 0; }
  .sec-intro { font-size: 14px; line-height: 20px; color: var(--ink-muted); margin-top: -8px; }
  .sub-title { font-size: 14px; font-weight: 600; margin-top: 8px; }
  .rows { display: grid; }
  .acct-digest { margin-top: 8px; width: 100%; max-width: 420px; }
  .acct-pick { margin: 0; padding: 0; border: 0; display: grid; gap: 6px; }
  .acct-pick label { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
  .acct-pick input { width: 16px; height: 16px; accent-color: var(--accent); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px 24px; padding: 14px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
  .rows > .row:first-child { border-top: 0; padding-top: 0; }
  .row-text { flex: 1 1 260px; min-width: 0; }
  .label { font-size: 14px; line-height: 20px; font-weight: 500; }
  .row .hint { margin-top: 2px; }
  .hint strong { color: var(--ink); font-weight: 600; }
  .w-auto { width: auto; }
  .small { min-height: 28px; padding: 0 8px; font-size: 12px; }
  .inline { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; }
  .tz { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tz .input { width: 240px; }
  .range { display: flex; align-items: center; gap: 12px; }
  .range input { width: 200px; accent-color: var(--button); }
  .range-value { min-width: 64px; font-weight: 600; font-size: 14px; font-variant-numeric: tabular-nums; }
  .advanced { border-top: 1px solid var(--line); padding-top: 12px; }
  .advanced summary { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-muted); cursor: pointer; list-style: none; }
  .advanced summary::-webkit-details-marker { display: none; }
  .advanced summary :global(svg) { transition: transform 150ms; transform: rotate(-90deg); }
  .advanced[open] summary :global(svg) { transform: none; }
  .advanced .row { border-top: 0; }

  .modules { display: grid; gap: 0; }
  .module { display: grid; grid-template-columns: 36px 1fr auto; gap: 14px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
  .muted-title { font-size: 14px; line-height: 20px; font-weight: 600; margin: 20px 0 4px; }
  .muted-list { list-style: none; margin: 0; padding: 0; }
  .muted-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px; }
  .muted-list .hint { margin-left: 6px; }
  .module:first-child { border-top: 0; padding-top: 0; }
  .module.sub { border-top: 0; padding-top: 0; }
  .m-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--chip); color: var(--chip-text); transition: opacity 150ms; }
  .module.off .m-icon { background: var(--line); color: var(--ink-muted); }
  .module.off .label { color: var(--ink-muted); }

  .tgroup { border: 0; margin: 0; padding: 0; }
  .tgroup legend { padding: 0; margin-bottom: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-muted); }
  .tgroup .row:first-of-type { border-top: 0; }
  .with-unit { display: inline-flex; align-items: center; gap: 8px; }
  .unit { width: 48px; font-size: 13px; }
  .short { text-align: right; font-variant-numeric: tabular-nums; }

  .scope-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 4px; }
  .mono-input { font-family: var(--mono); font-size: 13px; }

  .routes { display: grid; border: 1px solid var(--line); border-radius: var(--radius-control); overflow: hidden; }
  .r-row { display: grid; grid-template-columns: 140px 1fr 100px; gap: 12px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--line); }
  .r-row:first-child { border-top: 0; }
  .r-head { font-size: 12px; color: var(--ink-muted); background: var(--paper); padding-top: 8px; padding-bottom: 8px; }
  .sev { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
  .sev.critical :global(svg) { color: var(--critical); }
  .sev.warning :global(svg) { color: var(--accent); }
  .sev.info :global(svg) { color: var(--ink-muted); }
  .seg { width: max-content; }
  .quiet { border-top: 0; }
  .time { width: 120px; }

  .callout { display: flex; gap: 10px; align-items: start; padding: 12px 14px; border-radius: var(--radius-control); background: var(--row-tint); font-size: 14px; line-height: 20px; }
  .callout :global(svg) { flex: none; color: var(--accent); margin-top: 1px; }

  .file-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--surface); font-size: 14px; cursor: pointer; }
  .file-btn:hover { border-color: var(--ink-muted); }
  .file-btn:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
  .file-btn input { position: absolute; width: 1px; height: 1px; opacity: 0; }

  .savebar { position: fixed; left: 0; right: 0; bottom: 20px; z-index: 30; display: flex; justify-content: center; padding: 0 16px; pointer-events: none; }
  .savebar-inner {
    pointer-events: auto; display: flex; align-items: center; gap: 12px; width: min(640px, 100%); padding: 10px 10px 10px 18px;
    border: 1px solid var(--line); border-radius: 14px; background: var(--surface);
    box-shadow: 0 18px 48px -12px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.08);
  }
  @media (prefers-reduced-motion: no-preference) { .savebar-inner { animation: up 220ms cubic-bezier(0.2, 0.8, 0.2, 1); } }
  @keyframes up { from { opacity: 0; transform: translateY(12px); } }
  .sb-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .sb-dot.bad { background: var(--critical); }
  .sb-text { flex: 1; font-size: 14px; line-height: 20px; }
  .savebar-inner.confirming { flex-wrap: wrap; justify-content: flex-end; }
  .confirming .sb-text { flex: 1 1 calc(100% - 20px); }
  .erase-note { margin-top: 6px; color: var(--warning-text); }

  .toast {
    position: fixed; left: 50%; bottom: 24px; z-index: 40; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px;
    background: var(--ink); color: var(--paper); font-size: 14px; box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.4);
  }
  .toast :global(svg) { color: var(--healthy); }

  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; }
    .nav { position: static; display: flex; overflow-x: auto; gap: 4px; padding-bottom: 4px; }
    .nav button { flex: none; }
  }
  @media (max-width: 640px) {
    .sec { padding: 18px; }
    .scope-fields { grid-template-columns: 1fr; }
    .r-row { grid-template-columns: 1fr auto; }
    .r-row > :nth-child(2) { grid-column: 1 / -1; grid-row: 2; overflow-x: auto; }
    .r-head { display: none; }
    .tz .input, .range input { width: 100%; }
  }
  .pkg-map, .pkg-setup { align-items: start; }
  .callout-box { padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--row-tint); }
  .setup-steps { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 6px; font-size: 13px; line-height: 19px; color: var(--ink-muted); }
  .setup-steps ul { margin: 4px 0 0; padding-left: 18px; display: grid; gap: 4px; }
  .setup-steps strong { color: var(--ink); }
  .setup-steps a, .hint a { color: var(--accent-text); text-decoration: none; font-weight: 500; }
  .setup-steps a:hover, .hint a:hover { text-decoration: underline; }
  .hint-details { margin-top: 8px; font-size: 13px; color: var(--ink-muted); }
  .hint-details summary { cursor: pointer; font-weight: 500; color: var(--accent-text); }
  .pkg-section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); display: grid; gap: 6px; }
  .pkg-section .sub-h { margin-top: 0; }
  .pkg-add { margin-top: 8px; padding: 12px; border: 1px dashed var(--line); border-radius: var(--radius-control); background: var(--row-tint); display: grid; gap: 8px; }
  .pkg-add-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pkg-add-row .input { flex: 1 1 180px; min-width: 0; }
  .pkg-auto { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .pkg-pairs { flex: 1 1 100%; margin: 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--ink-muted); max-height: 126px; overflow-y: auto; }
  .pkg-warn { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 13px; line-height: 19px; color: var(--warning-text); }
  .pkg-warn :global(svg) { flex: none; }
  .pkg-warn span { flex: 1 1 240px; min-width: 0; }
  .pkg-warn .mono { overflow-wrap: anywhere; }
  .pkg-list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
  .pkg-search { max-width: 260px; }
  .pkg-table { margin-top: 6px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--paper); overflow: hidden; }
  .pkg-item { padding: 8px 12px; border-top: 1px solid var(--line); display: grid; gap: 6px; }
  .pkg-item:first-child { border-top: 0; }
  .pkg-item.invalid-row { background: color-mix(in srgb, var(--critical) 5%, var(--paper)); }
  .pkg-item-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pkg-name { flex: 0 0 150px; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pkg-repo-inputs { flex: 1 1 240px; display: flex; gap: 6px; min-width: 0; }
  .pkg-repo-inputs .input { flex: 1 1 140px; min-width: 0; }
  .pkg-repo-inputs .pkg-repo-pick { flex: 0 1 160px; }
  .pkg-kind-sel { flex: 0 0 84px; }
  .pkg-opt-btn.has-extra { color: var(--accent-text); }
  .pkg-row-err { margin: 0; }
  .pkg-extra-summary { font-size: 12px; margin: 0; }
  .pkg-extra { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; padding-top: 6px; border-top: 1px dashed var(--line); }
  .pkg-field { display: grid; gap: 4px; font-size: 12px; color: var(--ink-muted); align-content: start; }
  .pkg-field .input { width: 100%; min-width: 0; }
  .pkg-empty { padding: 14px 12px; }
  .input.invalid { border-color: var(--critical); }
  .field-err { font-size: 12px; color: var(--critical); }
  .sec-intro a { color: var(--accent-text); text-decoration: none; font-weight: 500; }
  .sec-intro a:hover { text-decoration: underline; }
  @media (max-width: 640px) { .pkg-name { flex: 1 1 100%; } .pkg-repo-inputs { flex-wrap: wrap; } }
  .budget { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .sub-h { font-size: 15px; margin-top: 20px; }
</style>
