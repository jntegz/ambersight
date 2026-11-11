# Checks

Ambersight runs 80 checks. Each one below lists the ID you see in the dashboard and in `config.json`, how severe it is, exactly when it fires, and what to do about it. The numbers are the defaults. Most of them can be changed globally, per group or per Worker (see [configuration.md](configuration.md)).

Every finding in the dashboard carries the evidence behind it, a suggested fix and a link to the matching Cloudflare docs page. When the problem goes away, the finding resolves on its own at the next scan.

**Severity** decides where a finding goes. By default, critical findings are e-mailed right away, and everything else waits for the digest. See [alerts.md](alerts.md).

- [Free plan budget](#free-plan-budget)
- [Free plan daily limits](#free-plan-daily-limits)
- [Storage caps](#storage-caps)
- [Runaway usage](#runaway-usage)
- [Idle loops and new bursts](#idle-loops-and-new-bursts)
- [Storage and log costs](#storage-and-log-costs)
- [Errors and limits](#errors-and-limits)
- [Cron health](#cron-health)
- [Bad deploys and rollouts](#bad-deploys)
- [Deprecations](#deprecations)
- [Exposure](#exposure)
- [Zombies and orphans](#zombies-and-orphans)
- [Pages](#pages)
- [Security](#security)
- [Config drift](#config-drift)
- [Packages](#packages) (off by default)
- [Ambersight's own health](#ambersights-own-health)
- [Switching checks off](#switching-checks-off)
- [Which permission each group needs](#which-permission-each-group-needs)

---

## Free plan budget

On the Workers Free plan, an account gets 100,000 requests per UTC day across all its Workers. Past that, every Worker answers with **Error 1027** until midnight UTC. This check is hidden on Workers Paid.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `budget:free-daily-requests` | Warning at 70%, critical at 90% | The account has used 70% of today's requests. The finding projects the time you hit the limit at today's pace, or says you should stay under it. | Find the Worker driving the traffic in the overview. If the traffic is real, move to Workers Paid. |

Threshold settings: `budgetWarn` (0.7), `budgetCritical` (0.9).

## Free plan daily limits

The Free plan has more daily limits than requests, and every one is **per account**: spreading the work over several Workers does not help. Past a limit, calls of that kind fail until 00:00 UTC. Each check projects when the account runs out at today's pace. The numbers come from the same GraphQL queries Ambersight already makes (D1 rows, KV operations by type), so most cost no extra API calls. Hidden on Workers Paid, except Workers AI.

| Check | Limit per day | Severity | What to do |
| --- | --- | --- | --- |
| `budget:free-daily-d1-rows-read` | 5,000,000 rows read | Warning at 70%, critical at 90% | Find the query reading the most rows (see `usage:d1-inefficient-query`). Usually a missing index. |
| `budget:free-daily-d1-rows-written` | 100,000 rows written | Same | Look for a write in a hot path or a loop. |
| `budget:free-daily-kv-reads` | 100,000 reads | Same | Cache in memory or with the Cache API. |
| `budget:free-daily-kv-writes` | 1,000 writes | Same | KV is built for reads. Batch writes, or move write-heavy data to D1 or Durable Objects. |
| `budget:free-daily-kv-deletes` | 1,000 deletes | Same | Use expiring keys (TTL) instead of deleting. |
| `budget:free-daily-kv-lists` | 1,000 list requests | Same | Keep an index key instead of listing. |
| `budget:free-daily-do-requests` | 100,000 Durable Object requests | Same | Look for chatty clients or alarms that fire too often. |
| `budget:free-daily-queue-ops` | 10,000 Queue operations | Same | Batch messages; check for a consumer that retries every message. |
| `budget:free-daily-workflow-steps` | 3,000 Workflow steps | Same | Combine small steps. |
| `budget:free-daily-ai-neurons` | 10,000 Workers AI neurons | Same on Free. On Paid, info once the free allocation is used, since the rest is billed. | Use a smaller model or cache answers. |

Threshold settings: `budgetWarn` (0.7), `budgetCritical` (0.9), shared with the request budget. The Workers AI dataset is not in Cloudflare's documentation, so that check may say the data is unavailable.

## Storage caps

Read once a day with the inventory: the size of each D1 database, KV namespace and R2 bucket, and the Durable Object total.

| Check | Limit | Severity | What to do |
| --- | --- | --- | --- |
| `budget:storage-d1-db` | 500 MB per database on Free, 10 GB on Paid (a hard cap) | Warning at 80%, critical at 95% | A full database rejects writes. Delete old rows, split the data, or move large values to R2. |
| `budget:storage-d1-account` | 5 GB on Free, 1 TB on Paid | Same | Same. |
| `budget:storage-kv-account` | 1 GB on Free | Same | Delete what you no longer need, or use expiring keys. |
| `budget:storage-do-account` | 5 GB on Free | Same | Delete old objects' storage with `deleteAll()`. |
| `budget:storage-r2-account` | 10 GB free | Warning | Past 10 GB, R2 is billed rather than blocked. Set lifecycle rules. |

## Runaway usage

These compare a Worker's **last full hour** with its **median hour over the past 7 days**. A Worker needs 72 hours of history before they apply, so a new install stays quiet for its first three days. Each one also has a floor, so a Worker that goes from 3 requests to 30 does not raise an alarm.

Workers Paid has no hard spending cap. A loop, a retry storm or a crawler is billed for every hour it runs, which makes these the checks that save money.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `runaway:traffic-spike` | Critical | Requests in the last hour are 5x the usual hour, and at least 500. | Look for a loop, a retry storm or a crawler. |
| `runaway:cpu-spike` | Critical | CPU time in the last hour is 5x the usual hour, and at least 60 seconds. | Same. Also check for a new slow path in the latest deploy. |
| `runaway:subrequest-spike` | Critical | Subrequests in the last hour are 5x the usual hour, and at least 2,000. | Look for a fetch inside a loop, or retries without a backoff. |

Threshold setting: `runawayMultiplier` (5).

## Idle loops and new bursts

The 5x baseline needs three days of history and cannot see a loop that starts on day one, or work that runs while nobody uses the app. These cover both.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `usage:idle-loop-do`, `-queues`, `-d1`, `-kv`, `-r2` | Critical on Paid, warning on Free | For each of the last 3 full hours, a Durable Object namespace, queue, database, namespace or bucket did at least 2,000 operations while the Workers bound to it served fewer than 1 request per 100 operations. On Paid the finding gives the cost per hour. | This is the shape of an alarm that always sets the next alarm, a queue consumer that fails and retries every message, or a cron that never finishes. Find it before it runs all night. |
| `runaway:new-worker-burst` | Critical on Paid, warning on Free | A Worker with under 72 hours of history served at least 50,000 requests in the last hour. | If the traffic is not expected, look for a loop or a crawler. |
| `usage:new-resource-burst-<kind>` | Same | A resource with under 72 hours of history had at least 100,000 operations in the last hour. | Look for a loop reading or writing in a hot path. |

Threshold settings: `newWorkerHourlyRequests` (50,000), `newResourceHourlyOps` (100,000).

## Storage and log costs

The same 5x rule as runaway usage, applied to storage operations and Durable Objects. The finding names the resource and the first Worker bound to it. Cloudflare's own usage notifications do not cover these operations.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `usage:ops-spike-d1` | Critical | D1 queries on one database in the last hour are 5x the usual hour, and at least 1,000. | Look for a query running in a hot path or a loop. |
| `usage:ops-spike-kv` | Critical | KV operations on one namespace: same rule. | Same. |
| `usage:ops-spike-r2` | Critical | R2 operations on one bucket: same rule. | Same. |
| `usage:ops-spike-queues` | Critical | Queue operations on one queue: same rule. | Check for a consumer that fails and retries every message. |
| `usage:ops-spike-do` | Critical | Durable Object requests: same rule. | Look for an alarm or a client that reconnects in a loop. |
| `usage:logs-full-sampling` | Info | A Worker has logs on at 100% sampling and serves at least 10,000 requests a day. The finding estimates GB a month, and on Paid the cost past the included 50 GB. | From 1 December 2026, logs and traces are billed per GB. Lower `head_sampling_rate` if you do not need every request. |
| `usage:logs-free-allowance` | Info at 70% of 0.5 GB a day, warning above it | Free plan only. The estimated log volume of all Workers is close to or over the 0.5 GB a day that Free accounts ingest from 1 December 2026. Past it, logs stop being stored until 00:00 UTC; the finding says around what time. | Lower `head_sampling_rate` on the busiest Workers, so the logs you need are kept. The estimate assumes about 1.5 KB per event. |
| `usage:d1-inefficient-query` | Info, warning at 100 million rows read a day | Once a day: a D1 query read at least 1 million rows in 24 hours, and at least 100 rows for every row it returned. The finding shows the query, with its parameters as `?`. | Add an index on the columns in its `WHERE` or `ORDER BY`. D1 bills rows read. |
| `usage:logpush-on` | Info | Logpush is on for a Worker. | Make sure the destination, and what it costs, is still wanted. |

## Errors and limits

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `errors:error-rate` | Warning at 2%, critical at 10% | At least 2% of a Worker's requests failed in the last 24 hours. Workers with fewer than 50 requests are skipped. | Open the Worker in Workers Observability and look at the most frequent exception. |
| `errors:error-baseline` | Warning | The 24-hour error rate is 3x what the Worker had in the 6 days before, with at least 10 errors and a rate of at least 0.5%. Not raised when `error-rate` already fired. | Something changed. Check recent deploys, then the most frequent exception. This catches a Worker that normally runs at 0.1% and is now at 0.8%, which the fixed 2% line would miss. |
| `errors:resource-limit` | Warning | Any invocation hit the CPU or memory limit in the last 24 hours. | Profile the slow path, or move heavy work to a Queue or a Workflow. |
| `errors:cpu-near-limit` | Info | Free plan only. The p99 CPU time is at least 80% of the 10 ms limit, and nothing has hit the limit yet. | Requests over the limit fail with Error 1102. Trim CPU work before traffic grows. |
| `errors:subrequests-near-limit` | Warning | Free plan only. Over 24 hours, invocations made 40 or more subrequests on average (Free allows 50 per invocation). | Only the average is known, so some invocations are probably over the limit already, and the 51st fetch throws. Batch calls, cache results, or move fan-out work to a Queue. |

Threshold settings: `errorWarn` (0.02), `errorCritical` (0.1), `errorBaselineMultiplier` (3), `cpuShareWarn` (0.8).

## Cron health

Ambersight reads each Worker's cron expressions and counts how many runs should have happened in the last 24 hours. After a deploy that changes a schedule, it expects runs only from the next full hour.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `cron:missed-runs` | Warning. Critical when 2 or more runs were missed and the last 2 slots both went wrong. | Fewer runs happened than the schedule expects. | Check that the Cron Trigger is still attached and the `scheduled()` handler is deployed. |
| `cron:failed-runs` | Warning. Critical when 2 or more runs failed and the last 2 slots both went wrong. | One or more scheduled runs ended in an error. | Look at the scheduled invocations in Workers Observability for the exception. |
| `cron:cron-cpu-near-limit` | Warning | A scheduled run used at least 80% of its CPU limit: 10 ms on Free, 30 seconds on Paid. | Runs over the limit are cancelled. Split the job into smaller steps or move it to a Queue. |
| `cron:cron-count` | Info at 80% of the plan limit, warning at the limit | The account uses 4 of 5 Cron Triggers (Free) or 200 of 250 (Paid). | At the limit, new schedules are rejected. Combine schedules into one Worker or remove unused ones. |

If Cloudflare returns no scheduled runs at all, not even for Ambersight's own cron, the cron checks pause and keep their current findings instead of raising a missed run for every Worker. See [troubleshooting.md](troubleshooting.md#cron-checks-paused).

## Bad deploys

This is not a separate check. When `errors:error-rate`, `errors:error-baseline` or any runaway check fires, Ambersight looks for a deploy of that Worker in the 60 minutes before the problem started. If it finds one:

- the finding says *"It started right after a deploy."*
- a warning becomes critical
- the suggested fix names the deploy: *"Compare the deploy of 2026-11-09 22:14 UTC with the one before it, or roll back."*
- the deploy is flagged on the timeline

Threshold setting: `deployWindowMinutes` (60). Turn the timeline module off to stop it.

The timeline also shows Cloudflare's own notifications (alert history, needs *Notifications Read*), audit log entries for Workers, routes, DNS, certificates, Access, members and tokens, each Pages project's latest deploy, and, if you turn it on, Cloudflare status incidents. A deploy with no author takes it from the audit log.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `deploys:stuck-rollout` | Warning | A Worker's latest deployment still splits traffic between versions (a gradual rollout) after 24 hours. | Finish the rollout with `wrangler versions deploy` at 100%, or roll back. While traffic is split, errors are hard to compare. |

Threshold setting: `rolloutMaxHours` (24).

## Deprecations

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `deprecation:service-worker-syntax` | Warning | The Worker uses the Service Worker syntax (`addEventListener('fetch', …)`). | Migrate to ES modules. Durable Objects, Workflows and most bindings need them. |
| `deprecation:old-compat-date` | Warning | The `compatibility_date` is 12 months old or more. | Read the compatibility flags changelog since that date, update the date and test. |
| `deprecation:legacy-usage-model` | Warning | The Worker reports the `bundled` or `unbound` usage model. | Both were replaced by Standard pricing. Remove `usage_model` from your Wrangler config and redeploy. |
| `deprecation:workers-sites` | Warning | The Worker has a `__STATIC_CONTENT` binding, meaning it serves files with Workers Sites. | Move to Workers Static Assets: replace the `[site]` block with an `assets` directory. |
| `deprecation:redundant-flags` | Info | A compatibility flag does nothing at the Worker's compatibility date because its behaviour became the default. Today this covers `nodejs_compat_v2` from 2024-09-23, and `nodejs_compat` from 2026-08-04, when Node.js compatibility became the default. | Remove the flag from `compatibility_flags`. |

Threshold setting: `compatAgeMonths` (12).

## Exposure

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `exposure:previews-without-workers-dev` | Critical | Preview URLs are public, although `workers.dev` is off. People often assume turning off `workers.dev` turns off previews too. It does not. | Set `preview_urls = false`, or put previews behind Cloudflare Access. |
| `exposure:preview-urls` | Warning | Every version of the Worker gets a public preview URL. | Set `preview_urls = false` unless you share previews on purpose. To fix the whole group at once: **Workers & Pages › Protect all Workers › Enable Access › Previews only**. |
| `exposure:workers-dev-duplicate` | Warning | The Worker answers on `workers.dev` and also on a route or custom domain. | Requests on `workers.dev` skip your zone settings, such as WAF rules and Access. Set `workers_dev = false` if you do not use it. |
| `exposure:workers-dev-public` | Info | The Worker answers only on `workers.dev`. | Fine if you meant it. Set `workers_dev = false` for internal Workers. |
| `exposure:pages-dev-public` | Info | A Pages project has a custom domain, and its `*.pages.dev` address still answers. | Requests to `pages.dev` skip your zone's WAF, bot and rate-limiting rules. Redirect it to your domain with a Bulk Redirect, or put it behind Cloudflare Access. |
| `exposure:not-behind-access` | Warning. **Off by default.** | A public URL of the Worker (route, custom domain or `workers.dev`) is not covered by a Cloudflare Access application. | Ignore it for public sites. For internal tools, add a self-hosted Access application for those hostnames. |

Only Workers with a `fetch` handler count for the `workers.dev` checks. For the Access check, an application scoped to a path covers only that path, so it does not count, and `*.example.com` covers subdomains but not `example.com` itself. Turn the check on in **Settings › Checks**. It needs the *Access: Apps and Policies Read* permission.

## Zombies and orphans

All of these are info-level housekeeping. They stay folded away in the overview until you open them.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `zombies:no-traffic` | Info | A Worker with only a `fetch` handler had no requests in the last 30 days (Ambersight keeps each Worker's last hour with a request). It waits until it has tracked the account that long, and never uses a window longer than its own history retention. | If nobody uses it, delete the Worker and any storage only it uses. |
| `zombies:never-deployed` | Info | The Worker was created but never deployed. | Deploy it or delete it. |
| `zombies:missing-service` | Info | A service binding points at a Worker that no longer exists. | Calls through it fail. Remove the binding or deploy the missing Worker. |
| `zombies:missing-tail` | Info | A tail consumer no longer exists. | Remove it from `tail_consumers`. |
| `zombies:orphan-route` | Info | A route points at a Worker that no longer exists. | Delete the route in the zone's **Workers Routes**. |
| `zombies:orphan-domain` | Info | A custom domain points at a Worker that no longer exists. | Remove the custom domain. |
| `zombies:unbound-kv` | Info | A KV namespace is not bound to any Worker. When storage operations are tracked, the finding adds when it was last used (from any source, not only Workers), its size and whether it is empty. If it had operations in the last 48 hours it says so and gives no delete command: something outside Workers may still use it. | Check **Last used**. "None in 30 days" means nothing touched it, from Workers or anywhere else; export what you need and delete it. |
| `zombies:unbound-d1` | Info | A D1 database is not bound to any Worker. | Same. |
| `zombies:unbound-r2` | Info | An R2 bucket is not bound to any Worker. | Same. R2 is often used through its S3 API, so check before deleting. |
| `zombies:unbound-queues` | Info | A queue has no producer, no consumer and is not a dead-letter queue. | Same. |
| `zombies:bound-idle-kv` | Info | A KV namespace is bound to at least one Worker but had no operations in the last 30 days (only once Ambersight has tracked that long). Storage bound only to one unused Worker is listed on that Worker's finding instead. | Remove the binding from each Worker's Wrangler config and redeploy, then delete it. |
| `zombies:bound-idle-d1` | Info | The same for a D1 database. | Same. |
| `zombies:bound-idle-r2` | Info | The same for an R2 bucket. | Same. |
| `zombies:bound-idle-queues` | Info | The same for a queue (not one with a consumer). | Same. |

**Is it safe to remove?** "Not bound" alone does not prove it: storage can be used through the API, an S3 client or a public URL. So Ambersight also keeps the last hour each KV namespace, D1 database, R2 bucket and queue had operations, from any source, and shows it as **Last used** with the size. This needs the usage checks on (the default) and costs no extra API calls: it comes from the operations the scan already reads. "No operations in 30 days" is only said for a kind (KV, D1, R2 or queues) whose operations Ambersight has read without a gap for those 30 days: a failed dataset, a kind skipped because the scan ran out of API budget, the usage checks being off or two days without a scan start the count again, and until then the finding makes no claim about use. The stored time is updated at most every 6 hours per resource, so it costs a handful of D1 rows a day.

**Cleaning up a Worker.** `zombies:no-traffic` and `zombies:never-deployed` list under **Leaves behind** the storage that only that Worker binds, and **How to remove it** adds the commands for it after `wrangler delete`. Storage that still had operations in the last 48 hours is listed but gets no command. Bindings are read from every Worker in the account, so storage another (out-of-scope) Worker uses is never listed.

**Cleaning up after a deleted Worker.** Deleting a Worker leaves its KV namespaces, D1 databases, R2 buckets and queues in place. After the next inventory refresh (once a day by default) they show up under **Housekeeping** as not bound to any Worker. Each of these findings has a **How to remove it** section with the exact command, such as `npx wrangler d1 export old-db --remote --output=old-db-backup.sql` and then `npx wrangler d1 delete old-db`. Ambersight is read-only and never runs them. Routes and custom domains left pointing at deleted Workers get the dashboard or API step instead.

**What it frees.** Under the Housekeeping heading, a line shows how much storage removing the unused and idle storage would free, per product and as a share of the account allowance, with the monthly saving when the cost estimate is on, and how many housekeeping findings were resolved in the last 7 days. The weekly digest has the same count.

**Resources page.** **Resources** lists every KV namespace, D1 database, R2 bucket and queue with the Workers that bind it, its size, when it was last used and a status: *In use*, *Idle*, *Not bound* or *Used outside Workers*. Check it before deleting anything.

**Export.** **Export .md** next to **Needs attention** (critical and warning) and next to **Housekeeping** (info) saves the findings as a Markdown checklist. The Housekeeping export ends with every cleanup command in one `sh` block, set to the right account with `CLOUDFLARE_ACCOUNT_ID`. The export covers the selected group, whatever the severity filter or search shows.

The unbound checks wait until Ambersight has read every Worker's bindings at least once. On a large fleet that takes a few scans (see [how-it-works.md](how-it-works.md#large-fleets)), so they may appear a little after the others.

Threshold setting: `zombieDays` (30).

## Pages

Read once a day with the inventory (needs *Pages Read*). Pages Functions count toward the same 100,000 daily requests as Workers; the overview's Pages section shows each project's function requests.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `pages:deploy-failed` | Warning for production, info for previews | The latest deploy of a Pages project failed. | Read the build log in Workers & Pages. The site keeps serving the last deploy that worked. |

## Security

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `security:member-change` | Warning (info for a removal) | The audit log shows an account member added, changed or removed in the last 7 days. | If you did not expect it, check **Manage Account › Members**. Acknowledge it once you have. |
| `security:token-created` | Info | The audit log shows a new API token in the last 7 days. | If you did not expect it, review its permissions under API Tokens. |
| `security:cert-expiring` | Warning at 7 days, critical at 2 | An active edge certificate expires soon. Managed certificates renew about 30 days ahead, so this one is not renewing. | Check its validation in **SSL/TLS › Edge Certificates**. Upload a renewed one if it is a custom certificate. |
| `security:cert-failed` | Critical when expired, otherwise warning | A certificate pack is expired or timed out, and no other active pack covers its hostnames. | Visitors see TLS errors. Check DNS validation records, CAA records and whether the hostname is still proxied. |
| `security:cert-pending` | Warning | A certificate is stuck in validation with an error. | Fix the error shown, usually a missing TXT record or a CAA record that blocks the certificate authority. |
| `security:dangling-pages` | Critical | A DNS record points at `<name>.pages.dev`, and the account has no Pages project of that name. | Anyone can create a project with that name and serve content on your hostname. Delete the record. |
| `security:dangling-workers-dev` | Warning | A DNS record points at `<worker>.<your-subdomain>.workers.dev`, and that Worker no longer exists. | Requests to the hostname fail. Delete the record or deploy the Worker again. |

The audit log is read every 6 hours (it needs *Account Settings Read*, which the token already has). Certificates and DNS records are read per zone on a rotating cursor, a few zones per scan, each zone at least once a day (*SSL and Certificates Read*, *DNS Read*). The dangling Pages check waits until the Pages project list has loaded once, so a missing permission cannot make every record look dangling.

## Config drift

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `drift:binding-removed` | Warning | A binding, variable or secret that a Worker had at the last read is gone, and still missing. Raised for 7 days. | Usually a deploy dropped it: variables and secrets set only in the dashboard are replaced by the next `wrangler deploy` unless they are in your config (or kept with `--keep-vars`). |
| `drift:env-mismatch` | Info | A Worker named like `api-staging`, `api-dev`, `api-preview` or `staging-api` has binding names that `api` does not, or the other way round. | Compare the two configs. Secrets are compared by name only; their values are never read. |
| `drift:vars-near-limit` | Info at 58, warning at 64 | A Worker has close to the 64 environment variables and secrets allowed. | Group related settings into one JSON variable, or move configuration to KV. |

## Packages

**Off by default.** For each Worker you map to a GitHub repository in **Settings › Checks › Packages**, Ambersight reads `package-lock.json` once a day, takes the direct `dependencies` and `devDependencies` with their locked versions, and compares them with the latest release on the public npm registry. The **Packages** page lists them as *locked → latest*.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `packages:outdated` | Warning if a direct dependency is a major version behind, otherwise Info | One or more direct dependencies are behind the latest npm release. | Run `npm outdated` in the repository and update. Read the changelog of each major version first. |
| `packages:lockfile-unreadable` | Warning | The lockfile could not be read: no `package-lock.json` at that path, no access, the repository moved, a lockfile older than npm 7 (`lockfileVersion` 1), or a file over 8 MB. | Check the repository, folder and branch in Settings, and that `GITHUB_TOKEN` can read the repository. |

Why this needs a separate token: Cloudflare stores your Worker as bundled code, without `package.json` or the lockfile, so the Cloudflare API cannot tell which versions you use. Workers Builds knows the repository, but its API needs an *Edit* permission, which Ambersight never takes. Only `package-lock.json` v2 and v3 are read (npm 7 and later); pnpm and yarn lockfiles are not supported yet. Lockfile reads and npm lookups count against the scan's subrequest budget, so on the Free plan a large fleet is covered over several scans.

## Ambersight's own health

These cannot be switched off: a monitor that has gone blind should say so.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `health:token-expiry` | Warning at 14 days, critical at 3 | Ambersight's API token has an expiry date that is close. | Extend the token or create a new read-only one, then update `CF_API_TOKEN`. |

After 3 failed scans in a row, Ambersight also sends one alert a day on the channel set for critical alerts, and the overview shows the last error. A scan that fails cannot store a finding, so this alert has none behind it.

---

## Switching checks off

There are three levels:

- **A whole group.** **Settings › Checks** has a switch for usage, errors, cron, deprecations, exposure, zombies, the deploy timeline, cost, Cloudflare notifications, Pages, security, config drift, Cloudflare incidents and packages.
- **One check.** From any finding group in the overview, switch that check off. It shows up under **Settings › Checks › Switched off from the overview**, where you can turn it back on. In `config.json` this is the `mutedChecks` list, using the IDs above.
- **One finding.** Acknowledge it, or snooze it for 7, 30 or 90 days. **Acknowledge all** and **Snooze all** work on a whole group.

When you switch a check off, its open findings resolve, the same as if you had fixed them.

## Which permission each group needs

| Group | Token permission (all Read) |
| --- | --- |
| Everything | Workers Scripts, Account Analytics |
| Free plan budget | Billing, to detect the plan. Without it, set the plan in **Settings › General**. |
| Storage and log costs, unbound storage | Workers KV Storage, D1, Workers R2 Storage, Queues |
| Exposure, orphaned routes and domains | Workers Routes, Zone |
| Access coverage | Access: Apps and Policies |
| Pages | Pages Read (key `page`) |
| Certificates | SSL and Certificates Read |
| Dangling DNS | DNS Read |
| Audit log | Account Settings Read |
| Cloudflare notifications on the timeline | Notifications Read. It has no key for the pre-filled token link, so add it by hand. |
| Packages | No Cloudflare permission. A separate `GITHUB_TOKEN` secret: GitHub fine-grained token, *Contents: Read* on the mapped repositories. |

If a permission is missing, the scan skips what it cannot read, carries on with the rest, and lists what it skipped. See [troubleshooting.md](troubleshooting.md).
