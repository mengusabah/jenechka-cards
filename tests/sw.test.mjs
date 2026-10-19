import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const scope = 'https://example.github.io/jenechka-cards/';
const prefix = `jenechka-cards-shell:${encodeURIComponent(scope)}:`;

function worker() {
  const handlers = new Map();
  const stores = new Map();
  const fetched = [];
  let offline = false;
  let missingPath = '';
  let denyStorage = false;
  let failWrites = false;
  let skipped = 0;
  let claimed = 0;
  const keyOf = request => typeof request === 'string' ? request : request.url;
  async function fetch(request) {
    const url = keyOf(request);
    fetched.push({ url, cache: request.cache });
    if (offline || (missingPath && url.endsWith(missingPath))) throw new TypeError('Offline');
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
        async match(request) { return entries.get(keyOf(request))?.clone(); },
        async put(request, response) {
          if (failWrites) throw new Error('Quota exceeded');
          entries.set(keyOf(request), response.clone());
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
  vm.runInNewContext(source, { self, caches, fetch, URL, Request, Set, Promise });
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
    stores, fetched, dispatch,
    get skipped() { return skipped; },
    get claimed() { return claimed; },
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
  assert.equal(sw.fetched.length, 10);
  assert.ok(sw.fetched.every(({ url, cache }) => url.startsWith(scope) && cache === 'reload'));
  sw.offline = true;
  const before = sw.fetched.length;
  for (const path of ['./', './?from=homescreen', 'index.html']) {
    const { intercepted, response } = await sw.request(path, 'navigate');
    assert.equal(intercepted, true);
    assert.equal(await response.text(), `release:${scope}index.html`);
  }
  for (const path of [
    'styles.css', 'app.js', 'data.js', 'study.js',
    'icons/icon-192.png', 'icons/icon-512.png',
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
  sw.stores.set(`${prefix}old`, new Map());
  sw.stores.set(otherScope, new Map());
  sw.stores.set('some-other-app', new Map());
  await sw.dispatch('activate');
  assert.ok(sw.stores.has(current));
  assert.ok(!sw.stores.has(`${prefix}old`));
  assert.ok(sw.stores.has(otherScope));
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
