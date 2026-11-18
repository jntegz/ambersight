-- Ambersight schema v15: delivery recorded per alert channel, digest parts with their own state,
-- and personal data taken out of what is already stored.

-- When each channel last carried a finding, and until when a run holds it for sending. A claim that
-- is never finished (a crashed run, a failed send) simply expires, so the finding is retried.
ALTER TABLE findings ADD COLUMN notified_email_at TEXT;
ALTER TABLE findings ADD COLUMN notified_webhook_at TEXT;
ALTER TABLE findings ADD COLUMN claim_email_until TEXT;
ALTER TABLE findings ADD COLUMN claim_webhook_until TEXT;
-- The old single time meant "alerted": both channels count as done, so nothing is alerted twice.
UPDATE findings SET notified_email_at = notified_at, notified_webhook_at = notified_at WHERE notified_at IS NOT NULL;

-- One row per message of the digest being sent: the main digest, and one per client or group
-- recipient. Rows of other periods are deleted when the next digest starts, so this stays small.
CREATE TABLE IF NOT EXISTS digest_parts (
  period       TEXT NOT NULL,   -- the local date of the digest, YYYY-MM-DD
  part         TEXT NOT NULL,   -- "operators", "account:<id>:<address>" or "group:<name>:<address>"
  claim_until  TEXT,
  sent_at      TEXT,
  PRIMARY KEY (period, part)
) WITHOUT ROWID;

-- Finding messages no longer name people. Open findings would converge at the next scan; this also
-- covers acknowledged, snoozed and resolved ones, which may never be raised again.
UPDATE findings
SET message = 'An account member was '
  || CASE json_extract(evidence, '$.action') WHEN 'create' THEN 'added' WHEN 'delete' THEN 'removed' ELSE 'changed' END
  || ' on ' || json_extract(evidence, '$.at') || ' UTC.'
WHERE code LIKE 'member-change-%' AND json_valid(evidence) AND json_extract(evidence, '$.at') IS NOT NULL;

UPDATE findings
SET message = 'An API token was created on ' || json_extract(evidence, '$.at') || ' UTC.'
WHERE code LIKE 'token-created-%' AND json_valid(evidence) AND json_extract(evidence, '$.at') IS NOT NULL;

-- The audit-log sentence on anomalies could name a person. A scan adds it back without the name
-- while the change is still recent.
UPDATE findings
SET message = substr(message, 1, instr(message, ' Shortly before, ') - 1),
    evidence = json_remove(evidence, '$.change')
WHERE instr(message, ' Shortly before, ') > 0 AND json_valid(evidence) AND json_extract(evidence, '$.change') LIKE '%(audit log)';

-- D1 query text could hold literal values. Blank it: the next daily refresh stores the query's shape.
-- The hash stays, so these findings keep their identity.
UPDATE d1_queries SET query = '';
UPDATE findings SET evidence = json_remove(evidence, '$.query')
WHERE code LIKE 'd1-inefficient-query-%' AND json_valid(evidence);

-- Stored scan errors predate the sanitizer. The next failed scan writes a clean one.
UPDATE account_state SET value = 'The last scan failed. The next attempt will show why.' WHERE key = 'last_scan_error';
