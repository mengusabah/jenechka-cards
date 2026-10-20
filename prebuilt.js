import { LANGUAGES, languageByCode } from './languages.js';
import { createId, validateDecks } from './data.js';

export const DATA_VERSION = '1';
export const FREQUENCY_SIZES = Object.freeze([10, 50, 100, 250, 500, 1000]);
export const CEFR_LEVELS = Object.freeze(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
export const PREBUILT_LANGUAGES = Object.freeze(LANGUAGES.filter(language =>
  ['en', 'tr', 'de', 'es', 'ru'].includes(language.code)));
const LEVEL_NAMES = ['Beginner', 'Elementary', 'Intermediate', 'Upper intermediate', 'Advanced', 'Proficiency'];
const DATA_ROOT = new URL(`./vocabulary/v${DATA_VERSION}/`, import.meta.url);
export const MAX_VOCABULARY_BYTES = 12 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));

export function cleanStudyText(value) {
  const pairs = new Map([['(', ')'], ['（', '）'], ['[', ']'], ['［', '］'], ['【', '】']]);
  const closings = new Set(pairs.values());
  const stack = [];
  let result = '';
  for (const char of value.normalize('NFC')) {
    if (pairs.has(char)) stack.push(pairs.get(char));
    else if (closings.has(char)) {
      if (stack.at(-1) === char) stack.pop();
    } else if (!stack.length) result += char;
  }
  return result.replace(/\s+/g, ' ').replace(/^[\s;,]+|[\s;,]+$/g, '');
}

function checkLanguage(code) {
  if (!languageByCode(code)) throw new Error('This language is not in the prebuilt library.');
}

export function isPrebuiltPair(source, target) {
  return source !== target && (source === 'tr' || target === 'tr') &&
    PREBUILT_LANGUAGES.some(language => language.code === source) &&
    PREBUILT_LANGUAGES.some(language => language.code === target);
}

export const prebuiltTargets = source => PREBUILT_LANGUAGES.filter(target => isPrebuiltPair(source, target.code));

function checkPair(source, target) {
  checkLanguage(source); checkLanguage(target);
  if (source === target) throw new Error('Choose two different languages.');
  if (!isPrebuiltPair(source, target)) throw new Error('Prebuilt decks currently pair Turkish with English, German, Spanish or Russian.');
}

// A shared string table removes repeated IDs, dictionary URLs and meanings.
// The expanded representation stays identical for study, import and previews.
export function decodeLanguageData(data) {
  if (data?.packing === undefined) return data;
  if (data.packing !== 1 || !Array.isArray(data.strings) ||
      !data.strings.every(value => typeof value === 'string')) throw new Error('Invalid vocabulary encoding.');
  const string = index => {
    if (!Number.isInteger(index) || index < 0 || index >= data.strings.length) throw new Error('Invalid vocabulary string reference.');
    return data.strings[index];
  };
  const strings = indices => {
    if (!Array.isArray(indices)) throw new Error('Invalid vocabulary string list.');
    return indices.map(string);
  };
  const entries = data.entries.map(row => {
    if (!Array.isArray(row) || row.length !== 9) throw new Error('Invalid vocabulary entry encoding.');
    return { id: string(row[0]), senseId: string(row[1]), lemma: string(row[2]), pos: string(row[3]),
      meaning: string(row[4]), grammar: strings(row[5]), sources: strings(row[6]),
      studyText: string(row[7]), attributionUrl: string(row[8]) };
  });
  const entryId = index => {
    if (!Number.isInteger(index) || !entries[index]) throw new Error('Invalid vocabulary entry reference.');
    return entries[index].id;
  };
  const decoded = {
    schema: data.schema, version: data.version, language: data.language, entries,
    translations: data.translations.map(row => {
      if (!Array.isArray(row) || row.length !== 4) throw new Error('Invalid vocabulary translation encoding.');
      return { senseId: string(row[0]), text: string(row[1]), sources: strings(row[2]), attributionUrl: string(row[3]) };
    }),
    frequency: data.frequency.map(([index, rank, source]) => ({ entryId: entryId(index), rank, source: string(source) })),
    cefr: data.cefr.map(row => {
      if (!Array.isArray(row) || ![3, 4].includes(row.length) ||
          (row.length === 4 && ![0, 1].includes(row[3]))) throw new Error('Invalid vocabulary level encoding.');
      return { entryId: entryId(row[0]), level: string(row[1]), source: string(row[2]), estimated: row[3] === 1 };
    }),
    categories: data.categories.map(([index, category]) => ({ entryId: entryId(index), categoryId: string(category) })),
    collections: data.collections.map(([index, collection]) => ({ entryId: entryId(index), collection })),
  };
  validateLanguageData(decoded);
  // Shared immutable library inputs can safely reuse lookup indexes.
  return Object.freeze(decoded);
}

