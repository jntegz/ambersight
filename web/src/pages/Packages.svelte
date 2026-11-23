<!-- Packages: fleet-wide tracking of mapped Workers' direct npm dependencies, locked → latest, and optional OSV advisories. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { Gap, PackageAdvisory, PackagesView } from '../../../src/shared/types';
  import Icon from '../components/Icon.svelte';
  import Stat from '../components/Stat.svelte';
  import { api, num, timeAgo, workerHref } from '../lib/api';
  import type { CsvCell } from '../lib/csv';
  import { download, downloadCsv } from '../lib/download';
  import { loadPrefs, savePrefs } from '../lib/prefs';

  let { query, account = null, onUnauthorized }: { query: string; account?: string | null; onUnauthorized: () => void } = $props();

  type ViewMode = 'worker' | 'package';
  type SortMode = 'urgency' | 'name';
  const prefs = loadPrefs('ambersight-packages', {
    onlyOutdated: true,
    showDev: true,
    onlyMajor: false,
    onlyVulnerable: false,
    mode: 'worker' as ViewMode,
    sort: 'urgency' as SortMode,
  });
  let onlyOutdated = $state(prefs.onlyOutdated);
  let showDev = $state(prefs.showDev);
  let onlyMajor = $state(prefs.onlyMajor);
  let onlyVulnerable = $state(prefs.onlyVulnerable);
  let mode = $state<ViewMode>(prefs.mode === 'package' ? 'package' : 'worker');
  let sort = $state<SortMode>(prefs.sort === 'name' ? 'name' : 'urgency');
  $effect(() => savePrefs('ambersight-packages', { onlyOutdated, showDev, onlyMajor, onlyVulnerable, mode, sort }));

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

  const BEHIND = new Set<Gap>(['major', 'minor', 'patch']);
  const GAP_RANK: Record<Gap, number> = { major: 0, minor: 1, patch: 2, unknown: 3, none: 4 };
  const q = $derived(query.trim().toLowerCase());

  const matchesPkg = (p: PackagesView['workers'][number]['packages'][number], workerName: string) =>
    (showDev || !p.dev)
    && (!onlyOutdated || BEHIND.has(p.gap) || (p.advisories?.length ?? 0) > 0)
    && (!onlyMajor || p.gap === 'major')
    && (!onlyVulnerable || (p.advisories?.length ?? 0) > 0)
    && (!q || p.name.toLowerCase().includes(q) || workerName.toLowerCase().includes(q));

  const summary = $derived.by(() => {
    const list = view?.workers ?? [];
    let needUpdate = 0;
    let runtimeMajors = 0;
    let totalBehind = 0;
    let vulnerableWorkers = 0;
    let totalAdvisories = 0;
    for (const w of list) {
      const behind = w.packages.filter((p) => BEHIND.has(p.gap));
      const vulns = w.packages.flatMap((p) => p.advisories ?? []);
      if (behind.length || vulns.length) needUpdate++;
      totalBehind += behind.length;
      runtimeMajors += behind.filter((p) => !p.dev && p.gap === 'major').length;
      if (vulns.length) vulnerableWorkers++;
      totalAdvisories += vulns.length;
    }
    return {
      mapped: list.length,
      unmapped: view?.unmappedWorkers?.length ?? 0,
      needUpdate,
      runtimeMajors,
      totalBehind,
      vulnerableWorkers,
      totalAdvisories,
    };
  });

  const workers = $derived.by(() => {
    const mapped = (view?.workers ?? []).map((w) => {
      const behind = w.packages.filter((p) => BEHIND.has(p.gap)).length;
      const runtimeMajor = w.packages.filter((p) => !p.dev && p.gap === 'major').length;
      const major = w.packages.filter((p) => p.gap === 'major').length;
      const vulns = w.packages.reduce((sum, p) => sum + (p.advisories?.length ?? 0), 0);
      const notCompared = w.packages.filter((p) => !p.compared).length;
      const shown = w.packages
        .filter((p) => matchesPkg(p, w.name))
        .sort((a, b) =>
          Number((b.advisories?.length ?? 0) > 0) - Number((a.advisories?.length ?? 0) > 0)
          || Number(a.dev) - Number(b.dev)
          || GAP_RANK[a.gap] - GAP_RANK[b.gap]
          || a.name.localeCompare(b.name));
      return { ...w, behind, runtimeMajor, major, vulns, notCompared, shown };
    }).filter((w) => {
      if (q && !w.name.toLowerCase().includes(q) && !w.shown.length) return false;
      if ((onlyMajor || onlyVulnerable) && !w.error && !w.shown.length) return false;
      return true;
    });

    if (sort === 'name') return mapped.sort((a, b) => a.name.localeCompare(b.name));
    // Urgency order: read errors, then vulnerable, then runtime major, then major, then outdated, then alphabetical.
    return mapped.sort((a, b) =>
      Number(Boolean(b.error)) - Number(Boolean(a.error))
      || b.vulns - a.vulns
      || b.runtimeMajor - a.runtimeMajor
      || b.major - a.major
      || b.behind - a.behind
      || a.name.localeCompare(b.name));
  });

  interface ByPackageRow {
    name: string;
    latest: string | null;
    compared: boolean;
    worstGap: Gap;
    vulnCount: number;
    uses: { worker: string; locked: string; gap: Gap; dev: boolean; advisories: PackageAdvisory[] }[];
  }

  const byPackage = $derived.by((): ByPackageRow[] => {
    const map = new Map<string, ByPackageRow>();
    for (const w of view?.workers ?? []) {
      if (w.error) continue;
      for (const p of w.packages) {
        if (!matchesPkg(p, w.name)) continue;
        let entry = map.get(p.name);
        if (!entry) {
          entry = { name: p.name, latest: p.latest, compared: p.compared, worstGap: p.gap, vulnCount: 0, uses: [] };
          map.set(p.name, entry);
        }
        if (p.compared && !entry.compared) entry.compared = true;
        if (p.latest && !entry.latest) entry.latest = p.latest;
        if (GAP_RANK[p.gap] < GAP_RANK[entry.worstGap]) entry.worstGap = p.gap;
        const advs = p.advisories ?? [];
        entry.vulnCount += advs.length;
        entry.uses.push({ worker: w.name, locked: p.locked, gap: p.gap, dev: p.dev, advisories: advs });
      }
    }
    const list = [...map.values()];
    for (const row of list) {
      row.uses.sort((a, b) =>
        b.advisories.length - a.advisories.length
        || GAP_RANK[a.gap] - GAP_RANK[b.gap]
        || a.worker.localeCompare(b.worker));
    }
    if (sort === 'name') return list.sort((a, b) => a.name.localeCompare(b.name));
    return list.sort((a, b) =>
      b.vulnCount - a.vulnCount
      || GAP_RANK[a.worstGap] - GAP_RANK[b.worstGap]
      || b.uses.length - a.uses.length
      || a.name.localeCompare(b.name));
  });

  function exportCsv() {
    const rows: CsvCell[][] = [['Worker', 'Repository', 'Lockfile', 'Package', 'Kind', 'Locked', 'Latest', 'Gap', 'Advisories']];
    for (const w of workers) {
      for (const p of w.shown) {
        rows.push([
          w.name,
          w.repo,
          w.lockfile ?? 'npm',
          p.name,
          p.dev ? 'dev' : 'runtime',
          p.locked,
          p.compared ? (p.latest ?? '') : 'not compared',
          p.gap,
          (p.advisories ?? []).map((a) => `${a.id}${a.fixed ? ` (fix ${a.fixed})` : ''}`).join('; '),
        ]);
      }
    }
    downloadCsv('ambersight-packages.csv', rows);
  }

  const mdSafe = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[`\\[\]()<>]/g, '\\$&');
  function exportMarkdown() {
    const lines = ['# Outdated npm packages', ''];
    for (const w of workers) {
      if (!w.shown.length && !w.error) continue;
      const loc = [w.repo ? `${w.repo}${w.dir ? `/${w.dir}` : ''}` : '', w.workspace ? `workspace ${w.workspace}` : ''].filter(Boolean).join(' · ');
      lines.push(`## ${mdSafe(w.name)}${loc ? ` (${mdSafe(loc)})` : ''}`);
      if (w.error) {
        lines.push(`- Error: ${mdSafe(w.error)}`, '');
        continue;
      }
      for (const p of w.shown) {
        const adv = p.advisories?.length ? ` · **${p.advisories.map((a) => mdSafe(a.id)).join(', ')}**` : '';
        lines.push(`- [ ] \`${mdSafe(p.name)}\`${p.dev ? ' (dev)' : ''}: \`${mdSafe(p.locked)}\` → \`${p.compared ? mdSafe(p.latest ?? '?') : 'not compared'}\`${BEHIND.has(p.gap) ? ` (${p.gap})` : ''}${adv}`);
      }
      lines.push('');
    }
    download('ambersight-packages.md', lines.join('\n'));
  }
