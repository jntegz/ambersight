// SPDX-License-Identifier: AGPL-3.0-only
import type { Config } from '../../../src/shared/config';
import type { PersonDataStep } from '../../../src/shared/personData';
import type { SessionMethod } from './auth.svelte';
import { createPasskey, usePasskey, type CreationOptionsJSON, type RequestOptionsJSON } from './passkey';
import type { AccountSummary, AdminLogView, AnalyticsView, BuildSourcesView, RepoLayout, FindingEvent, FindingListItem, Overview, PackagesView, Range, ResourcesView, SelfCost, SetupStatus, SinceView, TimelineEntry, WorkerDetail } from '../../../src/shared/types';

export interface ScanResult {
  skipped?: boolean;
  workers: number;
  findings: number;
  subrequests: number;
  warnings: string[];
  detailRemaining?: number;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** The server's answer when a request names an account this install does not watch. */
export const UNKNOWN_ACCOUNT = 'unknown_account';
let accountRefused: (() => void) | null = null;
/** Called when the remembered account is refused, so the app can fall back to the default one. */
export const onAccountRefused = (fn: () => void) => { accountRefused = fn; };

/** The server's answer when there is no session. A wrong passphrase is also a 401, but not this one. */
export const NOT_SIGNED_IN = 'not_signed_in';
let sessionEnded: (() => void) | null = null;
/** Called from any request that finds the session gone, whichever page sent it. */
export const onSessionEnded = (fn: () => void) => { sessionEnded = fn; };

/** How long a sign-out may take before the browser reports it as not confirmed. */
const LOGOUT_TIMEOUT_MS = 10_000;

/** Counts sign-ins in this tab: a refusal of a request sent before the latest one is out of date. */
let signIns = 0;
export const signInCount = () => signIns;

/** What may still be sent once the session has ended here; the server may not know yet. */
const OPEN_WITHOUT_SESSION = new Set(['/api/session', '/api/login', '/api/logout', '/api/login/passkey/options', '/api/login/passkey', '/api/login/link', '/api/login/link/confirm']);
let sessionClosed = false;
/** Until the next sign-in nothing else is asked for, so no late page action refills the offline copies. */
export const closeSession = () => { sessionClosed = true; };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (sessionClosed && !OPEN_WITHOUT_SESSION.has(path)) throw new ApiError('You are signed out.', 0);
  const startedIn = signIns;
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  }).catch((e: unknown) => {
    if (navigator.onLine !== false) throw e;
    throw new ApiError(init?.method ? 'You are offline. Try again when you are connected.' : 'You are offline, and this browser has no recent copy of this page.', 0);
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, code } = body as { error?: string; code?: string };
    if (startedIn !== signIns) {
      // About the session before this one. Pages sign out on any 401, so it does not stay a 401.
      throw new ApiError(error ?? res.statusText, res.status === 401 ? 0 : res.status, code);
    }
    if (code === UNKNOWN_ACCOUNT) accountRefused?.();
    if (res.status === 401 && code === NOT_SIGNED_IN) sessionEnded?.();
    throw new ApiError(error ?? res.statusText, res.status, code);
  }
  return body as T;
}

const q = (account?: string) => (account ? `?account=${encodeURIComponent(account)}` : '');

export interface TokenInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  /** Issued under a passphrase that has since changed: it no longer works. */
  invalidated: boolean;
  accounts: 'all' | string[];
  /** May read deploy authors, audit actors and the free text that can carry them. */
  people: boolean;
  /** Created before tokens had a scope: every account, no person-linked data. */
  olderScope: boolean;
}

/** The server's codes for a sensitive step that needs proof the request did not carry. */
export const PASSKEY_REQUIRED = 'passkey_required';
export const PASSPHRASE_REQUIRED = 'passphrase_required';

/** What confirms a sensitive step: a passkey answer for this session, or (with no passkeys) the passphrase. */
export type Proof = { passkey?: unknown; passphrase?: string };

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  current: boolean;
}

