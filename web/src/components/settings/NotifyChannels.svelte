<!-- Email and webhook channels: whether each is configured (Worker secrets/vars) and a test-message button. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { SetupStatus } from '../../../../src/shared/types';
  import { api } from '../../lib/api';
  import Icon from '../Icon.svelte';

  let { status }: { status: Pick<SetupStatus, 'email' | 'webhook'> } = $props();

  type Channel = 'email' | 'webhook';
  let result = $state<Record<Channel, { ok: boolean; text: string } | null>>({ email: null, webhook: null });
  let busy = $state<Channel | null>(null);

  async function test(channel: Channel) {
    busy = channel;
    result[channel] = null;
    try {
      await api.testNotify(channel);
      result[channel] = { ok: true, text: channel === 'email' ? 'Test email sent. Check the inbox.' : 'Test message sent.' };
    } catch (e) {
      result[channel] = { ok: false, text: (e as Error).message };
    } finally {
      busy = null;
    }
  }
  const KIND: Record<string, string> = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', ntfy: 'ntfy', json: 'JSON webhook' };
</script>

<div class="channels">
  <div class="channel" class:on={status.email.configured}>
    <span class="c-icon"><Icon name="mail" size={18} /></span>
    <div class="c-body">
      <p class="c-title">Email <span class="state">{status.email.configured ? 'Connected' : 'Not set up'}</span></p>
      {#if status.email.configured}
        <p class="c-detail muted">From <span class="mono">{status.email.from}</span> to <span class="mono">{status.email.to.join(', ')}</span></p>
      {:else}
        <p class="c-detail muted">Add the <span class="mono">EMAIL</span> send_email binding and set <span class="mono">EMAIL_FROM</span> and <span class="mono">DIGEST_TO</span> in wrangler.jsonc, then deploy.</p>
      {/if}
      {#if result.email}<p class={result.email.ok ? 'success-text' : 'error-text'} role="status">{result.email.text}</p>{/if}
    </div>
    <button type="button" disabled={!status.email.configured || busy === 'email'} onclick={() => test('email')}>{busy === 'email' ? 'Sending…' : 'Send test'}</button>
  </div>

  <div class="channel" class:on={status.webhook.configured}>
    <span class="c-icon"><Icon name="webhook" size={18} /></span>
    <div class="c-body">
      <p class="c-title">Webhook <span class="state">{status.webhook.configured ? KIND[status.webhook.kind ?? 'json'] ?? 'Connected' : 'Not set up'}</span></p>
      {#if status.webhook.configured}
        <p class="c-detail muted">Instant alerts post to the URL in the <span class="mono">WEBHOOK_URL</span> secret.</p>
      {:else}
        <p class="c-detail muted">Run <span class="mono">wrangler secret put WEBHOOK_URL</span> with a Slack, Discord, Telegram, ntfy or JSON endpoint.</p>
      {/if}
      {#if result.webhook}<p class={result.webhook.ok ? 'success-text' : 'error-text'} role="status">{result.webhook.text}</p>{/if}
    </div>
    <button type="button" disabled={!status.webhook.configured || busy === 'webhook'} onclick={() => test('webhook')}>{busy === 'webhook' ? 'Sending…' : 'Send test'}</button>
  </div>
</div>

<style>
  .channels { display: grid; gap: 10px; }
  .channel { display: grid; grid-template-columns: 36px 1fr auto; gap: 12px; align-items: start; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--paper); }
  .c-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--line); color: var(--ink-muted); }
  .on .c-icon { background: color-mix(in srgb, var(--healthy) 14%, transparent); color: var(--healthy); }
  .c-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
  .state { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--line); color: var(--ink-muted); }
  .on .state { background: color-mix(in srgb, var(--healthy) 14%, transparent); color: var(--healthy); }
  .c-detail { font-size: 13px; line-height: 18px; margin-top: 2px; overflow-wrap: anywhere; }
  .c-detail .mono { font-size: 12px; color: var(--ink); }
  .c-body p[role='status'] { margin-top: 6px; }
  .channel button { font-size: 13px; min-height: 32px; }
  @media (max-width: 560px) {
    .channel { grid-template-columns: 36px 1fr; }
    .channel button { grid-column: 2; justify-self: start; }
  }
</style>