// Only static, versioned, same-site data is requested. No words or user data
// are sent to a dictionary, translation service, or remote account.
export function createLibraryLoader(fetcher = (...args) => fetch(...args)) {
  const files = new Map();
  async function load(file) {
    if (files.has(file)) {
      const promise = files.get(file);
      files.delete(file); files.set(file, promise);
      return promise;
    }
    const promise = (async () => {
      let response;
      try { response = await fetcher(new URL(file, DATA_ROOT), { credentials: 'omit' }); }
      catch { throw new Error('This language pair is not available offline yet. Connect to the internet and try again. Your saved decks are still available in My Decks.'); }
      if (!response.ok) throw new Error('This vocabulary download is unavailable. Connect to the internet and try again.');
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_VOCABULARY_BYTES) throw new Error('This vocabulary file is too large.');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('The vocabulary download could not be read. Try again.'); }
      if (data.schema !== 1 || data.version !== DATA_VERSION) throw new Error('The vocabulary library version does not match this app. Reopen online to update.');
      if (file === 'catalog.json') {
        if (!Array.isArray(data.sources) || !Array.isArray(data.categories)) throw new Error('The vocabulary catalog is incomplete.');
      } else {
        data = decodeLanguageData(data);
        validateLanguageData(data, file.slice(0, -5));
      }
      return data;
    })();
    files.set(file, promise);
    // At most a catalog and four language files stay in application memory.
    while (files.size > 5) files.delete(files.keys().next().value);
    try { return await promise; }
    catch (error) { if (files.get(file) === promise) files.delete(file); throw error; }
  }
  return async (sourceCode, targetCode) => {
    checkPair(sourceCode, targetCode);
    const [catalog, source, target] = await Promise.all([
      load('catalog.json'), load(`${sourceCode}.json`), load(`${targetCode}.json`),
    ]);
    return { catalog, source, target };
  };
}

export function validateLanguageData(data, code = data.language) {
  checkLanguage(code);
  if (data.schema !== 1 || data.version !== DATA_VERSION || data.language !== code ||
      !['entries', 'translations', 'frequency', 'cefr', 'categories'].every(key => Array.isArray(data[key]))) {
    throw new Error('This language file is incomplete.');
  }
  const ids = new Set();
  for (const entry of data.entries) {
    if (!entry.id || ids.has(entry.id) || !entry.senseId || typeof entry.lemma !== 'string' ||
        !entry.lemma.trim() || !Array.isArray(entry.sources)) throw new Error('Invalid vocabulary entry.');
    ids.add(entry.id);
  }
  const senses = new Set();
  for (const translation of data.translations) {
    if (!translation.senseId || senses.has(translation.senseId) || typeof translation.text !== 'string' ||
        !translation.text.trim() || !Array.isArray(translation.sources)) throw new Error('Invalid vocabulary translation.');
    senses.add(translation.senseId);
  }
  for (const record of data.frequency) {
    if (!ids.has(record.entryId) || !Number.isInteger(record.rank) || record.rank < 1 || record.rank > 1000) {
      throw new Error('Invalid target-language frequency rank.');
    }
  }
  for (const record of data.cefr) {
    if (!ids.has(record.entryId) || !CEFR_LEVELS.includes(record.level) ||
        (record.estimated !== undefined && typeof record.estimated !== 'boolean')) throw new Error('Invalid target-language CEFR classification.');
  }
  for (const record of data.categories) {
    if (!ids.has(record.entryId) || !record.categoryId) throw new Error('Invalid vocabulary category.');
  }
  for (const record of data.collections || []) {
    if (!ids.has(record.entryId) || !Number.isInteger(record.collection) || record.collection < 1) {
      throw new Error('Invalid dictionary collection.');
    }
  }
  return data;
}

export function definitions(catalog) {
  return [
    ...FREQUENCY_SIZES.map(size => ({
      id: `frequency-${size}`, kind: 'frequency', selection: String(size),
      name: `From the top ${size}`,
      description: `Dictionary-matched vocabulary within the first ${size} target-language subtitle tokens. Original corpus ranks are preserved; this is a translated subset, not a complete top-${size} word list.`,
    })),
    ...CEFR_LEVELS.map((level, i) => ({
      id: `cefr-${level}`, kind: 'cefr', selection: level,
      name: `${level} · ${LEVEL_NAMES[i]}`,
      description: 'Vocabulary grouped by target-language learning level. Published word-level classifications are used where available; other levels are editorial estimates. Lower levels are not repeated.',
    })),
    ...catalog.categories.map(category => ({
      id: `topic-${category.id}`, kind: 'topic', selection: category.id,
      name: category.name, description: category.description, context: category.kind === 'context',
    })),
    ...Array.from({ length: catalog.collections || 0 }, (_, i) => ({
      id: `dictionary-${i + 1}`, kind: 'dictionary', selection: i + 1,
      name: `Dictionary · ${String(i + 1).padStart(2, '0')}`,
      description: `Dictionary words and meanings in smaller editable packs. Each pack contains up to ${catalog.collectionSize || 500} target entries with translations in your selected language.`,
    })),
  ];
}

