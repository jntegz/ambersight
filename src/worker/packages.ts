// Optional Packages check: each mapped Worker's direct npm dependencies, the version locked in
// its lockfile on GitHub (npm, pnpm, yarn or bun, including monorepo workspaces), the latest
// version on the public npm registry, and optional OSV.dev vulnerability advisories.
// Off by default. It is the only feature that reads source code, with a separate GITHUB_TOKEN
// (fine-grained, Contents: Read). Only GET requests to GitHub/npm (never following redirects),
// and optional POST/GET to api.osv.dev when modules.packagesOsv is enabled.
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor, inScope, LOCKFILE_KINDS, repoFor, type Config, type LockfileKind, type PackageRepo } from '../shared/config';
import type { AdvisorySeverity, Finding, Gap, PackageAdvisory, PackageItem, PackagesView, RepoLayout, WorkerPackages } from '../shared/types';
import { finding } from './checks';
import { allowedFetch, OPTIONAL_HOSTS } from './net';

/** A lockfile larger than this is not read: parsing it could not fit in the Free plan's CPU time. */
export const MAX_LOCKFILE_BYTES = 8_000_000;
/** Direct dependencies kept per Worker. */
const MAX_DEPS = 300;
/**
 * The root package entry (its dependency lists) is parsed whole, so it has its own limit: far above
 * any real project's, and small enough that a hostile lockfile cannot spend a scan's CPU on it.
 */
const MAX_ROOT_ENTRY_BYTES = 512_000;

/** The first `max` keys of an object, without building the whole list first. */
function firstKeys(obj: Record<string, unknown>, max: number, skip?: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k in obj) {
    if (out.length >= max) break;
    if (Object.hasOwn(obj, k) && !(skip && k in skip)) out.push(k);
  }
  return out;
}
/** Maximum unique OSV advisories hydrated per scan to preserve the Free plan subrequest budget. */
const MAX_OSV_HYDRATE = 8;
/** npm package names: optional @scope/, lower case, no path tricks. */
export const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,100})?$/;
const ADVISORY_ID = /^[A-Za-z0-9_.-]{4,60}$/;
const DOCS = 'https://docs.npmjs.com/cli/commands/npm-outdated';
const OSV_DOCS = 'https://osv.dev';

export const LOCKFILE_FILES: Record<LockfileKind, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
};

/** Where a locked package came from: the public npm registry, or anywhere else (or not recorded). */
export type PackageSource = 'registry' | 'other';

export interface LockedDep {
  name: string;
  locked: string;
  dev: boolean;
  source: PackageSource;
}

/** The refusal stored for a Worker mapped to a repository outside GITHUB_REPO_ALLOWLIST. */
export const REPO_NOT_ALLOWED = 'This repository is not in GITHUB_REPO_ALLOWLIST, so Ambersight did not read it.';

/** GITHUB_REPO_ALLOWLIST as lower-case owners and owner/name pairs; null when it is not set. */
export function repoAllowlist(value: string | undefined): string[] | null {
  if (!value?.trim()) return null;
  return value.split(/[\s,]+/).filter(Boolean).map((e) => e.toLowerCase());
}

/** GitHub names are case-insensitive. No list means every mapped repository may be read. */
export function repoAllowed(list: string[] | null, repo: string): boolean {
  if (!list) return true;
  const full = repo.toLowerCase();
  return list.includes(full) || list.includes(full.split('/')[0]);
}

