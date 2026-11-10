<!-- Change the dashboard passphrase. The parent decides when to apply it (Settings: now; setup: at the end). -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import Icon from '../Icon.svelte';

  let { onSubmit, submitLabel = 'Change passphrase', note = '' }: {
    onSubmit: (current: string, next: string) => Promise<void> | void;
    submitLabel?: string;
    /** Shown beside the button, e.g. what happens after the change. */
    note?: string;
  } = $props();

  const MIN = 12;
  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  const strength = $derived(next.length === 0 ? 0 : next.length < MIN ? 1 : next.length < 20 ? 2 : 3);
  const STRENGTH = ['', 'Too short', 'Good', 'Strong'];
  const matches = $derived(confirm.length > 0 && confirm === next);
  const mismatch = $derived(confirm.length > 0 && confirm !== next);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    if (next.length < MIN) return (error = `The new passphrase needs at least ${MIN} characters.`);
    if (next !== confirm) return (error = 'The two new passphrases do not match.');
    if (next === current) return (error = 'The new passphrase is the same as the current one.');
    busy = true;
    try {
      await onSubmit(current, next);
      current = next = confirm = '';
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form class="pass" onsubmit={submit}>
  <label class="field">
    <span class="label">Current passphrase</span>
    <input class="input" type="password" autocomplete="current-password" bind:value={current} required />
  </label>
  <span class="spacer" aria-hidden="true"></span>

  <label class="field">
    <span class="label">New passphrase</span>
    <input class="input" type="password" autocomplete="new-password" minlength={MIN} bind:value={next} aria-describedby="pass-strength" required />
    <span class="status" id="pass-strength" aria-live="polite">
      {#if strength === 0}
        <span class="muted">At least {MIN} characters</span>
      {:else}
        <span class="bars s{strength}" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="s-label s{strength}">{STRENGTH[strength]}{#if strength === 1}<span class="muted">&nbsp;· {MIN - next.length} more</span>{/if}</span>
      {/if}
    </span>
  </label>

  <label class="field">
    <span class="label">Repeat new passphrase</span>
    <input class="input" type="password" autocomplete="new-password" bind:value={confirm} aria-invalid={mismatch} aria-describedby="pass-match" required />
    <span class="status" id="pass-match" aria-live="polite">
      {#if matches}
        <span class="ok"><Icon name="check" size={14} /> Matches</span>
      {:else if mismatch}
        <span class="bad">Does not match yet</span>
      {:else}
        <span class="muted">Type it once more</span>
      {/if}
    </span>
  </label>

  {#if error}<p class="error-text full" role="alert">{error}</p>{/if}

  <div class="actions full">
    <button class="primary" type="submit" disabled={busy || !current || strength < 2 || !matches}>{busy ? 'Saving…' : submitLabel}</button>
    {#if note}<p class="note muted"><Icon name="logout" size={14} /> {note}</p>{/if}
  </div>
</form>

<style>
  .pass { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 16px; max-width: 640px; }
  .full { grid-column: 1 / -1; }
  .status { display: flex; align-items: center; gap: 10px; min-height: 18px; font-size: 12px; line-height: 16px; }
  .bars { display: grid; grid-template-columns: repeat(3, 28px); gap: 3px; }
  .bars span { height: 4px; border-radius: 2px; background: var(--line); transition: background 150ms; }
  .bars.s1 span:nth-child(1) { background: var(--critical); }
  .bars.s2 span:nth-child(-n + 2) { background: var(--accent); }
  .bars.s3 span { background: var(--healthy); }
  .s-label { font-weight: 600; }
  .s-label.s1 { color: var(--critical); }
  .s-label.s2 { color: var(--warning-text); }
  .s-label.s3 { color: var(--healthy); }
  .ok { display: inline-flex; align-items: center; gap: 4px; color: var(--healthy); font-weight: 600; }
  .bad { color: var(--critical); }
  .actions { display: flex; align-items: center; gap: 12px 16px; flex-wrap: wrap; padding-top: 4px; }
  .actions .primary { min-height: 38px; padding: 0 16px; }
  .note { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 18px; }
  .note :global(svg) { flex: none; }
  @media (max-width: 640px) {
    .pass { grid-template-columns: 1fr; }
    .spacer { display: none; }
  }
</style>
