// Types shared by the Worker and the Svelte UI.
// SPDX-License-Identifier: AGPL-3.0-only

export type Severity = 'critical' | 'warning' | 'info';
export type ModuleId = 'budget' | 'errors' | 'runaway' | 'cron';

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
  topFinding: Finding | null;
}

export interface BudgetStatus {
  plan: 'free' | 'paid';
  limit: number;
  usedToday: number;
  share: number; // 0..1
  projectedLimitAt: string | null; // ISO time the limit is projected to be hit today
}

export interface Overview {
  lastScanAt: string | null;
  totals: { workers: number; needAttention: number; requestsToday: number; errorsToday: number };
  budget: BudgetStatus | null;
  findings: Finding[];
  workers: WorkerSummary[];
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, warning: 3, info: 1 };
