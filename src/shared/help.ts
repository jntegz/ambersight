// Plain-language help for every check, written for someone new to Cloudflare Workers:
// what the finding means, why it matters, and step-by-step what to do.
// Shown under "Explain in plain words" on each finding and in the Markdown export.
// SPDX-License-Identifier: AGPL-3.0-only

export interface CheckHelp {
  /** What the finding means, without jargon. */
  what: string;
  /** What happens if you leave it. */
  why: string;
  /** What to do, one action per step. */
  steps: string[];
}

const DASH = 'In the Cloudflare dashboard (dash.cloudflare.com), open Workers & Pages and click the Worker named in the finding.';
const OBS = 'Open its Observability tab (or Logs) to see the individual requests and the error messages they produced.';
const RESET = 'Free plan daily limits reset at midnight UTC. Nothing you do brings the reset forward; upgrading to Workers Paid ($5 a month) lifts the limits right away.';

/** Free plan daily limits, one entry per kind of operation. */
function daily(thing: string, limit: string, causes: string, fix: string[]): CheckHelp {
  return {
    what: `On the Free plan, your whole account (all Workers together) can do ${limit} a day. Today you are getting close to that.`,
    why: `When the limit is reached, ${thing} fail for every Worker in the account until midnight UTC. Your app can break for hours. ${RESET}`,
    steps: [
      `Find out which Worker is behind it: ${causes}`,
      ...fix,
      'If the usage is real and expected (your app simply grew), upgrade the account to Workers Paid under Workers & Pages › Plans.',
    ],
  };
}

/** A resource kind in plain words, for the per-kind families of checks. */
const KIND: Record<string, { name: string; ops: string }> = {
  kv: { name: 'KV namespace (a simple key-value store)', ops: 'reads and writes' },
  d1: { name: 'D1 database (a SQL database)', ops: 'queries' },
  r2: { name: 'R2 bucket (file storage)', ops: 'file reads and writes' },
  queues: { name: 'queue (a list of jobs waiting to be processed)', ops: 'messages' },
  do: { name: 'Durable Objects (small stateful servers your Worker talks to)', ops: 'requests' },
};

const idle = (k: string): CheckHelp => ({
  what: `This ${KIND[k].name} has been busy for the last 3 hours, but the Workers that use it got almost no visitors. Something is working on its own, in a loop.`,
  why: 'A loop like this keeps running all night. On Workers Paid every operation is billed, so it costs money every hour. On Free it eats your daily limits.',
  steps: [
    'Think of what runs without a visitor: an alarm that schedules the next alarm, a queue consumer that fails and retries the same messages, or a scheduled job (cron) that never finishes.',
    `${DASH} ${OBS}`,
    'Look for the same request or error repeating many times a minute.',
    'Fix the code (for example: stop rescheduling the alarm, or send failing messages to a dead-letter queue instead of retrying forever), then deploy again.',
    'To stop the cost right away while you fix it, you can roll back to an earlier version in the Worker\'s Deployments tab.',
  ],
});

const opsSpike = (k: string): CheckHelp => ({
  what: `In the last hour, this ${KIND[k].name} handled about 5 times more ${KIND[k].ops} than in a normal hour.`,
  why: 'A sudden jump is usually a bug (a loop or retries) or unexpected traffic. On Workers Paid it is billed; on Free it uses up the daily limit.',
  steps: [
    'Check the overview for a Worker with a traffic spike at the same time: if visitors went up, the extra usage may be fine.',
    'If traffic did not go up, look at the Worker bound to this resource. Open it in the dashboard (Workers & Pages) and look at the Deployments tab: did anything change recently?',
    `${OBS} Look for the same call repeating.`,
    'If a recent deploy caused it, roll back from the Deployments tab, then fix the code.',
  ],
});

const newBurst = (k: string): CheckHelp => ({
  what: `This ${KIND[k].name} is new (less than 3 days old) and already had over 100,000 ${KIND[k].ops} in one hour.`,
  why: 'Ambersight normally compares with past hours, which a new resource does not have yet. A very busy first hour is often a loop.',
  steps: [
    'If you just imported data or ran a migration on purpose, you can acknowledge this finding.',
    'If not, open the Worker that uses it (Workers & Pages) and look at its Observability tab for a call that repeats.',
    'Fix the loop and deploy again.',
  ],
});

const storage = (what: string, limit: string, fix: string[]): CheckHelp => ({
  what: `${what} is close to its size limit (${limit}).`,
  why: 'When storage is full, new data cannot be written: saves fail with an error while reads still work.',
  steps: [
    'Open the resource in the dashboard (Storage & Databases) to see what takes the space.',
    ...fix,
    'If you need the space, upgrade to Workers Paid, which has much larger limits.',
  ],
});

