// The repository Cloudflare builds a Worker from (Workers Builds), read for Settings › npm Packages:
// what is kept from Cloudflare's answers, what happens without the permission, how the lockfile of
// a monorepo workspace is located on GitHub, and who may ask.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, parseConfig } from '../src/shared/config';
import type { BuildSourcesView, RepoLayout } from '../src/shared/types';
import { login } from '../src/worker/auth';
import { buildsRefused, CfClient } from '../src/worker/cf';
import { setSettings, upsertAccount } from '../src/worker/db';
import type { Env } from '../src/worker/env';
import worker, { usageBuffer } from '../src/worker/index';
import { fetchLockfile, layoutFor, lockfilesIn, REPO_NOT_ALLOWED } from '../src/worker/packages';
import { mappingFrom, suggestFor } from '../web/src/lib/repoMatch';
import { createD1 } from './d1';

const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = 'correct horse battery';
const ORIGIN = 'https://ambersight.example';
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  vi.unstubAllGlobals();
  usageBuffer.reset();
});

const cfOk = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
const cfErr = (status: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ message }] }), { status });

type Route = (path: string, url: URL, init?: RequestInit) => Response | undefined;
/** Answers Cloudflare and GitHub requests from two functions, and records every request made. */
function stub(cf: Route, gh: Route = () => undefined) {
  const calls: { host: string; path: string; auth: string | null; redirect?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/client/v4', '');
    calls.push({ host: url.hostname, path: `${path}${url.search}`, auth: new Headers(init?.headers).get('Authorization'), redirect: init?.redirect });
    const res = url.hostname === 'api.github.com' ? gh(path, url, init) : cf(path, url, init);
    return res ?? (url.hostname === 'api.github.com' ? new Response('{}', { status: 404 }) : cfErr(404, 'Resource not found'));
  }));
  return calls;
}

/** A build trigger as the Builds API documents it, with fields Ambersight has no use for. */
const trigger = (tag: string | null, owner: string, repo: string, root: string, more: Record<string, unknown> = {}) => ({
  trigger_uuid: 'trg', trigger_name: 'Production Deploy', ...(tag ? { external_script_id: tag } : {}),
  branch_includes: ['main'], build_command: 'pnpm build --secret-flag', deploy_command: 'npx wrangler deploy', build_token_name: 'deploy token of Jan Novak',
  root_directory: root,
  repo_connection: { provider_type: 'github', provider_account_name: owner, repo_name: repo, repo_id: '42', repo_connection_uuid: 'rc' },
  ...more,
});
const build = (t: unknown) => ({ build_uuid: 'b1', status: 'stopped', build_outcome: 'success', build_trigger_metadata: { author: 'jan.novak@example.org', commit_message: 'novak-note: hotfix', branch: 'main' }, trigger: t });

const TAGS = new Map([['tag-shop', 'shop-web'], ['tag-blog', 'blog-web'], ['tag-docs', 'docs-web'], ['tag-cron', 'cron']]);

