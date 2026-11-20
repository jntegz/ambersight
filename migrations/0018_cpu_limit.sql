-- Ambersight schema v18: each Worker's own CPU limit.
--
-- limits.cpu_ms from the Worker's settings, read with its bindings. NULL means the plan default
-- (30 seconds on Workers Paid). The cron CPU check compares scheduled runs with this limit.
ALTER TABLE workers ADD COLUMN cpu_limit_ms INTEGER;
