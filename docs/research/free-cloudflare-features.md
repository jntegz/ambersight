# Free Cloudflare features worth adding

Research notes, November 2026. A list of features Ambersight could add that are built on **free** Cloudflare capabilities and that users need, worked out from the point of view of five typical users.

Every idea was checked against the project rules ([CONTRIBUTING.md](../../CONTRIBUTING.md), [how-it-works.md](../how-it-works.md)): read-only token (GET and GraphQL only), at most 42 subrequests per scan on Free (`BUDGET` in `src/worker/scan.ts`), under 50 D1 queries, about 10 ms CPU, 1 Cron Trigger, and no code in the user's Workers.

> [!NOTE]
> **How sure the sources are.** The research read the cloudflare-docs source on GitHub (reliable) and search-result summaries of Cloudflare docs, changelog posts and community threads (less reliable). Limits marked (?) and every GraphQL dataset name should be confirmed by schema introspection with a real read-only token before anyone builds on them.

---

## The 5 users

| | Who | Setup | What keeps them up at night |
| --- | --- | --- | --- |
| **Mia** | Hobbyist | Free plan, 8 Workers: a Discord bot, a link shortener, 2 Astro sites, a cron scraper. KV + D1. | "My bot stopped working and I don't know why." Hitting a free quota she didn't know existed. An AI crawler eating her 100k requests. |
| **Raj** | Indie SaaS founder | Workers Paid, 25 Workers, Durable Objects, Queues, D1, R2. | A $5k to $36k surprise bill from a loop running while nobody is using the app. D1 hitting its 10 GB hard cap. A deploy that breaks checkout. |
| **Elena** | Agency owner | 14 client accounts, mostly Free, some Paid. Custom domains on every one. | Telling a client their site is down before they tell her. A certificate or domain quietly breaking. A monthly report per client. |
| **Tom** | Platform engineer | 1 Paid account, 220 Workers, Workers Builds CI, gradual deployments, 6 engineers. | Who changed what. A CI token that expires on a Friday. A 10% rollout nobody finished. "Is it us or Cloudflare?" |
| **Priya** | Security-minded admin | 2 accounts, internal tools behind Access, 40 zones. | Forgotten public endpoints, dangling DNS records (subdomain takeover), new API tokens or members she didn't approve. |

### What each of them says is missing today
- **Mia:** "You warn me about requests, but my bot died because KV only allows **1,000 writes a day**. And D1 now hard-fails at its daily row limits since September."
- **Raj:** "Show me **dollars**. Cloudflare's budget e-mail arrives the next day. And a Durable Object alarm loop has no 7-day baseline on the day I ship it."
- **Elena:** "I need **SSL, custom domain and Pages** status, and one view across clients."
- **Tom:** "Your 42-subrequest budget takes ages to read 220 Workers. Give me **audit logs**, stuck rollouts, failed builds and a Cloudflare-incident marker on the timeline."
- **Priya:** "Tell me about **dangling DNS**, certificate expiry and who created a new token."

---

## The feature list

Cost is extra subrequests per scan (or per day, for the daily inventory run). "New permission"
means the read-only token form gains one more **Read** scope.

### Tier 1: high value, cheap, fits today's design

| # | Feature | Free Cloudflare piece | Cost | Who | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | **Every free daily quota, with "you hit it at HH:MM UTC"** | GraphQL datasets already queried: switch D1 to `rowsRead`/`rowsWritten` (5M / 100k per day, hard fail since 2026-09-01), split KV by action (100k reads, **1k writes**, 1k deletes, 1k lists per day); add Durable Objects (~100k req/day (?)), Queues (10k ops/day, free since 2026-02), Workflows (3k steps/day), Workers AI (10k neurons/day, dataset name (?)) | 0 for D1/KV (same queries, different fields), +1 to +3 for the rest | Mia, Raj | Biggest gap. Today's budget meter only covers Workers requests. Reuse the existing projection logic for `budget:free-daily-requests` in `src/worker/checks.ts`. Fix the D1 and KV queries in `src/worker/cf.ts:401-402`. |
| 2 | **Storage caps** | D1 `file_size` (500 MB per DB and 5 GB per account on Free, 10 GB hard cap on Paid), R2 `r2StorageAdaptiveGroups` (10 GB free), KV storage (1 GB), DO storage (5 GB) | +1 to +2 per day | Mia, Raj | Warn at 80%, critical at 95%. A full D1 database rejects writes. |
| 3 | **"Ambersight is about to go blind"** | `expires_on` from the token verify call Ambersight already makes (`verifyToken`, `src/worker/cf.ts:149`) | 0 to 1 per day | Everyone | Warn 14 days and 3 days before the token expires. Also alert if N scans in a row fail. Without this the monitor dies silently. |
| 4 | **Idle-loop and first-day checks** | Data already stored | 0 | Raj | (a) DO, Queue or D1 operations with almost no matching requests (alarm or retry loop). (b) Absolute thresholds for Workers with under 72 h of history, where the 5x baseline cannot fire. This is the pattern behind the publicised $4.8k to $36k bills. |
| 5 | **Dollar estimate on Paid** | Units already stored x Cloudflare's public price list | 0 | Raj, Tom | Month-to-date estimate, month-end forecast, top 5 Workers by cost, and "about $X/hour" on every runaway alert. Optional later: Billable Usage API (alpha, PayGo only (?)). |
| 6 | **Cloudflare's own alerts in the timeline** | `GET /accounts/{id}/alerting/v3/history`, 30 days on Free | +1 per day, new permission: Notifications Read | Everyone | Shows "D1 limit reached", budget and usage e-mails next to deploys and findings. |
| 7 | **Update the log-cost check for 1 Dec 2026** | Per-GB logs and traces pricing; Free reportedly ingests 0.5 GB/day and then **stops** (?) | 0 | Everyone | `usage:logs-full-sampling` still uses the old per-event model. Estimate GB/day and warn that logs will silently stop on Free. |