/** True only for this package's own tarball on the public registry. An alias or a mirror is not that. */
function fromPublicRegistry(name: string, resolved: unknown, hosts: string[] = [OPTIONAL_HOSTS.packages]): boolean {
  if (typeof resolved !== 'string') return false;
  const variants = [name, name.replace('/', '%2f'), name.replace('/', '%2F')];
  return hosts.some((host) => {
    const base = `https://${host}/`;
    return variants.some((n) => resolved.startsWith(`${base}${n}/-/`));
  });
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

// ---- npm package-lock.json (v2 & v3, single-package and workspaces) --------

/**
 * Direct dependencies with their locked versions, from a package-lock.json (lockfileVersion 2 or 3).
 * Lockfiles run to megabytes and the Free plan allows 10 ms of CPU, so instead of parsing the
 * whole file this parses only the target package entry and finds each direct dependency by its key.
 */
export function parseLockfile(text: string, workspace?: string): LockedDep[] {
  if (text.length > MAX_LOCKFILE_BYTES) throw new LockfileError('package-lock.json is too large to read.');
  const version = /"lockfileVersion"\s*:\s*(\d+)/.exec(text.slice(0, 2000))?.[1];
  if (version !== '2' && version !== '3') throw new LockfileError(`lockfileVersion ${version ?? 'unknown'} is not supported (needs 2 or 3, npm 7 or later).`);
  const rootOpen = skipWs(text, 0);
  const pkgOpen = findDirectChildOpen(text, rootOpen, 'packages', '{');
  if (pkgOpen < 0) throw new LockfileError('package-lock.json has no packages map.');
  const ws = workspace?.replace(/^\/+|\/+$/g, '') ?? '';
  const root = findDirectChildObject(text, pkgOpen, ws);
  if (!root) throw new LockfileError(ws ? `Workspace "${ws}" was not found in package-lock.json.` : 'package-lock.json has no root package entry.');
  const deps = (root.dependencies ?? {}) as Record<string, unknown>;
  const dev = (root.devDependencies ?? {}) as Record<string, unknown>;
  const candidates: { name: string; dev: boolean }[] = [];
  for (const [name, isDev] of [...firstKeys(deps, MAX_DEPS * 4).map((n) => [n, false] as const), ...firstKeys(dev, MAX_DEPS * 4, deps).map((n) => [n, true] as const)]) {
    if (candidates.length >= MAX_DEPS) break;
    if (!NPM_NAME.test(name)) continue;
    candidates.push({ name, dev: isDev });
  }
  const wantedPaths: string[] = [];
  for (const { name } of candidates) {
    if (ws) wantedPaths.push(`${ws}/node_modules/${name}`);
    wantedPaths.push(`node_modules/${name}`);
  }
  const rawEntries = findDirectChildrenRaw(text, pkgOpen, wantedPaths);
  const out: LockedDep[] = [];
  for (const { name, dev: isDev } of candidates) {
    // In workspaces, a non-hoisted version lives under "<workspace>/node_modules/<name>"; hoisted under "node_modules/<name>".
    const entry = (ws ? parseLockedEntry(rawEntries.get(`${ws}/node_modules/${name}`)) : null) ?? parseLockedEntry(rawEntries.get(`node_modules/${name}`));
    if (entry) out.push({ name, locked: entry.version, dev: isDev, source: fromPublicRegistry(name, entry.resolved) ? 'registry' : 'other' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Skips ASCII whitespace starting at `i`. */
function skipWs(text: string, i: number): number {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    i++;
  }
  return i;
}

/** End index (inclusive) of a JSON string starting at `"`, or -1 if unclosed. */
function stringEnd(text: string, start: number): number {
  if (text.charCodeAt(start) !== 34) return -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 92 /* \ */) i++;
    else if (c === 34 /* " */) return i;
  }
  return -1;
}

/** Index of the matching closing delimiter (`}` or `]`) for the container opened at `start`, skipping strings. */
function containerEnd(text: string, start: number, open: number, close: number): number {
  if (text.charCodeAt(start) !== open) return -1;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      i = stringEnd(text, i);
      if (i < 0) return -1;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** Skips one JSON value starting at `start`, returning the index right after it (or -1 on syntax error). */
function skipJsonValue(text: string, start: number): number {
  const c = text.charCodeAt(start);
  if (c === 123 /* { */) {
    const e = containerEnd(text, start, 123, 125);
    return e < 0 ? -1 : e + 1;
  }
  if (c === 91 /* [ */) {
    const e = containerEnd(text, start, 91, 93);
    return e < 0 ? -1 : e + 1;
  }
  if (c === 34 /* " */) {
    const e = stringEnd(text, start);
    return e < 0 ? -1 : e + 1;
  }
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 44 /* , */ || ch === 125 /* } */ || ch === 93 /* ] */ || ch === 32 || ch === 9 || ch === 10 || ch === 13) break;
    i++;
  }
  return i > start ? i : -1;
}

/** Index of the opening `{` or `[` for direct child `targetKey` inside the JSON object at `objOpen`, or -1. */
function findDirectChildOpen(text: string, objOpen: number, targetKey: string, openChar: '{' | '['): number {
  if (text.charCodeAt(objOpen) !== 123 /* { */) return -1;
  const want = JSON.stringify(targetKey);
  let i = skipWs(text, objOpen + 1);
  while (i < text.length && text.charCodeAt(i) !== 125 /* } */) {
    if (text.charCodeAt(i) !== 34 /* " */) return -1;
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) return -1;
    const rawKey = text.slice(i, keyEnd + 1);
    const colon = skipWs(text, keyEnd + 1);
    if (text.charCodeAt(colon) !== 58 /* : */) return -1;
    const valStart = skipWs(text, colon + 1);
    if (rawKey === want) return text[valStart] === openChar ? valStart : -1;
    const valEnd = skipJsonValue(text, valStart);
    if (valEnd < 0) return -1;
    i = skipWs(text, valEnd);
    if (text.charCodeAt(i) === 44 /* , */) i = skipWs(text, i + 1);
  }
  return -1;
}

/**
 * Single O(N) pass over direct child properties of the JSON object opened at `objOpen`,
 * returning raw JSON value slices for every key in `targetKeys` (never matches nested keys).
 */
function findDirectChildrenRaw(text: string, objOpen: number, targetKeys: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (text.charCodeAt(objOpen) !== 123 /* { */) return out;
  const want = new Map<string, string>();
  for (const k of targetKeys) want.set(JSON.stringify(k), k);
  if (!want.size) return out;
  let i = skipWs(text, objOpen + 1);
  while (i < text.length && text.charCodeAt(i) !== 125 /* } */) {
    if (text.charCodeAt(i) !== 34 /* " */) break;
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) break;
    const rawKey = text.slice(i, keyEnd + 1);
    const colon = skipWs(text, keyEnd + 1);
    if (text.charCodeAt(colon) !== 58 /* : */) break;
    const valStart = skipWs(text, colon + 1);
    const valEnd = skipJsonValue(text, valStart);
    if (valEnd < 0) break;
    const logical = want.get(rawKey);
    if (logical !== undefined && !out.has(logical)) {
      out.set(logical, text.slice(valStart, valEnd));
      if (out.size === want.size) break;
    }
    i = skipWs(text, valEnd);
    if (text.charCodeAt(i) === 44 /* , */) i = skipWs(text, i + 1);
  }
  return out;
}

