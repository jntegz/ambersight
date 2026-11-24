// The admin log's vocabulary, shared by the Worker (notices) and the Settings page.
// SPDX-License-Identifier: AGPL-3.0-only

/** Admin events older than this are removed. */
export const ADMIN_EVENT_DAYS = 90;
/** At most this many are kept, however busy the install is. */
export const MAX_ADMIN_EVENTS = 1000;

export const ADMIN_ACTIONS: Record<string, string> = {
  'config.reduced': 'Detection reduced',
  'config.changed': 'Settings changed',
  'accounts.changed': 'Watched accounts changed',
  'setup.completed': 'Setup completed',
  'findings.acknowledged': 'Findings acknowledged',
  'findings.snoozed': 'Findings snoozed',
  'token.created': 'API token created',
  'token.revoked': 'API token revoked',
  'passphrase.changed': 'Passphrase changed',
  'passkey.added': 'Passkey added',
  'passkey.removed': 'Passkey removed',
  'sessions.ended': 'Other sessions signed out',
  'personal-data.previewed': 'Searched stored data for a person',
  'personal-data.removed': 'Removed a person from stored data',
  signin: 'Signed in',
};

export const adminActionLabel = (action: string) => ADMIN_ACTIONS[action] ?? action;
