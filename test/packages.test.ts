// The optional Packages check: lockfile parsing, version gaps, config validation, the scan step
// (budget, caching, token handling) and the findings.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, parseConfig } from '../src/shared/config';
import { buildWorkerDetail } from '../src/worker/analytics';
import { setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import { buildPackages, fetchOsvBatch, listGithubRepos, lockfileUrl, LockfileError, npmLatest, parseBunLock, parseLockfile, parsePnpmLock, parseYarnLock, REPO_NOT_ALLOWED, repoAllowed, repoAllowlist, semverGap } from '../src/worker/packages';
import { runScan } from '../src/worker/scan';
import { plainWorker } from '../src/worker/tokenView';
import { createD1 } from './d1';
import { fakeFetch, NOW, type FakeOptions } from './fixtures';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

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
      { name: '@scope/util', locked: '1.0.0', dev: false, source: 'registry' },
      { name: 'hono', locked: '4.6.0', dev: false, source: 'registry' },
      { name: 'wrangler', locked: '3.80.0', dev: true, source: 'registry' },
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
    expect(parseLockfile(text)).toEqual([{ name: 'ok', locked: '1.2.3', dev: false, source: 'other' }]);
  });

  it('counts a package as from the registry only when its own tarball there is what was locked', () => {
    const entry = (name: string, resolved?: string) => ({ [`node_modules/${name}`]: { version: '1.0.0', ...(resolved ? { resolved } : {}) } });
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: Object.fromEntries(['pub', '@acme/pub', '@acme/enc', 'corp', 'git', 'alias', 'none', 'look', 'plain'].map((n) => [n, '1'])) },
        ...entry('pub', 'https://registry.npmjs.org/pub/-/pub-1.0.0.tgz'),
        ...entry('@acme/pub', 'https://registry.npmjs.org/@acme/pub/-/pub-1.0.0.tgz'),
        ...entry('@acme/enc', 'https://registry.npmjs.org/@acme%2fenc/-/enc-1.0.0.tgz'),
        ...entry('corp', 'https://npm.corp.example/corp/-/corp-1.0.0.tgz'),
        ...entry('git', 'git+ssh://git@github.com/acme/git.git#abc'),
        // Installed under another name: the name in the lockfile is not what was published.
        ...entry('alias', 'https://registry.npmjs.org/other/-/other-1.0.0.tgz'),
        ...entry('none'),
        ...entry('look', 'https://registry.npmjs.org.evil.example/look/-/look-1.0.0.tgz'),
        ...entry('plain', 'http://registry.npmjs.org/plain/-/plain-1.0.0.tgz'),
      },
    });
    expect(Object.fromEntries(parseLockfile(text).map((d) => [d.name, d.source]))).toEqual({
      pub: 'registry', '@acme/pub': 'registry', '@acme/enc': 'registry', corp: 'other', git: 'other', alias: 'other', none: 'other', look: 'other', plain: 'other',
    });
  });

  it('reads the entry\'s own version and source, not a dependency that has the same name', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { dep: '1' } },
        'node_modules/dep': { dependencies: { version: '9.9.9', resolved: 'https://registry.npmjs.org/dep/-/dep-9.9.9.tgz' }, version: '1.0.0', resolved: 'https://npm.corp.example/dep.tgz' },
      },
    });
    expect(parseLockfile(text)).toEqual([{ name: 'dep', locked: '1.0.0', dev: false, source: 'other' }]);
  });
});

