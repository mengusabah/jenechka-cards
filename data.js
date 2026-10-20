// All user data stays on this device. A successful save means the transaction
// committed; callers must keep their previous state until this promise resolves.
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const LIMITS = Object.freeze({ decks: 2000, cards: 100000, name: 1000, language: 200, side: 100000 });
const LEGACY_KEY = 'jenechka-cards-v1';
const STORAGE_KEY = 'jenechka-cards-store-v2';
const BACKEND_KEY = 'jenechka-cards-backend-v2';
const RECOVERY_KEY = 'jenechka-cards-recovery-v2';
const LOCK_NAME = 'jenechka-cards-store-v2';
const DATABASE_NAME = 'jenechka-cards';
const STORE_NAME = 'state';
const RECORD_KEY = 'decks';
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();

function failure(message, code = 'INVALID_DATA') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw failure('Secure ID generation is unavailable. Please use a current browser.', 'UNAVAILABLE');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`${label} must be an object.`);
}

function id(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw failure(`${label} must contain only letters, numbers, hyphens, or underscores (1–128 characters).`);
  return value;
}

function textField(value, limit, label) {
  if (typeof value !== 'string' || !value.trim()) throw failure(`${label} cannot be blank and must be text.`);
  if (value.length > limit) throw failure(`${label} exceeds the ${limit.toLocaleString('en-US')}-character limit.`);
  return value;
}

function backupObject(decks) {
  return { format: 'jenechka-cards', version: 1, exportedAt: new Date().toISOString(), decks };
}

function checkBackupSize(decks) {
  // The UI exports pretty-printed JSON. Check that representation everywhere
  // so every accepted import and committed collection can also be exported.
  if (encoder.encode(JSON.stringify(backupObject(decks), null, 2)).byteLength > MAX_BACKUP_BYTES) {
    throw failure('This collection exceeds the 10 MiB backup limit. Split it into smaller backups.', 'TOO_LARGE');
  }
}

export function validateDecks(value) {
  if (!Array.isArray(value)) throw failure('The backup must contain a decks array.');
  if (value.length > LIMITS.decks) throw failure(`A collection can contain at most ${LIMITS.decks} decks.`);
  const deckIds = new Set();
  let totalCards = 0;
  const decks = value.map((deck, index) => {
    const label = `Deck ${index + 1}`;
    object(deck, label);
    const deckId = id(deck.id, `${label} ID`);
    if (deckIds.has(deckId)) throw failure(`${label} has a duplicate deck ID.`);
    deckIds.add(deckId);
    if (!Array.isArray(deck.cards)) throw failure(`${label} must contain a cards array.`);
    totalCards += deck.cards.length;
    if (totalCards > LIMITS.cards) throw failure(`A collection can contain at most ${LIMITS.cards.toLocaleString('en-US')} cards.`);
    const cardIds = new Set();
    return {
      id: deckId,
      name: textField(deck.name, LIMITS.name, `${label} name`),
      source: textField(deck.source, LIMITS.language, `${label} source language`),
      target: textField(deck.target, LIMITS.language, `${label} target language`),
      ...(deck.prebuilt === undefined ? {} : { prebuilt: validatePrebuilt(deck.prebuilt) }),
      cards: deck.cards.map((card, cardIndex) => {
        const cardLabel = `${label}, card ${cardIndex + 1}`;
        object(card, cardLabel);
        const cardId = id(card.id, `${cardLabel} ID`);
        if (cardIds.has(cardId)) throw failure(`${cardLabel} has a duplicate card ID.`);
        cardIds.add(cardId);
        return {
          id: cardId,
          front: textField(card.front, LIMITS.side, `${cardLabel} front`),
          back: textField(card.back, LIMITS.side, `${cardLabel} back`),
        };
      }),
    };
  });
  checkBackupSize(decks);
  return decks;
}

