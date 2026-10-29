/* Bump this version whenever any app-shell file changes. */
const VERSION = '2026.10.30.1';
const SCOPE = self.registration.scope;
const CACHE_PREFIX = `jenechka-cards-shell:${encodeURIComponent(SCOPE)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const SHELL_URL = new URL('index.html', SCOPE).href;
const ASSET_URLS = [
  'index.html',
  'styles.css',
  'stats.css',
  'app.js',
  'data.js',
  'languages.js',
  'prebuilt.js',
  'preview.js',
  'deck-builder.js',
  'deck-add-dialog.js',
  'deck-options.js',
  'study.js',
  'spaced-repetition.js',
  'stats.js',
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
const VOCABULARY_PREFIX = `jenechka-cards-vocabulary:${encodeURIComponent(SCOPE)}:`;
const VOCABULARY_CACHE = `${VOCABULARY_PREFIX}${VERSION}`;
const VOCABULARY_ROOT = new URL('vocabulary/v1/', SCOPE).href;
const CATALOG_URL = new URL('catalog.json', VOCABULARY_ROOT).href;
// This classic worker cannot import the app's ES module. A regression test
// compares this finite allowlist with languages.js.
const VOCABULARY_LANGUAGES = ['en', 'tr', 'de', 'es', 'fr', 'it', 'ru', 'pt', 'zh', 'ja', 'ko', 'ar', 'nl'];
const VOCABULARY_URLS = new Set([
  CATALOG_URL,
  ...VOCABULARY_LANGUAGES.map(code => new URL(`${code}.json`, VOCABULARY_ROOT).href),
]);
const MAX_VOCABULARY_FILES = 5; // The catalog and up to four language files.
const MAX_VOCABULARY_BYTES = 12 * 1024 * 1024;
const vocabularyUse = new Map();
const vocabularyRequests = new Map();
let activeVocabularyPair = new Set();
let vocabularyClock = 0;
let vocabularyWrites = Promise.resolve();

async function validVocabulary(response, key) {
  if (response.status !== 200 || response.type === 'opaque' || response.redirected ||
      response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return false;
  const declaredSize = Number(response.headers.get('Content-Length'));
  if (declaredSize > MAX_VOCABULARY_BYTES) return false;
  try {
    const bytes = await response.clone().arrayBuffer();
    if (bytes.byteLength > MAX_VOCABULARY_BYTES) return false;
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!data || data.schema !== 1 || data.version !== '1') return false;
    if (key === CATALOG_URL) return Array.isArray(data.sources) && Array.isArray(data.categories);
    const code = key.slice(VOCABULARY_ROOT.length, -5);
    return data.language === code &&
      (data.packing === undefined || (data.packing === 1 && Array.isArray(data.strings) && Array.isArray(data.collections))) &&
      ['entries', 'translations', 'frequency', 'cefr', 'categories'].every(field => Array.isArray(data[field]));
  } catch {
    return false;
  }
}

function rememberVocabulary(key) {
  vocabularyUse.set(key, ++vocabularyClock);
}

function storeVocabulary(key, response) {
  // All count checks, eviction, and writes share one queue. Parallel language
  // downloads cannot each observe spare capacity and exceed the cache limit.
  const write = vocabularyWrites.catch(() => {}).then(async () => {
    const cache = await caches.open(VOCABULARY_CACHE);
    const keys = await cache.keys();
    const exists = keys.some(request => request.url === key);
    let size = keys.length;
    const candidates = keys.filter(request => request.url !== CATALOG_URL && request.url !== key &&
      !activeVocabularyPair.has(request.url))
      .sort((a, b) => (vocabularyUse.get(a.url) || 0) - (vocabularyUse.get(b.url) || 0));
    while (size > MAX_VOCABULARY_FILES - (exists ? 0 : 1) && candidates.length) {
      const oldest = candidates.shift().url;
      if (activeVocabularyPair.has(oldest)) continue;
      if (await cache.delete(oldest)) size--;
      vocabularyUse.delete(oldest);
    }
    if (size > MAX_VOCABULARY_FILES - (exists ? 0 : 1)) return;
    await cache.put(key, response);
  });
  vocabularyWrites = write;
  return write;
}

async function vocabularyResponse(key) {
  // Mark the requested source before parsing a cached body, so a faster
  // concurrent target download does not evict the pair's source meanwhile.
  rememberVocabulary(key);
  try {
    const cache = await caches.open(VOCABULARY_CACHE);
    const cached = await cache.match(key);
    if (cached && await validVocabulary(cached, key)) {
      rememberVocabulary(key);
      return cached;
    }
  } catch { /* Online use still works when optional cache storage is denied. */ }
  if (!vocabularyRequests.has(key)) {
    const pending = downloadVocabulary(key).finally(() => vocabularyRequests.delete(key));
    vocabularyRequests.set(key, pending);
  }
  // Share only network work. A cached response already being read can outlive
  // eviction and must not satisfy a later request to restore that cache entry.
  return vocabularyRequests.get(key).then(response => response.clone());
}

async function downloadVocabulary(key) {
  const response = await fetch(new Request(key, { cache: 'reload', credentials: 'omit' }));
  if (await validVocabulary(response, key)) {
    rememberVocabulary(key);
    try { await storeVocabulary(key, response.clone()); }
    catch { /* Quota loss must not discard a successful online download. */ }
  }
  return response;
}

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
    await Promise.all(keys.filter(key =>
      (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) ||
      (key.startsWith(VOCABULARY_PREFIX) && key !== VOCABULARY_CACHE))
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
  if (event.data?.type === 'VOCABULARY_PAIR') {
    const languages = event.data.languages;
    if (!Array.isArray(languages) || languages.length !== 2 ||
        languages[0] === languages[1] || !languages.every(code => VOCABULARY_LANGUAGES.includes(code))) return;
    const pair = new Set(languages.map(code => new URL(`${code}.json`, VOCABULARY_ROOT).href));
    activeVocabularyPair = pair;
    pair.forEach(rememberVocabulary);
    // Restore an evicted file even when the app can still display its
    // in-memory copy. An older eviction may already be deleting a now-pinned
    // file, so finish those writes before checking what needs restoration.
    event.waitUntil((async () => {
      await vocabularyWrites.catch(() => {});
      if (activeVocabularyPair !== pair) return;
      await Promise.all([CATALOG_URL, ...pair]
        .map(key => vocabularyResponse(key).catch(() => {})));
    })());
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
  if (VOCABULARY_URLS.has(key)) {
    // Vocabulary is fetched only after a user selects a language pair. Source
    // datasets, backups, and other JSON paths are outside this exact allowlist.
    event.respondWith(vocabularyResponse(key));
    return;
  }
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
