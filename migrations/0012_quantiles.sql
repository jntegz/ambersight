-- Ambersight schema v12: median CPU time and wall time per Worker and hour. They come from the same
-- GraphQL request that already reads CPU p99 (more fields, no more requests).
ALTER TABLE metrics_hourly ADD COLUMN cpu_p50 REAL;   -- ms
ALTER TABLE metrics_hourly ADD COLUMN wall_p50 REAL;  -- ms
ALTER TABLE metrics_hourly ADD COLUMN wall_p99 REAL;  -- ms
-- Per day: the request-weighted average of the hourly medians, and the highest hourly wall-time p99.
ALTER TABLE metrics_daily ADD COLUMN cpu_p50 REAL;
ALTER TABLE metrics_daily ADD COLUMN wall_p50 REAL;
ALTER TABLE metrics_daily ADD COLUMN wall_p99_max REAL;
