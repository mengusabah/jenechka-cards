import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  CEFR_LEVELS, DATA_VERSION, FREQUENCY_SIZES, LANGUAGES, buildTemplate,
  createLibraryLoader, definitions, hasImported, importTemplate, validateLanguageData,
  decodeLanguageData, MAX_VOCABULARY_BYTES, cleanStudyText, isPrebuiltPair, prebuiltTargets, PREBUILT_LANGUAGES,
} from '../prebuilt.js';
import { LANGUAGES as SHARED_LANGUAGES } from '../languages.js';
import { createId, makeBackup, openDeckStore, parseBackup, validateDecks } from '../data.js';
import { createStudySession, rateStudyCard } from '../study.js';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const catalog = await json('../vocabulary/v1/catalog.json');
const encodedData = Object.fromEntries(await Promise.all(LANGUAGES.map(async ({ code }) =>
  [code, await json(`../vocabulary/v1/${code}.json`)])));
const languageData = Object.fromEntries(Object.entries(encodedData).map(([code, data]) => [code, decodeLanguageData(data)]));
const frequencyInput = await json('../vocabulary/source-data/frequency.json');
const cefrInput = await json('../vocabulary/source-data/cefr.json');
const levelInput = await json('../vocabulary/source-data/levels.json');
const lexiconInput = await json('../vocabulary/source-data/lexicon.json');
const allDefinitions = definitions(catalog);
const byDefinition = id => {
  const definition = allDefinitions.find(item => item.id === id);
  assert.ok(definition, `Missing definition: ${id}`);
  return definition;
};
const library = (source, target) => ({ catalog, source: languageData[source], target: languageData[target] });
const normalizedForm = (value, language) => {
  let result = value.normalize('NFC').replaceAll('\u0301', '').toLocaleLowerCase(language);
  if (language === 'ar') result = result.replace(/[\u064b-\u065f\u0670]/g, '');
  return result;
};
const unique = values => new Set(values).size === values.length;
const sourceNotice = {
  id: 'fixture', name: 'Fixture vocabulary', url: 'https://example.org/vocabulary',
  license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Test fixture authors.', methodology: 'Original test data with explicit meanings.',
};
const emptyLanguage = language => ({
  schema: 1, version: DATA_VERSION, language, entries: [], translations: [], frequency: [], cefr: [], categories: [],
});
const entry = (id, senseId, lemma, changes = {}) => ({
  id, senseId, lemma, pos: 'noun', meaning: senseId, sources: ['fixture'], ...changes,
});
const translation = (senseId, text) => ({ senseId, text, sources: ['fixture'] });
function fixture() {
  const en = emptyLanguage('en');
  const tr = emptyLanguage('tr');
  en.entries = [entry('en_apple', 'apple-fruit', 'apple'), entry('en_cat', 'cat-animal', 'cat')];
  tr.entries = [entry('tr_apple', 'apple-fruit', 'elma'), entry('tr_cat', 'cat-animal', 'kedi')];
  en.translations = [translation('apple-fruit', 'apple'), translation('cat-animal', 'cat')];
  tr.translations = [translation('apple-fruit', 'elma'), translation('cat-animal', 'kedi')];
  en.frequency = [{ entryId: 'en_cat', rank: 1, source: 'fixture' }, { entryId: 'en_apple', rank: 2, source: 'fixture' }];
  tr.frequency = [{ entryId: 'tr_apple', rank: 1, source: 'fixture' }, { entryId: 'tr_cat', rank: 90, source: 'fixture' }];
  tr.categories = tr.entries.map(item => ({ entryId: item.id, categoryId: 'fruits' }));
  return {
    catalog: { schema: 1, version: DATA_VERSION, sources: [sourceNotice], categories: catalog.categories },
    source: en, target: tr,
  };
}
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function localFetcher() {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(await json(`../vocabulary/v1/${new URL(url).pathname.split('/').at(-1)}`));
    },
  };
}

test('all 13 shared languages have versioned, internally consistent generated files and honest coverage', async () => {
  assert.equal(LANGUAGES, SHARED_LANGUAGES);
  assert.equal(LANGUAGES.length, 13);
  assert.ok(unique(LANGUAGES.map(item => item.code)));
  const files = await readdir(new URL('../vocabulary/v1/', import.meta.url));
  assert.deepEqual(files.filter(file => file.endsWith('.json')).sort(),
    ['catalog.json', ...LANGUAGES.map(item => `${item.code}.json`)].sort());
  assert.equal(catalog.schema, 1);
  assert.equal(catalog.version, DATA_VERSION);
  assert.ok(unique(catalog.sources.map(item => item.id)));
  assert.ok(unique(catalog.categories.map(item => item.id)));
  const sourceIds = new Set(catalog.sources.map(item => item.id));
  const categories = new Set(catalog.categories.map(item => item.id));
  for (const { code } of LANGUAGES) {
    const data = languageData[code];
    assert.equal(validateLanguageData(data, code), data);
    assert.ok(data.entries.length > 9000, `${code}: expanded dictionary coverage regressed`);
    assert.ok(unique(data.entries.map(item => item.id)), code);
    assert.ok(unique(data.translations.map(item => item.senseId)), code);
    assert.ok(unique(data.categories.map(item => `${item.entryId}:${item.categoryId}`)), code);
    for (const row of [...data.entries, ...data.translations]) {
      assert.ok(row.sources.length > 0);
      assert.ok(row.sources.every(id => sourceIds.has(id)), `${code}: unknown provenance`);
    }
    for (const row of data.categories) assert.ok(categories.has(row.categoryId), `${code}: unknown category`);
    const levels = Object.fromEntries(CEFR_LEVELS.map(level => [level, data.cefr.filter(row => row.level === level).length])
      .filter(([, count]) => count));
    assert.deepEqual(catalog.coverage[code], {
      entries: data.entries.length, translations: data.translations.length,
      frequencyEntries: data.frequency.length, cefr: levels,
      estimatedCefr: data.cefr.filter(row => row.estimated).length,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(encodedData[code])) <= MAX_VOCABULARY_BYTES, `${code}: excessive download size`);
  }
});

