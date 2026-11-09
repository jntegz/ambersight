<!-- Hex lens mark: one continuous line, plus the glint (dropped at 16 px). -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  let { size = 32, label = '' }: { size?: number; label?: string } = $props();
  const stroke = $derived(size >= 120 ? 1.25 : size >= 48 ? 2.5 : size >= 24 ? 3.25 : 4.5);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 48 48"
  fill="none"
  stroke="var(--accent)"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : 'true'}
>
  <path d="M42.5 38.5L32.5 28.5V15.5L21 9L9.5 15.5V28.5L21 35L32.5 28.5" />
  {#if size > 16}<path d="M15 19.5A7 7 0 0 1 19.5 14.8" />{/if}
</svg>
