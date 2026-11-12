<!-- What changed since this browser last opened the overview: findings opened, got worse, resolved. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { SinceView } from '../../../src/shared/types';
  import { api, timeAgo, workerHref } from '../lib/api';
  import Icon from './Icon.svelte';

  let { account }: { account: string | null } = $props();
  let view = $state<SinceView | null>(null);
  let hidden = $state(false);

  onMount(() => {
    const key = `ambersight-visit-${account ?? ''}`;
    let last: string | null = null;
    try {
      last = localStorage.getItem(key);
      localStorage.setItem(key, new Date().toISOString());
    } catch {}
    // Only after a real gap: reloading the page should not show it again.
    if (last && Date.now() - Date.parse(last) > 10 * 60_000) {
      api.changes(last, account ?? undefined).then((v) => (view = v), () => {});
    }
  });
  const any = $derived(view && view.opened + view.escalated + view.resolved > 0);
  const VERB = { opened: 'New', reopened: 'Back', escalated: 'Worse', resolved: 'Resolved' } as const;
</script>

{#if view && any && !hidden}
  <section class="card since" aria-labelledby="since-title">
    <div class="head">
      <h2 id="since-title">Since your last visit <span class="muted">{timeAgo(view.since)}</span></h2>
      <p class="sums">
        {#if view.opened}<span class="warn">{view.opened} new</span>{/if}
        {#if view.escalated}<span class="warn">{view.escalated} worse</span>{/if}
        {#if view.resolved}<span class="ok">{view.resolved} resolved</span>{/if}
      </p>
      <button type="button" class="icon-btn" aria-label="Dismiss" onclick={() => (hidden = true)}><Icon name="close" size={14} /></button>
    </div>
    <ul>
      {#each view.items as i, k (k)}
        <li class={i.severity ?? ''}>
          <span class="verb {i.kind}">{VERB[i.kind]}</span>
          {#if i.script && i.script !== '*'}<a class="mono" href={workerHref(i.script)}>{i.script}</a>{/if}
          <span class="msg">{i.message ?? ''}</span>
          <time class="muted num" datetime={i.at}>{timeAgo(i.at)}</time>
        </li>
      {/each}
    </ul>
    <a class="more" href="#/findings">All findings</a>
  </section>
{/if}

<style>
  .since { padding: 16px 20px; display: grid; gap: 10px; }
  .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h2 { font-size: 16px; flex: 1; }
  h2 .muted { font-weight: 400; font-size: 13px; margin-left: 6px; }
  .sums { display: flex; gap: 10px; font-size: 13px; font-weight: 600; }
  .warn { color: var(--warning-text); }
  .ok { color: var(--healthy); }
  .icon-btn { width: 28px; min-height: 28px; height: 28px; padding: 0; border-color: transparent; background: transparent; color: var(--ink-muted); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
  li { display: grid; grid-template-columns: 70px auto 1fr auto; gap: 10px; align-items: baseline; }
  .verb { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-muted); }
  .critical .verb { color: var(--critical); }
  .verb.resolved { color: var(--healthy); }
  .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .more { font-size: 13px; justify-self: start; }
  @media (max-width: 640px) { li { grid-template-columns: 60px 1fr; } .msg { grid-column: 1 / -1; white-space: normal; } time { display: none; } }
</style>
