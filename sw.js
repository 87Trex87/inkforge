/* Offline cache for the app shell. Bump VERSION whenever shipped files change. */
const VERSION = 'inkforge-v56';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'reel.js', 'icon.svg', 'manifest.webmanifest',
  'lib/sqlite3.js', 'lib/sqlite3.wasm', 'lib/db-worker.js', 'lib/stencil-worker.js', 'img/pain-chart.png', 'quote.html'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so the new version is cached, not an older copy.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first so updates show up immediately; cache when offline. cache: 'no-cache' makes the browser
// check every file with the server, so a new app.js is never paired with a stale reel.js.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    const copy = r.clone();
    caches.open(VERSION).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