export interface SessionState {
  authenticated: boolean;
  turnstileSiteKey?: string | null;
  signIn?: { passkeys: boolean; link: boolean };
  method?: SessionMethod;
  fresh?: boolean;
}

/** Asks this device's passkey to confirm a step. Opens the browser's passkey prompt. */
async function confirmWithPasskey(): Promise<Proof> {
  const options = await call<RequestOptionsJSON>('/api/passkeys/options', { method: 'POST', body: JSON.stringify({ purpose: 'confirm' }) });
  return { passkey: await usePasskey(options) };
}

/**
 * Runs a sensitive step with the proof it needs. With passkeys the browser's prompt opens first.
 * Without, `passphrase` is sent; when the server still asks for a passkey (one was added in another
 * tab), the prompt opens and the step runs once more.
 */
export async function withProof<T>(passkeys: boolean, passphrase: string, run: (proof: Proof) => Promise<T>): Promise<T> {
  if (passkeys) return run(await confirmWithPasskey());
  try {
    return await run(passphrase ? { passphrase } : {});
  } catch (e) {
    if (e instanceof ApiError && e.code === PASSKEY_REQUIRED) return run(await confirmWithPasskey());
    throw e;
  }
}

function signedIn<T>(done: T): T {
  signIns++;
  sessionClosed = false;
  return done;
}

