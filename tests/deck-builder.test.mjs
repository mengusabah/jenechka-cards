import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectionState, filterSelectionCards } from '../deck-builder.js';

const cards = [
  { entryId: 'light', front: 'light', back: 'ışık' },
  { entryId: 'city', front: 'city', back: 'İzmir' },
  { entryId: 'bird', front: 'small bird', back: 'küçük kuş' },
  { entryId: 'child', front: 'child', back: 'niño' },
  { entryId: 'street', front: 'street', back: 'Straße' },
];
const ids = results => results.map(card => card.entryId);

test('word selection search handles Turkish dotted and dotless I and accent-free typing', () => {
  for (const query of ['ışık', 'IŞIK', 'ISIK', '  ışIk  ']) {
    assert.deepEqual(ids(filterSelectionCards(cards, query)), ['light']);
  }
  for (const query of ['izmir', 'İZMİR', 'IZMIR']) {
    assert.deepEqual(ids(filterSelectionCards(cards, query)), ['city']);
  }
  assert.deepEqual(ids(filterSelectionCards(cards, 'kucuk kus')), ['bird']);
  assert.deepEqual(ids(filterSelectionCards(cards, 'nino')), ['child']);
  assert.deepEqual(ids(filterSelectionCards(cards, 'STRASSE')), ['street']);
});

test('multiword search requires every term within the same card and searches both sides', () => {
  const before = structuredClone(cards);
  assert.deepEqual(ids(filterSelectionCards(cards, 'small kuş')), ['bird']);
  assert.deepEqual(ids(filterSelectionCards(cards, '  KUS\tBIRD\n küçük ')), ['bird']);
  assert.deepEqual(ids(filterSelectionCards(cards, 'light izmir')), []);
  assert.deepEqual(ids(filterSelectionCards(cards, 'unmatched')), []);
  assert.deepEqual(filterSelectionCards(cards, ' \t\n'), cards);
  assert.deepEqual(cards, before);
});

test('initial selection state samples up to 25 real words and keeps manual selection empty', () => {
  for (const length of [1, 5, 25, 250]) {
    const template = Object.freeze({ templateId: 'en_tr_topic-fixture', cards: Object.freeze(
      Array.from({ length }, (_, i) => Object.freeze({ entryId: `word-${i}`, front: `word ${i}`, back: `kelime ${i}` }))) });
    for (const mode of ['random', 'manual']) {
      const state = createSelectionState(template, mode);
      assert.equal(state.templateId, template.templateId);
      assert.equal(state.mode, mode);
      assert.equal(state.count, String(Math.min(length, 25)));
      assert.equal(state.randomIds.length, Math.min(length, 25));
      assert.equal(new Set(state.randomIds).size, state.randomIds.length);
      assert.ok(state.randomIds.every(id => template.cards.some(card => card.entryId === id)));
      assert.deepEqual([...state.manualIds], []);
      assert.equal(state.query, '');
      assert.equal(state.selectedOnly, false);
      assert.equal(state.page, 0);
      assert.equal(state.name, '');
    }
  }
});

test('selection state is independent for every builder session, including empty templates', () => {
  const template = { templateId: 'en_tr_topic-fixture', cards };
  const first = createSelectionState(template, 'manual');
  const second = createSelectionState(template, 'random');
  const secondBefore = structuredClone(second);
  first.manualIds.add('light');
  first.randomIds.length = 0;
  first.query = 'bird'; first.name = 'Favorites'; first.page = 2;
  assert.deepEqual(second, secondBefore);
  assert.deepEqual(template.cards, cards);
  const empty = createSelectionState({ templateId: 'empty', cards: [] }, 'random');
  assert.equal(empty.count, '0');
  assert.deepEqual(empty.randomIds, []);
  assert.equal(empty.manualIds.size, 0);
});
