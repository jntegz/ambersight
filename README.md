<p align="center">
  <img src="docs/logo.svg" width="96" height="96" alt="Ambersight logo: a magnifying glass with a hexagon lens">
</p>

<h1 align="center">ambersight</h1>

<p align="center">See your whole Cloudflare Workers fleet on one page. Read-only. Free. No code changes.</p>

---

Ambersight is a small dashboard that runs as **one Worker in your own Cloudflare account**. Every hour it reads your Workers' metadata and metrics with a read-only API token and tells you which Workers need attention and why:

- **Free plan budget**: how much of today's 100,000 requests you have used, and when you will hit Error 1027.
- **Runaway traffic**: a Worker suddenly running 5x its usual hourly traffic (on Workers Paid, that is billed with no hard cap).
- **Errors and limits**: error rates above 2% or 10%, CPU and memory limit hits, p99 CPU close to the Free plan's 10 ms.
- **Cron health**: scheduled runs that were missed or failed.
- **Weekly digest** by e-mail, plus an instant e-mail for critical findings.

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

Do not give it any Edit permission. Ambersight only ever sends GET requests and GraphQL queries. If the token can see several accounts, set `CF_ACCOUNT_ID` in `wrangler.jsonc` `vars`.

### Protect the dashboard

The passphrase login is on by default (5 wrong attempts lock sign-in for 15 minutes). For stronger protection, put the Worker's hostname behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) as well.

### E-mail alerts (optional, free)

Ambersight uses Cloudflare's `send_email` binding, which is free when you send to a **verified destination address** in Email Routing (a Gmail address works).

1. Enable Email Routing on a domain you have on Cloudflare and verify your address.
2. In your fork's `wrangler.jsonc`, set `EMAIL_FROM` (an address on that domain) and `DIGEST_TO` (your verified address), and uncomment the `send_email` block with the same address.
3. Commit. Workers Builds redeploys.

## Cost

On Workers Free, with 30 Workers, Ambersight uses 1 of your 5 Cron Triggers, about 24 cron runs and a few hundred API calls a day (well under 1% of the 100,000 daily requests), fewer than 15 subrequests per run, and a few thousand D1 row writes a day. Its own logs are switched off.

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
| `src/worker/` | The Worker: API (`index.ts`), hourly scan (`scan.ts`), checks (`checks.ts`), Cloudflare client (`cf.ts`), auth, e-mail |
| `src/shared/` | Types shared by Worker and UI |
| `web/` | Svelte 5 dashboard, built by Vite into `dist/` and served as static assets |
| `migrations/` | D1 schema |
| `test/` | Vitest tests for the checks and the cron parser |

## Roadmap

- **v0.1 Core** (now): fleet overview, free-budget guard, runaway traffic, errors and limits, cron health, digest, deploy button.
- **v0.2 Hygiene**: deprecation radar, exposure audit (workers.dev and preview URLs), zombies and orphaned resources, groups and tags.
- **v0.3 Insight**: change timeline with deploy correlation, webhook channels, per-Worker thresholds, self-cost panel.
- **v1.0**: public launch, multiple accounts, optional GitHub package check.

## License

Ambersight is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a service for others, you must publish your changes. The name Ambersight and the logo are not covered by the license; see [TRADEMARK.md](TRADEMARK.md).

Ambersight is an independent project and is not affiliated with or endorsed by Cloudflare. "Cloudflare" and "Workers" are trademarks of Cloudflare, Inc., used here only to describe compatibility.