// Keep dataset attribution with copied templates, including JSON backups.
// Old custom decks remain valid; arbitrary extra fields are still discarded.
function validatePrebuilt(value) {
  object(value, 'Prebuilt metadata');
  const url = (value, label) => {
    const result = textField(value, 2000, label);
    try {
      if (new URL(result).protocol === 'https:') return result;
    } catch { /* Reject links that cannot safely be displayed as attribution. */ }
    throw failure(`${label} must be an HTTPS URL.`);
  };
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 20) {
    throw failure('Prebuilt metadata must contain its dataset sources.');
  }
  return {
    templateId: id(value.templateId, 'Prebuilt template ID'),
    version: textField(value.version, 100, 'Prebuilt version'),
    sourceLanguage: textField(value.sourceLanguage, 20, 'Prebuilt source language'),
    targetLanguage: textField(value.targetLanguage, 20, 'Prebuilt target language'),
    title: textField(value.title, 1000, 'Prebuilt title'),
    notice: textField(value.notice, 4000, 'Prebuilt notice'),
    sources: value.sources.map(source => {
      object(source, 'Dataset source');
      if (source.pages !== undefined && (!Array.isArray(source.pages) || source.pages.length > 10000)) {
        throw failure('Dataset entry attribution must contain at most 10000 page URLs.');
      }
      return {
        name: textField(source.name, 1000, 'Dataset name'),
        url: url(source.url, 'Dataset URL'),
        license: textField(source.license, 1000, 'Dataset license'),
        licenseUrl: url(source.licenseUrl, 'Dataset license URL'),
        attribution: textField(source.attribution, 8000, 'Dataset attribution'),
        modifications: textField(source.modifications, 8000, 'Dataset modifications'),
        ...(source.pages === undefined ? {} : { pages: source.pages.map(page => url(page, 'Dictionary entry URL')) }),
      };
    }),
  };
}

export function makeBackup(decks) {
  return backupObject(validateDecks(decks));
}

export function parseBackup(text) {
  if (typeof text !== 'string') throw failure('Choose a JSON backup file.');
  if (encoder.encode(text).byteLength > MAX_BACKUP_BYTES) throw failure('The backup file exceeds the 10 MiB limit.', 'TOO_LARGE');
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw failure('This file is not valid JSON. Choose a Jenechka Cards backup.'); }
  if (Array.isArray(value)) return validateDecks(value);
  object(value, 'Backup');
  if (value.format !== 'jenechka-cards' || value.version !== 1) throw failure('This backup format or version is not supported.');
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) throw failure('The backup export date is missing or invalid.');
  return validateDecks(value.decks);
}

function contentKey(deck) {
  return JSON.stringify([deck.name, deck.source, deck.target, deck.cards.map(card => [card.front, card.back])]);
}

export function mergeDecks(existing, incoming) {
  const decks = validateDecks(existing);
  const candidates = validateDecks(incoming);
  const contents = new Set(decks.map(contentKey));
  const ids = new Set(decks.flatMap(deck => [deck.id, ...deck.cards.map(card => card.id)]));
  const uniqueId = preferred => {
    let result = preferred;
    while (ids.has(result)) result = createId();
    ids.add(result);
    return result;
  };
  let added = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const key = contentKey(candidate);
    if (contents.has(key)) { skipped++; continue; }
    contents.add(key);
    decks.push({ ...candidate, id: uniqueId(candidate.id), cards: candidate.cards.map(card => ({ ...card, id: uniqueId(card.id) })) });
    added++;
  }
  return { decks: validateDecks(decks), added, skipped };
}

function record(decks) {
  return { format: 'jenechka-cards-store', version: 1, revision: createId(), decks };
}

function validateRecord(value) {
  object(value, 'Stored collection');
  if (value.format !== 'jenechka-cards-store' || value.version !== 1 || typeof value.revision !== 'string' || !SAFE_ID.test(value.revision)) {
    throw failure('The saved collection format is invalid.', 'CORRUPT_STORAGE');
  }
  return { ...value, decks: validateDecks(value.decks) };
}

