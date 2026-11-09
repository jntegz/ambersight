# Security

Ambersight is built so that the worst outcome of a stolen token is "someone can read Worker metadata and metrics", never "someone can change or delete Workers".

- The API token must be **read-only**. Ambersight only sends GET requests and GraphQL queries to `api.cloudflare.com`.
- The token and the dashboard passphrase are Worker secrets. They are never sent to the browser, logged or stored in D1.
- The dashboard requires a session; sessions are random 256-bit ids stored in D1, cookies are `HttpOnly; Secure; SameSite=Strict`.
- Five wrong passphrases lock sign-in for 15 minutes.
- No third-party scripts, fonts or analytics are loaded; the page sets a strict Content-Security-Policy.
- E-mail recipients come only from configuration; no endpoint accepts an address.
- Ambersight sends no telemetry to its maintainers.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's **Report a vulnerability** (private advisory) on this repository. We aim to reply within 7 days.
