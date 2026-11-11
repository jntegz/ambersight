<!-- "Explain in plain words": what a check means, why it matters and what to do, step by step. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { helpFor } from '../../../src/shared/help';

  let { check }: { check: string } = $props();
  const help = $derived(helpFor(check));
</script>

{#if help}
  <details class="explain">
    <summary>Explain in plain words</summary>
    <div class="box">
      <p><strong>What this means.</strong> {help.what}</p>
      <p><strong>Why it matters.</strong> {help.why}</p>
      <p class="steps-title"><strong>What to do</strong></p>
      <ol>
        {#each help.steps as s, i (i)}<li>{s}</li>{/each}
      </ol>
    </div>
  </details>
{/if}

<style>
  .explain { margin-top: 8px; font-size: 13px; line-height: 19px; }
  .explain summary { cursor: pointer; color: var(--accent-text, var(--accent)); font-weight: 500; width: fit-content; }
  .explain summary:hover { text-decoration: underline; }
  .box { margin-top: 8px; padding: 12px 14px; border-radius: 8px; background: var(--row-tint); border: 1px solid var(--line); display: grid; gap: 6px; max-width: 72ch; }
  .box p { margin: 0; }
  .steps-title { margin-top: 2px !important; }
  ol { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
</style>