test('all 8 supported ordered language pairs contain actual topic cards in the selected languages', () => {
  const topics = allDefinitions.filter(item => item.kind === 'topic');
  let pairs = 0;
  for (const source of LANGUAGES) {
    for (const target of LANGUAGES) {
      if (!isPrebuiltPair(source.code, target.code)) continue;
      pairs++;
      const current = library(source.code, target.code);
      const templates = topics.map(definition => buildTemplate(current, definition));
      assert.ok(templates.some(template => template.cards.length > 0), `${source.code} → ${target.code}: no real topic cards`);
      const translations = new Map(current.source.translations.map(item => [item.senseId, item.text]));
      const targetEntries = new Map(current.target.entries.map(item => [item.id, item]));
      for (const template of templates) {
        assert.equal(template.sourceName, source.name);
        assert.equal(template.targetName, target.name);
        assert.ok(unique(template.cards.map(card => card.entryId)));
        assert.ok(unique(template.cards.map(card => JSON.stringify([card.front.normalize('NFC'), card.back.normalize('NFC')]))));
        for (const card of template.cards) {
          const targetEntry = targetEntries.get(card.entryId);
          assert.equal(card.front, translations.get(card.senseId), `${source.code}: source text is not its translation`);
          assert.equal(card.back, targetEntry.studyText || targetEntry.lemma, `${target.code}: target text mismatch`);
        }
      }
    }
  }
  assert.equal(pairs, 8);
});

test('prebuilt selection and direct template imports allow only Turkish pairs while saved decks stay editable', async () => {
  const pairs = [];
  for (const source of LANGUAGES) {
    assert.deepEqual(prebuiltTargets(source.code).map(item => item.code),
      source.code === 'tr' ? ['en', 'de', 'es', 'ru'] : ['en', 'de', 'es', 'ru'].includes(source.code) ? ['tr'] : []);
    for (const target of LANGUAGES) {
      const supported = source.code !== target.code && [source.code, target.code].includes('tr') &&
        [source.code, target.code].every(code => ['tr', 'en', 'de', 'es', 'ru'].includes(code));
      assert.equal(isPrebuiltPair(source.code, target.code), supported);
      if (supported) pairs.push([source.code, target.code]);
      else assert.throws(() => buildTemplate(library(source.code, target.code), byDefinition('topic-fruits')));
    }
  }
  assert.equal(pairs.length, 8);
  assert.deepEqual(catalog.supportedPairs, pairs);
  const template = buildTemplate(fixture(), byDefinition('topic-fruits'));
  assert.throws(() => importTemplate({ ...template, sourceCode: 'de', targetCode: 'en' }), /Turkish/);
  const saved = importTemplate(template);
  saved.source = 'German'; saved.target = 'English';
  saved.prebuilt.sourceLanguage = 'de'; saved.prebuilt.targetLanguage = 'en';
  saved.prebuilt.templateId = 'de_en_topic-fruits';
  saved.cards[0] = { ...saved.cards[0], front: 'Apfel', back: 'apple' };
  assert.deepEqual(parseBackup(JSON.stringify(makeBackup([saved]))), [saved]);
  assert.deepEqual(validateDecks([{ id: 'custom', name: 'Custom', source: 'German', target: 'Spanish',
    cards: [{ id: 'word', front: 'Apfel', back: 'manzana' }] }])[0].target, 'Spanish');
});

test('frequency metadata matches each target language original token ranks without filling or re-ranking', () => {
  for (const { code } of PREBUILT_LANGUAGES) {
    const data = languageData[code];
    const entries = new Map(data.entries.map(item => [item.id, item]));
    const original = frequencyInput.languages[code];
    assert.equal(original.length, 1000);
    for (const row of data.frequency) {
      const token = original[row.rank - 1];
      assert.equal(row.source, 'frequencywords');
      assert.equal(token.rank, row.rank);
      assert.equal(normalizedForm(entries.get(row.entryId).lemma, code), normalizedForm(token.word, code),
        `${code}: rank ${row.rank} belongs to a different target word`);
    }
    const sourceCode = code === 'tr' ? 'en' : 'tr';
    let previous = new Set();
    for (const limit of FREQUENCY_SIZES) {
      const definition = byDefinition(`frequency-${limit}`);
      const template = buildTemplate(library(sourceCode, code), definition);
      const current = new Set(template.cards.map(card => card.entryId));
      assert.ok([...previous].every(id => current.has(id)), `${code}: cumulative ${limit} subset lost a word`);
      assert.ok(template.cards.every(card => card.rank <= limit));
      assert.ok(template.cards.length <= limit);
      assert.equal(template.corpusLimit, limit);
      assert.equal(template.partial, template.cards.length < limit);
      const forms = template.cards.map(card => normalizedForm(entries.get(card.entryId).lemma, code));
      assert.ok(unique(forms), `${code}: repeated surface forms inflated a frequency deck`);
      for (const alternative of LANGUAGES.filter(item => isPrebuiltPair(item.code, code) && item.code !== sourceCode)) {
        const other = buildTemplate(library(alternative.code, code), definition);
        assert.equal(other.targetCount, template.targetCount, 'source translations must not change target selection');
      }
      previous = current;
    }
  }
});

test('reversing languages uses independent target rankings and source rankings have no effect', () => {
  const data = fixture();
  const top10 = byDefinition('frequency-10');
  assert.deepEqual(buildTemplate(data, top10).cards.map(card => [card.front, card.back, card.rank]), [['apple', 'elma', 1]]);
  const reversed = buildTemplate({ ...data, source: data.target, target: data.source }, top10);
  assert.deepEqual(reversed.cards.map(card => [card.front, card.back, card.rank]), [['kedi', 'cat', 1], ['elma', 'apple', 2]]);
  data.source.frequency = [];
  assert.deepEqual(buildTemplate(data, top10).cards.map(card => card.back), ['elma']);
});

