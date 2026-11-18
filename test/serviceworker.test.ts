// The service worker, loaded from web/public/sw.js with small fakes for the Cache API: what is kept
// offline, for how long, and what ends it. Real browser behaviour is not exercised here.
// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_ONLY_EVIDENCE } from '../src/shared/findings';

const SOURCE = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://ambersight.example';
const SHELL_HTML = '<!doctype html><div id="app"></div><script type="module" src="/assets/index-abc.js"></script>';
/** Looks like the shell, loads something else: storing it would show, and would prune the real assets. */
const LOOKALIKE = '<!doctype html><div id="app"></div><script type="module" src="/assets/other.js"></script>';
/** As the build writes it: a script and a stylesheet. */
const FULL_SHELL_HTML = '<!doctype html><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="/assets/index-abc.css"><div id="app"></div>';
const DAY = 86_400_000;
const API = 'ambersight-api-v3';
const SHELL = 'ambersight-shell-v3';

type Key = string | { url: string };
const urlOf = (k: Key) => new URL(typeof k === 'string' ? k : k.url, ORIGIN).href;

class FakeCache {
  entries = new Map<string, Response>();
  /** Runs while a put is under way, to test what happens in that moment. */
  duringPut: (() => Promise<void>) | null = null;
  async match(k: Key) { return this.entries.get(urlOf(k))?.clone(); }
  async put(k: Key, res: Response) {
    const hook = this.duringPut;
    this.duringPut = null;
    await hook?.();
    this.entries.set(urlOf(k), res.clone());
  }
  async delete(k: Key) { return this.entries.delete(urlOf(k)); }
  async keys() { return [...this.entries.keys()].map((url) => ({ url })); }
  async addAll(list: string[]) { for (const k of list) this.entries.set(urlOf(k), new Response('static')); }
}

class FakeCaches {
  stores = new Map<string, FakeCache>();
  /** Runs once, just before the API cache is next opened. */
  beforeApiOpen: (() => Promise<unknown>) | null = null;
  async open(name: string) {
    if (name === API) {
      const hook = this.beforeApiOpen;
      this.beforeApiOpen = null;
      await hook?.();
    }
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name: string) { return this.stores.delete(name); }
}

