// Optional Packages check: each mapped Worker's direct npm dependencies, the version locked in
// package-lock.json on GitHub, and the latest version on the public npm registry.
// Off by default. It is the only feature that reads source code, with a separate GITHUB_TOKEN
// (fine-grained, Contents: Read). Only GET requests, never with redirects followed.
// SPDX-License-Identifier: AGPL-3.0-only

import { repoFor, type Config, type PackageRepo } from '../shared/config';
import type { Finding, Gap, PackagesView } from '../shared/types';
import { finding } from './checks';
import { allowedFetch, OPTIONAL_HOSTS } from './net';

/** A lockfile larger than this is not read: parsing it could not fit in the Free plan's CPU time. */
export const MAX_LOCKFILE_BYTES = 8_000_000;
/** Direct dependencies kept per Worker. */
const MAX_DEPS = 300;
/** npm package names: optional @scope/, lower case, no path tricks. */
export const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,100})?$/;
const DOCS = 'https://docs.npmjs.com/cli/commands/npm-outdated';

export interface LockedDep {
  name: string;
  locked: string;
  dev: boolean;
}

/** "1.2.3" parts, or null for anything that is not plain semver. Prerelease tags are ignored. */
function parts(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** How far `locked` is behind `latest`. A locked version ahead of latest (a prerelease line) is "none". */
export function semverGap(locked: string, latest: string | null): Gap {
  if (!latest) return 'unknown';
  const a = parts(locked);
  const b = parts(latest);
  if (!a || !b) return 'unknown';
  if (a[0] !== b[0]) return a[0] < b[0] ? 'major' : 'none';
  if (a[1] !== b[1]) return a[1] < b[1] ? 'minor' : 'none';
  return a[2] < b[2] ? 'patch' : 'none';
}

export class LockfileError extends Error {}

/**
 * Direct dependencies with their locked versions, from a package-lock.json (lockfileVersion 2 or 3).
 * Lockfiles run to megabytes and the Free plan allows 10 ms of CPU, so instead of parsing the
 * whole file this parses only the root entry and finds each direct dependency by its key.
 */
export function parseLockfile(text: string): LockedDep[] {
  if (text.length > MAX_LOCKFILE_BYTES) throw new LockfileError('package-lock.json is too large to read.');
  const version = /"lockfileVersion"\s*:\s*(\d+)/.exec(text.slice(0, 2000))?.[1];
  if (version !== '2' && version !== '3') throw new LockfileError(`lockfileVersion ${version ?? 'unknown'} is not supported (needs 2 or 3, npm 7 or later).`);
  const root = jsonObjectAt(text, /"packages"\s*:\s*\{\s*""\s*:\s*/y, text.indexOf('"packages"'));
  if (!root) throw new LockfileError('package-lock.json has no root package entry.');
  const deps = (root.dependencies ?? {}) as Record<string, unknown>;
  const dev = (root.devDependencies ?? {}) as Record<string, unknown>;
  const out: LockedDep[] = [];
  for (const [name, isDev] of [...Object.keys(deps).map((n) => [n, false] as const), ...Object.keys(dev).filter((n) => !(n in deps)).map((n) => [n, true] as const)]) {
    if (out.length >= MAX_DEPS) break;
    if (!NPM_NAME.test(name)) continue;
    const locked = lockedVersion(text, name);
    if (locked) out.push({ name, locked, dev: isDev });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parses the JSON object that starts right after `prefix` (a sticky regex), found from `from`. */
function jsonObjectAt(text: string, prefix: RegExp, from: number): Record<string, unknown> | null {
  if (from < 0) return null;
  prefix.lastIndex = from;
  if (!prefix.exec(text)) return null;
  const start = prefix.lastIndex;
  const end = objectEnd(text, start);
  if (end < 0) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Index of the "}" that closes the object opened at `start`, skipping strings. -1 if it never closes. */
function objectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      for (i++; i < text.length && text.charCodeAt(i) !== 34; i++) if (text.charCodeAt(i) === 92 /* \ */) i++;
    } else if (c === 123 /* { */) depth++;
    else if (c === 125 /* } */ && --depth === 0) return i;
  }
  return -1;
}

/** The "version" of the top-level "node_modules/<name>" entry. Nested copies have a longer key. */
function lockedVersion(text: string, name: string): string | null {
  const key = `"node_modules/${name}"`;
  let at = text.indexOf(key);
  while (at >= 0) {
    const brace = text.indexOf('{', at + key.length);
    if (brace >= 0 && /^\s*:\s*$/.test(text.slice(at + key.length, brace))) {
      const end = objectEnd(text, brace);
      if (end < 0) return null;
      const v = /"version"\s*:\s*"([^"]{1,120})"/.exec(text.slice(brace, end))?.[1];
      return v && VERSION.test(v) ? v : null;
    }
    at = text.indexOf(key, at + key.length);
  }
  return null;
}

