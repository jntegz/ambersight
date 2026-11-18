// Workers leaving and re-entering the scope: what the scan still knows about them.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type Config } from '../src/shared/config';
import { getAccountState, setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { runScan } from '../src/worker/scan';
import { createD1 } from './d1';
import { fakeFetch, fleet, NOW } from './fixtures';

const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const STAGING = 'api-staging';
const SETTINGS_PATH = `/workers/scripts/${STAGING}/settings`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete fleet.settings[STAGING];
});

async function setup(account: string): Promise<Env> {
  const env: Env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery' };
  await upsertAccount(env.DB, { id: account }, NOW).run();
  return env;
}
function configWith(exclude: string[]): Config {
  const c = defaultConfig();
  c.plan = 'paid';
  c.modules.drift = true;
  c.modules.zombies = true;
  c.scope = { include: [], exclude };
  return c;
}
const useConfig = (env: Env, exclude: string[]) => setSettings(env.DB, { config: JSON.stringify(configWith(exclude)) }).run();
const open = async (env: Env) => (await env.DB.prepare(`SELECT substr(id, length(account) + 2) AS id FROM findings WHERE status = 'open'`).all<{ id: string }>()).results.map((r) => r.id);

describe('a Worker outside the scope', () => {
  it('is not reported as missing by what points at it', async () => {
    vi.stubGlobal('fetch', fakeFetch().fn);
    const env = await setup('acc1');
    await useConfig(env, ['api']);
    await runScan(env, NOW, { account: 'acc1' });
    const ids = await open(env);
    expect(ids).not.toContain('zombies:*:orphan-route-r1');
    expect(ids).toContain('zombies:*:orphan-route-r2');
  });
});

describe('a Worker back in scope after its bindings were trimmed', () => {
  // Same binding names as api, so the two match, and storage only this Worker uses.
  const fleets = {
    acc2: {
      workers: [{ name: 'api', deployed_on: '2026-11-01T10:00:00Z' }, { name: STAGING, deployed_on: '2026-11-01T10:00:00Z' }],
      scripts: [{ id: 'api', has_modules: true, handlers: ['fetch'] }, { id: STAGING, has_modules: true, handlers: ['fetch'] }],
    },
  };
  const mismatch = `drift:api:env-mismatch-${STAGING}`;
  const missing = `zombies:${STAGING}:missing-service-deleted-worker`;
  const stored = async (env: Env) => (await env.DB.prepare('SELECT bindings FROM workers WHERE name = ?1').bind(STAGING).first<{ bindings: string }>())!.bindings;
  const trimmedList = async (env: Env) => (await getAccountState(env.DB, 'acc2')).trimmed_bindings;

  function stub(failSettings = false) {
    const f = fakeFetch({ fleets });
    vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) =>
      failSettings && String(input).includes(SETTINGS_PATH)
        ? (f.calls.push(`GET ${SETTINGS_PATH}`), Promise.resolve(new Response(JSON.stringify({ success: false, errors: [{ message: 'unavailable' }] }), { status: 403 })))
        : f.fn(input, init)) as typeof fetch);
    return f;
  }

  async function trimmedThenBack() {
    fleet.settings[STAGING] = { bindings: [{ type: 'kv_namespace', name: 'CACHE', namespace_id: 'ns-sites' }, { type: 'service', name: 'AUTH', service: 'deleted-worker' }] };
    const env = await setup('acc2');
    await useConfig(env, []);
    stub();
    await runScan(env, at(0), { account: 'acc2' });
    expect(await open(env)).toContain(missing);
    await useConfig(env, [STAGING]);
    stub();
    await runScan(env, at(7), { account: 'acc2' }); // its detail read is due, and trims what is stored
    expect(await stored(env)).not.toContain('deleted-worker');
    expect(await trimmedList(env)).toBe(JSON.stringify([STAGING]));
    await useConfig(env, []);
    return env;
  }

  it('is read again on the next scan, however recently it was read', async () => {
    const env = await trimmedThenBack();
    const f = stub();
    await runScan(env, at(8), { account: 'acc2' });
    expect(f.calls.some((c) => c.includes(SETTINGS_PATH))).toBe(true);
    expect(await stored(env)).toContain('deleted-worker');
    expect(await trimmedList(env)).toBe('[]');
    const ids = await open(env);
    expect(ids).toContain(missing);
    expect(ids).not.toContain(mismatch);
  });

  it('draws no conclusion from the partial list until that read succeeds', async () => {
    const env = await trimmedThenBack();
    const f = stub(true);
    await runScan(env, at(8), { account: 'acc2' });
    expect(f.calls.some((c) => c.includes(SETTINGS_PATH))).toBe(true);
    let ids = await open(env);
    expect(ids).not.toContain(mismatch);
    expect(ids).not.toContain(missing);
    // What it binds still counts: its storage is not called unused meanwhile.
    expect(ids).not.toContain('zombies:*:unbound-kv-ns-sites');
    expect(await trimmedList(env)).toBe(JSON.stringify([STAGING]));

    stub();
    await runScan(env, at(9), { account: 'acc2' });
    ids = await open(env);
    expect(ids).toContain(missing);
    expect(ids).not.toContain(mismatch);
    expect(await trimmedList(env)).toBe('[]');
  });
});
