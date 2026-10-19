import test from 'node:test';
import assert from 'node:assert/strict';
import { openDeckStore } from '../data.js';

const LEGACY = 'jenechka-cards-v1';
const FALLBACK = 'jenechka-cards-store-v2';
const decks = (name = 'My words') => [{ id: 'deck-1', name, source: 'English', target: 'Türkçe', cards: [{ id: 'card-1', front: "It's fine", back: 'Sorun değil' }] }];
const savedRecord = collection => ({ format: 'jenechka-cards-store', version: 1, revision: 'revision-initial', decks: collection });

function localStorageMock(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    failWrites: false,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (this.failWrites) throw new DOMException('No space', 'QuotaExceededError');
      values.set(key, String(value));
    },
  };
}

function locksMock() {
  const tails = new Map();
  return {
    request(name, callback) {
      const result = (tails.get(name) || Promise.resolve()).catch(() => {}).then(callback);
      tails.set(name, result);
      return result;
    },
  };
}

// This small transaction harness models serialized readwrite transactions,
// delayed commits, and aborted commits. Browser smoke tests cover the native
// IndexedDB implementation; these tests exercise our state and error handling.
function indexedDBMock(value) {
  const control = { value, failOpen: false, failNextCommit: null, commitGate: null, commits: 0, opens: 0 };
  let tail = Promise.resolve();
  control.open = () => {
    control.opens++;
    const request = {};
    let closed = false;
    request.result = {
      objectStoreNames: { contains: () => true },
      close() { closed = true; },
      transaction() {
        if (closed) throw new DOMException('Closed', 'InvalidStateError');
        let query;
        let pending;
        let writes = false;
        let aborted = false;
        const transaction = {
          error: null,
          abort() { aborted = true; },
          objectStore() {
            return {
              get() { query = {}; return query; },
              put(next) { writes = true; pending = structuredClone(next); },
            };
          },
        };
        tail = tail.catch(() => {}).then(async () => {
          query.result = control.value === undefined ? undefined : structuredClone(control.value);
          query.onsuccess();
          if (!aborted && control.commitGate) await control.commitGate;
          if (!aborted && control.failNextCommit) {
            transaction.error = control.failNextCommit;
            control.failNextCommit = null;
            aborted = true;
          }
          if (aborted) transaction.onabort();
          else {
            if (writes) { control.value = pending; control.commits++; }
            transaction.oncomplete();
          }
        });
        return transaction;
      },
    };
    queueMicrotask(() => {
      if (control.failOpen) { request.error = new DOMException('Unavailable', 'UnknownError'); request.onerror(); }
      else request.onsuccess();
    });
    return request;
  };
  return control;
}

