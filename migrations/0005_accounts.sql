-- Ambersight schema v5: one install watches several Cloudflare accounts.
-- Every per-account table gets an `account` column at the front of its primary key. Existing rows
-- are copied under the account this install already watched (settings.account_id), so history,
-- findings and their acknowledgements survive the upgrade.

-- Accounts the install watches. `enabled = 0` keeps the history but stops scanning.
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  detected_plan TEXT,             -- free | paid, from Billing Read; NULL when unknown
  added_at      TEXT NOT NULL
);

-- Per-account scan state (last scan, inventory time, dataset availability, ...).
CREATE TABLE account_state (
  account TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (account, key)
);

INSERT INTO accounts (id, name, enabled, detected_plan, added_at)
  SELECT value, NULL, 1, (SELECT value FROM settings WHERE key = 'detected_plan'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM settings WHERE key = 'account_id' AND value <> '';

INSERT INTO account_state (account, key, value)
  SELECT (SELECT value FROM settings WHERE key = 'account_id'), key, value FROM settings
  WHERE key IN ('last_scan_at', 'last_scan_calls', 'last_scan_ms', 'last_scan_warnings', 'inventory_at',
                'workers_subdomain', 'cpu_sum', 'cron_cpu', 'cron_dataset', 'cron_dataset_checked',
                'ops_unavailable', 'ops_checked', 'first_metrics_at', 'access_listed_at')
    AND EXISTS (SELECT 1 FROM settings WHERE key = 'account_id' AND value <> '');

DELETE FROM settings
  WHERE key IN ('last_scan_at', 'last_scan_calls', 'last_scan_ms', 'last_scan_warnings', 'inventory_at',
                'workers_subdomain', 'cpu_sum', 'cron_cpu', 'cron_dataset', 'cron_dataset_checked',
                'ops_unavailable', 'ops_checked', 'first_metrics_at', 'access_listed_at', 'detected_plan', 'account_id');

-- workers ---------------------------------------------------------------------
CREATE TABLE workers_v5 (
  account            TEXT NOT NULL,
  name               TEXT NOT NULL,
  has_modules        INTEGER,
  compatibility_date TEXT,
  compat_flags       TEXT,
  handlers           TEXT,
  usage_model        TEXT,
  created_on         TEXT,
  modified_on        TEXT,
  deployed_on        TEXT,
  workers_dev        INTEGER,
  previews_enabled   INTEGER,
  logs_enabled       INTEGER,
  sampling_rate      REAL,
  logpush            INTEGER,
  tags               TEXT,
  last_seen          TEXT NOT NULL,
  bindings           TEXT,
  detail_checked_at  TEXT,
  first_seen         TEXT,
  PRIMARY KEY (account, name)
);
INSERT INTO workers_v5 SELECT
  COALESCE((SELECT id FROM accounts LIMIT 1), ''),
  name, has_modules, compatibility_date, compat_flags, handlers, usage_model, created_on, modified_on, deployed_on,
  workers_dev, previews_enabled, logs_enabled, sampling_rate, logpush, tags, last_seen, bindings, detail_checked_at, first_seen
FROM workers;
DROP TABLE workers;
ALTER TABLE workers_v5 RENAME TO workers;

-- metrics_hourly --------------------------------------------------------------
CREATE TABLE metrics_hourly_v5 (
  account     TEXT NOT NULL,
  script      TEXT NOT NULL,
  hour        TEXT NOT NULL,
  requests    INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  subrequests INTEGER NOT NULL DEFAULT 0,
  exceeded    INTEGER NOT NULL DEFAULT 0,
  cpu_p99     REAL,
  cpu_time_us INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, script, hour)
);
INSERT INTO metrics_hourly_v5 SELECT COALESCE((SELECT id FROM accounts LIMIT 1), ''), script, hour, requests, errors, subrequests, exceeded, cpu_p99, cpu_time_us FROM metrics_hourly;
DROP TABLE metrics_hourly;
ALTER TABLE metrics_hourly_v5 RENAME TO metrics_hourly;
CREATE INDEX metrics_hour ON metrics_hourly (account, hour);
CREATE INDEX metrics_hour_all ON metrics_hourly (hour);

-- schedules -------------------------------------------------------------------
CREATE TABLE schedules_v5 (
  account    TEXT NOT NULL,
  script     TEXT NOT NULL,
  crons      TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (account, script)
);
INSERT INTO schedules_v5 SELECT COALESCE((SELECT id FROM accounts LIMIT 1), ''), script, crons, checked_at FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_v5 RENAME TO schedules;

