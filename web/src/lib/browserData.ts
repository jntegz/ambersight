// What this browser keeps in localStorage, and what of it goes when a session ends.
// Goes: the selected account, the last visit per account, and the group chosen on a page (a name
// from the fleet). Stays: the theme, the dismissed update notice, sort order and layout, on/off
// filters. sessionStorage is not used.
// SPDX-License-Identifier: AGPL-3.0-only

export const SIGN_OUT_PENDING = 'ambersight-signout-pending';

export interface KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const REMOVED = ['ambersight-account'];
const REMOVED_PREFIX = 'ambersight-visit-';
const WITH_GROUP = ['ambersight-workers-view', 'ambersight-timeline'];

export function forgetFleetData(store: KeyValueStore) {
  const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((k): k is string => k !== null);
  for (const key of keys) {
    if (REMOVED.includes(key) || key.startsWith(REMOVED_PREFIX)) store.removeItem(key);
    else if (WITH_GROUP.includes(key)) {
      try {
        const { group: _group, ...rest } = JSON.parse(store.getItem(key) ?? '{}') as Record<string, unknown>;
        store.setItem(key, JSON.stringify(rest));
      } catch {
        store.removeItem(key);
      }
    }
  }
}
