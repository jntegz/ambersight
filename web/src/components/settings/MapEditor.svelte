<!-- Edits a name -> list map (groups -> patterns, groups -> email addresses). Remount it to reload from `value`. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import Icon from '../Icon.svelte';

  let { value = $bindable({}), keyLabel, listLabel, keyPlaceholder, listPlaceholder, addLabel, keyOptions = [] }: {
    value?: Record<string, string[]>;
    keyLabel: string;
    listLabel: string;
    keyPlaceholder: string;
    listPlaceholder: string;
    addLabel: string;
    keyOptions?: string[];
  } = $props();

  const listId = `opts-${Math.random().toString(36).slice(2, 8)}`;
  let rows = $state(Object.entries(value).map(([key, list]) => ({ key, text: list.join(', ') })));

  const split = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  function commit() {
    value = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), split(r.text)]));
  }
  function add() {
    rows.push({ key: '', text: '' });
  }
  function remove(i: number) {
    rows.splice(i, 1);
    commit();
  }
  const dupes = $derived(new Set(rows.map((r) => r.key.trim()).filter((k, i, all) => k && all.indexOf(k) !== i)));
</script>

<div class="map">
  {#if rows.length}
    <div class="row head" aria-hidden="true"><span>{keyLabel}</span><span>{listLabel}</span><span></span></div>
  {/if}
  {#each rows as row, i (i)}
    <div class="row">
      <input class="input" aria-label={keyLabel} placeholder={keyPlaceholder} list={keyOptions.length ? listId : undefined}
        aria-invalid={dupes.has(row.key.trim())} bind:value={row.key} oninput={commit} />
      <input class="input mono-input" aria-label={listLabel} placeholder={listPlaceholder} bind:value={row.text} oninput={commit} />
      <button type="button" class="ghost remove" aria-label="Remove {row.key || 'row'}" onclick={() => remove(i)}><Icon name="trash" size={16} /></button>
    </div>
    {#if dupes.has(row.key.trim())}<p class="error-text">“{row.key.trim()}” is listed twice; only the last one is kept.</p>{/if}
  {/each}
  <button type="button" class="add" onclick={add}><Icon name="plus" size={14} /> {addLabel}</button>
  {#if keyOptions.length}
    <datalist id={listId}>{#each keyOptions as o (o)}<option value={o}></option>{/each}</datalist>
  {/if}
</div>

<style>
  .map { display: grid; gap: 8px; }
  .row { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(0, 2.2fr) 36px; gap: 8px; align-items: center; }
  .row.head { font-size: 12px; line-height: 16px; color: var(--ink-muted); font-weight: 500; }
  .mono-input { font-family: var(--mono); font-size: 13px; }
  .remove { width: 36px; padding: 0; }
  .remove:hover { color: var(--critical); }
  .add { justify-self: start; min-height: 32px; font-size: 13px; border-style: dashed; color: var(--ink-muted); background: transparent; }
  .add:hover { color: var(--ink); }
  @media (max-width: 640px) {
    .row { grid-template-columns: 1fr 36px; }
    .row > :nth-child(2) { grid-column: 1; }
    .row > :nth-child(3) { grid-row: 1; grid-column: 2; }
    .row.head { display: none; }
  }
</style>