describe('CfClient.buildSources', () => {
  it('reads repository and root directory from the latest builds, whatever key they are filed under', async () => {
    const calls = stub((path) => {
      if (path === '/accounts/acc1/builds/builds/latest') {
        // One Worker named by its trigger under an arbitrary key, one only by the key it is filed under.
        return cfOk({ builds: { foo: build(trigger('tag-shop', 'acme', 'sites', 'sites/shop')), 'tag-blog': build(trigger(null, 'acme', 'sites', '/sites/blog/')) } });
      }
      if (path === '/accounts/acc1/builds/workers/tag-docs/triggers') return cfOk([trigger(null, 'acme', 'sites', './sites/docs')]);
      if (path === '/accounts/acc1/builds/workers/tag-cron/triggers') return cfOk([]);
      return undefined;
    });
    const { sources, unchecked } = await new CfClient('t', 'acc1').buildSources(TAGS);
    expect(Object.fromEntries(sources)).toEqual({
      'shop-web': { provider: 'github', repo: 'acme/sites', rootDir: 'sites/shop' },
      'blog-web': { provider: 'github', repo: 'acme/sites', rootDir: 'sites/blog' },
      // No build in 90 days: absent from the latest builds, found through its triggers.
      'docs-web': { provider: 'github', repo: 'acme/sites', rootDir: 'sites/docs' },
    });
    expect(unchecked).toEqual([]);
    // One batch for all four, then one call for each Worker the batch did not show.
    expect(calls.map((c) => c.path)).toEqual([
      '/accounts/acc1/builds/builds/latest?external_script_ids=tag-shop,tag-blog,tag-docs,tag-cron',
      '/accounts/acc1/builds/workers/tag-cron/triggers',
      '/accounts/acc1/builds/workers/tag-docs/triggers',
    ]);
    // Nothing but the three fields leaves the client: no author, commit message, command or token name.
    const kept = JSON.stringify([...sources]);
    for (const dropped of ['novak', 'secret-flag', 'wrangler deploy', 'deploy token', 'main']) expect(kept).not.toContain(dropped);
  });

  it('keeps only values a saved mapping could hold', async () => {
    const answers: Record<string, unknown> = {
      'tag-shop': [trigger(null, 'acme', 'sites', '/')],
      'tag-blog': [trigger(null, 'acme', 'sites', '../../etc')],
      'tag-docs': [trigger(null, 'acme', '../evil', 'docs')],
      'tag-cron': [trigger(null, 'acme', 'old', 'x', { deleted_on: '2026-01-01T00:00:00Z' }), trigger(null, 'acme', 'jobs', 'cron')],
    };
    stub((path) => {
      const tag = /\/builds\/workers\/([^/]+)\/triggers$/.exec(path)?.[1];
      return tag ? cfOk(answers[tag]) : cfOk({});
    });
    const { sources } = await new CfClient('t', 'acc1').buildSources(TAGS);
    expect(Object.fromEntries(sources)).toEqual({
      'shop-web': { provider: 'github', repo: 'acme/sites', rootDir: '' },
      // A folder with ".." is dropped; the repository is still reported.
      'blog-web': { provider: 'github', repo: 'acme/sites', rootDir: '' },
      // A deleted trigger is skipped for the live one.
      cron: { provider: 'github', repo: 'acme/jobs', rootDir: 'cron' },
    });
  });

  it('reports another provider without its repository name', async () => {
    stub((path) => (path.endsWith('/builds/builds/latest')
      ? cfOk({ builds: { a: build(trigger('tag-shop', 'acme', 'sites', '', { repo_connection: { provider_type: 'gitlab', provider_account_name: 'acme group', repo_name: 'sites' } })) } })
      : cfOk([])));
    const { sources } = await new CfClient('t', 'acc1').buildSources(TAGS);
    expect(Object.fromEntries(sources)).toEqual({ 'shop-web': { provider: 'gitlab', repo: '', rootDir: '' } });
  });

  it('stops at its call budget on a large account and says which Workers it did not reach', async () => {
    const tags = new Map(Array.from({ length: 45 }, (_, i) => [`tag-${String(i).padStart(2, '0')}`, `worker-${String(i).padStart(2, '0')}`]));
    const calls = stub(() => cfOk({}));
    const cf = new CfClient('t', 'acc1');
    const { sources, unchecked } = await cf.buildSources(tags);
    expect(calls).toHaveLength(30);
    expect(cf.calls).toBe(30);
    // 3 batches of up to 20, then 27 Workers one by one, in name order.
    expect(calls.filter((c) => c.path.includes('/builds/builds/latest'))).toHaveLength(3);
    expect(sources.size).toBe(0);
    expect(unchecked).toHaveLength(18);
    expect(unchecked[0]).toBe('worker-27');
  });

  it('fails as a whole when Cloudflare refuses the token, and not for one missing Worker', async () => {
    stub(() => cfErr(403, 'Authentication error'));
    const refused = await new CfClient('t', 'acc1').buildSources(TAGS).catch((e) => e);
    expect(buildsRefused(refused)).toBe(true);
    stub(() => cfErr(400, 'Invalid token'));
    expect(buildsRefused(await new CfClient('t', 'acc1').buildSources(TAGS).catch((e) => e))).toBe(true);
    // "Not found" for every request is an answer, not a refusal.
    stub(() => undefined);
    await expect(new CfClient('t', 'acc1').buildSources(TAGS)).resolves.toMatchObject({ unchecked: [] });
  });
});

