import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createStudySession, rateStudyCard } from '../study.js';
import { isSpacedEnabled, getDeckSchedule, selectStudyCards, completeStudyDeck } from '../spaced-repetition.js';
import { validateDecks, makeBackup, parseBackup } from '../data.js';
import { fsrs, createEmptyCard, Rating, State } from '../vendor/ts-fsrs-5.4.2.mjs';

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
const referenceEngine = () => fsrs({
  request_retention: 0.9, maximum_interval: 36500, enable_fuzz: false,
  enable_short_term: true, learning_steps: ['10m'], relearning_steps: ['10m'],
});

function assertMemoryMatches(schedule, expected) {
  assert.equal(schedule.algorithm, 'fsrs-6');
  assert.equal(schedule.profile, 'fsrs6-default-90-v1');
  assert.equal(schedule.stability, expected.stability);
  assert.equal(schedule.difficulty, expected.difficulty);
  assert.equal(schedule.state, expected.state);
  assert.equal(schedule.stage, expected.state === State.Review ? 'review' : 'learning');
  assert.equal(schedule.intervalDays, expected.scheduled_days);
  assert.equal(schedule.learningSteps, expected.learning_steps);
  assert.equal(schedule.elapsedDays, expected.elapsed_days);
  assert.equal(schedule.dueAt, expected.due.toISOString());
  assert.equal(schedule.lastReviewedAt, expected.last_review.toISOString());
}

function finishRated(deck, rating, { start = NOW, end = start + 10000, mode = 'forward', id = 'rated', retries = 1 } = {}) {
  let now = start;
  const session = createStudySession(selectStudyCards(deck, start), mode, () => 1 - Number.EPSILON, { now: () => now, kind: 'spaced' });
  if (rating === Rating.Again) {
    // Mixed failures can happen on the reverse side after a clean forward answer.
    if (mode === 'mixed') good(session);
    for (let count = 0; count < retries; count++) again(session);
  }
  now = end;
  while (session.queue.length) good(session);
  return { session, deck: completeStudyDeck(deck, session, { id, durationMs: end - start }) };
}

