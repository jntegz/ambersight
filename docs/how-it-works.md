# How it works

Ambersight is one Worker, one D1 database and one Cron Trigger, all in your own Cloudflare account. It reads what Cloudflare already records about your Workers, keeps a short history in D1, and compares each Worker with its own past. One install can watch every account its token can see.

It never deploys, edits or deletes anything. It sends only `GET` requests and GraphQL queries to the Cloudflare API, with a token that has no write permissions.

## The schedule

The Cron Trigger fires every 15 minutes. Each run first reads the time of the last scan from D1. If the scan interval has not passed yet (one hour by default), the run stops there, after a few small D1 queries. That is why you can change the interval in **Settings › General** without redeploying: anything from 15 minutes to 24 hours.

You can also start a scan at any time with **Scan now** in the dashboard.

### Several accounts

Each cron run scans one account: the one that is most overdue. A scan that fails counts as an attempt, so one broken account cannot hold up the others. With many accounts, each one is scanned about every *accounts × 15 minutes* unless you add the optional **scan queue** (`SCAN_QUEUE` in `wrangler.jsonc`, free up to 10,000 operations a day). With the queue, the cron puts every due account on it, and each scan runs in its own invocation with its own subrequest budget. A scan that runs out of budget, for example on a fleet of several hundred Workers or many zones, continues in a follow-up message, up to 20 times. A follow-up only reads what is left (per-Worker detail and zones); it does not repeat the metrics, cron, notification and audit reads, or send alerts.

## What one scan does

1. **Lists your Workers**, with their handlers, `workers.dev` and preview settings, and observability settings. A Worker that appeared or disappeared since the last scan is recorded for the digest.
2. **Reads hourly metrics** from the GraphQL Analytics API: requests, errors, CPU time (total, median and p99), wall time (median and p99), subrequests and invocations that hit a limit, by limit. The totals and the limit outcomes come in one request. It fetches from the last stored hour (to complete it) onwards, at most 48 hours back.
3. **Reads cron runs** for Workers with a `scheduled()` handler, for the last 25 hours. If the dataset is not available on your account, Ambersight tries again once a day.
4. **Reads storage operations** for D1, KV, R2, Queues and Durable Objects, but only for the kinds your account actually has, all kinds in one request. The same query carries the free-limit numbers: D1 rows read and written, and KV operations by type, which are also kept per database and namespace. Workflow steps and Workers AI neurons are read only when a Worker binds them.
5. **Refreshes the inventory** once a day, at 03:00 UTC by default: custom domains, the zone list, Pages projects, the lists of KV namespaces, D1 databases, R2 buckets and queues, Access applications if that check is on, storage sizes, the most expensive D1 queries, the plan, the API token's expiry date, and the update check.
6. **Reads Cloudflare's own notifications and the audit log** every 6 hours, each since its last read.
7. **Works through the zones**: routes, certificates and DNS records, per zone, the most overdue first, with a share of the scan's budget. Each zone is read at least once a day.
8. **Fetches per-Worker detail**: bindings and compatibility settings, deployments and cron schedules. Each Worker's detail is refreshed every 6 hours, a few Workers per scan. A binding that disappeared since the last read is noted for the drift check.
9. **Writes everything to D1** in one batch, and folds each complete UTC day into the daily tables (a few days per scan at most, two hours after midnight so late data has arrived).
10. **Runs the checks** on the stored history. The checks are pure functions, data in and findings out, so they cost almost no CPU. See [checks.md](checks.md).
11. **Sends alerts and the digest** if any are due, then records what the scan itself cost, and a row in the scan log.

When an account rejects a combined GraphQL request, Ambersight reads its datasets one by one again and retries the combination a day later. The same goes for the median and wall-time fields.

## What a page view costs