</script>

<header class="page-head">
  <div>
    <h1>Packages</h1>
    <p>Direct npm dependencies of each mapped Worker: locked version against the latest on npm. Read once a day from npm, pnpm, yarn or bun lockfiles. Packages not from the public npm registry are marked <strong>not compared</strong> and never leave this install.</p>
  </div>
  {#if view?.enabled && view.github && view.workers.length}
    <div class="head-actions">
      <button type="button" class="ghost small" onclick={exportCsv}><Icon name="download" size={14} /> CSV</button>
      <button type="button" class="ghost small" onclick={exportMarkdown}><Icon name="download" size={14} /> .md</button>
    </div>
  {/if}
</header>

{#if error}
  <div class="card empty"><p role="alert">{error}</p><button type="button" onclick={() => load(account)}>Try again</button></div>
{:else if !view}
  <div class="card empty muted" aria-busy="true"><p>Loading packages…</p></div>
{:else if !view.enabled || !view.github || !view.workers.length}
  <div class="card setup-card">
    <div class="setup-head">
      <span class="empty-icon"><Icon name="package" size={24} /></span>
      <div>
        {#if !view.github}
          <h2>Set up <span class="mono">GITHUB_TOKEN</span> to track npm packages</h2>
          <p class="muted">Ambersight reads lockfiles from GitHub using a least-privilege fine-grained token so it only sees the repositories you choose.</p>
        {:else if !view.enabled}
          <h2>The Packages check is off</h2>
          <p class="muted">Turn on <strong>npm Packages</strong> (and optionally <strong>Known vulnerabilities (OSV.dev)</strong> — no API key needed) in <a href="#/settings?tab=packages">Settings › npm Packages</a>.</p>
        {:else}
          <h2>No Workers mapped yet</h2>
          <p class="muted">Map each Worker to its GitHub repository in <a href="#/settings?tab=packages">Settings › npm Packages</a>, then run a scan.</p>
        {/if}
      </div>
    </div>
    {#if !view.github}
      <ol class="setup-steps">
        <li>
          Create a token at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub › Fine-grained personal access tokens</a>
          (<strong>Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token</strong>).
        </li>
        <li>
          Under <strong>Repository access</strong>, select <strong>Only select repositories</strong> and pick only the repositories for your Workers (not all repositories).
        </li>
        <li>
          Under <strong>Permissions › Repository permissions</strong>, set <strong>Contents</strong> to <strong>Read-only</strong> (GitHub adds <em>Metadata: Read-only</em> automatically). Leave every other permission set to <strong>No access</strong>, then generate and copy the token.
        </li>
        <li>
          Add it as a secret named <span class="mono">GITHUB_TOKEN</span> on this Ambersight Worker:
          <ul>
            <li><strong>Cloudflare Dashboard:</strong> open <strong>Workers &amp; Pages ›</strong> this Worker <strong>› Settings › Variables and Secrets › Add › Secret</strong>, enter <span class="mono">GITHUB_TOKEN</span>, paste the token, and deploy.</li>
            <li><strong>Terminal:</strong> run <span class="mono">npx wrangler secret put GITHUB_TOKEN</span> (add <span class="mono">--name &lt;worker&gt;</span> if your Worker has a custom name).</li>
          </ul>
        </li>
        <li>
          Go to <a href="#/settings?tab=packages">Settings › npm Packages</a>, turn on <strong>Track outdated npm packages</strong> (and optionally <strong>Known vulnerabilities (OSV.dev)</strong> — <strong>no API key required</strong>), map your Workers, and press <strong>Scan now</strong>.
        </li>
      </ol>
    {/if}
  </div>
{:else}
  <div class="stats card">
    <Stat label="Workers needing updates" value="{num(summary.needUpdate)} / {num(summary.mapped)}" hint={summary.unmapped ? `${num(summary.unmapped)} unmapped` : 'all in-scope mapped'} />
    <Stat label="Runtime major behind" value={num(summary.runtimeMajors)} hint="production dependencies" />
    <Stat label="Outdated dependencies" value={num(summary.totalBehind)} hint="across mapped Workers" />
    {#if view.osvEnabled}
      <Stat label="Known vulnerabilities" value={num(summary.totalAdvisories)} hint={summary.vulnerableWorkers ? `in ${num(summary.vulnerableWorkers)} ${summary.vulnerableWorkers === 1 ? 'Worker' : 'Workers'}` : 'none found'} />
    {/if}
  </div>

  {#if !view.osvEnabled}
    <p class="osv-tip muted">
      Want security advisory alerts too? Turn on <strong>Known vulnerabilities (OSV.dev)</strong> in <a href="#/settings?tab=packages">Settings › npm Packages</a> — free, no API key required.
    </p>
  {/if}

  {#if view.unmappedWorkers?.length}
    <details class="card unmapped">
      <summary>
        <span><strong>{view.unmappedWorkers.length}</strong> in-scope {view.unmappedWorkers.length === 1 ? 'Worker is' : 'Workers are'} not mapped to a repository yet</span>
        <a href="#/settings?tab=packages" onclick={(e) => e.stopPropagation()}>Map in Settings</a>
      </summary>
      <div class="unmapped-list">
        {#each view.unmappedWorkers as name (name)}
          <a class="tag-chip mono" href={workerHref(name)}>{name}</a>
        {/each}
      </div>
    </details>
  {/if}

  <div class="toolbar">
    <div class="seg" role="group" aria-label="View mode">
      <button type="button" class:on={mode === 'worker'} onclick={() => (mode = 'worker')}>By Worker</button>
      <button type="button" class:on={mode === 'package'} onclick={() => (mode = 'package')}>By Package</button>
    </div>
    <div class="seg" role="group" aria-label="Sort order">
      <button type="button" class:on={sort === 'urgency'} onclick={() => (sort = 'urgency')}>Most urgent</button>
      <button type="button" class:on={sort === 'name'} onclick={() => (sort = 'name')}>A–Z</button>
    </div>
    <div class="filters">
      <label class="flag-toggle" title="Hide up-to-date packages; show only packages behind latest on npm or with a known security advisory.">
        <input type="checkbox" bind:checked={onlyOutdated} /><span>Only outdated</span>
      </label>
      <label class="flag-toggle" title="Show only breaking major-version updates (e.g. 3.x → 4.x) that usually need a changelog review before upgrading.">
        <input type="checkbox" bind:checked={onlyMajor} /><span>Major only</span>
      </label>
      <label class="flag-toggle" title="Include build, test and CLI tools (wrangler, typescript, vitest). Turn off to see only runtime packages bundled into your Worker.">
        <input type="checkbox" bind:checked={showDev} /><span>Include devDependencies</span>
      </label>
      {#if view.osvEnabled}
        <label class="flag-toggle" title="Show only packages matching a known security advisory reported by OSV.dev.">
          <input type="checkbox" bind:checked={onlyVulnerable} /><span>Vulnerable only</span>
        </label>
      {/if}
    </div>
  </div>
  <details class="filter-help">
    <summary><Icon name="info" size={14} /> What do these filters mean?</summary>
    <dl class="filter-defs">
      <div><dt>Only outdated</dt><dd>Hides packages already on the latest npm release and keeps only packages with a newer version available (or a known vulnerability).</dd></div>
      <div><dt>Major only</dt><dd>Shows only breaking major-version jumps (for example <span class="mono">3.x → 4.x</span>), skipping minor and patch updates so you can focus on upgrades that need changelog review.</dd></div>
      <div><dt>Include devDependencies</dt><dd>Includes build, test, and CLI tools (such as <span class="mono">wrangler</span>, <span class="mono">typescript</span>, <span class="mono">vitest</span>). Uncheck to focus strictly on runtime dependencies shipped inside your Workers.</dd></div>
      <div><dt>Vulnerable only</dt><dd>Shows only packages whose locked version matches a known security advisory (CVE / GHSA) reported by <a href="https://osv.dev" target="_blank" rel="noopener noreferrer">OSV.dev</a>.{#if !view.osvEnabled}{' '}Available once <strong>OSV.dev</strong> is turned on in <a href="#/settings?tab=packages">Settings › npm Packages</a>.{/if}</dd></div>
    </dl>
  </details>

  {#if mode === 'worker'}
    <div class="list">
      {#each workers as w (w.name)}
        <section class="card worker" aria-labelledby="pk-{w.name}">
          <header class="w-head">
            <h2 id="pk-{w.name}"><a class="mono" href={workerHref(w.name)}>{w.name}</a></h2>
            <span class="muted hint">
              {#if w.repo}{w.repo}{w.dir ? `/${w.dir}` : ''}{#if w.workspace} · workspace {w.workspace}{/if} · {/if}
              {#if w.lockfile && w.lockfile !== 'npm'}{w.lockfile} · {/if}
              read {timeAgo(w.checkedAt)}
            </span>
            {#if !w.error && w.vulns > 0}<span class="tag-chip crit">{w.vulns} {w.vulns === 1 ? 'advisory' : 'advisories'}</span>{/if}
            {#if !w.error && w.packages.length > w.notCompared}<span class="tag-chip" class:warn={w.behind > 0}>{w.behind} of {w.packages.length - w.notCompared} behind</span>{/if}
            {#if !w.error && w.notCompared}<span class="tag-chip" title="The lockfile shows these did not come from the public npm registry">{w.notCompared} not compared</span>{/if}
          </header>
          {#if w.error}
            <p class="err"><Icon name="warning" size={14} /> {w.error}</p>
          {:else if !w.checkedAt}
            <p class="muted hint">Not read yet. It will be on one of the next scans.</p>
          {:else if !w.shown.length}
            <p class="muted hint">{onlyOutdated ? (w.notCompared ? 'Every dependency compared with npm is on the latest release.' : 'Every direct dependency is on the latest release.') : 'No dependencies match.'}</p>
          {:else}
            <table>
              <thead><tr><th scope="col">Package</th><th scope="col">Locked</th><th scope="col">Latest</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {#each w.shown as p (p.name)}
                  <tr>
                    <td class="mono">{p.name}{#if p.dev} <span class="tag-chip">dev</span>{/if}</td>
                    <td class="mono">{p.locked}</td>
                    <td class="mono">{#if p.compared}{p.latest ?? '…'}{:else}<span class="muted">not compared</span>{/if}</td>
                    <td>
                      <span class="badges">
                        {#if BEHIND.has(p.gap)}<span class="gap {p.gap}">{p.gap}</span>{/if}
                        {#each p.advisories ?? [] as adv (adv.id)}
                          <a class="adv {adv.severity}" href="https://osv.dev/vulnerability/{encodeURIComponent(adv.id)}" target="_blank" rel="noopener noreferrer" title={adv.summary ?? adv.id}>
                            {adv.id}{#if adv.fixed} → {adv.fixed}{/if}
                          </a>
                        {/each}
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      {:else}
        <div class="card empty muted"><p>No Workers match the current filters.</p></div>
      {/each}
    </div>
  {:else}
    <section class="card pkg-table">
      {#if !byPackage.length}
        <p class="muted empty-pad">No packages match the current filters.</p>
      {:else}
        <table>
          <thead><tr><th scope="col">Package</th><th scope="col">Latest</th><th scope="col">Workers</th></tr></thead>
          <tbody>
            {#each byPackage as row (row.name)}
              <tr>
                <td class="mono">
                  {row.name}
                  {#if BEHIND.has(row.worstGap)} <span class="gap {row.worstGap}">{row.worstGap}</span>{/if}
                </td>
                <td class="mono">{#if row.compared}{row.latest ?? '…'}{:else}<span class="muted">not compared</span>{/if}</td>
                <td>
                  <ul class="uses">
                    {#each row.uses as u (u.worker)}
                      <li>
                        <a class="mono" href={workerHref(u.worker)}>{u.worker}</a>
                        <span class="mono muted">{u.locked}</span>
                        {#if u.dev}<span class="tag-chip">dev</span>{/if}
                        {#if BEHIND.has(u.gap)}<span class="gap {u.gap}">{u.gap}</span>{/if}
                        {#each u.advisories as adv (adv.id)}
                          <a class="adv {adv.severity}" href="https://osv.dev/vulnerability/{encodeURIComponent(adv.id)}" target="_blank" rel="noopener noreferrer" title={adv.summary ?? adv.id}>
                            {adv.id}
                          </a>
                        {/each}
                      </li>
                    {/each}
                  </ul>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/if}
{/if}

<style>
  .head-actions { display: flex; gap: 8px; flex: none; }
  .setup-card { padding: 20px 24px; display: grid; gap: 14px; }
  .setup-head { display: flex; align-items: flex-start; gap: 14px; }
  .setup-head h2 { font-size: 16px; margin-bottom: 4px; }
  .setup-head p { font-size: 13px; line-height: 19px; }
  .setup-head a, .setup-steps a, .osv-tip a { color: var(--accent-text); text-decoration: none; font-weight: 500; }
  .setup-head a:hover, .setup-steps a:hover, .osv-tip a:hover { text-decoration: underline; }
  .setup-steps { margin: 0; padding-left: 20px; display: grid; gap: 8px; font-size: 13px; line-height: 20px; color: var(--ink-muted); }
  .setup-steps ul { margin: 4px 0 0; padding-left: 18px; display: grid; gap: 4px; }
  .setup-steps strong { color: var(--ink); }
  .osv-tip { font-size: 13px; margin: -6px 0 16px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 16px; }
  .stats > :global(*) { border-right: 1px solid var(--line); }
  .stats > :global(*:last-child) { border-right: 0; }
  .unmapped { padding: 12px 18px; margin-bottom: 16px; font-size: 13px; }
  .unmapped summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; }
  .unmapped summary a { color: var(--accent-text); font-weight: 500; text-decoration: none; }
  .unmapped summary a:hover { text-decoration: underline; }
  .unmapped-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .unmapped-list a { text-decoration: none; color: inherit; }
  .unmapped-list a:hover { text-decoration: underline; }
  .toolbar { display: flex; align-items: center; gap: 12px 18px; flex-wrap: wrap; margin-bottom: 10px; }
  .filter-help { margin-bottom: 16px; font-size: 13px; color: var(--ink-muted); }
  .filter-help summary { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--accent-text); font-weight: 500; list-style: none; }
  .filter-help summary::-webkit-details-marker { display: none; }
  .filter-defs { margin: 8px 0 0; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--surface); display: grid; gap: 8px; }
  .filter-defs div { display: grid; grid-template-columns: 170px 1fr; gap: 6px 14px; }
  .filter-defs dt { font-weight: 600; color: var(--ink); }
  .filter-defs dd { margin: 0; line-height: 19px; }
  .filter-defs a { color: var(--accent-text); text-decoration: none; font-weight: 500; }
  .filter-defs a:hover { text-decoration: underline; }
  @media (max-width: 640px) { .filter-defs div { grid-template-columns: 1fr; gap: 2px; } }
  .seg { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); }
  .seg button { height: 28px; min-height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-muted); font-size: 13px; font-weight: 500; }
  .seg button.on { background: var(--chip); color: var(--chip-text); }
  .filters { display: flex; align-items: center; gap: 12px 18px; flex-wrap: wrap; }
  .flag-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--ink-muted); }
  .flag-toggle input { width: 16px; height: 16px; accent-color: var(--button); margin: 0; }
  .list { display: grid; gap: 16px; }
  .worker { padding: 16px 20px; min-width: 0; }
  .w-head { display: flex; align-items: baseline; gap: 6px 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .w-head h2 { font-size: 15px; font-weight: 600; }
  .w-head a { color: var(--ink); text-decoration: none; }
  .w-head a:hover { text-decoration: underline; }
  .tag-chip.warn { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--warning-text); }
  .tag-chip.crit { background: color-mix(in srgb, var(--critical) 16%, transparent); color: var(--critical); font-weight: 600; }
  .err { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--warning-text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
  th { text-align: left; font-weight: 500; font-size: 12px; color: var(--ink-muted); padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; vertical-align: top; }
  td.mono { font-size: 13px; }
  .worker th:first-child { width: 38%; }
  .worker th:nth-child(2), .worker th:nth-child(3) { width: 16%; }
  .pkg-table { padding: 12px 18px; overflow-x: auto; }
  .pkg-table th:first-child { width: 32%; }
  .pkg-table th:nth-child(2) { width: 16%; }
  .empty-pad { padding: 12px 0; font-size: 13px; }
  tr:last-child td { border-bottom: 0; }
  .badges { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .uses { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
  .uses li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .uses a.mono { color: var(--ink); text-decoration: none; font-weight: 500; }
  .uses a.mono:hover { text-decoration: underline; }
  .gap { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 5px; text-transform: uppercase; letter-spacing: 0.03em; }
  .gap.major { background: color-mix(in srgb, var(--critical) 16%, transparent); color: var(--critical); }
  .gap.minor { background: var(--chip); color: var(--chip-text); }
  .gap.patch { background: var(--line); color: var(--ink-muted); }
  .adv { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 5px; text-decoration: none; background: color-mix(in srgb, var(--critical) 16%, transparent); color: var(--critical); }
  .adv:hover { text-decoration: underline; }
  .adv.moderate, .adv.low, .adv.unknown { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--warning-text); }
</style>
