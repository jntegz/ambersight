<p align="center">
  <img src="docs/logo.svg" width="96" height="96" alt="Ambersight logo: a magnifying glass with a hexagon lens">
</p>

<h1 align="center">ambersight</h1>

<p align="center">See your whole Cloudflare Workers fleet on one page. Read-only. Free. No code changes.</p>

---

Ambersight is a small dashboard that runs as **one Worker in your own Cloudflare account**. Every hour it reads your Workers' metadata and metrics with a read-only API token and tells you which Workers need attention and why:

- **Free plan budget**: how much of today's 100,000 requests you have used, and when you will hit Error 1027.
- **Runaway usage**: requests, CPU time, subrequests, D1, KV, R2, Queues or Durable Objects suddenly at 5x their usual hourly level (on Workers Paid, that is billed with no hard cap).
- **Errors and limits**: error rates above 2% or 10% or 3x a Worker's own baseline, CPU and memory limit hits, p99 CPU close to the Free plan's 10 ms.
- **Cron health**: missed and failed scheduled runs, crons close to their CPU limit, Cron Trigger count against your plan.
- **Deprecations**: Service Worker syntax, old compatibility dates, legacy usage models, Workers Sites, redundant flags.
- **Exposure**: public preview URLs, forgotten workers.dev hostnames, optionally URLs not behind Cloudflare Access.
- **Zombies and orphans**: Workers with no traffic or never deployed, unbound KV/D1/R2/Queues, routes and bindings pointing at deleted Workers.
- **Change timeline**: every deploy across the fleet, with error or traffic spikes that started right after one marked.
- **Groups and tags**, per-Worker thresholds, include/exclude rules, and a **Self-cost** panel that shows what Ambersight itself uses.
- **Digest** by e-mail (weekly or daily, in your time zone, optionally one per group), plus instant alerts by e-mail or webhook.

It never deploys, edits or deletes anything, never adds code to your Workers, and stays inside the Workers Free plan.

> Status: **v0.1, in development.** See the roadmap below.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jntegz/ambersight-dev)

The button forks this repo into your GitHub account, creates the D1 database, applies migrations and deploys. It asks for two secrets:

| Secret | What to enter |
| --- | --- |
| `CF_API_TOKEN` | A **read-only** API token (see below) |
| `ADMIN_PASSPHRASE` | A long passphrase for signing in to the dashboard |

Then open `https://ambersight.<your-subdomain>.workers.dev`, sign in, and press **Scan now**. After that the scan runs every hour.

### The API token

Create it at **My Profile › API Tokens › Create Token › Custom token** with only these permissions:

| Scope | Permission | Access |
| --- | --- | --- |
| Account | Workers Scripts | Read |
| Account | Account Analytics | Read |
| Account | Account Settings | Read (optional; lets Ambersight find your account ID) |
| Account | Workers KV Storage, D1, Workers R2 Storage, Queues | Read (optional; zombie and storage checks) |
| Zone | Workers Routes, Zone | Read (optional; exposure and orphaned routes) |
| Account | Access: Apps and Policies | Read (optional; Access coverage check, off by default) |
| Account | Billing | Read (optional; detects Free or Paid automatically) |
| User | API Tokens | Read (optional; lets the setup wizard prove the token has no write scopes) |

Do not give it any Edit permission. On first sign-in a setup wizard verifies the token, detects your plan and refuses to continue if it finds a write scope. Ambersight only ever sends GET requests and GraphQL queries. If the token can see several accounts, set `CF_ACCOUNT_ID` in `wrangler.jsonc` `vars`.

### Protect the dashboard

The passphrase login is on by default (5 wrong attempts lock sign-in for 15 minutes). For stronger protection, put the Worker's hostname behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) as well.

### E-mail alerts (optional, free)

Ambersight uses Cloudflare's `send_email` binding, which is free when you send to a **verified destination address** in Email Routing (a Gmail address works).

1. Enable Email Routing on a domain you have on Cloudflare and verify your address.
2. In your fork's `wrangler.jsonc`, set `EMAIL_FROM` (an address on that domain) and `DIGEST_TO` (your verified address), and uncomment the `send_email` block with the same address.
3. Commit. Workers Builds redeploys.

### Webhook alerts (optional)

`npx wrangler secret put WEBHOOK_URL` with a Slack or Discord webhook URL, a Telegram `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>` URL, an ntfy topic URL, or any HTTPS endpoint that accepts JSON. Choose per severity in **Settings** whether alerts go to e-mail, webhook, both or nowhere. Every channel has a **Test message** button.

### Settings

Every check, threshold, schedule and alert route is configurable in **Settings** and stored in D1. Export the whole setup as `config.json` and import it elsewhere to version it.

## Cost

On Workers Free, with 30 Workers, Ambersight uses 1 of your 5 Cron Triggers. The trigger fires every 15 minutes (96 invocations a day) but only scans at your configured interval, by default hourly; the other runs stop after one D1 read. Together with a few hundred dashboard API calls that is well under 1% of the 100,000 daily requests. Each scan stays under 45 subrequests and fetches per-Worker details a few Workers at a time. Its own logs are switched off. The **Self-cost** panel in Settings shows the measured numbers.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in a token and a passphrase
npm run db:migrate:local
npm run dev                       # builds the UI and starts wrangler dev on :8787
npm run dev:web                   # optional: Vite with hot reload, proxying /api to :8787
npm test && npm run typecheck
```

| Path | What it is |
| --- | --- |
| `src/worker/` | The Worker: API (`index.ts`), scan (`scan.ts`), checks (`checks.ts`, `hygiene.ts`), Cloudflare client (`cf.ts`), setup wizard, auth, alerts (`notify.ts`) |
| `src/shared/` | Types and the config model shared by Worker and UI |
| `web/` | Svelte 5 dashboard, built by Vite into `dist/` and served as static assets |
| `migrations/` | D1 schema |
| `test/` | Vitest: unit tests, plus end-to-end scans against fake API responses with D1 emulated on `node:sqlite` |

## Roadmap

- **v0.1 Core**: fleet overview, free-budget guard, runaway usage, errors and limits, cron health, digest, deploy button, setup wizard, Settings.
- **v0.2 Hygiene**: deprecation radar, exposure audit, zombies and orphaned resources, groups and tags.
- **v0.3 Insight**: change timeline with deploy correlation, webhook channels, per-Worker thresholds, self-cost panel, update notice.
- **v1.0**: public launch, multiple accounts, optional GitHub package check.

The checks for v0.1 to v0.3 are implemented and tested against recorded API responses. Several Cloudflare datasets (scheduled invocations, storage analytics) still need confirming against a live account; see the open questions in the PRD.

## License

Ambersight is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a service for others, you must publish your changes. The name Ambersight and the logo are not covered by the license; see [TRADEMARK.md](TRADEMARK.md).

Ambersight is an independent project and is not affiliated with or endorsed by Cloudflare. "Cloudflare" and "Workers" are trademarks of Cloudflare, Inc., used here only to describe compatibility.