describe('GITHUB_REPO_ALLOWLIST', () => {
  it('is off when unset and matches owners or whole repositories, ignoring case', () => {
    expect(repoAllowlist(undefined)).toBeNull();
    expect(repoAllowlist('  ')).toBeNull();
    expect(repoAllowed(null, 'any/repo')).toBe(true);
    const list = repoAllowlist('Acme, other/One');
    expect(repoAllowed(list, 'acme/api')).toBe(true);
    expect(repoAllowed(list, 'ACME/web')).toBe(true);
    expect(repoAllowed(list, 'other/one')).toBe(true);
    expect(repoAllowed(list, 'other/two')).toBe(false);
    expect(repoAllowed(list, 'acmex/api')).toBe(false);
    // Set but holding no usable entry: nothing is allowed, rather than everything.
    expect(repoAllowed(repoAllowlist(','), 'acme/api')).toBe(false);
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

async function setup(opts: { token?: string; on?: boolean; osv?: boolean; repos?: Record<string, unknown>; plan?: 'free' | 'paid' } = {}) {
  const e = newEnv(opts.token ?? 'ghtok');
  await e.DB.batch([
    upsertAccount(e.DB, { id: 'acc1' }, NOW),
    setSettings(e.DB, {
      config: JSON.stringify({
        version: 1,
        plan: opts.plan ?? 'paid',
        modules: { packages: opts.on ?? true, packagesOsv: opts.osv ?? false },
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
      { name: 'hono', locked: '3.12.0', latest: '4.6.0', gap: 'major', dev: false, compared: true },
      { name: 'wrangler', locked: '4.10.0', latest: '4.12.0', gap: 'minor', dev: true, compared: true },
      { name: 'zod', locked: '3.23.8', latest: '3.23.8', gap: 'none', dev: false, compared: true },
    ]);
  });

  const configOf = async (e: Env) => parseConfig(JSON.parse((await e.DB.prepare(`SELECT value FROM settings WHERE key = 'config'`).first<{ value: string }>())!.value));
  const mixed = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { hono: '1', '@acme/internal': '1', 'internal-tool': '1' } },
      'node_modules/hono': { version: '3.12.0', resolved: 'https://registry.npmjs.org/hono/-/hono-3.12.0.tgz' },
      'node_modules/@acme/internal': { version: '1.0.0', resolved: 'https://npm.acme.example/@acme/internal/-/internal-1.0.0.tgz' },
      'node_modules/internal-tool': { version: '1.0.0' },
    },
  });

  it('sends only packages from the public registry to it, and gives the others no advice', async () => {
    // Someone has published a higher version under both private names.
    const f = stub({ lockfiles: { 'acme/api/package-lock.json': mixed }, npm: { hono: '4.6.0', '@acme/internal': '99.0.0', 'internal-tool': '99.0.0' } });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });
    expect(f.calls.filter((c) => c.includes('registry.npmjs.org'))).toEqual(['GET registry.npmjs.org/hono/latest']);
    const row = await e.DB.prepare(`SELECT message, evidence FROM findings WHERE module = 'packages' AND status = 'open'`).first<{ message: string; evidence: string }>();
    expect(row!.message).toContain('1 of 1 direct dependencies');
    expect(row!.message).not.toContain('internal');
    const view = await buildPackages(e.DB, 'acc1', await configOf(e), true);
    expect(view.workers[0].packages.map((p) => [p.name, p.compared, p.latest, p.gap])).toEqual([
      ['@acme/internal', false, null, 'unknown'], ['hono', true, '4.6.0', 'major'], ['internal-tool', false, null, 'unknown'],
    ]);
  });

  it('keeps findings on rows from before the source was stored, without sending their names anywhere', async () => {
    stub({ lockfiles: LOCKS, npm: NPM });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });
    const finding = () => e.DB.prepare(`SELECT status, reopen_count AS reopened FROM findings WHERE code = 'outdated'`).first<{ status: string; reopened: number }>();
    await e.DB.prepare(`UPDATE findings SET status = 'acknowledged' WHERE code = 'outdated'`).run();
    await e.DB.batch([
      e.DB.prepare('UPDATE worker_packages SET source = NULL'),
      // The state after the upgrade, with versions an older scan stored going stale.
      e.DB.prepare(`UPDATE npm_latest SET checked_at = '2026-01-01T00:00:00Z'`),
      // The daily refresh, which clears registry answers nothing uses, runs in the next scan too.
      e.DB.prepare(`DELETE FROM account_state WHERE key = 'inventory_at'`),
    ]);
    const f = stub({ lockfiles: LOCKS, npm: NPM });
    await runScan(e, new Date(NOW.getTime() + 3_600_000), { account: 'acc1' });
    // Not read again yet: nothing is looked up, and the finding and its acknowledgement stay.
    expect(f.calls.filter((c) => c.includes('registry.npmjs.org'))).toEqual([]);
    expect(await finding()).toEqual({ status: 'acknowledged', reopened: 0 });
    expect((await e.DB.prepare('SELECT COUNT(*) AS n FROM npm_latest').first<{ n: number }>())!.n).toBe(3);
    // The page agrees with the finding.
    const packages = (await buildPackages(e.DB, 'acc1', await configOf(e), true)).workers[0].packages;
    expect(packages.find((p) => p.name === 'hono')).toMatchObject({ compared: true, latest: '4.6.0', gap: 'major' });
    // The next read settles where each package came from, and lookups resume.
    const again = stub({ lockfiles: LOCKS, npm: NPM });
    await runScan(e, new Date(NOW.getTime() + 25 * 3_600_000), { account: 'acc1' });
    expect(again.calls.some((c) => c.includes('registry.npmjs.org/hono'))).toBe(true);
    expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM worker_packages WHERE source IS NULL`).first<{ n: number }>())!.n).toBe(0);
    expect(await finding()).toEqual({ status: 'acknowledged', reopened: 0 });
  });

  it('stops comparing a row with no source once its lockfile shows it came from elsewhere', async () => {
    stub({ lockfiles: { 'acme/api/package-lock.json': mixed }, npm: { hono: '4.6.0' } });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });
    // An older version looked this private name up.
    await e.DB.batch([
      e.DB.prepare(`INSERT INTO npm_latest (name, latest, checked_at) VALUES ('internal-tool', '99.0.0', '2026-11-09T00:00:00Z')`),
      e.DB.prepare(`UPDATE worker_packages SET source = NULL WHERE name = 'hono'`),
      e.DB.prepare(`DELETE FROM account_state WHERE key = 'inventory_at'`),
    ]);
    stub({ lockfiles: { 'acme/api/package-lock.json': mixed }, npm: { hono: '4.6.0' } });
    await runScan(e, new Date(NOW.getTime() + 3_600_000), { account: 'acc1' });
    const names = (await e.DB.prepare('SELECT name FROM npm_latest ORDER BY name').all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toEqual(['hono']);
  });

  it('reads a Worker\'s lockfile as soon as it is back in scope', async () => {
    stub({ lockfiles: LOCKS, npm: NPM });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    const c = await configOf(e);
    await runScan(e, NOW, { account: 'acc1' });
    await e.DB.batch([
      setSettings(e.DB, { config: JSON.stringify({ ...c, scope: { include: [], exclude: ['api'] } }) }),
      e.DB.prepare(`DELETE FROM account_state WHERE key = 'inventory_at'`),
    ]);
    await runScan(e, new Date(NOW.getTime() + 3_600_000), { account: 'acc1' });
    expect((await e.DB.prepare('SELECT COUNT(*) AS n FROM worker_packages').first<{ n: number }>())!.n).toBe(0);
    expect(await e.DB.prepare(`SELECT packages_checked_at AS at FROM workers WHERE name = 'api'`).first()).toEqual({ at: null });
    await setSettings(e.DB, { config: JSON.stringify(c) }).run();
    const back = stub({ lockfiles: LOCKS, npm: NPM });
    await runScan(e, new Date(NOW.getTime() + 2 * 3_600_000), { account: 'acc1' });
    expect(back.calls).toContain('GET api.github.com/repos/acme/api/contents/package-lock.json');
    expect((await e.DB.prepare('SELECT COUNT(*) AS n FROM worker_packages').first<{ n: number }>())!.n).toBeGreaterThan(0);
  });

  it('migration 0016 makes the next scan read the lockfiles again', async () => {
    const db = createD1({ stopBefore: '0016' });
    await db.batch([
      db.prepare(`INSERT INTO workers (account, name, last_seen, packages_checked_at) VALUES ('acc1', 'api', 'x', '2026-11-09T00:00:00Z')`),
      db.prepare(`INSERT INTO worker_packages (account, script, name, locked) VALUES ('acc1', 'api', 'hono', '1.0.0')`),
    ]);
    (db as unknown as { migrateFrom: (f: string) => void }).migrateFrom('0016');
    expect(await db.prepare('SELECT source FROM worker_packages').first()).toEqual({ source: null });
    expect(await db.prepare('SELECT packages_checked_at AS at FROM workers').first()).toEqual({ at: null });
  });

  it('reads only repositories on GITHUB_REPO_ALLOWLIST, and drops what it read before from the others', async () => {
    stub({ lockfiles: LOCKS, npm: NPM });
    const e = await setup();
    await runScan(e, NOW, { account: 'acc1' });
    const f = stub({ lockfiles: LOCKS, npm: NPM });
    const limited = { ...e, GITHUB_REPO_ALLOWLIST: 'acme/jobs' };
    await runScan(limited, new Date(NOW.getTime() + 3_600_000), { account: 'acc1' });
    expect(f.calls.filter((c) => c.includes('/contents/'))).toEqual([]);
    const view = await buildPackages(e.DB, 'acc1', await configOf(e), true, repoAllowlist('acme/jobs'));
    expect(view.workers.find((w) => w.name === 'api')).toMatchObject({ error: REPO_NOT_ALLOWED, packages: [] });
    expect(view.workers.find((w) => w.name === 'cron-job')!.packages.length).toBeGreaterThan(0);
    expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM worker_packages WHERE script = 'api'`).first<{ n: number }>())!.n).toBe(0);
    const open = await e.DB.prepare(`SELECT script, code FROM findings WHERE module = 'packages' AND status = 'open' ORDER BY script`).all();
    expect(open.results).toEqual([{ script: 'api', code: 'lockfile-unreadable' }, { script: 'cron-job', code: 'outdated' }]);
    // Allowed again: read on the next scan, without waiting a day.
    const back = stub({ lockfiles: LOCKS, npm: NPM });
    await runScan(e, new Date(NOW.getTime() + 2 * 3_600_000), { account: 'acc1' });
    expect(back.calls).toContain('GET api.github.com/repos/acme/api/contents/package-lock.json');
  });

  it('never reads the lockfile of an out-of-scope Worker', async () => {
    const f = stub({ lockfiles: LOCKS, npm: NPM });
    const e = await setup();
    const c = await configOf(e);
    await e.DB.batch([setSettings(e.DB, { config: JSON.stringify({ ...c, scope: { include: [], exclude: ['api'] } }) })]);
    await runScan(e, NOW, { account: 'acc1' });
    expect(f.calls.filter((x) => x.includes('/contents/'))).toEqual(['GET api.github.com/repos/acme/jobs/contents/cron/package-lock.json']);
    expect((await buildPackages(e.DB, 'acc1', { ...c, scope: { include: [], exclude: ['api'] } }, true)).workers.map((w) => w.name)).toEqual(['cron-job']);
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

  it('keeps dev-only major updates as info while runtime major updates stay warning', async () => {
    const devMajorOnly = lock({ zod: '3.23.8' }, { wrangler: '3.80.0' });
    stub({ lockfiles: { 'acme/api/package-lock.json': devMajorOnly }, npm: { zod: '3.23.8', wrangler: '4.12.0' } });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });
    const row = await e.DB.prepare(`SELECT severity, message, evidence FROM findings WHERE module = 'packages' AND code = 'outdated'`).first<{ severity: string; message: string; evidence: string }>();
    expect(row!.severity).toBe('info');
    expect(row!.message).toContain('dev dependency by a major version');
    expect(JSON.parse(row!.evidence)).toMatchObject({ outdated: 1, major: 1, runtimeMajor: 0, total: 2 });
  });

  it('lists unmapped in-scope Workers in buildPackages and attaches packages to WorkerDetail with plainWorker redaction', async () => {
    stub({ lockfiles: LOCKS, npm: NPM });
    const e = await setup({ repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });
    const view = await buildPackages(e.DB, 'acc1', await configOf(e), true);
    expect(view.unmappedWorkers).toEqual(['cron-job', 'draft', 'legacy']);

    const detail = await buildWorkerDetail(e, 'acc1', 'api', '7d', NOW);
    expect(detail.packages?.repo).toBe('acme/api');
    expect(detail.packages?.packages.find((p) => p.name === 'hono')).toMatchObject({ locked: '3.12.0', latest: '4.6.0', gap: 'major' });

    const plain = plainWorker(detail);
    expect(plain.packages?.repo).toBeUndefined();
    expect(plain.packages?.packages.length).toBe(3);

    const unmappedDetail = await buildWorkerDetail(e, 'acc1', 'draft', '7d', NOW);
    expect(unmappedDetail.packages).toBeUndefined();
  });

  it('deduplicates shared monorepo lockfile fetches in one scan', async () => {
    const monorepoLock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { workspaces: ['workers/*'] },
        'workers/api': { dependencies: { hono: '^3.12.0' } },
        'workers/cron': { dependencies: { zod: '^3.22.0' } },
        'node_modules/hono': { version: '3.12.0', resolved: 'https://registry.npmjs.org/hono/-/hono-3.12.0.tgz' },
        'node_modules/zod': { version: '3.22.0', resolved: 'https://registry.npmjs.org/zod/-/zod-3.22.0.tgz' },
        'workers/cron/node_modules/zod': { version: '3.21.0', resolved: 'https://registry.npmjs.org/zod/-/zod-3.21.0.tgz' },
      },
    });
    const f = stub({ lockfiles: { 'acme/mono/package-lock.json': monorepoLock }, npm: NPM });
    const e = await setup({
      repos: {
        api: { repo: 'acme/mono', workspace: 'workers/api' },
        'cron-job': { repo: 'acme/mono', workspace: 'workers/cron' },
      },
    });
    await runScan(e, NOW, { account: 'acc1' });
    // Two Workers in one monorepo -> only one GitHub contents request.
    expect(f.calls.filter((c) => c.includes('/contents/'))).toEqual(['GET api.github.com/repos/acme/mono/contents/package-lock.json']);
    const view = await buildPackages(e.DB, 'acc1', await configOf(e), true);
    expect(view.workers.find((w) => w.name === 'api')!.packages).toEqual([
      { name: 'hono', locked: '3.12.0', latest: '4.6.0', gap: 'major', dev: false, compared: true },
    ]);
    // Non-hoisted workspace dependency wins over hoisted copy.
    expect(view.workers.find((w) => w.name === 'cron-job')!.packages).toEqual([
      { name: 'zod', locked: '3.21.0', latest: '3.23.8', gap: 'minor', dev: false, compared: true },
    ]);
  });

  it('checks OSV.dev vulnerabilities when enabled, skips private packages, and caches daily', async () => {
    const f = stub({
      lockfiles: { 'acme/api/package-lock.json': mixed },
      npm: { hono: '4.6.0' },
      osv: {
        batch: { 'hono@3.12.0': ['GHSA-test-1234'], '@acme/internal@1.0.0': ['GHSA-private-9999'] },
        vulns: { 'GHSA-test-1234': { severity: 'HIGH', summary: 'Prototype pollution in router', fixed: { hono: '4.0.0' } } },
      },
    });
    const e = await setup({ osv: true, repos: { api: { repo: 'acme/api' } } });
    await runScan(e, NOW, { account: 'acc1' });

    expect(f.calls.filter((c) => c.includes('api.osv.dev'))).toEqual([
      'POST api.osv.dev/v1/querybatch',
      'GET api.osv.dev/v1/vulns/GHSA-test-1234',
    ]);
    // No credentials ever sent to OSV.
    expect(f.auth.some((a) => a.startsWith('api.osv.dev'))).toBe(false);

    const vuln = await e.DB.prepare(`SELECT severity, message, evidence FROM findings WHERE module = 'packages' AND code = 'vulnerable' AND status = 'open'`).first<{ severity: string; message: string; evidence: string }>();
    expect(vuln!.severity).toBe('critical');
    expect(vuln!.message).toContain('GHSA-test-1234');
    expect(vuln!.message).toContain('fix 4.0.0');
    expect(vuln!.message).not.toContain('internal');

    const view = await buildPackages(e.DB, 'acc1', await configOf(e), true);
    expect(view.osvEnabled).toBe(true);
    expect(view.workers[0].packages.find((p) => p.name === 'hono')?.advisories).toEqual([
      { id: 'GHSA-test-1234', severity: 'high', summary: 'Prototype pollution in router', fixed: '4.0.0' },
    ]);
    expect(view.workers[0].packages.find((p) => p.name === '@acme/internal')?.advisories).toBeUndefined();

    // Cached for 24h: next hourly scan makes zero OSV requests.
    const f2 = stub({ lockfiles: { 'acme/api/package-lock.json': mixed }, npm: { hono: '4.6.0' }, osv: { batch: {} } });
    await runScan(e, new Date(NOW.getTime() + 3_600_000), { account: 'acc1' });
    expect(f2.calls.filter((c) => c.includes('api.osv.dev'))).toEqual([]);
  });

  it('never contacts api.osv.dev when modules.packagesOsv is off', async () => {
    const f = stub({ lockfiles: LOCKS, npm: NPM, osv: { batch: { 'hono@3.12.0': ['GHSA-test-1234'] } } });
    const e = await setup({ osv: false });
    await runScan(e, NOW, { account: 'acc1' });
    expect(f.calls.filter((c) => c.includes('api.osv.dev'))).toEqual([]);
  });
});

