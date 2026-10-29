import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { LANGUAGES } from '../languages.js';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const scope = 'https://example.github.io/jenechka-cards/';
const prefix = `jenechka-cards-shell:${encodeURIComponent(scope)}:`;
const vocabularyPrefix = `jenechka-cards-vocabulary:${encodeURIComponent(scope)}:`;
const vocabularyRoot = `${scope}vocabulary/v1/`;
const catalog = { schema: 1, version: '1', sources: [], categories: [] };
const languageFile = language => ({
  schema: 1, version: '1', language, entries: [], translations: [], frequency: [], cefr: [], categories: [],
});
const jsonResponse = (value, options = {}) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' }, ...options,
});
const vocabularyEntries = sw => [...sw.stores.entries()].find(([name]) => name.startsWith(vocabularyPrefix))?.[1];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function worker({ beforeDelete, afterMatch } = {}) {
  const handlers = new Map();
  const stores = new Map();
  const fetched = [];
  const responses = new Map();
  let offline = false;
  let missingPath = '';
  let denyStorage = false;
  let failWrites = false;
  let skipped = 0;
  let claimed = 0;
  let maxVocabularyFiles = 0;
  const keyOf = request => typeof request === 'string' ? request : request.url;
  async function fetch(request) {
    const url = keyOf(request);
    fetched.push({ url, cache: request.cache });
    if (offline || (missingPath && url.endsWith(missingPath))) throw new TypeError('Offline');
    if (responses.has(url)) return responses.get(url).clone();
    if (url.startsWith(vocabularyRoot)) {
      const file = url.slice(vocabularyRoot.length);
      return jsonResponse(file === 'catalog.json' ? catalog : languageFile(file.slice(0, -5)));
    }
    return new Response(`release:${url}`);
  }
  const caches = {
    async open(name) {
      if (denyStorage) throw new Error('Storage unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(requests) {
          const responses = await Promise.all(requests.map(fetch));
          requests.forEach((request, i) => entries.set(keyOf(request), responses[i].clone()));
        },
        async match(request) {
          const response = entries.get(keyOf(request))?.clone();
          await afterMatch?.(keyOf(request), response);
          return response;
        },
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
        async delete(request) {
          await beforeDelete?.(keyOf(request));
          // Yield so a missing write queue would expose concurrency races.
          await new Promise(resolve => setImmediate(resolve));
          return entries.delete(keyOf(request));
        },
        async put(request, response) {
          await new Promise(resolve => setImmediate(resolve));
          if (failWrites) throw new Error('Quota exceeded');
          entries.set(keyOf(request), response.clone());
          if (name.startsWith(vocabularyPrefix)) maxVocabularyFiles = Math.max(maxVocabularyFiles, entries.size);
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    registration: { scope },
    addEventListener: (type, handler) => handlers.set(type, handler),
    skipWaiting: async () => { skipped += 1; },
    clients: { claim: async () => { claimed += 1; } },
  };
  vm.runInNewContext(source, { self, caches, fetch, URL, Request, Set, Map, Promise, TextDecoder });
  async function dispatch(type, properties = {}) {
    const pending = [];
    let intercepted = false;
    let result;
    handlers.get(type)({
      ...properties,
      waitUntil: promise => pending.push(promise),
      respondWith: promise => { intercepted = true; result = promise; },
    });
    await Promise.all(pending);
    return { intercepted, response: await result };
  }
  return {
    stores, fetched, responses, dispatch,
    get skipped() { return skipped; },
    get claimed() { return claimed; },
    get maxVocabularyFiles() { return maxVocabularyFiles; },
    set offline(value) { offline = value; },
    set missingPath(value) { missingPath = value; },
    set denyStorage(value) { denyStorage = value; },
    set failWrites(value) { failWrites = value; },
    request(path, mode = 'cors', method = 'GET') {
      return dispatch('fetch', { request: { url: new URL(path, scope).href, mode, method } });
    },
  };
}

test('precache and offline navigation work from the GitHub Pages subdirectory', async () => {
  const sw = worker();
  await sw.dispatch('install');
  assert.equal(sw.skipped, 0, 'install must not replace an active worker');
  assert.equal(sw.fetched.length, 24);
  assert.ok(sw.fetched.every(({ url, cache }) => url.startsWith(scope) && cache === 'reload'));
  sw.offline = true;
  const before = sw.fetched.length;
  for (const path of ['./', './?from=homescreen', 'index.html']) {
    const { intercepted, response } = await sw.request(path, 'navigate');
    assert.equal(intercepted, true);
    assert.equal(await response.text(), `release:${scope}index.html`);
  }
  for (const path of [
    'styles.css', 'stats.css', 'app.js', 'data.js', 'languages.js', 'prebuilt.js', 'preview.js', 'deck-builder.js', 'deck-add-dialog.js', 'deck-options.js', 'study.js', 'spaced-repetition.js', 'fsrs-scheduler.js', 'vendor/ts-fsrs-5.4.2.mjs', 'stats.js', 'welcome.js', 'icons/welcome-mascot.png',
    'icons/favicon-64.png', 'icons/icon-192.png', 'icons/icon-512.png',
    'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  ]) {
    const { response } = await sw.request(path);
    assert.equal(await response.text(), `release:${scope}${path}`);
  }
  assert.equal(sw.fetched.length, before, 'cached shell must not depend on a network request');
});

test('online shell remains coherent and uses the installed release', async () => {
  const sw = worker();
  await sw.dispatch('install');
  const before = sw.fetched.length;
  await sw.request('./', 'navigate');
  await sw.request('app.js?cachebust=other-version');
  assert.equal(sw.fetched.length, before);
});

test('backups, unknown files, other sites and writes never enter the static cache', async () => {
  const sw = worker();
  for (const [path, mode, method] of [
    ['backup.json', 'cors', 'GET'],
    ['backup.json', 'navigate', 'GET'],
    ['vocabulary/source-data/frequency.json', 'cors', 'GET'],
    ['scripts/fetch-frequency.py', 'cors', 'GET'],
    ['vocabulary/v1/unknown.json', 'cors', 'GET'],
    ['vocabulary/v1/en/backup.json', 'cors', 'GET'],
    ['vocabulary/v2/catalog.json', 'cors', 'GET'],
    ['vocabulary/v1/en.json', 'cors', 'POST'],
    ['https://example.github.io/other-project/', 'navigate', 'GET'],
    ['https://elsewhere.example/app.js', 'cors', 'GET'],
    ['app.js', 'cors', 'POST'],
  ]) {
    assert.equal((await sw.request(path, mode, method)).intercepted, false);
  }
  assert.equal(sw.stores.size, 0);
  assert.equal(sw.fetched.length, 0);
});

test('activation removes only obsolete caches belonging to this registration', async () => {
  const sw = worker();
  await sw.dispatch('install');
  const current = [...sw.stores.keys()][0];
  const otherScope = `jenechka-cards-shell:${encodeURIComponent('https://example.github.io/another-app/')}:old`;
  const otherVocabularyScope = `jenechka-cards-vocabulary:${encodeURIComponent('https://example.github.io/another-app/')}:old`;
  await sw.request('vocabulary/v1/catalog.json');
  const currentVocabulary = [...sw.stores.keys()].find(name => name.startsWith(vocabularyPrefix));
  sw.stores.set(`${prefix}old`, new Map());
  sw.stores.set(`${vocabularyPrefix}old`, new Map());
  sw.stores.set(otherScope, new Map());
  sw.stores.set(otherVocabularyScope, new Map());
  sw.stores.set('some-other-app', new Map());
  await sw.dispatch('activate');
  assert.ok(sw.stores.has(current));
  assert.ok(!sw.stores.has(`${prefix}old`));
  assert.ok(!sw.stores.has(`${vocabularyPrefix}old`));
  assert.ok(sw.stores.has(currentVocabulary));
  assert.ok(sw.stores.has(otherScope));
  assert.ok(sw.stores.has(otherVocabularyScope));
  assert.ok(sw.stores.has('some-other-app'));
  assert.equal(sw.claimed, 1);
});

test('an incomplete install fails and leaves the previous release intact', async () => {
  const sw = worker();
  const oldEntries = new Map([['old', new Response('previous release')]]);
  sw.stores.set(`${prefix}old`, oldEntries);
  sw.missingPath = 'data.js';
  await assert.rejects(sw.dispatch('install'), /Offline/);
  assert.equal(sw.stores.get(`${prefix}old`), oldEntries);
  assert.equal(sw.skipped, 0);
  assert.equal(sw.claimed, 0);
  const newCache = [...sw.stores.entries()].find(([name]) => name !== `${prefix}old`)[1];
  assert.equal(newCache.size, 0);
});

test('only an explicit update message invokes skipWaiting', async () => {
  const sw = worker();
  await sw.dispatch('message', { data: { type: 'OTHER' } });
  await sw.dispatch('message', { data: null });
  assert.equal(sw.skipped, 0);
  await sw.dispatch('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.skipped, 1);
});

test('online requests recover from evicted entries and denied or full storage', async () => {
  const sw = worker();
  await sw.dispatch('install');
  const entries = [...sw.stores.values()][0];
  entries.delete(`${scope}app.js`);
  assert.equal(await (await sw.request('app.js')).response.text(), `release:${scope}app.js`);
  assert.ok(entries.has(`${scope}app.js`));
  entries.delete(`${scope}app.js`);
  sw.failWrites = true;
  assert.equal(await (await sw.request('app.js')).response.text(), `release:${scope}app.js`);
  sw.denyStorage = true;
  assert.equal(await (await sw.request('./', 'navigate')).response.text(), `release:${scope}index.html`);
});

test('normal installation and startup do not download vocabulary or remove old vocabulary caches', async () => {
  const sw = worker();
  const previous = new Map();
  sw.stores.set(`${vocabularyPrefix}previous`, previous);
  await sw.dispatch('install');
  await sw.request('./', 'navigate');
  await sw.request('prebuilt.js');
  assert.ok(sw.fetched.every(({ url }) => !url.startsWith(vocabularyRoot)));
  assert.equal(sw.stores.get(`${vocabularyPrefix}previous`), previous);
  assert.deepEqual([...sw.stores.keys()].filter(key => key.startsWith(vocabularyPrefix)), [`${vocabularyPrefix}previous`]);
});

test('the vocabulary allowlist matches the shared languages and cached pairs open offline', async () => {
  const sw = worker();
  const allowed = vm.runInNewContext(`${source}\nVOCABULARY_LANGUAGES.join(',')`, {
    self: { registration: { scope }, addEventListener() {} }, URL, Set, Map, Promise,
  });
  assert.deepEqual(allowed.split(','), LANGUAGES.map(language => language.code));
  for (const file of ['catalog', 'tr', 'ja']) {
    const result = await sw.request(`vocabulary/v1/${file}.json`);
    assert.equal(result.intercepted, true);
    assert.deepEqual(await result.response.json(), file === 'catalog' ? catalog : languageFile(file));
  }
  assert.equal(vocabularyEntries(sw).size, 3);
  const networkRequests = sw.fetched.length;
  sw.offline = true;
  for (const file of ['catalog', 'tr', 'ja']) {
    assert.ok((await sw.request(`vocabulary/v1/${file}.json?library=1`)).response.ok);
  }
  assert.equal(sw.fetched.length, networkRequests);
  await assert.rejects(sw.request('vocabulary/v1/ru.json'), /Offline/);
});

test('concurrent vocabulary downloads never exceed five files and retain the catalog', async () => {
  const sw = worker();
  await sw.request('vocabulary/v1/catalog.json');
  await Promise.all(LANGUAGES.map(({ code }) => sw.request(`vocabulary/v1/${code}.json`)));
  const entries = vocabularyEntries(sw);
  assert.equal(entries.size, 5);
  assert.ok(sw.maxVocabularyFiles <= 5, 'even temporary size during concurrent puts must stay bounded');
  assert.ok(entries.has(`${vocabularyRoot}catalog.json`));
  const retainedLanguages = [...entries.keys()].filter(url => !url.endsWith('/catalog.json'));
  const networkRequests = sw.fetched.length;
  sw.offline = true;
  for (const url of [retainedLanguages[0], retainedLanguages[1], `${vocabularyRoot}catalog.json`]) {
    assert.ok((await sw.request(url)).response.ok);
  }
  assert.equal(sw.fetched.length, networkRequests);
});

test('using an older cached source protects it while another target is downloaded', async () => {
  const sw = worker();
  for (const file of ['catalog', 'en', 'tr', 'de', 'fr', 'en', 'es']) {
    await sw.request(`vocabulary/v1/${file}.json`);
  }
  const entries = vocabularyEntries(sw);
  assert.equal(entries.size, 5);
  assert.ok(entries.has(`${vocabularyRoot}catalog.json`));
  assert.ok(entries.has(`${vocabularyRoot}en.json`));
  assert.ok(entries.has(`${vocabularyRoot}es.json`));
  assert.ok(!entries.has(`${vocabularyRoot}tr.json`));
});

test('a source reused from app memory survives language switching and an offline restart', async () => {
  const sw = worker();
  for (const target of ['tr', 'de', 'fr', 'es', 'ru', 'zh', 'ja', 'ko', 'ar', 'nl', 'tr']) {
    await sw.dispatch('message', { data: { type: 'VOCABULARY_PAIR', languages: ['en', target] } });
    assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}en.json`));
    assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}${target}.json`));
  }
  assert.equal(sw.fetched.filter(({ url }) => url === `${vocabularyRoot}en.json`).length, 1);
  assert.ok(sw.maxVocabularyFiles <= 5);
  const requests = sw.fetched.length;
  sw.offline = true;
  for (const code of ['catalog', 'en', 'tr']) {
    assert.ok((await sw.request(`vocabulary/v1/${code}.json`)).response.ok);
  }
  assert.equal(sw.fetched.length, requests);
});

test('pair notifications restore evicted files, coalesce downloads and reject unknown paths', async () => {
  const sw = worker();
  for (const languages of [['en', '../backup'], ['en'], ['en', 'en'], null]) {
    await sw.dispatch('message', { data: { type: 'VOCABULARY_PAIR', languages } });
  }
  assert.equal(sw.fetched.length, 0);
  await Promise.all([
    sw.dispatch('message', { data: { type: 'VOCABULARY_PAIR', languages: ['en', 'tr'] } }),
    sw.request('vocabulary/v1/en.json'),
    sw.request('vocabulary/v1/tr.json'),
  ]);
  assert.equal(sw.fetched.length, 3);
  vocabularyEntries(sw).delete(`${vocabularyRoot}en.json`);
  await sw.dispatch('message', { data: { type: 'VOCABULARY_PAIR', languages: ['en', 'tr'] } });
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}en.json`));
  assert.equal(sw.fetched.length, 4);
  sw.offline = true;
  await sw.dispatch('message', { data: { type: 'VOCABULARY_PAIR', languages: ['en', 'ja'] } });
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}en.json`));
});

