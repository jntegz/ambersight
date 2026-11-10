# Security

Ambersight is built so that the worst outcome of a stolen token is "someone can read Worker metadata and metrics", never "someone can change or delete Workers".

- The API token must be **read-only**. Ambersight only sends GET requests and GraphQL queries to `api.cloudflare.com`.
- The token and the dashboard passphrase are Worker secrets. They are never sent to the browser or logged. If you change the passphrase in Settings, only a PBKDF2 hash of it is stored in D1.
- The dashboard requires a session. Sessions are random 256-bit ids; D1 stores only their SHA-256 digest, so a copy of the database contains no working cookies. The cookie is `__Host-` prefixed, `HttpOnly; Secure; SameSite=Strict`.
- Sessions are tied to the credential that issued them: changing the passphrase, rotating the `ADMIN_PASSPHRASE` secret or deleting the stored hash signs every session out.
- API requests that change something must come from the dashboard's own origin (Origin / Sec-Fetch-Site check), so other Workers on the same `workers.dev` subdomain cannot send them with your cookie.
- Five wrong passphrases from one IP address lock that address out for 15 minutes; 50 from any mix of addresses pause sign-in for everyone for 15 minutes. Attempts are counted atomically, and the same limits apply to the current-passphrase check when changing it.
- The `ADMIN_PASSPHRASE` secret must be at least 12 characters, or sign-in stays off.
- No third-party scripts, fonts or analytics are loaded; the page sets a Content-Security-Policy. Put Cloudflare Access in front for a second layer (see the README), and if you use a custom domain set `"workers_dev": false` in `wrangler.jsonc`.
- Names that other people in your account choose (Workers, KV namespaces, routes) are escaped in the dashboard, e-mail and chat alerts.
- E-mail recipients come only from configuration; no endpoint accepts an address.
- Ambersight sends no telemetry to its maintainers.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's **Report a vulnerability** (private advisory) on this repository. We aim to reply within 7 days.
