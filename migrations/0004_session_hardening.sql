-- Ambersight schema v4: sessions store a SHA-256 digest of the cookie value (a copy of this table
-- no longer contains working cookies) and the fingerprint of the credential that issued them, so
-- rotating ADMIN_PASSPHRASE or removing the stored hash signs every session out.
-- Existing sessions cannot be converted, so everyone signs in once more after this migration.
DELETE FROM sessions;
ALTER TABLE sessions ADD COLUMN cred TEXT NOT NULL DEFAULT '';
