// Which GitHub repository to suggest for a Worker in Settings › npm Packages, and whether a saved
// mapping disagrees with the repository Cloudflare builds the Worker from.
//
// A Worker's name does not say where its code lives: a Worker "shop-web" can be built from a
// monorepo while a repository "shop", or even "shop-web", holds something else. So the repository
// Cloudflare reports (Workers Builds) is the suggestion whenever there is one, and a match on the
// name is only ever offered as a guess.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PackageRepo } from '../../../src/shared/config';
import type { BuildSource, RepoLayout } from '../../../src/shared/types';

const repoName = (r: string) => (r.split('/')[1] ?? '').toLowerCase();
const normSlug = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '');
/** "api-production" is the Worker of a repository "api". */
const baseWorker = (s: string) => s.toLowerCase().replace(/-(?:prod|production|staging|stage|dev|test|preview|workers?)$/, '');

/**
 * A repository named as the Worker is, or '' when none is. The name has to match in full, apart
 * from punctuation and an environment suffix: a repository whose name is only part of the Worker's
 * name ("shop" for "shop-web") is a different project more often than not, and is not offered.
 */
export function guessRepoByName(worker: string, repos: string[]): string {
  const w = worker.toLowerCase();
  const base = baseWorker(w);
  return (
    repos.find((r) => repoName(r) === w)
    ?? repos.find((r) => normSlug(repoName(r)) === normSlug(w))
    ?? repos.find((r) => repoName(r) === base)
    ?? repos.find((r) => normSlug(repoName(r)) === normSlug(base))
    ?? ''
  );
}

export type Suggestion =
  /** The repository Cloudflare builds the Worker from. */
  | { from: 'cloudflare'; repo: string; rootDir: string }
  /** A repository with the Worker's name. To be checked by a person. */
  | { from: 'name'; repo: string };

/**
 * `source` is what Cloudflare reports for the Worker, if anything. A Worker Cloudflare builds from
 * another provider gets no suggestion: a GitHub repository of the same name is not its source.
 */
export function suggestFor(worker: string, source: BuildSource | undefined, repos: string[]): Suggestion | null {
  if (source) return source.provider === 'github' && source.repo ? { from: 'cloudflare', repo: source.repo, rootDir: source.rootDir } : null;
  const repo = guessRepoByName(worker, repos);
  return repo ? { from: 'name', repo } : null;
}

export interface MappingProblem {
  /** `repo`: mapped to another repository. `folder`: the right repository, but not the build's folder. */
  kind: 'repo' | 'folder';
  source: BuildSource;
}

/** How a saved mapping differs from the repository Cloudflare builds the Worker from, or null. Changes nothing. */
export function mappingProblem(saved: PackageRepo, source: BuildSource | undefined): MappingProblem | null {
  if (!source || source.provider !== 'github' || !source.repo) return null;
  if (saved.repo.trim().toLowerCase() !== source.repo.toLowerCase()) return { kind: 'repo', source };
  if (!source.rootDir) return null;
  // The build folder is either the lockfile's folder, a workspace of it, or the two joined.
  const reads = [saved.dir, saved.workspace, [saved.dir, saved.workspace].filter(Boolean).join('/')];
  return reads.includes(source.rootDir) ? null : { kind: 'folder', source };
}

/**
 * The mapping for a Worker built from `source`, given where GitHub shows the lockfile. Without a
 * lockfile found it is the repository alone, for the person to complete. A branch set on the
 * earlier mapping is kept only while the repository stays the same.
 */
export function mappingFrom(source: { repo: string; rootDir: string }, layout: RepoLayout | null, earlier?: PackageRepo): PackageRepo {
  const out: PackageRepo = { repo: source.repo };
  if (layout?.found) {
    if (layout.lockfile && layout.lockfile !== 'npm') out.lockfile = layout.lockfile;
    if (layout.dir) out.dir = layout.dir;
    if (layout.workspace) out.workspace = layout.workspace;
  }
  if (earlier?.ref && earlier.repo.trim().toLowerCase() === source.repo.toLowerCase()) out.ref = earlier.ref;
  return out;
}
