-- Ambersight schema v11: history. Daily rollups kept for 400 days, a finding event log,
-- storage sizes per day, scan runs, and the splits the scan already fetched but used to merge.
-- Every new table is written from data the scan already reads: no new Cloudflare API calls.

-- Limit hits by type and the D1 and KV operation splits, next to the existing totals.
ALTER TABLE metrics_hourly ADD COLUMN exceeded_cpu INTEGER;
ALTER TABLE metrics_hourly ADD COLUMN exceeded_memory INTEGER;
ALTER TABLE resource_hourly ADD COLUMN rows_read INTEGER;     -- D1
ALTER TABLE resource_hourly ADD COLUMN rows_written INTEGER;  -- D1
ALTER TABLE resource_hourly ADD COLUMN reads INTEGER;         -- D1 read queries, KV reads
ALTER TABLE resource_hourly ADD COLUMN writes INTEGER;        -- D1 write queries, KV writes
ALTER TABLE resource_hourly ADD COLUMN deletes INTEGER;       -- KV
ALTER TABLE resource_hourly ADD COLUMN lists INTEGER;         -- KV

-- One row per Worker and UTC day, folded from metrics_hourly once the day is over.
CREATE TABLE IF NOT EXISTS metrics_daily (
  account          TEXT NOT NULL,
  script           TEXT NOT NULL,
  day              TEXT NOT NULL,   -- YYYY-MM-DD, UTC
  requests         INTEGER NOT NULL DEFAULT 0,
  errors           INTEGER NOT NULL DEFAULT 0,
  subrequests      INTEGER NOT NULL DEFAULT 0,
  cpu_time_us      INTEGER NOT NULL DEFAULT 0,
  exceeded         INTEGER NOT NULL DEFAULT 0,
  exceeded_cpu     INTEGER NOT NULL DEFAULT 0,
  exceeded_memory  INTEGER NOT NULL DEFAULT 0,
  cpu_p99_max      REAL,            -- the highest hourly p99 of the day, ms
  active_hours     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, script, day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS metrics_daily_day ON metrics_daily (account, day);

CREATE TABLE IF NOT EXISTS resource_daily (
  account      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  resource     TEXT NOT NULL,
  day          TEXT NOT NULL,
  ops          INTEGER NOT NULL DEFAULT 0,
  rows_read    INTEGER,
  rows_written INTEGER,
  reads        INTEGER,
  writes       INTEGER,
  deletes      INTEGER,
  lists        INTEGER,
  peak_ops     INTEGER NOT NULL DEFAULT 0,  -- busiest hour of the day
  PRIMARY KEY (account, kind, resource, day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS resource_daily_day ON resource_daily (account, day);

CREATE TABLE IF NOT EXISTS quota_daily (
  account     TEXT NOT NULL,
  metric      TEXT NOT NULL,
  day         TEXT NOT NULL,
  value       REAL NOT NULL DEFAULT 0,
  peak_hour   TEXT,   -- the hour with the most usage, for "usually peaks at 14:00 UTC"
  peak_value  REAL,
  PRIMARY KEY (account, metric, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cron_daily (
  account     TEXT NOT NULL,
  script      TEXT NOT NULL,
  day         TEXT NOT NULL,
  runs        INTEGER NOT NULL DEFAULT 0,
  failures    INTEGER NOT NULL DEFAULT 0,
  cpu_max_ms  REAL,
  PRIMARY KEY (account, script, day)
) WITHOUT ROWID;

-- Storage size per resource and day, appended by each inventory refresh (storage_sizes keeps the latest).
CREATE TABLE IF NOT EXISTS storage_daily (
  account  TEXT NOT NULL,
  kind     TEXT NOT NULL,   -- d1 | kv | r2 | do
  id       TEXT NOT NULL,
  day      TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  objects  INTEGER,
  PRIMARY KEY (account, kind, id, day)
) WITHOUT ROWID;
INSERT OR IGNORE INTO storage_daily (account, kind, id, day, bytes, objects)
SELECT account, kind, id, substr(at, 1, 10), bytes, objects FROM storage_sizes;

-- Every change in a finding's life: opened, reopened, escalated, eased, resolved, acknowledged, snoozed, alerted.
CREATE TABLE IF NOT EXISTS finding_events (
  account     TEXT NOT NULL,
  finding_id  TEXT NOT NULL,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  severity    TEXT,
  check_id    TEXT,     -- module:code, for per-check analytics without parsing ids
  script      TEXT
);
CREATE INDEX IF NOT EXISTS finding_events_at ON finding_events (account, at);
CREATE INDEX IF NOT EXISTS finding_events_finding ON finding_events (finding_id, at);

-- The open events of findings that already exist, so time-to-resolve works for them too.
INSERT INTO finding_events (account, finding_id, at, kind, severity, check_id, script)
SELECT account, id, first_seen, 'opened', severity, module || ':' || code, script FROM findings;
INSERT INTO finding_events (account, finding_id, at, kind, severity, check_id, script)
SELECT account, id, last_seen, 'resolved', severity, module || ':' || code, script FROM findings WHERE status = 'resolved';

ALTER TABLE findings ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN status_at TEXT;   -- when it was last acknowledged, snoozed or reopened

-- One row per scan, for scan health and the Self-cost panel per account.
CREATE TABLE IF NOT EXISTS scan_runs (
  account       TEXT NOT NULL,
  at            TEXT NOT NULL,
  ms            INTEGER NOT NULL,
  calls         INTEGER NOT NULL,
  rows_read     INTEGER NOT NULL,
  rows_written  INTEGER NOT NULL,
  warnings      INTEGER NOT NULL,
  findings      INTEGER NOT NULL,
  opened        INTEGER NOT NULL DEFAULT 0,
  resolved      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, at)
) WITHOUT ROWID;

-- Responses built once per scan or change, served until the next one.
CREATE TABLE IF NOT EXISTS view_cache (
  account  TEXT NOT NULL,
  view     TEXT NOT NULL,
  etag     TEXT NOT NULL,
  body     TEXT NOT NULL,
  PRIMARY KEY (account, view)
) WITHOUT ROWID;

-- Each Worker's latest deployment without scanning all of its deployments.
CREATE INDEX IF NOT EXISTS deployments_latest ON deployments (account, script, created_on);

-- Backfill the daily rollups from the hourly history already stored, so charts are not empty.
INSERT OR IGNORE INTO metrics_daily (account, script, day, requests, errors, subrequests, cpu_time_us, exceeded, exceeded_cpu, exceeded_memory, cpu_p99_max, active_hours)
SELECT account, script, substr(hour, 1, 10), COALESCE(SUM(requests), 0), COALESCE(SUM(errors), 0), COALESCE(SUM(subrequests), 0),
  COALESCE(SUM(cpu_time_us), 0), COALESCE(SUM(exceeded), 0), 0, 0, MAX(cpu_p99), SUM(CASE WHEN requests > 0 THEN 1 ELSE 0 END)
FROM metrics_hourly WHERE substr(hour, 1, 10) < date('now') GROUP BY account, script, substr(hour, 1, 10);

INSERT OR IGNORE INTO resource_daily (account, kind, resource, day, ops, peak_ops)
SELECT account, kind, resource, substr(hour, 1, 10), COALESCE(SUM(ops), 0), COALESCE(MAX(ops), 0)
FROM resource_hourly WHERE substr(hour, 1, 10) < date('now') GROUP BY account, kind, resource, substr(hour, 1, 10);

INSERT OR IGNORE INTO quota_daily (account, metric, day, value)
SELECT account, metric, substr(hour, 1, 10), COALESCE(SUM(value), 0)
FROM quota_hourly WHERE substr(hour, 1, 10) < date('now') GROUP BY account, metric, substr(hour, 1, 10);

INSERT OR IGNORE INTO cron_daily (account, script, day, runs, failures, cpu_max_ms)
SELECT account, script, substr(hour, 1, 10), COALESCE(SUM(runs), 0), COALESCE(SUM(failures), 0), MAX(cpu_max_ms)
FROM cron_runs WHERE substr(hour, 1, 10) < date('now') GROUP BY account, script, substr(hour, 1, 10);
