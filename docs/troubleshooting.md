# Troubleshooting

Every scan records what it could not read. You see these messages after pressing **Scan now**, and the last scan's messages are always listed in **Settings › Self-cost**. A scan with warnings still runs every check it has data for.

If your problem is not here, [open an issue](https://github.com/jntegz/ambersight/issues/new/choose). Ambersight is an early release, and a few Cloudflare datasets are still being confirmed on live accounts, so reports of odd numbers help.

## Setup

### "CF_API_TOKEN is not set."

The secret is missing, or it still holds the placeholder from `.dev.vars.example`. Set it with `npx wrangler secret put CF_API_TOKEN`, or in the Cloudflare dashboard under **ambersight › Settings › Variables and Secrets**.

### "The token cannot see any account."

The token has no account in its scope. Add the *Account Settings Read* permission, or set `CF_ACCOUNT_ID` under `vars` in `wrangler.jsonc`.

### The wizard says the token has write permissions

Ambersight refuses to continue if any permission on the token can change something (names containing Edit, Write, Admin, Delete, Purge or Revoke). Create a new token from the [pre-filled form](../README.md#step-1-create-a-read-only-api-token), check that every permission says **Read**, and replace the secret. Then delete the old token under **My Profile › API Tokens**.

### "Permissions could not be read"

The wizard proves the token is read-only by listing its permissions, which needs *User › API Tokens Read*. Without it, you can add the permission, or check the token in the Cloudflare dashboard yourself and tick **I confirm this token is read-only**.

### The plan is wrong

Ambersight detects Free or Paid with *Billing Read*. Without that permission, it uses `PLAN` from `wrangler.jsonc`, which is `free` by default. Set the plan directly in **Settings › General** to override both.

### I forgot my passphrase

See the [FAQ in the README](../README.md#faq).

## Scan warnings

### "Storage lists unavailable: KV, D1 …"

The token is missing the matching Read permission (*Workers KV Storage*, *D1*, *Workers R2 Storage* or *Queues*). The storage checks for those kinds are skipped until you add the permissions to the token.

### "Routes unavailable" or "Custom domains unavailable"

The token is missing *Zone › Workers Routes Read* or *Zone › Zone Read*, or it is limited to some zones. The exposure and orphan checks see only what the token can read.

### "N zone checks will run on the next scans."

Routes, certificates and DNS records are read zone by zone, a few per scan, so each zone is read at least once a day. With many zones the first scans fill this in over a few hours; what is already stored is kept in the meantime. The optional scan queue finishes them in one go.

### "Certificates unavailable for …" or "DNS records unavailable for …"

The token is missing *SSL and Certificates Read* or *DNS Read*. The certificate and dangling-DNS checks are skipped until you add them, or switch off **Settings › Checks › Security**.

### "Pages projects unavailable: …"

The token is missing *Pages Read* (the key `page` in the token template). Add it, or switch off **Settings › Checks › Pages**.

### "Audit log unavailable: …"

The audit log needs *Account Settings Read*, which the pre-filled token already has. Ambersight tries again a day later.

### "Cloudflare notifications unavailable: …"

The token is missing *Notifications Read*. It has no short key for the pre-filled token link, so add it by hand under **My Profile › API Tokens › Edit**, or switch off **Settings › Checks › Cloudflare notifications**. Ambersight asks again once a day.

### "Storage sizes unavailable: d1, kv …" or "D1 query insights unavailable."

A GraphQL dataset was not available for the account. The storage-cap or expensive-query checks for those products wait until it is.

### Workers AI or Workflow limits never show

Those numbers come from GraphQL datasets that Ambersight reads only when a Worker binds Workers AI or a Workflow. The Workers AI dataset is not in Cloudflare's documentation; if the account does not have it, Ambersight retries once a day and the rest of the checks keep working.

### "The last N scans failed: …"

Shown on the overview after a scan fails, with Cloudflare's error. The most common causes are an expired or revoked token (check `health:token-expiry` and **My Profile › API Tokens**) and an account the token can no longer see. After 3 failures in a row, Ambersight sends one alert a day.

### "N Workers will get their details on the next runs."

Normal on a large fleet. Each scan reads bindings, deploys and schedules for as many Workers as its subrequest budget allows. The rest follow on the next scans. See [how-it-works.md](how-it-works.md#large-fleets).

### "Details for <Worker> unavailable: …"

Cloudflare refused one Worker's settings or deployments. This is usually temporary. If it repeats for the same Worker, open an issue with the message.

### "CPU totals unavailable; CPU runaway detection is off."

Your account does not return CPU totals in the analytics dataset Ambersight uses. `runaway:cpu-spike` is skipped. The other checks are not affected.

### "Limit outcomes unavailable: …"

Ambersight could not read how many invocations hit the CPU or memory limit, so `errors:resource-limit` is skipped this scan.

### "Workers list unavailable: …"

The detailed Workers list (which adds `workers.dev`, preview and deploy data) failed. Ambersight falls back to the basic list. The exposure checks wait until the detailed list works again.

### Cron checks paused

You may see one of three messages:

- **"Cron runs unavailable: …"**: the scheduled invocations dataset is not available on your account. Ambersight tries again once a day.
- **"Cron checks paused: Cloudflare returned no scheduled runs for any Worker in the last 24 hours, not even Ambersight's own."**: Ambersight's own cron ran, so an empty answer means the dataset returned nothing, not that every cron stopped. The cron checks keep their current findings instead of reporting a missed run for every Worker.
- **"Cron checks paused: …"** with another reason: there were too many runs to count in one scan. Existing cron findings are kept as they are.

### "Update check failed: GitHub answered …"

GitHub was unreachable or rate-limited. Nothing else is affected. Turn the update check off in **Settings › General** if you do not want it.

## Alerts

### "E-mail is not configured"

**Send test** needs all three: `EMAIL_FROM`, `DIGEST_TO` and the `send_email` binding in `wrangler.jsonc`. After changing them, commit or run `npm run deploy`. See [alerts.md](alerts.md#e-mail).

### E-mail is configured but nothing arrives

- The recipient must be a **verified destination address** in Email Routing, and it must be listed in `allowed_destination_addresses`.
- `EMAIL_FROM` must be on the domain where Email Routing is turned on.
- Check your spam folder for the first message.
- By default only critical findings are e-mailed right away. Everything else waits for the weekly digest on Monday at 08:00. **Send test** tells you whether delivery works at all.

### "Webhook answered 4xx/5xx"

The endpoint refused the message. For Slack and Discord, the webhook was usually deleted or regenerated: create a new one and replace `WEBHOOK_URL`. For Telegram, check that the URL includes `chat_id` and that the bot is in that chat.

### "Alerts failed: …"

The scan finished, but sending failed. Ambersight tries again on the next scan, because it only marks a finding as alerted after the message is sent.

## The dashboard

### "The first scan has not run yet."

Press **Scan now**, or wait for the next scheduled scan (at most 15 minutes away).

### The numbers look low for the first few days

The runaway and storage checks need 72 hours of history. The no-traffic check waits until Ambersight has tracked the account for 30 days. Until then, those checks stay quiet.

### `workers.dev` came back on after I disabled it

The next deploy applies `wrangler.jsonc` again. Set `"workers_dev": false` in the file and commit it, instead of only switching it off in the Cloudflare dashboard.
