# Contributing

Thanks for helping. A few rules keep Ambersight safe and free to run:

1. **Read-only, always.** No change may add a write call to the Cloudflare API or require a token with Edit permissions.
2. **Free plan first.** A scan run must stay under 50 subrequests, 50 D1 queries and about 10 ms of CPU. Add bulk writes through `json_each`, not one statement per row.
3. **No code in the user's Workers.** Ambersight reads; it never asks users to install an SDK or a tail consumer.
4. **Tests for checks.** Every new check in `src/worker/checks.ts` needs tests in `test/`.
5. Run `npm test && npm run typecheck` before opening a pull request.

## License and CLA

Contributions are accepted under the AGPL-3.0. Before your first pull request is merged you will be asked to sign a short Contributor License Agreement, so the maintainer can keep offering the project under other terms in the future (for example a hosted edition). You keep the copyright to your work.
