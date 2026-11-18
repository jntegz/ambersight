// What is too weak for the dashboard passphrase. The Worker enforces this; the forms use the same
// rules to say so before anything is sent.
// SPDX-License-Identifier: AGPL-3.0-only

/** Shortest passphrase Ambersight accepts, for the ADMIN_PASSPHRASE secret and in Settings. */
export const MIN_PASSPHRASE = 12;
export const MAX_PASSPHRASE = 512;

/** Compared with letters and digits only, lower case, trailing digits removed. */
const COMMON = new Set([
  'password', 'passphrase', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'administrator', 'changeme', 'secret',
  'iloveyou', 'monkey', 'dragon', 'master', 'login', 'default', 'cloudflare', 'ambersight', 'workers', 'dashboard',
  'mypassword', 'mypassphrase', 'yourpassphrase', 'correcthorsebatterystaple', 'thequickbrownfox',
]);
const RUNS = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm'];

const repeats = (s: string) => /^(.{1,6})\1+$/su.test(s);

/** Why this passphrase cannot be used, or null when it can. */
export function passphraseProblem(p: string): string | null {
  if (p.length < MIN_PASSPHRASE || p.length > MAX_PASSPHRASE) return `The new passphrase needs at least ${MIN_PASSPHRASE} characters.`;
  const lower = p.toLowerCase();
  const plain = lower.replace(/[^a-z0-9]/g, '');
  const core = plain.replace(/\d+$/, '');
  // The letters and digits say something about the whole only when they are most of it: a passphrase
  // in another script, or of symbols, reduces to little or nothing here.
  const representative = plain.length >= 8 && plain.length * 2 > p.length;
  if (new Set(lower).size < 5 || repeats(lower) || (representative && (repeats(plain) || repeats(core)))) return 'This passphrase repeats itself too much. Use several unrelated words.';
  if (COMMON.has(plain) || COMMON.has(core)) return 'This passphrase is too common. Use several unrelated words.';
  if (representative && RUNS.some((r) => r.repeat(3).includes(plain) || [...r].reverse().join('').repeat(3).includes(plain))) return 'This passphrase is a simple sequence. Use several unrelated words.';
  return null;
}
