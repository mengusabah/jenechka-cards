import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudySession, rateStudyCard } from '../study.js';

const cards = Object.freeze([
  Object.freeze({ id: 'cat', front: 'cat', back: 'kedi' }),
  Object.freeze({ id: 'dog', front: 'dog', back: 'köpek' }),
  Object.freeze({ id: 'bird', front: 'bird', back: 'kuş' }),
]);

function markGood(session) {
  session.flipped = true;
  return rateStudyCard(session, 'good');
}

test('mixed asks both directions of every card exactly once regardless of shuffle', () => {
  for (const random of [() => 0, () => 0.5, () => 1 - Number.EPSILON]) {
    const session = createStudySession(cards, 'mixed', random);
    assert.equal(session.mode, 'mixed');
    assert.equal(session.total, cards.length * 2);
    assert.equal(session.queue.length, session.total);
    assert.equal(session.done, 0);
    assert.equal(session.flipped, false);
    for (const card of cards) {
      const prompts = session.queue.filter((prompt) => prompt.id === card.id);
      assert.deepEqual(prompts.map((prompt) => prompt.reverse).sort(), [false, true]);
      for (const prompt of prompts) {
        assert.equal(prompt.front, card.front);
        assert.equal(prompt.back, card.back);
        assert.notEqual(prompt, card);
      }
      assert.notEqual(prompts[0], prompts[1]);
    }
  }
});

test('forward and reverse still ask each card once in the chosen direction', () => {
  for (const mode of ['forward', 'reverse']) {
    const session = createStudySession(cards, mode, () => 0);
    assert.equal(session.total, cards.length);
    assert.deepEqual(session.queue.map((card) => card.id).sort(), cards.map((card) => card.id).sort());
    assert.ok(session.queue.every((card) => card.reverse === (mode === 'reverse')));
    assert.equal(markGood(session), false);
    assert.equal(markGood(session), false);
    assert.equal(markGood(session), true);
    assert.equal(session.done, cards.length);
    assert.equal(session.queue.length, 0);
  }
});

test('study prompts are copies and source deck order and content stay untouched', () => {
  const snapshot = JSON.stringify(cards);
  const session = createStudySession(cards, 'mixed', () => 0);
  const prompt = session.queue[0];
  const otherDirection = session.queue.find((card) => card.id === prompt.id && card !== prompt);
  prompt.front = 'changed during study';
  assert.notEqual(otherDirection.front, prompt.front);
  session.flipped = true;
  rateStudyCard(session, 'again');
  markGood(session);
  assert.equal(JSON.stringify(cards), snapshot);
});

test('ratings cannot advance an unanswered card and unsupported ratings cannot mutate a session', () => {
  const session = createStudySession(cards, 'mixed', () => 0);
  const snapshot = structuredClone(session);
  assert.equal(rateStudyCard(session, 'good'), false);
  assert.equal(rateStudyCard(session, 'again'), false);
  assert.deepEqual(session, snapshot);
  session.flipped = true;
  assert.throws(() => rateStudyCard(session, 'skip'), RangeError);
  assert.deepEqual(session, { ...snapshot, flipped: true });
});

test('mixed completes only after both prompts of every card receive Good', () => {
  const session = createStudySession(cards, 'mixed', () => 1 - Number.EPSILON);
  for (let completed = 1; completed <= cards.length * 2; completed++) {
    assert.equal(markGood(session), completed === cards.length * 2);
    assert.equal(session.done, completed);
    assert.equal(session.queue.length, session.total - completed);
    assert.equal(session.flipped, false);
  }
});

