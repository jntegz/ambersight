// Ambersight configuration: one JSON document stored in D1 (settings.config).
// Shared by the Worker (validation, defaults) and the UI (Settings screen, import/export).
// SPDX-License-Identifier: AGPL-3.0-only

import { CHECK_PATTERN } from './findings';

export type PlanSetting = 'auto' | 'free' | 'paid';
export type InstantChannel = 'email' | 'webhook' | 'both' | 'off';
export type DigestFrequency = 'daily' | 'weekly' | 'off';

export interface Thresholds {
  /** Share of the free daily request limit, e.g. 0.7. */
  budgetWarn: number;
  budgetCritical: number;
  /** Error rate over 24 hours. */
  errorWarn: number;
  errorCritical: number;
  /** Error rate this many times the 7-day error rate is a warning. */
  errorBaselineMultiplier: number;
  /** Last full hour vs the 7-day hourly median. */
  runawayMultiplier: number;
  /** p99 CPU as share of the plan limit. */
  cpuShareWarn: number;
  compatAgeMonths: number;
  zombieDays: number;
  deployWindowMinutes: number;
  /** A Worker with under 72 hours of history: requests in one hour that are a burst on their own. */
  newWorkerHourlyRequests: number;
  /** Same for storage and Durable Object operations on a resource with under 72 hours of history. */
  newResourceHourlyOps: number;
}

export interface ModuleSwitches {
  usage: boolean; // M4
  cron: boolean; // M5
  errors: boolean; // M6
  deprecation: boolean; // M2
  exposure: boolean; // M3
  zombies: boolean; // M7
  timeline: boolean; // M8
  /** M3 option: check Cloudflare Access coverage (needs Access: Apps and Policies Read). */
  access: boolean;
  /** Estimated cost in dollars on Workers Paid. */
  cost: boolean;
  /** Notifications Cloudflare sent to the account, on the timeline (needs Notifications Read). */
  cfAlerts: boolean;
}

export interface SeverityRoute {
  instant: InstantChannel;
  digest: boolean;
}

export interface Config {
  version: 1;
  plan: PlanSetting;
  /** Minutes between scans. The cron fires every 15 minutes; runs in between are skipped. */
  scanIntervalMinutes: number;
  /** Hours between full inventory refreshes (storage, routes, domains, Access). */
  inventoryIntervalHours: number;
  /** UTC hour the inventory refresh prefers. */
  inventoryHourUtc: number;
  modules: ModuleSwitches;
  /** Individual checks switched off, as "module:check" (see checkOf in shared/findings.ts). */
  mutedChecks: string[];
  thresholds: Thresholds;
  /** Overrides keyed by Worker name or "group:<name>". Worker beats group beats global. */
  overrides: Record<string, Partial<Thresholds>>;
  scope: { include: string[]; exclude: string[] };
  /** Group name -> Worker name patterns (`*` wildcard). Cloudflare tags become groups too. */
  groups: Record<string, string[]>;
  alerts: {
    critical: SeverityRoute;
    warning: SeverityRoute;
    info: SeverityRoute;
    quietHours: { start: string; end: string } | null; // "22:00", "07:00" in timeZone
  };
  digest: {
    frequency: DigestFrequency;
    weekday: number; // 0 = Sunday
    hour: number; // local hour in timeZone
    /** Extra digest per group, sent only to addresses also listed in DIGEST_TO. */
    groupRecipients: Record<string, string[]>;
  };
  timeZone: string;
  retentionDays: number;
  updateCheck: boolean;
  /** Per-account settings, keyed by Cloudflare account ID. */
  accounts: Record<string, AccountSettings>;
}

export interface AccountSettings {
  /** Name shown in the dashboard and in alerts, instead of the Cloudflare account name. */
  label?: string;
  /** Overrides the global plan for this account. */
  plan?: PlanSetting;
  /** Extra digest for this account (a client), sent only to addresses also listed in DIGEST_TO. */
  digestTo?: string[];
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  budgetWarn: 0.7,
  budgetCritical: 0.9,
  errorWarn: 0.02,
  errorCritical: 0.1,
  errorBaselineMultiplier: 3,
  runawayMultiplier: 5,
  cpuShareWarn: 0.8,
  compatAgeMonths: 12,
  zombieDays: 30,
  deployWindowMinutes: 60,
  newWorkerHourlyRequests: 50_000,
  newResourceHourlyOps: 100_000,
};

export function defaultConfig(): Config {
  return {
    version: 1,
    plan: 'auto',
    scanIntervalMinutes: 60,
    inventoryIntervalHours: 24,
    inventoryHourUtc: 3,
    modules: { usage: true, cron: true, errors: true, deprecation: true, exposure: true, zombies: true, timeline: true, access: false, cost: true, cfAlerts: true },
    mutedChecks: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    overrides: {},
    scope: { include: [], exclude: [] },
    groups: {},
    alerts: {
      critical: { instant: 'email', digest: true },
      warning: { instant: 'off', digest: true },
      info: { instant: 'off', digest: true },
      quietHours: null,
    },
    digest: { frequency: 'weekly', weekday: 1, hour: 8, groupRecipients: {} },
    timeZone: 'UTC',
    retentionDays: 30,
    updateCheck: true,
    accounts: {},
  };
}