test('a newly pinned pair is restored after an older eviction already started', async () => {
  const deleting = deferred(), resumeDelete = deferred();
  const sw = worker({ beforeDelete: async key => {
    if (key === `${vocabularyRoot}en.json`) {
      deleting.resolve();
      await resumeDelete.promise;
    }
  } });
  for (const code of ['catalog', 'en', 'tr', 'de', 'fr']) await sw.request(`vocabulary/v1/${code}.json`);
  const oldWrite = sw.request('vocabulary/v1/es.json');
  await deleting.promise;
  const currentPair = sw.dispatch('message', { data: { type: 'VOCABULARY_PAIR', languages: ['en', 'tr'] } });
  // Allow an incorrectly unsequenced restore to take its pre-eviction cache
  // snapshot before the already-started deletion completes.
  await new Promise(resolve => setImmediate(resolve));
  resumeDelete.resolve();
  await Promise.all([oldWrite, currentPair]);
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}en.json`));
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}tr.json`));
  assert.ok(sw.maxVocabularyFiles <= 5);
  const networkRequests = sw.fetched.length;
  sw.offline = true;
  for (const code of ['catalog', 'en', 'tr']) {
    assert.ok((await sw.request(`vocabulary/v1/${code}.json`)).response.ok);
  }
  assert.equal(sw.fetched.length, networkRequests);
});

