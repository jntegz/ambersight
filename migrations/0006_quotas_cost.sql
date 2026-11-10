-- Ambersight schema v6: free-plan quotas, storage sizes, cost estimates and Cloudflare's own alerts.

-- Account-wide usage per metric per hour (D1 rows, KV operations by type, Queue operations,
-- Durable Object requests, Workflow steps, Workers AI neurons, Workers requests and CPU time).
-- Kept for at least 35 days whatever the history setting, for month-to-date cost estimates.
CREATE TABLE quota_hourly (
  account TEXT NOT NULL,
  metric  TEXT NOT NULL,
  hour    TEXT NOT NULL,
  value   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (account, metric, hour)
);
CREATE INDEX quota_hour ON quota_hourly (account, hour);

-- Latest storage size per D1 database, KV namespace, R2 bucket, and the Durable Object total ("*").
CREATE TABLE storage_sizes (
  account TEXT NOT NULL,
  kind    TEXT NOT NULL,   -- d1 | kv | r2 | do
  id      TEXT NOT NULL,
  bytes   REAL NOT NULL DEFAULT 0,
  objects INTEGER,
  at      TEXT NOT NULL,
  PRIMARY KEY (account, kind, id)
);

-- Notifications Cloudflare itself sent to the account (alerting/v3/history), for the timeline.
CREATE TABLE cf_alerts (
  account     TEXT NOT NULL,
  id          TEXT NOT NULL,
  sent        TEXT NOT NULL,
  alert_type  TEXT,
  name        TEXT,
  description TEXT,
  PRIMARY KEY (account, id)
);
CREATE INDEX cf_alerts_sent ON cf_alerts (account, sent);