test('Again requeues the exact prompt with its direction and does not increase completed count', () => {
  const session = createStudySession(cards, 'mixed', () => 1 - Number.EPSILON);
  const first = session.queue[0];
  const remaining = session.queue.slice(1);
  session.flipped = true;
  assert.equal(rateStudyCard(session, 'again'), false);
  assert.equal(session.total, cards.length * 2);
  assert.equal(session.done, 0);
  assert.equal(session.flipped, false);
  assert.deepEqual(session.queue, [remaining[0], remaining[1], first, ...remaining.slice(2)]);
  assert.equal(session.queue[2], first);
  assert.equal(session.queue[2].reverse, false);

  // The reverse prompt has an independent retry and must also be completed.
  const reversePrompt = session.queue[0];
  assert.equal(reversePrompt.reverse, true);
  session.flipped = true;
  assert.equal(rateStudyCard(session, 'again'), false);
  assert.equal(session.queue[2], reversePrompt);
  assert.equal(session.done, 0);
  for (let completed = 1; completed <= session.total; completed++) {
    assert.equal(markGood(session), completed === session.total);
    assert.equal(session.done, completed);
  }
});

test('Again on the last prompt keeps the session active until that prompt receives Good', () => {
  const session = createStudySession(cards.slice(0, 1), 'mixed', () => 1 - Number.EPSILON);
  assert.equal(markGood(session), false);
  const finalPrompt = session.queue[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    session.flipped = true;
    assert.equal(rateStudyCard(session, 'again'), false);
    assert.equal(session.queue[0], finalPrompt);
    assert.equal(session.queue[0].reverse, true);
    assert.equal(session.done, 1);
    assert.equal(session.total, 2);
  }
  assert.equal(markGood(session), true);
  assert.equal(session.done, 2);
  assert.equal(rateStudyCard(session, 'good'), false);
  assert.equal(session.done, 2);
});

test('restarting creates a fresh full session with independent prompts', () => {
  const first = createStudySession(cards, 'mixed', () => 0);
  while (first.queue.length) markGood(first);
  const restarted = createStudySession(cards, first.mode, () => 0);
  assert.equal(restarted.total, cards.length * 2);
  assert.equal(restarted.queue.length, cards.length * 2);
  assert.equal(restarted.done, 0);
  assert.equal(restarted.flipped, false);
  assert.equal(first.done, first.total);
  assert.equal(first.queue.length, 0);
});

test('empty decks have no prompts and unknown modes are rejected', () => {
  const session = createStudySession([], 'mixed');
  assert.equal(session.mode, 'mixed');
  assert.equal(session.total, 0);
  assert.equal(session.done, 0);
  assert.equal(session.flipped, false);
  assert.deepEqual(session.queue, []);
  assert.deepEqual(session.cardResults, []);
  assert.equal(session.completedAt, null);
  assert.equal(rateStudyCard(session, 'good'), false);
  assert.throws(() => createStudySession(cards, 'unknown'), RangeError);
});

test('mixed metrics count the first attempt independently for each direction', () => {
  let time = Date.parse('2026-10-30T10:00:00Z');
  const session = createStudySession(cards.slice(0, 1), 'mixed', () => 1 - Number.EPSILON, { now: () => time, kind: 'spaced' });
  assert.equal(session.startedAt, '2026-10-30T10:00:00.000Z');
  assert.equal(session.kind, 'spaced');
  assert.equal(session.cardCount, 1);
  session.flipped = true;
  rateStudyCard(session, 'again'); // forward again; reverse becomes next.
  assert.equal(markGood(session), false);
  session.flipped = true;
  rateStudyCard(session, 'again'); // same forward prompt fails twice.
  time += 8000;
  assert.equal(markGood(session), true);
  assert.equal(session.completedAt, '2026-10-30T10:00:08.000Z');
  assert.equal(session.attempts, 4);
  assert.equal(session.againCount, 2);
  assert.equal(session.firstPassGood, 1);
  assert.deepEqual(session.cardResults[0], {
    cardId: 'cat', isNew: true, initialSrs: null, questionCount: 2,
    attempts: 4, againCount: 2, firstPassGood: 1, completed: true,
    directions: {
      forward: { attempts: 3, againCount: 2, firstPassGood: false, completed: true },
      reverse: { attempts: 1, againCount: 0, firstPassGood: true, completed: true },
    },
  });
});