const indexCache = new WeakMap();
function indexes(data) {
  if (Object.isFrozen(data) && indexCache.has(data)) return indexCache.get(data);
  const result = {
    entries: new Map(data.entries.map(entry => [entry.id, entry])),
    translations: new Map(data.translations.map(item => [item.senseId, item])),
    selections: new Map(),
  };
  if (Object.isFrozen(data)) indexCache.set(data, result);
  return result;
}

function targetSelection(target, definition) {
  const index = indexes(target);
  if (index.selections.has(definition.id)) return index.selections.get(definition.id);
  const entries = index.entries;
  let selected;
  if (definition.kind === 'frequency') {
    // Select by TARGET rank before joining any source-language translations.
    // Multiple senses of one surface form must not inflate a Top-N subset.
    const forms = new Map();
    const ranks = new Set();
    selected = target.frequency.filter(record => record.rank <= Number(definition.selection))
      .sort((a, b) => a.rank - b.rank)
      .flatMap(record => {
        const entry = entries.get(record.entryId);
        let form = entry.lemma.normalize('NFC').replaceAll('\u0301', '').toLocaleLowerCase(target.language);
        if (target.language === 'ar') form = form.replace(/[\u064b-\u065f\u0670]/g, '');
        if (forms.has(form)) {
          forms.get(form).alternatives.push(entry);
          return [];
        }
        if (ranks.has(record.rank)) return [];
        const item = { entry, alternatives: [entry], rank: record.rank, metadataSource: record.source };
        forms.set(form, item); ranks.add(record.rank);
        return [item];
      });
  } else {
    const records = definition.kind === 'cefr'
    ? target.cefr.filter(record => record.level === definition.selection)
    : definition.kind === 'dictionary'
    ? (target.collections || []).filter(record => record.collection === definition.selection)
    : target.categories.filter(record => record.categoryId === definition.selection);
    const seen = new Set();
    selected = records.flatMap(record => {
      if (seen.has(record.entryId)) return [];
      seen.add(record.entryId);
      return [{ entry: entries.get(record.entryId), metadataSource: record.source, estimated: record.estimated === true }];
    });
  }
  if (Object.isFrozen(target)) index.selections.set(definition.id, selected);
  return selected;
}

export function buildTemplate(library, definition) {
  const { source, target, catalog } = library;
  checkPair(source.language, target.language);
  const translations = indexes(source).translations;
  const selected = targetSelection(target, definition);
  const seen = new Set();
  const sourceIds = new Set();
  const pages = new Map();
  let missing = 0;
  const cards = selected.flatMap(({ entry, rank, metadataSource, estimated }) => {
    // Keep the selected target meaning identical for every translation
    // language. A missing translation must not turn "can" (ability) into a tin
    // or "what" into an alphabet name just to fill a corpus position.
    const translation = translations.get(entry.senseId);
    if (!translation) { missing++; return []; }
    const answer = cleanStudyText(entry.studyText || entry.lemma);
    const question = cleanStudyText(translation.text);
    if (!answer || !question) { missing++; return []; }
    const key = JSON.stringify([question, answer]);
    if (seen.has(key)) return [];
    seen.add(key);
    [...entry.sources, ...translation.sources, metadataSource].filter(Boolean).forEach(id => sourceIds.add(id));
    for (const record of [entry, translation]) {
      if (record.attributionUrl) for (const source of record.sources) {
        if (!pages.has(source)) pages.set(source, new Set());
        pages.get(source).add(record.attributionUrl);
      }
    }
    return [{
      entryId: entry.id, senseId: entry.senseId, front: question, back: answer,
      pos: entry.pos, meaning: entry.meaning, grammar: entry.grammar || [], rank, estimated: estimated === true,
    }];
  });
  const corpusLimit = definition.kind === 'frequency' ? Number(definition.selection) : null;
  return {
    ...definition,
    templateId: `${source.language}_${target.language}_${definition.id}`,
    version: DATA_VERSION, sourceCode: source.language, targetCode: target.language,
    sourceName: languageByCode(source.language).name, targetName: languageByCode(target.language).name,
    targetCount: selected.length, missingTranslations: missing,
    combinedDuplicates: selected.length - missing - cards.length, cards,
    estimatedCount: cards.filter(card => card.estimated).length,
    partial: corpusLimit !== null ? cards.length < corpusLimit : missing > 0,
    corpusLimit,
    sources: catalog.sources.filter(source => sourceIds.has(source.id))
      .map(source => ({ ...source, pages: [...(pages.get(source.id) || [])].sort() })),
  };
}