/** Allowed range per threshold: [min, max]. Shares are 0..1. */
export const THRESHOLD_RANGES: Record<keyof Thresholds, [number, number]> = {
  budgetWarn: [0.05, 1],
  budgetCritical: [0.05, 1],
  errorWarn: [0.001, 0.5],
  errorCritical: [0.001, 0.5],
  errorBaselineMultiplier: [1.5, 50],
  runawayMultiplier: [2, 50],
  cpuShareWarn: [0.1, 1],
  compatAgeMonths: [1, 36],
  zombieDays: [7, 365],
  deployWindowMinutes: [5, 1440],
  newWorkerHourlyRequests: [1_000, 100_000_000],
  newResourceHourlyOps: [1_000, 100_000_000],
};

export class ConfigError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME = /^[\w.:\- *]{1,100}$/;
const ACCOUNT_ID = /^[\w-]{1,64}$/;
const LABEL = /^[^\r\n\u2028\u2029<>]{1,60}$/;
const EMAIL = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function num(v: unknown, [min, max]: [number, number], path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ConfigError(`${path} must be a number from ${min} to ${max}.`);
  return v;
}

function strList(v: unknown, path: string, re = NAME): string[] {
  if (!Array.isArray(v) || v.length > 200 || !v.every((s) => typeof s === 'string' && re.test(s))) throw new ConfigError(`${path} must be a list of names.`);
  return v as string[];
}

function thresholds(v: unknown, path: string, partial: boolean): Partial<Thresholds> {
  if (!isObj(v)) throw new ConfigError(`${path} must be an object.`);
  const out: Partial<Thresholds> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!(k in THRESHOLD_RANGES)) throw new ConfigError(`${path}.${k} is not a known threshold.`);
    out[k as keyof Thresholds] = num(val, THRESHOLD_RANGES[k as keyof Thresholds], `${path}.${k}`);
  }
  if (!partial) for (const k of Object.keys(THRESHOLD_RANGES)) if (!(k in out)) throw new ConfigError(`${path}.${k} is missing.`);
  return out;
}