-- cron_runs -------------------------------------------------------------------
CREATE TABLE cron_runs_v5 (
  account    TEXT NOT NULL,
  script     TEXT NOT NULL,
  hour       TEXT NOT NULL,
  runs       INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0,
  cpu_max_ms REAL,
  PRIMARY KEY (account, script, hour)
);
INSERT INTO cron_runs_v5 SELECT COALESCE((SELECT id FROM accounts LIMIT 1), ''), script, hour, runs, failures, cpu_max_ms FROM cron_runs;
DROP TABLE cron_runs;
ALTER TABLE cron_runs_v5 RENAME TO cron_runs;

-- findings: ids gain an "<account>/" prefix so they stay unique across accounts --
CREATE TABLE findings_v5 (
  id           TEXT PRIMARY KEY,  -- <account>/<module>:<script>:<code>
  account      TEXT NOT NULL,
  script       TEXT NOT NULL,
  module       TEXT NOT NULL,
  severity     TEXT NOT NULL,
  code         TEXT NOT NULL,
  message      TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  action       TEXT NOT NULL,
  docs_url     TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  snooze_until TEXT,
  notified_at  TEXT
);
INSERT INTO findings_v5 SELECT
  COALESCE((SELECT id FROM accounts LIMIT 1), '') || '/' || id, COALESCE((SELECT id FROM accounts LIMIT 1), ''),
  script, module, severity, code, message, evidence, action, docs_url, first_seen, last_seen, status, snooze_until, notified_at
FROM findings;
DROP TABLE findings;
ALTER TABLE findings_v5 RENAME TO findings;
CREATE INDEX findings_status ON findings (status, severity);
CREATE INDEX findings_account ON findings (account, status);

-- resources -------------------------------------------------------------------
CREATE TABLE resources_v5 (
  account TEXT NOT NULL,
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  name    TEXT,
  script  TEXT,
  extra   TEXT,
  PRIMARY KEY (account, kind, id)
);
INSERT INTO resources_v5 SELECT COALESCE((SELECT id FROM accounts LIMIT 1), ''), kind, id, name, script, extra FROM resources;
DROP TABLE resources;
ALTER TABLE resources_v5 RENAME TO resources;

-- resource_hourly -------------------------------------------------------------
CREATE TABLE resource_hourly_v5 (
  account  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  resource TEXT NOT NULL,
  hour     TEXT NOT NULL,
  ops      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, kind, resource, hour)
);
INSERT INTO resource_hourly_v5 SELECT COALESCE((SELECT id FROM accounts LIMIT 1), ''), kind, resource, hour, ops FROM resource_hourly;
DROP TABLE resource_hourly;
ALTER TABLE resource_hourly_v5 RENAME TO resource_hourly;
CREATE INDEX resource_hour ON resource_hourly (account, hour);
CREATE INDEX resource_hour_all ON resource_hourly (hour);

-- deployments -----------------------------------------------------------------
CREATE TABLE deployments_v5 (
  account    TEXT NOT NULL,
  script     TEXT NOT NULL,
  id         TEXT NOT NULL,
  created_on TEXT NOT NULL,
  author     TEXT,
  message    TEXT,
  source     TEXT,
  PRIMARY KEY (account, script, id)
);
INSERT INTO deployments_v5 SELECT COALESCE((SELECT id FROM accounts LIMIT 1), ''), script, id, created_on, author, message, source FROM deployments;
DROP TABLE deployments;
ALTER TABLE deployments_v5 RENAME TO deployments;
CREATE INDEX deployments_time ON deployments (account, created_on);
CREATE INDEX deployments_time_all ON deployments (created_on);

-- fleet_events ----------------------------------------------------------------
CREATE TABLE fleet_events_v5 (
  account TEXT NOT NULL,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  script  TEXT NOT NULL
);
INSERT INTO fleet_events_v5 SELECT COALESCE((SELECT id FROM accounts LIMIT 1), ''), at, kind, script FROM fleet_events;
DROP TABLE fleet_events;
ALTER TABLE fleet_events_v5 RENAME TO fleet_events;
CREATE INDEX fleet_events_at ON fleet_events (account, at);
CREATE INDEX fleet_events_at_all ON fleet_events (at);
