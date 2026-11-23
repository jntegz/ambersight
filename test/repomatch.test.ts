// Which repository Settings › npm Packages suggests for a Worker, and when it says a saved mapping
// looks wrong. The Worker's name is a weak clue; the repository Cloudflare builds it from is not.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseConfig, type PackageRepo } from '../src/shared/config';
import type { BuildSource } from '../src/shared/types';
import { guessRepoByName, mappingFrom, mappingProblem, suggestFor } from '../web/src/lib/repoMatch';

// One monorepo that deploys three Workers, next to older repositories whose names look like them.
const REPOS = ['acme/api', 'acme/blog', 'acme/docs-web', 'acme/shop', 'acme/sites'];
const github = (repo: string, rootDir = ''): BuildSource => ({ provider: 'github', repo, rootDir });
const SOURCES: Record<string, BuildSource> = {
  'shop-web': github('acme/sites', 'sites/shop'),
  'blog-web': github('acme/sites', 'sites/blog'),
  'docs-web': github('acme/sites', 'sites/docs'),
};

describe('guessRepoByName', () => {
  it('does not offer a repository whose name is only part of the Worker name', () => {
    // "shop-web" is not built from "shop": that repository deploys a Worker of its own.
    expect(guessRepoByName('shop-web', REPOS)).toBe('');
    expect(guessRepoByName('blog-web', REPOS)).toBe('');
    // Nor the other way round.
    expect(guessRepoByName('site', REPOS)).toBe('');
    expect(guessRepoByName('shop', ['acme/shop-web'])).toBe('');
  });

  it('does not offer the only readable repository to every Worker', () => {
    expect(guessRepoByName('shop-web', ['acme/sites'])).toBe('');
    expect(guessRepoByName('anything', ['acme/sites'])).toBe('');
    expect(guessRepoByName('anything', [])).toBe('');
  });

  it('still offers a repository with the Worker name, ignoring case, punctuation and an environment suffix', () => {
    expect(guessRepoByName('docs-web', REPOS)).toBe('acme/docs-web');
    expect(guessRepoByName('API', REPOS)).toBe('acme/api');
    expect(guessRepoByName('docs_web', REPOS)).toBe('acme/docs-web');
    expect(guessRepoByName('api-production', REPOS)).toBe('acme/api');
    expect(guessRepoByName('docsweb-staging', REPOS)).toBe('acme/docs-web');
  });
});

describe('suggestFor', () => {
  it('takes the repository Cloudflare builds from, whatever the names say', () => {
    expect(suggestFor('shop-web', SOURCES['shop-web'], REPOS)).toEqual({ from: 'cloudflare', repo: 'acme/sites', rootDir: 'sites/shop' });
    expect(suggestFor('blog-web', SOURCES['blog-web'], REPOS)).toEqual({ from: 'cloudflare', repo: 'acme/sites', rootDir: 'sites/blog' });
    // A repository named exactly as the Worker exists, and is still not where it is built from.
    expect(suggestFor('docs-web', SOURCES['docs-web'], REPOS)).toEqual({ from: 'cloudflare', repo: 'acme/sites', rootDir: 'sites/docs' });
  });

  it('marks a match on the name as a guess, and offers nothing for a partial match', () => {
    expect(suggestFor('docs-web', undefined, REPOS)).toEqual({ from: 'name', repo: 'acme/docs-web' });
    expect(suggestFor('shop-web', undefined, REPOS)).toBeNull();
  });

  it('offers no GitHub repository for a Worker built from another provider', () => {
    expect(suggestFor('docs-web', { provider: 'gitlab', repo: '', rootDir: '' }, REPOS)).toBeNull();
  });

  it('keeps guesses out of the set that is confirmed by Cloudflare', () => {
    const workers = ['shop-web', 'blog-web', 'docs-web', 'api-production', 'cron'];
    const sources: Record<string, BuildSource> = { 'shop-web': SOURCES['shop-web'], 'blog-web': SOURCES['blog-web'] };
    const all = workers.map((w) => ({ w, s: suggestFor(w, sources[w], REPOS) }));
    expect(all.filter((m) => m.s?.from === 'cloudflare').map((m) => m.w)).toEqual(['shop-web', 'blog-web']);
    expect(all.filter((m) => m.s?.from === 'name').map((m) => `${m.w} → ${m.s!.repo}`)).toEqual(['docs-web → acme/docs-web', 'api-production → acme/api']);
    expect(all.filter((m) => !m.s).map((m) => m.w)).toEqual(['cron']);
  });
});