test('frequency selection collapses equivalent written forms and shared ranks before translation joins', () => {
  const data = fixture();
  data.source.language = 'tr';
  data.target.language = 'ru';
  data.target.entries = [
    entry('ru_a', 'first-sense', 'во́да'),
    entry('ru_b', 'second-sense', 'вода'),
    entry('ru_c', 'third-sense', 'other form at same rank'),
    entry('ru_d', 'last-sense', 'кот'),
  ];
  data.target.frequency = data.target.entries.map((item, index) => ({
    entryId: item.id, rank: index < 3 ? 7 : 9, source: 'fixture',
  }));
  data.source.translations = [translation('second-sense', 'water'), translation('last-sense', 'cat')];
  const selected = buildTemplate(data, byDefinition('frequency-10'));
  assert.equal(selected.targetCount, 2);
  assert.equal(selected.missingTranslations, 1);
  assert.deepEqual(selected.cards.map(card => [card.entryId, card.rank]), [['ru_d', 9]]);
  data.source.translations.push(translation('first-sense', 'water'));
  const withTranslation = buildTemplate(data, byDefinition('frequency-10'));
  assert.equal(withTranslation.targetCount, selected.targetCount);
  assert.deepEqual(withTranslation.cards.map(card => [card.entryId, card.rank]), [['ru_a', 7], ['ru_d', 9]]);

});

test('missing translations remain missing without English fallback or replacement from lower ranks', () => {
  const data = fixture();
  data.source.language = 'de';
  data.source.translations = [translation('cat-animal', 'Katze')];
  const top10 = buildTemplate(data, byDefinition('frequency-10'));
  assert.equal(top10.targetCount, 1);
  assert.equal(top10.missingTranslations, 1);
  assert.deepEqual(top10.cards, []);
  assert.equal(top10.partial, true);
  assert.throws(() => importTemplate(top10), /no translated cards/i);
  const top100 = buildTemplate(data, byDefinition('frequency-100'));
  assert.deepEqual(top100.cards.map(card => [card.front, card.back, card.rank]), [['Katze', 'kedi', 90]]);
  assert.equal(top100.missingTranslations, 1);
});

test('empty language datasets yield empty previews without fabricated cards', () => {
  const data = fixture();
  data.target = emptyLanguage('tr');
  assert.doesNotThrow(() => validateLanguageData(data.target));
  for (const definition of allDefinitions) {
    const template = buildTemplate(data, definition);
    assert.equal(template.targetCount, 0);
    assert.equal(template.cards.length, 0);
    assert.throws(() => importTemplate(template), /no translated cards/i);
  }
});

test('published CEFR labels retain their exact native sources and estimates stay explicitly separate', () => {
  const englishEntries = new Map(languageData.en.entries.map(item => [item.id, item]));
  const posNames = { adj: 'adjective', adv: 'adverb', intj: 'interjection', num: 'number',
    pron: 'pronoun', prep: 'preposition', conj: 'conjunction', det: 'determiner' };
  const classified = new Map();
  for (const [source, rows] of [['cefrj', cefrInput.english], ['octanove', levelInput.english]]) {
    for (const row of rows) {
      const key = `${normalizedForm(row.lemma, 'en')}:${row.pos}`;
      if (!classified.has(key)) classified.set(key, []);
      classified.get(key).push({ ...row, source });
    }
  }
  assert.ok(languageData.en.cefr.length > 0);
  for (const row of languageData.en.cefr) {
    if (row.estimated) {
      assert.equal(row.source, 'jenechka-estimates');
      continue;
    }
    const item = englishEntries.get(row.entryId);
    const matching = classified.get(`${normalizedForm(item.lemma, 'en')}:${posNames[item.pos] || item.pos}`) || [];
    assert.ok(matching.some(item => item.source === row.source));
    assert.ok(matching.length > 0);
    assert.deepEqual([...new Set(matching.map(item => item.level))], [row.level]);
  }
  const russianSources = new Map(cefrInput.russian.map(item => [item.id, item]));
  const russianEntries = new Map(languageData.ru.entries.map(item => [item.id, item]));
  assert.ok(languageData.ru.cefr.length > 0);
  for (const row of languageData.ru.cefr) {
    if (row.estimated) {
      assert.equal(row.source, 'jenechka-estimates');
      continue;
    }
    const item = russianEntries.get(row.entryId);
    const original = russianSources.get(item.senseId);
    assert.ok(original, 'Russian CEFR needs a Russian source lexeme');
    assert.equal(row.source, 'smartool');
    assert.equal(row.level, original.level);
    assert.equal(item.lemma, cleanStudyText(original.lemma));
    assert.equal(item.pos, original.pos);
  }
  for (const { code } of LANGUAGES) {
    assert.equal(languageData[code].cefr.length, languageData[code].entries.length);
    assert.ok(unique(languageData[code].cefr.map(row => row.entryId)));
    if (!['en', 'ru'].includes(code)) assert.ok(languageData[code].cefr.every(row => row.estimated && row.source === 'jenechka-estimates'));
    if (!PREBUILT_LANGUAGES.some(language => language.code === code)) continue;
    const sourceCode = code === 'tr' ? 'en' : 'tr';
    const seen = new Set();
    for (const level of CEFR_LEVELS) {
      const template = buildTemplate(library(sourceCode, code), byDefinition(`cefr-${level}`));
      const allowed = new Set(languageData[code].cefr.filter(row => row.level === level).map(row => row.entryId));
      for (const card of template.cards) {
        assert.ok(allowed.has(card.entryId));
        assert.ok(!seen.has(card.entryId), 'CEFR decks must not repeat whole lower-level decks');
        seen.add(card.entryId);
      }
    }
  }
});

test('SMARTool English glosses do not create English entries, ranks, or CEFR labels', () => {
  const russianSenseIds = new Set(cefrInput.russian.map(item => item.id));
  assert.ok(languageData.en.translations.some(item => russianSenseIds.has(item.senseId)));
  assert.ok(languageData.en.entries.every(item => !russianSenseIds.has(item.senseId)));
  const template = buildTemplate(library('tr', 'ru'), byDefinition('cefr-A1'));
  assert.ok(template.cards.length > 0, 'shared multilingual Russian entries now have estimated levels');
  assert.ok(template.cards.every(card => !russianSenseIds.has(card.senseId)), 'Russian-only English glosses cannot be silently shown to Turkish speakers');
  assert.ok(template.missingTranslations > 0);
});