test('metrics stay untouched until a flipped question is rated and completion is stable', () => {
  let now = Date.parse('2026-10-30T12:00:00Z');
  const session = createStudySession(cards, 'forward', () => 0, { now: () => now });
  assert.equal(rateStudyCard(session, 'good'), false);
  assert.equal(session.attempts, 0);
  assert.equal(session.cardResults.every(result => result.attempts === 0), true);
  while (session.queue.length) markGood(session);
  assert.equal(session.firstPassGood, 3);
  assert.equal(session.attempts, 3);
  assert.equal(session.againCount, 0);
  const completed = session.completedAt;
  now += 100000;
  assert.equal(markGood(session), false);
  assert.equal(session.completedAt, completed);
  assert.equal(session.attempts, 3);
});

test('initial SRS is a snapshot and each new session resets measurements', () => {
  const srs = { stage: 'review', dueAt: '2026-10-30T10:00:00Z', repetitions: 1 };
  const source = [{ ...cards[0], srs }];
  const session = createStudySession(source, 'reverse', () => 0, { now: 0 });
  assert.equal(session.cardResults[0].isNew, false);
  assert.notEqual(session.cardResults[0].initialSrs, srs);
  srs.repetitions = 99;
  assert.equal(session.cardResults[0].initialSrs.repetitions, 1);
  markGood(session);
  const next = createStudySession(source, 'reverse', () => 0, { now: 1000 });
  assert.equal(next.attempts, 0);
  assert.equal(next.firstPassGood, 0);
  assert.equal(next.completedAt, null);
  assert.deepEqual(next.cardResults[0].directions, {
    reverse: { attempts: 0, againCount: 0, firstPassGood: false, completed: false },
  });
});

test('clock reversal cannot produce a negative session and invalid options are rejected', () => {
  let now = 1000;
  const session = createStudySession(cards.slice(0, 1), 'forward', () => 0, { now: () => now });
  now = 500;
  markGood(session);
  assert.equal(session.completedAt, session.startedAt);
  assert.throws(() => createStudySession(cards, 'forward', () => 0, { kind: 'exam' }), RangeError);
  assert.throws(() => createStudySession(cards, 'forward', () => 0, { now: NaN }), RangeError);
});

test('spaced sessions shuffle introduced cards before new cards while keeping every requested direction', () => {
  const selected = [
    { id: 'new-a', front: 'a', back: 'A' },
    { id: 'review', front: 'b', back: 'B', srs: { stage: 'review' } },
    { id: 'new-b', front: 'c', back: 'C' },
    { id: 'learning', front: 'd', back: 'D', srs: { stage: 'learning' } },
  ];
  const before = structuredClone(selected);
  for (const mode of ['forward', 'reverse', 'mixed']) {
    for (const random of [() => 0, () => 0.5, () => 1 - Number.EPSILON]) {
      const session = createStudySession(selected, mode, random, { kind: 'spaced', now: 0 });
      const groupLength = mode === 'mixed' ? 4 : 2;
      assert.ok(session.queue.slice(0, groupLength).every(prompt => prompt.srs));
      assert.ok(session.queue.slice(groupLength).every(prompt => !prompt.srs));
      for (const card of selected) {
        const directions = session.queue.filter(prompt => prompt.id === card.id).map(prompt => prompt.reverse).sort();
        assert.deepEqual(directions, mode === 'mixed' ? [false, true] : [mode === 'reverse']);
      }
    }
  }
  const spaced = createStudySession(selected, 'mixed', () => 0, { kind: 'spaced', now: 0 });
  assert.deepEqual(spaced.queue.slice(0, 4).map(prompt => [prompt.id, prompt.reverse]), [
    ['review', true], ['learning', false], ['learning', true], ['review', false],
  ]);
  const retry = spaced.queue[0];
  spaced.flipped = true;
  rateStudyCard(spaced, 'again');
  assert.equal(spaced.queue[3], retry);
  assert.equal(spaced.attempts, 1);
  assert.equal(spaced.againCount, 1);
  const practice = createStudySession(selected, 'forward', () => 1 - Number.EPSILON, { kind: 'practice', now: 0 });
  assert.deepEqual(practice.queue.map(prompt => prompt.id), selected.map(card => card.id));
  assert.deepEqual(selected, before);
});
