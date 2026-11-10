<!-- Change the dashboard passphrase. The parent decides when to apply it (Settings: now; setup: at the end). -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  let { onSubmit, submitLabel = 'Change passphrase' }: {
    onSubmit: (current: string, next: string) => Promise<void> | void;
    submitLabel?: string;
  } = $props();

  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  const strength = $derived(next.length === 0 ? 0 : next.length < 12 ? 1 : next.length < 20 ? 2 : 3);
  const STRENGTH = ['', 'Too short', 'Good', 'Strong'];

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    if (next.length < 12) return (error = 'The new passphrase needs at least 12 characters.');
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
  <div class="two">
    <label class="field">
      <span class="label">New passphrase</span>
      <input class="input" type="password" autocomplete="new-password" minlength="12" bind:value={next} required />
      <span class="meter s{strength}" aria-live="polite"><span></span><span></span><span></span><em>{STRENGTH[strength]}</em></span>
    </label>
    <label class="field">
      <span class="label">Repeat new passphrase</span>
      <input class="input" type="password" autocomplete="new-password" bind:value={confirm} aria-invalid={confirm.length > 0 && confirm !== next} required />
    </label>
  </div>
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}
  <div><button class="primary" type="submit" disabled={busy || !current || !next || !confirm}>{busy ? 'Saving…' : submitLabel}</button></div>
</form>

<style>
  .pass { display: grid; gap: 14px; max-width: 560px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .meter { display: grid; grid-template-columns: repeat(3, 1fr) auto; gap: 4px; align-items: center; height: 16px; }
  .meter span { height: 4px; border-radius: 2px; background: var(--line); }
  .meter em { font-style: normal; font-size: 11px; color: var(--ink-muted); margin-left: 6px; min-width: 48px; }
  .s1 span:nth-child(1) { background: var(--critical); }
  .s2 span:nth-child(-n + 2) { background: var(--accent); }
  .s3 span:nth-child(-n + 3) { background: var(--healthy); }
  @media (max-width: 640px) { .two { grid-template-columns: 1fr; } }
</style>
