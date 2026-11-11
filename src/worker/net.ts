// Outbound fetch allowlist: the Cloudflare API, the GitHub API (update notice, and lockfiles for the
// optional Packages check), the host
// of the configured webhook, and the optional hosts below when their feature is switched on.
// Nothing else is ever contacted.
// SPDX-License-Identifier: AGPL-3.0-only

const FIXED = ['api.cloudflare.com', 'api.github.com'];

/** Hosts that only some features contact, and only when the user switched them on. */
export const OPTIONAL_HOSTS = { incidents: 'www.cloudflarestatus.com', turnstile: 'challenges.cloudflare.com', packages: 'registry.npmjs.org' } as const;

export function allowedFetch(url: string, init: RequestInit, webhookUrl?: string, extra: string[] = []): Promise<Response> {
  const host = new URL(url).hostname;
  const allowed = [...FIXED, ...(webhookUrl ? [new URL(webhookUrl).hostname] : []), ...extra];
  if (!allowed.includes(host) || !url.startsWith('https://')) {
    return Promise.reject(new Error(`Blocked outbound request to ${host}: not on the allowlist.`));
  }
  return fetch(url, init);
}