/** A response as fetch gives it for this origin: `type` cannot be set through the constructor. */
function own(body: string, init: ResponseInit & { type?: string; redirected?: boolean } = {}) {
  const { type = 'basic', redirected = false, ...rest } = init;
  const res = new Response(body, rest);
  Object.defineProperty(res, 'type', { value: type });
  Object.defineProperty(res, 'redirected', { value: redirected });
  return res;
}
const json = (value: unknown, status = 200) => own(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
const html = (body = SHELL_HTML) => own(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

type Listener = (e: Record<string, unknown>) => void;

/** One start of the worker. Calling it again over the same caches is a worker that was stopped. */
function boot(caches: FakeCaches, network: (req: Key) => Promise<Response>) {
  const listeners: Record<string, Listener> = {};
  const self = {
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  new Function('self', 'caches', 'fetch', 'location', SOURCE)(self, caches, network, { origin: ORIGIN });

  async function dispatch(type: string, extra: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners[type]({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => { response = p; } });
    const res = await response;
    // Work may add more work while it runs.
    for (let i = 0; i < waits.length; i++) await waits[i];
    return res;
  }
  return {
    get: (path: string, mode = 'cors') => dispatch('fetch', { request: { url: new URL(path, ORIGIN).href, method: 'GET', mode } }),
    send: (data: unknown) => dispatch('message', { data }),
    install: () => dispatch('install', {}),
    activate: () => dispatch('activate', {}),
  };
}

const copies = (c: FakeCaches) => [...(c.stores.get(API)?.entries.keys() ?? [])].map((u) => new URL(u).pathname + new URL(u).search);
const shellPage = (c: FakeCaches) => c.stores.get(SHELL)?.entries.get(`${ORIGIN}/`)?.clone().text();
const offline = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };
const cachedAssets = (c: FakeCaches) => [...(c.stores.get(SHELL)?.entries.keys() ?? [])].map((u) => new URL(u).pathname).filter((p) => p.startsWith('/assets/')).sort();
/** The deployed site: the page, and its assets unless `broken` says how one of them fails. */
const site = (page = FULL_SHELL_HTML, broken: Record<string, () => Promise<Response>> = {}) => async (req: Key) => {
  const path = new URL(urlOf(req)).pathname;
  if (broken[path]) return broken[path]();
  return path === '/' ? html(page) : own(`file ${path}`, { headers: { 'Content-Type': 'text/plain' } });
};

afterEach(() => vi.restoreAllMocks());

describe('what is kept for offline use', () => {
  it('keeps the listed views and serves them when the network is gone', async () => {
    const caches = new FakeCaches();
    await boot(caches, async () => json({ workers: 3 })).get('/api/overview?account=a');
    expect(copies(caches)).toEqual(['/api/overview?account=a']);
    const res = await boot(caches, offline).get('/api/overview?account=a');
    expect(res!.headers.get('X-Ambersight-Offline')).toBe('1');
    expect(await res!.json()).toEqual({ workers: 3 });
  });

  it('never keeps views that name people, public routes or settings', async () => {
    const caches = new FakeCaches();
    const sw = boot(caches, async () => json({ author: 'someone@example.com' }));
    for (const path of ['/api/timeline?days=14', '/api/workers/api?range=7d', '/api/admin-events', '/api/health', '/api/config', '/api/tokens', '/api/setup', '/api/changes?since=x', '/api/findings/f1/history']) await sw.get(path);
    expect(copies(caches)).toEqual([]);
  });

  it('removes evidence naming a person from the stored copy, and only from it', async () => {
    const caches = new FakeCaches();
    const view = { findings: [{ id: 'f', evidence: { actor: 'a@example.com', member: 'm@example.com', changedBy: 'c@example.com', at: 'now' } }] };
    const live = await boot(caches, async () => json(view)).get('/api/overview');
    expect(((await live!.json()) as typeof view).findings[0].evidence.actor).toBe('a@example.com');
    const stored = await (await boot(caches, offline).get('/api/overview'))!.text();
    expect(stored).not.toContain('example.com');
    expect(JSON.parse(stored).findings[0].evidence).toEqual({ at: 'now' });
  });

  it('strips exactly the evidence the dashboard treats as naming a person', () => {
    const list = /PERSON_EVIDENCE = \[([^\]]*)\]/.exec(SOURCE)![1].match(/'[^']+'/g)!.map((s) => s.slice(1, -1));
    expect(new Set(list)).toEqual(DASHBOARD_ONLY_EVIDENCE);
  });

  it('keeps no error, redirected or non-JSON answer', async () => {
    const caches = new FakeCaches();
    await boot(caches, async () => json({ error: 'x' }, 500)).get('/api/overview');
    await boot(caches, async () => own('{}', { headers: { 'Content-Type': 'application/json' }, redirected: true })).get('/api/overview');
    await boot(caches, async () => html()).get('/api/overview');
    expect(copies(caches)).toEqual([]);
  });

  it('keeps at most 60 copies, dropping the oldest', async () => {
    const caches = new FakeCaches();
    const sw = boot(caches, async () => json({}));
    for (let i = 0; i < 62; i++) await sw.get(`/api/overview?account=a${i}`);
    const kept = copies(caches);
    expect(kept).toHaveLength(60);
    expect(kept[0]).toBe('/api/overview?account=a2');
  });
});

describe('the default overview, asked for by account id', () => {
  /** What a sign-in leaves: the overview stored without an account in its URL. */
  async function signedInTo(id: string) {
    const caches = new FakeCaches();
    await boot(caches, async () => json({ account: { id }, workers: 1 })).get('/api/overview');
    return caches;
  }

  it('answers for the account it shows', async () => {
    const caches = await signedInTo('a');
    const res = await boot(caches, offline).get('/api/overview?account=a');
    expect(res!.headers.get('X-Ambersight-Offline')).toBe('1');
    expect(await res!.json()).toEqual({ account: { id: 'a' }, workers: 1 });
  });

  it('never answers for another account', async () => {
    const caches = await signedInTo('a');
    expect((await boot(caches, offline).get('/api/overview?account=b'))!.type).toBe('error');
  });

  it('does not answer without an account id in the copy', async () => {
    const caches = new FakeCaches();
    await boot(caches, async () => json({ account: null })).get('/api/overview');
    expect((await boot(caches, offline).get('/api/overview?account=a'))!.type).toBe('error');
  });

  it("gives way to the account's own copy", async () => {
    const caches = await signedInTo('a');
    await boot(caches, async () => json({ account: { id: 'a' }, workers: 2 })).get('/api/overview?account=a');
    expect(await (await boot(caches, offline).get('/api/overview?account=a'))!.json()).toEqual({ account: { id: 'a' }, workers: 2 });
  });

  it('stands in for an expired copy of the account, and expires itself', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000 * DAY);
    const caches = new FakeCaches();
    await boot(caches, async () => json({ account: { id: 'a' }, workers: 2 })).get('/api/overview?account=a');
    now.mockReturnValue(1_005 * DAY);
    await boot(caches, async () => json({ account: { id: 'a' }, workers: 3 })).get('/api/overview');
    now.mockReturnValue(1_008 * DAY);
    const sw = boot(caches, offline);
    expect(await (await sw.get('/api/overview?account=a'))!.json()).toEqual({ account: { id: 'a' }, workers: 3 });
    now.mockReturnValue(1_013 * DAY);
    expect((await sw.get('/api/overview?account=a'))!.type).toBe('error');
    expect(copies(caches)).toEqual([]);
  });

  it('covers only the overview', async () => {
    const caches = new FakeCaches();
    await boot(caches, async () => json({ account: { id: 'a' } })).get('/api/resources');
    expect((await boot(caches, offline).get('/api/resources?account=a'))!.type).toBe('error');
  });

  it('is gone with the other copies at sign-out', async () => {
    const caches = await signedInTo('a');
    const sw = boot(caches, offline);
    await sw.send('clear');
    expect((await sw.get('/api/overview?account=a'))!.type).toBe('error');
  });
});