function readLocal() {
  let storage;
  let current;
  let legacy;
  try {
    storage = globalThis.localStorage;
    if (!storage) throw new Error('Unavailable');
    current = storage.getItem(STORAGE_KEY);
    legacy = current === null ? storage.getItem(LEGACY_KEY) : null;
  } catch {
    throw failure('Browser storage is unavailable. Existing browser data could not be read.', 'STORAGE_UNAVAILABLE');
  }
  try {
    if (current !== null) return { storage, value: validateRecord(JSON.parse(current)) };
    return { storage, value: null, legacyDecks: legacy === null ? [] : parseBackup(legacy) };
  } catch {
    throw failure('Saved browser data could not be read safely. The original data has been preserved; saving is disabled to avoid replacing it.', 'CORRUPT_STORAGE');
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(failure('The device database is blocked by another open version of this app. Close other Jenechka Cards tabs and reopen it.', 'DATABASE_BLOCKED'));
    }, 5000);
    try { request = globalThis.indexedDB.open(DATABASE_NAME, 1); }
    catch (error) { clearTimeout(timer); reject(error); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) { request.result.close(); return; }
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
  });
}

function transact(database, transform) {
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let reason;
    try {
      // Safari and older browsers can ignore/omit the durability hint. The
      // transaction completion event remains the success boundary everywhere.
      try { transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' }); }
      catch { transaction = database.transaction(STORE_NAME, 'readwrite'); }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(reason || transaction.error || failure('The save was interrupted. Your previous saved collection is unchanged.', 'SAVE_FAILED'));
      transaction.onerror = () => {};
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(RECORD_KEY);
      request.onsuccess = () => {
        try {
          const outcome = transform(request.result);
          result = outcome.result;
          if (outcome.write) store.put(outcome.write, RECORD_KEY);
        } catch (error) { reason = error; transaction.abort(); }
      };
    } catch (error) { reject(error); }
  });
}

function stale() {
  return failure('Your collection changed in another tab or app window. Export any unsaved work, then reload before saving again.', 'DATA_CHANGED');
}

function saveError(error) {
  if (error?.code === 'DATA_CHANGED' || error?.code === 'CORRUPT_STORAGE') return error;
  if (error?.name === 'QuotaExceededError') return failure('Your device has no space for this save. Export a backup and free storage, then try again. Your previous saved collection is unchanged.', 'QUOTA_EXCEEDED');
  return failure('Your changes could not be saved on this device. Keep this page open and export a backup before trying again.', 'SAVE_FAILED');
}

function writableStore(initial, backend, warning, commit) {
  let revision = initial.revision;
  let queue = Promise.resolve();
  const api = {
    decks: initial.decks,
    backend,
    warning,
    save(nextDecks) {
      let canonical;
      try { canonical = validateDecks(nextDecks); }
      catch (error) { return Promise.reject(error); }
      const work = queue.catch(() => {}).then(async () => {
        const next = record(canonical);
        try { await commit(revision, next); }
        catch (error) { throw saveError(error); }
        revision = next.revision;
        api.decks = canonical;
      });
      queue = work;
      return work;
    },
  };
  return api;
}

function memoryStore(decks, warning) {
  return {
    decks,
    backend: 'memory',
    warning,
    save: async () => { throw failure('Safe device storage is unavailable. Your changes have not been saved. Export a backup and reopen the app in a regular browser window.', 'STORAGE_UNAVAILABLE'); },
  };
}

function recoveryStore(message) {
  // This extra copy is best-effort: IndexedDB remains authoritative, and a
  // browser-storage quota error must not turn a committed database save into
  // an apparent failure. Always identify a recovery copy as potentially older.
  try {
    const raw = globalThis.localStorage?.getItem(RECOVERY_KEY);
    if (raw !== null && raw !== undefined) {
      const saved = validateRecord(JSON.parse(raw));
      return memoryStore(saved.decks, `${message} A recovery copy has been loaded for study and export; it may be older than your latest save. Saving is disabled to protect the original database.`);
    }
    const local = readLocal();
    const rawLegacy = local.storage.getItem(LEGACY_KEY);
    if (local.value || rawLegacy !== null) {
      return memoryStore(local.value?.decks || local.legacyDecks, `${message} An earlier browser-storage copy has been loaded for study and export. Saving is disabled to protect the original database.`);
    }
  } catch { /* Preserve unreadable data; never replace it. */ }
  return memoryStore([], `${message} The original data has been preserved. Saving is disabled; reopen the app to try reading it again.`);
}

function rememberDatabase(saved) {
  try { globalThis.localStorage.setItem(BACKEND_KEY, 'indexeddb'); }
  catch { /* The primary database works even when browser storage is blocked. */ }
  try { globalThis.localStorage.setItem(RECOVERY_KEY, JSON.stringify(saved)); }
  catch { /* A recovery copy is optional; the committed database is durable. */ }
}

