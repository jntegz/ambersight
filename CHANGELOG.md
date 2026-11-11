# Changelog

All notable changes to Ambersight. Each version here has a matching [GitHub release](https://github.com/jntegz/ambersight/releases), which is what the update notice in the dashboard reads.

## Unreleased

- **Explain in plain words** on every finding: what it means, why it matters, and numbered steps with where to click, written for people new to Cloudflare. Also in the `.md` export. A test fails if a check has no explanation.
- **Clean up leftovers.** Unused KV, D1, R2 and queues, and Workers with no traffic or never deployed, now show **How to remove it** with the exact `wrangler` command (a backup first for D1). Routes and custom domains left behind get the dashboard or API step. Ambersight still never deletes anything.
- **Export .md** next to **Needs attention** and **Housekeeping**: the findings as a Markdown checklist, and for Housekeeping every cleanup command in one block.
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