Nothing on the Cloudflare side: every page reads Ambersight's own D1 database. The overview, Analytics, Worker pages, Timeline and Resources are built once after each change (a scan, an acknowledge or snooze, a settings save) and then served from one cached row. An API client that already has the current version gets `304 Not Modified` through the ETag. The signed-in dashboard is sent `no-store`, so the browser's HTTP cache keeps no copy. Charts longer than 7 days read the daily tables, so a 12-month chart of 200 Workers reads a few thousand rows, not millions.

## Staying inside the free plan

A Worker on the Free plan gets 50 subrequests and 10 ms of CPU per invocation, and the account gets 5 Cron Triggers. Ambersight is built around those limits:

- A scan spends at most **42 subrequests** on the Cloudflare API on Free (900 on Paid), which leaves room for alerts and the update check. Alert and digest messages are counted as one subrequest each, within what is left, and those that do not fit go out with the next scan. A typical hourly scan makes at most 3 GraphQL requests plus the Workers lists; the daily inventory run uses more.
- D1 counts a `db.batch()` as one query against its 50-per-invocation limit, and every write goes into one batch. A scan makes about 10 D1 calls.
- D1 also bills every row a query scans and every row (and index entry) a write touches: 5 million reads and 100,000 writes a day on Free. Writes skip rows that did not change, the no-traffic check reads each Worker's last active hour instead of 30 days of metrics, and there are no indexes that no query uses. With 200 Workers and 30 days of history, an hourly scan reads about 34,000 rows and writes about 650: roughly 0.8 million reads and 16,000 writes a day.
- The per-Worker detail in step 8 and the zones in step 7 are fetched on **rotating cursors**: whatever was read longest ago goes first, and the scan stops when its budget runs out.
- The cron expression parser counts expected runs hour by hour instead of minute by minute, so a 24-hour window costs about 24 checks.
- Bulk writes go through `json_each` in a single statement, never one statement per row.
- Ambersight's own logs are off, and the dashboard is served as static assets, which do not count as requests.

With 30 Workers, that comes to about 100 cron runs and a few hundred dashboard API calls a day, well under 1% of the 100,000 daily requests. The **Self-cost** panel in Settings shows the measured numbers for your account: cron runs, subrequests, and D1 rows read and written.

### Large fleets

Steps 1 to 6 cover the whole account on every scan. Steps 7 and 8 do not. On a fleet of a few dozen Workers or more, the first scans fill in the detail a few Workers at a time, and the scan warnings say how many are still waiting (*"40 Workers will get their details on the next runs."*). Until every Worker has been read once, the deprecation checks are incomplete and the unbound storage checks wait. After that, each Worker is refreshed every 6 hours.

## What it stores

Everything lives in your own D1 database:

