-- Ambersight schema v2: data for deprecation, exposure, zombie, timeline and usage modules,
-- plus the app's own usage for the Self-cost panel.

-- Per-Worker detail, filled by the rotating detail cursor.
ALTER TABLE workers ADD COLUMN compat_flags TEXT;        -- JSON array
ALTER TABLE workers ADD COLUMN bindings TEXT;            -- JSON array of { type, name, id? }
ALTER TABLE workers ADD COLUMN detail_checked_at TEXT;   -- last settings/deployments fetch
ALTER TABLE workers ADD COLUMN first_seen TEXT;

-- CPU time per Worker per hour (sum, microseconds) for runaway detection.
ALTER TABLE metrics_hourly ADD COLUMN cpu_time_us INTEGER NOT NULL DEFAULT 0;

-- Max CPU of scheduled runs, to warn when a cron is close to its CPU limit.
ALTER TABLE cron_runs ADD COLUMN cpu_max_ms REAL;

-- Storage and Durable Object operations per resource per hour (GraphQL datasets).
CREATE TABLE resource_hourly (
  kind     TEXT NOT NULL,   -- d1 | kv | r2 | do | queues
  resource TEXT NOT NULL,   -- database id, namespace id, bucket name, ...
  hour     TEXT NOT NULL,
  ops      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, resource, hour)
);
CREATE INDEX resource_hour ON resource_hourly (hour);

-- Inventory refreshed on the full inventory run: storage, routes, custom domains, Access apps.
CREATE TABLE resources (
  kind  TEXT NOT NULL,      -- kv | d1 | r2 | queues | route | domain | access
  id    TEXT NOT NULL,
  name  TEXT,
  script TEXT,              -- for routes and domains: the Worker they point at
  extra TEXT,               -- JSON
  PRIMARY KEY (kind, id)
);

CREATE TABLE deployments (
  script     TEXT NOT NULL,
  id         TEXT NOT NULL,
  created_on TEXT NOT NULL,
  author     TEXT,
  message    TEXT,
  source     TEXT,
  PRIMARY KEY (script, id)
);
CREATE INDEX deployments_time ON deployments (created_on);

-- Workers added to or removed from the account, for the digest.
CREATE TABLE fleet_events (
  at     TEXT NOT NULL,
  kind   TEXT NOT NULL,     -- added | removed
  script TEXT NOT NULL
);
CREATE INDEX fleet_events_at ON fleet_events (at);

-- Ambersight's own usage per UTC day, shown on the Self-cost panel.
CREATE TABLE usage_daily (
  day          TEXT PRIMARY KEY,
  cron_runs    INTEGER NOT NULL DEFAULT 0,
  api_requests INTEGER NOT NULL DEFAULT 0,
  subrequests  INTEGER NOT NULL DEFAULT 0,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0
);