export const hasImported = (decks, template) =>
  decks.some(deck => deck.prebuilt?.templateId === template.templateId);

function selectableCards(template) {
  if (!Array.isArray(template?.cards) || !template.cards.length) {
    throw new Error('There are no translated cards in this deck.');
  }
  const ids = new Set();
  for (const card of template.cards) {
    if (typeof card?.entryId !== 'string' || !card.entryId || ids.has(card.entryId)) {
      throw new Error('This deck contains invalid or repeated word IDs. Reload the library and try again.');
    }
    ids.add(card.entryId);
  }
  return template.cards;
}

// A partial Fisher–Yates shuffle gives each word the same chance of inclusion.
// Work on IDs so the shared library template and its card order stay untouched.
export function sampleTemplateCards(template, count, random = Math.random) {
  const cards = selectableCards(template);
  if (!Number.isInteger(count) || count < 1 || count > cards.length) {
    throw new Error(`Choose a whole number from 1 to ${cards.length.toLocaleString('en-US')}.`);
  }
  if (typeof random !== 'function') throw new Error('A random number generator is required.');
  const ids = cards.map(card => card.entryId);
  for (let i = 0; i < count; i++) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error('The random number generator must return a value from 0 up to, but not including, 1.');
    }
    const selected = i + Math.floor(value * (ids.length - i));
    [ids[i], ids[selected]] = [ids[selected], ids[i]];
  }
  return ids.slice(0, count);
}

export function importTemplate(template, existing = []) {
  checkPair(template.sourceCode, template.targetCode);
  if (!template.cards.length) throw new Error('There are no translated cards in this deck.');
  if (hasImported(existing, template)) throw new Error('This prebuilt deck is already in My Decks, even if you renamed or edited it.');
  return copiedTemplateDeck(template, `${template.name} · ${template.targetName}`);
}

export function importTemplateSelection(template, entryIds, { name } = {}) {
  checkPair(template.sourceCode, template.targetCode);
  const cards = selectableCards(template);
  if (!Array.isArray(entryIds) || !entryIds.length) throw new Error('Choose at least one word for your deck.');
  const selected = new Set(entryIds);
  if (selected.size !== entryIds.length) throw new Error('Each word can only be selected once.');
  const available = new Set(cards.map(card => card.entryId));
  if (entryIds.some(id => typeof id !== 'string' || !available.has(id))) {
    throw new Error('A selected word is no longer in this deck. Choose your words again.');
  }
  const chosen = cards.filter(card => selected.has(card.entryId));
  const subset = {
    ...template,
    // Each selection is an independent editable deck. It must neither block a
    // full-template import nor prevent creating another selection later.
    templateId: `subset_${createId()}`,
    cards: chosen,
    estimatedCount: chosen.filter(card => card.estimated).length,
  };
  const title = name === undefined
    ? `${template.name} · ${chosen.length} ${chosen.length === 1 ? 'word' : 'words'} · ${template.targetName}`
    : name;
  return copiedTemplateDeck(subset, title);
}

function copiedTemplateDeck(template, name) {
  const deck = {
    id: createId(),
    name,
    source: template.sourceName, target: template.targetName,
    cards: template.cards.map(card => ({ id: createId(), front: card.front, back: card.back })),
    prebuilt: {
      templateId: template.templateId, version: template.version,
      sourceLanguage: template.sourceCode, targetLanguage: template.targetCode,
      title: template.name,
      notice: 'Copied from a prebuilt template; the user may have edited these cards. Dataset licenses and attribution apply to the original vocabulary. App code is licensed separately.' +
        (template.estimatedCount ? ` ${template.estimatedCount} of ${template.cards.length} level assignments are editorial estimates, not official CEFR classifications.` : ''),
      sources: template.sources.map(source => ({
        name: source.name, url: source.url, license: source.license, licenseUrl: source.licenseUrl,
        attribution: source.attribution, modifications: source.modifications || source.methodology,
        pages: source.pages || [],
      })),
    },
  };
  return validateDecks([clone(deck)])[0];
}

export { LANGUAGES };
