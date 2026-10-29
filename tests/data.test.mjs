import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BACKUP_BYTES, LIMITS, createId, makeBackup, mergeDecks, parseBackup, validateDecks } from '../data.js';

const deck = (changes = {}) => ({
  id: 'deck-1', name: 'Everyday words', source: 'English', target: 'Türkçe',
  cards: [{ id: 'card-1', front: "What's new?", back: 'Ne var ne yok? 👋' }],
  ...changes,
});
const session = (changes = {}) => ({
  id: 'session-1', startedAt: '2026-10-30T12:00:00.000Z', completedAt: '2026-10-30T12:00:01.500Z',
  mode: 'forward', kind: 'spaced', cardCount: 1, questionCount: 1, attempts: 1, againCount: 0,
  firstPassGood: 1, durationMs: 1500, newCards: 1, reviewCards: 0, ...changes,
});
const schedule = (changes = {}) => ({
  stage: 'review', dueAt: '2026-10-31T12:00:01.500Z', intervalDays: 1, ease: 2.5,
  repetitions: 1, lapses: 0, reviews: 1, lastReviewedAt: '2026-10-30T12:00:01.500Z',
  introducedAt: '2026-10-30T12:00:01.500Z', ...changes,
});
const progressedDeck = (changes = {}) => deck({
  spacedRepetition: true,
  history: [session()],
  cards: [{ ...deck().cards[0], srs: schedule() }],
  ...changes,
});
const fsrsSchedule = (changes = {}) => ({
  algorithm: 'fsrs-6', profile: 'fsrs6-default-90-v1', stage: 'review',
  dueAt: '2026-11-03T12:00:01.500Z', intervalDays: 4, lapses: 0, reviews: 1,
  lastReviewedAt: '2026-10-30T12:00:01.500Z', introducedAt: '2026-10-30T12:00:01.500Z',
  stability: 3.173, difficulty: 5.282, state: 2, learningSteps: 0, elapsedDays: 0,
  reviewLogComplete: true, reviewLog: [{ at: '2026-10-30T12:00:01.500Z', rating: 3 }],
  ...changes,
});
const fsrsDeck = (changes = {}) => progressedDeck({ cards: [{ ...deck().cards[0], srs: fsrsSchedule(changes) }] });

