// Ambersight service worker: opens the dashboard offline with the last data it showed.
// Assets (hashed file names) come from the cache first; pages and API reads from the network
// first, falling back to the last copy. Sign-in, settings and every change always go to the
// network. Signing out clears the cache.
// SPDX-License-Identifier: AGPL-3.0-only
const CACHE = 'ambersight-v2';
// Never kept: sign-in, settings, actions, and views keyed by a time that differs on every visit.
const NEVER = /^\/api\/(session|login|logout|setup|config|tokens|passphrase|scan|notify|changes|report)|^\/api\/findings\/[^/]+\/history/;
/** Offline copies of API answers kept at most; the oldest go first. Assets are pruned per deploy. */
const MAX_API = 60;

/** Drops the oldest API answers past MAX_API, and assets the current page no longer loads. */
async function prune(cache) {
  const keys = await cache.keys();
  const api = keys.filter((r) => new URL(r.url).pathname.startsWith('/api/'));
  await Promise.all(api.slice(0, Math.max(0, api.length - MAX_API)).map((r) => cache.delete(r)));
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/favicon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data === 'clear') e.waitUntil(caches.delete(CACHE));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || NEVER.test(url.pathname)) return;
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  const key = req.mode === 'navigate' ? '/' : req;
  e.respondWith(fetch(req).then((res) => {
    // Only complete answers are kept: a 401 must not replace the last good copy.
    if (res.ok) {
      const copy = res.clone();
      // A new copy goes to the end of the cache's order, so the oldest are pruned first.
      e.waitUntil(caches.open(CACHE).then((c) => c.delete(key).then(() => c.put(key, copy)).then(() => prune(c))));
    }
    // A new deploy brings new hashed assets: forget the ones the new page no longer loads.
    if (res.ok && req.mode === 'navigate') {
      const page = res.clone();
      e.waitUntil(page.text().then((html) => caches.open(CACHE).then(async (c) => {
        for (const r of await c.keys()) {
          const p = new URL(r.url).pathname;
          if (p.startsWith('/assets/') && !html.includes(p) && !p.includes('inter-')) await c.delete(r);
        }
      })));
    }
    return res;
  }).catch(() => caches.match(key).then((hit) => {
    if (!hit) return Response.error();
    const headers = new Headers(hit.headers);
    headers.set('X-Ambersight-Offline', '1');
    return hit.blob().then((b) => new Response(b, { status: hit.status, headers }));
  })));
});
