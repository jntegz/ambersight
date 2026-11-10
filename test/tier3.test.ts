// Tier 3: the scan queue, the richer digest (monthly, client digests, AI summary), the client
// report, Turnstile on sign-in, and nodejs_compat as a redundant flag.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, parseConfig } from '../src/shared/config';
import { verifyTurnstile } from '../src/worker/auth';
import { setAccountState, setSettings, upsertAccount } from '../src/worker/db';
import { aiSummary, digestData, renderDigest } from '../src/worker/digest';
import type { Env, ScanMessage } from '../src/worker/env';
import { deprecationFindings } from '../src/worker/hygiene';
import { reportHtml, reportPdf } from '../src/worker/report';
import { handleQueueMessage, MAX_CONTINUATIONS, scheduledRun } from '../src/worker/scheduler';
import { runScan } from '../src/worker/scan';
import { digestDue } from '../src/worker/time';
import { createD1 } from './d1';
import { fakeFetch, NOW } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

const fakeQueue = () => {
  const sent: ScanMessage[] = [];
  const q = {
    send: async (m: ScanMessage) => void sent.push(m),
    sendBatch: async (ms: { body: ScanMessage }[]) => void sent.push(...ms.map((m) => m.body)),
  } as unknown as Queue<ScanMessage>;
  return { q, sent };
};
const newEnv = (over: Partial<Env> = {}): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery', ...over });
const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }));

describe('scan queue', () => {
  it('queues every due account at once instead of one per cron tick', async () => {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const { q, sent } = fakeQueue();
    const e = newEnv({ SCAN_QUEUE: q });
    await e.DB.batch([setSettings(e.DB, { setup_done: '1' }), upsertAccount(e.DB, { id: 'acc1' }, NOW), upsertAccount(e.DB, { id: 'acc2' }, NOW)]);
    expect(await scheduledRun(e, NOW)).toEqual({ queued: ['acc1', 'acc2'] });
    expect(sent.map((m) => m.account)).toEqual(['acc1', 'acc2']);
    // Marked as attempted: the next tick does not queue them again while they wait.
    expect(await scheduledRun(e, new Date(NOW.getTime() + 15 * 60_000))).toBeNull();
  });

  it('continues a scan that ran out of budget in a new message, up to a limit', async () => {
    const zones = Array.from({ length: 30 }, (_, i) => ({ id: `z${i}`, name: `s${i}.com` }));
    const base = fakeFetch();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = new URL(String(input instanceof Request ? input.url : input)).pathname.replace('/client/v4', '');
      if (p === '/zones') return ok(zones);
      if (/^\/zones\/z\d+\//.test(p)) return ok([]);
      return base.fn(input, init);
    });
    const { q, sent } = fakeQueue();
    const e = newEnv({ SCAN_QUEUE: q });
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    const r = await handleQueueMessage(e, { kind: 'scan', account: 'acc1' }, NOW);
    expect('error' in r).toBe(false);
    expect(sent).toEqual([{ kind: 'continue', account: 'acc1', step: 1 }]);
    sent.length = 0;
    await handleQueueMessage(e, { kind: 'continue', account: 'acc1', step: MAX_CONTINUATIONS }, new Date(NOW.getTime() + 60_000));
    expect(sent).toEqual([]);
  });

  it('drops messages for accounts that are no longer watched', async () => {
    const { q, sent } = fakeQueue();
    const e = newEnv({ SCAN_QUEUE: q });
    await upsertAccount(e.DB, { id: 'acc1', enabled: false }, NOW).run();
    expect(await handleQueueMessage(e, { kind: 'scan', account: 'acc1' }, NOW)).toEqual({ error: 'Account is no longer watched.' });
    expect(sent).toEqual([]);
  });
});

