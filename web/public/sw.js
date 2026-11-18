// Ambersight service worker: opens the dashboard offline with recent data.
// The application shell and its assets live in one cache and hold no account data. A short list of
// API views lives in another, for at most 7 days, without the people named in findings' evidence.
// That second cache is emptied as soon as this worker sees the session has ended (a 401 from the
// API, or /api/session saying so), and when a page says it signed out.
// SPDX-License-Identifier: AGPL-3.0-only
const SHELL = 'ambersight-shell-v3';
const API = 'ambersight-api-v3';
/** Changes every time the API copies are cleared. Kept in the cache: this worker can be stopped between events. */
const GENERATION = '/__ambersight/generation';
const STORED_AT = 'X-Ambersight-Stored-At';
/** Offline copies of API answers kept at most; the oldest go first. */
const MAX_API = 60;
/** As long as a session lasts: an older copy proves no recent sign-in. */
const MAX_AGE_MS = 7 * 86_400_000;
/**
 * The only API views kept offline. Everything else stays out, by default: sign-in, settings and
 * actions, and the Timeline and Worker pages, which name who deployed and who changed what.
 */
const OFFLINE_VIEWS = /^\/api\/(overview|accounts|findings|analytics|resources|packages|self-cost)$/;
/** The same keys as DASHBOARD_ONLY_EVIDENCE in src/shared/findings.ts; a test keeps them equal. */
const PERSON_EVIDENCE = ['actor', 'member', 'changedBy'];
const STATIC_FILES = ['/favicon.svg', '/manifest.webmanifest'];

/** A complete answer from this origin, not a redirect or another site's page. */
const isOwnAnswer = (res) => res.status === 200 && res.type === 'basic' && !res.redirected;
const typeOf = (res) => res.headers.get('Content-Type') || '';
const isHtml = (res) => /^text\/html\b/i.test(typeOf(res));
/** The built index.html: it has the app's mount point and loads a hashed script. */
const isAppShell = (html) => html.includes('id="app"') && /\/assets\/[^"']+\.js/.test(html);

const generation = () => caches.open(SHELL).then((c) => c.match(GENERATION)).then((hit) => (hit ? hit.text() : '')).catch(() => null);

/** The new generation goes first, so that a copy being written now sees it and removes itself. */
async function clearApiCopies() {
  const shell = await caches.open(SHELL);
  await shell.put(GENERATION, new Response(crypto.randomUUID()));
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('ambersight-') && n !== SHELL).map((n) => caches.delete(n)));
}

function isExpired(copy) {
  const age = Date.now() - Number(copy.headers.get(STORED_AT));
  return !(age >= -86_400_000 && age <= MAX_AGE_MS);
}

async function sweepExpired() {
  const cache = await caches.open(API);
  for (const key of await cache.keys()) {
    const copy = await cache.match(key);
    if (!copy || isExpired(copy)) await cache.delete(key);
  }
}

/** Removes evidence naming a person from a view before it is written to disk. */
function withoutPeople(value) {
  if (Array.isArray(value)) value.forEach(withoutPeople);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'evidence' && v && typeof v === 'object') for (const p of PERSON_EVIDENCE) delete v[p];
      withoutPeople(v);
    }
  }
  return value;
}

/** Stores an API answer unless the copies were cleared since its request began, or while writing it. */
async function keepApiCopy(req, res, startedIn) {
  if ((await generation()) !== startedIn) return;
  const body = JSON.stringify(withoutPeople(await res.json()));
  const cache = await caches.open(API);
  // A new copy goes to the end of the cache's order, so the oldest are pruned first.
  await cache.delete(req);
  await cache.put(req, new Response(body, { headers: { 'Content-Type': 'application/json; charset=UTF-8', [STORED_AT]: String(Date.now()) } }));
  if ((await generation()) !== startedIn) {
    await cache.delete(req);
    return;
  }
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_API)).map((k) => cache.delete(k)));
}

async function markedOffline(copy) {
  const headers = new Headers(copy.headers);
  headers.set('X-Ambersight-Offline', '1');
  return new Response(await copy.blob(), { status: copy.status, headers });
}

async function freshCopy(cache, key) {
  const copy = await cache.match(key);
  if (!copy) return null;
  if (!isExpired(copy)) return copy;
  await cache.delete(key);
  return null;
}

/**
 * A sign-in loads the default account and only then learns its id, which later launches ask for by
 * name. The default overview answers those, but only for the account it says it shows.
 */
async function defaultOverviewFor(cache, req) {
  const url = new URL(req.url);
  const account = url.searchParams.get('account');
  if (url.pathname !== '/api/overview' || !account || url.search !== `?account=${encodeURIComponent(account)}`) return null;
  const copy = await freshCopy(cache, '/api/overview');
  if (!copy) return null;
  const view = await copy.clone().json().catch(() => null);
  return view?.account?.id === account ? copy : null;
}

