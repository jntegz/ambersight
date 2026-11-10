// SPDX-License-Identifier: AGPL-3.0-only
/** Keep in sync with package.json. Shown in the UI and compared with the latest GitHub release. */
export const VERSION = '0.1.0';
export const REPO = 'jntegz/ambersight';

/** True if `latest` (e.g. "v0.2.0") is a newer semver than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
