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
  assert.deepEqual(session, { mode: 'mixed', total: 0, done: 0, flipped: false, queue: [] });
  assert.equal(rateStudyCard(session, 'good'), false);
  assert.throws(() => createStudySession(cards, 'unknown'), RangeError);
});
