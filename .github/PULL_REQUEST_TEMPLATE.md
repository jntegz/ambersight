## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] Read-only: no new write call to the Cloudflare API, and no Edit permission needed on the token.
- [ ] Free plan: a scan still stays under 50 subrequests, 50 D1 queries and about 10 ms of CPU.
- [ ] Nothing has to be added to the user's Workers (no SDK, no tail consumer).
- [ ] New or changed checks have tests in `test/`, and `docs/checks.md` is updated.
- [ ] `npm test && npm run typecheck` pass.
- [ ] Every commit is signed off (`git commit -s`).
