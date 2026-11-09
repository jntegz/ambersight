-- Ambersight schema v1. Everything stays in the user's own D1 database.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per Worker, refreshed from the Workers list and scripts list APIs.
CREATE TABLE workers (
  name              TEXT PRIMARY KEY,
  has_modules       INTEGER,
  compatibility_date TEXT,
  handlers          TEXT,          -- JSON array, e.g. ["fetch","scheduled"]
  usage_model       TEXT,
  created_on        TEXT,
  modified_on       TEXT,
  deployed_on       TEXT,
  workers_dev       INTEGER,
  previews_enabled  INTEGER,
  logs_enabled      INTEGER,
  sampling_rate     REAL,
  logpush           INTEGER,
  tags              TEXT,          -- JSON array
  last_seen         TEXT NOT NULL
);

-- Hourly metrics per Worker from GraphQL workersInvocationsAdaptive.
CREATE TABLE metrics_hourly (
  script       TEXT NOT NULL,
  hour         TEXT NOT NULL,     -- ISO hour, e.g. 2026-11-09T14:00:00Z
  requests     INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  subrequests  INTEGER NOT NULL DEFAULT 0,
  exceeded     INTEGER NOT NULL DEFAULT 0, -- exceededCpu + exceededMemory
  cpu_p99      REAL,
  PRIMARY KEY (script, hour)
);
CREATE INDEX metrics_hour ON metrics_hourly (hour);

-- Cron schedules per Worker (only Workers with a scheduled handler).
CREATE TABLE schedules (
  script     TEXT PRIMARY KEY,
  crons      TEXT NOT NULL,       -- JSON array of cron expressions
  checked_at TEXT NOT NULL
);

-- Scheduled (cron) runs per Worker and hour.
CREATE TABLE cron_runs (
  script   TEXT NOT NULL,
  hour     TEXT NOT NULL,
  runs     INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (script, hour)
);

-- Findings: one row per (module, worker, code). Status survives rescans.
CREATE TABLE findings (
  id           TEXT PRIMARY KEY,  -- module:script:code
  script       TEXT NOT NULL,     -- "*" for account-wide findings
  module       TEXT NOT NULL,
  severity     TEXT NOT NULL,     -- critical | warning | info
  code         TEXT NOT NULL,
  message      TEXT NOT NULL,
  evidence     TEXT NOT NULL,     -- JSON
  action       TEXT NOT NULL,
  docs_url     TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open', -- open | acknowledged | snoozed | resolved
  snooze_until TEXT,
  notified_at  TEXT
);
CREATE INDEX findings_status ON findings (status, severity);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
