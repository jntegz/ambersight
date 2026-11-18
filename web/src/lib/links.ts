// Links built from stored or Cloudflare-derived text. Svelte escapes an href but does not check its
// scheme, so a value only becomes a link here.
// SPDX-License-Identifier: AGPL-3.0-only

/** The URL if it is http(s) and carries no credentials; otherwise null. */
export function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Host, optional port, optional path: nothing that could make the link go somewhere else. */
const ROUTE = /^[a-z0-9.-]+(:\d+)?(\/[^\s\\]*)?$/i;

/**
 * Where a Worker's route or domain leads. Patterns like "example.com/api/*" link to their base;
 * host wildcards are not linkable. The host is returned apart, so the card can always show it.
 */
export function entryLink(entry: string | null | undefined): { href: string; host: string; path: string } | null {
  const base = entry?.replace(/\/\*$/, '');
  if (!base || base.includes('*') || !ROUTE.test(base)) return null;
  const href = httpUrl(`https://${base}`);
  if (!href) return null;
  const url = new URL(href);
  return { href, host: url.host, path: url.pathname === '/' ? '' : url.pathname + url.search };
}
