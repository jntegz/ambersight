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
| `TURNSTILE_SECRET` | No | The secret key of a Cloudflare Turnstile widget. With `TURNSTILE_SITE_KEY`, the sign-in page asks for a Turnstile check before the passphrase. |

Set them with `npx wrangler secret put <NAME>`, or in the Cloudflare dashboard under **ambersight › Settings › Variables and Secrets**.

## Variables in `wrangler.jsonc`

| Variable | Default | What it does |
| --- | --- | --- |
| `PLAN` | `"free"` | The fallback plan, `free` or `paid`. Used only when the plan cannot be detected (the token lacks *Billing Read*) and **Settings › General** is on Auto. |
| `EMAIL_FROM` | empty | Sender address for alerts and the digest, on a domain with Email Routing. |
| `DIGEST_TO` | empty | Verified recipient addresses, separated by commas. They must also be listed in the `send_email` binding. |
| `CF_ACCOUNT_ID` | empty | Pins the accounts to watch, as a comma-separated list of account IDs. Without it, you choose the accounts in the setup wizard and in **Settings › Accounts**. |
| `TURNSTILE_SITE_KEY` | empty | The site key of a Cloudflare Turnstile widget (free). Turnstile is on only when this and the `TURNSTILE_SECRET` secret are both set. |

## Optional bindings

Each of these is free, commented out in `wrangler.jsonc`, and off until you uncomment it. A fresh install needs none of them.

| Binding | What it adds | Free allowance |
| --- | --- | --- |
| `SCAN_QUEUE` (`queues`) | Every due account is scanned on time, each in its own run with its own subrequest budget. A scan that runs out of budget continues in a follow-up message, up to 20, so large fleets and many zones finish in one go. Create the queue once with `npx wrangler queues create ambersight-scans`. | 10,000 queue operations a day. 14 accounts scanned hourly use about 1,000. |
| `AI` (`ai`) | A plain-language summary at the top of the digest. Turn it on in **Settings › Digest**. | 10,000 Workers AI neurons a day; one digest uses a few hundred. |
| `BROWSER` (`browser`) | The client report as a PDF. Without it, the report opens as a page you can print to PDF. | 10 minutes of browser time a day. |

Without the scan queue, one cron run scans one account, so with many accounts each account is scanned about every *accounts × 15 minutes* (for example 2 hours for 8 accounts). **Settings › Accounts** shows the real interval.

The PDF report uses `@cloudflare/playwright`, which makes the Worker bundle about 3.6 MB (720 KB compressed). It is loaded only when a PDF is asked for.

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

### Accounts

One install can watch every account its token can see. Choose them in the setup wizard or **Settings › Accounts** (this list is stored in D1, not in `config.json`). Per-account settings are in `config.json`:

```json
"accounts": {
  "0123456789abcdef0123456789abcdef": { "label": "Client A", "plan": "paid", "digestTo": ["ops@client-a.example"] }
}
```

| Field | What it does |
| --- | --- |
| `label` | The name shown in the dashboard, alerts and the digest, instead of the Cloudflare account name. One line, up to 60 characters. |
| `plan` | `auto`, `free` or `paid` for this account. Wins over the global `plan`. |
| `digestTo` | Sends this account its own digest (a client report by e-mail) on the digest schedule. Every address must also be in `DIGEST_TO`. |

### Checks

| Field | Default | What it does |
| --- | --- | --- |
| `modules.usage` | `true` | Free plan limits, runaway usage, idle loops, storage caps, expensive D1 queries and log volume |
| `modules.errors` | `true` | Errors and limits |
| `modules.cron` | `true` | Cron health |
| `modules.deprecation` | `true` | Deprecations |
| `modules.exposure` | `true` | Exposure |
| `modules.access` | `false` | The Access coverage check, inside exposure. Needs *Access: Apps and Policies Read*. |
| `modules.zombies` | `true` | Zombies and orphans |
| `modules.timeline` | `true` | Deploy history, linking problems to the deploy that caused them, and stuck gradual rollouts |
| `modules.cost` | `true` | The estimated bill on Workers Paid, and dollars on runaway findings |
| `modules.cfAlerts` | `true` | Notifications Cloudflare sent to the account, on the timeline. Needs *Notifications Read*. |
| `modules.pages` | `true` | Pages projects: failed deploys and public `pages.dev` addresses. Needs *Pages Read*. |
| `modules.security` | `true` | Audit log (members, tokens), certificates and dangling DNS. Needs *SSL and Certificates Read* and *DNS Read*. |
| `modules.drift` | `true` | Bindings that disappeared, staging and production that differ, the 64-variable limit |
| `modules.incidents` | `false` | Active incidents from the public status page `www.cloudflarestatus.com`, on alerts and the timeline. The only module that contacts a host outside Cloudflare's API; the request carries nothing about your account. |
| `mutedChecks` | `[]` | Individual checks switched off, by ID, for example `"zombies:unbound-kv"`. The IDs are in [checks.md](checks.md). |

### Thresholds

| Field | Default | Range | Used by |
| --- | --- | --- | --- |
| `budgetWarn` | `0.7` | 0.05 to 1 | Free plan limits: share of a daily limit (requests, D1 rows, KV operations and the rest) for a warning |
| `budgetCritical` | `0.9` | 0.05 to 1 | Same, for critical. Must be above `budgetWarn`. |
| `errorWarn` | `0.02` | 0.001 to 0.5 | 24-hour error rate for a warning |
| `errorCritical` | `0.1` | 0.001 to 0.5 | Same, for critical. Must be above `errorWarn`. |
| `errorBaselineMultiplier` | `3` | 1.5 to 50 | Error rate compared with the Worker's previous 6 days |
| `runawayMultiplier` | `5` | 2 to 50 | Last hour compared with the 7-day median hour, for runaway and storage checks |
| `cpuShareWarn` | `0.8` | 0.1 to 1 | Share of the CPU limit for the near-limit checks |
| `compatAgeMonths` | `12` | 1 to 36 | Age of the compatibility date |
| `zombieDays` | `30` | 7 to 365 | Days without traffic before a Worker counts as a zombie |
| `deployWindowMinutes` | `60` | 5 to 1440 | How long after a deploy a new problem is blamed on it |
| `newWorkerHourlyRequests` | `50000` | 1,000 to 100,000,000 | Requests in one hour that count as a burst for a Worker with under 72 hours of history |
| `newResourceHourlyOps` | `100000` | 1,000 to 100,000,000 | Storage or Durable Object operations in one hour that count as a burst for a new resource |
| `rolloutMaxHours` | `24` | 1 to 720 | How long a gradual rollout may split traffic before it is reported as stuck |

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
  "groupRecipients": { "client-acme": ["ops@acme.example"] },
  "aiSummary": false,
  "aiModel": "@cf/meta/llama-3.2-3b-instruct"
}
```

`frequency` is `daily`, `weekly`, `monthly` (on the 1st) or `off`. `weekday` runs from 0 (Sunday) to 6. `hour` is in `timeZone`. Every address in `groupRecipients` must also be in `DIGEST_TO`. `aiSummary` needs the `AI` binding; `aiModel` is any Workers AI text model ID.

## Importing a config

**Settings › Backup › Import** loads a `config.json` so you can review it before saving. A file from an older version still works: missing sections fall back to their defaults. A value out of range is refused with a message that names the field, for example *"thresholds.errorWarn must be a number from 0.001 to 0.5."*
