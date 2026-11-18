-- Ambersight schema v14: known devices for sign-in during a pause, and a bounded life for API tokens.
-- The install-wide failed sign-in count moves to one reserved login_attempts row ('#global'), so
-- login_attempts needs no change; rows keyed by a full IPv6 address simply age out.
CREATE TABLE IF NOT EXISTS known_devices (
  digest      TEXT PRIMARY KEY,   -- SHA-256 of the random cookie value; the value itself is never stored
  cred        TEXT NOT NULL,      -- credential generation that issued it
  expires_at  INTEGER NOT NULL    -- ms since epoch
) WITHOUT ROWID;

-- Existing tokens get 90 days from now. Their credential generation stays NULL and is filled in at
-- first use, because the generation cannot be computed here (it depends on a Worker secret).
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
ALTER TABLE api_tokens ADD COLUMN cred TEXT;
UPDATE api_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days');

-- sessions.cred used to be an unsalted SHA-256 over the ADMIN_PASSPHRASE secret. New values are
-- derived with salted PBKDF2. Old rows cannot be converted, so everyone signs in once more.
DELETE FROM sessions;