/** GitHub contents API URL for the lockfile. Every part was validated by parseConfig; encoded again here. */
export function lockfileUrl(repo: PackageRepo): string {
  const [owner, name] = repo.repo.split('/');
  const path = [...(repo.dir ? repo.dir.split('/') : []), 'package-lock.json'].map(encodeURIComponent).join('/');
  const ref = repo.ref ? `?ref=${encodeURIComponent(repo.ref)}` : '';
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}${ref}`;
}

/** Fetches and parses the lockfile. Errors never include the token or the response body. */
export async function fetchLockfile(token: string, repo: PackageRepo): Promise<LockedDep[]> {
  const res = await allowedFetch(lockfileUrl(repo), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'ambersight-packages',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    // A redirect (renamed repo) would carry the token to another URL: treat it as an error instead.
    redirect: 'manual',
  });
  if (res.status === 401) throw new LockfileError('GitHub rejected GITHUB_TOKEN (expired or revoked).');
  if (res.status === 403 || res.status === 404) throw new LockfileError(`No package-lock.json found in ${repo.repo}${repo.dir ? `/${repo.dir}` : ''}, or GITHUB_TOKEN has no Contents: Read on it.`);
  if (res.status >= 300 && res.status < 400) throw new LockfileError(`${repo.repo} has moved on GitHub. Update its name in Settings › Packages.`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const size = Number(res.headers.get('Content-Length') ?? 0);
  if (size > MAX_LOCKFILE_BYTES) {
    await res.body?.cancel();
    throw new LockfileError('package-lock.json is too large to read.');
  }
  return parseLockfile(await res.text());
}

/** Latest version of a package on the public npm registry. No credentials are sent. */
export async function npmLatest(name: string): Promise<string | null> {
  if (!NPM_NAME.test(name)) return null;
  const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const res = await allowedFetch(`https://${OPTIONAL_HOSTS.packages}/${path}/latest`, {
    headers: { Accept: 'application/json', 'User-Agent': 'ambersight-packages' },
    redirect: 'manual',
  }, undefined, [OPTIONAL_HOSTS.packages]);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
  const v = ((await res.json()) as { version?: unknown }).version;
  return typeof v === 'string' && VERSION.test(v) ? v : null;
}

export interface PackageRow {
  script: string;
  name: string;
  locked: string;
  latest: string | null;
  dev: boolean;
}

/** One finding per Worker: outdated direct dependencies, or a lockfile that could not be read. */
export function packageFindings(config: Config, account: string, rows: PackageRow[], errors: Map<string, string>): Finding[] {
  if (!config.modules.packages) return [];
  const out: Finding[] = [];
  for (const [script, error] of errors) {
    const repo = repoFor(config, account, script);
    if (!repo) continue;
    out.push(finding('packages', script, 'lockfile-unreadable', 'warning', `Ambersight could not read this Worker's packages: ${error}`,
      { repo: repo.repo }, 'Check the repository, folder and branch in Settings › Packages, and that GITHUB_TOKEN can read the repository.', DOCS));
  }
  const byScript = new Map<string, PackageRow[]>();
  for (const r of rows) byScript.set(r.script, [...(byScript.get(r.script) ?? []), r]);
  for (const [script, list] of byScript) {
    if (!repoFor(config, account, script) || errors.has(script)) continue;
    const behind = list.map((r) => ({ ...r, gap: semverGap(r.locked, r.latest) })).filter((r) => r.gap === 'major' || r.gap === 'minor' || r.gap === 'patch');
    if (!behind.length) continue;
    const majors = behind.filter((r) => r.gap === 'major');
    const worst = [...majors, ...behind.filter((r) => r.gap !== 'major')].slice(0, 3).map((r) => `${r.name} ${r.locked} → ${r.latest}`);
    out.push(finding('packages', script, 'outdated', majors.length ? 'warning' : 'info',
      `${behind.length} of ${list.length} direct dependencies are behind the latest release${majors.length ? `, ${majors.length} by a major version` : ''}: ${worst.join(', ')}.`,
      { outdated: behind.length, major: majors.length, total: list.length },
      'Run npm outdated in the repository and update, reading the changelog of each major version first. See the full list on the Packages page.', DOCS));
  }
  return out;
}

/** The Packages page: every mapped Worker of one account with its direct dependencies. */
export async function buildPackages(db: D1Database, account: string, config: Config, github: boolean): Promise<PackagesView> {
  const view: PackagesView = { enabled: config.modules.packages, github, workers: [] };
  if (!config.modules.packages) return view;
  const [workersR, rowsR] = await db.batch([
    db.prepare('SELECT name, packages_checked_at, packages_error FROM workers WHERE account = ?1').bind(account),
    db.prepare(
      `SELECT p.script, p.name, p.locked, p.dev, n.latest FROM worker_packages p LEFT JOIN npm_latest n ON n.name = p.name
       WHERE p.account = ?1 ORDER BY p.script, p.name`,
    ).bind(account),
  ]);
  const rows = rowsR.results as { script: string; name: string; locked: string; dev: number; latest: string | null }[];
  for (const w of workersR.results as { name: string; packages_checked_at: string | null; packages_error: string | null }[]) {
    const repo = repoFor(config, account, w.name);
    if (!repo) continue;
    view.workers.push({
      name: w.name,
      repo: repo.repo,
      dir: repo.dir ?? null,
      checkedAt: w.packages_checked_at,
      error: w.packages_error,
      packages: rows.filter((r) => r.script === w.name).map((r) => ({ name: r.name, locked: r.locked, latest: r.latest, gap: semverGap(r.locked, r.latest), dev: r.dev === 1 })),
    });
  }
  view.workers.sort((a, b) => a.name.localeCompare(b.name));
  return view;
}