test('an old cached response cannot satisfy restoration after its entry was evicted', async () => {
  const deleting = deferred(), resumeDelete = deferred();
  const cachedRead = deferred(), resumeCachedRead = deferred();
  let pauseCachedRead = false;
  const sw = worker({
    beforeDelete: async key => {
      if (key === `${vocabularyRoot}en.json`) {
        deleting.resolve();
        await resumeDelete.promise;
      }
    },
    afterMatch: async (key, response) => {
      if (pauseCachedRead && key === `${vocabularyRoot}en.json` && response) {
        pauseCachedRead = false;
        cachedRead.resolve();
        await resumeCachedRead.promise;
      }
    },
  });
  for (const code of ['catalog', 'en', 'tr', 'de', 'fr']) await sw.request(`vocabulary/v1/${code}.json`);
  const oldWrite = sw.request('vocabulary/v1/es.json');
  await deleting.promise;
  pauseCachedRead = true;
  const oldRead = sw.request('vocabulary/v1/en.json');
  await cachedRead.promise;
  const currentPair = sw.dispatch('message', { data: { type: 'VOCABULARY_PAIR', languages: ['en', 'tr'] } });
  resumeDelete.resolve();
  await oldWrite;
  await new Promise(resolve => setImmediate(resolve));
  resumeCachedRead.resolve();
  await Promise.all([oldRead, currentPair]);
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}en.json`));
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}tr.json`));
  assert.equal(sw.fetched.filter(({ url }) => url === `${vocabularyRoot}en.json`).length, 2);
  assert.ok(sw.maxVocabularyFiles <= 5);
  const networkRequests = sw.fetched.length;
  sw.offline = true;
  assert.ok((await sw.request('vocabulary/v1/en.json')).response.ok);
  assert.equal(sw.fetched.length, networkRequests);
});

