-- Ambersight schema v20: passkeys, e-mailed sign-in links, and what each session was signed in with.
-- Once a passkey exists, the passphrase no longer signs in; it is kept for recovery (see auth.ts).

-- Public keys only: a copy of this table signs nobody in. A rowid table, so that removing a
-- person's data (personData.ts) can walk it like the others: a passkey's name may be a person's.
CREATE TABLE IF NOT EXISTS passkeys (
  id            TEXT PRIMARY KEY,           -- credential ID, base64url
  public_key    TEXT NOT NULL,              -- JWK (JSON) of the credential's public key
  alg           INTEGER NOT NULL,           -- COSE algorithm: -7 ES256, -8 EdDSA, -257 RS256
  sign_count    INTEGER NOT NULL DEFAULT 0,
  backed_up     INTEGER NOT NULL DEFAULT 0, -- 1: synced to a cloud account (backup state flag)
  transports    TEXT,                       -- JSON array, as the browser reported it
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

-- Passkey challenges are signed, not stored. A challenge that a passkey answered is kept here until
-- it would have expired anyway, so the same answer cannot be used twice. Only answers that verified
-- add a row, so the table cannot be filled by someone without a passkey.
CREATE TABLE IF NOT EXISTS webauthn_used (
  digest      TEXT PRIMARY KEY,   -- SHA-256 of the challenge
  expires_at  INTEGER NOT NULL    -- ms since epoch
) WITHOUT ROWID;

-- E-mailed sign-in links that are still open. Asking for a new one does not end an earlier one
-- (signinLink.ts): only expired links are deleted.
CREATE TABLE IF NOT EXISTS signin_links (
  digest      TEXT PRIMARY KEY,   -- SHA-256 of the token in the link; the token itself is never stored
  browser     TEXT NOT NULL,      -- SHA-256 of the cookie of the browser that asked for it
  expires_at  INTEGER NOT NULL    -- ms since epoch
) WITHOUT ROWID;

ALTER TABLE sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'passphrase';  -- passphrase | passkey | link | recovery
ALTER TABLE sessions ADD COLUMN passkey TEXT;                                -- the passkey that signed it in
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;       -- ms since epoch; 0 for older sessions