| Table | What is in it |
| --- | --- |
| `workers` | Each Worker's settings, bindings, tags, when its detail was last read, and the last hour it had a request |
| `metrics_hourly` | Requests, errors, CPU, wall time, subrequests and limit hits per Worker per hour |
| `metrics_daily`, `resource_daily`, `quota_daily`, `cron_daily` | The same, one row per UTC day, kept 400 days for Analytics and the Worker pages |
| `schedules` | Each Worker's cron expressions |
| `cron_runs` | Scheduled runs and failures per hour |
| `resources` | KV namespaces, D1 databases, R2 buckets, queues, routes, custom domains and Access applications |
| `resource_hourly` | Storage and Durable Object operations per hour |
| `resource_activity` | The last hour each KV namespace, D1 database, R2 bucket and queue had operations, for the unused-storage checks |
| `deployments` | Deploys per Worker, for the timeline |
| `findings` | Every finding, its status (open, acknowledged, snoozed, resolved) and when it was last alerted |
| `fleet_events` | Workers added to or removed from the account |
| `usage_daily` | Ambersight's own cost, for the Self-cost panel |
| `accounts`, `account_state` | The accounts this install watches, and each one's scan state |
| `quota_hourly` | Account-wide usage per hour for the free limits and the cost estimate (kept at least 35 days) |
| `storage_sizes` | Latest size of each D1 database, KV namespace and R2 bucket, and the Durable Object total |
| `storage_daily` | The same sizes per day, kept 400 days, for growth and the date a cap is reached |
| `finding_events` | Every change of every finding: opened, alerted, acknowledged, snoozed, restored, resolved; kept 400 days |
| `scan_runs` | One row per scan: duration, API calls, D1 rows, warnings, findings opened and resolved; kept 90 days |
| `view_cache` | Dashboard views built after the last change, served until the next; rows from earlier hours are deleted during the daily inventory refresh |
| `api_tokens` | Read-only API tokens, stored only as SHA-256 digests, with their expiry, the credential that issued them, the accounts they may read and whether they may read person-linked data |
| `admin_events` | Sign-ins and security-relevant changes made from the dashboard, with a short session handle; kept 90 days, at most 1,000 |
| `worker_packages`, `npm_latest` | With the Packages check on: direct dependencies of mapped Workers and where the lockfile says they came from, and the latest version on npm of those from the registry |
| `zones` | Each zone and when its routes, certificates and DNS records were last read |
| `cf_alerts` | Notifications Cloudflare sent to the account |
| `audit_events` | The account audit log, without "view" entries |
| `d1_queries` | The most expensive D1 queries of the last day, as their shape only: strings, numbers, blobs and value lists become `?`, and comments are dropped |
| `digest_parts` | Which messages of the current digest went out, one row per message, with each client or group recipient only as a keyed hash; older digests' rows are deleted when the next one starts |
| `cf_incidents` | Recent Cloudflare status incidents, only when that check is on |
| `settings` | Your configuration, the setup state, a passphrase set in Settings (as a PBKDF2 hash) and its binding to the `ADMIN_PASSPHRASE` secret |
| `sessions` | Dashboard sign-ins, stored only as SHA-256 hashes |
| `known_devices` | Browsers that have signed in (at most 10, for 90 days), stored only as SHA-256 hashes, so they can still sign in during a pause |
| `login_attempts` | Passphrase attempts per client and per 15-minute window, for the sign-in limits; every cron run deletes the expired ones |

### How long data is kept

**Settings › General › Keep history for** (`retentionDays`, 30 days by default, 7 to 90) applies to part of this. The rest has its own limit:

| Data | Kept |
| --- | --- |
| `metrics_hourly`, `cron_runs`, `resource_hourly`, `deployments` (with deploy authors), `audit_events` (with actors), `fleet_events`, `cf_alerts`, `cf_incidents`, `usage_daily`, resolved findings | `retentionDays` |
| `quota_hourly` | `retentionDays`, and at least 35 days: the cost estimate needs the whole month |
| `metrics_daily`, `resource_daily`, `quota_daily`, `cron_daily`, `storage_daily`, `finding_events` | 400 days, whatever `retentionDays` says. They hold counts and check names, no deploy authors or actors |
| `scan_runs`, `admin_events` | 90 days |
| Open, acknowledged and snoozed findings, inventory (`workers`, `resources`, `schedules`, `zones` and the like) | Replaced by each scan, for as long as the account is watched |
| `sessions` | 7 days after sign-in |

These deletes run with each account's daily inventory refresh. For **an account no longer scanned** (unticked in Settings, or left out of `CF_ACCOUNT_ID`) the scheduled run does the same once a day, with no Cloudflare calls: history ages out by the rules above, and once the last scan is older than `retentionDays`, its findings of any status, inventory, scan state and account name go too. The 400-day tables last their full 400 days. One row remains, the account ID with its last scan time, so that an account you switched off stays off. A label or client digest addresses you set for it stay in the configuration until you remove them.

### Who made a change

Cloudflare reports who made each deploy (an e-mail address) and each audit-log change (an e-mail address, a token name or the kind of caller). Ambersight stores this so that you know who to ask when a change breaks something. It is shown in the dashboard and to API tokens created with person-linked data, and the main digest e-mail lists deploy authors. Client digests, reports, alerts, webhooks and the AI summary leave it out. **Settings › General › Record who made changes** (`recordAttribution`, on by default) decides whether it is kept.

With it off:

- A scan stores no deploy author and no audit-log actor, and no ID of an account member or user that an audit-log entry is about. Findings keep no actor, member or "changed by" evidence. In deploy messages and audit-log descriptions, the person's address or token name becomes `[person]` where it stands on its own, unless the token is named after a common audit-log word such as `deploy`. Any other e-mail address there, and every e-mail address in Cloudflare notifications, becomes `[email]`.
- The timeline and the Worker page say that this is not recorded, and the digest shows no authors.
- Every check keeps working. None of them reads who made a change, so the same findings are raised with the same text. For that reason the switch is logged as a settings change and not as reduced detection.

**Turning it off erases what is stored**, and cannot be undone, so Settings asks first. The names go from `deployments`, `audit_events`, `cf_alerts` and `findings`, and the cached views are deleted; the rest of each row stays. The save handles up to 3,000 rows per table. The scheduled runs finish a larger history, and also clean up after a scan that was already running when you saved.

**Turning it on again** affects future scans only. Erased names do not come back, even for deploys and audit entries Cloudflare still lists: a deploy from before that moment is stored without its author. While erasing is unfinished, turning it on is refused. It has to be turned on deliberately: `PUT /api/config` needs `confirmRecord: true` for this, and without it the setting stays off, so a browser tab opened earlier or a restored backup cannot turn it back on.

The switch recognises people by the address or token name Cloudflare reports, and by the form of an e-mail address. It does not find a first name someone typed into a deploy message, and it does not touch Worker, branch or API token names, the Cloudflare account name (which can contain an address), the digest recipients in your settings, the session handles in the admin log, mail and chat messages already sent, or Cloudflare's own audit log.

### Removing one person from stored data

**Settings › Security › Remove one person from stored data** finds one e-mail address or name and replaces it with `[removed]`. The rows stay, so history, counts and finding identity keep working. It needs a dashboard session and cannot be used with an API token.

1. **Preview.** Enter the exact address or name, with at least three letters or digits. You get a count per kind of data, never the records. A long search can stop before the end: the page says so and lets you continue, and nothing can be replaced until it has finished.
2. **Replace.** Confirm with your passphrase. The step only accepts an identifier this session finished previewing in the last hour or two. It cannot be undone.

Matching takes the input literally, including `%` and `_`. An address matches in any case, and only as a whole address: `ann@example.com` leaves `joann@example.com` and `ann@example.com.au` alone. A name matches only as typed, capitals included, and only as a whole name: `Ann` leaves `ann`, `Channel`, `Ann-Marie`, `Ann.Lee` and `Ann@example.com` alone, so search for each form, and for a name and an address, separately. A single word can still be an ordinary word in text people wrote, and the preview warns about that. JSON is parsed and its values are rewritten one by one, so it stays valid. Its keys never change.

| Data | What happens |
| --- | --- |
| `deployments` (author, message), `audit_events` (actor, description, and the resource ID when it identifies a person), `findings` (message, evidence), `admin_events` (summary), `cf_alerts` (name, description), `accounts` (name), `api_tokens` (name), the last scan error and warnings in `account_state` | The identifier is replaced. In a finding's message and its `change` evidence, a name is replaced only inside quoted text, because the rest is Ambersight's own sentence. A finding's advice is never changed |
| `digest_parts` | Nothing to replace: recipients are stored as an HMAC keyed with the `CF_API_TOKEN` secret (`ADMIN_PASSPHRASE` only if there is no token), so a removal cannot change what counts as sent. Rows in the older form, with a plain address, still count as sent; a removal or the next digest hashes them, and they age out with their digest. Replacing the token while a digest is unfinished can send that digest once more to its client and group recipients |
| `view_cache` | Every cached view is deleted when the run ends. The preview's count for it is approximate |
| `workers` (name, tags, bindings), the `workers.dev` subdomain, `zones`, `resources` (name, details), `fleet_events` (detail), audit-log resource IDs that do not identify a person | Counted only. These identify things in Cloudflare, link records together and return with each scan, so change them there |
| Digest recipients, account labels, groups and other settings; a waiting admin notice's recipients; `DIGEST_TO`, `DIGEST_OPERATORS`, `EMAIL_FROM` | Listed by where they are, for you to change. Editing them here could silently change who gets mail |

