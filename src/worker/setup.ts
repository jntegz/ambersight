// Setup wizard: verify the token, detect account and plan, refuse write scopes.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SetupStatus } from '../shared/types';
import { CfClient } from './cf';
import { getSettings } from './db';
import type { Env } from './env';
import { webhookKind } from './notify';

/** Permission groups that can change something. Names look like "Workers Scripts Write" or "... Edit". */
export function writeScopes(permissions: string[]): string[] {
  return permissions.filter((p) => /\b(write|edit|admin|delete|purge|revoke)\b/i.test(p));
}

/** `accountId` previews another account the token can see; CF_ACCOUNT_ID always wins. */
export async function setupStatus(env: Env, opts: { accountId?: string; behindAccess?: boolean } = {}): Promise<SetupStatus> {
  const settings = await getSettings(env.DB);
  const recipients = (env.DIGEST_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const base: SetupStatus = {
    tokenActive: false,
    tokenError: null,
    accountId: null,
    accountName: null,
    detectedPlan: null,
    writeScopes: null,
    readScopes: null,
    email: { configured: Boolean(env.EMAIL && env.EMAIL_FROM && recipients.length), from: env.EMAIL_FROM || null, to: recipients },
    webhook: { configured: Boolean(env.WEBHOOK_URL), kind: env.WEBHOOK_URL ? webhookKind(env.WEBHOOK_URL) : null },
    setupDone: settings.setup_done === '1',
    passphraseFromSettings: Boolean(settings.passphrase_hash),
    accounts: [],
    accountPinned: Boolean(env.CF_ACCOUNT_ID),
    behindAccess: opts.behindAccess ?? false,
  };
  if (!env.CF_API_TOKEN || env.CF_API_TOKEN.startsWith('paste-')) return { ...base, tokenError: 'CF_API_TOKEN is not set.' };
  try {
    const accounts = await CfClient.accounts(env.CF_API_TOKEN);
    const account = accounts.find((a) => a.id === (env.CF_ACCOUNT_ID || opts.accountId || settings.account_id)) ?? accounts[0];
    if (!account) return { ...base, tokenError: 'The token cannot see any account. Add Account Settings Read or set CF_ACCOUNT_ID.' };
    const cf = new CfClient(env.CF_API_TOKEN, account.id);
    const token = await cf.verifyToken();
    const perms = await cf.tokenPermissions(token.id, token.owner);
    return {
      ...base,
      tokenActive: token.status === 'active',
      tokenError: token.status === 'active' ? null : `The token is ${token.status}.`,
      accountId: account.id,
      accountName: account.name,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      detectedPlan: await cf.detectPlan(),
      writeScopes: perms ? writeScopes(perms) : null,
      readScopes: perms ? perms.filter((p) => !writeScopes([p]).length) : null,
    };
  } catch (e) {
    return { ...base, tokenError: (e as Error).message };
  }
}
