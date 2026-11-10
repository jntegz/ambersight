<!-- Snooze button with a 7 / 30 / 90 day menu. Used by a single finding and by a group. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import Icon from './Icon.svelte';

  let { onSnooze, label = 'Snooze', title = 'Hide this finding for' }: {
    onSnooze: (days: 7 | 30 | 90) => void;
    label?: string;
    title?: string;
  } = $props();

  const SNOOZE = [7, 30, 90] as const;
  let open = $state(false);
  let el = $state<HTMLDivElement>();
  function closeOnOutside(e: MouseEvent) {
    if (open && el && !el.contains(e.target as Node)) open = false;
  }
</script>

<div class="snooze" bind:this={el}>
  <button type="button" aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)}>
    <Icon name="snooze" size={16} /> {label} <span class="caret" class:open><Icon name="chevron" size={12} /></span>
  </button>
  {#if open}
    <div class="menu" role="menu" aria-label="{label} for">
      <p class="menu-title">{title}</p>
      {#each SNOOZE as days (days)}
        <button type="button" role="menuitem" onclick={() => { open = false; onSnooze(days); }}>
          {days} days <span class="muted">until {new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<svelte:window onclick={closeOnOutside} onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<style>
  .snooze { position: relative; }
  button { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; min-height: 32px; padding: 0 10px; background: transparent; color: var(--ink-muted); }
  button:hover { color: var(--ink); background: var(--surface); }
  .caret { display: inline-flex; transition: transform 150ms; }
  .caret.open { transform: rotate(180deg); }
  .menu {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 200px; padding: 6px;
    display: grid; gap: 2px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--surface); box-shadow: var(--shadow-lift), 0 2px 6px rgba(0, 0, 0, 0.08);
  }
  .menu-title { font-size: 11px; line-height: 16px; padding: 4px 8px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .menu button { justify-content: space-between; width: 100%; border: 0; border-radius: 6px; color: var(--ink); font-weight: 500; }
  .menu button:hover { background: var(--row-tint); }
  .menu .muted { font-weight: 400; font-size: 12px; }
  @media (prefers-reduced-motion: no-preference) {
    .menu { animation: pop 140ms ease-out; transform-origin: top right; }
  }
  @keyframes pop { from { opacity: 0; transform: scale(0.96) translateY(-4px); } }
</style>
