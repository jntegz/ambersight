// Pre-filled "Create API token" link: opens the Cloudflare dashboard with Ambersight's
// read-only permissions already ticked. The user still reviews and creates the token.
// Format: https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
// SPDX-License-Identifier: AGPL-3.0-only

/** What the features that are on by default read. The same list is in the link in package.json and the README. */
export const TOKEN_PERMISSION_KEYS = [
  'workers_scripts',
  'account_analytics',
  'account_settings',
  'workers_kv_storage',
  'd1',
  'workers_r2',
  'queues',
  'zone',
  'workers_routes',
  'billing',
  // Pages projects, certificates and DNS records (keys from the cloudflare-docs token template reference).
  'page',
  'ssl_and_certificates',
  'dns',
  // Lets the setup wizard and the daily recheck read this token's own permissions.
  'api_tokens',
] as const;

export const TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent(JSON.stringify(TOKEN_PERMISSION_KEYS.map((key) => ({ key, type: 'read' })))) +
  '&accountId=*&zoneId=all&name=' +
  encodeURIComponent('Ambersight read-only');

/**
 * Every permission Ambersight has a use for, by the name Cloudflare reports. Three are not in the link
 * because the features that use them are optional: Access (the Access coverage check, off by
 * default), Notifications (it has no key for the link) and Workers CI (the repository a Worker is
 * built from, for the Packages check; no documented key). A name not listed here is unexpected,
 * whatever it is called: this is a list of what is allowed, not a guess at what looks dangerous.
 */
export const EXPECTED_TOKEN_PERMISSIONS = [
  'Workers Scripts Read',
  'Account Analytics Read',
  'Account Settings Read',
  'Workers KV Storage Read',
  'D1 Read',
  'Workers R2 Storage Read',
  'Queues Read',
  'Zone Read',
  'Workers Routes Read',
  'Billing Read',
  'Pages Read',
  'Cloudflare Pages Read',
  'SSL and Certificates Read',
  'DNS Read',
  'API Tokens Read',
  'Account API Tokens Read',
  'Access: Apps and Policies Read',
  'Notifications Read',
  'Workers CI Read',
] as const;

const EXPECTED = new Set(EXPECTED_TOKEN_PERMISSIONS.map((p) => p.toLowerCase()));

/** The granted permissions that are not on the expected list, once each. */
export function unexpectedPermissions(granted: string[]): string[] {
  return [...new Set(granted.filter((p) => !EXPECTED.has(p.trim().toLowerCase())))];
}