`finding_events`, the daily tables and `d1_queries` are not searched: they hold counts, check names and query shapes, with no free text about people. Finding IDs stay as they are.

The work runs in small steps, and the page continues until it is done. One request looks closely at no more than 100 candidate rows and reads at most 20,000. Each step returns a signed position that only this session can use, for this identifier, and only for a limited time (an hour in a preview, 15 minutes in a removal). In a removal it also stands in for the passphrase, which is checked once, on the first step. Repeating a step or the whole run is safe, because a replaced value no longer matches. A value that a scan changes in the meantime is read again.

The identifier is not stored or logged. The admin log records that a search finished or a removal ran and, for a removal, how many records changed. A removal also sends the operators a notice.

**What this cannot reach:** e-mail, webhook and chat messages already sent; what their recipients kept or forwarded; copies in other browsers, offline copies there, exports and printouts (the offline copies in the browser that ran the removal are cleared); database backups and D1 Time Travel restore points until they expire; and what Cloudflare itself holds. Cloudflare's deployment records and audit log still name the person, so a later scan can store them again. Turning off **Record who made changes** stops authors and actors being stored and takes their address or token name out of new text, but a name someone typed into a new deploy message can still come back. Saving the watched accounts in Settings, or a later account refresh, stores the account name Cloudflare reports again.

The API token is a Worker secret. It is never written to D1, logged or sent to the browser.

## How findings live and die

Each finding has a stable ID made from the check, the Worker and the resource it is about. Every scan raises the findings that apply right now:

- A finding that is raised for the first time opens.
- A finding that is not raised again resolves on its own. You do not have to close anything.
- **Acknowledge** keeps a finding out of the list and out of alerts. If its severity changes later, for example a warning becomes critical, it opens again.
- **Snooze** does the same for 7, 30 or 90 days, then the finding opens again if it still applies.
- Switching a check off resolves its open findings.

Findings from the same check are grouped in the overview, so fourteen Workers with public preview URLs are one row with one fix.

## What stays in your browser

The dashboard works from the API and stores nothing it needs to keep. Two things stay in the browser:

- **Offline copies**, in the service worker's cache, so that the installed app opens without a connection: the page and its assets, plus the last overview, accounts, findings, analytics, resources, packages and self-cost answers (at most 60). Timeline and Worker pages are not kept, because they name who deployed and who changed what, so they need a connection. People named in a finding's evidence are removed from the copy.
- **Preferences**, in `localStorage`: theme, dismissed update notice, sort order, layout and filters, plus the selected account, the time of your last visit per account and the group you filtered by.

An offline copy is served for 7 days, as long as a session lasts, and deleted after that. All copies go as soon as the browser sees that the session has ended, and when you sign out. The selected account, last-visit times and chosen group go with them, so **Since your last visit** starts again after the next sign-in; the other preferences stay.

If the server cannot confirm a sign-out, the sign-in page says that the session may still be active and offers to try again. The browser also retries when the connection returns and at the next page load.

## Where your data goes

Ambersight talks to these places, and only these:

- `api.cloudflare.com`, to read your account.
- `api.github.com`, once a day, to read the latest release number for the update notice. Nothing about your account is sent. Turn it off in **Settings › General**.
- The e-mail address and webhook you configure, for alerts.
- Only if you turn the check on: `www.cloudflarestatus.com`, Cloudflare's public status page, once a day and when an alert is about to go out. The request carries nothing about your account.
- Only if you set up Turnstile: `challenges.cloudflare.com`, to check the sign-in challenge.

The optional Workers AI summary runs on Workers AI in your own account. It is given each check's severity, name and number of findings and the names of the Workers affected, and nothing else: no finding text, account names or people's names.

There is no telemetry and no analytics.
