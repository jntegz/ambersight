-- Ambersight schema v13: read-only tokens for Ambersight's own JSON API (Grafana, scripts, status
-- boards). Only a SHA-256 digest of each token is stored; the token is shown once when created.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  digest        TEXT NOT NULL UNIQUE,
  hint          TEXT NOT NULL,   -- last 4 characters, to tell tokens apart
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
