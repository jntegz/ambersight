// Ambersight service worker: opens the dashboard offline with the last data it showed.
// Assets (hashed file names) come from the cache first; pages and API reads from the network
// first, falling back to the last copy. Sign-in, settings and every change always go to the
// network. Signing out clears the cache.
// SPDX-License-Identifier: AGPL-3.0-only
const CACHE = 'ambersight-v1';
const NEVER = /^\/api\/(session|login|logout|setup|config|tokens|passphrase|scan|notify)/;

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
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then((hit) => {
    if (!hit) return Response.error();
    const headers = new Headers(hit.headers);
    headers.set('X-Ambersight-Offline', '1');
    return hit.blob().then((b) => new Response(b, { status: hit.status, headers }));
  })));
});
