<!-- Ctrl+K / Cmd+K: jump to any Worker, page or account by typing part of its name. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Icon, { type IconName } from './Icon.svelte';

  export interface Command {
    id: string;
    label: string;
    hint?: string;
    icon: IconName;
    run: () => void;
  }
  let { commands, onClose }: { commands: Command[]; onClose: () => void } = $props();

  let q = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  // Matches every typed word, in any order; names that start with the query come first.
  const results = $derived.by(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(w)));
    const first = words[0] ?? '';
    return list.sort((a, b) => Number(b.label.toLowerCase().startsWith(first)) - Number(a.label.toLowerCase().startsWith(first))).slice(0, 50);
  });
  $effect(() => {
    void q;
    active = 0;
  });
  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') active = Math.min(results.length - 1, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'Enter' && results[active]) choose(results[active]);
    else if (e.key === 'Escape') onClose();
    else return;
    e.preventDefault();
    document.getElementById(`cmd-${active}`)?.scrollIntoView({ block: 'nearest' });
  }
  function choose(c: Command) {
    onClose();
    c.run();
  }
  onMount(() => input?.focus());
</script>

<div class="backdrop" role="presentation" onclick={onClose}></div>
<div class="palette card" role="dialog" aria-modal="true" aria-label="Go to">
  <label class="field-row">
    <Icon name="search" size={16} />
    <span class="sr-only">Go to a Worker, page or account</span>
    <input
      bind:this={input} bind:value={q} onkeydown={key} placeholder="Go to a Worker, page or account…" autocomplete="off" spellcheck="false"
      role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={results.length ? `cmd-${active}` : undefined}
    />
    <kbd>Esc</kbd>
  </label>
  <ul id="cmd-list" role="listbox">
    {#each results as c, i (c.id)}
      <li id="cmd-{i}" role="option" aria-selected={i === active} class:on={i === active} onpointerenter={() => (active = i)}>
        <button type="button" tabindex="-1" onclick={() => choose(c)}>
          <Icon name={c.icon} size={16} /><span class="label" class:mono={c.icon === 'worker'}>{c.label}</span>{#if c.hint}<span class="hint">{c.hint}</span>{/if}
        </button>
      </li>
    {:else}
      <li class="none muted">Nothing matches.</li>
    {/each}
  </ul>
  <p class="foot muted"><kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>Enter</kbd> to open. Shortcuts: <kbd>g</kbd> then <kbd>o</kbd> overview, <kbd>a</kbd> analytics, <kbd>f</kbd> findings, <kbd>t</kbd> timeline, <kbd>r</kbd> resources, <kbd>s</kbd> settings; <kbd>/</kbd> search.</p>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 40; background: color-mix(in srgb, var(--ink) 30%, transparent); }
  .palette {
    position: fixed; z-index: 41; top: 12vh; left: 50%; transform: translateX(-50%);
    width: min(600px, calc(100vw - 32px)); max-height: 70vh; display: grid; grid-template-rows: auto 1fr auto; overflow: hidden;
    box-shadow: var(--shadow-lift);
  }
  .field-row { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--line); color: var(--ink-muted); }
  input { flex: 1; height: 52px; border: 0; outline: 0; background: transparent; font-size: 16px; color: var(--ink); }
  ul { list-style: none; margin: 0; padding: 6px; overflow: auto; }
  li button {
    width: 100%; justify-content: flex-start; gap: 10px; min-height: 38px; padding: 0 10px; border: 0; border-radius: 8px;
    background: transparent; color: var(--ink); text-align: left;
  }
  li.on button { background: var(--chip); color: var(--chip-text); }
  .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint { font-size: 12px; color: var(--ink-muted); }
  li.on .hint { color: inherit; opacity: 0.8; }
  .none { padding: 12px; }
  .foot { padding: 8px 14px; border-top: 1px solid var(--line); font-size: 12px; line-height: 20px; }
  kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 4px; margin: 0 1px; font: 500 11px/1 var(--font); border: 1px solid var(--line); border-radius: 5px; background: var(--paper); color: var(--ink-muted); }
</style>