function finish(deck, { start = NOW, end = start + 10000, mode = 'forward', kind = 'spaced', id = 'session', cards } = {}) {
  let now = start;
  const session = createStudySession(cards ?? (kind === 'practice' ? deck.cards : selectStudyCards(deck, start)), mode, () => 1 - Number.EPSILON, { now: () => now, kind });
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

test('FSRS reviews match the official engine across mixed retries, learning, late reviews, and relearning', () => {
  const engine = referenceEngine();
  let expected = createEmptyCard(new Date(NOW));
  let deck = deckOf(fresh('one'));
  const steps = [
    { rating: Rating.Again, mode: 'mixed', retries: 3, late: 0 },
    { rating: Rating.Again, mode: 'forward', retries: 2, late: 0 },
    { rating: Rating.Good, mode: 'mixed', late: 0 },
    { rating: Rating.Good, mode: 'reverse', late: 0 },
    { rating: Rating.Good, mode: 'mixed', late: 9 * DAY },
    { rating: Rating.Again, mode: 'mixed', retries: 4, late: 3 * DAY },
    { rating: Rating.Good, mode: 'forward', late: 0 },
    { rating: Rating.Good, mode: 'mixed', late: 2 * DAY },
  ];
  const log = [];
  let introduction;
  for (const [index, step] of steps.entries()) {
    const start = expected.due.getTime() + step.late;
    const end = start + 10000;
    expected = engine.repeat(expected, new Date(end))[step.rating].card;
    const before = structuredClone(deck);
    const result = finishRated(deck, step.rating, { ...step, start, end, id: `fsrs-${index}` });
    assert.deepEqual(deck, before, 'committing a completed review must not mutate its source deck');
    deck = result.deck;
    const schedule = deck.cards[0].srs;
    assertMemoryMatches(schedule, expected);
    introduction ??= iso(end);
    log.push({ at: iso(end), rating: step.rating });
    assert.equal(schedule.introducedAt, introduction);
    assert.equal(schedule.reviews, index + 1, 'retries and mixed directions must not inflate FSRS reviews');
    assert.deepEqual(schedule.reviewLog, log);
    assert.equal(schedule.reviewLogComplete, true);
    assert.equal(Object.hasOwn(schedule, 'ease'), false);
    assert.equal(Object.hasOwn(schedule, 'repetitions'), false);
    assert.deepEqual(validateDecks([deck]), [deck]);
  }
});

test('a clean new card uses the FSRS default two-day interval and subsequent reviews remain model-derived', () => {
  const engine = referenceEngine();
  let expected = createEmptyCard(new Date(NOW));
  let deck = deckOf(fresh('one'));
  for (let index = 0; index < 5; index++) {
    const start = expected.due.getTime();
    const end = start + 10000;
    expected = engine.repeat(expected, new Date(end))[Rating.Good].card;
    deck = finish(deck, { start, end, id: `clean-${index}` }).deck;
    assertMemoryMatches(deck.cards[0].srs, expected);
    if (!index) assert.equal(deck.cards[0].srs.intervalDays, 2);
  }
  assert.equal(deck.cards[0].srs.reviews, 5);
  assert.equal(deck.cards[0].srs.reviewLog.length, 5);
});

test('legacy progress keeps its current due date until a completed review and migrates without invented logs', () => {
  const legacy = reviewed('legacy', {
    intervalDays: 38, ease: 2.3, repetitions: 4, reviews: 8, lapses: 2,
    introducedAt: iso(NOW - 150 * DAY), lastReviewedAt: iso(NOW - 38 * DAY), dueAt: iso(NOW + 1000),
  });
  const original = deckOf(legacy);
  const snapshot = structuredClone(original);
  assert.equal(selectStudyCards(original, NOW).length, 0);
  assert.equal(getDeckSchedule(original, NOW).nextDueAt, iso(NOW + 1000));
  assert.deepEqual(original, snapshot);
  const result = finish(original, { start: NOW + 1000, id: 'migration' });
  const schedule = result.deck.cards[0].srs;
  assert.deepEqual(original, snapshot);
  assert.equal(schedule.algorithm, 'fsrs-6');
  assert.equal(schedule.introducedAt, legacy.srs.introducedAt);
  assert.equal(schedule.reviews, 9);
  assert.equal(schedule.lapses, 2);
  assert.equal(schedule.reviewLogComplete, false);
  assert.deepEqual(schedule.reviewLog, [{ at: iso(NOW + 11000), rating: Rating.Good }]);
  assert.ok(schedule.stability > 0);
  assert.ok(schedule.difficulty >= 1 && schedule.difficulty <= 10);
  assert.ok(Date.parse(schedule.dueAt) > Date.parse(schedule.lastReviewedAt));
  const next = finish(result.deck, { start: Date.parse(schedule.dueAt), id: 'migration-followup' }).deck;
  assert.equal(next.cards[0].srs.reviewLogComplete, false);
  assert.equal(next.cards[0].srs.reviewLog.length, 2);
  assert.equal(next.cards[0].srs.reviews, 10);
  assert.deepEqual(validateDecks([next]), [next]);
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
  const schedule = updated.cards[0].srs;
  assert.equal(schedule.stage, 'learning');
  assert.equal(schedule.state, State.Relearning);
  assert.equal(schedule.dueAt, iso(time + 600000));
  assert.equal(schedule.intervalDays, 0);
  assert.equal(schedule.lapses, 1);
  assert.equal(schedule.reviews, 2);
  assert.equal(schedule.introducedAt, iso(NOW - DAY));
  assert.equal(schedule.lastReviewedAt, iso(time));
  assert.equal(schedule.reviewLogComplete, false);
  assert.deepEqual(schedule.reviewLog, [{ at: iso(time), rating: Rating.Again }]);
  assert.deepEqual(updated.history[0], {
    id: 'lapse', startedAt: iso(NOW), completedAt: iso(time), mode: 'mixed', kind: 'spaced',
    cardCount: 1, questionCount: 2, attempts: 4, againCount: 2, firstPassGood: 1,
    durationMs: 18000, newCards: 0, reviewCards: 1,
  });
  assert.deepEqual(deck, snapshot);
  const next = finish(updated, { start: time + 600000, id: 'relearn' }).deck;
  assert.ok(next.cards[0].srs.intervalDays >= 1);
  assert.equal(next.cards[0].srs.stage, 'review');
  assert.equal(next.cards[0].srs.state, State.Review);
  assert.equal(next.cards[0].srs.lapses, 1);
  assert.equal(next.cards[0].srs.reviews, 3);
  assert.deepEqual(next.cards[0].srs.reviewLog, [
    { at: iso(time), rating: Rating.Again },
    { at: iso(time + 600000 + 10000), rating: Rating.Good },
  ]);
});

test('new-card Again uses a ten-minute learning step and consumes only one daily introduction', () => {
  const deck = deckOf(fresh('new'));
  const { deck: updated } = finishRated(deck, Rating.Again, { start: NOW, end: NOW, mode: 'mixed', retries: 3 });
  const schedule = updated.cards[0].srs;
  assert.equal(schedule.stage, 'learning');
  assert.equal(schedule.state, State.Learning);
  assert.equal(schedule.dueAt, iso(NOW + 600000));
  assert.equal(schedule.introducedAt, iso(NOW));
  assert.equal(schedule.reviews, 1);
  assert.deepEqual(schedule.reviewLog, [{ at: iso(NOW), rating: Rating.Again }]);
  assert.equal(updated.history[0].newCards, 1);
  assert.equal(updated.history[0].reviewCards, 0);
  assert.equal(getDeckSchedule(deckOf(...updated.cards, ...Array.from({ length: 30 }, (_, i) => fresh(i))), NOW).newAvailable, 19);
});

test('practice adds immutable history without changing any schedule or introducing cards', () => {
  const scheduled = finish(deckOf(fresh('review')), { id: 'introduced' }).deck.cards[0];
  const deck = deckOf(fresh('new'), scheduled);
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

test('concurrent FSRS memory or review-log changes cannot be overwritten by an older completed session', () => {
  const introduced = finish(deckOf(fresh('one')), { id: 'initial' }).deck;
  const start = Date.parse(introduced.cards[0].srs.dueAt);
  const { session } = finish(introduced, { start, id: 'pending' });
  const schedule = introduced.cards[0].srs;
  const changes = [
    { stability: schedule.stability + 0.1 },
    { difficulty: Math.min(10, schedule.difficulty + 0.1) },
    { learningSteps: schedule.learningSteps + 1 },
    { elapsedDays: schedule.elapsedDays + 1 },
    { reviewLogComplete: false },
    { reviewLog: [{ ...schedule.reviewLog[0], rating: Rating.Again }] },
  ];
  for (const change of changes) {
    const changed = { ...introduced.cards[0], srs: { ...schedule, ...change } };
    const current = { ...introduced, cards: [changed] };
    const updated = completeStudyDeck(current, session, { id: 'concurrent-fsrs' });
    assert.equal(updated.cards[0], changed, `must preserve newer FSRS field ${Object.keys(change)[0]}`);
    assert.equal(updated.history.length, 2);
  }
});

test('the starting review-log snapshot is detached from mutable current card memory', () => {
  const deck = finish(deckOf(fresh('one')), { id: 'initial' }).deck;
  const start = Date.parse(deck.cards[0].srs.dueAt);
  const session = createStudySession(deck.cards, 'forward', () => 0, { now: start, kind: 'spaced' });
  deck.cards[0].srs.reviewLog[0].rating = Rating.Again;
  good(session);
  const snapshot = structuredClone(deck.cards[0]);
  const updated = completeStudyDeck(deck, session, { id: 'stale-log' });
  assert.deepEqual(updated.cards[0], snapshot);
  assert.equal(updated.cards[0].srs.reviews, 1);
});

test('malformed completion metrics cannot append history or memory observations', () => {
  const original = finish(deckOf(fresh('one')), { id: 'initial' }).deck;
  const start = Date.parse(original.cards[0].srs.dueAt);
  for (const corrupt of [
    (session) => { session.attempts++; },
    (session) => { session.againCount++; },
    (session) => { session.firstPassGood++; },
    (session) => { session.cardResults[0].attempts++; },
    (session) => { session.cardResults[0].directions.forward.completed = false; },
  ]) {
    const { session } = finish(original, { start });
    corrupt(session);
    const snapshot = structuredClone(original);
    assert.equal(completeStudyDeck(original, session, { id: 'invalid' }), original);
    assert.deepEqual(original, snapshot);
  }
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
