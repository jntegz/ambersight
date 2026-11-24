// Finding and removing one person's identifier in what Ambersight stores: the vocabulary shared by
// the Worker and the Settings page.
// SPDX-License-Identifier: AGPL-3.0-only

/** What replaces the identifier. Rows stay, so history, counts and finding identity survive. */
export const REMOVED_MARKER = '[removed]';
export const MIN_IDENTIFIER = 3;
/** The longest possible e-mail address. */
export const MAX_IDENTIFIER = 254;

export type PersonDataClass =
  | 'deployments' | 'auditEvents' | 'findings' | 'adminLog' | 'cloudflareAlerts'
  | 'accountNames' | 'apiTokenNames' | 'passkeyNames' | 'scanNotes' | 'digestDelivery' | 'infrastructure';

/** `replaced: false` is only counted: those names identify things in Cloudflare and come back with each scan. */
export const PERSON_DATA_CLASSES: { id: PersonDataClass; label: string; replaced: boolean }[] = [
  { id: 'deployments', label: 'Deployments (author, message)', replaced: true },
  { id: 'auditEvents', label: 'Audit log events (actor, description, resource)', replaced: true },
  { id: 'findings', label: 'Findings (quoted text in the message, evidence)', replaced: true },
  { id: 'adminLog', label: 'Admin log entries', replaced: true },
  { id: 'cloudflareAlerts', label: 'Cloudflare notifications', replaced: true },
  { id: 'accountNames', label: 'Account names', replaced: true },
  { id: 'apiTokenNames', label: 'API token names', replaced: true },
  { id: 'passkeyNames', label: 'Passkey names', replaced: true },
  { id: 'scanNotes', label: 'Last scan error and warnings', replaced: true },
  { id: 'digestDelivery', label: 'Digest delivery records in the older format (the recipient becomes a keyed hash)', replaced: true },
  { id: 'infrastructure', label: 'Names of Workers, zones, resources and bindings, audit log resource IDs and the workers.dev subdomain (change them in Cloudflare)', replaced: false },
];

export type PersonDataCounts = Partial<Record<PersonDataClass, number>>;

/** A setting that holds the identifier. It says where, never what. */
export interface PersonDataEntry {
  label: string;
  count: number;
}

/** One bounded step. `counts` covers this step only; `reported` and `cachedViews` come with the last. */
export interface PersonDataStep {
  counts: PersonDataCounts;
  done: boolean;
  /**
   * Send this back to continue. Null when done. It is signed for this session and identifier and
   * expires soon. In a removal it also stands in for the passphrase on the following step.
   */
  cursor: string | null;
  /** Cached views that may hold it (preview), or that were cleared (removal). */
  cachedViews?: number;
  /** For the operator to change: Ambersight does not edit these. */
  reported?: PersonDataEntry[];
  /** The last preview step only: proves to the removal that this session searched everything for this identifier. */
  confirmation?: string;
  notReachable: string[];
}

export const NOT_REACHABLE = [
  'E-mails, webhook and chat messages already sent.',
  'Whatever recipients of those messages, such as clients or chat members, kept or forwarded.',
  'Copies in browsers and files: pages still open, the installed app\'s offline copies on other devices, and anything exported or printed.',
  'Backups and exports of the database, including D1 Time Travel restore points, until they expire.',
  'What Cloudflare itself holds. Its deployment records and audit log still name this person, and a later scan can store them again. Turning off "Record who made changes" in Settings › General stops authors and actors being stored and takes their address or token name out of new text, but a name someone typed into a new deploy message can still come back.',
  'Account names. Saving the watched accounts in Settings, or a later account refresh, stores the name Cloudflare reports again.',
];

export const cleanIdentifier = (value: string) => value.normalize('NFC').trim();

/** An e-mail address, which matches in any case. Anything else is a name, which matches as typed. */
export const isAddress = (identifier: string) => /^[^\s@]+@[^\s@]+$/u.test(identifier);

/** One word that is not an address: it may also be an ordinary word in a sentence. */
export const mayBeOrdinaryWord = (identifier: string) => !isAddress(identifier) && !/\s/u.test(identifier);

/** Why this cannot be searched for. The text never repeats the identifier. */
export function identifierProblem(identifier: string): string | null {
  if (identifier.length > MAX_IDENTIFIER) return `Enter at most ${MAX_IDENTIFIER} characters.`;
  if (/\p{Cc}/u.test(identifier)) return 'Enter one e-mail address or name, on one line.';
  // Letters and digits only: a short run of punctuation would match nearly every record.
  if ((identifier.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < MIN_IDENTIFIER) return `Enter a full e-mail address or name, with at least ${MIN_IDENTIFIER} letters or digits.`;
  return null;
}