test('only bounded JSON with the expected vocabulary schema, version, and language is cached', async () => {
  const cases = [
    ['wrong content type', new Response(JSON.stringify(languageFile('en')), { headers: { 'Content-Type': 'text/html' } })],
    ['malformed JSON', new Response('{', { headers: { 'Content-Type': 'application/json' } })],
    ['null JSON', jsonResponse(null)],
    ['wrong schema', jsonResponse({ ...languageFile('en'), schema: 2 })],
    ['wrong version', jsonResponse({ ...languageFile('en'), version: '2' })],
    ['wrong language', jsonResponse(languageFile('fr'))],
    ['missing fields', jsonResponse({ schema: 1, version: '1', language: 'en' })],
    ['invalid fields', jsonResponse({ ...languageFile('en'), translations: {} })],
    ['not found', jsonResponse(languageFile('en'), { status: 404 })],
    ['partial content', jsonResponse(languageFile('en'), { status: 206 })],
    ['oversized declared body', jsonResponse(languageFile('en'), {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(12 * 1024 * 1024 + 1) },
    })],
    ['oversized actual body', jsonResponse({ ...languageFile('en'), padding: 'x'.repeat(12 * 1024 * 1024) })],
    ['invalid UTF-8', new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'Content-Type': 'application/json' } })],
  ];
  for (const [label, response] of cases) {
    const sw = worker();
    sw.responses.set(`${vocabularyRoot}en.json`, response);
    const result = await sw.request('vocabulary/v1/en.json');
    assert.equal(result.intercepted, true, label);
    assert.equal(vocabularyEntries(sw).size, 0, `${label} must not be cached`);
  }
  const sw = worker();
  sw.responses.set(`${vocabularyRoot}catalog.json`, jsonResponse({ schema: 1, version: '1', sources: [] }));
  await sw.request('vocabulary/v1/catalog.json');
  assert.equal(vocabularyEntries(sw).size, 0, 'catalog fields must also be validated');
});