function environment(t, { storage = localStorageMock(), database = indexedDBMock(), locks = locksMock() } = {}) {
  const values = { localStorage: storage, indexedDB: database, navigator: { locks } };
  for (const [key, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  return { storage, database, locks };
}

test('legacy words migrate once, survive reopening, and the original recovery source remains untouched', async t => {
  const legacy = JSON.stringify(decks());
  const { storage, database } = environment(t, { storage: localStorageMock({ [LEGACY]: legacy }) });
  const store = await openDeckStore();
  assert.equal(store.backend, 'indexeddb');
  assert.deepEqual(store.decks, decks());
  assert.equal(database.commits, 1);
  await store.save(decks('Updated'));
  assert.equal(storage.getItem(LEGACY), legacy);
  const reopened = await openDeckStore();
  assert.deepEqual(reopened.decks, decks('Updated'));
  assert.equal(database.commits, 2);
});

test('save resolves only after commit and clones data before asynchronous work', async t => {
  const { database } = environment(t);
  const store = await openDeckStore();
  let release;
  database.commitGate = new Promise(resolve => { release = resolve; });
  const next = decks();
  let resolved = false;
  const saving = store.save(next).then(() => { resolved = true; });
  next[0].name = 'Changed after save began';
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.deepEqual(store.decks, []);
  release();
  await saving;
  assert.deepEqual(store.decks, decks());
  assert.deepEqual(database.value.decks, decks());
});

test('quota failure preserves the previous collection and allows retry', async t => {
  const { database } = environment(t, { database: indexedDBMock(savedRecord(decks())) });
  const store = await openDeckStore();
  database.failNextCommit = new DOMException('Full', 'QuotaExceededError');
  await assert.rejects(store.save(decks('Unsaved')), error => error.code === 'QUOTA_EXCEEDED');
  assert.deepEqual(store.decks, decks());
  assert.deepEqual(database.value.decks, decks());
  await store.save(decks('Retry'));
  assert.deepEqual(database.value.decks, decks('Retry'));
});

test('concurrent IndexedDB tabs cannot overwrite an unseen committed update', async t => {
  const { database } = environment(t, { database: indexedDBMock(savedRecord(decks())) });
  const first = await openDeckStore();
  const second = await openDeckStore();
  const results = await Promise.allSettled([first.save(decks('First update')), second.save(decks('Second update'))]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'DATA_CHANGED');
  assert.deepEqual(database.value.decks, decks('First update'));
  assert.deepEqual(second.decks, decks());
});

test('corrupt legacy data is preserved without initializing an empty database', async t => {
  const invalid = '{ broken json';
  const { database, storage } = environment(t, { storage: localStorageMock({ [LEGACY]: invalid }) });
  const store = await openDeckStore();
  assert.equal(store.backend, 'memory');
  assert.match(store.warning, /preserved/);
  assert.equal(database.value, undefined);
  assert.equal(storage.getItem(LEGACY), invalid);
  await assert.rejects(store.save(decks()), error => error.code === 'STORAGE_UNAVAILABLE');
});

test('corrupt primary data remains untouched and an earlier recovery source is clearly identified', async t => {
  const invalid = { ...savedRecord(decks()), decks: null };
  const { database } = environment(t, { storage: localStorageMock({ [LEGACY]: JSON.stringify(decks()) }), database: indexedDBMock(invalid) });
  const store = await openDeckStore();
  assert.equal(store.backend, 'memory');
  assert.deepEqual(store.decks, decks());
  assert.match(store.warning, /earlier browser-storage copy/);
  assert.deepEqual(database.value, invalid);
});

test('localStorage fallback commits durably and detects stale tabs under the shared lock', async t => {
  const { storage } = environment(t, { database: undefined });
  // Supplying undefined selects the helper default, so explicitly remove IDB.
  globalThis.indexedDB = undefined;
  const first = await openDeckStore();
  const second = await openDeckStore();
  assert.equal(first.backend, 'localstorage');
  assert.match(first.warning, /browser storage/);
  await first.save(decks('Fallback words'));
  await assert.rejects(second.save(decks('Stale words')), error => error.code === 'DATA_CHANGED');
  assert.deepEqual(JSON.parse(storage.getItem(FALLBACK)).decks, decks('Fallback words'));
  const reopened = await openDeckStore();
  assert.deepEqual(reopened.decks, decks('Fallback words'));
});

test('fallback quota failure never updates the loaded or persisted collection', async t => {
  const { storage } = environment(t, { database: null });
  const store = await openDeckStore();
  storage.failWrites = true;
  await assert.rejects(store.save(decks()), error => error.code === 'QUOTA_EXCEEDED');
  assert.deepEqual(store.decks, []);
  assert.deepEqual(JSON.parse(storage.getItem(FALLBACK)).decks, []);
});

test('a selected fallback stays authoritative when IndexedDB becomes available again', async t => {
  environment(t, { database: null });
  const fallback = await openDeckStore();
  await fallback.save(decks('Latest fallback words'));
  const database = indexedDBMock(savedRecord(decks('Old database words')));
  globalThis.indexedDB = database;
  const reopened = await openDeckStore();
  assert.equal(reopened.backend, 'localstorage');
  assert.deepEqual(reopened.decks, decks('Latest fallback words'));
  assert.equal(database.opens, 0);
});

test('temporary IndexedDB failure loads the recovery copy read-only instead of creating a stale writable fallback', async t => {
  const { database, storage } = environment(t);
  const store = await openDeckStore();
  await store.save(decks('Latest committed words'));
  database.failOpen = true;
  const recovered = await openDeckStore();
  assert.equal(recovered.backend, 'memory');
  assert.deepEqual(recovered.decks, decks('Latest committed words'));
  assert.match(recovered.warning, /may be older/);
  assert.equal(storage.getItem(FALLBACK), null);
  await assert.rejects(recovered.save(decks()), error => error.code === 'STORAGE_UNAVAILABLE');
  database.failOpen = false;
  assert.deepEqual((await openDeckStore()).decks, decks('Latest committed words'));
});

test('without locks or IndexedDB, existing words stay exportable and writes are refused', async t => {
  environment(t, { database: null, locks: null, storage: localStorageMock({ [LEGACY]: JSON.stringify(decks()) }) });
  const store = await openDeckStore();
  assert.equal(store.backend, 'memory');
  assert.deepEqual(store.decks, decks());
  await assert.rejects(store.save(decks('Unsaved')), error => error.code === 'STORAGE_UNAVAILABLE');
});

test('normal IndexedDB saving does not require Web Locks or localStorage', async t => {
  const { database } = environment(t, { locks: null, storage: null });
  const store = await openDeckStore();
  assert.equal(store.backend, 'indexeddb');
  await store.save(decks());
  assert.deepEqual(database.value.decks, decks());
});
