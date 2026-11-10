<!-- Group scope control: segmented pills for a few groups, a select for many. Renders nothing without groups. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  let { groups, value = $bindable('') }: { groups: string[]; value?: string } = $props();
</script>

{#if groups.length && groups.length <= 5}
  <div class="seg" role="group" aria-label="Filter by group">
    <button type="button" aria-pressed={value === ''} onclick={() => (value = '')}>All groups</button>
    {#each groups as g (g)}
      <button type="button" aria-pressed={value === g} onclick={() => (value = g)}>{g}</button>
    {/each}
  </div>
{:else if groups.length}
  <label class="select-pill">
    <span class="muted">Group</span>
    <select bind:value>
      <option value="">All groups</option>
      {#each groups as g (g)}<option value={g}>{g}</option>{/each}
    </select>
  </label>
{/if}