test('categories are many-to-many and gardening includes actions and qualities alongside nouns', () => {
  const concepts = new Map(lexiconInput.concepts.map(item => [item.id, item]));
  const apple = concepts.get('apple-fruit');
  assert.ok(apple);
  for (const category of ['fruits', 'food-drinks', 'gardening']) assert.ok(apple.categories.includes(category));
  const source = languageData.en;
  const gardeningIds = new Set(source.categories.filter(item => item.categoryId === 'gardening').map(item => item.entryId));
  const partsOfSpeech = new Set(source.entries.filter(item => gardeningIds.has(item.id)).map(item => item.pos));
  assert.ok(partsOfSpeech.has('noun'));
  assert.ok(partsOfSpeech.has('verb'));
  assert.ok(partsOfSpeech.has('adj') || partsOfSpeech.has('adjective'));
  assert.ok(source.entries.some(item => item.lemma.includes(' ')), 'library includes useful expressions');
  const template = buildTemplate(library('tr', 'en'), byDefinition('topic-gardening'));
  assert.ok(template.cards.length > 0);
  assert.ok(template.cards.every(card => gardeningIds.has(card.entryId)));
});

test('expanded familiar topics have real multilingual coverage and reject unrelated inherited sense topics', () => {
  for (const target of ['tr', 'de']) {
    for (const [topic, minimum] of [['animals', 60], ['fruits', 15], ['vegetables', 15], ['gardening', 60]]) {
      const template = buildTemplate(library(target === 'tr' ? 'en' : 'tr', target), byDefinition(`topic-${topic}`));
      assert.ok(template.cards.length >= minimum, `${target}/${topic}: familiar topic coverage regressed`);
    }
  }
  for (const [senseId, correct] of [
    ['bulk-f5f4206ca3d5fd661daac77c', 'family'],
    ['bulk-7ef49ac056613448b6faa466', 'professions'],
  ]) {
    const item = languageData.en.entries.find(row => row.senseId === senseId);
    assert.ok(item);
    const categories = languageData.en.categories.filter(row => row.entryId === item.id).map(row => row.categoryId);
    assert.ok(categories.includes(correct));
    assert.ok(!categories.includes('technology'), 'A different parent sense must not supply its topic');
  }
});

test('reviewed Turkish source errors use attested alternatives or remain unavailable', () => {
  const translations = new Map(languageData.tr.translations.map(row => [row.senseId, row.text]));
  assert.equal(translations.get('bulk-e8dfbc2bf7ebcd49199161fa'), 'tabak');
  assert.equal(translations.get('bulk-812c7f0929e026130796a683'), 'pişirmek');
  assert.equal(translations.get('bulk-3fe94f39e4d5e79cfd3592f7'), 'makas');
  for (const id of ['bulk-68a9ca01adf31566a5d1024d', 'bulk-acc7e432ecb2f15bec8f0632',
    'bulk-1801adc8ccc2bb682f6f1776', 'bulk-32ac7ac54bf1986cc9192b1c']) {
    assert.ok(!translations.has(id), `${id}: rejected translation must not be offered as a study answer`);
    assert.ok(!languageData.tr.entries.some(row => row.senseId === id));
  }
});

test('bank meanings remain separate in metadata while study faces stay free of explanations', () => {
  const bank = languageData.en.entries.filter(item => item.lemma === 'bank' && item.sources.includes('wiktionary-kaikki'));
  assert.ok(bank.length >= 2, 'the reviewed seed must include separate financial and river bank meanings');
  assert.ok(unique(bank.map(item => item.senseId)));
  assert.ok(unique(bank.map(item => item.meaning)), 'bank metadata must retain distinct meanings');
  for (const item of bank) {
    assert.ok(item.studyText && item.studyText.includes('bank'));
    const sourceLanguage = LANGUAGES.find(({ code }) => isPrebuiltPair(code, 'en') &&
      languageData[code].translations.some(translation => translation.senseId === item.senseId));
    if (!sourceLanguage) continue;
    const category = languageData.en.categories.find(row => row.entryId === item.id);
    assert.ok(category);
    const template = buildTemplate(library(sourceLanguage.code, 'en'), byDefinition(`topic-${category.categoryId}`));
    const card = template.cards.find(card => card.senseId === item.senseId);
    assert.ok(card);
    assert.equal(card.back, item.studyText);
    const imported = importTemplate(template);
    assert.ok(imported.cards.some(card => card.back === item.studyText));
  }
});

test('parenthetical sense and grammar annotations are removed only from prebuilt study faces', () => {
  const data = fixture();
  data.target.language = 'en';
  data.source.language = 'tr';
  data.target.entries = [
    entry('en_finance', 'bank-finance', 'bank', { studyText: 'bank (financial institution)' }),
    entry('en_river', 'bank-river', 'bank', { studyText: 'bank (river edge)' }),
    entry('en_apple', 'apple-fruit', 'apple', { studyText: 'apple (noun)', grammar: ['noun'] }),
  ];
  data.target.categories = data.target.entries.map(item => ({ entryId: item.id, categoryId: 'fruits' }));
  data.source.translations = [
    translation('bank-finance', 'banka (finans)'), translation('bank-river', 'kıyı'), translation('apple-fruit', 'elma（meyve）'),
  ];
  const template = buildTemplate(data, byDefinition('topic-fruits'));
  assert.equal(template.cards.length, 3);
  assert.deepEqual(template.cards.map(card => card.back),
    ['bank', 'bank', 'apple']);
  assert.deepEqual(template.cards.map(card => card.front), ['banka', 'kıyı', 'elma']);
  assert.deepEqual(template.cards[2].grammar, ['noun']);
  assert.equal(data.target.entries[0].lemma, 'bank');
  assert.deepEqual(importTemplate(template).cards.map(card => card.back), template.cards.map(card => card.back));
});

test('duplicate rows and identical translated pairs cannot inflate a topic deck', () => {
  const data = fixture();
  data.target.entries.push(entry('tr_other_apple', 'same-apple-text', 'elma'));
  data.source.translations.push(translation('same-apple-text', 'apple'));
  data.target.categories.push(
    { entryId: 'tr_apple', categoryId: 'fruits' },
    { entryId: 'tr_other_apple', categoryId: 'fruits' },
  );
  const template = buildTemplate(data, byDefinition('topic-fruits'));
  assert.deepEqual(template.cards.map(card => [card.front, card.back]), [['apple', 'elma'], ['cat', 'kedi']]);
});

