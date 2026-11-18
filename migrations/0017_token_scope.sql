-- Ambersight schema v17: what each read-only API token may read.
--
-- `accounts` is '*' for a token granted every watched account, or a JSON list of account ids. NULL
-- marks a token created before this column existed: it keeps every watched account, so integrations
-- do not break, and Settings says so. `people` is 1 only for a token explicitly granted person-linked
-- data (deploy authors, audit actors and the free text that can carry them). Existing tokens get 0
-- and stop receiving that data; a new token is needed to grant it.
ALTER TABLE api_tokens ADD COLUMN accounts TEXT;
ALTER TABLE api_tokens ADD COLUMN people INTEGER NOT NULL DEFAULT 0;
