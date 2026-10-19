import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BACKUP_BYTES, LIMITS, createId, makeBackup, mergeDecks, parseBackup, validateDecks } from '../data.js';

const deck = (changes = {}) => ({
  id: 'deck-1', name: 'Everyday words', source: 'English', target: 'Türkçe',
  cards: [{ id: 'card-1', front: "What's new?", back: 'Ne var ne yok? 👋' }],
  ...changes,
});

test('versioned and legacy backups round-trip Unicode, apostrophes, and plain HTML text', () => {
  const decks = [deck({ cards: [{ id: 'card-1', front: "<script>alert('hello')</script>", back: 'İstanbul, العربية, 日本語 🧠\nNext line' }] })];
  const backup = makeBackup(decks);
  assert.equal(backup.format, 'jenechka-cards');
  assert.equal(backup.version, 1);
  assert.ok(Number.isFinite(Date.parse(backup.exportedAt)));
  assert.deepEqual(parseBackup(JSON.stringify(backup)), decks);
  assert.deepEqual(parseBackup(JSON.stringify(decks)), decks);
  assert.deepEqual(parseBackup('\uFEFF' + JSON.stringify(backup)), decks);
});

test('canonical output copies only supported fields and never mutates input', () => {
  const decks = [deck({ unknown: '<img src=x onerror=alert(1)>', cards: [{ id: 'card-1', front: '  word  ', back: ' çeviri ', unknown: true }] })];
  const canonical = validateDecks(decks);
  assert.equal(canonical[0].cards[0].front, '  word  ');
  assert.equal(canonical[0].unknown, undefined);
  assert.equal(canonical[0].cards[0].unknown, undefined);
  canonical[0].cards[0].front = 'changed';
  assert.equal(decks[0].cards[0].front, '  word  ');
  const proto = parseBackup('[{"id":"safe","name":"Words","source":"en","target":"tr","cards":[],"__proto__":{"polluted":true}}]');
  assert.equal(proto[0].polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('empty collections and zero-card decks remain valid', () => {
  assert.deepEqual(parseBackup('[]'), []);
  assert.deepEqual(parseBackup(JSON.stringify([deck({ cards: [] })])), [deck({ cards: [] })]);
});

test('malformed JSON, unsupported versions, missing fields, and invalid types reject the whole backup', () => {
  for (const input of ['{', 'null', '42', '"decks"', '{}']) assert.throws(() => parseBackup(input));
  assert.throws(() => parseBackup(23));
  for (const change of [{ format: 'another-app' }, { version: 2 }, { version: '1' }, { exportedAt: 'not-a-date' }, { exportedAt: undefined }, { decks: {} }]) {
    assert.throws(() => parseBackup(JSON.stringify({ ...makeBackup([deck()]), ...change })));
  }
  for (const change of [{ name: '' }, { name: '\n  ' }, { source: 3 }, { target: null }, { cards: null }, { cards: [{}] }, { cards: [{ id: 'a', front: '', back: 'x' }] }, { cards: [{ id: 'a', front: 'x', back: '\t' }] }]) {
    assert.throws(() => validateDecks([deck({ id: 'valid' }), deck({ id: 'invalid', ...change })]));
  }
});

test('hostile and duplicate IDs are rejected before use in dataset selectors', () => {
  for (const unsafe of ['x" onclick="alert(1)', 'a[b]', '<script>', '', 'has space', '日本語', 'a'.repeat(129), 12, null]) {
    assert.throws(() => validateDecks([deck({ id: unsafe })]));
    assert.throws(() => validateDecks([deck({ cards: [{ id: unsafe, front: 'a', back: 'b' }] })]));
  }
  assert.throws(() => validateDecks([deck(), deck()]), /duplicate deck ID/);
  assert.throws(() => validateDecks([deck({ cards: [{ id: 'same', front: 'a', back: 'b' }, { id: 'same', front: 'c', back: 'd' }] })]), /duplicate card ID/);
  assert.doesNotThrow(() => validateDecks([deck({ id: 'A_0-z' })]));
  assert.match(createId(), /^[A-Za-z0-9_-]{1,128}$/);
});

test('merge preserves existing decks, skips exact-content duplicates, and replaces colliding IDs', () => {
  const existing = [deck()];
  const incoming = [
    deck({ id: 'duplicate-content', cards: [{ id: 'other-card', front: "What's new?", back: 'Ne var ne yok? 👋' }] }),
    deck({ name: 'Different words', cards: [{ id: 'card-1', front: 'cat', back: 'kedi' }] }),
    deck({ id: 'fresh-deck', name: 'Fresh', cards: [{ id: 'fresh-card', front: 'dog', back: 'köpek' }] }),
    deck({ id: 'duplicate-within-import', name: 'Fresh', cards: [{ id: 'other-fresh-card', front: 'dog', back: 'köpek' }] }),
  ];
  const result = mergeDecks(existing, incoming);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.decks[0], existing[0]);
  assert.notEqual(result.decks[1].id, 'deck-1');
  assert.notEqual(result.decks[1].cards[0].id, 'card-1');
  assert.equal(result.decks[2].id, 'fresh-deck');
  assert.equal(result.decks[2].cards[0].id, 'fresh-card');
  assert.equal(existing.length, 1);
  assert.equal(incoming[1].id, 'deck-1');
  assert.deepEqual(mergeDecks(result.decks, incoming).decks, result.decks);
});

test('field and count limits reject excess instead of truncating', () => {
  assert.doesNotThrow(() => validateDecks([deck({ name: 'n'.repeat(LIMITS.name), source: 's'.repeat(LIMITS.language), cards: [{ id: 'c', front: 'x'.repeat(LIMITS.side), back: 'y' }] })]));
  assert.throws(() => validateDecks([deck({ name: 'n'.repeat(LIMITS.name + 1) })]), /limit/);
  assert.throws(() => validateDecks([deck({ source: 's'.repeat(LIMITS.language + 1) })]), /limit/);
  assert.throws(() => validateDecks([deck({ cards: [{ id: 'c', front: 'x'.repeat(LIMITS.side + 1), back: 'y' }] })]), /limit/);
  assert.throws(() => validateDecks(Array(LIMITS.decks + 1).fill(deck())), /at most/);
  assert.throws(() => validateDecks([deck({ cards: Array(LIMITS.cards + 1).fill({ id: 'c', front: 'x', back: 'y' }) })]), /at most/);
});

test('10 MiB file limit counts UTF-8 bytes and accepts the exact boundary', () => {
  assert.deepEqual(parseBackup('[]' + ' '.repeat(MAX_BACKUP_BYTES - 2)), []);
  assert.throws(() => parseBackup('[]' + ' '.repeat(MAX_BACKUP_BYTES - 1)), error => error.code === 'TOO_LARGE');
  assert.throws(() => parseBackup('ı'.repeat(MAX_BACKUP_BYTES / 2 + 1)), error => error.code === 'TOO_LARGE');
});

test('every accepted collection fits the same pretty-printed export limit', () => {
  const cards = Array.from({ length: 52 }, (_, index) => ({ id: `c${index}`, front: 'x'.repeat(LIMITS.side), back: 'y'.repeat(LIMITS.side) }));
  const backup = makeBackup([deck({ cards })]);
  const serialized = JSON.stringify(backup, null, 2);
  assert.ok(Buffer.byteLength(serialized) <= MAX_BACKUP_BYTES);
  assert.deepEqual(parseBackup(serialized), backup.decks);
  cards.push({ id: 'over-limit', front: 'x'.repeat(LIMITS.side), back: 'y'.repeat(LIMITS.side) });
  assert.throws(() => makeBackup([deck({ cards })]), error => error.code === 'TOO_LARGE');
});

test('merging cannot create an unexportable oversized collection', () => {
  const makeLarge = (prefix, name) => deck({ id: prefix, name, cards: Array.from({ length: 27 }, (_, i) => ({ id: `${prefix}-${i}`, front: 'x'.repeat(LIMITS.side), back: 'y'.repeat(LIMITS.side) })) });
  assert.throws(() => mergeDecks([makeLarge('a', 'A')], [makeLarge('b', 'B')]), error => error.code === 'TOO_LARGE');
});
