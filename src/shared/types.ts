// Types shared by the Worker and the Svelte UI.
// SPDX-License-Identifier: AGPL-3.0-only

export type Severity = 'critical' | 'warning' | 'info';
export type ModuleId =
  | 'budget' | 'errors' | 'runaway' | 'cron' | 'usage'
  | 'deprecation' | 'exposure' | 'zombies' | 'timeline';

export interface Finding {
  id: string;
  script: string; // "*" = whole account
  module: ModuleId;
  severity: Severity;
  code: string;
  message: string;
  evidence: Record<string, number | string>;
  action: string;
  docsUrl?: string;
  firstSeen?: string;
  status?: 'open' | 'acknowledged' | 'snoozed' | 'resolved';
}

export interface WorkerSummary {
  name: string;
  score: number;
  requests24h: number;
  errors24h: number;
  spark: number[]; // requests per day, last 7 days, oldest first
  spark24: number[]; // requests per hour, last 24 hours, oldest first
  deployedOn: string | null;
  handlers: string[];
  groups: string[];
  /** Public URLs: routes, custom domains, workers.dev. */
  entryPoints: string[];
  topFinding: Finding | null;
  latestFindingAt: string | null;
}

export interface BudgetStatus {
  plan: 'free' | 'paid';
  limit: number;
  usedToday: number;
  share: number; // 0..1
  projectedLimitAt: string | null; // ISO time the limit is projected to be hit today
  warnAt: number;
  criticalAt: number;
}

export interface Overview {
  /** The account shown; null before setup. */
  account: { id: string; label: string; plan: 'free' | 'paid' } | null;
  /** How many accounts this install watches. The account switcher appears above 1. */
  accountCount: number;
  /** Scans that failed in a row for this account, and the last error. */
  scanHealth: { failures: number; lastError: string | null; lastAttemptAt: string | null };
  lastScanAt: string | null;
  setupDone: boolean;
  update: { current: string; latest: string; url: string } | null;
  totals: { workers: number; needAttention: number; requestsToday: number; errorsToday: number };
  budget: BudgetStatus | null;
  findings: Finding[];
  workers: WorkerSummary[];
  groups: string[];
}

/** One row of the "All accounts" view. */
export interface AccountSummary {
  id: string;
  label: string;
  plan: 'free' | 'paid';
  workers: number;
  findings: Record<Severity, number>;
  requestsToday: number;
  errorsToday: number;
  /** Share of the free daily request limit; null on Workers Paid. */
  budgetShare: number | null;
  lastScanAt: string | null;
  scanFailures: number;
  lastError: string | null;
}

export interface TimelineEntry {
  script: string;
  id: string;
  createdOn: string;
  author: string | null;
  message: string | null;
  source: string | null;
  groups: string[];
  /** Finding codes whose problem started within the correlation window after this deploy. */
  correlated: string[];
}

export interface SetupStatus {
  tokenActive: boolean;
  tokenError: string | null;
  accountId: string | null;
  accountName: string | null;
  detectedPlan: 'free' | 'paid' | null;
  /** null = the token cannot read its own permissions, so scopes could not be checked. */
  writeScopes: string[] | null;
  readScopes: string[] | null;
  email: { configured: boolean; from: string | null; to: string[] };
  webhook: { configured: boolean; kind: string | null };
  setupDone: boolean;
  passphraseFromSettings: boolean;
  /** Every account the token can see (up to 20); the wizard offers a choice when there are several. */
  accounts: { id: string; name: string }[];
  /** Accounts already watched (chosen at setup or pinned). */
  watched: string[];
  /** CF_ACCOUNT_ID is set, so the accounts cannot be chosen in the UI. */
  accountPinned: boolean;
  /** This request came through Cloudflare Access. Display only: never used to grant access. */
  behindAccess: boolean;
}

export interface SelfCostDay {
  day: string;
  cronRuns: number;
  apiRequests: number;
  subrequests: number;
  rowsRead: number;
  rowsWritten: number;
}

export interface SelfCost {
  days: SelfCostDay[];
  lastScan: { at: string | null; subrequests: number; durationMs: number; warnings: string[] };
  allowances: { requestsPerDay: number; subrequestsPerRun: number; rowsWrittenPerDay: number; rowsReadPerDay: number };
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, warning: 3, info: 1 };
