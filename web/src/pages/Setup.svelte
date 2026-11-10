<!-- First-run setup: 1 check the API token, 2 protect the dashboard, 3 notifications. Shown until setup is complete. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { TOKEN_TEMPLATE_URL } from '../../../src/shared/token';
  import type { SetupStatus } from '../../../src/shared/types';
  import Icon from '../components/Icon.svelte';
  import Logo from '../components/Logo.svelte';
  import NotifyChannels from '../components/settings/NotifyChannels.svelte';
  import PassphraseForm from '../components/settings/PassphraseForm.svelte';
  import { api, ApiError } from '../lib/api';

  let { onDone, onSignedOut, onUnauthorized }: {
    onDone: () => void;
    onSignedOut: (message: string) => void;
    onUnauthorized: () => void;
  } = $props();

  const STEPS = [
    { title: 'Connect', text: 'Check the API token' },
    { title: 'Protect', text: 'Lock down the dashboard' },
    { title: 'Notify', text: 'Choose where alerts go' },
  ];
  let step = $state(0);
  let status = $state<SetupStatus | null>(null);
  let checking = $state(false);
  let loadError = $state('');
  let confirmReadOnly = $state(false);
  let changePass = $state(false);
  let pending = $state<{ current: string; next: string } | null>(null);
  let finishing = $state(false);
  let finishError = $state('');

  async function check() {
    checking = true;
    loadError = '';
    try {
      status = await api.setup();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else loadError = (e as Error).message;
    } finally {
      checking = false;
    }
  }
  onMount(check);

  const tokenOk = $derived(!!status?.tokenActive && (status.writeScopes?.length === 0 || (status.writeScopes == null && confirmReadOnly)));

  async function finish() {
    finishing = true;
    finishError = '';
    try {
      await api.completeSetup({
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(status?.writeScopes == null && confirmReadOnly ? { confirmReadOnly: true as const } : {}),
      });
      if (pending) {
        try {
          await api.changePassphrase(pending.current, pending.next);
        } catch (e) {
          // Setup is already complete; report the passphrase problem but let the user in.
          finishError = `Setup is done, but the passphrase was not changed: ${(e as Error).message} You can change it later in Settings.`;
          finishing = false;
          pending = null;
          return;
        }
        onSignedOut('Setup is done and the passphrase changed. Sign in with the new passphrase; the first scan is running.');
        return;
      }
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else finishError = (e as Error).message;
    } finally {
      finishing = false;
    }
  }
</script>

