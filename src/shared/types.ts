// Types shared by the Worker and the Svelte UI.
// SPDX-License-Identifier: AGPL-3.0-only

export type Severity = 'critical' | 'warning' | 'info';
export type ModuleId =
  | 'budget' | 'errors' | 'runaway' | 'cron' | 'usage'
  | 'deprecation' | 'exposure' | 'zombies' | 'timeline' | 'health'
  | 'pages' | 'security' | 'drift' | 'deploys' | 'packages';

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

export interface QuotaStatus {
  metric: string;
  label: string;
  used: number;
  limit: number;
  share: number;
  projectedLimitAt: string | null;
}

export interface StorageStatus {
  kind: 'd1' | 'kv' | 'r2' | 'do';
  /** Database, namespace or bucket name, or "All <product>" for an account total. */
  label: string;
  bytes: number;
  /** The cap it is measured against; null when there is none. */
  limit: number | null;
  share: number | null;
}

export interface CostEstimate {
  monthToDate: number;
  forecast: number;
  /** Forecast by product, largest first. */
  breakdown: { label: string; amount: number }[];
  /** Workers by list-price cost over the last 7 days, scaled to a month. */
  topWorkers: { name: string; amount: number }[];
  /** Ambersight started tracking this account after the month began, so the start is extrapolated. */
  partialMonth: boolean;
  pricesAsOf: string;
}

export interface PagesSummary {
  name: string;
  subdomain: string | null;
  domains: string[];
  latest: { createdOn: string; status: string; stage: string; environment: string; branch: string | null } | null;
  /** Pages Functions requests in the last 24 hours (they share the Workers daily budget). */
  requests24h: number;
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
  /** The other free daily limits with usage today (Free plan only). */
  quotas: QuotaStatus[];
  /** Storage against its caps, largest share first. */
  storage: StorageStatus[];
  /** Estimated bill (Workers Paid only, when the cost module is on). */
  cost: CostEstimate | null;
  /** Pages projects, when the Pages module is on and the token can read them. */
  pages: PagesSummary[];
  /** Optional bindings present on this install. */
  features: { queue: boolean; ai: boolean; turnstile: boolean; github: boolean };
  findings: Finding[];
  /** What removing unused storage would free, and housekeeping resolved in the last 7 days. */
  housekeeping: {
    frees: { kind: 'd1' | 'kv' | 'r2' | 'do'; bytes: number; share: number | null }[];
    /** Estimated monthly storage cost saved; null without the cost estimate. */
    monthlySaving: number | null;
    resolvedThisWeek: number;
  };
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
  /**
   * deploy: a Worker deployment. cf-alert: a notification Cloudflare sent to the account.
   * audit: an audit log entry. pages: a Pages project's latest deploy. incident: a Cloudflare status incident.
   */
  kind: 'deploy' | 'cf-alert' | 'audit' | 'pages' | 'incident';
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

/** A finding in the inbox: any status, with its history counters. */
export interface FindingListItem extends Finding {
  lastSeen: string;
  /** When it was last acknowledged, snoozed or reopened. */
  statusAt: string | null;
  snoozeUntil: string | null;
  reopenCount: number;
}

/** One change in a finding's life. */
export interface FindingEvent {
  at: string;
  kind: 'opened' | 'reopened' | 'escalated' | 'eased' | 'resolved' | 'acknowledged' | 'snoozed' | 'restored' | 'alerted';
  severity: Severity | null;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, warning: 3, info: 1 };

/** How far a locked package version is behind the latest release on npm. */
export type Gap = 'major' | 'minor' | 'patch' | 'none' | 'unknown';

/** The Resources page: every KV namespace, D1 database, R2 bucket and queue, and who uses it. */
export interface ResourcesView {
  /** False until the first inventory refresh and every Worker's bindings are in. */
  ready: boolean;
  /** Days without operations after which bound storage counts as idle. */
  windowDays: number;
  resources: {
    kind: 'kv' | 'd1' | 'r2' | 'queues';
    id: string;
    name: string;
    boundBy: string[];
    /** Used without a binding: a queue consumer or a dead-letter queue. */
    inUse: boolean;
    lastActiveHour: string | null;
    /** quiet: no operations in windowDays. unknown: this kind's operations are not read, or not for that long yet. */
    activity: 'recent' | 'earlier' | 'quiet' | 'unknown';
    bytes: number | null;
    objects: number | null;
    status: 'in-use' | 'idle' | 'unbound' | 'outside';
  }[];
}

/** The Packages page (optional check). */
export interface PackagesView {
  enabled: boolean;
  github: boolean;
  workers: {
    name: string;
    repo: string;
    dir: string | null;
    checkedAt: string | null;
    error: string | null;
    packages: { name: string; locked: string; latest: string | null; gap: Gap; dev: boolean }[];
  }[];
}
