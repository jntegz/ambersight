<!-- Settings › Security: find one person's e-mail address or name in stored data and replace it. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { cleanIdentifier, identifierProblem, mayBeOrdinaryWord, PERSON_DATA_CLASSES, REMOVED_MARKER, type PersonDataCounts, type PersonDataEntry, type PersonDataStep } from '../../../../src/shared/personData';
  import { api, num, withProof } from '../../lib/api';
  import { auth } from '../../lib/auth.svelte';
  import { clearOfflineCopies } from '../../lib/offline';

  interface Totals {
    counts: PersonDataCounts;
    cachedViews: number;
    reported: PersonDataEntry[];
    notReachable: string[];
    confirmation: string;
    done: boolean;
    /** Where an unfinished run can go on from. */
    cursor: string | null;
  }

  /** Each step is small, so a large history takes many. A search stopped here can be continued. */
  const MAX_STEPS = 2000;

  let identifier = $state('');
  let passphrase = $state('');
  let understood = $state(false);
  let busy = $state(false);
  let error = $state('');
  let preview = $state<Totals | null>(null);
  let result = $state<Totals | null>(null);

  const replaced = PERSON_DATA_CLASSES.filter((c) => c.replaced);
  const countOf = (t: Totals, id: keyof PersonDataCounts) => t.counts[id] ?? 0;
  const total = (t: Totals) => replaced.reduce((sum, c) => sum + countOf(t, c.id), 0);
  const rows = (t: Totals) => PERSON_DATA_CLASSES.filter((c) => countOf(t, c.id) > 0);

  function empty(): Totals {
    return { counts: {}, cachedViews: 0, reported: [], notReachable: [], confirmation: '', done: false, cursor: null };
  }

  /** Runs steps until the server says it is done, adding up what each one reports. */
  async function collect(into: Totals, step: (cursor: string | null) => Promise<PersonDataStep>) {
    let cursor = into.cursor;
    for (let i = 0; i < MAX_STEPS; i++) {
      const r: PersonDataStep = await step(cursor);
      for (const [k, n] of Object.entries(r.counts) as [keyof PersonDataCounts, number][]) into.counts[k] = (into.counts[k] ?? 0) + n;
      into.cachedViews += r.cachedViews ?? 0;
      into.reported = r.reported ?? into.reported;
      into.notReachable = r.notReachable;
      into.confirmation = r.confirmation ?? into.confirmation;
      into.cursor = r.cursor;
      if (r.done) {
        into.done = true;
        return;
      }
      cursor = r.cursor;
    }
  }

  /** Counts belong to the identifier they were made for. */
  function edited() {
    preview = null;
    result = null;
    understood = false;
    error = '';
  }

  async function find() {
    const id = cleanIdentifier(identifier);
    error = identifierProblem(id) ?? '';
    if (error) return;
    busy = true;
    edited();
    const totals = empty();
    try {
      await collect(totals, (cursor) => api.personalDataPreview(id, cursor));
      preview = totals;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  /** Goes on from where a long search stopped. If this fails, what was found so far stays. */
  async function continueSearch() {
    if (!preview?.cursor) return;
    const id = cleanIdentifier(identifier);
    const totals: Totals = $state.snapshot(preview);
    busy = true;
    error = '';
    try {
      await collect(totals, (cursor) => api.personalDataPreview(id, cursor));
      preview = totals;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!preview?.done) return;
    const id = cleanIdentifier(identifier);
    const { confirmation } = preview;
    busy = true;
    error = '';
    const totals = empty();
    try {
      // The proof goes with the first step only. Its signed cursor carries the later ones.
      await withProof(auth.passkeys, passphrase, (proof) => {
        let first = true;
        return collect(totals, (cursor) => {
          const step = api.personalDataRemove(id, first ? proof : {}, confirmation, cursor);
          first = false;
          return step;
        });
      });
      if (totals.done) {
        identifier = '';
        preview = null;
        void clearOfflineCopies();
      } else {
        error = 'Not finished yet. Run it again to continue: what is already replaced stays replaced.';
      }
      result = totals;
    } catch (e) {
      error = `${(e as Error).message} Anything already replaced stays replaced, and running this again is safe.`;
      if (total(totals)) result = totals;
    } finally {
      busy = false;
      passphrase = '';
      understood = false;
    }
  }
</script>

{#snippet counts(t: Totals)}
  <ul class="counts">
    {#each rows(t) as c (c.id)}
      <li><span>{c.label}</span><span class="mono">{num(countOf(t, c.id))}</span></li>
    {/each}
  </ul>
{/snippet}

{#snippet settingsToChange(t: Totals)}
  {#if t.reported.length}
    <p class="hint"><strong>Change these yourself.</strong> Ambersight does not edit them, because that could change who gets mail:</p>
    <ul class="plain">
      {#each t.reported as e (e.label)}<li>{e.label}{#if e.count > 1} ({num(e.count)}){/if}</li>{/each}
    </ul>
  {/if}
{/snippet}

<div class="person">
  <p class="hint">
    Finds one person's e-mail address or name in stored data and replaces it with <span class="mono">{REMOVED_MARKER}</span>.
    The records stay, so history and counts keep working. An address matches in any case. A name matches only as you type it, capitals included: <span class="mono">Ann</span> does not match <span class="mono">ann</span>, <span class="mono">Channel</span> or <span class="mono">Ann@example.com</span>, so search for each form, and for a name and an address, separately.
  </p>
  <form class="row" onsubmit={(e) => { e.preventDefault(); find(); }}>
    <input class="input" aria-label="E-mail address or name" placeholder="E-mail address or name" autocomplete="off" spellcheck="false" maxlength="254" bind:value={identifier} oninput={edited} />
    <button type="submit" disabled={busy || !identifier.trim()}>{busy && !preview ? 'Searching…' : 'Find stored records'}</button>
  </form>

  {#if preview}
    {#if rows(preview).length}
      {@render counts(preview)}
    {:else if preview.done}
      <p class="hint">No stored record holds this.</p>
    {/if}
    {#if !preview.done}
      <p class="hint" role="status"><strong>The search has not finished.</strong> The list shows only what it has found so far, and nothing can be replaced until it ends.</p>
      <div class="row"><button type="button" disabled={busy} onclick={continueSearch}>{busy ? 'Searching…' : 'Continue searching'}</button></div>
    {/if}
    {#if mayBeOrdinaryWord(cleanIdentifier(identifier))}
      <p class="hint"><strong>Check this is really a name.</strong> A single word can also be an ordinary word, and every place it appears with these capitals counts as a match. The advice and wording of findings are left alone, but other stored text is not. A full name is safer.</p>
    {/if}
    {#if preview.cachedViews}<p class="hint">{num(preview.cachedViews)} cached {preview.cachedViews === 1 ? 'view' : 'views'} may hold it. All cached views are cleared afterwards and rebuilt when next opened.</p>{/if}
    {@render settingsToChange(preview)}
    {#if preview.done && (total(preview) || preview.cachedViews)}
      <form class="confirm" onsubmit={(e) => { e.preventDefault(); remove(); }}>
        <p><strong>This cannot be undone.</strong> Every match above, except names that are only counted, is replaced for good.</p>
        <label class="check"><input type="checkbox" bind:checked={understood} /> I understand that this cannot be undone</label>
        <div class="row">
          {#if !auth.passkeys}
            <input class="input" type="password" autocomplete="current-password" placeholder="Your passphrase" aria-label="Your passphrase, to confirm" bind:value={passphrase} />
          {/if}
          <button type="submit" class="danger" disabled={busy || !understood || (!auth.passkeys && !passphrase)}>{busy ? 'Replacing…' : auth.passkeys ? 'Confirm with passkey and replace' : 'Replace permanently'}</button>
        </div>
      </form>
    {/if}
  {/if}

  {#if error}<p class="error-text" role="alert">{error}</p>{/if}

  {#if result}
    <div class="done" role="status">
      <p><strong>{result.done ? 'Done.' : 'Partly done.'}</strong> {num(total(result))} stored {total(result) === 1 ? 'record' : 'records'} changed{#if result.done}, {num(result.cachedViews)} cached {result.cachedViews === 1 ? 'view' : 'views'} cleared, and this browser's offline copies removed{/if}.</p>
      {@render counts(result)}
      {@render settingsToChange(result)}
      <p class="hint"><strong>This could not reach:</strong></p>
      <ul class="plain">
        {#each result.notReachable as line (line)}<li>{line}</li>{/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .person { display: grid; gap: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row .input { flex: 1; min-width: 200px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .counts { display: grid; font-size: 14px; }
  .counts li { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .plain { display: grid; gap: 4px; font-size: 13px; line-height: 18px; }
  .confirm, .done { display: grid; gap: 10px; padding: 12px; border-radius: 8px; font-size: 14px; line-height: 20px; }
  .confirm { border: 1px solid color-mix(in srgb, var(--critical) 40%, var(--line)); }
  .done { border: 1px solid var(--line); background: var(--row-tint); }
  .check { display: flex; gap: 8px; align-items: center; }
</style>