describe('mappingProblem', () => {
  it('reports a saved mapping to another repository, and leaves it as it is', () => {
    const saved: PackageRepo = { repo: 'acme/shop' };
    const before = JSON.stringify(saved);
    expect(mappingProblem(saved, SOURCES['shop-web'])).toEqual({ kind: 'repo', source: SOURCES['shop-web'] });
    expect(mappingProblem({ repo: 'acme/docs-web' }, SOURCES['docs-web'])).toMatchObject({ kind: 'repo' });
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('reports the right repository read at the wrong folder', () => {
    expect(mappingProblem({ repo: 'acme/sites' }, SOURCES['shop-web'])).toMatchObject({ kind: 'folder' });
    expect(mappingProblem({ repo: 'acme/sites', lockfile: 'pnpm', workspace: 'sites/blog' }, SOURCES['shop-web'])).toMatchObject({ kind: 'folder' });
  });

  it('accepts the build folder as a workspace, as the lockfile folder, or as both joined', () => {
    expect(mappingProblem({ repo: 'acme/sites', lockfile: 'pnpm', workspace: 'sites/shop' }, SOURCES['shop-web'])).toBeNull();
    expect(mappingProblem({ repo: 'ACME/Sites', dir: 'sites/shop' }, SOURCES['shop-web'])).toBeNull();
    expect(mappingProblem({ repo: 'acme/sites', dir: 'sites', workspace: 'shop' }, SOURCES['shop-web'])).toBeNull();
  });

  it('has nothing to say without a GitHub source', () => {
    expect(mappingProblem({ repo: 'acme/shop' }, undefined)).toBeNull();
    expect(mappingProblem({ repo: 'acme/shop' }, { provider: 'gitlab', repo: '', rootDir: '' })).toBeNull();
    // A build at the repository root says nothing about a workspace someone set by hand.
    expect(mappingProblem({ repo: 'acme/api', workspace: 'packages/api' }, github('acme/api'))).toBeNull();
  });
});

describe('mappingFrom', () => {
  it('maps a monorepo workspace: the lockfile in the repository root, the build folder as the workspace', () => {
    const entry = mappingFrom(SOURCES['shop-web'], { found: true, lockfile: 'pnpm', workspace: 'sites/shop' });
    expect(entry).toEqual({ repo: 'acme/sites', lockfile: 'pnpm', workspace: 'sites/shop' });
    expect(mappingProblem(entry, SOURCES['shop-web'])).toBeNull();
    // What Settings would save is a mapping the config accepts.
    expect(parseConfig({ version: 1, packageRepos: { 'acc1:shop-web': entry } }).packageRepos['acc1:shop-web']).toEqual(entry);
  });

  it('maps a folder with its own lockfile, and a build at the repository root', () => {
    expect(mappingFrom(github('acme/apps', 'workers/api'), { found: true, dir: 'workers/api' })).toEqual({ repo: 'acme/apps', dir: 'workers/api' });
    expect(mappingFrom(github('acme/api'), { found: true, lockfile: 'bun' })).toEqual({ repo: 'acme/api', lockfile: 'bun' });
  });

  it('leaves the folder for a person to set when no lockfile was found', () => {
    expect(mappingFrom(SOURCES['shop-web'], { found: false })).toEqual({ repo: 'acme/sites' });
    expect(mappingFrom(SOURCES['shop-web'], null)).toEqual({ repo: 'acme/sites' });
  });

  it('keeps a branch only while the repository stays the same', () => {
    const layout = { found: true, lockfile: 'pnpm' as const, workspace: 'sites/shop' };
    expect(mappingFrom(SOURCES['shop-web'], layout, { repo: 'acme/sites', ref: 'release' }).ref).toBe('release');
    expect(mappingFrom(SOURCES['shop-web'], layout, { repo: 'acme/shop', ref: 'release' }).ref).toBeUndefined();
  });
});