async function localStore(databaseError) {
  let snapshot;
  try { snapshot = readLocal(); }
  catch (error) { return memoryStore([], error.message); }
  const decks = snapshot.value?.decks || snapshot.legacyDecks;
  if (!globalThis.navigator?.locks?.request) {
    return memoryStore(decks, 'The device database and safe cross-tab saving are unavailable. Your saved words can still be studied or exported; new changes cannot be saved. Reopen the app in an updated browser.');
  }
  try {
    const initial = await globalThis.navigator.locks.request(LOCK_NAME, () => {
      const current = readLocal();
      if (current.value) return current.value;
      const next = record(current.legacyDecks);
      current.storage.setItem(STORAGE_KEY, JSON.stringify(next));
      // The fallback record itself also identifies the selected backend if
      // storage fills up before this optional marker can be written.
      try { current.storage.setItem(BACKEND_KEY, 'localstorage'); } catch {}
      return next;
    });
    return writableStore(initial, 'localstorage', 'This device uses browser storage for words. Export regular backups and keep this browser’s site data.', (revision, next) => globalThis.navigator.locks.request(LOCK_NAME, () => {
      const current = readLocal();
      if (!current.value || current.value.revision !== revision) throw stale();
      current.storage.setItem(STORAGE_KEY, JSON.stringify(next));
    }));
  } catch (error) {
    return memoryStore(decks, `${error?.code === 'CORRUPT_STORAGE' ? error.message : 'Safe device storage is unavailable. Saved words can still be studied or exported, but new changes cannot be saved.'}${databaseError?.code === 'DATABASE_BLOCKED' ? ` ${databaseError.message}` : ''}`);
  }
}

async function selectStore() {
  let previousBackend;
  try {
    previousBackend = globalThis.localStorage.getItem(BACKEND_KEY);
    // A fallback remains authoritative across launches. Automatically moving
    // between backends during a transient failure could resurrect stale data.
    if (globalThis.localStorage.getItem(STORAGE_KEY) !== null) return localStore();
  } catch { /* IndexedDB may still be available. */ }
  let database;
  try { database = await openDatabase(); }
  catch (error) {
    return previousBackend === 'indexeddb'
      ? recoveryStore(error?.code === 'DATABASE_BLOCKED' ? error.message : 'The device database is temporarily unavailable.')
      : localStore(error);
  }
  try {
    let warning;
    const initial = await transact(database, saved => {
      if (saved !== undefined) return { result: validateRecord(saved) };
      let local;
      try { local = readLocal(); }
      catch (error) {
        if (error.code === 'CORRUPT_STORAGE') throw error;
        warning = 'Older browser storage could not be checked. New words will be saved in the device database; keep backups of any words from earlier versions.';
      }
      const next = record(local?.value?.decks || local?.legacyDecks || []);
      // Retain the original localStorage entry as a recovery copy. IndexedDB
      // becomes authoritative only after this transaction has committed.
      return { result: next, write: next };
    });
    rememberDatabase(initial);
    return writableStore(initial, 'indexeddb', warning, async (revision, next) => {
      await transact(database, saved => {
        if (!saved) throw stale();
        const current = validateRecord(saved);
        if (current.revision !== revision) throw stale();
        return { write: next };
      });
      rememberDatabase(next);
    });
  } catch (error) {
    database.close();
    // An existing but malformed database must never be replaced by an empty
    // collection or by an older localStorage migration snapshot.
    if (error.code === 'CORRUPT_STORAGE' || error.code === 'INVALID_DATA' || error.code === 'TOO_LARGE') {
      return recoveryStore('Saved data could not be read safely.');
    }
    return previousBackend === 'indexeddb' ? recoveryStore('The device database is temporarily unavailable.') : localStore(error);
  }
}

export async function openDeckStore() {
  // Coordinate backend selection as well as fallback saves across app windows.
  // IndexedDB transactions protect normal saving even without the Locks API.
  return globalThis.navigator?.locks?.request
    ? globalThis.navigator.locks.request(`${LOCK_NAME}-selection`, selectStore)
    : selectStore();
}