describe('the end of a session', () => {
  async function withCopy() {
    const caches = new FakeCaches();
    await boot(caches, async () => json({ workers: 1 })).get('/api/overview');
    expect(copies(caches)).toHaveLength(1);
    return caches;
  }

  it('a 401 from any API read clears the copies, also on a route that is never kept', async () => {
    for (const path of ['/api/overview', '/api/config']) {
      const caches = await withCopy();
      await boot(caches, async () => json({ error: 'Not signed in.' }, 401)).get(path);
      expect(copies(caches)).toEqual([]);
    }
  });

  it('/api/session saying signed out clears them; saying signed in does not', async () => {
    const caches = await withCopy();
    await boot(caches, async () => json({ authenticated: true })).get('/api/session');
    expect(copies(caches)).toHaveLength(1);
    await boot(caches, async () => json({ authenticated: false })).get('/api/session');
    expect(copies(caches)).toEqual([]);
  });

  it('a link to /api/* from elsewhere, answered 401 for lack of the cookie, clears nothing', async () => {
    const caches = await withCopy();
    const res = await boot(caches, async () => json({}, 401)).get('/api/overview', 'navigate');
    expect(res).toBeUndefined(); // left to the browser
    expect(copies(caches)).toHaveLength(1);
  });

  it('the clear message empties the copies and leaves the shell', async () => {
    const caches = await withCopy();
    await boot(caches, async () => html()).get('/', 'navigate');
    const sw = boot(caches, offline);
    await sw.send('clear');
    expect(copies(caches)).toEqual([]);
    expect(await shellPage(caches)).toBe(SHELL_HTML);
    expect((await sw.get('/api/overview'))!.type).toBe('error');
  });

  it('an answer still on its way when the copies are cleared is not stored', async () => {
    const caches = new FakeCaches();
    let answer!: (r: Response) => void;
    const sw = boot(caches, () => new Promise((resolve) => { answer = resolve; }));
    const pending = sw.get('/api/overview');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await sw.send('clear');
    answer(json({ workers: 1 }));
    await pending;
    expect(caches.stores.has(API)).toBe(false); // not even written and removed again
  });

  it('a clear that lands while a copy is being written still wins', async () => {
    const caches = new FakeCaches();
    const sw = boot(caches, async () => json({ workers: 1 }));
    // After the first check has passed: the write then recreates the cache that was just deleted.
    caches.beforeApiOpen = () => sw.send('clear');
    await sw.get('/api/overview');
    expect(caches.stores.has(API)).toBe(true);
    expect(copies(caches)).toEqual([]);
  });

  it('a clear that lands during the write itself also wins', async () => {
    const caches = new FakeCaches();
    const sw = boot(caches, async () => json({ workers: 1 }));
    const cache = await caches.open(API);
    cache.duringPut = async () => { await sw.send('clear'); caches.stores.set(API, cache); };
    await sw.get('/api/overview');
    expect(copies(caches)).toEqual([]);
  });

  it('the generation survives the worker being stopped', async () => {
    const caches = new FakeCaches();
    let answer!: (r: Response) => void;
    const before = boot(caches, () => new Promise((resolve) => { answer = resolve; }));
    const pending = before.get('/api/overview');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    // A fresh instance handles the sign-out; the earlier one finishes its request afterwards.
    await boot(caches, offline).send('clear');
    answer(json({ workers: 1 }));
    await pending;
    expect(copies(caches)).toEqual([]);
  });

  it('after clearing, a new sign-in can store copies again', async () => {
    const caches = await withCopy();
    const sw = boot(caches, async () => json({ workers: 2 }));
    await sw.send('clear');
    await sw.get('/api/overview');
    expect(copies(caches)).toEqual(['/api/overview']);
  });
});