const deleteWithCare = (thing: string, extra: string[] = []): CheckHelp => ({
  what: `This ${thing} is not connected (bound) to any Worker. It often happens after you delete a Worker: Cloudflare deletes the code but keeps its data.`,
  why: 'Leftover storage is clutter, can hold old personal data, and counts against your storage limits. It costs nothing to keep a small one.',
  steps: [
    'Make sure nothing else uses it. Some apps use storage directly through the Cloudflare API or other tools, without a Worker. "Last used" on the finding shows the last operations Ambersight saw, from any source: "none in 30 days" is a good sign it is safe to remove.',
    ...extra,
    'Open "How to remove it" on the finding and run the command shown in a terminal, logged in with npx wrangler login. Ambersight never deletes anything itself.',
  ],
});

/** Storage still bound to a Worker that never uses it. */
const boundIdle = (thing: string, extra: string[] = []): CheckHelp => ({
  what: `This ${thing} is connected (bound) to one or more Workers, but nothing has read from it or written to it for the whole period Ambersight looked at. Usually the code that used it was removed but the binding stayed in the Wrangler config.`,
  why: 'It is clutter, can hold old personal data and counts against your storage limits. Because it is still bound, deleting it without removing the binding first makes those Workers fail when they next try to use it.',
  steps: [
    'Check the Workers listed under "Bound to": search their code for the binding name. Yearly jobs and backups can look idle for a long time.',
    'Remove the binding from each Worker\'s Wrangler config (wrangler.jsonc or wrangler.toml) and redeploy.',
    ...extra,
    'Then open "How to remove it" on the finding and run the command shown, logged in with npx wrangler login. Ambersight never deletes anything itself.',
  ],
});

