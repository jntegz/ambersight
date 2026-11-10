# Alerts

Ambersight tells you about findings in two ways:

- **Instant alerts**, sent by the scan that finds the problem, to e-mail, a webhook or both.
- **The digest**, a summary e-mail once a week or once a day.

## The defaults

| Severity | Instant alert | In the digest |
| --- | --- | --- |
| Critical | E-mail | Yes |
| Warning | Off | Yes |
| Info | Off | Yes |

So out of the box, you hear about a runaway Worker or a 10% error rate right away, and everything else arrives on Monday at 08:00 in your time zone. Change both in **Settings › Alerts** and **Settings › Digest**. For each severity, the instant alert can go to e-mail, the webhook, both or nowhere.

An instant alert for a severity with no working channel is skipped. For example, if critical alerts are set to e-mail and e-mail is not configured, Ambersight does not queue them up for later.

## When an instant alert repeats

An open finding is alerted once. If it is still open 24 hours later, it is alerted again, and then once a day until you fix it, acknowledge it or snooze it. A finding that resolves and comes back later is alerted as new.

One scan sends at most 50 findings, critical first. Chat messages show up to 20 of them.

## Quiet hours

Set a start and end time in **Settings › Alerts**, for example 22:00 to 07:00, in your time zone. Instant alerts wait during quiet hours and go out with the first scan after they end. The digest is not affected.

## E-mail

E-mail uses Cloudflare's `send_email` binding. It is free when you send to a **verified address** in Email Routing, and a Gmail address works.

1. Turn on **Email Routing** for a domain you have on Cloudflare and verify the address you want alerts at.
2. In `wrangler.jsonc`, set:
   - `EMAIL_FROM`: any address on that domain, for example `ambersight@example.com`.
   - `DIGEST_TO`: your verified address. Several addresses are fine, separated by commas.
3. Uncomment the `send_email` block and list the same addresses in `allowed_destination_addresses`:

   ```jsonc
   "send_email": [
     { "name": "EMAIL", "allowed_destination_addresses": ["you@example.com"] }
   ]
   ```

4. Commit (Deploy button) or run `npm run deploy` (terminal), then press **Send test** in **Settings › Alerts**.

Recipients come only from this configuration. No API endpoint accepts an e-mail address, so a stolen session cannot send mail to someone new.

## Webhooks

Add one webhook URL as a secret:

```bash
npx wrangler secret put WEBHOOK_URL
```

With the Deploy button you can also add it in the Cloudflare dashboard under **ambersight › Settings › Variables and Secrets**.

Ambersight recognises the service from the URL and sends the format it expects:

| Service | URL | What arrives |
| --- | --- | --- |
| Slack | `https://hooks.slack.com/…` (an incoming webhook) | A message with one line per finding |
| Discord | `https://discord.com/api/webhooks/…` | The same, with mentions turned off |
| Telegram | `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>` | The same, to that chat |
| ntfy | `https://ntfy.sh/<topic>` or your own `ntfy.` host | A notification titled with the summary, one line per finding |
| Anything else | Any HTTPS endpoint | JSON, below |

A chat message looks like this:

```
Ambersight: 2 critical findings in your Workers
• [Critical] auth-gateway: 6.2% of requests failed in the last 24 hours. It started right after a deploy.
• [Critical] image-resizer: Requests in the last hour are 9x this Worker's usual hourly level.
```

Any other endpoint gets a `POST` with this body:

```json
{
  "title": "Ambersight: 2 critical findings in your Workers",
  "findings": [
    {
      "id": "errors:auth-gateway:error-rate",
      "worker": "auth-gateway",
      "severity": "critical",
      "message": "6.2% of requests failed in the last 24 hours. It started right after a deploy.",
      "action": "Compare the deploy of 2026-11-09 22:14 UTC with the one before it, or roll back. Open the Worker in Workers Observability and look at the most frequent exception."
    }
  ]
}
```

`worker` is `*` for findings about the whole account, such as the free request budget. The endpoint must answer with a 2xx status, or the scan records the alert as failed and tries again on the next scan.

Worker names, route patterns and other names that people in your account choose are escaped before they go into a chat message, so a KV namespace called `<!channel>` cannot ping your whole Slack channel.

## The digest

The digest is e-mail only. It lists the open findings for the severities you include, worst first (up to 25), and adds:

- requests and errors across the fleet for the period
- Workers added to or removed from the account
- every deploy in the period, with its author when Cloudflare records one

When nothing is open, the subject says *"All Workers look healthy"*. That is a useful signal by itself: if the digest stops arriving, the scan stopped running.

Choose weekly (any weekday) or daily, and the hour, in **Settings › Digest**. The time zone is in **Settings › General**.

### A digest per group

If you look after Workers for several teams or clients, send each group its own digest. In **Settings › Digest**, give a group one or more recipients. They get a digest with only that group's findings.

Each of those addresses must also be listed in `DIGEST_TO` and in `allowed_destination_addresses`. That keeps the list of people who can receive mail in your config file, where you can review it.
