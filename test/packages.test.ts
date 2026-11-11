// The optional Packages check: lockfile parsing, version gaps, config validation, the scan step
// (budget, caching, token handling) and the findings.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, parseConfig } from '../src/shared/config';
import { setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { buildPackages, lockfileUrl, LockfileError, npmLatest, parseLockfile, semverGap } from '../src/worker/packages';
import { runScan } from '../src/worker/scan';
import { createD1 } from './d1';
import { fakeFetch, NOW, type FakeOptions } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

const lock = (deps: Record<string, string>, dev: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: Object.fromEntries(Object.keys(deps).map((n) => [n, '^1'])), devDependencies: Object.fromEntries(Object.keys(dev).map((n) => [n, '^1'])) },
      ...Object.fromEntries(Object.entries({ ...deps, ...dev }).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` }])),
      ...extra,
    },
  }, null, 2);

describe('parseLockfile', () => {
  it('reads direct dependencies with their top-level locked versions', () => {
    const text = lock({ hono: '4.6.0', '@scope/util': '1.0.0' }, { wrangler: '3.80.0' }, {
      // A nested copy of hono must not win over the top-level one.
      'node_modules/other/node_modules/hono': { version: '3.0.0' },
      'node_modules/hono-extra': { version: '9.9.9' },
    });
    expect(parseLockfile(text)).toEqual([
      { name: '@scope/util', locked: '1.0.0', dev: false },
      { name: 'hono', locked: '4.6.0', dev: false },
      { name: 'wrangler', locked: '3.80.0', dev: true },
    ]);
  });

  it('rejects lockfile v1 and files without a root entry', () => {
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toThrow(LockfileError);
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: {} }))).toThrow(LockfileError);
    expect(() => parseLockfile('not json')).toThrow(LockfileError);
  });

  it('skips names that are not valid npm names and versions that are not semver', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { '../evil': '1', ok: '1', linked: '1' } }, 'node_modules/ok': { version: '1.2.3' }, 'node_modules/linked': { link: true, resolved: 'packages/linked' } },
    });
    expect(parseLockfile(text)).toEqual([{ name: 'ok', locked: '1.2.3', dev: false }]);
  });
});

describe('semverGap', () => {
  it('compares major, minor and patch', () => {
    expect(semverGap('3.80.0', '4.1.0')).toBe('major');
    expect(semverGap('4.0.0', '4.1.0')).toBe('minor');
    expect(semverGap('4.1.0', '4.1.2')).toBe('patch');
    expect(semverGap('4.1.2', '4.1.2')).toBe('none');
    expect(semverGap('5.0.0-beta.1', '4.1.2')).toBe('none');
    expect(semverGap('4.1.2', null)).toBe('unknown');
  });
});

describe('config', () => {
  it('accepts a repo mapping and rejects anything that could change the GitHub URL', () => {
    const c = parseConfig({ version: 1, packageRepos: { api: { repo: 'acme/api', dir: 'workers/api', ref: 'release/1.x' } } });
    expect(c.packageRepos.api).toEqual({ repo: 'acme/api', dir: 'workers/api', ref: 'release/1.x' });
    expect(c.modules.packages).toBe(false);
    for (const bad of [
      { repo: 'acme' }, { repo: 'acme/api/x' }, { repo: '../api' }, { repo: 'acme/..' },
      { repo: 'acme/api', dir: '../secrets' }, { repo: 'acme/api', dir: '/abs' }, { repo: 'acme/api', dir: 'a//b' },
      { repo: 'acme/api', ref: 'main?x=1' }, { repo: 'acme/api', ref: 'a/../b' }, { repo: 'acme/api', dir: 'a%2f..' },
    ]) {
      expect(() => parseConfig({ version: 1, packageRepos: { api: bad } }), JSON.stringify(bad)).toThrow(ConfigError);
    }
    expect(() => parseConfig({ version: 1, packageRepos: { 'a b': { repo: 'acme/api' } } })).toThrow(ConfigError);
  });

  it('maps a Worker per account, with a name-only key as the fallback for every account', async () => {
    const { repoFor } = await import('../src/shared/config');
    const c = parseConfig({ version: 1, packageRepos: { 'acc1:api': { repo: 'acme/api' }, 'acc2:api': { repo: 'other/api' }, web: { repo: 'acme/web' } } });
    expect(repoFor(c, 'acc1', 'api')?.repo).toBe('acme/api');
    expect(repoFor(c, 'acc2', 'api')?.repo).toBe('other/api');
    expect(repoFor(c, 'acc3', 'api')).toBeUndefined();
    expect(repoFor(c, 'acc2', 'web')?.repo).toBe('acme/web');
    expect(() => parseConfig({ version: 1, packageRepos: { 'acc1:a:b': { repo: 'acme/api' } } })).toThrow(ConfigError);
  });

  it('builds the contents URL with every part encoded', () => {
    expect(lockfileUrl({ repo: 'acme/api', dir: 'workers/api', ref: 'release/1.x' })).toBe(
      'https://api.github.com/repos/acme/api/contents/workers/api/package-lock.json?ref=release%2F1.x',
    );
  });
});

describe('npmLatest', () => {
  it('encodes scoped names and sends no credentials', async () => {
    const f = fakeFetch({ npm: { '@cloudflare/workers-types': '5.1.0' } });
    vi.stubGlobal('fetch', f.fn);
    expect(await npmLatest('@cloudflare/workers-types')).toBe('5.1.0');
    expect(f.calls).toEqual(['GET registry.npmjs.org/@cloudflare%2Fworkers-types/latest']);
    expect(f.auth).toEqual([]);
    expect(await npmLatest('../../etc')).toBeNull();
  });
});

const newEnv = (token?: string): Env => ({ DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: 'correct horse battery staple', ...(token ? { GITHUB_TOKEN: token } : {}) });

async function setup(opts: { token?: string; on?: boolean; repos?: Record<string, unknown>; plan?: 'free' | 'paid' } = {}) {
  const e = newEnv(opts.token ?? 'ghtok');
  await e.DB.batch([
    upsertAccount(e.DB, { id: 'acc1' }, NOW),
    setSettings(e.DB, {
      config: JSON.stringify({
        version: 1,
        plan: opts.plan ?? 'paid',
        modules: { packages: opts.on ?? true },
        packageRepos: opts.repos ?? { api: { repo: 'acme/api' }, 'cron-job': { repo: 'acme/jobs', dir: 'cron' } },
      }),
    }),
  ]);
  return e;
}
function stub(opts: FakeOptions) {
  const f = fakeFetch(opts);
  vi.stubGlobal('fetch', f.fn);
  return f;
}
const LOCKS = {
  'acme/api/package-lock.json': lock({ hono: '3.12.0', zod: '3.23.8' }, { wrangler: '4.10.0' }),
  'acme/jobs/cron/package-lock.json': lock({ zod: '3.22.0' }),
};
const NPM = { hono: '4.6.0', zod: '3.23.8', wrangler: '4.12.0' };

describe('scan with the Packages check', () => {
  it('reads lockfiles and latest versions, raises one finding per Worker, and shows them on the page', async () => {
    const f = stub({ lockfiles: LOCKS, npm: NPM });
    const e = await setup();
    await runScan(e, NOW, { account: 'acc1' });

    // Each package is looked up once, even when two Workers use it.
    expect(f.calls.filter((c) => c.includes('registry.npmjs.org')).sort()).toEqual([
      'GET registry.npmjs.org/hono/latest', 'GET registry.npmjs.org/wrangler/latest', 'GET registry.npmjs.org/zod/latest',
    ]);
    // The GitHub token goes to GitHub's contents API only, never to Cloudflare or npm.
    expect(f.auth.filter((a) => a.includes('ghtok'))).toEqual(['api.github.com Bearer ghtok', 'api.github.com Bearer ghtok']);
    expect(f.auth.filter((a) => !a.startsWith('api.github.com')).every((a) => !a.includes('ghtok'))).toBe(true);

    const { results } = await e.DB.prepare(`SELECT script, severity, message FROM findings WHERE module = 'packages' AND status = 'open' ORDER BY script`).all<{ script: string; severity: string; message: string }>();
    expect(results.map((r) => [r.script, r.severity])).toEqual([['api', 'warning'], ['cron-job', 'info']]);
    expect(results[0].message).toContain('hono 3.12.0 → 4.6.0');

    const view = await buildPackages(e.DB, 'acc1', parseConfig(JSON.parse((await e.DB.prepare(`SELECT value FROM settings WHERE key = 'config'`).first<{ value: string }>())!.value)), true);
    expect(view.workers.map((w) => w.name)).toEqual(['api', 'cron-job']);
    expect(view.workers[0].packages).toEqual([
      { name: 'hono', locked: '3.12.0', latest: '4.6.0', gap: 'major', dev: false },
      { name: 'wrangler', locked: '4.10.0', latest: '4.12.0', gap: 'minor', dev: true },
      { name: 'zod', locked: '3.23.8', latest: '3.23.8', gap: 'none', dev: false },
    ]);
  });

  it('reads each lockfile and npm version once a day, not every scan', async () => {
    stub({ lockfiles: LOCKS, npm: NPM });
    const e = await setup();
    await runScan(e, NOW, { account: 'acc1' });
    const f = stub({ lockfiles: LOCKS, npm: NPM });
    await runScan(e, new Date(NOW.getTime() + 3_600_000), { account: 'acc1' });
    expect(f.calls.filter((c) => c.includes('/contents/') || c.includes('registry.npmjs.org'))).toEqual([]);
  });

  it('turns a missing lockfile into a warning finding, and fixes it once the file is there', async () => {
    stub({ lockfiles: { 'acme/api/package-lock.json': 404 }, npm: NPM });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });
    const open = await e.DB.prepare(`SELECT code, severity, message FROM findings WHERE module = 'packages' AND status = 'open'`).all<{ code: string; severity: string; message: string }>();
    expect(open.results).toHaveLength(1);
    expect(open.results[0]).toMatchObject({ code: 'lockfile-unreadable', severity: 'warning' });
    expect(open.results[0].message).not.toContain('ghtok');

    stub({ lockfiles: LOCKS, npm: NPM });
    await runScan(e, new Date(NOW.getTime() + 25 * 3_600_000), { account: 'acc1' });
    const after = await e.DB.prepare(`SELECT code FROM findings WHERE module = 'packages' AND status = 'open'`).all<{ code: string }>();
    expect(after.results.map((r) => r.code)).toEqual(['outdated']);
  });

  it('treats a GitHub redirect as an error instead of following it with the token', async () => {
    stub({ lockfiles: { 'acme/api/package-lock.json': 301 } });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });
    const row = await e.DB.prepare(`SELECT packages_error FROM workers WHERE account = 'acc1' AND name = 'api'`).first<{ packages_error: string }>();
    expect(row?.packages_error).toContain('has moved');
  });

  it('contacts neither GitHub nor npm when the module is off or there is no token', async () => {
    for (const s of [{ on: false }, { token: '' }]) {
      const f = stub({ lockfiles: LOCKS, npm: NPM });
      const e = await setup(s);
      const r = await runScan(e, NOW, { account: 'acc1' });
      expect(f.calls.filter((c) => c.includes('/contents/') || c.includes('registry.npmjs.org'))).toEqual([]);
      if (s.token === '') expect(r.warnings.join(' ')).toContain('GITHUB_TOKEN is not set');
    }
  });

  it('stays inside the Free plan subrequest budget', async () => {
    const repos = Object.fromEntries(['api', 'cron-job', 'legacy', 'draft'].map((n) => [n, { repo: `acme/${n}` }]));
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`dep${i}`, '1.0.0']));
    const lockfiles = Object.fromEntries(Object.keys(repos).map((n) => [`acme/${n}/package-lock.json`, lock(many)]));
    stub({ lockfiles, npm: Object.fromEntries(Object.keys(many).map((n) => [n, '1.0.0'])) });
    const e = await setup({ repos, plan: 'free' });
    const r = await runScan(e, NOW, { account: 'acc1' });
    expect(r.subrequests).toBeLessThanOrEqual(42);
  });
});
