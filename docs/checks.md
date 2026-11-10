# Checks

Ambersight runs 39 checks on every scan. Each one below lists the ID you see in the dashboard and in `config.json`, how severe it is, exactly when it fires, and what to do about it. The numbers are the defaults. Most of them can be changed globally, per group or per Worker (see [configuration.md](configuration.md)).

Every finding in the dashboard carries the evidence behind it, a suggested fix and a link to the matching Cloudflare docs page. When the problem goes away, the finding resolves on its own at the next scan.

**Severity** decides where a finding goes. By default, critical findings are e-mailed right away, and everything else waits for the digest. See [alerts.md](alerts.md).

- [Free plan budget](#free-plan-budget)
- [Runaway usage](#runaway-usage)
- [Storage and log costs](#storage-and-log-costs)
- [Errors and limits](#errors-and-limits)
- [Cron health](#cron-health)
- [Bad deploys](#bad-deploys)
- [Deprecations](#deprecations)
- [Exposure](#exposure)
- [Zombies and orphans](#zombies-and-orphans)
- [Switching checks off](#switching-checks-off)
- [Which permission each group needs](#which-permission-each-group-needs)

---

## Free plan budget

On the Workers Free plan, an account gets 100,000 requests per UTC day across all its Workers. Past that, every Worker answers with **Error 1027** until midnight UTC. This check is hidden on Workers Paid.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `budget:free-daily-requests` | Warning at 70%, critical at 90% | The account has used 70% of today's requests. The finding projects the time you hit the limit at today's pace, or says you should stay under it. | Find the Worker driving the traffic in the overview. If the traffic is real, move to Workers Paid. |

Threshold settings: `budgetWarn` (0.7), `budgetCritical` (0.9).

## Runaway usage

These compare a Worker's **last full hour** with its **median hour over the past 7 days**. A Worker needs 72 hours of history before they apply, so a new install stays quiet for its first three days. Each one also has a floor, so a Worker that goes from 3 requests to 30 does not raise an alarm.

Workers Paid has no hard spending cap. A loop, a retry storm or a crawler is billed for every hour it runs, which makes these the checks that save money.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `runaway:traffic-spike` | Critical | Requests in the last hour are 5x the usual hour, and at least 500. | Look for a loop, a retry storm or a crawler. |
| `runaway:cpu-spike` | Critical | CPU time in the last hour is 5x the usual hour, and at least 60 seconds. | Same. Also check for a new slow path in the latest deploy. |
| `runaway:subrequest-spike` | Critical | Subrequests in the last hour are 5x the usual hour, and at least 2,000. | Look for a fetch inside a loop, or retries without a backoff. |

Threshold setting: `runawayMultiplier` (5).

## Storage and log costs

The same 5x rule as runaway usage, applied to storage operations and Durable Objects. The finding names the resource and the first Worker bound to it. Cloudflare's own usage notifications do not cover these operations.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `usage:ops-spike-d1` | Critical | D1 queries on one database in the last hour are 5x the usual hour, and at least 1,000. | Look for a query running in a hot path or a loop. |
| `usage:ops-spike-kv` | Critical | KV operations on one namespace: same rule. | Same. |
| `usage:ops-spike-r2` | Critical | R2 operations on one bucket: same rule. | Same. |
| `usage:ops-spike-queues` | Critical | Queue operations on one queue: same rule. | Check for a consumer that fails and retries every message. |
| `usage:ops-spike-do` | Critical | Durable Object requests: same rule. | Look for an alarm or a client that reconnects in a loop. |
| `usage:logs-full-sampling` | Info | A Worker has logs on at 100% sampling and serves at least 10,000 requests a day. | Workers Logs are billed by volume from 1 December 2026. Lower `head_sampling_rate` if you do not need every request. |
| `usage:logpush-on` | Info | Logpush is on for a Worker. | Make sure the destination, and what it costs, is still wanted. |

## Errors and limits

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `errors:error-rate` | Warning at 2%, critical at 10% | At least 2% of a Worker's requests failed in the last 24 hours. Workers with fewer than 50 requests are skipped. | Open the Worker in Workers Observability and look at the most frequent exception. |
| `errors:error-baseline` | Warning | The 24-hour error rate is 3x what the Worker had in the 6 days before, with at least 10 errors and a rate of at least 0.5%. Not raised when `error-rate` already fired. | Something changed. Check recent deploys, then the most frequent exception. This catches a Worker that normally runs at 0.1% and is now at 0.8%, which the fixed 2% line would miss. |
| `errors:resource-limit` | Warning | Any invocation hit the CPU or memory limit in the last 24 hours. | Profile the slow path, or move heavy work to a Queue or a Workflow. |
| `errors:cpu-near-limit` | Info | Free plan only. The p99 CPU time is at least 80% of the 10 ms limit, and nothing has hit the limit yet. | Requests over the limit fail with Error 1102. Trim CPU work before traffic grows. |

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

## Deprecations

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `deprecation:service-worker-syntax` | Warning | The Worker uses the Service Worker syntax (`addEventListener('fetch', …)`). | Migrate to ES modules. Durable Objects, Workflows and most bindings need them. |
| `deprecation:old-compat-date` | Warning | The `compatibility_date` is 12 months old or more. | Read the compatibility flags changelog since that date, update the date and test. |
| `deprecation:legacy-usage-model` | Warning | The Worker reports the `bundled` or `unbound` usage model. | Both were replaced by Standard pricing. Remove `usage_model` from your Wrangler config and redeploy. |
| `deprecation:workers-sites` | Warning | The Worker has a `__STATIC_CONTENT` binding, meaning it serves files with Workers Sites. | Move to Workers Static Assets: replace the `[site]` block with an `assets` directory. |
| `deprecation:redundant-flags` | Info | A compatibility flag does nothing at the Worker's compatibility date because its behaviour became the default. Today this covers `nodejs_compat_v2` from 2024-09-23. | Remove the flag from `compatibility_flags`. |

Threshold setting: `compatAgeMonths` (12).

## Exposure

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `exposure:previews-without-workers-dev` | Critical | Preview URLs are public, although `workers.dev` is off. People often assume turning off `workers.dev` turns off previews too. It does not. | Set `preview_urls = false`, or put previews behind Cloudflare Access. |
| `exposure:preview-urls` | Warning | Every version of the Worker gets a public preview URL. | Set `preview_urls = false` unless you share previews on purpose. To fix the whole group at once: **Workers & Pages › Protect all Workers › Enable Access › Previews only**. |
| `exposure:workers-dev-duplicate` | Warning | The Worker answers on `workers.dev` and also on a route or custom domain. | Requests on `workers.dev` skip your zone settings, such as WAF rules and Access. Set `workers_dev = false` if you do not use it. |
| `exposure:workers-dev-public` | Info | The Worker answers only on `workers.dev`. | Fine if you meant it. Set `workers_dev = false` for internal Workers. |
| `exposure:not-behind-access` | Warning. **Off by default.** | A public URL of the Worker (route, custom domain or `workers.dev`) is not covered by a Cloudflare Access application. | Ignore it for public sites. For internal tools, add a self-hosted Access application for those hostnames. |

Only Workers with a `fetch` handler count for the `workers.dev` checks. For the Access check, an application scoped to a path covers only that path, so it does not count, and `*.example.com` covers subdomains but not `example.com` itself. Turn the check on in **Settings › Checks**. It needs the *Access: Apps and Policies Read* permission.

## Zombies and orphans

All of these are info-level housekeeping. They stay folded away in the overview until you open them.

| Check | Severity | Fires when | What to do |
| --- | --- | --- | --- |
| `zombies:no-traffic` | Info | A Worker with only a `fetch` handler had no requests in the last 30 days. Ambersight waits until it has tracked the account that long, and never uses a window longer than its own history retention. | If nobody uses it, delete the Worker and any storage only it uses. |
| `zombies:never-deployed` | Info | The Worker was created but never deployed. | Deploy it or delete it. |
| `zombies:missing-service` | Info | A service binding points at a Worker that no longer exists. | Calls through it fail. Remove the binding or deploy the missing Worker. |
| `zombies:missing-tail` | Info | A tail consumer no longer exists. | Remove it from `tail_consumers`. |
| `zombies:orphan-route` | Info | A route points at a Worker that no longer exists. | Delete the route in the zone's **Workers Routes**. |
| `zombies:orphan-domain` | Info | A custom domain points at a Worker that no longer exists. | Remove the custom domain. |
| `zombies:unbound-kv` | Info | A KV namespace is not bound to any Worker. | It may still be used from outside Workers, through the API. If not, export what you need and delete it. |
| `zombies:unbound-d1` | Info | A D1 database is not bound to any Worker. | Same. |
| `zombies:unbound-r2` | Info | An R2 bucket is not bound to any Worker. | Same. R2 is often used through its S3 API, so check before deleting. |
| `zombies:unbound-queues` | Info | A queue has no producer, no consumer and is not a dead-letter queue. | Same. |

The unbound checks wait until Ambersight has read every Worker's bindings at least once. On a large fleet that takes a few scans (see [how-it-works.md](how-it-works.md#large-fleets)), so they may appear a little after the others.

Threshold setting: `zombieDays` (30).

---

## Switching checks off

There are three levels:

- **A whole group.** **Settings › Checks** has a switch for usage, errors, cron, deprecations, exposure, zombies and the deploy timeline.
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

If a permission is missing, the scan skips what it cannot read, carries on with the rest, and lists what it skipped. See [troubleshooting.md](troubleshooting.md).