export const api = {
  adminLog: () => call<AdminLogView>('/api/admin-events'),
  tokens: () => call<TokenInfo[]>('/api/tokens'),
  createToken: (name: string, days: number, proof: Proof, accounts: 'all' | string[], people: boolean) =>
    call<{ token: string; info: TokenInfo }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name, days, ...proof, accounts, people }) }),
  revokeToken: (id: string) => call<{ ok: true }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  session: () => call<SessionState>('/api/session'),
  login: async (passphrase: string, turnstile?: string) =>
    signedIn(await call<{ ok: true; recovery?: true }>('/api/login', { method: 'POST', body: JSON.stringify({ passphrase, ...(turnstile ? { turnstile } : {}) }) })),
  /** Opens the browser's passkey prompt for this site and signs in with the passkey chosen. */
  loginWithPasskey: async () => {
    const options = await call<RequestOptionsJSON>('/api/login/passkey/options', { method: 'POST', body: '{}' });
    const response = await usePasskey(options);
    return signedIn(await call<{ ok: true }>('/api/login/passkey', { method: 'POST', body: JSON.stringify({ response }) }));
  },
  /** E-mails a sign-in link to the operators. It works only in this browser. */
  requestLink: (turnstile?: string) => call<{ ok: true }>('/api/login/link', { method: 'POST', body: JSON.stringify(turnstile ? { turnstile } : {}) }),
  confirmLink: async (token: string) => signedIn(await call<{ ok: true }>('/api/login/link/confirm', { method: 'POST', body: JSON.stringify({ token }) })),
  passkeys: () => call<{ passkeys: PasskeyInfo[]; method: SessionMethod; fresh: boolean }>('/api/passkeys'),
  /**
   * Registers a passkey on this device. The browser's prompt opens first; when the server then asks
   * for proof, `prove` supplies it and the same registration is sent again.
   */
  addPasskey: async (name: string, prove: (code: string) => Promise<Proof>) => {
    const options = await call<CreationOptionsJSON>('/api/passkeys/options', { method: 'POST', body: JSON.stringify({ purpose: 'register' }) });
    const response = await createPasskey(options);
    const send = (proof: Proof) => call<{ info: PasskeyInfo; first: boolean }>('/api/passkeys', { method: 'POST', body: JSON.stringify({ response, name, ...proof }) });
    try {
      return await send({});
    } catch (e) {
      if (e instanceof ApiError && (e.code === PASSKEY_REQUIRED || e.code === PASSPHRASE_REQUIRED)) {
        return send(e.code === PASSKEY_REQUIRED ? await confirmWithPasskey() : await prove(e.code));
      }
      throw e;
    }
  },
  /** Proof is asked for only when the server needs it: a fresh recovery session needs none. */
  removePasskey: async (id: string) => {
    const send = (proof: Proof) => call<{ ok: true; last: boolean }>(`/api/passkeys/${encodeURIComponent(id)}/remove`, { method: 'POST', body: JSON.stringify(proof) });
    try {
      return await send({});
    } catch (e) {
      if (e instanceof ApiError && e.code === PASSKEY_REQUIRED) return send(await confirmWithPasskey());
      throw e;
    }
  },
  endOtherSessions: async () => {
    const send = (proof: Proof) => call<{ ok: true; ended: number }>('/api/sessions/end-others', { method: 'POST', body: JSON.stringify(proof) });
    try {
      return await send({});
    } catch (e) {
      if (e instanceof ApiError && e.code === PASSKEY_REQUIRED) return send(await confirmWithPasskey());
      throw e;
    }
  },
  logout: () => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), LOGOUT_TIMEOUT_MS);
    return call<{ ok: true }>('/api/logout', { method: 'POST', signal: stop.signal }).finally(() => clearTimeout(timer));
  },
  overview: (account?: string) => call<Overview>(`/api/overview${q(account)}`),
  /** The "All accounts" view. */
  accounts: () => call<AccountSummary[]>('/api/accounts'),
  /** The full set of accounts to watch. */
  saveAccounts: (ids: string[]) => call<AccountSummary[]>('/api/accounts', { method: 'PUT', body: JSON.stringify({ ids }) }),
  scan: (account?: string) => call<ScanResult>('/api/scan', { method: 'POST', body: JSON.stringify(account ? { account } : {}) }),
  timeline: (days: number, account?: string) => call<TimelineEntry[]>(`/api/timeline?days=${days}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  packages: (account?: string) => call<PackagesView>(`/api/packages${q(account)}`),
  githubRepos: () => call<{ repos: string[]; owner: string | null; error?: string }>('/api/github-repos'),
  /** The repository Cloudflare builds each Worker from (needs the optional Workers CI Read). */
  buildSources: (account?: string) => call<BuildSourcesView>(`/api/build-sources${q(account)}`),
  /** Which lockfile a repository holds, and whether `dir` has its own or is a workspace. */
  repoLayout: (repo: string, dir: string) => call<RepoLayout>(`/api/repo-layout?repo=${encodeURIComponent(repo)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`),
  resources: (account?: string) => call<ResourcesView>(`/api/resources${q(account)}`),
  selfCost: (account?: string) => call<SelfCost>(`/api/self-cost${q(account)}`),
  setup: (account?: string) => call<SetupStatus>(account ? `/api/setup?account=${encodeURIComponent(account)}` : '/api/setup'),
  completeSetup: (body: { timeZone: string; confirmReadOnly?: true; accountId?: string; accountIds?: string[]; replacePassphrase?: { current: string; next: string } }) =>
    call<{ ok: true }>('/api/setup/complete', { method: 'POST', body: JSON.stringify(body) }),
  config: () => call<Config>('/api/config'),
  /**
   * Recording who made changes is sent only when the person changed it in this save, so a page opened
   * earlier cannot put back an old value. `erase`: they agreed that turning it off erases the stored
   * names. `resume`: they turned it on. The answer holds the value in force.
   */
  saveConfig: (config: Config, recording: 'keep' | 'erase' | 'resume' = 'keep') => {
    const { recordAttribution, ...rest } = config;
    const body = recording === 'keep' ? rest
      : { ...rest, recordAttribution, ...(recording === 'erase' ? { confirmErase: true } : { confirmRecord: true }) };
    return call<Config & { attributionErasure?: 'done' | 'running' }>('/api/config', { method: 'PUT', body: JSON.stringify(body) });
  },
  testNotify: (channel: 'email' | 'webhook') => call<{ ok: true }>('/api/notify/test', { method: 'POST', body: JSON.stringify({ channel }) }),
  /** Signs out every session, including this one. */
  changePassphrase: (current: string, next: string) =>
    call<{ ok: true }>('/api/passphrase', { method: 'POST', body: JSON.stringify({ current, next }) }),
  /** One bounded step. POST, so the identifier stays out of URLs. */
  personalDataPreview: (identifier: string, cursor: string | null) =>
    call<PersonDataStep>('/api/personal-data/preview', { method: 'POST', body: JSON.stringify({ identifier, cursor }) }),
  /** `proof` goes with the first step only; the signed cursor carries the later ones. */
  personalDataRemove: (identifier: string, proof: Proof, confirmation: string, cursor: string | null) =>
    call<PersonDataStep>('/api/personal-data/remove', { method: 'POST', body: JSON.stringify({ identifier, ...proof, confirmation, cursor }) }),
  acknowledge: (id: string) => call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' }),
  snooze: (id: string, days: 7 | 30 | 90) =>
    call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/snooze`, { method: 'POST', body: JSON.stringify({ days }) }),
  /** Undo an acknowledge or a snooze. */
  restore: (id: string) => call<{ ok: true }>(`/api/findings/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  findings: (status: 'open' | 'acknowledged' | 'snoozed' | 'resolved', account?: string) =>
    call<FindingListItem[]>(`/api/findings?status=${status}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  changes: (since: string, account?: string) =>
    call<SinceView>(`/api/changes?since=${encodeURIComponent(since)}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  history: (id: string) => call<FindingEvent[]>(`/api/findings/${encodeURIComponent(id)}/history`),
  analytics: (range: Range, account?: string) => call<AnalyticsView>(`/api/analytics?range=${range}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  worker: (name: string, range: Range, account?: string) =>
    call<WorkerDetail>(`/api/workers/${encodeURIComponent(name)}?range=${range}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  /** A whole group at once. */
  bulk: (ids: string[], action: 'acknowledge' | 'snooze' | 'restore', days?: 7 | 30 | 90) =>
    call<{ ok: true; changed: number }>('/api/findings/bulk', { method: 'POST', body: JSON.stringify({ ids, action, days }) }),
};

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export const num = (n: number) => n.toLocaleString('en-US');

export const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** Percentage with one decimal under 10%, "<0.1%" for tiny non-zero shares. */
export const pct = (share: number) => {
  const p = share * 100;
  return (p > 0 && p < 0.1 ? '<0.1' : p.toFixed(p < 10 ? 1 : 0)) + '%';
};

/** UTC day labels for a series of `n` days ending today (matches WorkerSummary.spark). */
export function dayLabels(n = 7, now = Date.now()): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now - (n - 1 - i) * 86_400_000);
    return i === n - 1 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  });
}

/** Stable DOM id for a Worker's card or table row. */
export const workerId = (name: string) => `w-${name}`;

/** The Worker page. */
export const workerHref = (name: string) => `#/worker/${encodeURIComponent(name)}`;

/** Signed change against the period before: "+12%", "−3%", "new" or "" when both are zero. */
export function change(now: number, before: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (!before) return now ? { text: 'new', dir: 'up' } : { text: '', dir: 'flat' };
  const r = (now - before) / before;
  if (Math.abs(r) < 0.005) return { text: '0%', dir: 'flat' };
  const p = Math.abs(r) * 100;
  return { text: `${r > 0 ? '+' : '−'}${p >= 100 ? Math.round(p).toLocaleString('en-US') : p.toFixed(p < 10 ? 1 : 0)}%`, dir: r > 0 ? 'up' : 'down' };
}

export const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** "1.2 ms" style durations from milliseconds. */
export const ms = (n: number | null) => (n == null ? '–' : n < 1 ? `${n.toFixed(2)} ms` : n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n).toLocaleString('en-US')} ms`);

export const bytes = (n: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toPrecision(2)} ${units[i]}`;
};
