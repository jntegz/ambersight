# Read-only API

Everything the dashboard shows is also available as JSON. You can feed it into Grafana, a script or a status board.

The API reads Ambersight's own D1 database. A request never calls the Cloudflare API, so it costs you nothing beyond one Worker request.

## Tokens

Create a token in **Settings › Security › Read-only API tokens**. Choose the accounts it may read, whether it may read person-linked data, and how long it lasts (30, 90 or 365 days), then confirm with one of your passkeys (or, before any passkey exists, your passphrase). The token is shown once. Copy it then.

Send it in the `Authorization` header:

```sh
curl -H "Authorization: Bearer amb_..." https://ambersight.<you>.workers.dev/api/overview
```

A token is read-only:

- It can read the routes below with `GET`.
- It cannot acknowledge or snooze findings, start a scan, or read or change settings.
- It cannot create or list other tokens, or read the admin log.

Ambersight stores only a SHA-256 digest of each token. The token list shows when each one was last used and when it expires. **Revoke** stops a token at once.

A token stops working when it expires, after a recovery sign-in, and when the dashboard passphrase changes: in Settings, by replacing the `ADMIN_PASSPHRASE` secret, or by deleting the stored passphrase. The list marks those tokens. Create a new one to replace them. A stopped token gets `401`. A token created before this rule existed is tied to the credential at the first sign-in, token use or scheduled run after the upgrade; see [SECURITY.md](../SECURITY.md) if you replaced the secret before that.

A token sees that a scan failed, not the error text: `lastError` reads "The last scan failed." and scan warnings are reduced to one general line. The dashboard shows the detail.

You can have up to 20 tokens.

### Which accounts a token reads

You pick the accounts when you create a token. Nothing is ticked at the start: you tick single accounts, or **All watched accounts**, which also covers accounts added later. `POST /api/tokens` refuses a request without `accounts`, which is `"all"` or a list of watched account ids.

A token limited to some accounts behaves as if the others did not exist:

- Naming another account gets the same `404` as naming one that does not exist, so a token cannot find out which accounts are watched.
- With no `?account=`, it gets the first watched account it may read.
- `/api/accounts` lists only its accounts, and `/api/overview` leaves out `accountCount`.
- `/api/findings/<id>/history` returns `[]` for another account's finding, exactly as for an id that does not exist.
- If none of its accounts is watched any more, a request that names no account gets `403` with `{"error": "...", "code": "no_permitted_account"}`. A request with `?account=` still gets the `404` above.
- `/api/self-cost` returns an empty `days` list. Those figures cover the whole install, so they would show how many accounts it scans. `lastScan` is about the account you read, and `allowances` are fixed numbers.

A token for all watched accounts gets the daily figures in `days`.

These limits apply to tokens only. **A dashboard session still sees every watched account**: there is one shared passphrase, and it cannot identify separate people. Do not give the passphrase to someone who should see only one client.

### Person-linked data

A token reads person-linked data only if you tick **Include person-linked data** when you create it. It is off by default. Without it, these fields are left out of every answer, not blanked:

| Where | Left out |
| --- | --- |
| Timeline | `author` on every entry; `message` on deploys, audit entries and Cloudflare notifications; the branch in a Pages entry's message |
| Worker page | `author` and `message` of each deploy; `detail` of audit log changes |
| Findings, everywhere they appear | Evidence `actor`, `member`, `changedBy`, `branch`, `repo`, and `change` when it quotes the audit log. Evidence is limited to the fields Ambersight's checks are known to report, so anything else is left out too. The sentence says "A change was recorded shortly before." instead of quoting it, and "the repository" instead of its name. A lockfile that could not be read gets one fixed sentence |
| Overview | `branch` of the latest Pages deploy |
| Packages | `repo`. `error` is one fixed sentence, because a stored error can name a repository the Worker used before |
| Client report | Always, also for a token with person-linked data or a dashboard session: it is meant for the client |

