-- Ambersight schema v16: where each locked package came from, and a bounded log of security-relevant
-- changes made from the dashboard.

-- 'registry' when the lockfile shows the package came from the public npm registry, 'other' when it
-- came from anywhere else or shows no source. Existing rows stay NULL until the lockfile is read again:
-- no new registry lookup is made for them, but results already stored still count, so open findings
-- do not resolve and reopen during the upgrade.
ALTER TABLE worker_packages ADD COLUMN source TEXT;
-- So that happens at the next scans instead of up to a day later.
UPDATE workers SET packages_checked_at = NULL WHERE packages_checked_at IS NOT NULL;

-- Who changed what. `actor` is a pseudonymous handle derived from the session cookie, never the
-- session id or the digest stored in `sessions`. `notice` is NULL when no notice is due, otherwise
-- pending, sent, none (no channel configured) or failed. Rows older than 90 days are removed by the
-- scheduled run, and each write keeps at most the newest 1,000.
CREATE TABLE IF NOT EXISTS admin_events (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL DEFAULT '',
  actor   TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 1,
  notice  TEXT
);
CREATE INDEX IF NOT EXISTS admin_events_at ON admin_events (at);
CREATE INDEX IF NOT EXISTS admin_events_pending ON admin_events (id) WHERE notice = 'pending';