async function offlineCopy(req) {
  const cache = await caches.open(API);
  const copy = (await freshCopy(cache, req)) || (await defaultOverviewFor(cache, req));
  return copy ? markedOffline(copy) : Response.error();
}

/** What /api/session says decides whether the copies may stay. */
async function readSession(res) {
  const { authenticated } = await res.json();
  if (authenticated === false) await clearApiCopies();
  else if (authenticated === true) await sweepExpired();
}

async function apiRequest(e, req, path) {
  const keep = OFFLINE_VIEWS.test(path);
  const startedIn = keep ? await generation() : null;
  let res;
  try {
    res = await fetch(req);
  } catch {
    return keep ? offlineCopy(req) : Response.error();
  }
  if (res.status === 401) e.waitUntil(clearApiCopies().catch(() => {}));
  else if (path === '/api/session') e.waitUntil(readSession(res.clone()).catch(() => {}));
  else if (keep && startedIn !== null && isOwnAnswer(res) && /^application\/json\b/i.test(typeOf(res))) {
    e.waitUntil(keepApiCopy(req, res.clone(), startedIn).catch(() => {}));
  }
  return res;
}

/**
 * Stores the page as the shell only if it really is the shell. A new deploy brings new hashed
 * assets, so this is also the one place that forgets those the page no longer loads.
 */
async function keepShell(res) {
  const html = await res.clone().text();
  if (!isAppShell(html)) return;
  const shell = await caches.open(SHELL);
  await shell.put('/', res);
  for (const key of await shell.keys()) {
    const p = new URL(key.url).pathname;
    if (p.startsWith('/assets/') && !html.includes(p) && !p.includes('inter-')) await shell.delete(key);
  }
}

async function navigation(e, req) {
  try {
    const res = await fetch(req);
    if (isOwnAnswer(res) && isHtml(res)) e.waitUntil(keepShell(res.clone()).catch(() => {}));
    return res;
  } catch {
    e.waitUntil(sweepExpired().catch(() => {}));
    const page = await (await caches.open(SHELL)).match('/');
    return page ? markedOffline(page) : Response.error();
  }
}

/** Unknown paths answer with the shell's HTML: that must not be kept as an asset. */
const isStaticAnswer = (res) => isOwnAnswer(res) && !isHtml(res);

/** The hashed files the page itself loads. The fonts its stylesheet asks for are kept when first used. */
const assetsOf = (html) => [...new Set(Array.from(html.matchAll(/(?:src|href)=["']?(\/assets\/[^"'\s>]+)/g), (m) => m[1]))];

/**
 * Stores the page together with its assets, or not at all: a shell without them opens blank offline.
 * Assets go first, and nothing is pruned, so a shell already stored keeps working if this fails.
 */
async function storeShellWithAssets(shell, page, html) {
  const paths = assetsOf(html);
  const files = await Promise.all(paths.map((p) => fetch(p)));
  if (!paths.length || !files.every(isStaticAnswer)) return;
  await Promise.all(paths.map((p, i) => shell.put(p, files[i])));
  await shell.put('/', page);
}

async function asset(e, req) {
  const shell = await caches.open(SHELL);
  const hit = await shell.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (isStaticAnswer(res)) e.waitUntil(shell.put(req, res.clone()).catch(() => {}));
  return res;
}

async function staticFile(e, req) {
  const shell = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (isStaticAnswer(res)) e.waitUntil(shell.put(req, res.clone()).catch(() => {}));
    return res;
  } catch {
    return (await shell.match(req)) || Response.error();
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    const page = await fetch('/');
    const html = isOwnAnswer(page) && isHtml(page) ? await page.clone().text() : '';
    if (!isAppShell(html)) throw new Error('Not the application shell');
    // A failed asset does not fail the install: the next page loaded online stores the shell.
    await storeShellWithAssets(shell, page, html).catch(() => {});
    await shell.addAll(STATIC_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL && n !== API).map((n) => caches.delete(n)));
    await sweepExpired().catch(() => {});
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'clear') e.waitUntil(clearApiCopies().catch(() => {}));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isApi = url.pathname.startsWith('/api/');
  if (req.mode === 'navigate') {
    // A link to /api/* opens as itself. It says nothing about the session either: a link from
    // another site arrives without the SameSite=Strict cookie and gets a 401.
    if (!isApi) e.respondWith(navigation(e, req));
    return;
  }
  if (isApi) e.respondWith(apiRequest(e, req, url.pathname));
  else if (url.pathname.startsWith('/assets/')) e.respondWith(asset(e, req));
  else if (STATIC_FILES.includes(url.pathname)) e.respondWith(staticFile(e, req));
});