describe('digest', () => {
  it('sends the monthly digest on the 1st only', () => {
    expect(digestDue(new Date('2026-12-01T09:00:00Z'), 'UTC', 'monthly', 1, 8, null)).toBe(true);
    expect(digestDue(new Date('2026-12-02T09:00:00Z'), 'UTC', 'monthly', 1, 8, null)).toBe(false);
    expect(digestDue(new Date('2026-12-01T09:00:00Z'), 'UTC', 'monthly', 1, 8, '2026-12-01T08:30:00Z')).toBe(false);
    expect(parseConfig({ version: 1, digest: { frequency: 'monthly' } }).digest.frequency).toBe('monthly');
  });

  it('includes free limit headroom and the biggest traffic changes', async () => {
    const e = newEnv();
    await upsertAccount(e.DB, { id: 'acc1', name: 'Main' }, NOW).run();
    await e.DB.batch([
      e.DB.prepare(`INSERT INTO quota_hourly (account, metric, hour, value) VALUES ('acc1', 'kv.write', '2026-11-08T10:00:00Z', 900)`),
      e.DB.prepare(`INSERT INTO metrics_hourly (account, script, hour, requests) VALUES ('acc1', 'api', '2026-11-08T10:00:00Z', 9000), ('acc1', 'api', '2026-10-30T10:00:00Z', 1000)`),
    ]);
    const [d] = await digestData(e, NOW, defaultConfig(), 7);
    expect(d.headroom).toEqual([{ label: 'KV writes', peak: 0.9 }]);
    expect(d.movers).toEqual([{ name: 'api', now: 9000, before: 1000 }]);
    const { text, html } = renderDigest('t', 'i', [d], { periodLabel: 'This week' });
    expect(text).toContain('KV writes: 90%');
    expect(text).toContain('api: 9,000 requests, 9.0x up');
    expect(html).toContain('Biggest changes in traffic');
  });

  it('sends a client its own account\'s digest, only to addresses in DIGEST_TO', async () => {
    vi.stubGlobal('fetch', fakeFetch({ fleets: { acc2: { workers: [], scripts: [] } } }).fn);
    const sent: { to: string | string[]; subject: string }[] = [];
    const e = newEnv({ EMAIL_FROM: 'a@example.com', DIGEST_TO: 'me@example.com, client@example.com', EMAIL: { send: async (m) => void sent.push(m) } });
    const config = defaultConfig();
    config.digest = { ...config.digest, frequency: 'daily', hour: 0 };
    config.alerts.critical.instant = 'off';
    config.accounts = { acc1: { label: 'Client A', digestTo: ['client@example.com', 'stranger@example.com'] } };
    await e.DB.batch([upsertAccount(e.DB, { id: 'acc1' }, NOW), upsertAccount(e.DB, { id: 'acc2', name: 'Other' }, NOW), setSettings(e.DB, { config: JSON.stringify(config) })]);
    // The scan sends the digest that is due, with the saved config.
    await runScan(e, NOW, { account: 'acc1' });
    const client = sent.find((m) => m.subject.startsWith('Ambersight · Client A'));
    expect(client?.to).toEqual(['client@example.com']);
    expect(sent.some((m) => m.subject.startsWith('Ambersight: '))).toBe(true);
  });

  it('adds a plain-language summary from Workers AI when switched on, and skips it on failure', async () => {
    const e = newEnv({ AI: { run: async () => ({ response: 'Fix the public preview URLs on api first — then the cron.' }) } });
    const config = defaultConfig();
    const d = [{ id: 'a', label: 'A', plan: 'free' as const, rows: [{ id: '1', script: 'api', severity: 'critical' as const, message: 'Preview URLs are public', action: 'x' }], requests: 0, errors: 0, added: [], removed: [], deploys: [], headroom: [], movers: [], cost: null, cfAlerts: 0, tags: new Map() }];
    expect(await aiSummary(e, config, d)).toBeNull(); // off by default
    config.digest.aiSummary = true;
    expect(await aiSummary(e, config, d)).toBe('Fix the public preview URLs on api first , then the cron.');
    expect(await aiSummary(newEnv({ AI: { run: async () => { throw new Error('quota'); } } }), config, d)).toBeNull();
    expect(await aiSummary(newEnv(), config, d)).toBeNull(); // no binding
  });
});

describe('client report', () => {
  it('renders one account as self-contained HTML', async () => {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const e = newEnv();
    await upsertAccount(e.DB, { id: 'acc1', name: 'Test account' }, NOW).run();
    await runScan(e, NOW, { account: 'acc1' });
    const { html, title } = await reportHtml(e, 'acc1', 30, NOW);
    expect(title).toBe('Test account 2026-11-09');
    expect(html).toContain('Report for 2026-10-10 to 2026-11-09.');
    expect(html).toContain('Last 30 days');
    expect(html).not.toContain('<script');
  });
  it('needs the Browser Rendering binding for a PDF', async () => {
    await expect(reportPdf(newEnv(), '<p>x</p>')).rejects.toThrow(/Browser Rendering/);
  });
});

describe('Turnstile on sign-in', () => {
  it('is skipped when not configured, and checks the token with siteverify when it is', async () => {
    expect(await verifyTurnstile(newEnv(), undefined, '1.2.3.4')).toBe(true);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      const token = (init?.body as FormData).get('response');
      return new Response(JSON.stringify({ success: token === 'good' }));
    });
    const e = newEnv({ TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET: 'secret' });
    expect(await verifyTurnstile(e, 'good', '1.2.3.4')).toBe(true);
    expect(await verifyTurnstile(e, 'bad', '1.2.3.4')).toBe(false);
    expect(await verifyTurnstile(e, undefined, '1.2.3.4')).toBe(false);
    expect(calls).toEqual(['https://challenges.cloudflare.com/turnstile/v0/siteverify', 'https://challenges.cloudflare.com/turnstile/v0/siteverify']);
  });
});

describe('redundant compatibility flags', () => {
  it('flags nodejs_compat from the 2026-08-04 compatibility date, when it became the default', () => {
    const meta = (date: string) => ({ name: 'api', groups: [], handlers: ['fetch'], hasModules: true, compatibilityDate: date, compatibilityFlags: ['nodejs_compat'], usageModel: 'standard', bindings: [], workersDev: false, previewsEnabled: false, logsEnabled: false, samplingRate: 1, logpush: false, deployedOn: null, listed: true, deployments: [] });
    const tf = () => defaultConfig().thresholds;
    expect(deprecationFindings(NOW, [meta('2026-09-01')], tf).map((f) => f.code)).toEqual(['redundant-flags']);
    expect(deprecationFindings(NOW, [meta('2026-07-01')], tf)).toEqual([]);
  });
});

describe('scan cost with every module on', () => {
  it('stays within 42 subrequests on Free', async () => {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const e = newEnv();
    await upsertAccount(e.DB, { id: 'acc1' }, NOW).run();
    const config = defaultConfig();
    config.modules.access = true;
    config.modules.incidents = true;
    await setSettings(e.DB, { config: JSON.stringify(config) }).run();
    await setAccountState(e.DB, 'acc1', {}).run();
    const r = await runScan(e, NOW, { account: 'acc1' });
    expect(r.subrequests).toBeLessThanOrEqual(42);
    expect(r.d1Queries).toBeLessThan(50);
  });
});
