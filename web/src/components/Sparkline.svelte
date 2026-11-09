<!-- 7-day request sparkline. Orange only when the Worker has an open finding. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  let { values, hot = false, label }: { values: number[]; hot?: boolean; label: string } = $props();
  const W = 120;
  const H = 28;
  const points = $derived.by(() => {
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? W / (values.length - 1) : W;
    return values.map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`).join(' ');
  });
</script>

<svg width={W} height={H} viewBox="0 0 {W} {H}" role="img" aria-label={label}>
  {#if hot}<polygon points="0,{H} {points} {W},{H}" fill="var(--orange-200)" opacity="0.5" />{/if}
  <polyline {points} fill="none" stroke={hot ? 'var(--accent)' : 'var(--ink-muted)'} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
</svg>