Account names from Cloudflare are left out as well, because they are often a person's name. Wherever an account is named, you get the label set in **Settings › Accounts**, or `Account <first 8 characters of the id>` if there is none. E-mail addresses in the remaining text become `[email]`. Names chosen for Workers, resources and tags stay: they are what the API reports on, and Ambersight cannot tell whether someone used a personal name for one.

### Tokens from before scopes

A token created before scopes existed keeps every watched account, so what uses it keeps working, but it no longer receives person-linked data. The token list marks these. To narrow one, or to give it that data, create a new token and revoke the old one: the scope of an existing token cannot be changed.

## Routes

Every route that shows one account takes `?account=<account id>`. Without it you get the first watched account the token may read. An id that this install does not watch, or that the token may not read, gets `404` with `{"error": "...", "code": "unknown_account"}`, never another account's data.

| Route | Returns |
| --- | --- |
| `GET /api/overview` | What the Overview page shows: totals, budget and quotas, open findings, every Worker with its 7-day sparkline |
| `GET /api/accounts` | One summary per watched account the token may read |
| `GET /api/analytics?range=30d` | Trends, previous-period totals, every Worker's totals, daily quotas, cost (Workers Paid), storage growth, reliability, deploys |
| `GET /api/workers/<name>?range=7d` | One Worker: metric series, deploys with before and after, findings, changes, configuration |
| `GET /api/findings?status=open` | Findings by status: `open`, `acknowledged`, `snoozed` or `resolved` |
| `GET /api/findings/<id>/history` | Every event of one finding: opened, alerted, acknowledged, resolved |
| `GET /api/changes?since=<ISO time>` | Findings opened, made worse or resolved since a time, at most 30 days back |
| `GET /api/timeline?days=14` | Deploys, audit log, Cloudflare notifications and incidents |
| `GET /api/resources` | Every KV namespace, D1 database, R2 bucket and queue, with who binds it |
| `GET /api/packages` | The Packages view (when it is on) |
| `GET /api/self-cost` | What Ambersight itself used over the last 7 days |
| `GET /api/report?days=7` | The printable client report (HTML) |

`range` can be `24h`, `7d`, `30d`, `90d` or `365d`. The 24-hour and 7-day ranges come by hour. The longer ones come by UTC day.

`days` on the timeline is 7, 14 or 30. Other values round up to the next of these.

The field names are the TypeScript types in [`src/shared/types.ts`](../src/shared/types.ts): `Overview`, `AnalyticsView`, `WorkerDetail`, `FindingListItem` and the others.

## Caching

`/api/overview`, `/api/accounts`, `/api/analytics`, `/api/workers/<name>`, `/api/timeline`, `/api/resources` and `/api/packages` carry an `ETag`. The other routes (`/api/findings`, `/api/findings/<id>/history`, `/api/changes`, `/api/self-cost`, `/api/report` and `/api/health`) do not, and neither does a Worker name Ambersight does not know.

For a token with all watched accounts, the ETag changes after a scan, a status change or a settings save, and at least once an hour. For a token limited to some accounts it is a hash of the response, so it changes only when that response does. The ETag also depends on what the token may read, so tokens with different scopes get different ones.

Send the ETag back in `If-None-Match`. When nothing has changed you get `304 Not Modified` and no body. Polling every minute is fine.

## Examples

Error rate per Worker over the last 30 days:

```sh
curl -s -H "Authorization: Bearer $AMBERSIGHT_TOKEN" "$URL/api/analytics?range=30d" \
  | jq -r '.workers[] | [.name, .totals.requests, (.totals.errors / ([.totals.requests,1] | max))] | @tsv'
```

Open critical findings, for a status board:

```sh
curl -s -H "Authorization: Bearer $AMBERSIGHT_TOKEN" "$URL/api/findings?status=open" \
  | jq '[.[] | select(.severity == "critical")] | length'
```
