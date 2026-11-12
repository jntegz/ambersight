# Read-only API

Everything the dashboard shows is also available as JSON. You can feed it into Grafana, a script or a status board.

The API reads Ambersight's own D1 database. A request never calls the Cloudflare API, so it costs you nothing beyond one Worker request.

## Tokens

Create a token in **Settings › Security › Read-only API tokens**. It is shown once. Copy it then.

Send it in the `Authorization` header:

```sh
curl -H "Authorization: Bearer amb_..." https://ambersight.<you>.workers.dev/api/overview
```

A token is read-only:

- It can read the routes below with `GET`.
- It cannot acknowledge or snooze findings, start a scan, or read or change settings.
- It cannot create or list other tokens.

Ambersight stores only a SHA-256 digest of each token. The token list shows when each one was last used. **Revoke** stops a token at once.

You can have up to 20 tokens.

## Routes

Every route takes `?account=<account id>`. Without it you get the first watched account.

| Route | Returns |
| --- | --- |
| `GET /api/overview` | What the Overview page shows: totals, budget and quotas, open findings, every Worker with its 7-day sparkline |
| `GET /api/accounts` | One summary per watched account |
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

The field names are the TypeScript types in [`src/shared/types.ts`](../src/shared/types.ts): `Overview`, `AnalyticsView`, `WorkerDetail`, `FindingListItem` and the others.

## Caching

Responses carry an `ETag`. They change only after a scan, a status change or a settings save, and at least once an hour.

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
