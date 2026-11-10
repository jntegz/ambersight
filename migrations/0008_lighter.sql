-- Ambersight schema v8: lighter on D1.
-- D1 bills every row a query scans and every index entry a write touches, against 5 million
-- reads and 100,000 writes a day on the Free plan.

-- The last hour each Worker had a request. The no-traffic check reads this instead of summing
-- 30 days of hourly metrics on every scan.
ALTER TABLE workers ADD COLUMN last_active_hour TEXT;
UPDATE workers SET last_active_hour = (
  SELECT MAX(m.hour) FROM metrics_hourly m WHERE m.account = workers.account AND m.script = workers.name AND m.requests > 0
);

-- Indexes no query uses (every query filters by account first); each one cost a written row per insert.
DROP INDEX IF EXISTS metrics_hour_all;
DROP INDEX IF EXISTS resource_hour_all;
DROP INDEX IF EXISTS deployments_time_all;
DROP INDEX IF EXISTS fleet_events_at_all;