describe('multi-lockfile parsers', () => {
  it('parses pnpm-lock.yaml v9 monorepo importers and flags non-registry entries', () => {
    const yaml = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      root-only:
        specifier: ^1.0.0
        version: 1.0.0
  workers/api:
    dependencies:
      hono:
        specifier: ^4.6.0
        version: 4.6.0
      '@acme/ui':
        specifier: ^1.2.0
        version: 1.2.0(react@18.3.1)
      local-lib:
        specifier: workspace:*
        version: link:../../packages/local-lib
    devDependencies:
      wrangler:
        specifier: ^4.10.0
        version: 4.10.0
packages:
  hono@4.6.0:
    resolution: {integrity: sha512-abc}
  '@acme/ui@1.2.0':
    resolution: {tarball: https://npm.corp.example/@acme/ui/-/ui-1.2.0.tgz}
  wrangler@4.10.0:
    resolution: {integrity: sha512-def}
`;
    expect(parsePnpmLock(yaml, 'workers/api')).toEqual([
      { name: '@acme/ui', locked: '1.2.0', dev: false, source: 'other' },
      { name: 'hono', locked: '4.6.0', dev: false, source: 'registry' },
      { name: 'wrangler', locked: '4.10.0', dev: true, source: 'registry' },
    ]);
    expect(() => parsePnpmLock(yaml, 'workers/missing')).toThrow(LockfileError);
  });

  it('parses bun.lock JSONC with comments, trailing commas, and workspaces', () => {
    const bun = `{
  // Bun text lockfile
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "mono" },
    "workers/api": {
      "dependencies": {
        "hono": "^4.6.0",
        "aliased": "npm:real-pkg@^1.0.0",
        "corp": "^2.0.0",
      },
      "devDependencies": {
        "wrangler": "^4.10.0",
      },
    },
  },
  "packages": {
    "hono": ["hono@4.6.0", "", {}, "sha512-abc"],
    "aliased": ["real-pkg@1.0.0", "", {}, "sha512-def"],
    "corp": ["corp@2.0.0", "https://npm.corp.example/corp/-/corp-2.0.0.tgz", {}, "sha512-ghi"],
    "wrangler": ["wrangler@4.10.0", "", {}, "sha512-jkl"],
  },
}`;
    expect(parseBunLock(bun, 'workers/api')).toEqual([
      { name: 'aliased', locked: '1.0.0', dev: false, source: 'other' },
      { name: 'corp', locked: '2.0.0', dev: false, source: 'other' },
      { name: 'hono', locked: '4.6.0', dev: false, source: 'registry' },
      { name: 'wrangler', locked: '4.10.0', dev: true, source: 'registry' },
    ]);
  });

  it('parses yarn.lock Classic v1 and Berry v2+ paired with package.json', () => {
    const pkg = JSON.stringify({
      dependencies: { hono: '^4.6.0', privatepkg: '^1.0.0' },
      devDependencies: { wrangler: '^4.10.0' },
    });
    const classic = `# yarn lockfile v1
hono@^4.6.0:
  version "4.6.1"
  resolved "https://registry.yarnpkg.com/hono/-/hono-4.6.1.tgz#abc"

privatepkg@^1.0.0:
  version "1.0.2"
  resolved "https://npm.corp.example/privatepkg/-/privatepkg-1.0.2.tgz"

wrangler@^4.10.0:
  version "4.10.3"
  resolved "https://registry.npmjs.org/wrangler/-/wrangler-4.10.3.tgz"
`;
    expect(parseYarnLock(classic, pkg)).toEqual([
      { name: 'hono', locked: '4.6.1', dev: false, source: 'registry' },
      { name: 'privatepkg', locked: '1.0.2', dev: false, source: 'other' },
      { name: 'wrangler', locked: '4.10.3', dev: true, source: 'registry' },
    ]);

    const berry = `__metadata:
  version: 8

"hono@npm:^4.6.0":
  version: 4.6.2
  resolution: "hono@npm:4.6.2"

"privatepkg@npm:^1.0.0":
  version: 1.0.3
  resolution: "privatepkg@https://npm.corp.example/privatepkg.tgz"

"wrangler@npm:^4.10.0":
  version: 4.10.4
  resolution: "wrangler@npm:4.10.4"
`;
    expect(parseYarnLock(berry, pkg)).toEqual([
      { name: 'hono', locked: '4.6.2', dev: false, source: 'registry' },
      { name: 'privatepkg', locked: '1.0.3', dev: false, source: 'other' },
      { name: 'wrangler', locked: '4.10.4', dev: true, source: 'registry' },
    ]);
  });

  it('validates lockfile format and workspace in config and builds the right GitHub URL', () => {
    const c = parseConfig({ version: 1, packageRepos: { api: { repo: 'acme/mono', lockfile: 'pnpm', workspace: 'workers/api' } } });
    expect(c.packageRepos.api).toEqual({ repo: 'acme/mono', lockfile: 'pnpm', workspace: 'workers/api' });
    expect(lockfileUrl(c.packageRepos.api)).toBe('https://api.github.com/repos/acme/mono/contents/pnpm-lock.yaml');
    expect(() => parseConfig({ version: 1, packageRepos: { api: { repo: 'acme/mono', lockfile: 'pip' } } })).toThrow(ConfigError);
    expect(() => parseConfig({ version: 1, packageRepos: { api: { repo: 'acme/mono', workspace: '../escape' } } })).toThrow(ConfigError);
  });

  it('invalidates cached overview and packages views as soon as GITHUB_TOKEN is added', async () => {
    const { default: worker } = await import('../src/worker/index');
    const e = await setup({ token: '', on: false });
    const login = await worker.fetch(new Request('https://app.test/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ passphrase: e.ADMIN_PASSPHRASE }),
    }), e);
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const req = (path: string, env: Env) => worker.fetch(new Request(`https://app.test${path}`, { headers: { Cookie: cookie } }), env);

    const before = (await (await req('/api/overview?account=acc1', e)).json()) as { features: { github: boolean } };
    expect(before.features.github).toBe(false);
    // Secret added on the Worker without a scan or data_rev bump.
    const withToken: Env = { ...e, GITHUB_TOKEN: 'ghp_added' };
    const after = (await (await req('/api/overview?account=acc1', withToken)).json()) as { features: { github: boolean } };
    expect(after.features.github).toBe(true);
    const pkg = (await (await req('/api/packages?account=acc1', withToken)).json()) as { github: boolean };
    expect(pkg.github).toBe(true);
  });

  it('hardens parsers against nested JSON spoofing, multi-line pnpm resolutions, oversized package.json, OSV control chars, and GitHub redirects', async () => {
    // 1. npm lockfile: nested "api" key inside another package must not shadow the real top-level "api" workspace.
    const spoofedNpm = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'mono', api: { dependencies: { evil: '1.0.0' } } },
        api: { dependencies: { hono: '^4.6.0' } },
        'node_modules/hono': { version: '4.6.0', resolved: 'https://registry.npmjs.org/hono/-/hono-4.6.0.tgz' },
        'node_modules/evil': { version: '1.0.0', resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz' },
      },
    });
    expect(parseLockfile(spoofedNpm, 'api')).toEqual([
      { name: 'hono', locked: '4.6.0', dev: false, source: 'registry' },
    ]);

    // 2. bun.lock: nested "os": [...] inside another package must not shadow the real top-level "os" package tuple.
    const spoofedBun = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "dependencies": { "os": "^1.0.0" } } },
      "packages": {
        "first": ["first@1.0.0", "", { "os": ["linux@9.9.9", "", {}, "sha512-fake"] }, "sha512-a"],
        "os": ["os@1.0.0", "https://npm.corp.example/os/-/os-1.0.0.tgz", {}, "sha512-b"]
      }
    }`;
    expect(parseBunLock(spoofedBun)).toEqual([
      { name: 'os', locked: '1.0.0', dev: false, source: 'other' },
    ]);

    // 3. pnpm-lock.yaml: multi-line resolution blocks with non-npmjs tarball, git, or directory are marked source: 'other'.
    const multiLinePnpm = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      pub:
        specifier: ^1.0.0
        version: 1.0.0
      corp:
        specifier: ^2.0.0
        version: 2.0.0
      gitpkg:
        specifier: ^3.0.0
        version: 3.0.0
      dirpkg:
        specifier: ^4.0.0
        version: 4.0.0
packages:
  pub@1.0.0:
    resolution:
      integrity: sha512-ok
  corp@2.0.0:
    resolution:
      tarball: https://npm.corp.example/corp/-/corp-2.0.0.tgz
  gitpkg@3.0.0:
    resolution:
      type: git
      repo: https://github.com/acme/private.git
  dirpkg@4.0.0:
    resolution:
      directory: packages/local
`;
    expect(parsePnpmLock(multiLinePnpm)).toEqual([
      { name: 'corp', locked: '2.0.0', dev: false, source: 'other' },
      { name: 'dirpkg', locked: '4.0.0', dev: false, source: 'other' },
      { name: 'gitpkg', locked: '3.0.0', dev: false, source: 'other' },
      { name: 'pub', locked: '1.0.0', dev: false, source: 'registry' },
    ]);

    // 4. yarn.lock rejects oversized package.json (> 1 MB).
    const hugePkg = `{"dependencies":{"a":"${'1'.repeat(1_000_005)}"}}`;
    expect(() => parseYarnLock('# yarn lockfile v1\n', hugePkg)).toThrow(LockfileError);

    // 5. OSV hydration strips control chars and newlines from summary.
    stub({
      osv: {
        batch: { 'hono@3.12.0': ['GHSA-ctrl-1234'] },
        vulns: { 'GHSA-ctrl-1234': { severity: 'HIGH', summary: 'Bad\r\ninjection\t\u0000line' } },
      },
    });
    const osvRes = await fetchOsvBatch([{ name: 'hono', version: '3.12.0' }]);
    expect(osvRes[0].advisories[0].summary).toBe('Bad injection line');

    // 6. listGithubRepos refuses 3xx redirects without following them and enforces GITHUB_REPO_ALLOWLIST.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })));
    const redir = await listGithubRepos('ghtok');
    expect(redir.repos).toEqual([]);
    expect(redir.error).toContain('redirected');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { full_name: 'acme/allowed' },
      { full_name: 'other/blocked' },
      { full_name: '../bad/name' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const filtered = await listGithubRepos('ghtok', repoAllowlist('acme'));
    expect(filtered.repos).toEqual(['acme/allowed']);
    expect(filtered.owner).toBe('acme');
  });
});
