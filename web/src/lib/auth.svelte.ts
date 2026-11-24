// How this dashboard signs in, shared by the pages that ask for proof before a sensitive step.
// SPDX-License-Identifier: AGPL-3.0-only

export type SessionMethod = 'passphrase' | 'passkey' | 'link' | 'recovery';

export const auth = $state({
  /** Passkeys exist: sensitive steps are confirmed with one, and the passphrase only recovers. */
  passkeys: false,
  /** E-mailed sign-in links can be sent. */
  link: false,
  /** How this session signed in. Null before sign-in. */
  method: null as SessionMethod | null,
});
