-- Ambersight schema v7: zones read on a rotating cursor, the audit log, expensive D1 queries,
-- gradual rollouts, config drift and Cloudflare status incidents.

-- Zones and when each per-zone task last ran (routes, certificates, DNS), so 40 zones are covered
-- over a few scans instead of being cut off at 20.
CREATE TABLE zones (
  account   TEXT NOT NULL,
  id        TEXT NOT NULL,
  name      TEXT NOT NULL,
  routes_at TEXT,
  certs_at  TEXT,
  dns_at    TEXT,
  PRIMARY KEY (account, id)
);

-- Account audit log (Audit Logs v2), without "view" actions.
CREATE TABLE audit_events (
  account       TEXT NOT NULL,
  id            TEXT NOT NULL,
  at            TEXT NOT NULL,
  actor         TEXT,
  action        TEXT,             -- create | update | delete
  description   TEXT,
  product       TEXT,
  resource_type TEXT,
  resource_id   TEXT,
  result        TEXT,
  PRIMARY KEY (account, id)
);
CREATE INDEX audit_events_at ON audit_events (account, at);

-- The most expensive D1 queries of the last 24 hours, replaced once a day.
CREATE TABLE d1_queries (
  account       TEXT NOT NULL,
  hash          TEXT NOT NULL,
  database_id   TEXT NOT NULL,
  query         TEXT NOT NULL,
  rows_read     REAL NOT NULL DEFAULT 0,
  rows_returned REAL NOT NULL DEFAULT 0,
  runs          INTEGER NOT NULL DEFAULT 0,
  at            TEXT NOT NULL,
  PRIMARY KEY (account, hash)
);

-- Traffic split of a deployment: [{ "id": version, "percentage": 90 }, ...].
ALTER TABLE deployments ADD COLUMN versions TEXT;

-- Extra detail for an event, e.g. the binding name for "binding-removed".
ALTER TABLE fleet_events ADD COLUMN detail TEXT;

-- Recent incidents from the public Cloudflare status page (opt-in), shared by every account.
CREATE TABLE cf_incidents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  impact      TEXT,
  status      TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  url         TEXT
);
