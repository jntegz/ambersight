<!-- Settings › Security: recent security-relevant changes made from the dashboard. Read-only. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { adminActionLabel } from '../../../../src/shared/adminLog';
  import type { AdminLogView } from '../../../../src/shared/types';
  import { api, timeAgo } from '../../lib/api';

  let log = $state<AdminLogView | null>(null);
  let error = $state('');
  let showAll = $state(false);

  onMount(async () => {
    try {
      log = await api.adminLog();
    } catch (e) {
      error = (e as Error).message;
    }
  });

  const SHOWN = 10;
  const NOTICE: Record<string, string> = { pending: 'notice waiting', sent: 'operators told', none: 'no channel to notify', failed: 'notice not delivered' };
  const events = $derived(log ? (showAll ? log.events : log.events.slice(0, SHOWN)) : []);
</script>

<div class="log">
  <p class="hint">
    Sign-ins and changes made from this dashboard: settings, watched accounts, bulk acknowledgements, API tokens, the passphrase, and searches for or removals of a person's stored data (counts only).
    Sessions appear as a short code that tells them apart without identifying anyone. Changes that reduce detection are also sent to the operators and to the webhook, whatever the alert routes and quiet hours say, at most one message every 30 minutes.
    {#if log}Kept {log.retentionDays} days, at most {log.maxEvents.toLocaleString('en-US')} entries.{/if}
  </p>
  {#if error}
    <p class="error-text" role="alert">{error}</p>
  {:else if log && !log.events.length}
    <p class="hint">Nothing recorded yet.</p>
  {:else if log}
    <ul>
      {#each events as e (e.id)}
        <li>
          <span class="what"><strong>{adminActionLabel(e.action)}</strong>{#if e.count > 1} <span class="muted">({e.count} times)</span>{/if}{#if e.target}<span class="target">{e.target}</span>{/if}</span>
          <span class="muted meta">
            <span class="mono">{e.actor}</span> · <time datetime={e.at} title={new Date(e.at).toUTCString()}>{timeAgo(e.at)}</time>
            {#if e.notice && NOTICE[e.notice]} · <span class:warn={e.notice === 'failed'}>{NOTICE[e.notice]}</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if log.events.length > SHOWN}
      <button type="button" class="ghost" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${log.events.length}`}</button>
    {/if}
  {/if}
</div>

<style>
  .log { display: grid; gap: 12px; justify-items: start; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; width: 100%; }
  li { display: flex; justify-content: space-between; gap: 4px 16px; flex-wrap: wrap; font-size: 14px; line-height: 20px; padding: 8px 0; border-bottom: 1px solid var(--line); }
  li:last-child { border-bottom: 0; }
  .what { flex: 1 1 280px; min-width: 0; overflow-wrap: anywhere; }
  .what strong { font-weight: 500; }
  .target { display: block; font-size: 13px; color: var(--ink-muted); }
  .meta { font-size: 13px; white-space: nowrap; }
  .warn { color: var(--critical); }
</style>
