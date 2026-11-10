# Configuration

Ambersight has two layers of configuration:

- **`wrangler.jsonc` and secrets** hold what the Worker needs before it can start: the API token, the passphrase and the e-mail setup. Change them by committing (Deploy button copy) or running `npm run deploy` (terminal).
- **Settings** holds everything else: checks, thresholds, groups, alerts and the digest. It is stored as one JSON document in D1 and takes effect on the next scan, with no redeploy. **Settings › Backup** exports it as `config.json` and imports it again, so you can keep it in version control or copy it to a second install.

## Secrets

| Secret | Required | What it is |
| --- | --- | --- |
| `CF_API_TOKEN` | Yes | The read-only API token. The setup wizard refuses a token with any write permission. See the [README](../README.md#step-1-create-a-read-only-api-token) for the permission list. |
| `ADMIN_PASSPHRASE` | Yes | The dashboard passphrase, at least 12 characters. Sign-in stays off until it is set. If you change the passphrase in **Settings › Security**, the new one is stored as a hash in D1 and takes priority over this secret. |
| `WEBHOOK_URL` | No | A Slack, Discord, Telegram, ntfy or generic JSON endpoint. See [alerts.md](alerts.md#webhooks). |

Set them with `npx wrangler secret put <NAME>`, or in the Cloudflare dashboard under **ambersight › Settings › Variables and Secrets**.

## Variables in `wrangler.jsonc`

| Variable | Default | What it does |
| --- | --- | --- |
| `PLAN` | `"free"` | The fallback plan, `free` or `paid`. Used only when the plan cannot be detected (the token lacks *Billing Read*) and **Settings › General** is on Auto. |
| `EMAIL_FROM` | empty | Sender address for alerts and the digest, on a domain with Email Routing. |
| `DIGEST_TO` | empty | Verified recipient addresses, separated by commas. They must also be listed in the `send_email` binding. |
| `CF_ACCOUNT_ID` | empty | Pins the account to watch when the token can see several. Without it, the setup wizard asks. |

Two other settings in `wrangler.jsonc` matter for security:

- `"workers_dev": true` serves the dashboard on `ambersight.<your-subdomain>.workers.dev`. Set it to `false` if you serve Ambersight on a custom domain behind Cloudflare Access, or `workers.dev` stays a public way around Access.
- `"preview_urls": false` keeps Ambersight's own preview URLs off. Leave it that way.

## Settings

Every field below is in `config.json`. The Settings section that edits it is in brackets.

### General

| Field | Default | Range | What it does |
| --- | --- | --- | --- |
| `plan` | `"auto"` | `auto`, `free`, `paid` | Auto detects the plan from Billing. Free turns on the request budget check and the 10 ms CPU checks. |
| `scanIntervalMinutes` | `60` | 15 to 1440 | Minutes between scans. The cron fires every 15 minutes and skips runs inside the interval. |
| `inventoryIntervalHours` | `24` | 6 to 168 | Hours between full inventory refreshes (routes, domains, storage lists, Access). |
| `inventoryHourUtc` | `3` | 0 to 23 | The UTC hour the daily inventory refresh prefers. |
| `timeZone` | `"UTC"` | Any IANA zone, such as `Europe/Prague` | Used for the digest time and quiet hours. |
| `retentionDays` | `30` | 7 to 90 | Days of history to keep. Also caps the window of the no-traffic check. |
| `updateCheck` | `true` | | Asks GitHub once a day for the latest release number and shows a notice when there is a newer one. |

### Checks

| Field | Default | What it does |
| --- | --- | --- |
| `modules.usage` | `true` | Free plan budget, runaway usage, storage and log costs |
| `modules.errors` | `true` | Errors and limits |
| `modules.cron` | `true` | Cron health |
| `modules.deprecation` | `true` | Deprecations |
| `modules.exposure` | `true` | Exposure |
| `modules.access` | `false` | The Access coverage check, inside exposure. Needs *Access: Apps and Policies Read*. |
| `modules.zombies` | `true` | Zombies and orphans |
| `modules.timeline` | `true` | Deploy history and linking problems to the deploy that caused them |
| `mutedChecks` | `[]` | Individual checks switched off, by ID, for example `"zombies:unbound-kv"`. The IDs are in [checks.md](checks.md). |

### Thresholds

| Field | Default | Range | Used by |
| --- | --- | --- | --- |
| `budgetWarn` | `0.7` | 0.05 to 1 | Free plan budget: share of 100,000 requests for a warning |
| `budgetCritical` | `0.9` | 0.05 to 1 | Same, for critical. Must be above `budgetWarn`. |
| `errorWarn` | `0.02` | 0.001 to 0.5 | 24-hour error rate for a warning |
| `errorCritical` | `0.1` | 0.001 to 0.5 | Same, for critical. Must be above `errorWarn`. |
| `errorBaselineMultiplier` | `3` | 1.5 to 50 | Error rate compared with the Worker's previous 6 days |
| `runawayMultiplier` | `5` | 2 to 50 | Last hour compared with the 7-day median hour, for runaway and storage checks |
| `cpuShareWarn` | `0.8` | 0.1 to 1 | Share of the CPU limit for the near-limit checks |
| `compatAgeMonths` | `12` | 1 to 36 | Age of the compatibility date |
| `zombieDays` | `30` | 7 to 365 | Days without traffic before a Worker counts as a zombie |
| `deployWindowMinutes` | `60` | 5 to 1440 | How long after a deploy a new problem is blamed on it |

### Groups & scope

Groups let you set thresholds, filter the overview and send digests for a set of Workers at once.

```json
"groups": {
  "api": ["api-*", "auth-gateway"],
  "client-acme": ["acme-*"]
}
```

Patterns match Worker names, with `*` as a wildcard. Matching is case-sensitive, like Worker names. **Cloudflare tags become groups automatically**, so a Worker tagged `production` is in the group `production` without any config.

`scope` decides which Workers Ambersight watches at all:

```json
"scope": {
  "include": [],
  "exclude": ["*-preview", "group:sandbox"]
}
```

An empty `include` means every Worker. `exclude` always wins. Both take name patterns or `group:<name>`.

### Overrides

Overrides change thresholds for one group or one Worker. A Worker's own override beats its groups, and a group beats the global value.

```json
"overrides": {
  "group:api": { "errorWarn": 0.005, "errorCritical": 0.02 },
  "legacy-proxy": { "compatAgeMonths": 36 },
  "nightly-export": { "runawayMultiplier": 20 }
}
```

Only the thresholds you list change. A few checks read only the global thresholds: the free plan budget (it is account-wide), the storage and Durable Object spikes, and the cron CPU check.

### Alerts

```json
"alerts": {
  "critical": { "instant": "email", "digest": true },
  "warning": { "instant": "off", "digest": true },
  "info": { "instant": "off", "digest": true },
  "quietHours": { "start": "22:00", "end": "07:00" }
}
```

`instant` is `email`, `webhook`, `both` or `off`. `quietHours` is `null` for none. See [alerts.md](alerts.md).

### Digest

```json
"digest": {
  "frequency": "weekly",
  "weekday": 1,
  "hour": 8,
  "groupRecipients": { "client-acme": ["ops@acme.example"] }
}
```

`frequency` is `weekly`, `daily` or `off`. `weekday` runs from 0 (Sunday) to 6. `hour` is in `timeZone`. Every address in `groupRecipients` must also be in `DIGEST_TO`.

## Importing a config

**Settings › Backup › Import** loads a `config.json` so you can review it before saving. A file from an older version still works: missing sections fall back to their defaults. A value out of range is refused with a message that names the field, for example *"thresholds.errorWarn must be a number from 0.001 to 0.5."*
