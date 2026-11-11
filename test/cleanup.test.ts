// Cleanup commands for leftovers, and the Markdown export of Needs attention and Housekeeping.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cleanupFor, groupFindings } from '../src/shared/findings';
import type { Finding } from '../src/shared/types';
import { findingsMarkdown } from '../web/src/lib/exportMd';

const f = (module: Finding['module'], script: string, code: string, evidence: Finding['evidence'] = {}, severity: Finding['severity'] = 'info'): Finding => ({
  id: `${module}:${script}:${code}`, module, script, code, severity, message: `msg ${code}`, evidence, action: 'Do the thing.',
});

describe('cleanupFor', () => {
  it('gives the wrangler command for each kind of leftover', () => {
    expect(cleanupFor(f('zombies', '*', 'unbound-kv-0123456789abcdef0123456789abcdef', { kv: 'cache' }))?.commands)
      .toEqual(['npx wrangler kv namespace delete --namespace-id=0123456789abcdef0123456789abcdef']);
    expect(cleanupFor(f('zombies', '*', 'unbound-d1-uuid', { d1: 'old-db' }))?.commands)
      .toEqual(['npx wrangler d1 export old-db --remote --output=old-db-backup.sql', 'npx wrangler d1 delete old-db']);
    expect(cleanupFor(f('zombies', '*', 'unbound-r2-assets', { r2: 'assets' }))?.commands).toEqual(['npx wrangler r2 bucket delete assets']);
    expect(cleanupFor(f('zombies', '*', 'unbound-queues-q1', { queues: 'jobs' }))?.commands).toEqual(['npx wrangler queues delete jobs']);
    expect(cleanupFor(f('zombies', 'old-api', 'no-traffic'))?.commands).toEqual(['npx wrangler delete --name old-api']);
    expect(cleanupFor(f('zombies', '*', 'orphan-route-r1', { route: 'x/*' }))?.commands).toEqual([]);
    expect(cleanupFor(f('errors', 'api', 'error-rate'))).toBeNull();
  });

  it('gives no command for a name that is not shell-safe', () => {
    expect(cleanupFor(f('zombies', '*', 'unbound-d1-uuid', { d1: 'x; rm -rf ~' }))).toBeNull();
    expect(cleanupFor(f('zombies', '*', 'unbound-r2-b', { r2: '$(curl evil)' }))).toBeNull();
    expect(cleanupFor(f('zombies', '*', 'unbound-kv-not-an-id', { kv: 'cache' }))).toBeNull();
  });
});

describe('findingsMarkdown', () => {
  it('lists findings as a checklist and collects the cleanup commands', () => {
    const md = findingsMarkdown({
      title: 'Housekeeping',
      groups: groupFindings([f('zombies', '*', 'unbound-d1-uuid', { d1: 'old-db' }), f('zombies', '*', 'orphan-route-r1', { route: 'a.com/*' })]),
      account: { id: 'acc1', label: 'Client A' },
      now: new Date('2026-11-10T14:00:00Z'),
    });
    expect(md).toContain('# Ambersight · Housekeeping');
    expect(md).toContain('Account: Client A (`acc1`) · Exported 2026-11-10 14:00 UTC · 2 findings');
    expect(md).toContain('- [ ] **Account**: msg unbound-d1-uuid');
    expect(md).toContain('  - Remove: Delete it in the dashboard');
    expect(md).toContain('```sh\nexport CLOUDFLARE_ACCOUNT_ID=acc1\n');
    expect(md).toContain('npx wrangler d1 delete old-db');
  });

  it('keeps finding text from breaking out of its line or the command block', () => {
    const evil = { ...f('zombies', '*', 'unbound-queues-q', { queues: 'jobs' }), message: 'Queue jobs\n```\nrm -rf ~\n# ok' };
    const md = findingsMarkdown({ title: 'Housekeeping', groups: groupFindings([evil]), account: null });
    const block = md.slice(md.indexOf('```sh'));
    expect(block.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('```'))).toEqual(['npx wrangler queues delete jobs']);
  });
});

describe('cleanup block is safe to paste into a shell', () => {
  it('holds only checked commands, never a KV title from the API', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const evil = { ...f('zombies', '*', `unbound-kv-${id}`, { kv: 'cache $(touch pwned) `id`; rm -rf ~' }), message: 'KV namespace cache $(touch pwned) `id`; rm -rf ~ is not bound to any Worker.' };
    const md = findingsMarkdown({ title: 'Housekeeping', groups: groupFindings([evil]), account: { id: 'acc1', label: 'A' } });
    const block = md.slice(md.indexOf('```sh') + 6, md.lastIndexOf('```'));
    expect(block.trim().split('\n')).toEqual(['export CLOUDFLARE_ACCOUNT_ID=acc1', `npx wrangler kv namespace delete --namespace-id=${id}`]);
    // Outside the block the title is still shown, escaped, for the reader.
    expect(md).toContain('cache $(touch pwned) \\`id\\`; rm -rf ~');
  });
});

describe('plain-language help', () => {
  it('exists for every named check', async () => {
    const { CHECK_TITLES } = await import('../src/shared/findings');
    const { helpFor } = await import('../src/shared/help');
    const missing = [...Object.keys(CHECK_TITLES), 'packages:outdated', 'packages:lockfile-unreadable'].filter((c) => !helpFor(c));
    expect(missing).toEqual([]);
  });

  it('exists for every finding a scan of the test fleet raises', async () => {
    const { vi } = await import('vitest');
    const { fakeFetch, NOW } = await import('./fixtures');
    const { createD1 } = await import('./d1');
    const { upsertAccount } = await import('../src/worker/db');
    const { runScan } = await import('../src/worker/scan');
    const { checkOf } = await import('../src/shared/findings');
    const { helpFor } = await import('../src/shared/help');
    vi.stubGlobal('fetch', fakeFetch({ hourly: [{ scriptName: 'api', datetimeHour: '2026-11-09T11:00:00Z', requests: 1000, errors: 300 }] }).fn);
    const env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery staple' };
    await upsertAccount(env.DB, { id: 'acc1' }, NOW).run();
    await runScan(env, NOW, { account: 'acc1' });
    const { results } = await env.DB.prepare('SELECT module, code FROM findings').all<{ module: Finding['module']; code: string }>();
    expect(results.length).toBeGreaterThan(3);
    expect(results.map(checkOf).filter((c) => !helpFor(c))).toEqual([]);
    vi.unstubAllGlobals();
  });
});
