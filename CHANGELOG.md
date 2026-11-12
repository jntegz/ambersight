# Changelog

All notable changes to Ambersight. Each version here has a matching [GitHub release](https://github.com/jntegz/ambersight/releases), which is what the update notice in the dashboard reads.

## 1.1.2 (2026-11-12)

The biggest release yet: 13 months of history, a page per Worker, an Analytics page, budgets and a read-only API, built from the data each scan already reads. An hourly scan makes fewer Cloudflare API calls than before. Upgrading runs migrations 0011 to 0013; `npm run deploy` applies them.

- **Fewer false runaway alerts.** The "5x usual" checks compare an hour with the same hour of day over the last week when that is higher than the plain median, so a nightly batch or a daily peak no longer raises an alert. No check becomes more sensitive.
- **What changed just before.** A traffic, CPU or storage spike, or an error rise, that no deploy explains now names the binding that disappeared or the audit log change in the 6 hours before it.
- **Median CPU time and wall time** per Worker, read in the request that already reads CPU p99 (migration 0012). An account whose schema rejects these fields is asked without them, and again a day later. The Worker page charts them.
- **Monthly budget** per account on Workers Paid (**Settings › Accounts**): a finding at 80% of it, past it, and when the month-end forecast passes it, within the hour. The estimated bill shows the budget as a bar.
- **Read-only API tokens** (**Settings › Security**) for Ambersight's own JSON API: overview, analytics, Worker pages, findings and the timeline for Grafana or scripts. A token cannot change anything or read settings. Only a digest is stored (migration 0013). See [docs/api.md](docs/api.md).
- **Since your last visit** on the overview: findings opened, made worse and resolved since this browser last opened it.
- **Compare Workers**: tick two to four Workers in **Analytics › Trends** to see requests, error rate and CPU per request on shared axes.
- **Installable app**: add Ambersight to your home screen or dock. It opens offline with the last data it showed; signing out clears that copy.
- **Worker page** (`#/worker/<name>`): requests, errors, error rate, CPU p99 and CPU per request, subrequests, limit hits by type and cron runs over 24 hours to 12 months, with deploys marked on every chart. Each deploy shows error rate, CPU and traffic for the 24 hours before and after. Also the Worker's open and resolved findings with their history, recent changes (bindings removed, audit log), entry points and bindings. Every Worker name in the app now links here; old `#w-<name>` links still work.
- **Analytics page** with a time range from 24 hours to 12 months and a comparison with the period before:
  - **Trends**: totals with their change, requests and errors for the account, error rate and CPU per request, the Workers growing and shrinking fastest, and a sortable table of every Worker with a sparkline.
  - **Cost** (Workers Paid): the estimated bill per month, usage at list price per day, and Workers by cost per month and per million requests.
  - **Limits and storage**: each daily quota per day against its free limit, how often it ran above 70% or 90% or ran out, its usual busiest hour; storage size, growth per day and the date it reaches its cap at that pace.
  - **Reliability**: findings opened and resolved per day, median time to resolve by severity, deploys per day and how many were followed by a finding, and alert quality per check, which flags checks whose findings are mostly acknowledged or snoozed.
- **Findings inbox** (`#/findings`): open, acknowledged, snoozed and resolved findings, each with a **History**; **Restore** undoes an acknowledge or a snooze, one at a time or all at once.
- **Charts** with axes, units, gridlines, deploy markers and limit lines. Use the arrow keys on a focused chart to read each hour or day; screen readers announce each value. **Show data** opens the numbers as a table and **Download CSV** saves them; the Analytics tables export as CSV too.
- **Go to** with Ctrl+K or Cmd+K: any Worker, page or account by typing part of its name. `g` then `o`, `a`, `f`, `t`, `r` or `s` opens Overview, Analytics, Findings, Timeline, Resources or Settings.
- The time range, tab and status are in the URL, so a view can be bookmarked or shared.
- All of it reads Ambersight's own D1 database. Opening a page makes no Cloudflare API call.
- **History for 13 months.** Each complete UTC day is folded into daily tables (`metrics_daily`, `resource_daily`, `quota_daily`, `cron_daily`), kept for 400 days while the hourly rows keep their retention. Storage sizes are kept per day (`storage_daily`) instead of being overwritten. The upgrade builds the daily rows from the hourly history already stored (migration 0011).
- **Finding history.** Every open, reopen, escalation, resolve, acknowledge, snooze, restore and alert is recorded in `finding_events`, and each finding counts its reopens.
- **Undo acknowledge and snooze**, and list findings by status: `GET /api/findings?status=acknowledged`, `POST /api/findings/:id/restore` and the `restore` bulk action. `GET /api/findings/:id/history` returns a finding's events.
- **Splits that used to be thrown away are kept:** limit hits by type (CPU, memory), D1 rows read and written and read and write queries per database, KV reads, writes, deletes and lists per namespace.
- **Fewer Cloudflare API calls.** The hourly totals and the limit outcomes are read in one GraphQL request, the storage operations of every kind in one, and the daily storage sizes in one. An hourly scan now makes at most 3 GraphQL requests instead of up to 8. An account that rejects a combined request is read the old way and asked again a day later.
- **Faster, cheaper page loads.** The overview, All accounts, Timeline, Resources and Packages are built once per change and served from one D1 row, with an ETag: a browser that already has the current version gets a `304`. The dashboard's request count is written every 10 requests instead of once per request.
- **Scan log**: one row per scan in `scan_runs` (duration, calls, D1 rows, warnings, findings opened and resolved), kept 90 days.
- Fixed: the Self-cost panel showed the oldest day as today, and its bars ran backwards. The overview no longer sends an unused 24-hour series per Worker.

- **Explain in plain words** on every finding: what it means, why it matters, and numbered steps with where to click, written for people new to Cloudflare. Also in the `.md` export. A test fails if a check has no explanation.
- **Clean up leftovers.** Unused KV, D1, R2 and queues, and Workers with no traffic or never deployed, now show **How to remove it** with the exact `wrangler` command (a backup first for D1). Routes and custom domains left behind get the dashboard or API step. Ambersight still never deletes anything.
- **Export .md** next to **Needs attention** and **Housekeeping**: the findings as a Markdown checklist, and for Housekeeping every cleanup command in one block.
- **Is it safe to remove?** Storage not bound to any Worker now shows when it was last used, from any source (the API and S3 clients count too), its size and whether it is empty. One with operations in the last 48 hours is marked as still used and gets no delete command. Bindings are read from every Worker in the account, so storage used by an out-of-scope Worker is no longer reported as unbound.
- **Bound but idle**: four new checks, `zombies:bound-idle-kv`, `-d1`, `-r2` and `-queues`, for storage a Worker binds but has not used in 30 days.
- **Leaves behind**: a Worker with no traffic or never deployed lists the storage only it uses, and **How to remove it** includes the commands for that storage.
- **Resources page** with every KV namespace, D1 database, R2 bucket and queue: who binds it, size, last use and status. Housekeeping shows what removing the unused storage would free and how many items were resolved this week; the digest has the same count.
- No new API calls or token permissions. One small table, `resource_activity`, keeps one row per resource, written at most every 6 hours (migration 0010). "No operations" is only claimed for a storage kind read without a gap for the whole period.
- Fixed: long cleanup commands widened the page on phones, and a missing space in **How to remove it**.
- **Packages (opt-in, off by default).** Map a Worker to its GitHub repository in **Settings › Checks** and the new **Packages** page shows each direct npm dependency as *locked → latest*. Two checks: `packages:outdated` (Warning when a major version behind) and `packages:lockfile-unreadable`. Needs a separate fine-grained `GITHUB_TOKEN` with *Contents: Read*; the Cloudflare token stays read-only. Reads `package-lock.json` v2/v3 once a day, inside the scan's subrequest budget (migration 0009).

## 0.1.1 (2026-11-10)

Everything here is built on free Cloudflare features and keeps the read-only token. See [docs/research/free-cloudflare-features.md](docs/research/free-cloudflare-features.md) for why each one was chosen.

- **Several accounts in one install.** Tick the accounts to watch in the setup wizard or **Settings › Accounts**; an account switcher and an **All accounts** view appear. Each account can have its own label, plan and client digest. Existing installs keep their history (migration 0005).
- **74 checks** (from 39):
  - every free daily limit, not just requests: D1 rows, KV reads/writes/deletes/lists, Durable Objects, Queues, Workflows, Workers AI;
  - storage caps for D1 (per database and per account), KV, R2 and Durable Objects;
  - idle loops (Durable Object alarm or Queue retry loops with no traffic) and bursts on new Workers;
  - Pages failed deploys and `pages.dev` exposure;
  - audit log: new members and API tokens;
  - certificates expiring, failed or stuck; DNS records pointing at deleted Pages projects or Workers;
  - stuck gradual rollouts; config drift (bindings that disappeared, staging vs production, the 64-variable limit);
  - expensive D1 queries; subrequests close to 50 per invocation on Free;
  - log volume under the per-GB pricing from 1 December 2026;
  - Ambersight's own API token expiring; `nodejs_compat` as a redundant flag from 2026-08-04.
- **Estimated bill** on Workers Paid: month to date, month-end forecast, costliest Workers, and dollars on runaway findings.
- **Timeline** adds Cloudflare's own notifications, the audit log, Pages deploys, and (opt-in) Cloudflare status incidents; deploy authors are filled in from the audit log.
- **Digest**: monthly frequency, free-limit headroom, biggest traffic changes, estimated bill, a section per account, client digests per account.
- **Client report** per account for 7 or 30 days, printable (Print saves it as PDF).
- **Alerts**: an alert after 3 failed scans in a row; an optional note when Cloudflare reports an active incident.
- **Zones** are read on a cursor, so all of them are covered instead of the first 20.
- **Optional, free bindings**, all off by default: a scan queue (every account on time, large fleets in one go), a Workers AI digest summary, and Turnstile on sign-in.
- The pre-filled token link adds Pages, SSL and Certificates, and DNS Read.
- **Lighter on D1 and CPU.** With 200 Workers and 30 days of history, an hourly scan now reads about 34,000 D1 rows instead of 293,000 and writes about 640 instead of 2,300 (roughly 0.8 million reads and 16,000 writes a day, inside the Free plan's 5 million and 100,000). Writes skip unchanged rows, the no-traffic check uses each Worker's last active hour, four unused indexes are gone (migration 0008), the overview reads the metrics once, and medians use quickselect.

## 0.1.0 (2026-11-09)

The first public release.

- **Fleet overview** with the free request budget, requests and errors today, and findings grouped by check and ranked by severity.
- **39 checks** across the free plan budget, runaway usage, storage and log costs, errors and limits, cron health, deprecations, exposure, and zombies and orphans. See [docs/checks.md](docs/checks.md).
- **Deploy timeline** that flags the deploy a new problem started after.
- **Alerts** by e-mail, Slack, Discord, Telegram, ntfy or any JSON webhook, with per-severity routing, quiet hours, and a daily or weekly digest, including one per group.
- **Groups, tags, scope rules and per-Worker thresholds**, with `config.json` export and import.
- **Setup wizard** that refuses a token with any write permission.
- **Self-cost panel** showing what Ambersight itself uses.
- **Security**: hashed sessions, `__Host-` cookies, origin checks, and a sign-in lockout per address and across addresses.