export const CHECK_HELP: Record<string, CheckHelp> = {
  // ---- Free plan budget and daily limits
  'budget:free-daily-requests': {
    what: 'On the Free plan, all Workers in your account together can answer 100,000 requests a day. Today you have used most of them.',
    why: `When the 100,000 are used up, every Worker in the account shows Error 1027 to visitors until midnight UTC. Your whole site or API is down for the rest of the day. ${RESET}`,
    steps: [
      'Look at the Workers list on the overview, sorted by requests, to see which Worker gets the most traffic.',
      'Check whether the traffic is real: a bot or crawler, or a loop where your app calls itself, can use thousands of requests an hour.',
      'If it is a bot, block it with a WAF rule or rate limiting (Security › WAF in your domain\'s dashboard).',
      'If it is real visitors, upgrade to Workers Paid (Workers & Pages › Plans): it includes 10 million requests a month.',
    ],
  },
  'budget:monthly-budget': {
    what: 'You set a monthly budget for this account in Settings › Accounts, and the estimated Workers Paid bill is close to it, past it, or on track to pass it by the end of the month.',
    why: 'Workers Paid has no spending cap: a loop, a retry storm or a crawler keeps running and is billed for every request. Cloudflare\'s own budget alerts arrive a day late; this one comes within the hour.',
    steps: [
      'Open Analytics › Cost to see the bill per month, the usage per day and the Workers that cost most.',
      'Look in Needs attention for runaway or idle-loop findings: they name the Worker or the storage behind a sudden rise.',
      'If the spend is expected (more visitors), raise the budget in Settings › Accounts.',
      'To stop a runaway Worker yourself, deploy a fix, roll back in Workers & Pages › your Worker › Deployments, or set a CPU limit in its Settings. Ambersight never changes your Workers.',
    ],
  },
  'budget:free-daily-d1-rows-read': daily('database reads', '5 million rows read from D1 databases', 'look for the "D1 queries reading far more rows than they return" finding, which names the query.', [
    'A query that reads far more rows than it returns usually needs an index. Add one: CREATE INDEX idx_name ON table(column), for the columns in its WHERE clause.',
  ]),
  'budget:free-daily-d1-rows-written': daily('database writes', '100,000 rows written to D1 databases', 'look in the overview for the Worker with the most D1 activity.', [
    'Look for a write that runs on every request, or inside a loop. Write once per change, not once per visit.',
  ]),
  'budget:free-daily-kv-reads': daily('KV reads', '100,000 reads from KV', 'look for the Worker that reads KV on every request.', [
    'Keep values you read often in memory, or use the Cache API, so each request does not read KV again.',
  ]),
  'budget:free-daily-kv-writes': daily('KV writes', '1,000 writes to KV', 'look for the Worker that writes KV on every request (for example a visitor counter).', [
    'KV is made for data you read often and change rarely. Move counters and frequently changing data to D1 or Durable Objects.',
  ]),
  'budget:free-daily-kv-deletes': daily('KV deletes', '1,000 deletes from KV', 'look for the Worker that deletes many keys.', [
    'Give keys an expiry time (expirationTtl when you write them) so they disappear on their own, without a delete.',
  ]),
  'budget:free-daily-kv-lists': daily('KV list requests', '1,000 list requests on KV', 'look for the Worker that lists keys on every request.', [
    'Store an index (one key that holds the list of names) instead of listing the namespace each time.',
  ]),
  'budget:free-daily-do-requests': daily('Durable Object requests', '100,000 Durable Object requests', 'look for the Worker bound to the Durable Object.', [
    'Look for clients that send many small messages or reconnect in a loop, and alarms that fire more often than needed.',
  ]),
  'budget:free-daily-queue-ops': daily('queue operations', '10,000 queue operations', 'look for the Worker that sends to or reads from the queue.', [
    'Send messages in batches (sendBatch), and check that the consumer is not failing and retrying every message.',
  ]),
  'budget:free-daily-workflow-steps': daily('Workflow steps', '3,000 Workflow steps', 'look for the Workflow that starts most often.', [
    'Combine many small steps into fewer bigger ones.',
  ]),
  'budget:free-daily-ai-neurons': {
    what: 'Workers AI measures usage in "neurons". Your account gets 10,000 free neurons a day, and today you have used most of them.',
    why: 'On Free, AI calls fail once they are used up, until midnight UTC. On Paid, the rest of the day is billed.',
    steps: [
      'Find the Worker that calls AI (it has an AI binding).',
      'Use a smaller model if the answers are good enough, and keep answers to repeated questions in a cache instead of asking again.',
    ],
  },
  'budget:storage-d1-db': storage('A D1 database', '500 MB per database on Free, 10 GB on Paid', [
    'Delete old rows you no longer need (logs, expired sessions), or move large files to R2 and keep only a link in the database.',
  ]),
  'budget:storage-d1-account': storage('All D1 databases together', '5 GB on Free', ['Delete old data, or remove databases you no longer use (see Housekeeping).']),
  'budget:storage-kv-account': storage('All KV storage together', '1 GB on Free', ['Delete keys you no longer need, and give temporary keys an expiry time.']),
  'budget:storage-do-account': storage('Durable Object storage', '5 GB on Free', ['Clear the storage of objects you no longer use (storage.deleteAll() in your code).']),
  'budget:storage-r2-account': {
    what: 'Your R2 file storage is past the 10 GB that are free each month.',
    why: 'R2 does not stop working: storage above 10 GB is billed (about $0.015 per GB per month).',
    steps: [
      'Open R2 in the dashboard and check which bucket is largest.',
      'Delete files you no longer need, or add a lifecycle rule (bucket › Settings › Object lifecycle rules) that deletes old files automatically.',
    ],
  },

  // ---- Ambersight itself
  'health:token-expiry': {
    what: 'The API token that Ambersight uses to read your account expires soon.',
    why: 'When it expires, Ambersight cannot read anything and stops warning you about problems.',
    steps: [
      'In the Cloudflare dashboard, open My Profile › API Tokens and find the token (named "Ambersight read-only" if you used the link).',
      'Extend its expiry date, or create a new read-only token with the same permissions.',
      'If you made a new one, save it: npx wrangler secret put CF_API_TOKEN (or Ambersight › Settings › Variables and Secrets in the dashboard).',
    ],
  },

  // ---- Runaway usage
  'runaway:traffic-spike': {
    what: 'This Worker got about 5 times more requests in the last hour than in a normal hour.',
    why: 'If it is not real visitors, it is usually a bot or a loop. On Workers Paid every request is billed with no spending cap; on Free it uses up the 100,000 daily requests.',
    steps: [
      `${DASH} ${OBS}`,
      'Check where the requests come from: many from the same IP or user agent usually means a bot. Block it with a WAF or rate limiting rule on your domain.',
      'If the Worker calls itself (directly or through another Worker), that is a loop: fix the code.',
      'If it is a real surge of visitors (a launch, a mention), you can acknowledge the finding.',
    ],
  },
  'runaway:cpu-spike': {
    what: 'This Worker used about 5 times more CPU time (computing time) in the last hour than in a normal hour.',
    why: 'On Workers Paid CPU time is billed. It often means a slow piece of code arrived with a recent deploy, or more traffic than usual.',
    steps: [
      'Check whether requests also went up. If they did, it is probably traffic: see the traffic spike advice.',
      `If not, look at the Deployments tab of the Worker (${DASH}): a recent deploy may have added slow code.`,
      'Roll back from the Deployments tab if needed, then find the slow part (big loops, large JSON parsing, image work).',
    ],
  },
  'runaway:subrequest-spike': {
    what: 'This Worker made about 5 times more outgoing requests (fetch calls to other servers or APIs) in the last hour than usual.',
    why: 'Usually a fetch inside a loop, or retries without a pause. It can hit the other service\'s rate limits and costs more on Paid.',
    steps: [
      `${DASH} ${OBS}`,
      'Look for the same outgoing URL called many times per request.',
      'Fetch once and reuse the result, and wait longer between retries (exponential backoff).',
    ],
  },
  'runaway:new-worker-burst': {
    what: 'This Worker is new (less than 3 days old) and already got over 50,000 requests in one hour.',
    why: 'Ambersight cannot compare a new Worker with its past yet. A very busy first hour is often a loop or a bot.',
    steps: [
      'If you just launched it and expected the traffic, acknowledge the finding.',
      `If not, ${DASH.charAt(0).toLowerCase() + DASH.slice(1)} ${OBS}`,
    ],
  },

  // ---- Logs and D1 queries
  'usage:logs-full-sampling': {
    what: 'This busy Worker keeps a log of every single request (100% sampling).',
    why: 'From 1 December 2026 Cloudflare bills logs per GB. Logging every request of a busy Worker can cost money, or use up the Free plan\'s daily log allowance.',
    steps: [
      'Decide whether you need every request, or whether 1 in 10 (10%) is enough to spot problems.',
      'In your Wrangler config, set observability.head_sampling_rate, for example to 0.1 for 10%, and deploy again.',
    ],
  },
  'usage:logs-free-allowance': {
    what: 'On the Free plan, your Workers together are close to (or over) the 0.5 GB of logs a day that Cloudflare stores for free.',
    why: 'Past the allowance, new logs are no longer stored until midnight UTC, so you may miss the logs you need to debug a problem.',
    steps: [
      'Find the busiest Workers on the overview.',
      'Lower their logging with observability.head_sampling_rate in the Wrangler config (for example 0.1 keeps 1 request in 10), then deploy.',
    ],
  },
  'usage:d1-inefficient-query': {
    what: 'A database query reads a lot of rows to return just a few. The finding shows the query.',
    why: 'D1 counts (and on Paid, bills) every row it reads. On Free it eats the 5 million rows a day. It is also slower than it needs to be.',
    steps: [
      'Look at the WHERE and ORDER BY parts of the query shown.',
      'Add an index on those columns, for example: npx wrangler d1 execute <database> --remote --command "CREATE INDEX idx_users_email ON users(email)".',
      'After the next day of data, this finding goes away if the index helped.',
    ],
  },
  'usage:logpush-on': {
    what: 'Logpush is on for this Worker: its logs are sent to an outside service (for example a storage bucket or a logging tool).',
    why: 'Logpush is a paid feature and the destination may charge too. It is easy to forget once it is set up.',
    steps: [
      'Check that you still use the destination.',
      'If not, turn off logpush in the Worker\'s settings (logpush = false in the Wrangler config) and deploy.',
    ],
  },

  // ---- Errors and limits
  'errors:error-rate': {
    what: 'More than 2% of this Worker\'s requests failed in the last 24 hours. Visitors got an error instead of a page or a result.',
    why: 'Failed requests mean broken pages, failed sign-ins or lost data for your users.',
    steps: [
      `${DASH} ${OBS}`,
      'Filter by errors or "outcome: exception" and open the most common one: it shows the error message and the line of code.',
      'If the errors started after a deploy, roll back from the Deployments tab first, then fix the code calmly.',
    ],
  },
  'errors:error-baseline': {
    what: 'This Worker fails more often than it usually does: about 3 times its normal error rate over the past week.',
    why: 'The rate may still look small, but a change from normal usually means something broke (a deploy, an API it depends on, bad data).',
    steps: [
      `${DASH} Check the Deployments tab for a recent change.`,
      `${OBS} Compare the most common error with what you see in the days before.`,
      'Check whether an outside service the Worker calls is having problems.',
    ],
  },
  'errors:resource-limit': {
    what: 'Some requests to this Worker were stopped because they used too much CPU time or memory.',
    why: 'Each stopped request is an error for the visitor. On Free, a request may use only 10 ms of CPU.',
    steps: [
      `${DASH} ${OBS} Look for "exceededCpu" or "exceededMemory".`,
      'Find the heavy work (big loops, parsing large files, image processing) and make it lighter.',
      'Move heavy jobs out of the request: put them on a Queue or in a Workflow and do them in the background.',
    ],
  },
  'errors:cpu-near-limit': {
    what: 'The slowest requests of this Worker use close to the 10 ms of CPU time that the Free plan allows per request.',
    why: 'Nothing fails yet, but a little more work per request, or a slower code path, will push requests over the limit (Error 1102).',
    steps: [
      'Look for work you can skip, cache or do once at start-up instead of on every request.',
      'If the Worker simply needs more time, Workers Paid allows up to 30 seconds of CPU per request.',
    ],
  },
  'errors:subrequests-near-limit': {
    what: 'On average, each request to this Worker makes 40 or more outgoing calls (fetches, or calls to other Cloudflare services). The Free plan allows 50 per request.',
    why: 'Since this is an average, some requests probably already go over 50. The 51st call throws an error.',
    steps: [
      'Combine calls where the API allows it (one request for many items).',
      'Cache results you fetch on every request.',
      'Move work that fans out to many calls to a Queue, where each message gets its own limit.',
    ],
  },

  // ---- Cron
  'cron:missed-runs': {
    what: 'A scheduled job (Cron Trigger) ran fewer times than its schedule says it should have.',
    why: 'Whatever the job does (cleanups, reports, syncing data) is not happening.',
    steps: [
      `${DASH} Open Settings › Trigger events and check that the schedule is still there.`,
      'Check that the code still has a scheduled() handler: a deploy without it stops the job.',
      'If the schedule is gone, add it back in your Wrangler config (triggers.crons) and deploy.',
    ],
  },
  'cron:failed-runs': {
    what: 'A scheduled job (Cron Trigger) ran, but ended with an error.',
    why: 'The job\'s work is not done, and it fails again at every run until the code is fixed.',
    steps: [
      `${DASH} ${OBS} Filter for scheduled (cron) invocations.`,
      'Open a failed run to see the error message, fix the code and deploy.',
    ],
  },
  'cron:cron-cpu-near-limit': {
    what: 'A scheduled job uses close to its CPU time limit: 10 ms on Free, 30 seconds on Paid.',
    why: 'A run that goes over the limit is cancelled half-way, so the job may be left unfinished.',
    steps: [
      'Split the job into smaller parts that each do less.',
      'Or let the cron put work on a Queue, and process the queue in small batches.',
    ],
  },
  'cron:cron-count': {
    what: 'Your account is close to the maximum number of scheduled jobs (Cron Triggers): 5 on Free, 250 on Paid.',
    why: 'At the limit, a deploy that adds a schedule is rejected.',
    steps: [
      'Remove schedules you no longer need.',
      'Combine jobs: one Worker with one schedule can run several tasks, checking the time to decide which one.',
    ],
  },

  // ---- Deploys
  'deploys:stuck-rollout': {
    what: 'This Worker is running two versions at once, splitting visitors between them (a gradual rollout), and has been for more than a day.',
    why: 'Visitors get different behaviour depending on which version they hit, and errors are hard to trace to a version.',
    steps: [
      `${DASH} Open the Deployments tab to see the two versions and their percentages.`,
      'If the new version works well, move it to 100%: npx wrangler versions deploy, or "Deploy version" in the dashboard.',
      'If not, roll back to the old version at 100%.',
    ],
  },

  // ---- Deprecations
  'deprecation:service-worker-syntax': {
    what: 'This Worker is written in the old "Service Worker" style (addEventListener(\'fetch\', ...)) instead of the current "ES modules" style (export default { fetch }).',
    why: 'The old style still works, but newer features (Durable Objects, Workflows, many bindings) need the modules style, and new docs and examples use it.',
    steps: [
      'Follow Cloudflare\'s migration guide (linked as Docs on the finding).',
      'The main change: replace addEventListener(\'fetch\', ...) with export default { async fetch(request, env, ctx) { ... } }, and read bindings from env instead of globals.',
      'Test locally with npx wrangler dev, then deploy.',
    ],
  },
  'deprecation:old-compat-date': {
    what: 'The Worker\'s compatibility date is over a year old. This date tells Cloudflare which version of the Workers runtime behaviour your code expects.',
    why: 'Your Worker keeps the old behaviour and misses fixes and newer features. The longer you wait, the more changes pile up.',
    steps: [
      'Open the compatibility dates changelog (Docs link) and read what changed since your date.',
      'Set compatibility_date in your Wrangler config to today\'s date.',
      'Test with npx wrangler dev, then deploy. Roll back from the Deployments tab if something breaks.',
    ],
  },
  'deprecation:legacy-usage-model': {
    what: 'This Worker still reports an old pricing setting ("bundled" or "unbound") that Cloudflare replaced with "Standard" pricing.',
    why: 'It is a leftover. Removing it keeps the config clean and avoids surprises when the old setting is retired.',
    steps: [
      'Remove the usage_model line from your Wrangler config.',
      'Deploy again.',
    ],
  },
  'deprecation:workers-sites': {
    what: 'This Worker serves its website files with "Workers Sites", an older feature that Cloudflare replaced with "Static Assets".',
    why: 'Workers Sites is deprecated: it gets no new features and is harder to use. Static Assets is simpler and serves files for free.',
    steps: [
      'In your Wrangler config, replace the [site] section with assets = { directory = "./public" } (your folder of files).',
      'Remove the code that used __STATIC_CONTENT or kv-asset-handler.',
      'Test with npx wrangler dev, then deploy.',
    ],
  },
  'deprecation:redundant-flags': {
    what: 'The Worker turns on a compatibility flag that is already on by default for its compatibility date.',
    why: 'Nothing breaks. It is just clutter in the config.',
    steps: ['Remove the flag from compatibility_flags in your Wrangler config, and deploy.'],
  },

  // ---- Exposure
  'exposure:previews-without-workers-dev': {
    what: 'Anyone with the link can open preview versions of this Worker, even though you turned off its workers.dev address. Many people think turning off workers.dev also hides previews. It does not.',
    why: 'Previews can show unfinished code, test data or admin pages to anyone who finds the URL, without your domain\'s security rules.',
    steps: [
      'Add preview_urls = false to the Worker\'s Wrangler config and deploy.',
      'Or protect previews with Cloudflare Access: Workers & Pages › select the Worker › Settings › Domains & Routes › Preview URLs.',
    ],
  },
  'exposure:preview-urls': {
    what: 'Every new version of this Worker gets its own public preview link.',
    why: 'Preview links are public by default and skip your domain\'s security rules. Fine if you share previews on purpose, risky for internal tools.',
    steps: [
      'If you do not use previews, add preview_urls = false to the Wrangler config and deploy.',
      'To fix all Workers at once: Workers & Pages › Protect all Workers › Enable Access › Previews only.',
    ],
  },
  'exposure:workers-dev-duplicate': {
    what: 'This Worker answers on your own domain and also on a free <name>.<you>.workers.dev address.',
    why: 'Requests through workers.dev skip the protection you set on your domain (firewall rules, rate limits, Access login). Someone could use it to get around them.',
    steps: [
      'If you only use your own domain, add workers_dev = false to the Wrangler config and deploy.',
      'Or turn it off in the dashboard: the Worker › Settings › Domains & Routes › workers.dev › Disable.',
    ],
  },
  'exposure:workers-dev-public': {
    what: 'This Worker is reachable only on its free workers.dev address, by anyone who has the link.',
    why: 'That is fine for a public site or API. For an internal tool, anyone who guesses or finds the address can use it.',
    steps: [
      'If it is meant to be public, acknowledge the finding.',
      'If it is internal, protect it with Cloudflare Access, or turn workers.dev off and give it a route on your own protected domain.',
    ],
  },
  'exposure:pages-dev-public': {
    what: 'This Pages site has your own domain, but its free <project>.pages.dev address still works too.',
    why: 'Visits through pages.dev skip your domain\'s firewall, bot and rate-limiting rules.',
    steps: [
      'Redirect pages.dev to your domain with a Bulk Redirect rule (Rules › Bulk Redirects in the dashboard).',
      'Or protect the pages.dev address with Cloudflare Access.',
    ],
  },
  'exposure:not-behind-access': {
    what: 'This Worker\'s address is open to everyone: no Cloudflare Access login protects it.',
    why: 'For a public website that is expected. For an internal tool (admin panel, dashboard, staging), anyone who finds the address can use it.',
    steps: [
      'If it is meant to be public, acknowledge the finding or switch the Access check off in Settings.',
      'If it is internal, go to Zero Trust › Access › Applications › Add an application › Self-hosted, enter the Worker\'s hostname, and allow only your e-mail or team.',
    ],
  },

  // ---- Zombies and orphans
  'zombies:no-traffic': {
    what: 'Nobody has used this Worker for 30 days or more.',
    why: 'An unused Worker is easy to forget: it may still be public, hold old secrets, or keep its storage around.',
    steps: [
      'Make sure it is really unused (a yearly job, or a backup endpoint, may look idle).',
      'Delete it: open "How to remove it" for the command, or Workers & Pages › the Worker › Settings › Delete.',
      'Deleting a Worker keeps its KV, D1, R2 and queues. "Leaves behind" on the finding lists the storage only this Worker uses, and "How to remove it" has the commands to delete it too.',
    ],
  },
  'zombies:never-deployed': {
    what: 'This Worker was created but no code was ever deployed to it.',
    why: 'It does nothing. It is usually a test or a forgotten start.',
    steps: ['Deploy it if you still need it, or delete it (see "How to remove it").'],
  },
  'zombies:missing-service': {
    what: 'This Worker has a "service binding" (a direct connection) to another Worker that no longer exists.',
    why: 'Any code that calls that Worker through the binding fails with an error.',
    steps: [
      'Remove the binding from the Wrangler config ([[services]]) and the code that uses it, then deploy.',
      'Or deploy the missing Worker again if it was deleted by mistake.',
    ],
  },
  'zombies:missing-tail': {
    what: 'This Worker sends its logs to a "tail consumer" Worker that no longer exists.',
    why: 'Those logs go nowhere.',
    steps: ['Remove it from tail_consumers in the Wrangler config, and deploy.'],
  },
  'zombies:orphan-route': {
    what: 'A route on your domain still points at a Worker that was deleted.',
    why: 'Visitors to that address get an error. The route is just a leftover.',
    steps: ['In the dashboard, open your domain › Workers Routes, find the route shown in the finding and delete it.'],
  },
  'zombies:orphan-domain': {
    what: 'A custom domain is still connected to a Worker that was deleted.',
    why: 'Visitors to that hostname get an error.',
    steps: ['Remove the custom domain (see "How to remove it"), or connect it to another Worker.'],
  },
  'zombies:unbound-kv': deleteWithCare('KV namespace (key-value storage)', ['Look inside first: Storage & Databases › KV › the namespace › KV Pairs.']),
  'zombies:unbound-d1': deleteWithCare('D1 database', ['The commands under "How to remove it" make a backup file first.']),
  'zombies:unbound-r2': deleteWithCare('R2 bucket (file storage)', ['R2 is often used directly by other apps through its S3 API or a public URL. Check before deleting.', 'A bucket must be empty before it can be deleted.']),
  'zombies:unbound-queues': deleteWithCare('queue', ['Messages still waiting in the queue are lost when you delete it.']),
  'zombies:bound-idle-kv': boundIdle('KV namespace (key-value storage)', ['Look inside first: Storage & Databases › KV › the namespace › KV Pairs.']),
  'zombies:bound-idle-d1': boundIdle('D1 database', ['The commands under "How to remove it" make a backup file first.']),
  'zombies:bound-idle-r2': boundIdle('R2 bucket (file storage)', ['A bucket must be empty before it can be deleted.']),
  'zombies:bound-idle-queues': boundIdle('queue', ['Messages still waiting in the queue are lost when you delete it.']),

  // ---- Pages
  'pages:deploy-failed': {
    what: 'The latest deploy of this Pages site failed.',
    why: 'Your changes are not live. The site keeps showing the last version that deployed fine.',
    steps: [
      'Open Workers & Pages › the project › Deployments, and click the failed deploy.',
      'Read the build log: the error is usually near the end (a failed install, a typo, a missing environment variable).',
      'Fix it and push again, or click Retry deployment.',
    ],
  },

  // ---- Security
  'security:member-change': {
    what: 'Someone was added to, changed in, or removed from your Cloudflare account in the last 7 days.',
    why: 'If you did not expect it, someone may have access to your account who should not.',
    steps: [
      'Open Manage Account › Members and check who is there and their role.',
      'If you do not recognise a change, remove the member, change your password and turn on two-factor login.',
      'When everything is as expected, acknowledge the finding.',
    ],
  },
  'security:token-created': {
    what: 'A new API token was created for your account in the last 7 days. API tokens let scripts and tools act on your account.',
    why: 'An unexpected token can be a sign that someone else has access.',
    steps: [
      'Open My Profile › API Tokens (and Manage Account › Account API Tokens) and find the new token.',
      'If you do not recognise it, roll or delete it.',
      'If it is yours, acknowledge the finding.',
    ],
  },
  'security:cert-expiring': {
    what: 'The HTTPS certificate for one of your domains expires soon and is not renewing on its own.',
    why: 'When it expires, browsers show a security warning and most visitors leave.',
    steps: [
      'Open your domain › SSL/TLS › Edge Certificates and look at the certificate\'s status.',
      'If it is a managed certificate, fix what blocks validation (often a DNS record or a CAA record).',
      'If it is a certificate you uploaded, upload a renewed one.',
    ],
  },
  'security:cert-failed': {
    what: 'An HTTPS certificate for your domain has expired or failed, and no other certificate covers those hostnames.',
    why: 'Visitors see a security error instead of your site.',
    steps: [
      'Open your domain › SSL/TLS › Edge Certificates.',
      'Check that the hostname is still proxied (orange cloud in DNS), and that no CAA record blocks the certificate authority.',
      'Order a new certificate if needed.',
    ],
  },
  'security:cert-pending': {
    what: 'A new HTTPS certificate is stuck: Cloudflare cannot confirm you own the domain.',
    why: 'Until it is issued, the hostnames it covers may show security errors.',
    steps: [
      'Open your domain › SSL/TLS › Edge Certificates and read the error shown.',
      'Usually you need to add a TXT record in DNS, or fix a CAA record that blocks the certificate authority.',
    ],
  },
  'security:dangling-pages': {
    what: 'A DNS record on your domain points at a pages.dev site that no longer exists in your account.',
    why: 'Anyone can create a Pages project with that free name and show their own content on your domain, for example a phishing page. This is called a subdomain takeover.',
    steps: [
      'Open your domain › DNS › Records and find the record shown in the finding.',
      'Delete it, or create the Pages project again in your own account.',
      'Do this soon: it is the most urgent item in this list.',
    ],
  },
  'security:dangling-workers-dev': {
    what: 'A DNS record on your domain points at a workers.dev address of a Worker that no longer exists.',
    why: 'Visitors to that hostname get an error.',
    steps: ['Open your domain › DNS › Records, find the record shown in the finding, and delete it or point it somewhere else.'],
  },

  // ---- Config drift
  'drift:binding-removed': {
    what: 'A binding, variable or secret that this Worker had before is gone since the last read.',
    why: 'Code that uses it now fails or behaves differently. The usual cause: a deploy replaced settings that had been added only in the dashboard.',
    steps: [
      `${DASH} Open Settings › Variables and Secrets (or Bindings) to see what it has now.`,
      'Add the missing item back. To keep it from disappearing again, put it in your Wrangler config (secrets with npx wrangler secret put NAME).',
      'If you removed it on purpose, acknowledge the finding.',
    ],
  },
  'drift:env-mismatch': {
    what: 'Your staging (or dev) Worker and your production Worker have different bindings or settings.',
    why: 'Code tested in staging may fail in production because something it needs is missing there.',
    steps: [
      'Compare the two Workers\' Settings › Variables and Secrets and Bindings.',
      'Make them match, ideally from one Wrangler config with an [env.staging] section.',
    ],
  },
  'drift:vars-near-limit': {
    what: 'This Worker has close to the maximum of 64 variables and secrets.',
    why: 'At 64, you cannot add another one.',
    steps: [
      'Combine related settings into one variable that holds JSON.',
      'Or move configuration that rarely changes into KV.',
    ],
  },

  // ---- Packages
  'packages:outdated': {
    what: 'Some of the npm packages this Worker\'s code uses have newer versions available. The Packages page lists each one as locked version → latest.',
    why: 'Old packages miss bug and security fixes. A major version behind usually means a bigger change, which is harder the longer you wait.',
    steps: [
      'In the project folder, run npm outdated to see the same list.',
      'Update small changes (patch and minor) with npm update, then test with npx wrangler dev.',
      'For a major version, read the package\'s changelog or migration guide first, update with npm install <package>@latest, and test.',
      'Commit the updated package-lock.json and deploy.',
    ],
  },
  'packages:lockfile-unreadable': {
    what: 'Ambersight could not read package-lock.json for this Worker from GitHub.',
    why: 'Without it, Ambersight cannot tell you which package versions you use.',
    steps: [
      'In Settings › Checks › Packages, check the repository (owner/name), the folder that holds package-lock.json, and the branch.',
      'Check that GITHUB_TOKEN has Contents: Read access to that repository.',
      'If the project uses pnpm or yarn, or an old npm (before version 7), the lockfile cannot be read yet.',
    ],
  },
};

for (const k of ['do', 'queues', 'd1', 'kv', 'r2']) {
  CHECK_HELP[`usage:idle-loop-${k}`] = idle(k);
  CHECK_HELP[`usage:ops-spike-${k}`] = opsSpike(k);
  CHECK_HELP[`usage:new-resource-burst-${k}`] = newBurst(k);
}

export const helpFor = (check: string): CheckHelp | null => CHECK_HELP[check] ?? null;