### Tier 2: valuable, needs one new permission or a bit more work

| # | Feature | Free Cloudflare piece | Cost | Who | Notes |
| --- | --- | --- | --- | --- | --- |
| 8 | **Pages projects** | `GET /accounts/{id}/pages/projects` and deployments | +1 to +2 per day, new: Pages Read | Mia, Elena | Pages Functions count toward the same 100k/day budget, so the meter is wrong for Pages users today. Also: failed Pages deploys, public `*.pages.dev` that skips WAF and bot rules on the custom domain. |
| 9 | **Audit log** | Audit Logs v2, `GET /accounts/{id}/logs/audit` (GA 2026-03) | +1 per scan | Tom, Priya | Account Settings Read is already in the token. Who changed bindings, secrets or routes; new API tokens or members. Put the name on timeline entries. |
| 10 | **Stuck gradual rollout** | Deployments already fetched; versions carry a `percentage` | 0 | Tom | Warn when a split like 90/10 sits for more than 24 h. |
| 11 | **Config drift** | Bindings already stored (secrets show up by name only) | 0 | Raj, Tom | A binding or secret name disappeared after a deploy, or `api` and `api-staging` differ. Also warn near the 64 vars-plus-secrets limit. |
| 12 | **Subrequests per invocation near 50 on Free** | Subrequests and requests already stored | 0 | Mia | Free still allows only 50 external subrequests per invocation and the failure is often silent. The average is a proxy, not a maximum, so word it carefully. |
| 13 | **Slow and expensive D1 queries** | D1 query analytics (`d1QueriesAdaptiveGroups` (?)): rows read vs rows returned | +1 per day | Raj | "This query reads 40,000 rows to return 1. Add an index." The cause of a well-known 56-billion-rows bill. |
| 14 | **Certificates and custom-domain status** | `GET /zones/{id}/ssl/certificate_packs` (`expires_on`, status) | Per zone, rotated like routes; new: SSL and Certificates Read | Elena, Priya | Stuck "pending validation", expiring or failed certificates. |
| 15 | **Dangling DNS** | `GET /zones/{id}/dns_records` | Per zone, rotated; new: DNS Read | Priya, Elena | A CNAME to a deleted `*.workers.dev` or `*.pages.dev` is a subdomain takeover risk. Reuses the orphan-route logic in `src/worker/hygiene.ts`. |
| 16 | **"Is it Cloudflare?" marker** | The public cloudflarestatus.com JSON (not account data) | +1, only when an alert fires | Everyone | Adds one more outside host to "Where your data goes". It is a GET that sends nothing, so it can be opt-in like the update check. |

### Tier 3: Ambersight uses free Cloudflare products itself

