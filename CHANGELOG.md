# Changelog

All notable changes to Ambersight. Each version here has a matching [GitHub release](https://github.com/jntegz/ambersight/releases), which is what the update notice in the dashboard reads.

## 0.1.0 (2026-11-09)

The first public release.

- **Fleet overview** with the free request budget, requests and errors today, and findings grouped by check and ranked by severity.
- **39 checks** across the free plan budget, runaway usage, storage and log costs, errors and limits, cron health, deprecations, exposure, and zombies and orphans. See [docs/checks.md](docs/checks.md).
- **Deploy timeline** that flags the deploy a new problem started after.
- **Alerts** by e-mail, Slack, Discord, Telegram, ntfy or any JSON webhook, with per-severity routing, quiet hours, and a daily or weekly digest, including one per group.
- **Groups, tags, scope rules and per-Worker thresholds**, with `config.json` export and import.
- **Setup wizard** that refuses a token with any write permission.
- **Self-cost panel** showing what Ambersight itself uses.
- **Security**: hashed sessions, `__Host-` cookies, origin checks, and a sign-in lockout per address and across addresses.