test('language validation rejects duplicate IDs, dangling references, invalid ranks and invalid levels', () => {
  const good = fixture().target;
  const cases = [
    data => { data.schema = 2; },
    data => { data.version = '2'; },
    data => { data.language = 'en'; },
    data => { data.entries.push(structuredClone(data.entries[0])); },
    data => { data.entries[0].lemma = ' '; },
    data => { data.translations.push(structuredClone(data.translations[0])); },
    data => { data.translations[0].text = ''; },
    data => { data.frequency[0].entryId = 'not-an-entry'; },
    data => { data.frequency[0].rank = 0; },
    data => { data.frequency[0].rank = 1001; },
    data => { data.frequency[0].rank = 1.5; },
    data => { data.cefr.push({ entryId: 'tr_apple', level: 'C3' }); },
    data => { data.categories[0].categoryId = ''; },
  ];
  for (const mutate of cases) {
    const invalid = structuredClone(good);
    mutate(invalid);
    assert.throws(() => validateLanguageData(invalid, 'tr'));
  }
  assert.throws(() => validateLanguageData(emptyLanguage('xx')), /not in the prebuilt library/);
});

test('imports copy templates, retain attribution through versioned backup, and prevent duplicates after editing', () => {
  const template = buildTemplate(library('tr', 'en'), byDefinition('topic-gardening'));
  const original = structuredClone(template);
  const custom = { id: 'existing-custom', name: 'Custom', source: 'Turkish', target: 'English', cards: [] };
  const existing = [custom];
  const imported = importTemplate(template, existing);
  assert.equal(existing.length, 1);
  assert.equal(existing[0], custom);
  assert.ok(unique([imported.id, ...imported.cards.map(card => card.id)]));
  assert.notEqual(imported.cards[0], template.cards[0]);
  imported.name = 'My revised garden words';
  imported.cards[0].front = 'My own translation';
  imported.cards[0].back = 'My own word';
  imported.cards.push({ id: createId(), front: 'Yeni kart', back: 'New card' });
  imported.prebuilt.sources[0].name = 'Edited local attribution label';
  assert.deepEqual(template, original);
  assert.equal(hasImported([custom, imported], template), true);
  assert.throws(() => importTemplate(template, [custom, imported]), /already in My Decks/);
  const backup = makeBackup([custom, imported]);
  assert.equal(backup.version, 1);
  assert.deepEqual(parseBackup(JSON.stringify(backup)), [custom, imported]);
  const withoutImported = [custom, imported].filter(deck => deck.id !== imported.id);
  const fresh = importTemplate(template, withoutImported);
  assert.notEqual(fresh.id, imported.id);
  assert.notEqual(fresh.cards[0].id, imported.cards[0].id);
  assert.equal(fresh.cards[0].front, template.cards[0].front);
  assert.deepEqual(fresh.prebuilt.sources, importTemplate(template).prebuilt.sources);
});

test('dictionary entry attribution is deduplicated and survives copied decks and JSON backup', () => {
  const data = fixture();
  data.target.entries[0].attributionUrl = 'https://en.wiktionary.org/wiki/apple';
  data.source.translations[0].attributionUrl = 'https://en.wiktionary.org/wiki/apple';
  data.target.entries[1].attributionUrl = 'https://en.wiktionary.org/wiki/cat';
  const template = buildTemplate(data, byDefinition('topic-fruits'));
  assert.deepEqual(template.sources[0].pages,
    ['https://en.wiktionary.org/wiki/apple', 'https://en.wiktionary.org/wiki/cat']);
  const imported = importTemplate(template);
  assert.deepEqual(imported.prebuilt.sources[0].pages, template.sources[0].pages);
  assert.notEqual(imported.prebuilt.sources[0].pages, template.sources[0].pages);
  assert.deepEqual(parseBackup(JSON.stringify(makeBackup([imported]))), [imported]);
  imported.prebuilt.sources[0].pages.pop();
  assert.equal(template.sources[0].pages.length, 2);
});

test('imported decks use the existing persistence path and can be edited, deleted, and reimported', async t => {
  const values = new Map();
  const mocks = {
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    indexedDB: undefined,
    navigator: { locks: { request: async (_name, callback) => callback() } },
  };
  for (const [name, value] of Object.entries(mocks)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  const template = buildTemplate(library('en', 'tr'), byDefinition('topic-fruits'));
  const imported = importTemplate(template);
  const store = await openDeckStore();
  await store.save([imported]);
  const reopened = await openDeckStore();
  assert.deepEqual(reopened.decks, [imported]);
  const edited = structuredClone(reopened.decks);
  edited[0].name = 'Personal fruit vocabulary';
  edited[0].cards[0].back = 'Custom answer';
  edited[0].cards.push({ id: createId(), front: 'An added card', back: 'Eklenmiş kart' });
  await reopened.save(edited);
  assert.deepEqual((await openDeckStore()).decks, edited);
  await reopened.save([]);
  const empty = await openDeckStore();
  assert.deepEqual(empty.decks, []);
  await empty.save([importTemplate(template, empty.decks)]);
  assert.equal((await openDeckStore()).decks[0].cards[0].back, template.cards[0].back);
});

test('imported cards work in forward, reverse, and mixed study with both sides preserved', () => {
  const imported = importTemplate(buildTemplate(library('tr', 'de'), byDefinition('topic-gardening')));
  for (const mode of ['forward', 'reverse', 'mixed']) {
    const session = createStudySession(imported.cards, mode, () => 0.5);
    assert.equal(session.total, imported.cards.length * (mode === 'mixed' ? 2 : 1));
    for (const card of imported.cards) {
      const queued = session.queue.filter(item => item.id === card.id);
      assert.equal(queued.length, mode === 'mixed' ? 2 : 1);
      assert.ok(queued.every(item => item.front === card.front && item.back === card.back));
      if (mode === 'mixed') assert.deepEqual(new Set(queued.map(item => item.reverse)), new Set([false, true]));
    }
    while (session.queue.length) {
      session.flipped = true;
      rateStudyCard(session, 'good');
    }
    assert.equal(session.done, session.total);
  }
});

test('dataset attribution rejects unsafe URLs instead of preserving them in exported decks', () => {
  const imported = importTemplate(buildTemplate(fixture(), byDefinition('topic-fruits')));
  for (const field of ['url', 'licenseUrl', 'pages']) {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hello', 'file:///private/file', 'http://example.org/data', '//example.org/data', 'not a URL']) {
      const changed = structuredClone(imported);
      changed.prebuilt.sources[0][field] = field === 'pages' ? [bad] : bad;
      assert.throws(() => validateDecks([changed]), /HTTPS URL/);
      assert.throws(() => parseBackup(JSON.stringify([changed])), /HTTPS URL/);
    }
  }
  for (const pages of ['https://example.org/entry', Array(10001).fill('https://example.org/entry')]) {
    const changed = structuredClone(imported);
    changed.prebuilt.sources[0].pages = pages;
    assert.throws(() => validateDecks([changed]));
  }
});

