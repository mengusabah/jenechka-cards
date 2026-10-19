/* Bump this version whenever any app-shell file changes. */
const VERSION = '2026.10.19.8';
const SCOPE = self.registration.scope;
const CACHE_PREFIX = `jenechka-cards-shell:${encodeURIComponent(SCOPE)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const SHELL_URL = new URL('index.html', SCOPE).href;
const ASSET_URLS = [
  'index.html',
  'styles.css',
  'app.js',
  'data.js',
  'study.js',
  'welcome.js',
  'manifest.webmanifest',
  'icons/favicon-64.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/welcome-mascot.png',
].map(path => new URL(path, SCOPE).href);
const ASSETS = new Set(ASSET_URLS);

self.addEventListener('install', event => {
  // addAll is atomic: an unavailable asset must not leave a partial new shell.
  // Reload bypasses the HTTP cache so a release cannot reuse stale scripts.
  event.waitUntil(caches.open(CACHE_NAME).then(cache =>
    cache.addAll(ASSET_URLS.map(url => new Request(url, { cache: 'reload' })))
  ));
  // Updates wait until all old tabs close, or the user accepts an update.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scopeURL = new URL(SCOPE);
  if (url.origin !== scopeURL.origin) return;

  // This app has no server routes. Only its root and index are HTML entries.
  // Unknown files (including JSON backups) always bypass this static cache.
  const isEntry = request.mode === 'navigate' &&
    (url.pathname === scopeURL.pathname || url.pathname === new URL(SHELL_URL).pathname);
  url.search = '';
  url.hash = '';
  const key = isEntry ? SHELL_URL : url.href;
  if (!isEntry && !ASSETS.has(key)) return;

  // HTML and scripts come from the same installed release, including online.
  // A newly installed worker prepares the next complete shell separately.
  event.respondWith((async () => {
    let cache;
    let cached;
    try {
      cache = await caches.open(CACHE_NAME);
      cached = await cache.match(key);
    } catch {
      // Browsers may deny storage access; the online app should still load.
    }
    if (cached) return cached;
    // Recover if the browser evicted an individual cache entry while online.
    const response = await fetch(new Request(key, { cache: 'reload' }));
    if (cache && response.ok && response.type !== 'opaque') {
      try { await cache.put(key, response.clone()); } catch { /* Quota may be full. */ }
    }
    return response;
  })());
});