describe('layoutFor', () => {
  it('makes the build folder a workspace when only the repository root has a lockfile', () => {
    expect(layoutFor(['pnpm'], [], 'sites/shop')).toEqual({ found: true, lockfile: 'pnpm', workspace: 'sites/shop' });
    expect(layoutFor(['npm'], null, 'workers/api')).toEqual({ found: true, workspace: 'workers/api' });
  });

  it('makes it the lockfile folder when it has its own lockfile', () => {
    expect(layoutFor(['pnpm'], ['npm'], 'workers/api')).toEqual({ found: true, dir: 'workers/api' });
    expect(layoutFor([], ['bun'], 'workers/api')).toEqual({ found: true, lockfile: 'bun', dir: 'workers/api' });
  });

  it('reads the repository root for a build that runs there', () => {
    expect(layoutFor(['npm'], null, '')).toEqual({ found: true });
    expect(layoutFor(['yarn'], null, '')).toEqual({ found: true, lockfile: 'yarn' });
    // Next to another lockfile, package-lock.json is the likelier leftover.
    expect(layoutFor(['npm', 'pnpm'], null, '')).toEqual({ found: true, lockfile: 'pnpm' });
  });

  it('finds nothing without a supported lockfile', () => {
    expect(layoutFor([], [], 'sites/shop')).toEqual({ found: false });
    expect(layoutFor(null, null, '')).toEqual({ found: false });
  });
});

const listing = (...names: string[]) => new Response(JSON.stringify(names.map((name) => ({ name, type: name.includes('.') ? 'file' : 'dir', sha: 'x' }))));