| # | Feature | Free Cloudflare piece | Who | Notes |
| --- | --- | --- | --- | --- |
| 17 | **Scan big fleets fast** | Queues on Free (10k ops/day): split one scan into several messages, each with its own 50-subrequest budget | Tom, Elena | The clean way past the 42-subrequest ceiling. About 96 scans x a few messages a day fits easily. It is also what makes multi-account (#18) practical. |
| 18 | **Multi-account and per-client view** | Same token across accounts plus #17 | Elena | Already on the v1.0 roadmap (README FAQ). Add a monthly per-client summary. |
| 19 | **Better weekly digest** | Data already stored | Everyone | Quota headroom, biggest movers, estimated cost, new and removed Workers. Cloudflare's own weekly e-mail covers only requests, CPU and egress. |
| 20 | **Plain-language summary (opt-in)** | Workers AI, 10k neurons/day | Mia | Once a day in the digest, never per scan. It spends the user's own AI quota, and some models are now Paid-only, so keep it off by default. |
| 21 | **PDF report for clients** | Browser Rendering, 10 min/day on Free | Elena | A weekly or monthly PDF of the digest. |
| 22 | **Turnstile on the sign-in page** | Turnstile (free) | Priya | A small extra next to the lockout. Cloudflare Access (free for 50 users) stays the main recommendation. |

### Considered and not recommended
- **Kill switch or circuit breaker.** Users ask for it, but it needs write access and breaks the read-only promise. If ever done, it should be a separate opt-in Worker with its own narrowly scoped token.
- **Listing every API token or account member.** Needs sensitive scopes. #9 covers the important events instead.
- **Analytics Engine for longer history.** Free, but D1 with 7 to 90 days of retention already covers it.
- **Containers.** Not on the Free plan.
- **A public status page.** Little evidence users want one inside a monitor, and it would expose fleet data.

---

## Recommended order
1. **#1 free quotas, #3 token expiry, #4 idle loops, #7 log-cost update.** No new permissions, almost no subrequests, and they target the failures users actually hit.
2. **#2 storage caps, #5 dollar estimate, #6 Cloudflare alerts, #19 better digest.**
3. **#8 Pages, #9 audit log, #10 to #12 rollout, drift and subrequest checks.**
4. **#17 Queues fan-out**, then **#18 multi-account**.
5. The rest when there is demand.

New token permissions over all tiers: Notifications Read, Pages Read, SSL and Certificates Read,
DNS Read. All are Read. Keep each optional, the way the Access check is today.

---

## Before building

- Before building any item marked (?), run GraphQL introspection
  (`{ __schema { types { name } } }` at `api.cloudflare.com/client/v4/graphql`) with a real
  read-only token on a Free account, and confirm field names and limits on the live docs pages.
- For each feature built later: a check in `src/worker/checks.ts` with tests in `test/`,
  `npm test && npm run typecheck`, and a Self-cost panel check that the scan stays at or under 42 subrequests on Free.

## Sources

**Cloudflare limits and pricing** (cloudflare-docs, `src/content/docs/`): `workers/platform/limits.mdx`, `d1/platform/limits.mdx`, `kv/platform/limits.mdx`, `durable-objects/platform/{pricing,limits}.mdx`, `r2/pricing.mdx`, `workflows/reference/limits.mdx`, `workers-ai/platform/pricing.mdx`, `workers/observability/logs/workers-logs.mdx`, `email-service/platform/limits.mdx`.

**Changelog** (developers.cloudflare.com/changelog/post/…):
- `2026-02-04-queues-free-plan` (Queues on Free, 10k ops/day)
- `2026-02-11-subrequests-limit` (Paid 10,000 per invocation; Free stays at 50 external)
- `2026-03-10-audit-logs-v2-ga`
- `2026-04-13-billable-usage-dashboard-and-budget-alerts`, `2026-06-15-budget-alerts-default-on`
- `2026-07-07-workflows-billing-updates` (Free 3,000 steps/day)
- `2026-07-28-models-require-workers-paid`
- `2026-08-04-nodejs-compat-default`
- `2026-09-01-d1-free-tier-limit-enforcement`
- `2026-09-04-increased-worker-size-limit`
- `2026-09-15-granular-worker-permissions`
- `2026-10-02-30-days-analytics-on-every-plan`
- [Observability pricing](https://developers.cloudflare.com/observability/pricing/) (per-GB model from 1 December 2026)

**API reference** (developers.cloudflare.com/api/resources/…): `user/subresources/tokens/methods/verify`, `alerting/subresources/history/methods/list`, `accounts/subresources/logs/subresources/audit/methods/list`, `billing/subresources/usage/`, `workers/subresources/observability/subresources/telemetry/`. Docs: `pages/functions/pricing`, `notifications/notification-history/`, `d1/observability/find-expensive-queries/`, `billing/manage/budget-alerts/`.

**User pain points** (paraphrased from search summaries; dollar figures as reported by the users):
- No spending cap, queue loop bill: [ppc.land](https://ppc.land/developer-faces-36-000-cloudflare-bill-after-queue-loop-post-says/)
- Durable Object alarm loops: [HN thread](https://hn.jakechampion.name/item/47787042), [aiidelist](https://aiidelist.com/blog/cloudflare-10811-bill-codex-durable-objects-alarm-loop)
- D1 write loop: [littlebearapps](https://littlebearapps.com/blog/d1-billing-disaster-circuit-breakers/)
- Free quotas beyond requests: [eastondev](https://blog.eastondev.com/en/posts/dev/20251201-workers-quota-optimization)
- AI bots and pages.dev skipping WAF: [AnswerOverflow](https://www.answeroverflow.com/m/1346571209281634317)
- Silent subrequest limit in a cron: [dev.to](https://dev.to/gitgem/my-cron-job-was-silently-failing-on-cloudflare-the-bug-wasnt-where-i-looked-31ko)
- Secrets and bindings lost on deploy: [workers-sdk #8871](https://github.com/cloudflare/workers-sdk/issues/8871)
- Builds failure alerts need a custom consumer: [changelog 2025-12-11](https://developers.cloudflare.com/changelog/post/2025-12-11-builds-event-subscriptions/)
- "Is it us or Cloudflare?": [18 November 2025 postmortem](https://blog.cloudflare.com/18-november-2025-outage/)
