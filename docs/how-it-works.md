# How it works

Ambersight is one Worker, one D1 database and one Cron Trigger, all in your own Cloudflare account. It reads what Cloudflare already records about your Workers, keeps a short history in D1, and compares each Worker with its own past.

It never deploys, edits or deletes anything. It sends only `GET` requests and GraphQL queries to the Cloudflare API, with a token that has no write permissions.

## The schedule

The Cron Trigger fires every 15 minutes. Each run first reads the time of the last scan from D1. If the scan interval has not passed yet (one hour by default), the run stops there, after a single D1 read. That is why you can change the interval in **Settings › General** without redeploying: anything from 15 minutes to 24 hours.

You can also start a scan at any time with **Scan now** in the dashboard.

## What one scan does

1. **Lists your Workers**, with their handlers, `workers.dev` and preview settings, and observability settings. A Worker that appeared or disappeared since the last scan is recorded for the digest.
2. **Reads hourly metrics** from the GraphQL Analytics API: requests, errors, CPU time, subrequests and invocations that hit a limit. It fetches only the hours since the last stored hour, at most 48 hours back.
3. **Reads cron runs** for Workers with a `scheduled()` handler, for the last 25 hours. If the dataset is not available on your account, Ambersight tries again once a day.
4. **Reads storage operations** for D1, KV, R2, Queues and Durable Objects, but only for the kinds your account actually has.
5. **Refreshes the inventory** once a day, at 03:00 UTC by default: custom domains, routes (up to 20 zones per run), the lists of KV namespaces, D1 databases, R2 buckets and queues, Access applications if that check is on, and the update check.
6. **Fetches per-Worker detail**: bindings and compatibility settings, deployments and cron schedules. Each Worker's detail is refreshed every 6 hours, a few Workers per scan.
7. **Writes everything to D1** in one batch.
8. **Runs the checks** on the stored history. The checks are pure functions, data in and findings out, so they cost almost no CPU. See [checks.md](checks.md).
9. **Sends alerts and the digest** if any are due, then records what the scan itself cost.

## Staying inside the free plan

A Worker on the Free plan gets 50 subrequests and 10 ms of CPU per invocation, and the account gets 5 Cron Triggers. Ambersight is built around those limits:

- A scan spends at most **42 subrequests** on the Cloudflare API on Free (900 on Paid), which leaves room for alerts and the update check.
- The per-Worker detail in step 6 is fetched on a **rotating cursor**: the Workers that were checked longest ago go first, and the scan stops when its budget runs out.
- The cron expression parser counts expected runs hour by hour instead of minute by minute, so a 24-hour window costs about 24 checks.
- Bulk writes go through `json_each` in a single statement, never one statement per row.
- Ambersight's own logs are off, and the dashboard is served as static assets, which do not count as requests.

With 30 Workers, that comes to about 100 cron runs and a few hundred dashboard API calls a day, well under 1% of the 100,000 daily requests. The **Self-cost** panel in Settings shows the measured numbers for your account: cron runs, subrequests, and D1 rows read and written.

### Large fleets

Steps 1 to 5 cover the whole account on every scan. Step 6 does not. On a fleet of a few dozen Workers or more, the first scans fill in the detail a few Workers at a time, and the scan warnings say how many are still waiting (*"40 Workers will get their details on the next runs."*). Until every Worker has been read once, the deprecation checks are incomplete and the unbound storage checks wait. After that, each Worker is refreshed every 6 hours.

## What it stores

Everything lives in your own D1 database:

| Table | What is in it |
| --- | --- |
| `workers` | Each Worker's settings, bindings, tags and when its detail was last read |
| `metrics_hourly` | Requests, errors, CPU and subrequests per Worker per hour |
| `schedules` | Each Worker's cron expressions |
| `cron_runs` | Scheduled runs and failures per hour |
| `resources` | KV namespaces, D1 databases, R2 buckets, queues, routes, custom domains and Access applications |
| `resource_hourly` | Storage and Durable Object operations per hour |
| `deployments` | Deploys per Worker, for the timeline |
| `findings` | Every finding, its status (open, acknowledged, snoozed, resolved) and when it was last alerted |
| `fleet_events` | Workers added to or removed from the account |
| `usage_daily` | Ambersight's own cost, for the Self-cost panel |
| `settings` | Your configuration and the setup state |
| `sessions` | Dashboard sign-ins, stored only as SHA-256 hashes |
| `login_attempts` | Wrong passphrase counts, for the sign-in lockout |

History is kept for 30 days by default (7 to 90 in **Settings › General**). Older metrics, resolved findings, deploys and expired sessions are deleted during the daily inventory refresh.

The API token is a Worker secret. It is never written to D1, logged or sent to the browser.

## How findings live and die

Each finding has a stable ID made from the check, the Worker and the resource it is about. Every scan raises the findings that apply right now:

- A finding that is raised for the first time opens.
- A finding that is not raised again resolves on its own. You do not have to close anything.
- **Acknowledge** keeps a finding out of the list and out of alerts. If its severity changes later, for example a warning becomes critical, it opens again.
- **Snooze** does the same for 7, 30 or 90 days, then the finding opens again if it still applies.
- Switching a check off resolves its open findings.

Findings from the same check are grouped in the overview, so fourteen Workers with public preview URLs are one row with one fix.

## Where your data goes

Ambersight talks to three places, and only these:

- `api.cloudflare.com`, to read your account.
- `api.github.com`, once a day, to read the latest release number for the update notice. Nothing about your account is sent. Turn it off in **Settings › General**.
- The e-mail address and webhook you configure, for alerts.

There is no telemetry and no analytics.