function findDirectChildObject(text: string, objOpen: number, targetKey: string): Record<string, unknown> | null {
  const raw = findDirectChildrenRaw(text, objOpen, [targetKey]).get(targetKey);
  if (!raw || raw[0] !== '{') return null;
  if (raw.length > MAX_ROOT_ENTRY_BYTES) throw new LockfileError('The root package entry of the lockfile is too large to read.');
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parses a direct `"<pathKey>"` JSON object slice from `packages` into version + resolved URL. */
function parseLockedEntry(raw: string | undefined): { version: string; resolved: unknown } | null {
  if (!raw || raw[0] !== '{') return null;
  try {
    const e = JSON.parse(raw) as Record<string, unknown>;
    return typeof e.version === 'string' && e.version.length <= 120 && VERSION.test(e.version) ? { version: e.version, resolved: e.resolved } : null;
  } catch {
    return null;
  }
}

// ---- pnpm-lock.yaml (v6 & v9, single-package and workspaces) ---------------

const unquoteYaml = (s: string) => {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
};

/**
 * Direct dependencies from pnpm-lock.yaml (lockfileVersion 6.x or 9.x).
 * Scans line by line in O(N) without loading a full YAML parser, keeping CPU under the Free plan limit.
 */
export function parsePnpmLock(text: string, workspace?: string): LockedDep[] {
  if (text.length > MAX_LOCKFILE_BYTES) throw new LockfileError('pnpm-lock.yaml is too large to read.');
  const head = text.slice(0, 1000);
  const vm = /^lockfileVersion:\s*['"]?(\d+(?:\.\d+)?)['"]?/m.exec(head);
  const major = vm ? Number(vm[1].split('.')[0]) : NaN;
  if (major !== 6 && major !== 9) throw new LockfileError(`pnpm lockfileVersion ${vm?.[1] ?? 'unknown'} is not supported (needs 6 or 9).`);

  const ws = workspace?.replace(/^\/+|\/+$/g, '') || '.';
  const lines = text.split(/\r?\n/);

  // 1. Collect direct dependencies from importers[ws] (or top-level dependencies/devDependencies in single-package v6).
  const rawDeps = new Map<string, { rawVersion: string; dev: boolean }>();
  let hasImporters = false;
  let foundImporter = false;
  let topSection = '';
  let inTargetImporter = false;
  let depKind: 'deps' | 'dev' | '' = '';
  let curPkg = '';
  let depIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      topSection = trimmed.endsWith(':') ? unquoteYaml(trimmed.slice(0, -1)) : '';
      if (topSection === 'importers') hasImporters = true;
      inTargetImporter = false;
      curPkg = '';
      if (!hasImporters && (topSection === 'dependencies' || topSection === 'devDependencies') && ws === '.') {
        foundImporter = true;
        depKind = topSection === 'dependencies' ? 'deps' : 'dev';
        depIndent = 2;
      } else {
        depKind = '';
      }
      continue;
    }

    if (topSection === 'importers') {
      if (indent === 2 && trimmed.endsWith(':')) {
        const key = unquoteYaml(trimmed.slice(0, -1));
        inTargetImporter = key === ws;
        if (inTargetImporter) foundImporter = true;
        depKind = '';
        curPkg = '';
        continue;
      }
      if (!inTargetImporter) continue;
      if (indent === 4 && trimmed.endsWith(':')) {
        const sub = unquoteYaml(trimmed.slice(0, -1));
        depKind = sub === 'dependencies' ? 'deps' : sub === 'devDependencies' ? 'dev' : '';
        depIndent = 6;
        curPkg = '';
        continue;
      }
    }

    if (!depKind) continue;
    if (indent === depIndent && trimmed.endsWith(':')) {
      curPkg = unquoteYaml(trimmed.slice(0, -1));
      continue;
    }
    if (curPkg && indent > depIndent && trimmed.startsWith('version:')) {
      const val = unquoteYaml(trimmed.slice('version:'.length));
      if (!rawDeps.has(curPkg) || depKind === 'deps') rawDeps.set(curPkg, { rawVersion: val, dev: depKind === 'dev' });
      curPkg = '';
    }
  }

  if (!foundImporter) {
    throw new LockfileError(ws === '.' ? 'pnpm-lock.yaml has no root dependencies section.' : `Workspace "${ws}" was not found in pnpm-lock.yaml.`);
  }

  // 2. Check packages: section for custom resolutions (non-npmjs tarball, git, directory) on matched direct deps.
  const wanted = new Map<string, string>(); // "<name>@<ver>" -> name
  const parsed: { name: string; locked: string; dev: boolean; nonRegistry: boolean }[] = [];
  for (const [name, info] of rawDeps) {
    if (parsed.length >= MAX_DEPS) break;
    if (!NPM_NAME.test(name)) continue;
    const raw = info.rawVersion;
    const nonRegistry = /^(?:link:|file:|workspace:|git\+|https?:\/\/|npm:|\/)/.test(raw);
    const cleaned = raw.split('(')[0].trim();
    if (!VERSION.test(cleaned)) continue;
    parsed.push({ name, locked: cleaned, dev: info.dev, nonRegistry });
    if (!nonRegistry) wanted.set(`${name}@${cleaned}`, name);
  }

  const otherResolved = new Set<string>();
  if (wanted.size) {
    let inPackages = false;
    let curKey = '';
    let inResolution = false;
    let resIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();
      if (indent === 0) {
        inPackages = trimmed === 'packages:';
        curKey = '';
        inResolution = false;
        continue;
      }
      if (!inPackages) continue;
      if (indent === 2 && trimmed.endsWith(':')) {
        // v6 keys look like '/hono@4.6.0:' or '/@scope/pkg@1.0.0(peer):'; v9 look like 'hono@4.6.0:'
        const k = unquoteYaml(trimmed.slice(0, -1)).replace(/^\//, '').split('(')[0];
        curKey = wanted.has(k) ? k : '';
        inResolution = false;
        continue;
      }
      if (!curKey) continue;
      if (indent >= 4 && trimmed.startsWith('resolution:')) {
        inResolution = true;
        resIndent = indent;
        const pkgName = wanted.get(curKey)!;
        const tarball = /tarball:\s*['"]?([^,'"\s}]+)/.exec(trimmed)?.[1];
        if (tarball && !fromPublicRegistry(pkgName, tarball)) otherResolved.add(curKey);
        if (/\b(?:type:\s*['"]?git|directory:)/.test(trimmed)) otherResolved.add(curKey);
        continue;
      }
      if (inResolution) {
        if (indent <= resIndent) {
          inResolution = false;
        } else {
          const pkgName = wanted.get(curKey)!;
          const tarball = /^tarball:\s*['"]?([^,'"\s}]+)/.exec(trimmed)?.[1];
          if (tarball && !fromPublicRegistry(pkgName, tarball)) otherResolved.add(curKey);
          if (/^(?:type:\s*['"]?git|directory:)/.test(trimmed)) otherResolved.add(curKey);
        }
      }
    }
  }

  return parsed
    .map((p) => ({
      name: p.name,
      locked: p.locked,
      dev: p.dev,
      source: (p.nonRegistry || otherResolved.has(`${p.name}@${p.locked}`) ? 'other' : 'registry') as PackageSource,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- bun.lock (JSONC text lockfile, Bun 1.2+) ------------------------------

/** Strips JSONC comments and trailing commas using chunk slicing (fast enough for Free plan CPU). */
function stripJsonc(text: string): string {
  const noComments: string[] = [];
  let seg = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      const end = stringEnd(text, i);
      i = end < 0 ? text.length : end + 1;
    } else if (c === 47 /* / */ && text.charCodeAt(i + 1) === 47 /* / */) {
      if (i > seg) noComments.push(text.slice(seg, i));
      i += 2;
      while (i < text.length && text.charCodeAt(i) !== 10) i++;
      seg = i;
    } else if (c === 47 /* / */ && text.charCodeAt(i + 1) === 42 /* * */) {
      if (i > seg) noComments.push(text.slice(seg, i));
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      seg = i;
    } else {
      i++;
    }
  }
  if (seg < text.length) noComments.push(text.slice(seg));
  const mid = noComments.length === 1 ? noComments[0] : noComments.join('');

  const clean: string[] = [];
  let cseg = 0;
  for (let j = 0; j < mid.length; j++) {
    const c = mid.charCodeAt(j);
    if (c === 34 /* " */) {
      const end = stringEnd(mid, j);
      j = end < 0 ? mid.length : end;
    } else if (c === 44 /* , */) {
      const next = skipWs(mid, j + 1);
      const nc = mid.charCodeAt(next);
      if (nc === 125 /* } */ || nc === 93 /* ] */) {
        if (j > cseg) clean.push(mid.slice(cseg, j));
        cseg = j + 1;
      }
    }
  }
  if (cseg < mid.length) clean.push(mid.slice(cseg));
  return clean.length === 1 ? clean[0] : clean.join('');
}

/**
 * Direct dependencies from bun.lock (text JSONC lockfile).
 * Extracts only the target workspace and each direct dependency entry from `packages`.
 */
export function parseBunLock(text: string, workspace?: string): LockedDep[] {
  if (text.length > MAX_LOCKFILE_BYTES) throw new LockfileError('bun.lock is too large to read.');
  const json = stripJsonc(text);
  const ws = workspace?.replace(/^\/+|\/+$/g, '') ?? '';
  const rootOpen = skipWs(json, 0);
  const wsOpen = findDirectChildOpen(json, rootOpen, 'workspaces', '{');
  if (wsOpen < 0) throw new LockfileError('bun.lock has no workspaces section.');
  const root = findDirectChildObject(json, wsOpen, ws);
  if (!root) throw new LockfileError(ws ? `Workspace "${ws}" was not found in bun.lock.` : 'bun.lock has no root workspace entry.');
  const deps = (root.dependencies ?? {}) as Record<string, unknown>;
  const dev = (root.devDependencies ?? {}) as Record<string, unknown>;
  const pkgsOpen = findDirectChildOpen(json, rootOpen, 'packages', '{');
  if (pkgsOpen < 0) throw new LockfileError('bun.lock has no packages section.');

  const candidates: { name: string; dev: boolean }[] = [];
  for (const [name, isDev] of [...firstKeys(deps, MAX_DEPS * 4).map((n) => [n, false] as const), ...firstKeys(dev, MAX_DEPS * 4, deps).map((n) => [n, true] as const)]) {
    if (candidates.length >= MAX_DEPS) break;
    if (!NPM_NAME.test(name)) continue;
    candidates.push({ name, dev: isDev });
  }
  const rawEntries = findDirectChildrenRaw(json, pkgsOpen, candidates.map((c) => c.name));
  const out: LockedDep[] = [];
  for (const { name, dev: isDev } of candidates) {
    const tuple = parseBunPackage(rawEntries.get(name), name);
    if (!tuple) continue;
    out.push({ name, locked: tuple.version, dev: isDev, source: tuple.source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parseBunPackage(raw: string | undefined, name: string): { version: string; source: PackageSource } | null {
  if (!raw || raw[0] !== '[') return null;
  try {
    const arr = JSON.parse(raw) as unknown[];
    const id = typeof arr[0] === 'string' ? arr[0] : '';
    const reg = typeof arr[1] === 'string' ? arr[1] : '';
    const atIdx = id.lastIndexOf('@');
    if (atIdx <= 0) return null;
    const resolvedName = id.slice(0, atIdx);
    const version = id.slice(atIdx + 1);
    if (!VERSION.test(version)) return null;
    const ownName = resolvedName === name;
    const defaultOrPublicReg = reg === '' || fromPublicRegistry(name, reg) || reg === `https://${OPTIONAL_HOSTS.packages}/` || reg === `https://${OPTIONAL_HOSTS.packages}`;
    return { version, source: ownName && defaultOrPublicReg ? 'registry' : 'other' };
  } catch {
    return null;
  }
}

// ---- yarn.lock (Classic v1 & Berry v2+) + package.json ---------------------

/**
 * Direct dependencies from yarn.lock (v1 Classic or v2+ Berry) paired with package.json.
 * yarn.lock does not list which dependencies are direct, so package.json supplies the names and ranges.
 */
export function parseYarnLock(lockText: string, pkgJsonText: string): LockedDep[] {
  if (lockText.length > MAX_LOCKFILE_BYTES) throw new LockfileError('yarn.lock is too large to read.');
  if (pkgJsonText.length > 1_000_000) throw new LockfileError('package.json is too large to read.');
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(pkgJsonText) as typeof pkg;
  } catch {
    throw new LockfileError('package.json could not be parsed.');
  }
  const deps = pkg?.dependencies ?? {};
  const dev = pkg?.devDependencies ?? {};
  const wanted = new Map<string, { spec: string; dev: boolean }>();
  for (const [n, s] of Object.entries(deps)) {
    if (wanted.size >= MAX_DEPS) break;
    if (NPM_NAME.test(n) && typeof s === 'string') wanted.set(n, { spec: s, dev: false });
  }
  for (const [n, s] of Object.entries(dev)) {
    if (wanted.size >= MAX_DEPS) break;
    if (!wanted.has(n) && NPM_NAME.test(n) && typeof s === 'string') wanted.set(n, { spec: s, dev: true });
  }
  if (!wanted.size) return [];

  const isBerry = /__metadata:\s*$/m.test(lockText.slice(0, 1500));
  const lines = lockText.split(/\r?\n/);
  const found = new Map<string, { version: string; source: PackageSource }>();

  // Match block headers -> extract version + resolved/resolution.
  let matchedNames: string[] = [];
  let curVersion = '';
  let curResolved = '';

  const flush = () => {
    if (matchedNames.length && VERSION.test(curVersion)) {
      for (const name of matchedNames) {
        if (found.has(name)) continue;
        const spec = wanted.get(name)!.spec;
        const specNonReg = /^(?:workspace:|link:|file:|portal:|patch:|git\+|https?:\/\/|npm:)/.test(spec);
        let source: PackageSource = 'other';
        if (!specNonReg) {
          if (isBerry) {
            // Berry resolution looks like "hono@npm:4.6.0"
            source = curResolved === `${name}@npm:${curVersion}` ? 'registry' : 'other';
          } else {
            // Classic v1 resolved URL points to registry.yarnpkg.com or registry.npmjs.org
            source = fromPublicRegistry(name, curResolved, [OPTIONAL_HOSTS.packages, 'registry.yarnpkg.com']) ? 'registry' : 'other';
          }
        }
        found.set(name, { version: curVersion, source });
      }
    }
    matchedNames = [];
    curVersion = '';
    curResolved = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('#')) {
      if (!line.trim()) flush();
      continue;
    }
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      flush();
      if (!line.trimEnd().endsWith(':')) continue;
      // Split header selectors like `"hono@^4.0.0", "hono@^4.6.0":` or `"hono@npm:^4.6.0":`
      const header = line.trimEnd().slice(0, -1);
      const hits: string[] = [];
      for (const part of header.split(',')) {
        const sel = unquoteYaml(part);
        const at = sel.lastIndexOf('@');
        if (at <= 0) continue;
        const name = sel.slice(0, at);
        const range = sel.slice(at + 1);
        const w = wanted.get(name);
        if (!w) continue;
        if (range === w.spec || range === `npm:${w.spec}`) hits.push(name);
      }
      matchedNames = hits;
      continue;
    }
    if (!matchedNames.length) continue;
    const trimmed = line.trim();
    if (isBerry) {
      if (trimmed.startsWith('version:')) curVersion = unquoteYaml(trimmed.slice('version:'.length));
      else if (trimmed.startsWith('resolution:')) curResolved = unquoteYaml(trimmed.slice('resolution:'.length));
    } else {
      if (trimmed.startsWith('version ')) curVersion = unquoteYaml(trimmed.slice('version '.length));
      else if (trimmed.startsWith('resolved ')) curResolved = unquoteYaml(trimmed.slice('resolved '.length));
    }
  }
  flush();

  const out: LockedDep[] = [];
  for (const [name, w] of wanted) {
    const hit = found.get(name);
    if (hit) out.push({ name, locked: hit.version, dev: w.dev, source: hit.source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- GitHub fetching -------------------------------------------------------

function githubFileUrl(repo: PackageRepo, folder: string | undefined, filename: string): string {
  const [owner, name] = repo.repo.split('/');
  const path = [...(folder ? folder.split('/') : []), filename].map(encodeURIComponent).join('/');
  const ref = repo.ref ? `?ref=${encodeURIComponent(repo.ref)}` : '';
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}${ref}`;
}

/** GitHub contents API URL for the lockfile. Every part was validated by parseConfig; encoded again here. */
export function lockfileUrl(repo: PackageRepo): string {
  const kind: LockfileKind = repo.lockfile ?? 'npm';
  return githubFileUrl(repo, repo.dir, LOCKFILE_FILES[kind]);
}

/** A response body as text, or null (and the rest left unread) once it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function fetchGithubRaw(token: string, url: string, repo: PackageRepo, filename: string, fileCache?: Map<string, string>, onFetch?: () => void): Promise<string> {
  if (fileCache?.has(url)) return fileCache.get(url)!;
  onFetch?.();
  const res = await allowedFetch(url, {
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
  if (res.status === 403 || res.status === 404) throw new LockfileError(`No ${filename} found in ${repo.repo}${repo.dir ? `/${repo.dir}` : ''}, or GITHUB_TOKEN has no Contents: Read on it.`);
  if (res.status >= 300 && res.status < 400) throw new LockfileError(`${repo.repo} has moved on GitHub. Update its name in Settings › Packages.`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const size = Number(res.headers.get('Content-Length') ?? 0);
  if (size > MAX_LOCKFILE_BYTES) {
    await res.body?.cancel();
    throw new LockfileError(`${filename} is too large to read.`);
  }
  // Content-Length can be missing or wrong, so the body itself is read with a hard limit.
  const text = await readCapped(res, MAX_LOCKFILE_BYTES);
  if (text === null) throw new LockfileError(`${filename} is too large to read.`);
  fileCache?.set(url, text);
  return text;
}

/** Lists GitHub repositories the fine-grained GITHUB_TOKEN can read, filtered by GITHUB_REPO_ALLOWLIST. */
export async function listGithubRepos(token: string, allowlist: string[] | null = null): Promise<{ repos: string[]; owner: string | null; error?: string }> {
  const res = await allowedFetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ambersight-packages',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
  });
  if (res.status === 401) return { repos: [], owner: null, error: 'GitHub rejected GITHUB_TOKEN (expired or invalid).' };
  if (res.status === 403) return { repos: [], owner: null, error: 'GITHUB_TOKEN could not list repositories (ensure Metadata: Read-only is enabled on the token).' };
  if (res.status >= 300 && res.status < 400) return { repos: [], owner: null, error: 'GitHub redirected the repository list request.' };
  if (!res.ok) return { repos: [], owner: null, error: `GitHub answered ${res.status}.` };
  const items = (await res.json()) as { full_name?: unknown }[];
  if (!Array.isArray(items)) return { repos: [], owner: null };
  const validRepo = /^[A-Za-z0-9-]{1,39}\/[\w.-]{1,100}$/;
  const repos = [...new Set(
    items
      .map((r) => (typeof r?.full_name === 'string' ? r.full_name : ''))
      .filter((n) => validRepo.test(n) && repoAllowed(allowlist, n)),
  )].sort((a, b) => a.localeCompare(b));
  const owners = [...new Set(repos.map((r) => r.split('/')[0]))];
  return { repos, owner: owners.length === 1 ? owners[0] : (owners[0] ?? null) };
}

/**
 * Which supported lockfiles one folder of a repository holds, from GitHub's listing of it ('' is the
 * repository root). Only the four lockfile names are looked for: no file is opened and no other
 * name is kept. Null when the folder is missing or GITHUB_TOKEN cannot read the repository.
 */
export async function lockfilesIn(token: string, repo: string, folder: string): Promise<LockfileKind[] | null> {
  const [owner, name] = repo.split('/');
  const path = folder ? `/${folder.split('/').map(encodeURIComponent).join('/')}` : '';
  const res = await allowedFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ambersight-packages',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    // As for a lockfile: a redirect would carry the token to another URL.
    redirect: 'manual',
  });
  if (res.status === 401) throw new LockfileError('GitHub rejected GITHUB_TOKEN (expired or revoked).');
  if (res.status >= 300 && res.status < 400) throw new LockfileError(`${repo} has moved on GitHub.`);
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const items = (await res.json()) as { name?: unknown; type?: unknown }[];
  if (!Array.isArray(items)) return [];
  const names = new Set(items.filter((i) => i?.type === 'file' && typeof i.name === 'string').map((i) => i.name as string));
  return LOCKFILE_KINDS.filter((k) => names.has(LOCKFILE_FILES[k]));
}

/** When a folder holds several lockfiles, a stray package-lock.json is the likeliest leftover. */
const LOCKFILE_PREFERENCE: readonly LockfileKind[] = ['pnpm', 'yarn', 'bun', 'npm'];

/**
 * The mapping fields for a build that runs in `rootDir`: a lockfile in that folder makes it the
 * lockfile folder; one only in the repository root makes the folder a workspace of a monorepo.
 */
export function layoutFor(rootKinds: LockfileKind[] | null, dirKinds: LockfileKind[] | null, rootDir: string): RepoLayout {
  const pick = (kinds: LockfileKind[] | null) => LOCKFILE_PREFERENCE.find((k) => kinds?.includes(k));
  const lockfile = (k: LockfileKind) => (k === 'npm' ? {} : { lockfile: k });
  const own = rootDir ? pick(dirKinds) : undefined;
  if (own) return { found: true, ...lockfile(own), dir: rootDir };
  const top = pick(rootKinds);
  if (!top) return { found: false };
  return { found: true, ...lockfile(top), ...(rootDir ? { workspace: rootDir } : {}) };
}

/**
 * Fetches and parses the lockfile. Errors never include the token or the response body.
 * `fileCache` deduplicates shared monorepo lockfiles within one scan so each file costs at most one subrequest.
 */
export async function fetchLockfile(token: string, repo: PackageRepo, fileCache?: Map<string, string>, onFetch?: () => void): Promise<LockedDep[]> {
  const kind: LockfileKind = repo.lockfile ?? 'npm';
  const filename = LOCKFILE_FILES[kind];
  const text = await fetchGithubRaw(token, lockfileUrl(repo), repo, filename, fileCache, onFetch);
  if (kind === 'npm') return parseLockfile(text, repo.workspace);
  if (kind === 'pnpm') return parsePnpmLock(text, repo.workspace);
  if (kind === 'bun') return parseBunLock(text, repo.workspace);
  // Yarn needs package.json (in the workspace folder if set, else alongside yarn.lock).
  const pkgDir = [repo.dir, repo.workspace].filter(Boolean).join('/') || undefined;
  const pkgText = await fetchGithubRaw(token, githubFileUrl(repo, pkgDir, 'package.json'), { ...repo, dir: pkgDir }, 'package.json', fileCache, onFetch);
  return parseYarnLock(text, pkgText);
}

// ---- npm registry & OSV.dev ------------------------------------------------

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

function osvSeverity(raw: unknown): AdvisorySeverity {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    if (s === 'critical' || s === 'high' || s === 'moderate' || s === 'low') return s;
    if (s === 'medium') return 'moderate';
  }
  return 'unknown';
}

function fixedVersionFor(affected: unknown, pkgName: string): string | null {
  if (!Array.isArray(affected)) return null;
  for (const item of affected as { package?: { ecosystem?: string; name?: string }; ranges?: { events?: { fixed?: string }[] }[] }[]) {
    if (item?.package?.ecosystem !== 'npm' || item?.package?.name !== pkgName) continue;
    for (const r of item.ranges ?? []) {
      for (const e of r.events ?? []) {
        if (typeof e.fixed === 'string' && VERSION.test(e.fixed)) return e.fixed;
      }
    }
  }
  return null;
}

/**
 * Checks public-registry (name, version) pairs against OSV.dev in one batch query, then hydrates
 * unique vulnerability IDs up to `hydrateBudget` for severity, summary and fixed version.
 * Sends no credentials and never sends private packages (callers pass only `source === 'registry'`).
 */
export async function fetchOsvBatch(
  pairs: { name: string; version: string }[],
  hydrateBudget = MAX_OSV_HYDRATE,
  onFetch?: () => void,
): Promise<{ name: string; version: string; advisories: PackageAdvisory[] }[]> {
  const valid = pairs.filter((p) => NPM_NAME.test(p.name) && VERSION.test(p.version)).slice(0, 200);
  if (!valid.length) return [];
  onFetch?.();
  const res = await allowedFetch(`https://${OPTIONAL_HOSTS.osv}/v1/querybatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ambersight-packages' },
    body: JSON.stringify({ queries: valid.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })) }),
    redirect: 'manual',
  }, undefined, [OPTIONAL_HOSTS.osv]);
  if (!res.ok) throw new Error(`OSV API answered ${res.status}`);
  const body = (await res.json()) as { results?: { vulns?: { id?: unknown }[] }[] };
  const results = Array.isArray(body.results) ? body.results : [];

  const rawByIdx: string[][] = valid.map((_, i) =>
    (results[i]?.vulns ?? [])
      .map((v) => (typeof v?.id === 'string' && ADVISORY_ID.test(v.id) ? v.id : ''))
      .filter(Boolean)
      .slice(0, 20),
  );
  const uniqueIds = [...new Set(rawByIdx.flat())];
  const details = new Map<string, { severity: AdvisorySeverity; summary: string | null; affected?: unknown }>();
  const hydrateCap = Math.min(Math.max(0, hydrateBudget), MAX_OSV_HYDRATE);

  for (const id of uniqueIds.slice(0, hydrateCap)) {
    onFetch?.();
    try {
      const r = await allowedFetch(`https://${OPTIONAL_HOSTS.osv}/v1/vulns/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'ambersight-packages' },
        redirect: 'manual',
      }, undefined, [OPTIONAL_HOSTS.osv]);
      if (!r.ok) continue;
      const v = (await r.json()) as { summary?: unknown; database_specific?: { severity?: unknown }; affected?: unknown };
      const cleanSummary = typeof v.summary === 'string' ? v.summary.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 200) : '';
      details.set(id, {
        severity: osvSeverity(v.database_specific?.severity),
        summary: cleanSummary || null,
        affected: v.affected,
      });
    } catch {
      // Keep the ID even if hydration fails; the finding still reports the vulnerability.
    }
  }

  return valid.map((p, i) => ({
    name: p.name,
    version: p.version,
    advisories: rawByIdx[i].map((id): PackageAdvisory => {
      const d = details.get(id);
      return {
        id,
        severity: d?.severity ?? 'unknown',
        summary: d?.summary ?? null,
        fixed: d ? fixedVersionFor(d.affected, p.name) : null,
      };
    }),
  }));
}

export function parseAdvisories(raw: string | null | undefined): PackageAdvisory[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as PackageAdvisory[]) : [];
  } catch {
    return [];
  }
}

// ---- Findings & read views -------------------------------------------------

export interface PackageRow {
  script: string;
  name: string;
  locked: string;
  /** Null for a package from elsewhere: nothing else is compared with the registry. */
  latest: string | null;
  dev: boolean;
  /** Null for a row stored before sources were recorded, until its lockfile is read again. */
  source: string | null;
  advisories?: PackageAdvisory[];
}

/**
 * Only a lockfile that shows another source ends the comparison. Rows from before sources were
 * recorded keep theirs, or their findings would resolve and reopen (losing acknowledgements) while
 * the lockfiles are read again over several scans. They use the version already stored: the scan
 * looks up only names the lockfile shows came from the registry, so no private name is sent.
 */
const isCompared = (source: string | null) => source !== 'other';
export const COMPARED_LATEST = `CASE WHEN p.source IS NOT 'other' THEN n.latest END AS latest`;
export const COMPARED_ADVISORIES = `CASE WHEN p.source IS NOT 'other' THEN a.advisories END AS advisories`;

const ADV_RANK: Record<AdvisorySeverity, number> = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };

/**
 * Findings per Worker: outdated direct dependencies, known vulnerabilities (when OSV is on),
 * or a lockfile that could not be read.
 * Packages from elsewhere get no advice: a newer public package of the same name is not an update.
 */
export function packageFindings(config: Config, account: string, rows: PackageRow[], errors: Map<string, string>, visible?: Set<string>): Finding[] {
  if (!config.modules.packages) return [];
  const out: Finding[] = [];
  for (const [script, error] of errors) {
    const repo = repoFor(config, account, script);
    if (!repo || (visible && !visible.has(script))) continue;
    out.push(finding('packages', script, 'lockfile-unreadable', 'warning', `Ambersight could not read this Worker's packages: ${error}`,
      { repo: repo.repo }, 'Check the repository, lockfile format, folder and branch in Settings › Packages, and that GITHUB_TOKEN can read the repository.', DOCS));
  }
  const byScript = new Map<string, PackageRow[]>();
  for (const r of rows) byScript.set(r.script, [...(byScript.get(r.script) ?? []), r]);
  for (const [script, list] of byScript) {
    if (!repoFor(config, account, script) || errors.has(script) || (visible && !visible.has(script))) continue;
    const compared = list.filter((r) => isCompared(r.source));

    // 1. Outdated versions: runtime major behind = warning; dev-only major or minor/patch = info.
    const behind = compared.map((r) => ({ ...r, gap: semverGap(r.locked, r.latest) })).filter((r) => r.gap === 'major' || r.gap === 'minor' || r.gap === 'patch');
    if (behind.length) {
      const runtimeMajors = behind.filter((r) => !r.dev && r.gap === 'major');
      const devMajors = behind.filter((r) => r.dev && r.gap === 'major');
      const majors = [...runtimeMajors, ...devMajors];
      const worst = [...runtimeMajors, ...devMajors, ...behind.filter((r) => r.gap !== 'major')].slice(0, 3).map((r) => `${r.name} ${r.locked} → ${r.latest}`);
      const majorNote = runtimeMajors.length
        ? `, ${majors.length} by a major version`
        : devMajors.length
          ? `, ${devMajors.length} dev ${devMajors.length === 1 ? 'dependency' : 'dependencies'} by a major version`
          : '';
      out.push(finding('packages', script, 'outdated', runtimeMajors.length ? 'warning' : 'info',
        `${behind.length} of ${compared.length} direct dependencies from the npm registry are behind the latest release${majorNote}: ${worst.join(', ')}.`,
        { outdated: behind.length, major: majors.length, runtimeMajor: runtimeMajors.length, total: compared.length },
        'Run npm outdated in the repository and update, reading the changelog of each major version first. See the full list on the Packages page.', DOCS));
    }

    // 2. Known vulnerabilities (opt-in OSV check).
    if (config.modules.packagesOsv) {
      const vulnRows = compared.filter((r) => (r.advisories?.length ?? 0) > 0);
      if (vulnRows.length) {
        const allAdvs = vulnRows.flatMap((r) => (r.advisories ?? []).map((a) => ({ ...a, pkg: r.name, locked: r.locked, dev: r.dev })));
        allAdvs.sort((a, b) => Number(a.dev) - Number(b.dev) || ADV_RANK[a.severity] - ADV_RANK[b.severity]);
        const runtimeHigh = allAdvs.filter((a) => !a.dev && (a.severity === 'critical' || a.severity === 'high'));
        const top = allAdvs.slice(0, 3).map((a) => `${a.pkg}@${a.locked} (${a.id}${a.fixed ? `, fix ${a.fixed}` : ''})`);
        out.push(finding('packages', script, 'vulnerable', runtimeHigh.length ? 'critical' : 'warning',
          `${allAdvs.length} known ${allAdvs.length === 1 ? 'vulnerability' : 'vulnerabilities'} in ${vulnRows.length} direct ${vulnRows.length === 1 ? 'dependency' : 'dependencies'}: ${top.join(', ')}.`,
          { vulnerable: vulnRows.length, advisories: allAdvs.length, runtimeCriticalHigh: runtimeHigh.length },
          'Update the affected packages to a fixed version, test with wrangler dev, commit the lockfile and deploy. See the Packages page for advisory links.', OSV_DOCS));
      }
    }
  }
  return out;
}

export interface RawPackageDbRow {
  script?: string;
  name: string;
  locked: string;
  dev: number;
  latest: string | null;
  source: string | null;
  advisories?: string | null;
}

export function toPackageItem(r: RawPackageDbRow): PackageItem {
  const compared = isCompared(r.source);
  const advs = compared ? parseAdvisories(r.advisories) : [];
  return {
    name: r.name,
    locked: r.locked,
    latest: r.latest,
    gap: semverGap(r.locked, r.latest),
    dev: r.dev === 1,
    compared,
    ...(advs.length ? { advisories: advs } : {}),
  };
}

/** SQL selecting a Worker's (or account's) packages with latest version and optional OSV advisories. */
export function packagesQuerySql(osv: boolean, singleWorker = false): string {
  const cols = `${singleWorker ? '' : 'p.script, '}p.name, p.locked, p.dev, p.source, ${COMPARED_LATEST}${osv ? `, ${COMPARED_ADVISORIES}` : ''}`;
  const advJoin = osv ? ' LEFT JOIN npm_advisories a ON a.name = p.name AND a.version = p.locked' : '';
  const where = singleWorker ? 'WHERE p.account = ?1 AND p.script = ?2 ORDER BY p.name' : 'WHERE p.account = ?1 ORDER BY p.script, p.name';
  return `SELECT ${cols} FROM worker_packages p LEFT JOIN npm_latest n ON n.name = p.name${advJoin} ${where}`;
}

export function formatWorkerPackages(
  repo: PackageRepo,
  checkedAt: string | null,
  error: string | null,
  rows: RawPackageDbRow[],
  allowlist: string[] | null = null,
): WorkerPackages {
  const allowed = repoAllowed(allowlist, repo.repo);
  return {
    repo: repo.repo,
    dir: repo.dir ?? null,
    ...(repo.workspace ? { workspace: repo.workspace } : {}),
    ...(repo.lockfile && repo.lockfile !== 'npm' ? { lockfile: repo.lockfile } : {}),
    checkedAt,
    error: allowed ? error : REPO_NOT_ALLOWED,
    packages: allowed ? rows.map(toPackageItem) : [],
  };
}

/** The Packages page: every mapped Worker in scope in one account, with its direct dependencies. */
export async function buildPackages(db: D1Database, account: string, config: Config, github: boolean, allowlist: string[] | null = null): Promise<PackagesView> {
  const view: PackagesView = { enabled: config.modules.packages, github, osvEnabled: config.modules.packagesOsv, unmappedWorkers: [], workers: [] };
  if (!config.modules.packages) return view;
  const [workersR, rowsR] = await db.batch([
    db.prepare('SELECT name, tags, packages_checked_at, packages_error FROM workers WHERE account = ?1').bind(account),
    db.prepare(packagesQuerySql(config.modules.packagesOsv, false)).bind(account),
  ]);
  const rows = rowsR.results as (RawPackageDbRow & { script: string })[];
  for (const w of workersR.results as { name: string; tags: string | null; packages_checked_at: string | null; packages_error: string | null }[]) {
    if (!inScope(config, w.name, groupsFor(config, w.name, w.tags ? (JSON.parse(w.tags) as string[]) : []))) continue;
    const repo = repoFor(config, account, w.name);
    if (!repo) {
      view.unmappedWorkers!.push(w.name);
      continue;
    }
    view.workers.push({
      name: w.name,
      ...formatWorkerPackages(repo, w.packages_checked_at, w.packages_error, rows.filter((r) => r.script === w.name), allowlist),
    });
  }
  view.unmappedWorkers!.sort((a, b) => a.localeCompare(b));
  view.workers.sort((a, b) => a.name.localeCompare(b.name));
  return view;
}
