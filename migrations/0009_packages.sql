-- Ambersight schema v9: the optional Packages check (off by default).

-- Direct npm dependencies of each mapped Worker, as locked in its package-lock.json on GitHub.
CREATE TABLE IF NOT EXISTS worker_packages (
  account TEXT NOT NULL,
  script TEXT NOT NULL,
  name TEXT NOT NULL,
  locked TEXT NOT NULL,
  dev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, script, name)
);

-- Latest version on the npm registry, shared by every account: each package is looked up once a day.
CREATE TABLE IF NOT EXISTS npm_latest (
  name TEXT PRIMARY KEY,
  latest TEXT,
  checked_at TEXT NOT NULL
);

-- When each Worker's lockfile was last read, and why it could not be (NULL = read fine).
ALTER TABLE workers ADD COLUMN packages_checked_at TEXT;
ALTER TABLE workers ADD COLUMN packages_error TEXT;
