// Pre-filled "Create API token" link: opens the Cloudflare dashboard with Ambersight's
// read-only permissions already ticked. The user still reviews and creates the token.
// Format: https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
// SPDX-License-Identifier: AGPL-3.0-only

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
  // Optional checks: the Access coverage check, and the setup wizard proving the token has no write scopes.
  'access',
  'api_tokens',
] as const;

export const TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent(JSON.stringify(TOKEN_PERMISSION_KEYS.map((key) => ({ key, type: 'read' })))) +
  '&accountId=*&zoneId=all&name=' +
  encodeURIComponent('Ambersight read-only');
