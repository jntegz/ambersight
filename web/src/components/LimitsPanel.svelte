<!-- Free plan limits other than requests (D1 rows, KV writes, ...) and storage against its caps, one meter each. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { QuotaStatus, StorageStatus } from '../../../src/shared/types';
  import { compact, num, pct } from '../lib/api';
  import Icon from './Icon.svelte';

  let { quotas, storage, paid = false, warnAt = 0.7, criticalAt = 0.9 }: { quotas: QuotaStatus[]; storage: StorageStatus[]; paid?: boolean; warnAt?: number; criticalAt?: number } = $props();

  const tone = (share: number | null) => (share == null ? 'calm' : share >= criticalAt ? 'critical' : share >= warnAt ? 'warning' : 'calm');
  const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`);
  // Show storage with a cap first; products without one only when there is room.
  const shownStorage = $derived(storage.filter((s) => s.limit != null).slice(0, 6));
</script>

<section class="card limits" aria-labelledby="limits-title">
  <div class="head">
    <span class="icon"><Icon name="budget" size={20} /></span>
    <div>
      <h2 id="limits-title">{paid ? 'Storage limits' : 'Free plan limits'}</h2>
      <p class="muted">{paid ? 'A full D1 database rejects writes.' : 'Per account, reset at 00:00 UTC. Past a limit, calls fail until then.'}</p>
    </div>
  </div>

  {#if quotas.length}
    <ul class="rows" aria-label="Daily limits used today">
      {#each quotas as q (q.metric)}
        <li class={tone(q.share)}>
          <div class="row-head">
            <span>{q.label}</span>
            <span class="num"><strong>{compact(q.used)}</strong><span class="muted">&nbsp;/ {compact(q.limit)}</span></span>
          </div>
          <div class="track" role="meter" aria-label="{q.label} used today" aria-valuemin="0" aria-valuemax={q.limit} aria-valuenow={q.used}>
            <span class="fill" style="width: {Math.min(1, q.share) * 100}%"></span>
          </div>
          {#if q.share >= 1}
            <p class="note"><Icon name="critical" size={14} /> Out for today</p>
          {:else if q.projectedLimitAt}
            <p class="note"><Icon name="warning" size={14} /> Runs out around <strong class="num">{q.projectedLimitAt.slice(11, 16)} UTC</strong></p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if shownStorage.length}
    <p class="sub muted">Storage</p>
    <ul class="rows" aria-label="Storage against its limits">
      {#each shownStorage as s (s.kind + s.label)}
        <li class={tone(s.share)}>
          <div class="row-head">
            <span class="mono-ish">{s.label}</span>
            <span class="num"><strong>{size(s.bytes)}</strong><span class="muted">&nbsp;/ {size(s.limit!)}</span></span>
          </div>
          <div class="track" role="meter" aria-label="{s.label} storage used" aria-valuemin="0" aria-valuemax={s.limit} aria-valuenow={s.bytes}>
            <span class="fill" style="width: {Math.min(1, s.share ?? 0) * 100}%"></span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if !quotas.length && !shownStorage.length && !paid}
    <p class="muted">No D1, KV, Durable Object, Queue, Workflow or Workers AI usage today.</p>
  {:else if quotas.length}
    <p class="muted foot">{num(quotas.filter((q) => q.share >= warnAt).length)} of {num(quotas.length)} at or above {pct(warnAt)}.</p>
  {/if}
</section>

<style>
  .limits { padding: 20px 24px; display: grid; gap: 12px; align-content: start; }
  .head { display: flex; gap: 12px; align-items: flex-start; }
  .icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; flex: none; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  h2 { font-size: 16px; line-height: 22px; font-weight: 600; }
  .head p { font-size: 13px; line-height: 18px; }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .row-head { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; line-height: 20px; }
  .mono-ish { overflow-wrap: anywhere; }
  .track { margin-top: 4px; height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: inherit; background: var(--healthy); }
  .warning .fill { background: var(--accent); }
  .critical .fill { background: var(--critical); }
  .note { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 12px; color: var(--ink-muted); }
  .critical .note { color: var(--critical); }
  .sub { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 4px; }
  .foot { font-size: 12px; }
</style>
