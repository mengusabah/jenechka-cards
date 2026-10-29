import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createStudySession, rateStudyCard } from '../study.js';
import { isSpacedEnabled, getDeckSchedule, selectStudyCards, completeStudyDeck } from '../spaced-repetition.js';
import { validateDecks, makeBackup, parseBackup } from '../data.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const iso = (time) => new Date(time).toISOString();
const fresh = (id) => ({ id: String(id), front: `front ${id}`, back: `back ${id}` });
const deckOf = (...cards) => ({ id: 'deck', name: 'Words', source: 'English', target: 'Turkish', cards });
const reviewed = (id, overrides = {}) => ({ ...fresh(id), srs: {
  stage: 'review', dueAt: iso(NOW), intervalDays: 1, ease: 2.5, repetitions: 1,
  lapses: 0, reviews: 1, lastReviewedAt: iso(NOW - DAY), introducedAt: iso(NOW - DAY),
  ...overrides,
} });
const good = (session) => { session.flipped = true; return rateStudyCard(session, 'good'); };
const again = (session) => { session.flipped = true; return rateStudyCard(session, 'again'); };

function finish(deck, { start = NOW, end = start + 10000, mode = 'forward', kind = 'spaced', id = 'session', cards } = {}) {
  let now = start;
  const session = createStudySession(cards ?? selectStudyCards(deck, start), mode, () => 1 - Number.EPSILON, { now: () => now, kind });
  now = end;
  while (session.queue.length) good(session);
  return { session, deck: completeStudyDeck(deck, session, { id, durationMs: end - start }) };
}

test('legacy decks default to spaced mode, explicit off selects all for practice', () => {
  const deck = deckOf(fresh('new'), reviewed('future', { dueAt: iso(NOW + DAY) }));
  assert.equal(isSpacedEnabled(deck), true);
  assert.deepEqual(selectStudyCards(deck, NOW).map(card => card.id), ['new']);
  deck.spacedRepetition = false;
  assert.equal(isSpacedEnabled(deck), false);
  assert.deepEqual(selectStudyCards(deck, NOW), deck.cards);
  assert.notEqual(selectStudyCards(deck, NOW), deck.cards);
});

test('schedule partitions cards and reports the earliest future learning or review deadline', () => {
  const deck = deckOf(
    fresh('new'),
    reviewed('due'),
    reviewed('overdue', { dueAt: iso(NOW - 10) }),
    reviewed('review-later', { dueAt: iso(NOW + DAY) }),
    reviewed('learning-due', { stage: 'learning', dueAt: iso(NOW), intervalDays: 0, repetitions: 0 }),
    reviewed('learning-later', { stage: 'learning', dueAt: iso(NOW + 600000), intervalDays: 0, repetitions: 0 }),
  );
  assert.deepEqual(getDeckSchedule(deck, NOW), {
    newCount: 1, learningCount: 2, dueLearningCount: 1, dueCount: 2, scheduledCount: 1,
    newAvailable: 1, readyCount: 4, nextDueAt: iso(NOW + 600000),
  });
  assert.deepEqual(selectStudyCards(deck, NOW).map(card => card.id), ['overdue', 'due', 'learning-due', 'new']);
  assert.equal(getDeckSchedule(deckOf(), NOW).nextDueAt, null);
});

test('due boundary is inclusive and selecting cards cannot mutate the source deck', () => {
  const deck = deckOf(reviewed('boundary', { dueAt: iso(NOW + 1) }));
  const snapshot = structuredClone(deck);
  assert.equal(selectStudyCards(deck, NOW).length, 0);
  assert.equal(selectStudyCards(deck, NOW + 1).length, 1);
  assert.equal(getDeckSchedule(deck, NOW + 1).dueCount, 1);
  assert.equal(getDeckSchedule(deck, NOW + 1).nextDueAt, null);
  assert.deepEqual(deck, snapshot);
});

