-- Ambersight schema v3: failed sign-ins per client IP, so one address cannot lock everyone out.
CREATE TABLE login_attempts (
  ip            TEXT PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,   -- ms since epoch; fails count from here for LOCK_MS
  locked_until  INTEGER NOT NULL DEFAULT 0
);
