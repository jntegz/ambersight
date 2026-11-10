// SPDX-License-Identifier: AGPL-3.0-only

/** Cloudflare Email Service binding (send_email). Only the fields Ambersight uses. */
export interface EmailBinding {
  send(message: { to: string | string[]; from: string; subject: string; html?: string; text?: string }): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Read-only Cloudflare API token (Worker secret). */
  CF_API_TOKEN: string;
  /** Passphrase for the dashboard (Worker secret). */
  ADMIN_PASSPHRASE: string;
  /** Optional: pin the account when the token can see more than one. */
  CF_ACCOUNT_ID?: string;
  PLAN?: string;
  EMAIL_FROM?: string;
  DIGEST_TO?: string;
  EMAIL?: EmailBinding;
  /** Optional webhook for instant alerts (Worker secret): Slack, Discord, Telegram, ntfy or any JSON endpoint. */
  WEBHOOK_URL?: string;
}
