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
  /** Optional scan queue (Queues, free plan: 10,000 operations a day): every due account scans at once. */
  SCAN_QUEUE?: Queue<ScanMessage>;
  /** Optional Workers AI binding, for the plain-language digest summary. */
  AI?: AiBinding;
  /** Optional Turnstile on the sign-in page: the site key (var) and secret (Worker secret). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

/** One unit of work on the scan queue. `step` counts continuations of the same account's scan. */
export interface ScanMessage {
  kind: 'scan' | 'continue';
  account: string;
  step?: number;
}

/** Workers AI binding, only the call Ambersight makes. */
export interface AiBinding {
  run(model: string, input: { messages: { role: 'system' | 'user'; content: string }[]; max_tokens?: number }): Promise<{ response?: string } | unknown>;
}
