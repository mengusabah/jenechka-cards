import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS, makeBackup, parseBackup, validateDecks } from '../data.js';
import { hasImported, importTemplate, importTemplateSelection, sampleTemplateCards } from '../prebuilt.js';

function template() {
  return {
    templateId: 'en_tr_topic-fruits', version: '1', name: 'Fruit',
    sourceCode: 'en', targetCode: 'tr', sourceName: 'English', targetName: 'Turkish',
    estimatedCount: 2,
    cards: [
      { entryId: 'tr_apple', front: 'apple', back: 'elma', estimated: true },
      { entryId: 'tr_pear', front: 'pear', back: 'armut', estimated: false },
      { entryId: 'tr_mango', front: 'mango', back: 'mango', estimated: true },
      { entryId: 'tr_peach', front: 'peach', back: 'şeftali', estimated: false },
    ],
    sources: [{
      name: 'Fixture dictionary', url: 'https://example.org/dictionary', license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'Fixture dictionary contributors.', modifications: 'Reviewed and translated for study.',
      pages: ['https://example.org/dictionary/apple', 'https://example.org/dictionary/pear'],
    }],
  };
}

test('random selection returns the requested number of unique entry IDs without changing the template', () => {
  const input = template();
  const before = structuredClone(input);
  for (const count of [1, 2, input.cards.length]) {
    for (const value of [0, 0.25, 0.5, 0.999999999]) {
      const ids = sampleTemplateCards(input, count, () => value);
      assert.equal(ids.length, count);
      assert.equal(new Set(ids).size, count);
      assert.ok(ids.every(id => input.cards.some(card => card.entryId === id)));
    }
  }
  assert.deepEqual(input, before);
  assert.deepEqual(new Set(sampleTemplateCards(input, input.cards.length)), new Set(input.cards.map(card => card.entryId)));
});

test('every equally likely draw path gives an unbiased two-word selection', () => {
  const input = template();
  input.cards = input.cards.slice(0, 3);
  const outcomes = new Map();
  for (let first = 0; first < 3; first++) {
    for (let second = 0; second < 2; second++) {
      const draws = [(first + 0.5) / 3, (second + 0.5) / 2];
      const ids = sampleTemplateCards(input, 2, () => draws.shift()).sort().join(',');
      outcomes.set(ids, (outcomes.get(ids) || 0) + 1);
    }
  }
  assert.equal(outcomes.size, 3);
  assert.deepEqual([...outcomes.values()], [2, 2, 2]);
});

test('random selection validates size, input integrity and generator values', () => {
  const input = template();
  for (const count of [0, -1, 1.5, 5, NaN, Infinity, '2', null, undefined]) {
    assert.throws(() => sampleTemplateCards(input, count), /whole number/);
  }
  assert.throws(() => sampleTemplateCards({ ...input, cards: [] }, 1), /no translated cards/);
  assert.throws(() => sampleTemplateCards({ ...input, cards: [input.cards[0], input.cards[0]] }, 1), /repeated word IDs/);
  assert.throws(() => sampleTemplateCards({ ...input, cards: [{ front: 'apple', back: 'elma' }] }, 1), /invalid/);
  assert.throws(() => sampleTemplateCards(input, 1, null), /generator/);
  for (const value of [-0.1, 1, NaN, Infinity, '0.5']) {
    assert.throws(() => sampleTemplateCards(input, 1, () => value), /generator/);
  }
});

test('manual selection copies exactly the selected words in library order and stays independently editable', () => {
  const input = template();
  const before = structuredClone(input);
  const deck = importTemplateSelection(input, ['tr_mango', 'tr_apple'], { name: 'My first fruits' });
  assert.equal(deck.name, 'My first fruits');
  assert.equal(deck.source, 'English');
  assert.equal(deck.target, 'Turkish');
  assert.deepEqual(deck.cards.map(({ front, back }) => [front, back]), [['apple', 'elma'], ['mango', 'mango']]);
  assert.notEqual(deck.cards[0].id, input.cards[0].entryId);
  assert.match(deck.prebuilt.notice, /2 of 2 level assignments/);
  assert.deepEqual(input, before);
  deck.cards[0].back = 'Edited apple';
  deck.prebuilt.sources[0].pages.push('https://example.org/new');
  assert.deepEqual(input, before);
});

test('subset creation can repeat and coexist with a full import without marking the original imported', () => {
  const input = template();
  const first = importTemplateSelection(input, ['tr_pear']);
  const second = importTemplateSelection(input, ['tr_pear']);
  const allSelected = importTemplateSelection(input, input.cards.map(card => card.entryId));
  assert.equal(first.name, 'Fruit · 1 word · Turkish');
  assert.equal(allSelected.name, 'Fruit · 4 words · Turkish');
  assert.equal(hasImported([first, second, allSelected], input), false);
  const full = importTemplate(input, [first, second, allSelected]);
  assert.equal(hasImported([first, second, full], input), true);
  const afterFull = importTemplateSelection(input, ['tr_mango']);
  const decks = validateDecks([first, second, allSelected, full, afterFull]);
  assert.equal(new Set(decks.map(deck => deck.id)).size, decks.length);
  assert.equal(new Set(decks.map(deck => deck.prebuilt.templateId)).size, decks.length);
  const cardIds = decks.flatMap(deck => deck.cards.map(card => card.id));
  assert.equal(new Set(cardIds).size, cardIds.length);
  for (const deck of decks) assert.match(deck.prebuilt.templateId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.throws(() => importTemplate(input, decks), /already in My Decks/);
});

test('subset attribution and exact card content survive export and import', () => {
  const input = template();
  const deck = importTemplateSelection(input, ['tr_peach', 'tr_pear', 'tr_mango']);
  assert.equal(deck.prebuilt.title, input.name);
  assert.deepEqual(deck.prebuilt.sources, input.sources);
  assert.match(deck.prebuilt.notice, /1 of 3 level assignments/);
  const restored = parseBackup(JSON.stringify(makeBackup([deck])));
  assert.deepEqual(restored, [deck]);
  assert.equal(hasImported(restored, input), false);
  const unestimated = importTemplateSelection(input, ['tr_pear']);
  assert.doesNotMatch(unestimated.prebuilt.notice, /level assignments/);
});

test('selection rejects invalid IDs and names and keeps the current language-pair restriction', () => {
  const input = template();
  for (const ids of [[], undefined, null, 'tr_apple']) {
    assert.throws(() => importTemplateSelection(input, ids), /at least one word/);
  }
  assert.throws(() => importTemplateSelection(input, ['tr_apple', 'tr_apple']), /only be selected once/);
  for (const ids of [['unknown'], ['tr_apple', 'unknown'], [null], [1], [{}]]) {
    assert.throws(() => importTemplateSelection(input, ids), /no longer in this deck/);
  }
  for (const name of ['', '   ', null, 5, 'a'.repeat(LIMITS.name + 1)]) {
    assert.throws(() => importTemplateSelection(input, ['tr_apple'], { name }));
  }
  assert.equal(importTemplateSelection(input, ['tr_apple'], { name: 'a'.repeat(LIMITS.name) }).name.length, LIMITS.name);
  assert.throws(() => importTemplateSelection({ ...input, sourceCode: 'de', targetCode: 'en' }, ['tr_apple']), /Turkish/);
});