test('versioned and legacy backups round-trip Unicode, apostrophes, and plain HTML text', () => {
  const decks = [deck({ cards: [{ id: 'card-1', front: "<script>alert('hello')</script>", back: 'İstanbul, العربية, 日本語 🧠\nNext line' }] })];
  const backup = makeBackup(decks);
  assert.equal(backup.format, 'jenechka-cards');
  assert.equal(backup.version, 3);
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
  for (const change of [{ format: 'another-app' }, { version: 4 }, { version: '1' }, { exportedAt: 'not-a-date' }, { exportedAt: undefined }, { decks: {} }]) {
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

test('version-1 backups and legacy arrays retain their absent progress fields', () => {
  const legacy = [deck()];
  assert.deepEqual(parseBackup(JSON.stringify({ ...makeBackup(legacy), version: 1 })), legacy);
  assert.deepEqual(parseBackup(JSON.stringify(legacy)), legacy);
  const canonical = validateDecks(legacy);
  assert.equal(Object.hasOwn(canonical[0], 'spacedRepetition'), false);
  assert.equal(Object.hasOwn(canonical[0], 'history'), false);
  assert.equal(Object.hasOwn(canonical[0].cards[0], 'srs'), false);
});

test('version-2 backups preserve schedules, completed sessions, and disabled spaced repetition', () => {
  const completed = session({ mode: 'mixed', questionCount: 2, attempts: 3, againCount: 1, firstPassGood: 1 });
  const source = [progressedDeck({ spacedRepetition: false, history: [completed] })];
  const backup = makeBackup(source);
  assert.equal(backup.version, 3);
  assert.deepEqual(parseBackup(JSON.stringify({ ...backup, version: 2 })), source);
  assert.deepEqual(parseBackup(JSON.stringify(backup, null, 2)), source);
  const canonical = validateDecks(source);
  canonical[0].history[0].againCount = 9;
  canonical[0].cards[0].srs.ease = 1.3;
  assert.equal(source[0].history[0].againCount, 1);
  assert.equal(source[0].cards[0].srs.ease, 2.5);
});

test('version-3 backups round-trip FSRS memory and review logs without changing legacy schedules', () => {
  const source = [fsrsDeck(), progressedDeck({ id: 'legacy-deck' })];
  const original = structuredClone(source);
  const backup = makeBackup(source);
  assert.equal(backup.version, 3);
  assert.deepEqual(parseBackup(JSON.stringify(backup, null, 2)), source);
  const canonical = validateDecks(source);
  canonical[0].cards[0].srs.reviewLog[0].rating = 1;
  canonical[0].cards[0].srs.stability = 1;
  assert.deepEqual(source, original);
  assert.deepEqual(backup.decks[1], source[1]);
});

test('FSRS validates memory, state, profile, review count, and all required fields', () => {
  const invalid = [
    { algorithm: 'fsrs-7' }, { algorithm: null }, { profile: 'other' }, { profile: undefined },
    { stage: 'learning' }, { state: 0 }, { state: 4 }, { state: '2' },
    { intervalDays: -1 }, { intervalDays: 0 }, { intervalDays: 0.5 }, { intervalDays: 36501 },
    { state: 1, stage: 'learning', intervalDays: 1 }, { state: 3, stage: 'learning', intervalDays: 1 },
    { stability: 0 }, { stability: 36501 }, { stability: NaN }, { stability: Infinity }, { stability: '3' },
    { difficulty: 0.99 }, { difficulty: 10.01 }, { difficulty: Infinity }, { difficulty: undefined },
    { learningSteps: -1 }, { learningSteps: 0.5 }, { learningSteps: 1 }, { learningSteps: Number.MAX_SAFE_INTEGER },
    { state: 1, stage: 'learning', intervalDays: 0, learningSteps: 1 },
    { state: 3, stage: 'learning', intervalDays: 0, learningSteps: 1 },
    { elapsedDays: -1 }, { elapsedDays: 0.1 },
    { reviews: 0 }, { reviews: 2 }, { reviews: Number.MAX_SAFE_INTEGER + 1 }, { lapses: -1 },
    { reviewLogComplete: 'true' }, { reviewLogComplete: undefined },
    { reviewLog: undefined }, { reviewLog: null }, { reviewLog: [] }, { reviewLog: {} },
    { reviewLog: [null] }, { reviewLog: [{ at: '2026-10-30T12:00:01.500Z', rating: 2 }] },
    { reviewLog: [{ at: '2026-10-30T12:00:01.500Z', rating: 4 }] },
    { reviewLog: [{ at: '2026-10-30T12:00:01.500Z', rating: '3' }] },
    { reviewLog: [{ at: 'not-a-date', rating: 3 }] }, { ease: 2.5 }, { repetitions: 1 },
  ];
  for (const change of invalid) assert.throws(() => validateDecks([fsrsDeck(change)]), undefined, JSON.stringify(change));
  assert.doesNotThrow(() => validateDecks([fsrsDeck({ state: 1, stage: 'learning', intervalDays: 0, stability: 0.001, difficulty: 1 })]));
  assert.doesNotThrow(() => validateDecks([fsrsDeck({ state: 3, stage: 'learning', intervalDays: 0, stability: 36500, difficulty: 10 })]));
});

test('FSRS logs stay chronological from introduction through the last review and preserve incomplete legacy history', () => {
  const previous = '2026-10-30T12:00:01.500Z';
  const later = '2026-11-02T12:00:01.500Z';
  const history = [{ at: previous, rating: 3 }, { at: later, rating: 1 }];
  const valid = { reviews: 2, lastReviewedAt: later, reviewLog: history };
  assert.deepEqual(validateDecks([fsrsDeck(valid)])[0].cards[0].srs.reviewLog, history);
  const invalid = [
    { ...valid, reviewLog: history.toReversed() },
    { ...valid, reviewLog: [{ at: '2026-10-29T12:00:00.000Z', rating: 3 }, history[1]] },
    { ...valid, reviewLog: [history[0], { at: '2026-11-03T12:00:00.000Z', rating: 1 }] },
    { lastReviewedAt: later },
    { introducedAt: later },
    { dueAt: '2026-10-29T12:00:00.000Z' },
    { reviews: 1, reviewLogComplete: false, reviewLog: [history[0], history[0]] },
  ];
  for (const change of invalid) assert.throws(() => validateDecks([fsrsDeck(change)]));
  const converted = fsrsDeck({ reviews: Number.MAX_SAFE_INTEGER, lapses: Number.MAX_SAFE_INTEGER, reviewLogComplete: false });
  assert.deepEqual(validateDecks([converted]), [converted]);
  assert.doesNotThrow(() => validateDecks([fsrsDeck({ reviewLog: [{ at: '2026-10-30T15:00:01.500+03:00', rating: 3 }] })]));
  assert.doesNotThrow(() => validateDecks([fsrsDeck({ reviews: 2, reviewLog: [history[0], history[0]] })]));
});

test('FSRS fields without an algorithm are never silently discarded as a legacy schedule', () => {
  for (const [field, value] of Object.entries(fsrsSchedule())) {
    if (!['profile', 'stability', 'difficulty', 'state', 'learningSteps', 'elapsedDays', 'reviewLogComplete', 'reviewLog'].includes(field)) continue;
    const source = progressedDeck({ cards: [{ ...deck().cards[0], srs: schedule({ [field]: value }) }] });
    assert.throws(() => validateDecks([source]), /identify its algorithm/);
  }
});

test('card review log count limits reject excess on a card or across a collection without truncating', () => {
  const entry = fsrsSchedule().reviewLog[0];
  const excess = fsrsDeck({ reviews: LIMITS.reviewLogs + 1, reviewLog: Array(LIMITS.reviewLogs + 1).fill(entry) });
  assert.throws(() => validateDecks([excess]), /card review records/);
  const half = fsrsDeck({ reviews: Math.ceil(LIMITS.reviewLogs / 2) + 1, reviewLog: Array(Math.ceil(LIMITS.reviewLogs / 2) + 1).fill(entry) });
  assert.throws(() => validateDecks([half, { ...half, id: 'second' }]), /card review records/);
  assert.equal(half.cards[0].srs.reviewLog.length, 50001);
});

test('import deduplication preserves divergent FSRS memory or logs instead of merging away progress', () => {
  const existing = [fsrsDeck()];
  assert.equal(mergeDecks(existing, [fsrsDeck()]).skipped, 1);
  for (const change of [{ stability: 4 }, { difficulty: 6 }, { reviewLogComplete: false }, { reviewLog: [{ at: '2026-10-30T12:00:01.500Z', rating: 1 }] }]) {
    const source = fsrsDeck(change);
    const merged = mergeDecks(existing, [source]);
    assert.equal(merged.added, 1);
    assert.deepEqual(merged.decks[0], existing[0]);
    assert.deepEqual(merged.decks[1].cards[0].srs, source.cards[0].srs);
    assert.notEqual(merged.decks[1].id, existing[0].id);
  }
});

test('historical counts are independent of the current editable deck size', () => {
  const source = [deck({ cards: [], history: [session({ cardCount: 3, questionCount: 3, attempts: 3, firstPassGood: 3, newCards: 2, reviewCards: 1 })] })];
  assert.deepEqual(validateDecks(source), source);
});

test('partial or invalid schedules reject rather than silently removing progress', () => {
  const invalid = [
    { stage: 'new' }, { dueAt: null }, { intervalDays: -1 }, { intervalDays: Infinity }, { intervalDays: NaN },
    { ease: 1.29 }, { ease: 3.01 }, { ease: '2.5' }, { repetitions: 0.5 }, { lapses: -1 }, { reviews: 0 },
    { reviews: Number.MAX_SAFE_INTEGER + 1 }, { introducedAt: '2026-11-01T12:00:00.000Z' },
    { dueAt: '2026-10-29T12:00:00.000Z' }, { lastReviewedAt: undefined },
  ];
  for (const change of invalid) {
    assert.throws(() => validateDecks([progressedDeck({ cards: [{ ...deck().cards[0], srs: schedule(change) }] })]), undefined, JSON.stringify(change));
  }
  for (const value of [null, false, []]) assert.throws(() => validateDecks([deck({ cards: [{ ...deck().cards[0], srs: value }] })]));
  assert.doesNotThrow(() => validateDecks([progressedDeck({ cards: [{ ...deck().cards[0], srs: schedule({ stage: 'learning', intervalDays: 0, repetitions: 0, ease: 1.3 }) }] })]));
});

test('completed history requires valid modes, counts, safe integers, and unique IDs', () => {
  const invalid = [
    { mode: 'random' }, { kind: 'unfinished' }, { cardCount: 0 }, { questionCount: 0 },
    { mode: 'mixed' }, { questionCount: 2 }, { attempts: 0 }, { attempts: 2 }, { againCount: 1 },
    { firstPassGood: 2 }, { firstPassGood: -1 }, { durationMs: 0.5 }, { durationMs: -1 },
    { durationMs: Number.MAX_SAFE_INTEGER + 1 }, { newCards: 0 }, { reviewCards: 1 },
    { newCards: '1' }, { completedAt: undefined }, { startedAt: '2026-10-31T00:00:00.000Z' },
  ];
  for (const change of invalid) assert.throws(() => validateDecks([deck({ history: [session(change)] })]), undefined, JSON.stringify(change));
  assert.throws(() => validateDecks([deck({ history: [session(), session()] })]), /duplicate history ID/);
  for (const value of [null, {}, 'sessions']) assert.throws(() => validateDecks([deck({ history: value })]));
  for (const value of [null, 'true', 1]) assert.throws(() => validateDecks([deck({ spacedRepetition: value })]));
  assert.throws(() => validateDecks([deck({ history: Array(LIMITS.history + 1).fill(session()) })]), /completed sessions/);
});

test('completed histories cannot report first-pass recall incompatible with their repeat counts', () => {
  const invalid = [
    session({ firstPassGood: 0 }),
    session({ attempts: 2, againCount: 1 }),
    session({ mode: 'mixed', questionCount: 2, attempts: 3, againCount: 1, firstPassGood: 0 }),
  ];
  for (const record of invalid) {
    assert.throws(() => parseBackup(JSON.stringify([deck({ history: [record] })])), /recall and repeat counts are inconsistent/);
  }
  const valid = session({ mode: 'mixed', questionCount: 2, attempts: 5, againCount: 3, firstPassGood: 0 });
  assert.deepEqual(parseBackup(JSON.stringify([deck({ history: [valid] })]))[0].history, [valid]);
});

test('active study duration cannot exceed real elapsed time, including UTC offsets and zero-length sessions', () => {
  const invalid = [
    session({ durationMs: 1501 }),
    session({ completedAt: '2026-10-30T15:00:01+03:00', durationMs: 1001 }),
    session({ completedAt: '2026-10-30T12:00:00.000Z', durationMs: 1 }),
  ];
  for (const record of invalid) assert.throws(() => validateDecks([deck({ history: [record] })]), /active duration cannot exceed/);
  const zeroLength = session({ completedAt: '2026-10-30T12:00:00.000Z', durationMs: 0 });
  assert.deepEqual(validateDecks([deck({ history: [zeroLength] })])[0].history, [zeroLength]);
  assert.doesNotThrow(() => validateDecks([deck({ history: [session({ durationMs: 1499 })] })]));
});

test('progress dates require real ISO calendar timestamps and support valid UTC offsets and extended years', () => {
  for (const invalid of ['1', '2026-02-30T12:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-10-30', '2026-10-30T24:00:00.000Z', '+275761-01-01T00:00:00.000Z', '2026-10-30T00:00:00.000+25:00']) {
    assert.throws(() => validateDecks([deck({ history: [session({ startedAt: invalid })] })]), /ISO date/);
  }
  const offset = session({ startedAt: '2026-10-30T15:00:00+03:00', completedAt: '2026-10-30T15:00:01.500+03:00' });
  assert.deepEqual(validateDecks([deck({ history: [offset] })])[0].history, [offset]);
  const farFuture = '+275760-09-13T00:00:00.000Z';
  const source = [progressedDeck({ cards: [{ ...deck().cards[0], srs: schedule({ dueAt: farFuture }) }] })];
  assert.deepEqual(validateDecks(source), source);
});

test('merge skips identical progress but preserves divergent history or scheduling as independent copies', () => {
  const existing = [progressedDeck()];
  const identical = progressedDeck({ id: 'copy', cards: [{ ...deck().cards[0], id: 'copy-card', srs: schedule() }] });
  assert.equal(mergeDecks(existing, [identical]).skipped, 1);
  const historyChanged = progressedDeck({ history: [session(), session({ id: 'session-2', kind: 'practice' })] });
  const historyMerge = mergeDecks(existing, [historyChanged]);
  assert.equal(historyMerge.added, 1);
  assert.deepEqual(historyMerge.decks[0], existing[0]);
  assert.notEqual(historyMerge.decks[1].id, existing[0].id);
  assert.notEqual(historyMerge.decks[1].cards[0].id, existing[0].cards[0].id);
  assert.deepEqual(historyMerge.decks[1].history, historyChanged.history);
  assert.deepEqual(mergeDecks(historyMerge.decks, [historyChanged]).decks, historyMerge.decks);
  const scheduleChanged = progressedDeck({ cards: [{ ...deck().cards[0], srs: schedule({ dueAt: '2026-11-03T12:00:01.500Z', intervalDays: 4 }) }] });
  const scheduleMerge = mergeDecks(existing, [scheduleChanged]);
  assert.equal(scheduleMerge.added, 1);
  assert.deepEqual(scheduleMerge.decks[1].cards[0].srs, scheduleChanged.cards[0].srs);
});

test('semantic defaults deduplicate legacy decks, while disabled scheduling remains a distinct preference', () => {
  assert.equal(mergeDecks([deck()], [deck({ spacedRepetition: true, history: [] })]).skipped, 1);
  assert.equal(mergeDecks([deck()], [deck({ spacedRepetition: false })]).added, 1);
  assert.equal(mergeDecks([progressedDeck()], [deck()]).added, 1);
});
