-- Ambersight schema v10: the last hour each KV namespace, D1 database, R2 bucket and queue had
-- operations. The unused-storage checks read one row per resource instead of rereading the whole
-- history of resource_hourly on every scan (the same approach as workers.last_active_hour).
CREATE TABLE IF NOT EXISTS resource_activity (
  account          TEXT NOT NULL,
  kind             TEXT NOT NULL,   -- kv | d1 | r2 | queues
  resource         TEXT NOT NULL,   -- namespace id, database id, bucket name, queue id
  last_active_hour TEXT NOT NULL,
  PRIMARY KEY (account, kind, resource)
) WITHOUT ROWID;  -- one row written per change, not a row plus an index entry

INSERT OR IGNORE INTO resource_activity (account, kind, resource, last_active_hour)
SELECT account, kind, resource, MAX(hour) FROM resource_hourly
WHERE ops > 0 AND kind IN ('kv', 'd1', 'r2', 'queues')
GROUP BY account, kind, resource;

-- Since when each kind's operations are known: the first stored hour, for installs with history.
-- Kinds with no stored operations start when the next scan reads them.
INSERT OR IGNORE INTO account_state (account, key, value)
SELECT account, 'ops_since', json_group_object(kind, first) FROM (
  SELECT account, kind, MIN(hour) AS first FROM resource_hourly WHERE kind IN ('kv', 'd1', 'r2', 'queues') GROUP BY account, kind
) GROUP BY account;