describe('offline copies expire', () => {
  it('serves a copy for 7 days, then refuses and removes it', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000 * DAY);
    const caches = new FakeCaches();
    await boot(caches, async () => json({ workers: 1 })).get('/api/overview');
    const sw = boot(caches, offline);
    now.mockReturnValue(1_007 * DAY);
    expect((await sw.get('/api/overview'))!.status).toBe(200);
    now.mockReturnValue(1_007 * DAY + 1);
    expect((await sw.get('/api/overview'))!.type).toBe('error');
    expect(copies(caches)).toEqual([]);
  });

  it('treats a copy with no valid date as expired', async () => {
    const caches = new FakeCaches();
    (await caches.open(API)).entries.set(`${ORIGIN}/api/overview`, new Response('{}'));
    expect((await boot(caches, offline).get('/api/overview'))!.type).toBe('error');
    expect(copies(caches)).toEqual([]);
  });

  it('opening the app offline removes every expired copy, not only the one asked for', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000 * DAY);
    const caches = new FakeCaches();
    const online = boot(caches, async () => json({}));
    await online.get('/api/overview');
    await online.get('/api/resources');
    await boot(caches, async () => html()).get('/', 'navigate');
    now.mockReturnValue(1_008 * DAY);
    const res = await boot(caches, offline).get('/', 'navigate');
    expect(await res!.text()).toBe(SHELL_HTML);
    expect(copies(caches)).toEqual([]);
  });

  it('a signed-in check and an activation sweep expired copies too', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000 * DAY);
    for (const run of [
      (c: FakeCaches) => boot(c, async () => json({ authenticated: true })).get('/api/session'),
      (c: FakeCaches) => boot(c, offline).activate(),
    ]) {
      now.mockReturnValue(1_000 * DAY);
      const caches = new FakeCaches();
      await boot(caches, async () => json({})).get('/api/overview');
      now.mockReturnValue(1_008 * DAY);
      await run(caches);
      expect(copies(caches)).toEqual([]);
    }
  });
});

