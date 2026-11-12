<!-- Time range: 24 hours to 12 months. 24h and 7d are drawn by hour, longer ranges by day. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { RANGES, type Range } from '../../../src/shared/types';
  import { RANGE_LABEL, RANGE_SHORT } from '../lib/route';

  let { value, onChange }: { value: Range; onChange: (r: Range) => void } = $props();
</script>

<div class="seg" role="group" aria-label="Time range">
  {#each RANGES as r (r)}
    <button type="button" aria-pressed={value === r} title={RANGE_LABEL[r]} onclick={() => onChange(r)}>{RANGE_SHORT[r]}</button>
  {/each}
</div>