test('daily new allowance is 20 per deck and due cards take all available session slots first', () => {
  const newCards = Array.from({ length: 30 }, (_, i) => fresh(`new-${i}`));
  const due = Array.from({ length: 55 }, (_, i) => reviewed(`due-${i}`));
  const deck = deckOf(...newCards, ...due);
  assert.equal(getDeckSchedule(deck, NOW).newAvailable, 20);
  assert.equal(getDeckSchedule(deck, NOW).readyCount, 75);
  const selected = selectStudyCards(deck, NOW);
  assert.equal(selected.length, 50);
  assert.ok(selected.every(card => card.srs));
  const introduced = Array.from({ length: 18 }, (_, i) => reviewed(`today-${i}`, {
    introducedAt: iso(NOW - 1000), lastReviewedAt: iso(NOW - 1000), dueAt: iso(NOW + DAY),
    stage: i % 2 ? 'learning' : 'review',
  }));
  const smaller = deckOf(...newCards, ...introduced, due[0]);
  assert.equal(getDeckSchedule(smaller, NOW).newAvailable, 2);
  assert.deepEqual(selectStudyCards(smaller, NOW).map(card => card.id), ['due-0', 'new-0', 'new-1']);
  assert.equal(getDeckSchedule(deckOf(...newCards), NOW).newAvailable, 20);
});

test('new allowance uses the local calendar date across midnight and daylight-saving boundaries', () => {
  const source = `
    import { getDeckSchedule } from './spaced-repetition.js';
    const now = Date.parse('2026-11-01T05:30:00Z'); // 01:30 EDT before fallback
    const srs = at => ({ stage:'review', dueAt:'2026-11-03T00:00:00Z', introducedAt:at });
    const cards = Array.from({length:20}, (_,i)=>({id:i}));
    cards.push({id:'yesterday',srs:srs('2026-11-01T03:59:59Z')}); // Oct31 local
    cards.push({id:'today',srs:srs('2026-11-01T04:00:00Z')}); // Nov1 local
    const first = getDeckSchedule({cards}, now).newAvailable;
    const fallback = getDeckSchedule({cards}, Date.parse('2026-11-01T06:30:00Z')).newAvailable;
    const next = getDeckSchedule({cards}, Date.parse('2026-11-02T05:00:00Z')).newAvailable;
    console.log(JSON.stringify([first,fallback,next]));
  `;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(result), [19, 19, 20]);
});

test('clean successful reviews advance through 1 day, 6 days, then ease multiplication with a 365-day cap', () => {
  let deck = deckOf(fresh('one'));
  let result = finish(deck);
  deck = result.deck;
  assert.deepEqual(deck.cards[0].srs, {
    stage: 'review', dueAt: iso(NOW + 10000 + DAY), intervalDays: 1, ease: 2.5,
    repetitions: 1, lapses: 0, reviews: 1,
    introducedAt: iso(NOW + 10000), lastReviewedAt: iso(NOW + 10000),
  });
  const introduction = deck.cards[0].srs.introducedAt;
  result = finish(deck, { start: Date.parse(deck.cards[0].srs.dueAt), id: 'two' });
  deck = result.deck;
  assert.equal(deck.cards[0].srs.intervalDays, 6);
  assert.equal(deck.cards[0].srs.repetitions, 2);
  result = finish(deck, { start: Date.parse(deck.cards[0].srs.dueAt), id: 'three' });
  deck = result.deck;
  assert.equal(deck.cards[0].srs.intervalDays, 15);
  assert.equal(deck.cards[0].srs.repetitions, 3);
  assert.equal(deck.cards[0].srs.reviews, 3);
  assert.equal(deck.cards[0].srs.introducedAt, introduction);
  const long = deckOf(reviewed('long', { intervalDays: 300, repetitions: 8, ease: 2.9 }));
  assert.equal(finish(long).deck.cards[0].srs.intervalDays, 365);
  const fractional = deckOf(reviewed('fractional', { intervalDays: 7, repetitions: 3, ease: 2.3 }));
  assert.equal(finish(fractional).deck.cards[0].srs.intervalDays, 17);
});

