<!-- On/off switch. A real button with role="switch", so it works with keyboard and screen readers. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  let { checked = $bindable(false), label, disabled = false, onchange }: {
    checked?: boolean;
    label: string;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
  } = $props();

  function toggle() {
    checked = !checked;
    onchange?.(checked);
  }
</script>

<button type="button" class="switch" role="switch" aria-checked={checked} aria-label={label} {disabled} onclick={toggle}>
  <span class="knob" aria-hidden="true"></span>
</button>

<style>
  .switch {
    position: relative; flex: none; width: 36px; height: 20px; min-height: 20px; padding: 0;
    border: 0; border-radius: 999px; background: var(--line); transition: background 160ms;
  }
  .switch:hover { background: color-mix(in srgb, var(--ink-muted) 45%, var(--line)); }
  .switch[aria-checked='true'] { background: var(--button); }
  .switch[aria-checked='true']:hover { background: var(--button-hover); }
  .knob {
    position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    transition: transform 200ms cubic-bezier(0.3, 1.3, 0.5, 1);
  }
  .switch[aria-checked='true'] .knob { transform: translateX(16px); }
</style>