<main class="setup">
  <aside class="rail">
    <div class="brand"><Logo size={32} label="Ambersight" /><span class="wordmark">ambersight</span></div>
    <p class="welcome">Let's get your fleet on one page. Three short steps; nothing here changes your Workers.</p>
    <ol class="steps">
      {#each STEPS as s, i (s.title)}
        <li class:done={i < step} class:current={i === step}>
          <span class="dot">{#if i < step}<Icon name="check" size={14} />{:else}{i + 1}{/if}</span>
          <span><strong>{s.title}</strong><span class="muted">{s.text}</span></span>
        </li>
      {/each}
    </ol>
  </aside>

  <section class="card panel" aria-labelledby="step-title">
    <p class="eyebrow muted">Step {step + 1} of {STEPS.length}</p>

    {#if step === 0}
      <h1 id="step-title">Check the API token</h1>
      <p class="lead">Ambersight reads your account with the <span class="mono">CF_API_TOKEN</span> secret. It must be read-only.</p>

      {#if loadError}
        <p class="error-text" role="alert">{loadError}</p>
      {:else if !status}
        <p class="muted" aria-busy="true">Checking the token…</p>
      {:else}
        <ul class="checks">
          <li class={status.tokenActive ? 'ok' : 'bad'}>
            <Icon name={status.tokenActive ? 'healthy' : 'critical'} size={20} />
            <div>
              <p class="c-title">{status.tokenActive ? 'Token is active' : 'Token does not work'}</p>
              <p class="muted">{status.tokenActive ? `Account: ${status.accountName ?? status.accountId ?? 'unknown'}${status.detectedPlan ? ` · ${status.detectedPlan} plan` : ''}` : (status.tokenError ?? 'Set CF_API_TOKEN with wrangler secret put and deploy again.')}</p>
              {#if status.tokenError}
                <a class="token-link" href={TOKEN_TEMPLATE_URL} target="_blank" rel="noopener noreferrer"><Icon name="key" size={16} /> Create a read-only token <Icon name="external" size={14} /></a>
                <p class="muted next-step">Then update the <span class="mono">CF_API_TOKEN</span> secret in your Worker's settings and press Check again.</p>
              {/if}
            </div>
          </li>
          {#if status.tokenActive}
            {#if status.writeScopes == null}
              <li class="warn">
                <Icon name="warning" size={20} />
                <div>
                  <p class="c-title">Permissions could not be read</p>
                  <p class="muted">This token cannot list its own permissions. Check it in the Cloudflare dashboard and confirm it only has <strong>Read</strong> permissions.</p>
                  <label class="confirm"><input type="checkbox" bind:checked={confirmReadOnly} /> I confirm this token is read-only</label>
                </div>
              </li>
            {:else if status.writeScopes.length}
              <li class="bad">
                <Icon name="critical" size={20} />
                <div>
                  <p class="c-title">Token can make changes</p>
                  <p class="muted">Ambersight never writes, but a leaked token could. Create a new token with read permissions only, then run <span class="mono">wrangler secret put CF_API_TOKEN</span>.</p>
                  <div class="chips">{#each status.writeScopes as s (s)}<span class="tag-chip bad-chip">{s}</span>{/each}</div>
                  <a class="token-link" href={TOKEN_TEMPLATE_URL} target="_blank" rel="noopener noreferrer"><Icon name="key" size={16} /> Create a read-only token <Icon name="external" size={14} /></a>
                </div>
              </li>
            {:else}
              <li class="ok">
                <Icon name="shield" size={20} />
                <div>
                  <p class="c-title">Read-only, as it should be</p>
                  {#if status.readScopes?.length}<div class="chips">{#each status.readScopes as s (s)}<span class="tag-chip">{s}</span>{/each}</div>{/if}
                </div>
              </li>
            {/if}
          {/if}
        </ul>
      {/if}

      <div class="actions">
        <button type="button" class="ghost" onclick={check} disabled={checking}><Icon name="refresh" size={16} /> {checking ? 'Checking…' : 'Check again'}</button>
        <button type="button" class="primary" disabled={!tokenOk} onclick={() => (step = 1)}>Continue <Icon name="arrow" size={16} /></button>
      </div>
    {:else if step === 1}
      <h1 id="step-title">Protect the dashboard</h1>
      <p class="lead">The dashboard is behind a passphrase. For a team, add Cloudflare Access in front of it as well.</p>

      <ol class="guide">
        <li><span class="n">1</span><p>In the Cloudflare dashboard open <strong>Zero Trust → Access → Applications</strong> and add a <strong>Self-hosted</strong> application.</p></li>
        <li><span class="n">2</span><p>Use this dashboard's hostname, <span class="mono">{location.host}</span>, as the application domain.</p></li>
        <li><span class="n">3</span><p>Add a policy that allows only your team, for example emails ending in your company domain.</p></li>
      </ol>
      <a class="doc-link" href="https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/" target="_blank" rel="noopener noreferrer">Cloudflare Access guide <Icon name="external" size={14} /></a>

      <div class="pass-box">
        <div class="pass-head">
          <div>
            <p class="c-title">Change the passphrase</p>
            <p class="muted">Optional. Replaces the one from deploy. Applied when you finish, then you sign in again.</p>
          </div>
          {#if !changePass && !pending}<button type="button" onclick={() => (changePass = true)}><Icon name="key" size={16} /> Change</button>{/if}
        </div>
        {#if pending}
          <p class="success-text"><Icon name="check" size={14} /> New passphrase will be set when you finish. <button type="button" class="link" onclick={() => (pending = null)}>Undo</button></p>
        {:else if changePass}
          <PassphraseForm submitLabel="Use this passphrase" onSubmit={(current, next) => { pending = { current, next }; changePass = false; }} />
        {/if}
      </div>

      <div class="actions">
        <button type="button" class="ghost" onclick={() => (step = 0)}>Back</button>
        <button type="button" class="primary" onclick={() => (step = 2)}>Continue <Icon name="arrow" size={16} /></button>
      </div>
    {:else}
      <h1 id="step-title">Choose where alerts go</h1>
      <p class="lead">Critical problems are emailed right away; everything else goes into a weekly digest. Send a test to make sure it arrives.</p>
      {#if status}<NotifyChannels {status} />{/if}
      <p class="muted small">You can set up channels later and fine-tune routing in Settings → Alerts.</p>

      {#if finishError}<p class="error-text" role="alert">{finishError}</p>{/if}
      <div class="actions">
        <button type="button" class="ghost" onclick={() => (step = 1)} disabled={finishing}>Back</button>
        {#if finishError && !pending && finishError.startsWith('Setup is done')}
          <button type="button" class="primary" onclick={onDone}>Open dashboard <Icon name="arrow" size={16} /></button>
        {:else}
          <button type="button" class="primary" onclick={finish} disabled={finishing}>{finishing ? 'Finishing…' : 'Finish and start the first scan'}</button>
        {/if}
      </div>
    {/if}
  </section>
</main>

<style>
  .setup { min-height: 100vh; display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 620px); gap: 48px; justify-content: center; align-items: start; padding: 72px 24px; }
  .rail { position: sticky; top: 72px; display: grid; gap: 20px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .wordmark { font-size: 22px; font-weight: 600; letter-spacing: -0.03em; }
  .welcome { font-size: 15px; line-height: 22px; color: var(--ink-muted); }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .steps li { position: relative; display: flex; gap: 12px; align-items: start; padding: 10px 0; }
  .steps li:not(:last-child)::after { content: ''; position: absolute; left: 13px; top: 40px; bottom: -6px; width: 2px; border-radius: 1px; background: var(--line); }
  .steps li.done:not(:last-child)::after { background: var(--accent); }
  .steps strong { display: block; font-size: 14px; line-height: 20px; }
  .steps .muted { display: block; font-size: 13px; line-height: 18px; }
  .dot { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--line); font-size: 13px; font-weight: 600; color: var(--ink-muted); background: var(--paper); }
  .current .dot { border-color: var(--accent); color: var(--accent-text); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent); }
  .done .dot { border-color: var(--button); background: var(--button); color: var(--button-text); }

  .panel { padding: 32px; display: grid; gap: 18px; }
  @media (prefers-reduced-motion: no-preference) { .panel { animation: rise 420ms cubic-bezier(0.2, 0.8, 0.2, 1); } }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
  .eyebrow { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  h1 { font-size: 26px; line-height: 32px; font-weight: 600; letter-spacing: -0.02em; margin-top: -10px; }
  .lead { font-size: 15px; line-height: 22px; color: var(--ink-muted); margin-top: -6px; }
  .small { font-size: 13px; }

  .checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .checks li { display: flex; gap: 12px; align-items: start; padding: 14px; border-radius: var(--radius-control); border: 1px solid var(--line); background: var(--paper); font-size: 14px; line-height: 20px; }
  .checks li > :global(svg) { flex: none; margin-top: 1px; }
  .checks .ok > :global(svg) { color: var(--healthy); }
  .checks .warn > :global(svg) { color: var(--accent); }
  .checks .bad { border-color: color-mix(in srgb, var(--critical) 40%, var(--line)); }
  .checks .bad > :global(svg) { color: var(--critical); }
  .c-title { font-weight: 600; font-size: 14px; }
  .checks .muted strong { color: var(--ink); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .bad-chip { background: color-mix(in srgb, var(--critical) 12%, transparent); color: var(--critical); }
  .token-link {
    display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 0 12px; height: 34px;
    border-radius: var(--radius-control); background: var(--button); color: var(--button-text);
    font-size: 13px; font-weight: 600; text-decoration: none;
  }
  .token-link:hover { background: var(--button-hover); color: var(--button-text); }
  .next-step { margin-top: 8px; font-size: 13px; line-height: 18px; }
  .next-step .mono { font-size: 12px; color: var(--ink); }
  .confirm { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; font-weight: 500; cursor: pointer; }
  .confirm input { width: 16px; height: 16px; margin: 0; accent-color: var(--button); }

  .guide { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .guide li { display: flex; gap: 12px; align-items: start; font-size: 14px; line-height: 20px; }
  .n { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--chip); color: var(--chip-text); font-size: 12px; font-weight: 600; }
  .doc-link { display: inline-flex; align-items: center; gap: 4px; font-size: 14px; font-weight: 500; text-decoration: none; justify-self: start; }
  .doc-link:hover { text-decoration: underline; }
  .pass-box { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--paper); }
  .pass-head { display: flex; gap: 12px; align-items: start; justify-content: space-between; }
  .pass-head .muted { font-size: 13px; line-height: 18px; margin-top: 2px; }
  .success-text { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .link { min-height: 0; padding: 0; border: 0; background: none; color: var(--accent-text); font-size: 13px; text-decoration: underline; }

  .actions { display: flex; justify-content: space-between; gap: 12px; padding-top: 18px; margin-top: 4px; border-top: 1px solid var(--line); }
  .actions .primary { min-height: 40px; padding: 0 18px; }

  @media (max-width: 860px) {
    .setup { grid-template-columns: 1fr; gap: 24px; padding: 24px 16px; }
    .rail { position: static; }
    .steps { grid-auto-flow: column; }
    .steps li:not(:last-child)::after { display: none; }
    .steps .muted { display: none; }
    .panel { padding: 22px; }
  }
</style>