test('the loader starts lazily and requests only catalog plus the two selected language files', async () => {
  const network = localFetcher();
  const load = createLibraryLoader(network.fetch);
  assert.equal(network.calls.length, 0);
  const result = await load('tr', 'de');
  assert.equal(result.source.language, 'tr');
  assert.equal(result.target.language, 'de');
  assert.deepEqual(network.calls.map(call => new URL(call.url).pathname.split('/').at(-1)).sort(),
    ['catalog.json', 'de.json', 'tr.json']);
  assert.ok(network.calls.every(call => call.url.includes('/vocabulary/v1/') && call.options.credentials === 'omit'));
  await load('de', 'tr');
  assert.equal(network.calls.length, 3);
  await load('tr', 'es');
  assert.equal(network.calls.length, 4);
  assert.ok(network.calls.every(call => !call.url.includes('source-data')));
});

test('loader errors can be retried without discarding successful language downloads', async () => {
  const calls = new Map();
  let failTarget = true;
  const load = createLibraryLoader(async url => {
    const file = new URL(url).pathname.split('/').at(-1);
    calls.set(file, (calls.get(file) || 0) + 1);
    if (file === 'de.json' && failTarget) throw new TypeError('Network disconnected');
    return response(file === 'catalog.json' ? catalog : encodedData[file.slice(0, -5)]);
  });
  await assert.rejects(load('tr', 'de'), /not available offline.*Connect to the internet.*My Decks/);
  failTarget = false;
  assert.equal((await load('tr', 'de')).target.language, 'de');
  assert.equal(calls.get('catalog.json'), 1);
  assert.equal(calls.get('tr.json'), 1);
  assert.equal(calls.get('de.json'), 2);
});

test('loader rejects invalid pairs without downloads and rejects malformed or oversized downloads', async () => {
  let calls = 0;
  const load = createLibraryLoader(async () => { calls++; return response(catalog); });
  for (const pair of [['en', 'en'], ['xx', 'en'], ['en', '../../backup'], ['en', 'de'], ['ja', 'ko'], ['tr', 'ja'], ['fr', 'tr']]) {
    await assert.rejects(load(...pair));
  }
  assert.equal(calls, 0);
  const invalid = [
    new Response('unavailable', { status: 503 }),
    new Response('{'),
    response({ ...catalog, schema: 2 }),
    response({ ...catalog, version: 'old' }),
    response({ schema: 1, version: DATA_VERSION, sources: [] }),
    response({ ...catalog, padding: 'é'.repeat(MAX_VOCABULARY_BYTES / 2) }),
  ];
  for (const bad of invalid) {
    const loader = createLibraryLoader(async url => new URL(url).pathname.endsWith('/catalog.json')
      ? bad.clone() : response(encodedData[new URL(url).pathname.split('/').at(-1).slice(0, -5)]));
    await assert.rejects(loader('tr', 'en'));
  }
});

