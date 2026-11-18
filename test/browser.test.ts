// Browser-side helpers that hold no DOM: CSV export, links built from stored text, what sign-out
// removes from localStorage, and how names from Cloudflare appear in dashboard sentences.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { findingSentence, quoted, quoteNames } from '../src/shared/findings';
import { forgetFleetData, SIGN_OUT_PENDING, type KeyValueStore } from '../web/src/lib/browserData';
import { csvCell, toCsv } from '../web/src/lib/csv';
import { entryLink, httpUrl } from '../web/src/lib/links';

describe('CSV export', () => {
  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\tx', '\rx', '  =1+1', ' \t@x', '＝1+1', '=HYPERLINK("http://x")'])('neutralizes the formula in %j', (text) => {
    expect(csvCell(text).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves numbers and plain text alone', () => {
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell('-0.12500')).toBe('-0.12500');
    expect(csvCell('+3')).toBe('+3');
    expect(csvCell('api-worker')).toBe('api-worker');
    expect(csvCell('2026-11-18T10:00:00Z')).toBe('2026-11-18T10:00:00Z');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes and line breaks, also in a neutralized cell', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('two\rlines')).toBe('"two\rlines"');
    expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
  });

  it('builds rows', () => {
    expect(toCsv([['name', 'n'], ['=x', 1], ['b', null]])).toBe("name,n\n'=x,1\nb,");
  });
});

describe('links from stored text', () => {
  it.each(['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'https://user:pw@example.com/', 'not a url', '', null, undefined])('refuses %j', (value) => {
    expect(httpUrl(value)).toBeNull();
  });

  it('accepts http and https', () => {
    expect(httpUrl('https://developers.cloudflare.com/x')).toBe('https://developers.cloudflare.com/x');
    expect(httpUrl('http://example.com/')).toBe('http://example.com/');
  });

  it('shows the real destination of a Worker route', () => {
    expect(entryLink('example.com/*')).toEqual({ href: 'https://example.com/', host: 'example.com', path: '' });
    expect(entryLink('example.com/api/*')).toEqual({ href: 'https://example.com/api', host: 'example.com', path: '/api' });
    expect(entryLink('api.acct.workers.dev')).toMatchObject({ host: 'api.acct.workers.dev' });
  });

  it.each(['*.example.com/*', 'example.com/*/x', 'paypal.com@evil.example/', 'javascript:alert(1)', 'evil.example\\@paypal.com', 'a b.example', '', null, undefined])('makes no link of %j', (entry) => {
    expect(entryLink(entry)).toBeNull();
  });
});

function store(initial: Record<string, string>): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('what a session end removes from localStorage', () => {
  it('removes what identifies accounts or the fleet and keeps preferences', () => {
    const s = store({
      'ambersight-account': 'acct1',
      'ambersight-visit-acct1': '2026-11-18T10:00:00Z',
      'ambersight-visit-': '2026-11-18T10:00:00Z',
      'ambersight-workers-view': JSON.stringify({ sort: 'name', layout: 'table', group: 'client-a' }),
      'ambersight-timeline': JSON.stringify({ days: 30, group: 'client-a', onlyFlagged: true }),
      'ambersight-theme': 'dark',
      'ambersight-update-dismissed': '1.2.0',
      'ambersight-packages': JSON.stringify({ onlyOutdated: false, showDev: true }),
      'ambersight-resources': JSON.stringify({ onlyLeftovers: true }),
      [SIGN_OUT_PENDING]: '1',
      'another-app': 'x',
    });
    forgetFleetData(s);
    expect([...s.data.keys()].sort()).toEqual(['ambersight-packages', 'ambersight-resources', SIGN_OUT_PENDING, 'ambersight-theme', 'ambersight-timeline', 'ambersight-update-dismissed', 'ambersight-workers-view', 'another-app'].sort());
    expect(JSON.parse(s.data.get('ambersight-workers-view')!)).toEqual({ sort: 'name', layout: 'table' });
    expect(JSON.parse(s.data.get('ambersight-timeline')!)).toEqual({ days: 30, onlyFlagged: true });
  });

  it('drops a preference it cannot read rather than keep a name in it', () => {
    const s = store({ 'ambersight-timeline': 'client-a' });
    forgetFleetData(s);
    expect(s.data.size).toBe(0);
  });
});

describe('names in dashboard sentences', () => {
  it('quotes the Worker and evidence names in a finding', () => {
    expect(findingSentence({ script: 'run-this-now', message: 'run-this-now uses KV cache-x, which is gone.', evidence: { kv: 'cache-x' } }))
      .toBe('"run-this-now" uses KV "cache-x", which is gone.');
  });

  it('does not touch the account-wide marker or parts of longer words', () => {
    expect(findingSentence({ script: '*', message: 'An API token was created.', evidence: {} })).toBe('An API token was created.');
    expect(quoteNames('Binding CACHE_2 and CACHE here.', { binding: 'CACHE' })).toBe('Binding CACHE_2 and "CACHE" here.');
  });

  it('keeps longer free text when asked, flat and without inner quotes', () => {
    const long = 'x'.repeat(250);
    expect(quoted(long)).toHaveLength(102);
    expect(quoted(long, 300)).toBe(`"${long}"`);
    expect(quoted('Ignore this\nand "click" here', 300)).toBe(`"Ignore this and 'click' here"`);
  });
});