test('one or many Again ratings in either mixed direction produce one card-level lapse only after completion', () => {
  let time = NOW;
  const deck = deckOf(reviewed('one'));
  const snapshot = structuredClone(deck);
  const session = createStudySession(deck.cards, 'mixed', () => 1 - Number.EPSILON, { now: () => time, kind: 'spaced' });
  good(session); // forward good
  again(session); // reverse again
  again(session);
  assert.equal(completeStudyDeck(deck, session, { id: 'lapse' }), deck);
  assert.deepEqual(deck, snapshot);
  time += 30000;
  good(session);
  const updated = completeStudyDeck(deck, session, { id: 'lapse', durationMs: 18000 });
  assert.deepEqual(updated.cards[0].srs, {
    stage: 'learning', dueAt: iso(time + 600000), intervalDays: 0, ease: 2.3,
    repetitions: 0, lapses: 1, reviews: 2,
    introducedAt: iso(NOW - DAY), lastReviewedAt: iso(time),
  });
  assert.deepEqual(updated.history[0], {
    id: 'lapse', startedAt: iso(NOW), completedAt: iso(time), mode: 'mixed', kind: 'spaced',
    cardCount: 1, questionCount: 2, attempts: 4, againCount: 2, firstPassGood: 1,
    durationMs: 18000, newCards: 0, reviewCards: 1,
  });
  assert.deepEqual(deck, snapshot);
  const next = finish(updated, { start: time + 600000, id: 'relearn' }).deck;
  assert.equal(next.cards[0].srs.intervalDays, 1);
  assert.equal(next.cards[0].srs.repetitions, 1);
  assert.equal(next.cards[0].srs.stage, 'review');
  assert.equal(next.cards[0].srs.ease, 2.3);
  assert.equal(next.cards[0].srs.lapses, 1);
});

test('lapse ease never drops below 1.3 and new-card lapse consumes the daily introduction allowance', () => {
  const deck = deckOf(fresh('new'), reviewed('low', { ease: 1.3 }));
  const session = createStudySession(deck.cards, 'forward', () => 1 - Number.EPSILON, { now: NOW, kind: 'spaced' });
  again(session);
  again(session);
  while (session.queue.length) good(session);
  const updated = completeStudyDeck(deck, session, { id: 'failed' });
  assert.equal(updated.cards[0].srs.stage, 'learning');
  assert.equal(updated.cards[0].srs.introducedAt, iso(NOW));
  assert.equal(updated.cards[1].srs.ease, 1.3);
  assert.equal(updated.history[0].newCards, 1);
  assert.equal(updated.history[0].reviewCards, 1);
  assert.equal(getDeckSchedule(deckOf(...updated.cards, ...Array.from({ length: 30 }, (_, i) => fresh(i))), NOW).newAvailable, 19);
});

test('practice adds immutable history without changing any schedule or introducing cards', () => {
  const deck = deckOf(fresh('new'), reviewed('review'));
  const snapshot = structuredClone(deck);
  const result = finish(deck, { kind: 'practice', mode: 'mixed' });
  assert.notEqual(result.deck, deck);
  assert.equal(result.deck.cards, deck.cards);
  assert.deepEqual(deck, snapshot);
  assert.equal(result.deck.history[0].kind, 'practice');
  assert.equal(result.deck.history[0].questionCount, 4);
  assert.equal(result.deck.history[0].newCards, 1);
  assert.equal(result.deck.history[0].reviewCards, 1);
});

test('empty, aborted, and only partly finished mixed sessions produce no history or schedule changes', () => {
  const deck = deckOf(fresh('one'));
  const empty = createStudySession([], 'forward', () => 0, { now: NOW, kind: 'spaced' });
  assert.equal(completeStudyDeck(deck, empty, { id: 'empty' }), deck);
  const session = createStudySession(deck.cards, 'mixed', () => 0, { now: NOW, kind: 'spaced' });
  assert.equal(completeStudyDeck(deck, session, { id: 'aborted' }), deck);
  good(session);
  assert.equal(completeStudyDeck(deck, session, { id: 'half' }), deck);
  session.done = session.total; // completion requires actual per-direction results too.
  session.queue = [];
  session.completedAt = iso(NOW);
  assert.equal(completeStudyDeck(deck, session, { id: 'premature' }), deck);
});

