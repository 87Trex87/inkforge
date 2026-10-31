/* Offline cache for the app shell. Bump VERSION whenever shipped files change. */
const VERSION = 'inkforge-v13';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'reel.js', 'icon.svg', 'manifest.webmanifest',
  'lib/sqlite3.js', 'lib/sqlite3.wasm', 'lib/db-worker.js', 'lib/stencil-worker.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first so edits show up immediately during development; cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(VERSION).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