function route(v: unknown, path: string): SeverityRoute {
  if (!isObj(v) || !['email', 'webhook', 'both', 'off'].includes(v.instant as string) || typeof v.digest !== 'boolean') {
    throw new ConfigError(`${path} must be { instant: email|webhook|both|off, digest: true|false }.`);
  }
  return { instant: v.instant as InstantChannel, digest: v.digest };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a config document (from the Settings screen or a config.json import).
 * Missing top-level sections fall back to defaults, so older exports keep working.
 */
export function parseConfig(input: unknown): Config {
  if (!isObj(input)) throw new ConfigError('Config must be a JSON object.');
  const d = defaultConfig();
  const v = { ...d, ...input } as Record<string, unknown>;
  if (v.version !== 1) throw new ConfigError('Unsupported config version.');
  if (!['auto', 'free', 'paid'].includes(v.plan as string)) throw new ConfigError('plan must be auto, free or paid.');

  const modules = { ...d.modules, ...(isObj(v.modules) ? v.modules : {}) } as Record<string, unknown>;
  for (const k of Object.keys(d.modules)) if (typeof modules[k] !== 'boolean') throw new ConfigError(`modules.${k} must be true or false.`);

  const t = { ...d.thresholds, ...thresholds(v.thresholds ?? {}, 'thresholds', true) } as Thresholds;
  if (t.budgetCritical <= t.budgetWarn) throw new ConfigError('thresholds.budgetCritical must be above budgetWarn.');
  if (t.errorCritical <= t.errorWarn) throw new ConfigError('thresholds.errorCritical must be above errorWarn.');

  const overrides: Config['overrides'] = {};
  if (!isObj(v.overrides)) throw new ConfigError('overrides must be an object.');
  for (const [k, o] of Object.entries(v.overrides)) {
    if (!NAME.test(k)) throw new ConfigError(`overrides key "${k}" is not a valid Worker or group name.`);
    overrides[k] = thresholds(o, `overrides.${k}`, true);
  }

  const scope = isObj(v.scope) ? v.scope : {};
  const groups: Config['groups'] = {};
  if (!isObj(v.groups)) throw new ConfigError('groups must be an object.');
  for (const [k, list] of Object.entries(v.groups)) {
    if (!NAME.test(k) || k.includes(':')) throw new ConfigError(`Group name "${k}" is not valid.`);
    groups[k] = strList(list, `groups.${k}`);
  }

  const a = isObj(v.alerts) ? v.alerts : {};
  let quietHours: Config['alerts']['quietHours'] = null;
  if (a.quietHours != null) {
    if (!isObj(a.quietHours) || !TIME.test(String(a.quietHours.start)) || !TIME.test(String(a.quietHours.end))) {
      throw new ConfigError('alerts.quietHours must be { start: "HH:MM", end: "HH:MM" } or null.');
    }
    quietHours = { start: String(a.quietHours.start), end: String(a.quietHours.end) };
  }

  const dg = { ...d.digest, ...(isObj(v.digest) ? v.digest : {}) } as Record<string, unknown>;
  if (!['daily', 'weekly', 'off'].includes(dg.frequency as string)) throw new ConfigError('digest.frequency must be daily, weekly or off.');
  const groupRecipients: Record<string, string[]> = {};
  if (!isObj(dg.groupRecipients)) throw new ConfigError('digest.groupRecipients must be an object.');
  for (const [g, list] of Object.entries(dg.groupRecipients)) {
    // The key ends up in an e-mail subject: same rule as group names, so no line breaks.
    if (!NAME.test(g) || g.includes(':')) throw new ConfigError(`Group name "${g}" in digest.groupRecipients is not valid.`);
    groupRecipients[g] = strList(list, `digest.groupRecipients.${g}`, EMAIL);
  }

  const accounts: Config['accounts'] = {};
  if (!isObj(v.accounts)) throw new ConfigError('accounts must be an object.');
  for (const [id, a] of Object.entries(v.accounts)) {
    if (!ACCOUNT_ID.test(id)) throw new ConfigError(`accounts key "${id}" is not a Cloudflare account ID.`);
    if (!isObj(a)) throw new ConfigError(`accounts.${id} must be an object.`);
    const out: AccountSettings = {};
    if (a.label != null) {
      // The label ends up in e-mail subjects and chat messages: one line, no markup.
      if (typeof a.label !== 'string' || !LABEL.test(a.label)) throw new ConfigError(`accounts.${id}.label must be one line of up to 60 characters.`);
      out.label = a.label;
    }
    if (a.plan != null) {
      if (!['auto', 'free', 'paid'].includes(a.plan as string)) throw new ConfigError(`accounts.${id}.plan must be auto, free or paid.`);
      out.plan = a.plan as PlanSetting;
    }
    if (a.digestTo != null) out.digestTo = strList(a.digestTo, `accounts.${id}.digestTo`, EMAIL);
    accounts[id] = out;
  }

  if (typeof v.timeZone !== 'string' || !isValidTimeZone(v.timeZone)) throw new ConfigError('timeZone must be an IANA time zone such as Europe/Prague.');
  if (typeof v.updateCheck !== 'boolean') throw new ConfigError('updateCheck must be true or false.');

  return {
    version: 1,
    plan: v.plan as PlanSetting,
    scanIntervalMinutes: num(v.scanIntervalMinutes, [15, 1440], 'scanIntervalMinutes'),
    inventoryIntervalHours: num(v.inventoryIntervalHours, [6, 168], 'inventoryIntervalHours'),
    inventoryHourUtc: Math.round(num(v.inventoryHourUtc, [0, 23], 'inventoryHourUtc')),
    modules: modules as unknown as ModuleSwitches,
    mutedChecks: [...new Set(strList(v.mutedChecks ?? [], 'mutedChecks', CHECK_PATTERN))],
    thresholds: t,
    overrides,
    scope: { include: strList(scope.include ?? [], 'scope.include'), exclude: strList(scope.exclude ?? [], 'scope.exclude') },
    groups,
    alerts: {
      critical: route(a.critical ?? d.alerts.critical, 'alerts.critical'),
      warning: route(a.warning ?? d.alerts.warning, 'alerts.warning'),
      info: route(a.info ?? d.alerts.info, 'alerts.info'),
      quietHours,
    },
    digest: {
      frequency: dg.frequency as DigestFrequency,
      weekday: Math.round(num(dg.weekday, [0, 6], 'digest.weekday')),
      hour: Math.round(num(dg.hour, [0, 23], 'digest.hour')),
      groupRecipients,
    },
    timeZone: v.timeZone,
    retentionDays: Math.round(num(v.retentionDays, [7, 90], 'retentionDays')),
    updateCheck: v.updateCheck,
    accounts,
  };
}

/** `*` wildcard match, case-sensitive like Worker names. */
export function matchPattern(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/** Groups a Worker belongs to: configured groups whose patterns match, plus its Cloudflare tags. */
export function groupsFor(config: Config, name: string, tags: string[] = []): string[] {
  const out = Object.entries(config.groups)
    .filter(([, patterns]) => patterns.some((p) => matchPattern(p, name)))
    .map(([g]) => g);
  for (const t of tags) if (!out.includes(t)) out.push(t);
  return out;
}

export function inScope(config: Config, name: string, groups: string[]): boolean {
  const hit = (p: string) => (p.startsWith('group:') ? groups.includes(p.slice(6)) : matchPattern(p, name));
  if (config.scope.include.length && !config.scope.include.some(hit)) return false;
  return !config.scope.exclude.some(hit);
}

/** Effective thresholds for one Worker: global, then each matching group, then the Worker itself. */
export function thresholdsFor(config: Config, name: string, groups: string[]): Thresholds {
  let t = { ...config.thresholds };
  for (const g of groups) if (config.overrides[`group:${g}`]) t = { ...t, ...config.overrides[`group:${g}`] };
  if (config.overrides[name]) t = { ...t, ...config.overrides[name] };
  return t;
}