describe('the application shell', () => {
  it('keeps the real page and answers navigations with it offline', async () => {
    const caches = new FakeCaches();
    await boot(caches, async () => html()).get('/some/page', 'navigate');
    expect(await shellPage(caches)).toBe(SHELL_HTML);
    const res = await boot(caches, offline).get('/settings', 'navigate');
    expect(res!.headers.get('X-Ambersight-Offline')).toBe('1');
    expect(await res!.text()).toBe(SHELL_HTML);
  });

  it('a navigation to /api/* neither replaces the shell nor prunes assets', async () => {
    const caches = new FakeCaches();
    const sw = boot(caches, async () => html());
    await sw.get('/', 'navigate');
    (await caches.open(SHELL)).entries.set(`${ORIGIN}/assets/index-abc.js`, new Response('js'));
    const link = boot(caches, async () => json({ ok: true }));
    expect(await link.get('/api/health', 'navigate')).toBeUndefined();
    expect(await shellPage(caches)).toBe(SHELL_HTML);
    expect(caches.stores.get(SHELL)!.entries.has(`${ORIGIN}/assets/index-abc.js`)).toBe(true);
  });

  it.each([
    ['JSON', () => json({ ok: true })],
    ['an error page', () => own(LOOKALIKE, { status: 500, headers: { 'Content-Type': 'text/html' } })],
    ['a redirected page', () => own(LOOKALIKE, { headers: { 'Content-Type': 'text/html' }, redirected: true })],
    ['another origin', () => own(LOOKALIKE, { headers: { 'Content-Type': 'text/html' }, type: 'cors' })],
    ['HTML that is not the app', () => html('<!doctype html><h1>Sign in to continue</h1>')],
  ])('%s is not stored as the shell and prunes nothing', async (_label, answer) => {
    const caches = new FakeCaches();
    await boot(caches, async () => html()).get('/', 'navigate');
    (await caches.open(SHELL)).entries.set(`${ORIGIN}/assets/index-abc.js`, new Response('js'));
    await boot(caches, async () => answer()).get('/', 'navigate');
    expect(await shellPage(caches)).toBe(SHELL_HTML);
    expect(caches.stores.get(SHELL)!.entries.has(`${ORIGIN}/assets/index-abc.js`)).toBe(true);
  });

  it('a new shell forgets the assets it no longer loads, keeping the font', async () => {
    const caches = new FakeCaches();
    const shell = await caches.open(SHELL);
    shell.entries.set(`${ORIGIN}/assets/index-old.js`, new Response('old'));
    shell.entries.set(`${ORIGIN}/assets/index-abc.js`, new Response('new'));
    shell.entries.set(`${ORIGIN}/assets/inter-latin.woff2`, new Response('font'));
    await boot(caches, async () => html()).get('/', 'navigate');
    expect([...shell.entries.keys()].filter((k) => k.includes('/assets/')).map((k) => k.slice(ORIGIN.length))).toEqual(['/assets/index-abc.js', '/assets/inter-latin.woff2']);
  });

  it('does not keep the HTML that an unknown asset path answers with', async () => {
    const caches = new FakeCaches();
    await boot(caches, async () => html()).get('/assets/gone.js');
    expect(caches.stores.get(SHELL)?.entries.has(`${ORIGIN}/assets/gone.js`) ?? false).toBe(false);
  });

  it('install refuses a page that is not the shell', async () => {
    await expect(boot(new FakeCaches(), async () => html('<h1>Maintenance</h1>')).install()).rejects.toThrow();
    const caches = new FakeCaches();
    await boot(caches, site(SHELL_HTML)).install();
    expect(await shellPage(caches)).toBe(SHELL_HTML);
    expect(caches.stores.get(SHELL)!.entries.has(`${ORIGIN}/favicon.svg`)).toBe(true);
  });

  it('install keeps what the page loads, so the first offline launch works', async () => {
    const caches = new FakeCaches();
    await boot(caches, site()).install();
    expect(cachedAssets(caches)).toEqual(['/assets/index-abc.css', '/assets/index-abc.js']);
    const sw = boot(caches, offline);
    expect(await (await sw.get('/', 'navigate'))!.text()).toBe(FULL_SHELL_HTML);
    expect(await (await sw.get('/assets/index-abc.js'))!.text()).toBe('file /assets/index-abc.js');
    expect(await (await sw.get('/assets/index-abc.css'))!.text()).toBe('file /assets/index-abc.css');
  });

  it.each([
    ['is unreachable', offline],
    ['answers 404', async () => own('gone', { status: 404, headers: { 'Content-Type': 'text/plain' } })],
    ['answers with the HTML of an unknown path', async () => html()],
  ])('when an asset %s, install succeeds and stores neither the page nor part of its assets', async (_label, failure) => {
    const caches = new FakeCaches();
    await boot(caches, site(FULL_SHELL_HTML, { '/assets/index-abc.css': failure })).install();
    expect(await shellPage(caches)).toBeUndefined();
    expect(cachedAssets(caches)).toEqual([]);
    expect(caches.stores.get(SHELL)!.entries.has(`${ORIGIN}/favicon.svg`)).toBe(true);
  });

  it('an install that cannot get the new assets leaves the working shell and its assets', async () => {
    const caches = new FakeCaches();
    await boot(caches, site(SHELL_HTML)).install();
    await boot(caches, site(FULL_SHELL_HTML.replaceAll('abc', 'new'), { '/assets/index-new.js': offline })).install();
    expect(await shellPage(caches)).toBe(SHELL_HTML);
    expect(cachedAssets(caches)).toEqual(['/assets/index-abc.js']);
  });

  it('after an install without its assets, the next online page stores the shell', async () => {
    const caches = new FakeCaches();
    await boot(caches, site(FULL_SHELL_HTML, { '/assets/index-abc.js': offline })).install();
    await boot(caches, site()).get('/', 'navigate');
    expect(await shellPage(caches)).toBe(FULL_SHELL_HTML);
  });

  it('pruning keeps what install stored and forgets it once a new deploy no longer loads it', async () => {
    const caches = new FakeCaches();
    await boot(caches, site()).install();
    await boot(caches, site()).get('/', 'navigate');
    expect(cachedAssets(caches)).toEqual(['/assets/index-abc.css', '/assets/index-abc.js']);
    await boot(caches, site(FULL_SHELL_HTML.replaceAll('abc', 'new'))).get('/', 'navigate');
    expect(cachedAssets(caches)).toEqual([]);
  });

  it('activation removes the caches of older versions, with their API copies', async () => {
    const caches = new FakeCaches();
    (await caches.open('ambersight-v2')).entries.set(`${ORIGIN}/api/timeline`, new Response('[]'));
    await caches.open(SHELL);
    await boot(caches, offline).activate();
    expect(await caches.keys()).not.toContain('ambersight-v2');
  });
});
