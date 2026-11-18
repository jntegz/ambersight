// Wildcard patterns: the matcher means exactly what the old regular expression meant, and a pattern
// from a saved or imported config cannot make it slow.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { defaultConfig, groupsFor, inScope, matchPattern } from '../src/shared/config';
import { messageText } from '../src/worker/notify';

/** What matchPattern did before: the reference for "same meaning". Only ever given short inputs here. */
function viaRegExp(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
}

/** A small repeatable generator, so a failure can be reproduced. */
function random(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1_103_515_245 + 12_345) & 0x7fffffff;
    return (s >> 8) % n;
  };
}

describe('matchPattern', () => {
  it('keeps the documented cases', () => {
    expect(matchPattern('*-staging', 'api-staging')).toBe(true);
    expect(matchPattern('api-*', 'api-')).toBe(true);
    expect(matchPattern('api-*', 'api')).toBe(false);
    expect(matchPattern('a*a', 'a')).toBe(false);
    expect(matchPattern('a*a', 'aa')).toBe(true);
    expect(matchPattern('*', '')).toBe(true);
    expect(matchPattern('**', 'anything')).toBe(true);
    expect(matchPattern('api.v1', 'apixv1')).toBe(false);
    expect(matchPattern('api.*', 'apixv1')).toBe(false);
    expect(matchPattern('API-*', 'api-1')).toBe(false);
    expect(matchPattern('a*b*c', 'a-c-b-c')).toBe(true);
    expect(matchPattern('a*b*c', 'a-c-b')).toBe(false);
  });

  it('treats regular expression characters as themselves', () => {
    for (const [p, n] of [['a+*', 'a+b'], ['(x)*', '(x)y'], ['[a]*', '[a]b'], ['a|b*', 'a|bc'], ['$*^', '$-^'], ['a\\*', 'a\\z'], ['{1}*', '{1}']]) {
      expect(matchPattern(p, n), p).toBe(true);
      expect(viaRegExp(p, n), p).toBe(true);
    }
    expect(matchPattern('a+*', 'aab')).toBe(false);
  });

  it('does not let a wildcard cross a line break, as the regular expression did not', () => {
    for (const br of ['\n', '\r', ' ', ' ']) {
      expect(matchPattern('a*b', `a${br}b`)).toBe(false);
      expect(matchPattern(`a*${br}*b`, `ax${br}yb`)).toBe(true);
      expect(matchPattern('*', br)).toBe(false);
    }
  });

  it('agrees with the regular expression on many generated patterns and names', () => {
    const next = random(20261118);
    const alphabet = ['a', 'a', 'b', 'b', '*', '*', '*', '.', '-', '$', '[', '\\', '\n', '\r', ' ', 'é', '\ud83d', '\ude00'];
    const text = (max: number, chars: string[]) => Array.from({ length: next(max) }, () => chars[next(chars.length)]).join('');
    let matches = 0;
    for (let i = 0; i < 30_000; i++) {
      const pattern = text(9, alphabet);
      // Half the names are built from the pattern, so that plenty of them match.
      const name = next(2) ? pattern.split('*').join(text(3, alphabet.filter((c) => c !== '*'))) : text(10, alphabet.filter((c) => c !== '*'));
      const want = viaRegExp(pattern, name);
      matches += want ? 1 : 0;
      expect(matchPattern(pattern, name), JSON.stringify([pattern, name])).toBe(want);
    }
    expect(matches).toBeGreaterThan(1000);
  });

  it('stays fast on patterns that make a backtracking matcher run away', () => {
    const name = 'a'.repeat(200);
    const cases = ['*a'.repeat(49) + '*b', 'a*'.repeat(50) + 'b', '*'.repeat(99) + 'b', `${'*aa'.repeat(33)}*!`];
    const started = performance.now();
    for (let i = 0; i < 2000; i++) for (const p of cases) expect(matchPattern(p, name)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('is what scope and group checks use', () => {
    const c = defaultConfig();
    c.groups = { slow: ['*a'.repeat(49) + '*b'] };
    c.scope.exclude = ['*a'.repeat(49) + '*b', 'tmp-*'];
    const name = 'a'.repeat(120);
    expect(groupsFor(c, name)).toEqual([]);
    expect(inScope(c, name, [])).toBe(true);
    expect(inScope(c, 'tmp-1', [])).toBe(false);
  });
});

describe('the other regular expression built from stored text', () => {
  it('quotes names in a finding message without slowing down on repetitive names', () => {
    // messageText builds an alternation of escaped literals: no nested repetition to backtrack.
    const names = Array.from({ length: 12 }, (_, i) => `${'a'.repeat(190)}${i}`);
    const message = 'a'.repeat(5000);
    const started = performance.now();
    expect(messageText({ message, evidence: JSON.stringify({ hosts: names.join(', ') }) })).toBe(message);
    expect(performance.now() - started).toBeLessThan(500);
    expect(messageText({ message: 'Route a.b+c is stale', evidence: JSON.stringify({ route: 'a.b+c' }) })).toContain('"a.b+c"');
  });
});
