// Outbound fetch allowlist: the Cloudflare API, the GitHub releases feed (update notice)
// and the host of the configured webhook. Nothing else is ever contacted.
// SPDX-License-Identifier: AGPL-3.0-only

const FIXED = ['api.cloudflare.com', 'api.github.com'];

export function allowedFetch(url: string, init: RequestInit, webhookUrl?: string): Promise<Response> {
  const host = new URL(url).hostname;
  const allowed = [...FIXED, ...(webhookUrl ? [new URL(webhookUrl).hostname] : [])];
  if (!allowed.includes(host) || !url.startsWith('https://')) {
    return Promise.reject(new Error(`Blocked outbound request to ${host}: not on the allowlist.`));
  }
  return fetch(url, init);
}