test('a repeated completion ID is idempotent for both history and schedule', () => {
  const first = finish(deckOf(fresh('one')), { id: 'same' });
  const snapshot = structuredClone(first.deck);
  const second = completeStudyDeck(first.deck, first.session, { id: 'same', completedAt: iso(NOW + DAY), durationMs: 5000 });
  assert.equal(second, first.deck);
  assert.deepEqual(second, snapshot);
  assert.equal(second.cards[0].srs.reviews, 1);
  assert.equal(second.history.length, 1);
});

test('early cards cannot be postponed even if they become due before an oversized session finishes', () => {
  const early = reviewed('early', { dueAt: iso(NOW + 5000) });
  const deck = deckOf(early, reviewed('due'), fresh('new'));
  const { deck: updated } = finish(deck, { cards: deck.cards, end: NOW + 10000 });
  assert.equal(updated.cards[0], early);
  assert.equal(updated.cards[1].srs.reviews, 2);
  assert.equal(updated.cards[2].srs.reviews, 1);
});

test('completion respects new-card and session caps even if a caller bypasses selection', () => {
  const newCards = Array.from({ length: 30 }, (_, i) => fresh(`new-${i}`));
  const due = Array.from({ length: 45 }, (_, i) => reviewed(`due-${i}`));
  const deck = deckOf(...newCards, ...due);
  const updated = finish(deck, { cards: deck.cards }).deck;
  assert.equal(updated.cards.filter(card => card.srs?.reviews === 2).length, 45);
  assert.equal(updated.cards.filter(card => card.srs?.reviews === 1 && card.id.startsWith('new')).length, 5);
  const onlyNew = deckOf(...newCards);
  assert.equal(finish(onlyNew, { cards: onlyNew.cards }).deck.cards.filter(card => card.srs).length, 20);
});

test('concurrent schedule changes and removed cards are preserved at completion', () => {
  const deck = deckOf(reviewed('changed'), reviewed('removed'), reviewed('same'));
  const { session } = finish(deck);
  const changed = { ...deck.cards[0], srs: { ...deck.cards[0].srs, dueAt: iso(NOW + DAY), reviews: 2 } };
  const current = deckOf(changed, deck.cards[2]);
  const updated = completeStudyDeck(current, session, { id: 'concurrent' });
  assert.equal(updated.cards.length, 2);
  assert.equal(updated.cards[0], changed);
  assert.equal(updated.cards[1].srs.reviews, 2);
  assert.equal(updated.history[0].cardCount, 3);
});

test('history durations are finite foreground time bounded by wall duration, and IDs are required', () => {
  const deck = deckOf(fresh('one'));
  const { session } = finish(deck);
  for (const [durationMs, expected] of [[Infinity, 0], [-1, 0], [12000, 10000], [123.9, 123]]) {
    const updated = completeStudyDeck(deck, session, { id: 'duration', durationMs });
    assert.equal(updated.history[0].durationMs, expected);
  }
  const backward = completeStudyDeck(deck, session, { id: 'clock', completedAt: iso(NOW - 1), durationMs: 1000 });
  assert.equal(backward.history[0].completedAt, iso(NOW));
  assert.equal(backward.history[0].durationMs, 0);
  assert.throws(() => completeStudyDeck(deck, session), TypeError);
});

test('completed sessions and schedules round-trip through the real storage and backup schema', () => {
  let now = NOW;
  const deck = deckOf(fresh('new'), reviewed('old'));
  const session = createStudySession(deck.cards, 'mixed', () => 1 - Number.EPSILON, { now: () => now, kind: 'spaced' });
  again(session);
  now += 4000;
  while (session.queue.length) good(session);
  let updated = completeStudyDeck(deck, session, { id: 'mixed-lapse', durationMs: 4000 });
  updated = finish(updated, { start: now, kind: 'practice', mode: 'reverse', id: 'practice', cards: updated.cards }).deck;
  assert.deepEqual(validateDecks([updated]), [updated]);
  assert.deepEqual(parseBackup(JSON.stringify(makeBackup([updated]))), [updated]);
  const imported = deckOf(reviewed('max', {
    repetitions: Number.MAX_SAFE_INTEGER, reviews: Number.MAX_SAFE_INTEGER, lapses: Number.MAX_SAFE_INTEGER,
  }));
  const saturated = finish(imported).deck;
  assert.deepEqual(validateDecks([saturated]), [saturated]);
});
