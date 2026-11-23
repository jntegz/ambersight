-- Ambersight schema v19: cached OSV.dev vulnerability results per (npm package, locked version).
-- Shared across accounts and Workers; checked once a day for public-registry packages only, when
-- modules.packagesOsv is enabled.

CREATE TABLE IF NOT EXISTS npm_advisories (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  advisories TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