test('vocabulary still loads online after quota failures, denied storage, or eviction', async () => {
  const sw = worker();
  sw.failWrites = true;
  assert.deepEqual(await (await sw.request('vocabulary/v1/en.json')).response.json(), languageFile('en'));
  assert.equal(vocabularyEntries(sw).size, 0);
  sw.failWrites = false;
  await sw.request('vocabulary/v1/tr.json');
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}tr.json`), 'a rejected write must not poison the queue');
  vocabularyEntries(sw).delete(`${vocabularyRoot}tr.json`);
  sw.offline = true;
  await assert.rejects(sw.request('vocabulary/v1/tr.json'), /Offline/);
  sw.offline = false;
  await sw.request('vocabulary/v1/tr.json');
  assert.ok(vocabularyEntries(sw).has(`${vocabularyRoot}tr.json`));
  sw.denyStorage = true;
  assert.deepEqual(await (await sw.request('vocabulary/v1/de.json')).response.json(), languageFile('de'));
});

test('invalid cached vocabulary is not served offline and is replaced when online', async () => {
  const sw = worker();
  await sw.request('vocabulary/v1/en.json');
  vocabularyEntries(sw).set(`${vocabularyRoot}en.json`, jsonResponse({ ...languageFile('en'), version: '0' }));
  sw.offline = true;
  await assert.rejects(sw.request('vocabulary/v1/en.json'), /Offline/);
  sw.offline = false;
  assert.deepEqual(await (await sw.request('vocabulary/v1/en.json')).response.json(), languageFile('en'));
  assert.equal((await vocabularyEntries(sw).get(`${vocabularyRoot}en.json`).clone().json()).version, '1');
});

test('manifest stays in scope and shipped icons have the promised PNG dimensions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  for (const property of ['id', 'start_url', 'scope']) assert.equal(new URL(manifest[property], scope).href, scope);
  assert.equal(manifest.display, 'standalone');
  for (const icon of [...manifest.icons, { src: './icons/apple-touch-icon.png', sizes: '180x180' }]) {
    assert.ok(new URL(icon.src, scope).href.startsWith(scope));
    const bytes = await readFile(new URL(`../${icon.src}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
});
