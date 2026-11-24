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

An open finding is alerted once on each channel it is routed to. If it is still open 24 hours later, it is alerted again, and then once a day until you fix it, acknowledge it or snooze it. A finding that resolves and comes back later is alerted as new.

E-mail and the webhook are tracked separately. If one fails, the other is not repeated, the digest still goes out, the failure shows as a scan warning, and the channel that failed is retried by a later scan.

One scan handles at most 50 findings per channel, critical first, so a channel that keeps failing does not hold up the other. A chat message shows up to 20 of them, fewer if the text would pass the service's length limit (1,900 characters on Discord, 3,900 elsewhere). Its last line says how many it left out. Those count as not delivered and go out with the next scans. E-mail and the JSON format carry all 50 and say how many more are waiting.

If two scans overlap, each finding and each digest message is still sent once: a run reserves what it will send before sending. A run that dies mid-way loses its reservation after 10 minutes, and a later scan sends the rest.

## When Ambersight itself has a problem

- **Failed scans.** After 3 failed scans of an account in a row (an expired or revoked token, for example), Ambersight sends one alert a day on the channel set for critical alerts. The overview shows the last error, with web addresses, query strings and anything shaped like a credential removed. If that alert should go by e-mail and there is [no operator](#who-gets-what) to send it to, **Settings › Alerts** shows the day it happened.
- **The token is about to expire.** The `health:token-expiry` finding warns 14 days and 3 days ahead.

## When someone changes what you get told

A dashboard session can turn alerts off, so these changes are reported outside the alert settings. Ambersight tells the operators by e-mail and posts to the webhook when someone:

- turns an alert route off or takes a channel away, adds or changes quiet hours, takes a severity out of the digest, or turns the digest off
- switches a check or a group of checks off, excludes Workers from scope or narrows it, raises thresholds, or scans less often
- names a new client or group digest recipient
- acknowledges or snoozes 10 or more findings at once
- stops watching an account
- creates an API token or changes the passphrase

The notice ignores the alert routes and quiet hours. If the same save turned an operator into a client recipient, that address still gets this notice. The first one goes out at once; further changes within 30 minutes are collected into one message, sent by the next scheduled run after that. A notice no channel accepts is retried for a day. Every change is also in **Settings › Security › Admin activity**, with whether the notice went out.

## Is it Cloudflare?

Turn on **Settings › Checks › Cloudflare incidents** and Ambersight looks at Cloudflare's public status page before it sends an instant alert. If an incident is open, the alert says so: *"Cloudflare reports an active incident: …"*. Recent incidents also show on the timeline. This is the only feature that contacts a site outside Cloudflare's API, so it is off by default; the request carries nothing about your account.

## Quiet hours

Set a start and end time in **Settings › Alerts**, for example 22:00 to 07:00, in your time zone. Instant alerts wait during quiet hours and go out with the first scan after they end. The digest is not affected.

## E-mail

E-mail uses Cloudflare's `send_email` binding. It is free when you send to a **verified address** in Email Routing, and a Gmail address works.

1. Turn on **Email Routing** for a domain you have on Cloudflare and verify the address you want alerts at.
2. In `wrangler.jsonc`, set:
   - `EMAIL_FROM`: any address on that domain, for example `ambersight@example.com`.
   - `DIGEST_TO`: your verified address. Several addresses are fine, separated by commas. This is the list of everyone who may receive mail.
3. Uncomment the `send_email` block and list the same addresses in `allowed_destination_addresses`:

   ```jsonc
   "send_email": [
     { "name": "EMAIL", "allowed_destination_addresses": ["you@example.com"] }
   ]
   ```

4. Commit (Deploy button) or run `npm run deploy` (terminal), then press **Send test** in **Settings › Alerts**.

Recipients come only from this configuration. No API endpoint accepts an e-mail address, so a stolen session cannot send mail to someone new.

### Who gets what

| Mail | Goes to |
| --- | --- |
| Instant alerts, "scans are failing" alerts, test messages and the main digest, which covers all accounts | **Operators**: everyone in `DIGEST_TO` who is not named as a client or group recipient, plus the exceptions below, together in one message |
| A client's digest | Each address set for that account, in a message of its own |
| A group's digest | Each address set for that group, in a message of its own |

An address you name as a client or group recipient stops being an operator, so a client never receives mail about your other accounts. Two exceptions keep it an operator:

- It has the per-account digest of **every** watched account and is not a group recipient. There are no other accounts to keep from it, which is the usual case on a one-account install. It then also gets the alerts and the main digest, which shows who deployed. Watching one more account ends this.
- It is listed in the optional `DIGEST_OPERATORS` variable (comma-separated, each address also in `DIGEST_TO`). Use this for your own address on a test client, or for a group recipient.

If that leaves no operator, Ambersight does not fall back to the clients: alerts by e-mail and the main digest are not sent, each scan reports a warning, and **Settings › Alerts** says so, along with the last day a "scans are failing" alert could not be e-mailed. Client and group digests and the webhook keep working.

Each message counts against what one scan may do, one subrequest and one D1 write each. On the Free plan, what does not fit goes out with the next scan that day, operators first.

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
• [Critical] "auth-gateway": 6.2% of requests failed in the last 24 hours. It started right after a deploy.
• [Critical] "image-resizer": Requests in the last hour are 9x this Worker's usual hourly level.
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

`worker` is `*` for findings about the whole account, such as the free request budget. A `more` field appears when further findings are waiting. The endpoint must answer with a 2xx status, or the scan records the alert as failed and tries again on a later scan.

Worker names, route patterns and other names that people in your account choose appear in double quotes, in alerts and digests alike, so they read as data and not as Ambersight's own words. They are also escaped before they go into a chat message or an e-mail, so a KV namespace called `<!channel>` cannot ping your whole Slack channel.

## People's names

Finding messages do not name people. Who made an audit-log change is kept with the finding for the dashboard, where it helps you troubleshoot, and is left out of e-mail, webhooks and the AI summary. Ambersight has no per-person view or ranking, and this attribution is not meant for assessing people. To keep no names at all, turn off **Settings › General › Record who made changes**; see [who made a change](how-it-works.md#who-made-a-change).

## The digest

The digest is e-mail only. It lists the open findings for the severities you include, worst first (up to 25 per account), and adds:

- requests and errors for the period, and how many notifications Cloudflare itself sent
- the estimated bill so far this month and by month end (Workers Paid)
- on the Free plan, the busiest day's share of each daily limit (D1 rows, KV writes and the rest) at 20% or more
- the Workers whose traffic changed most against the period before (at least 2x up or down)
- Workers added to or removed from the account
- every deploy in the period (the main digest also shows its author when Cloudflare records one; client digests and reports do not)

With several accounts, each gets its own section.

When nothing is open, the subject says *"All Workers look healthy"*. That is a useful signal by itself: if the digest stops arriving, the scan stopped running.

Choose daily, weekly (any weekday) or monthly (on the 1st), and the hour, in **Settings › Digest**. The time zone is in **Settings › General**.

### A plain-language summary

With the optional Workers AI binding (`AI` in `wrangler.jsonc`), turn on **Settings › Digest › Plain-language summary**. A few sentences at the top of the main digest say what is most urgent and what to look at first, and are labelled as written by Workers AI. The model gets one line per check: its severity, its name, how many findings it raised and the names of the Workers affected. It does not get finding messages, account names or anything about people, so text someone puts in a resource name cannot steer it. Workers AI runs in your own account and uses a few hundred of the free 10,000 neurons a day. If the call fails, the digest goes out without the summary.

### A digest per account (client reports)

In **Settings › Accounts**, give an account one or more digest recipients. Each gets that account's own digest in a message of its own, and nothing about your other accounts, on the digest schedule. Each address must also be in `DIGEST_TO`. See [who gets what](#who-gets-what).

A digest that fails for one address is retried for that address by later scans that day. The others are not sent again.

For a one-off report, the overview links to a printable report of the account for the last 7 or 30 days. Your browser's Print saves it as a PDF. Client digests, group digests and reports leave the operators, so they hold what an API token without person-linked data gets: no deploy authors, no audit-log text ("A change was recorded shortly before."), no repository or branch names, and no e-mail addresses. The account is named by its label from **Settings › Accounts**, never by its Cloudflare name, which is often a person's; without a label it is `Account <first 8 characters of the id>`, so set one for each client.

### A digest per group

If you look after Workers for several teams or clients, send each group its own digest. In **Settings › Digest**, give a group one or more recipients. Each gets a digest with only that group's findings, in a message of its own.

Each of those addresses must also be listed in `DIGEST_TO` and in `allowed_destination_addresses`. That keeps the list of people who can receive mail in your config file, where you can review it.

A group is made of the Worker patterns you set in **Settings** and of Cloudflare tags. Tags are set by people inside each account, so a tag counts only while the tag and the group's patterns all point at one account. If they reach a second one, the tag is ignored for the group's digest and the scan reports a warning. One client's findings cannot reach another that way. Patterns you set yourself apply in every account.
