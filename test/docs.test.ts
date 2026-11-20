// SPDX-License-Identifier: AGPL-3.0-only
// Keeps the check count in the README and docs/checks.md in step with the checks they document.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECK_TITLES } from '../src/shared/findings';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Every check ID in the first column of docs/checks.md; "`a:b-do`, `-kv`" expands to a:b-do and a:b-kv. */
function documentedIds(md: string): Set<string> {
  const ids = new Set<string>();
  for (const line of md.split('\n')) {
    if (!line.startsWith('| `')) continue;
    let base = '';
    for (const [, id] of line.split('|')[1].matchAll(/`([^`]+)`/g)) {
      if (id.startsWith('-') && base) ids.add(base.slice(0, base.lastIndexOf('-')) + id);
      else ids.add((base = id));
    }
  }
  return ids;
}

describe('docs', () => {
  const ids = documentedIds(read('docs/checks.md'));

  it('documents every check that has a title in the dashboard', () => {
    expect(Object.keys(CHECK_TITLES).filter((id) => !ids.has(id))).toEqual([]);
    for (const id of ids) expect(id).toMatch(/^[a-z]+:[a-z0-9-]+$/);
  });

  it('states the number of documented checks', () => {
    const counts = (text: string) => [...text.matchAll(/\b(?:runs|all) (\d+) checks\b/g)].map((m) => Number(m[1]));
    expect(counts(read('docs/checks.md'))).toEqual([ids.size]);
    expect(counts(read('README.md'))).toEqual([ids.size, ids.size]);
  });
});
