<!-- Per-Worker or per-group threshold overrides. Worker beats group beats global. Remount to reload from `value`. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { Thresholds } from '../../../../src/shared/config';
  import { fromDisplay, inputStep, rangeText, THRESHOLD_GROUPS, THRESHOLD_META, toDisplay, type ThresholdKey } from '../../lib/thresholds';
  import Icon from '../Icon.svelte';

  let { value = $bindable({}), defaults, targets }: {
    value?: Record<string, Partial<Thresholds>>;
    /** Global thresholds, used as the starting value for a new override. */
    defaults: Thresholds;
    /** Known Worker names and "group:x" targets, offered as suggestions. */
    targets: string[];
  } = $props();

  type Item = { key: ThresholdKey; shown: number };
  let rows = $state(
    Object.entries(value).map(([target, t]) => ({
      target,
      items: Object.entries(t).map(([k, v]) => ({ key: k as ThresholdKey, shown: toDisplay(k as ThresholdKey, v as number) })) as Item[],
    })),
  );

  function commit() {
    value = Object.fromEntries(
      rows
        .filter((r) => r.target.trim())
        .map((r) => [r.target.trim(), Object.fromEntries(r.items.map((i) => [i.key, fromDisplay(i.key, Number(i.shown))]))]),
    );
  }
  function addTarget() {
    rows.push({ target: '', items: [] });
  }
  function addItem(r: (typeof rows)[number], key: string) {
    if (!key) return;
    const k = key as ThresholdKey;
    r.items.push({ key: k, shown: toDisplay(k, defaults[k]) });
    commit();
  }
</script>

<div class="overrides">
  {#each rows as r, ri (ri)}
    <div class="target card">
      <div class="target-head">
        <input class="input mono-input" aria-label="Worker or group" placeholder="worker-name or group:api" list="override-targets" bind:value={r.target} oninput={commit} />
        <button type="button" class="ghost remove" aria-label="Remove override for {r.target || 'this target'}" onclick={() => { rows.splice(ri, 1); commit(); }}><Icon name="trash" size={16} /></button>
      </div>
      {#each r.items as item, ii (item.key)}
        <div class="item">
          <span class="item-label">{THRESHOLD_META[item.key].label}<span class="muted">&nbsp;· {rangeText(item.key)}</span></span>
          <span class="with-unit">
            <input class="input short" type="number" step={inputStep(item.key)} aria-label={THRESHOLD_META[item.key].label} bind:value={item.shown} oninput={commit} />
            <span class="unit muted">{THRESHOLD_META[item.key].unit}</span>
          </span>
          <button type="button" class="ghost remove" aria-label="Remove {THRESHOLD_META[item.key].label}" onclick={() => { r.items.splice(ii, 1); commit(); }}><Icon name="close" size={14} /></button>
        </div>
      {/each}
      <select class="select-input add-item" aria-label="Add a threshold override" value="" onchange={(e) => { addItem(r, e.currentTarget.value); e.currentTarget.value = ''; }}>
        <option value="" disabled>+ Override a threshold…</option>
        {#each THRESHOLD_GROUPS as g (g.title)}
          <optgroup label={g.title}>
            {#each g.items.filter((m) => !r.items.some((i) => i.key === m.key)) as m (m.key)}<option value={m.key}>{m.label}</option>{/each}
          </optgroup>
        {/each}
      </select>
    </div>
  {/each}
  <button type="button" class="add" onclick={addTarget}><Icon name="plus" size={14} /> Add override</button>
  <datalist id="override-targets">{#each targets as t (t)}<option value={t}></option>{/each}</datalist>
</div>

<style>
  .overrides { display: grid; gap: 10px; }
  .target { padding: 12px; display: grid; gap: 8px; background: var(--paper); box-shadow: none; }
  .target-head { display: grid; grid-template-columns: 1fr 36px; gap: 8px; }
  .mono-input { font-family: var(--mono); font-size: 13px; font-weight: 600; }
  .item { display: grid; grid-template-columns: 1fr auto 32px; gap: 8px; align-items: center; padding-left: 4px; font-size: 13px; }
  .with-unit { display: inline-flex; align-items: center; gap: 6px; }
  .unit { width: 44px; font-size: 12px; }
  .remove { width: 32px; min-height: 32px; padding: 0; }
  .remove:hover { color: var(--critical); }
  .add-item { width: auto; justify-self: start; height: 32px; font-size: 13px; color: var(--ink-muted); background-color: transparent; border-style: dashed; }
  .add { justify-self: start; min-height: 32px; font-size: 13px; border-style: dashed; color: var(--ink-muted); background: transparent; }
  .add:hover { color: var(--ink); }
</style>