test('compact files reject broken string and entry references before any import', () => {
  const mutations = [
    data => { data.packing = 2; },
    data => { data.strings[0] = 3; },
    data => { data.entries[0][2] = data.strings.length; },
    data => { data.translations[0][0] = -1; },
    data => { data.frequency[0][0] = data.entries.length; },
    data => { data.collections[0][1] = 0; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(encodedData.tr);
    mutate(data);
    assert.throws(() => decodeLanguageData(data));
  }
});

test('dictionary packs expose every target entry once, in bounded editable selections', () => {
  const dictionary = allDefinitions.filter(definition => definition.kind === 'dictionary');
  for (const { code } of PREBUILT_LANGUAGES) {
    const data = languageData[code];
    assert.equal(data.collections.length, data.entries.length);
    assert.ok(unique(data.collections.map(row => row.entryId)));
    const source = code === 'tr' ? 'en' : 'tr';
    let available = 0;
    for (const definition of dictionary) {
      const template = buildTemplate(library(source, code), definition);
      assert.ok(template.targetCount <= 500);
      assert.ok(template.cards.length <= 500);
      available += template.cards.length;
    }
    assert.ok(available > 6000, `${source} → ${code}: expanded translations inaccessible`);
  }
  const template = buildTemplate(library('tr', 'en'), dictionary[0]);
  const copied = importTemplate(template);
  assert.deepEqual(parseBackup(JSON.stringify(makeBackup([copied]))), [copied]);
});

test('Asian dictionary study faces omit readings but retain entry attribution without becoming English headwords', () => {
  const englishSenseIds = new Set(languageData.en.entries.map(row => row.senseId));
  for (const code of ['zh', 'ja', 'ko', 'ar']) {
    const records = languageData[code].entries.filter(row =>
      row.sources.some(source => ['cc-cedict', 'jmdict', 'wiktionary-korean', 'wiktionary-arabic'].includes(source)));
    assert.ok(records.length > 2000);
    for (const row of records) {
      assert.ok(!englishSenseIds.has(row.senseId));
      if (['ko', 'ar'].includes(code)) assert.ok(row.attributionUrl.startsWith('https://en.wiktionary.org/wiki/'));
    }
    assert.ok(records.every(row => row.studyText === row.lemma));
  }
});

test('larger CEFR decks retain complete entry credits through the existing backup limit', () => {
  for (const level of CEFR_LEVELS) {
    const template = buildTemplate(library('tr', 'en'), byDefinition(`cefr-${level}`));
    assert.ok(template.cards.length > 300, `${level}: insufficient source-backed translation coverage`);
    const imported = importTemplate(template);
    assert.deepEqual(parseBackup(JSON.stringify(makeBackup([imported]))), [imported]);
  }
});

test('all six learning levels are usable across all 8 supported pairs and estimates survive import', () => {
  for (const { code: target } of LANGUAGES) {
    for (const { code: source } of LANGUAGES) {
      if (!isPrebuiltPair(source, target)) continue;
      for (const level of CEFR_LEVELS) {
        const template = buildTemplate(library(source, target), byDefinition(`cefr-${level}`));
        assert.ok(template.cards.length > 0, `${source} → ${target}/${level}: empty learning band`);
        assert.equal(template.estimatedCount, template.cards.filter(card => card.estimated).length);
        if (!['en', 'ru'].includes(target)) assert.equal(template.estimatedCount, template.cards.length);
      }
    }
  }
  const estimate = buildTemplate(library('en', 'tr'), byDefinition('cefr-C2'));
  assert.ok(estimate.sources.some(source => source.id === 'jenechka-estimates'));
  assert.match(importTemplate(estimate).prebuilt.notice, /editorial estimates/);
});

test('every generated study face is free of parenthesized annotations without altering custom cards', () => {
  const annotations = /[()[\]（）［］【】]/u;
  for (const { code } of LANGUAGES) {
    for (const row of languageData[code].entries) {
      assert.ok(!annotations.test(row.studyText || row.lemma), `${code}/${row.id}: annotated study face`);
    }
    for (const row of languageData[code].translations) {
      assert.ok(!annotations.test(row.text), `${code}/${row.senseId}: annotated translation`);
    }
  }
  assert.equal(cleanStudyText('bank (finance (noun)) ［note］'), 'bank');
  assert.equal(cleanStudyText('苹果（píngguǒ）'), '苹果');
  assert.equal(cleanStudyText(' (only an explanation) '), '');
  const custom = validateDecks([{ id: 'custom', name: 'Mine', source: 'English', target: 'Turkish',
    cards: [{ id: 'mine', front: 'bank (river)', back: 'kıyı (benim notum)' }] }]);
  assert.equal(custom[0].cards[0].front, 'bank (river)');
  assert.equal(custom[0].cards[0].back, 'kıyı (benim notum)');
});

test('reported mistranslations and alphabet-name leakage cannot re-enter the library', () => {
  for (const { code } of LANGUAGES) {
    assert.ok(!languageData[code].entries.some(row => row.senseId === 'bulk-48f03be0d56e76b2a19981a9'));
  }
  const tr = new Map(languageData.tr.translations.map(row => [row.senseId, row.text]));
  assert.equal(tr.get('bulk-65dba546840519c704dcb356'), 'yazar');
  const top = (source, target) => buildTemplate(library(source, target), byDefinition('frequency-100'));
  assert.equal(top('en', 'tr').cards.find(card => card.back === 'ne').front, 'what');
  assert.equal(top('tr', 'en').cards.find(card => card.back === 'what').front, 'ne');
  assert.equal(top('tr', 'en').cards.find(card => card.back === 'can').front, 'yapabilmek');
  assert.equal(top('en', 'tr').cards.find(card => card.back === 'sen').front, 'you');
});

test('everyday Turkish words retain the right sense in both directions and across deck sections', () => {
  const cases = [
    ['bulk-8941d9c2ad24b7aa530af33b', 'salmon', 'somon'],
    ['bulk-f2a30fec070d00afc4f9d74a', 'beaver', 'kunduz'],
    ['bulk-63c3e9437e3b30a41cc36746', 'rabbit', 'tavşan'],
    ['bulk-aec7b2e7c7b2b0ba497c6d2a', 'ape', 'kuyruksuz maymun'],
    ['bulk-a5d4d53906f2e1ce81ca55ca', 'berry', 'üzümsü meyve'],
    ['bulk-b3be37f871eb3c46c44f9b17', 'mango', 'mango'],
    ['bulk-cd2c2c455de2f6b0e21e7507', 'squash', 'kabak'],
    ['bulk-536036daebe9cd5f8249ebfe', 'corn', 'mısır'],
    ['bulk-f78fa64bc9395f0498fae713', 'grain', 'tahıl'],
    ['bulk-d0e572d35d9ad514c19db373', 'farmer', 'çiftçi'],
    ['bulk-7ef49ac056613448b6faa466', 'interpreter', 'sözlü çevirmen'],
    ['bulk-6ab1aed77d72a6246764b8a0', 'dentist', 'dişçi'],
    ['physician-profession', 'doctor', 'doktor'],
    ['bulk-9449f99bf464c14720b98d0d', 'builder', 'inşaatçı'],
    ['bulk-b91e0b655d6cff561adac9ee', 'carpenter', 'marangoz'],
    ['bulk-0374526211efd035c3fbd041', 'engineer', 'mühendis'],
    ['bulk-4570f2b1bc003ac8e01a2aa9', 'entrepreneur', 'girişimci'],
    ['bulk-710407034e2e0888102f355b', 'hairdresser', 'kuaför'],
    ['bulk-09b3b02e23ecbf0287172960', 'barber', 'berber'],
    ['bulk-92868c2fb73d98594010e1eb', 'monk', 'keşiş'],
    ['bulk-70c43022c52544e32d136093', 'scientist', 'bilim adamı'],
    ['bulk-1ccc27be5bf359fcdbcaddd3', 'programmer', 'yazılımcı'],
    ['bulk-5e474a2859cd201485e40d48', 'driver', 'şoför'],
    ['bulk-3fd45009ab07873ed483aa80', 'watering can', 'sulama kabı'],
  ];
  for (const [sense, english, turkish] of cases) {
    for (const [source, target, front, back] of [['en', 'tr', english, turkish], ['tr', 'en', turkish, english]]) {
      const entry = languageData[target].entries.find(row => row.senseId === sense);
      assert.ok(entry, `${target}/${sense}`);
      const topic = languageData[target].categories.find(row => row.entryId === entry.id);
      const level = languageData[target].cefr.find(row => row.entryId === entry.id);
      const pack = languageData[target].collections.find(row => row.entryId === entry.id);
      for (const id of [`topic-${topic.categoryId}`, `cefr-${level.level}`, `dictionary-${pack.collection}`]) {
        const template = buildTemplate(library(source, target), byDefinition(id));
        assert.ok(template.cards.some(card => card.front === front && card.back === back),
          `${source}/${target}/${id}: ${english} ↔ ${turkish}`);
      }
    }
  }
});

test('pair review decisions preserve provenance and exclude malformed examples', async () => {
  const review = await json('../vocabulary/source-data/pair-corrections.json');
  assert.deepEqual(review.pairs.map(pair => pair.pair), [['en', 'tr'], ['tr', 'de'], ['tr', 'es'], ['tr', 'ru']]);
  assert.ok(review.pairs.every(pair => pair.reviewed === pair.total && pair.total > 10000));
  const indexes = Object.fromEntries(Object.entries(languageData).map(([code, data]) => [code, {
    entries: new Map(data.entries.map(row => [row.senseId, row])),
    translations: new Map(data.translations.map(row => [row.senseId, row])),
    classified: new Set(data.cefr.map(row => row.entryId)),
  }]));
  for (const decision of review.corrections) {
    const data = indexes[decision.language];
    const translation = data.translations.get(decision.conceptId);
    assert.equal(translation?.text, decision.replacementText);
    assert.ok(translation.sources.includes('jenechka-editorial'));
    const entry = data.entries.get(decision.conceptId);
    if (entry) {
      assert.equal(entry.lemma, decision.replacementText);
      assert.equal(entry.studyText, decision.replacementText);
      assert.ok(entry.sources.includes('jenechka-editorial'));
      assert.ok(data.classified.has(entry.id));
    }
  }
  for (const decision of review.exclusions) {
    const data = indexes[decision.language];
    assert.ok(!data.entries.has(decision.conceptId));
    assert.ok(!data.translations.has(decision.conceptId));
  }
  for (const decision of review.meaningCorrections) {
    for (const data of Object.values(indexes)) {
      const entry = data.entries.get(decision.conceptId);
      if (entry) assert.equal(entry.meaning, decision.replacementText);
    }
  }
});

test('shared Turkish decisions preserve pronoun register and verb direction in every active pair', () => {
  const cases = [
    ['bulk-4c838c876c0a45948e6af0fc', { tr: 'sen', en: 'you', de: 'du', es: 'tú', ru: 'ты' }],
    ['bulk-f28468cb75f9b1b919ddca58', { tr: 'seni', en: 'you', de: 'dich', es: 'te', ru: 'тебя' }],
    ['bulk-e025a7b4463bfa2ad1498d31', { tr: 'giydirmek', en: 'attire', de: 'anziehen', es: 'vestir', ru: 'одевать' }],
    ['bulk-26213bb095afa629ec246a8d', { tr: 'sallanmak', en: 'rock', de: 'schwanken', es: 'mecerse', ru: 'качаться' }],
    ['bulk-e5bf4bc5a5e8448a03ec4528', { tr: 'genişlemek', en: 'extend', de: 'sich erweitern', es: 'extenderse', ru: 'расширяться' }],
    ['bulk-f954396b861520d7ca4c93c5', { tr: 'karıştırarak pişirmek', en: 'scramble', de: 'unter Rühren garen', es: 'cocinar removiendo', ru: 'готовить, помешивая' }],
  ];
  for (const [senseId, forms] of cases) {
    for (const [code, text] of Object.entries(forms)) {
      assert.equal(languageData[code].translations.find(row => row.senseId === senseId)?.text, text);
      assert.equal(languageData[code].entries.find(row => row.senseId === senseId)?.studyText, text);
    }
    for (const code of ['en', 'de', 'es', 'ru']) {
      for (const [source, target] of [['tr', code], [code, 'tr']]) {
        const data = languageData[target];
        const entry = data.entries.find(row => row.senseId === senseId);
        const pack = data.collections.find(row => row.entryId === entry.id);
        const template = buildTemplate(library(source, target), byDefinition(`dictionary-${pack.collection}`));
        assert.ok(template.cards.some(card => card.front === forms[source] && card.back === forms[target]));
      }
    }
  }
});

test('estimated beginner anchors do not leak into technical homonyms or diacritic collisions', () => {
  const level = (language, sense) => {
    const data = languageData[language];
    const entry = data.entries.find(row => row.senseId === sense);
    assert.ok(entry, `${language}/${sense}: missing regression sense`);
    return data.cefr.find(row => row.entryId === entry.id);
  };
  for (const code of ['fr', 'de', 'it', 'pt', 'ru', 'es', 'tr']) {
    assert.notEqual(level(code, 'bulk-8059753803c79601d021435a').level, 'A1', 'physics work is not the everyday work anchor');
  }
  assert.notEqual(level('ar', 'bulk-077df0f3e465fa1cd6420258').level, 'A1', 'ionize is not where');
  assert.notEqual(level('ja', 'jmdict:1304970:2559bd0cb3b4').level, 'A1', 'physics tags must also block the ordinary work anchor');
  assert.equal(level('ar', 'editorial-core-where').level, 'A1');
});

test('sparse everyday topics now contain useful multilingual vocabulary and original modern additions', () => {
  for (const { code } of PREBUILT_LANGUAGES) {
    const source = code === 'tr' ? 'en' : 'tr';
    for (const [topic, min] of [['clothing', 40], ['agriculture', 35], ['hobbies', 45],
      ['technology', 65], ['sports', 55], ['furniture', 30]]) {
      const template = buildTemplate(library(source, code), byDefinition(`topic-${topic}`));
      assert.ok(template.cards.length >= min, `${code}/${topic}: ${template.cards.length} < ${min}`);
    }
    const modern = languageData[code].entries.find(row => row.senseId === 'editorial-power-bank');
    assert.ok(modern);
    assert.deepEqual(modern.sources, ['jenechka-editorial']);
  }
});

test('the loader bounds memory by evicting older language downloads while reusing active pair files', async () => {
  const network = localFetcher();
  const load = createLibraryLoader(network.fetch);
  for (const target of ['en', 'de', 'ru', 'es']) await load('tr', target);
  const count = file => network.calls.filter(call => call.url.endsWith(`/${file}.json`)).length;
  assert.equal(count('catalog'), 1);
  assert.equal(count('en'), 1);
  assert.equal(count('tr'), 1);
  await load('en', 'tr');
  assert.equal(count('en'), 2);
  assert.equal(count('catalog'), 1);
  assert.equal(count('tr'), 1);
});