describe('lockfilesIn', () => {
  it('reports the lockfile names in a folder and nothing else from the listing', async () => {
    const calls = stub(() => undefined, (path) => {
      if (path === '/repos/acme/sites/contents') return listing('pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'sites', '.env.production');
      if (path === '/repos/acme/sites/contents/sites/shop') return listing('package.json', 'wrangler.jsonc', 'src');
      return undefined;
    });
    expect(await lockfilesIn('ghtok', 'acme/sites', '')).toEqual(['pnpm']);
    expect(await lockfilesIn('ghtok', 'acme/sites', 'sites/shop')).toEqual([]);
    expect(await lockfilesIn('ghtok', 'acme/sites', 'sites/gone')).toBeNull();
    // The token goes to GitHub's API only, and a redirect is never followed with it.
    expect(calls.every((c) => c.host === 'api.github.com' && c.auth === 'Bearer ghtok' && c.redirect === 'manual')).toBe(true);
  });

  it('does not take a folder named like a lockfile for one', async () => {
    stub(() => undefined, () => new Response(JSON.stringify([{ name: 'yarn.lock', type: 'dir' }, { name: 'bun.lock', type: 'file' }])));
    expect(await lockfilesIn('ghtok', 'acme/sites', '')).toEqual(['bun']);
  });

  it('treats a redirect and a rejected token as errors', async () => {
    stub(() => undefined, () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
    await expect(lockfilesIn('ghtok', 'acme/sites', '')).rejects.toThrow('moved');
    stub(() => undefined, () => new Response('{}', { status: 401 }));
    await expect(lockfilesIn('ghtok', 'acme/sites', '')).rejects.toThrow('GITHUB_TOKEN');
  });
});

// A pnpm monorepo: versions pinned in a catalog, three sites that each deploy a Worker.
const PNPM_MONOREPO = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

catalogs:
  default:
    astro:
      specifier: ^5.1.0
      version: 5.1.1
    sharp:
      specifier: ^0.33.5
      version: 0.33.5
    wrangler:
      specifier: ^3.99.0
      version: 3.99.0

importers:

  .:
    devDependencies:
      prettier:
        specifier: ^3.4.2
        version: 3.4.2

  sites/blog:
    dependencies:
      astro:
        specifier: 'catalog:'
        version: 5.1.1(@types/node@22.10.2)
      hono:
        specifier: ^4.6.0
        version: 4.6.14
    devDependencies:
      wrangler:
        specifier: 'catalog:'
        version: 3.99.0(@cloudflare/workers-types@4.20241218.0)

  sites/shop:
    dependencies:
      astro:
        specifier: 'catalog:'
        version: 5.1.1(@types/node@22.10.2)
      sharp:
        specifier: 'catalog:'
        version: 0.33.5
    devDependencies:
      wrangler:
        specifier: 'catalog:'
        version: 3.99.0(@cloudflare/workers-types@4.20241218.0)

packages:

  astro@5.1.1:
    resolution: {integrity: sha512-a}
    engines: {node: ^18.17.1 || ^20.3.0 || >=22.0.0}

  hono@4.6.14:
    resolution: {integrity: sha512-h}

  prettier@3.4.2:
    resolution: {integrity: sha512-p}

  sharp@0.33.5:
    resolution: {integrity: sha512-s}

  wrangler@3.99.0:
    resolution: {integrity: sha512-w}
`;

/** The older repository of the same name: a single package with dependencies of its own. */
const OTHER_PROJECT = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { hono: '^4', jose: '^5' }, devDependencies: { wrangler: '^3' } },
    'node_modules/hono': { version: '4.6.14', resolved: 'https://registry.npmjs.org/hono/-/hono-4.6.14.tgz' },
    'node_modules/jose': { version: '5.9.6', resolved: 'https://registry.npmjs.org/jose/-/jose-5.9.6.tgz' },
    'node_modules/wrangler': { version: '3.99.0', resolved: 'https://registry.npmjs.org/wrangler/-/wrangler-3.99.0.tgz' },
  },
});

const github: Route = (path, url) => {
  // A file is asked for as raw text, a folder as a listing: tell them apart by the path.
  if (path === '/repos/acme/sites/contents') return listing('pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'sites');
  if (path === '/repos/acme/sites/contents/sites/shop') return listing('package.json', 'astro.config.mjs', 'wrangler.jsonc', 'src');
  if (path === '/repos/acme/sites/contents/pnpm-lock.yaml') return new Response(PNPM_MONOREPO);
  if (path === '/repos/acme/shop/contents') return listing('package-lock.json', 'package.json', 'src');
  if (path === '/repos/acme/shop/contents/package-lock.json') return new Response(OTHER_PROJECT);
  void url;
  return undefined;
};

async function install(extra: Partial<Env> = {}) {
  const e: Env = { DB: createD1(), ASSETS: {} as Fetcher, CF_API_TOKEN: 't', ADMIN_PASSPHRASE: PASS, GITHUB_TOKEN: 'ghtok', ...extra };
  const config = defaultConfig();
  config.modules.packages = true;
  // The wrong mapping, as a guess from the name once saved it.
  config.packageRepos = { 'acc1:shop-web': { repo: 'acme/shop' } };
  await e.DB.batch([
    upsertAccount(e.DB, { id: 'acc1', name: 'Alpha' }, new Date('2026-01-01T00:00:00Z')),
    setSettings(e.DB, { config: JSON.stringify(config) }),
  ]);
  const r = await login(e, PASS, '1.1.1.1');
  if (!r.ok) throw new Error(r.error);
  return { e, session: r.cookie.split(';')[0] };
}
const asSession = (e: Env, session: string, path: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: session } }), e, ctx);
async function apiToken(e: Env, session: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/tokens`, {
    method: 'POST', body: JSON.stringify({ name: 'reader', passphrase: PASS, accounts: 'all', people: 'yes' }),
    headers: { Cookie: session, Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1' },
  }), e, ctx);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const cloudflare: Route = (path) => {
  if (path === '/accounts/acc1/workers/scripts') return cfOk([{ id: 'shop-web', tag: 'tag-shop' }, { id: 'cron', tag: 'tag-cron' }, { id: 'untagged' }]);
  if (path === '/accounts/acc1/builds/builds/latest') return cfOk({ builds: { 'tag-shop': build(trigger('tag-shop', 'acme', 'sites', 'sites/shop')) } });
  if (path.endsWith('/triggers')) return cfOk([]);
  return undefined;
};

describe('GET /api/build-sources', () => {
  it('answers a dashboard session with each connected Worker, and stores nothing', async () => {
    const { e, session } = await install();
    const calls = stub(cloudflare);
    const before = await e.DB.prepare(`SELECT value FROM settings WHERE key = 'config'`).first<string>('value');
    const res = await asSession(e, session, '/api/build-sources?account=acc1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ available: true, sources: { 'shop-web': { provider: 'github', repo: 'acme/sites', rootDir: 'sites/shop' } }, unchecked: 0 } satisfies BuildSourcesView);
    // The Workers list, one batch, one trigger read for the Worker the batch did not show: all to Cloudflare.
    expect(calls.map((c) => `${c.host}${c.path.split('?')[0]}`)).toEqual([
      'api.cloudflare.com/accounts/acc1/workers/scripts',
      'api.cloudflare.com/accounts/acc1/builds/builds/latest',
      'api.cloudflare.com/accounts/acc1/builds/workers/tag-cron/triggers',
    ]);
    // The saved mapping is wrong, and reading the sources leaves it exactly as it was.
    expect(await e.DB.prepare(`SELECT value FROM settings WHERE key = 'config'`).first<string>('value')).toBe(before);
  });

  it('says why when the token cannot read Workers Builds, without passing on Cloudflare\'s text', async () => {
    const { e, session } = await install();
    stub((path) => (path.endsWith('/workers/scripts') ? cfOk([{ id: 'shop-web', tag: 'tag-shop' }]) : cfErr(403, 'Authentication error (code 10000) for token abc')));
    const missing = (await (await asSession(e, session, '/api/build-sources?account=acc1')).json()) as BuildSourcesView;
    expect(missing).toEqual({ available: false, reason: 'CF_API_TOKEN does not have the Workers CI Read permission.', sources: {}, unchecked: 0 });

    stub((path) => (path.endsWith('/workers/scripts') ? cfOk([{ id: 'shop-web', tag: 'tag-shop' }]) : cfErr(400, 'Invalid token')));
    const owned = (await (await asSession(e, session, '/api/build-sources?account=acc1')).json()) as BuildSourcesView;
    expect(owned.available).toBe(false);
    expect(owned.reason).toContain('account-owned');
  });

  it('refuses an API token and an account this install does not watch', async () => {
    const { e, session } = await install();
    const token = await apiToken(e, session);
    const calls = stub(cloudflare, github);
    for (const path of ['/api/build-sources?account=acc1', '/api/repo-layout?repo=acme/sites&dir=sites/shop']) {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${token}` } }), e, ctx);
      // Not on the list of routes a token may read, so it is turned away before the route runs.
      expect(res.status, path).toBe(401);
    }
    expect((await asSession(e, session, '/api/build-sources?account=nope')).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('GET /api/repo-layout', () => {
  it('locates the lockfile of a monorepo workspace in two GitHub requests', async () => {
    const { e, session } = await install();
    const calls = stub(cloudflare, github);
    const res = await asSession(e, session, '/api/repo-layout?repo=acme/sites&dir=sites/shop');
    expect(await res.json()).toEqual({ found: true, lockfile: 'pnpm', workspace: 'sites/shop' } satisfies RepoLayout);
    expect(calls.map((c) => `${c.host}${c.path}`)).toEqual(['api.github.com/repos/acme/sites/contents', 'api.github.com/repos/acme/sites/contents/sites/shop']);
    expect(calls.every((c) => c.auth === 'Bearer ghtok' && c.redirect === 'manual')).toBe(true);
  });

  it('does not read a repository outside GITHUB_REPO_ALLOWLIST, or one it was not given as owner/name', async () => {
    const { e, session } = await install({ GITHUB_REPO_ALLOWLIST: 'other' });
    const calls = stub(cloudflare, github);
    expect(await (await asSession(e, session, '/api/repo-layout?repo=acme/sites&dir=sites/shop')).json()).toEqual({ found: false, error: REPO_NOT_ALLOWED });
    for (const bad of ['repo=acme', 'repo=acme/sites/extra', 'repo=acme/..', 'repo=acme/sites&dir=../x', 'repo=acme/sites&dir=/etc', 'repo=acme/sites&dir=a%3Fb']) {
      expect((await asSession(e, session, `/api/repo-layout?${bad}`)).status, bad).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('says so when the repository cannot be read or has no lockfile', async () => {
    const { e, session } = await install();
    stub(cloudflare, github);
    expect(await (await asSession(e, session, '/api/repo-layout?repo=acme/private')).json()).toEqual({ found: false, error: 'GITHUB_TOKEN cannot read acme/private.' });
    stub(cloudflare, () => listing('README.md', 'src'));
    expect(await (await asSession(e, session, '/api/repo-layout?repo=acme/sites&dir=sites/shop')).json()).toEqual({ found: false });
    const { e: bare, session: s2 } = await install({ GITHUB_TOKEN: undefined });
    expect(await (await asSession(bare, s2, '/api/repo-layout?repo=acme/sites')).json()).toEqual({ found: false, error: 'GITHUB_TOKEN is not set.' });
  });
});

describe('a Worker built from a monorepo workspace', () => {
  it('is mapped to the monorepo and its workspace, and reads that workspace\'s dependencies only', async () => {
    const { e, session } = await install();
    stub(cloudflare, github);
    // What Settings does for an unmapped Worker: ask Cloudflare, then GitHub, then build the mapping.
    const view = (await (await asSession(e, session, '/api/build-sources?account=acc1')).json()) as BuildSourcesView;
    const suggestion = suggestFor('shop-web', view.sources['shop-web'], ['acme/shop', 'acme/sites']);
    expect(suggestion).toEqual({ from: 'cloudflare', repo: 'acme/sites', rootDir: 'sites/shop' });
    if (suggestion?.from !== 'cloudflare') throw new Error('unreachable');
    const layout = (await (await asSession(e, session, `/api/repo-layout?repo=${suggestion.repo}&dir=${suggestion.rootDir}`)).json()) as RepoLayout;
    const entry = parseConfig({ version: 1, packageRepos: { 'acc1:shop-web': mappingFrom(suggestion, layout) } }).packageRepos['acc1:shop-web'];
    expect(entry).toEqual({ repo: 'acme/sites', lockfile: 'pnpm', workspace: 'sites/shop' });

    // The catalog pins three packages for this site; the other sites' and the root's stay out.
    expect(await fetchLockfile('ghtok', entry)).toEqual([
      { name: 'astro', locked: '5.1.1', dev: false, source: 'registry' },
      { name: 'sharp', locked: '0.33.5', dev: false, source: 'registry' },
      { name: 'wrangler', locked: '3.99.0', dev: true, source: 'registry' },
    ]);
    // The repository a name match would have picked is a different project with other dependencies.
    expect((await fetchLockfile('ghtok', { repo: 'acme/shop' })).map((d) => d.name)).toEqual(['hono', 'jose', 'wrangler']);
  });
});
