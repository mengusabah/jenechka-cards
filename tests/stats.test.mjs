import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { summarizeStats, renderStats, formatStudyDuration } from '../stats.js';

const NOW = new Date(2026, 9, 30, 15).getTime();
const atDay = (offset, hour = 12) => new Date(2026, 9, 30 + offset, hour).toISOString();
const fresh = id => ({ id, front: 'word', back: 'kelime' });
const scheduled = (id, stage, offset) => ({ ...fresh(id), srs: {
  stage, dueAt: atDay(offset), introducedAt: atDay(-20), lastReviewedAt: atDay(-1),
  intervalDays: stage === 'learning' ? 0 : 2, ease: 2.5, repetitions: 1, reviews: 2, lapses: 0,
} });
const deck = (id, history = [], cards = []) => ({ id, name: `Deck ${id}`, source: 'English', target: 'Turkish', history, cards });
const session = (id, day, values = {}) => ({
  id, startedAt: atDay(day, 11), completedAt: atDay(day), mode: 'forward', kind: 'practice',
  cardCount: 10, questionCount: 10, attempts: 12, againCount: 2, firstPassGood: 8,
  durationMs: 100000, newCards: 10, reviewCards: 0, ...values,
});

test('empty and legacy decks have no fabricated history, score, or trend', () => {
  const result = summarizeStats([{ id: 'old', name: 'Legacy', source: 'a', target: 'b', cards: [fresh('one')] }], { now: NOW });
  assert.equal(result.sessionCount, 0);
  assert.equal(result.recall, null);
  assert.equal(result.trend, null);
  assert.equal(result.streak, 0);
  assert.equal(result.durationMs, 0);
  assert.equal(result.activity.length, 14);
  assert.ok(result.activity.every(day => day.sessionCount === 0 && day.recall === null));
  assert.equal(result.schedule.newCount, 1);
  assert.equal(result.schedule.enabledDecks, 1);
});

test('overall and daily recall weight prompts, including both mixed directions', () => {
  const small = session('small', 0, { cardCount: 1, questionCount: 1, firstPassGood: 1, attempts: 1, againCount: 0 });
  const large = session('large', 0, { cardCount: 5, questionCount: 10, firstPassGood: 0, mode: 'mixed', attempts: 20, againCount: 10 });
  const result = summarizeStats([deck('a', [small]), deck('b', [large])], { now: NOW });
  assert.equal(result.recall, 100 / 11);
  assert.equal(result.activity.at(-1).recall, 100 / 11);
  assert.equal(result.questionCount, 11);
  assert.equal(result.cardCount, 6);
  assert.equal(result.attempts, 21);
  assert.equal(result.againCount, 10);
  assert.equal(result.durationMs, 200000);
  assert.equal(result.decks[0].recall, 100);
  assert.equal(result.decks[1].recall, 0);
});

test('only completed, nonempty, nonfuture sessions count and source data is not mutated', () => {
  const input = [deck('a', [session('valid', 0), session('no-date', 0, { completedAt: undefined }), session('bad-date', 0, { completedAt: 'bad' }), session('future', 1), session('empty', 0, { questionCount: 0 })])];
  const before = JSON.stringify(input);
  const result = summarizeStats(input, { now: NOW });
  assert.deepEqual(result.sessions.map(item => item.id), ['valid']);
  assert.equal(JSON.stringify(input), before);
});

test('deck filtering affects every metric, history, active days, and schedule', () => {
  const a = deck('a', [session('a1', -1)], [fresh('a')]);
  const b = deck('b', [session('b1', -3), session('b2', 0)], [fresh('b1'), fresh('b2')]);
  const result = summarizeStats([a, b], { deckId: 'a', now: NOW });
  assert.equal(result.deckCount, 1);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.cardTotal, 1);
  assert.equal(result.activeDays, 1);
  assert.equal(result.streak, 1);
  assert.deepEqual(result.decks.map(item => item.id), ['a']);
  assert.equal(result.schedule.newCount, 1);
  assert.equal(summarizeStats([a], { deckId: 'missing', now: NOW }).sessionCount, 0);
});

test('identical history in imported deck copies counts once globally but remains on each deck', () => {
  const original = session('shared-session', 0);
  const data = [deck('a', [original]), deck('copy', [structuredClone(original)])];
  const overall = summarizeStats(data, { now: NOW });
  assert.equal(overall.sessionCount, 1);
  assert.equal(overall.questionCount, 10);
  assert.equal(overall.durationMs, 100000);
  assert.equal(overall.duplicateSessionCount, 1);
  assert.equal(overall.decks[0].sessionCount, 1);
  assert.equal(overall.decks[1].sessionCount, 1);
  assert.equal(summarizeStats(data, { deckId: 'copy', now: NOW }).sessionCount, 1);
  assert.equal(summarizeStats(data, { deckId: 'copy', now: NOW }).duplicateSessionCount, 0);
  const changed = summarizeStats([deck('a', [original]), deck('b', [{ ...original, firstPassGood: 7 }])], { now: NOW });
  assert.equal(changed.sessionCount, 2);
  assert.equal(changed.duplicateSessionCount, 0);
});

test('streak counts active local dates once and remains open through today', () => {
  assert.equal(summarizeStats([deck('a', [session('a', -1), session('b', -1), session('c', -2)])], { now: NOW }).streak, 2);
  assert.equal(summarizeStats([deck('a', [session('a', 0), session('b', -1), session('c', -3)])], { now: NOW }).streak, 2);
  assert.equal(summarizeStats([deck('a', [session('a', -2), session('b', -3)])], { now: NOW }).streak, 0);
});

test('local-day grouping and streaks cross both daylight-saving transitions', () => {
  const script = `
    import { summarizeStats } from ${JSON.stringify(new URL('../stats.js', import.meta.url).href)};
    for (const [month, endDay] of [[2, 9], [10, 2]]) {
      const now = new Date(2026, month, endDay, 18).getTime();
      const history = [0, -1, -2].map((offset, i) => ({ id: String(i), completedAt: new Date(2026, month, endDay + offset, 0, 30).toISOString(), questionCount: 2, firstPassGood: 1 }));
      const result = summarizeStats([{id:'a', cards:[], history}], { now });
      if (result.streak !== 3 || result.activeDays !== 3 || result.activity.slice(-3).some(day => day.sessionCount !== 1)) throw new Error(JSON.stringify(result));
    }
    const result = summarizeStats([{id:'a', cards:[], history:[{completedAt:'2026-10-31T02:00:00Z', questionCount:2, firstPassGood:1}]}], { now: Date.parse('2026-10-31T03:00:00Z') });
    if (result.activity.at(-1).date !== '2026-10-30' || result.streak !== 1) throw new Error('UTC date used instead of local date');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' } });
});

test('recall trend compares complete calendar windows and needs evidence in both', () => {
  const old = session('outside', -14, { firstPassGood: 10 });
  const previous = session('previous', -13, { firstPassGood: 5 });
  const recent = session('recent', -6, { firstPassGood: 8 });
  const result = summarizeStats([deck('a', [old, previous, recent])], { now: NOW });
  assert.equal(result.trend.previousRecall, 50);
  assert.equal(result.trend.recentRecall, 80);
  assert.equal(result.trend.difference, 30);
  assert.equal(result.activity.reduce((total, day) => total + day.sessionCount, 0), 2);
  assert.equal(summarizeStats([deck('a', [recent])], { now: NOW }).trend, null);
  assert.equal(summarizeStats([deck('a', [previous, session('tiny', 0, { questionCount: 4, firstPassGood: 4 })])], { now: NOW }).trend, null);
});

test('SRS stages are disjoint, due includes learning, paused decks excluded, and overdue appears today', () => {
  const active = deck('a', [], [fresh('new'), scheduled('learning-due', 'learning', -1), scheduled('learning-future', 'learning', 2), scheduled('review-due', 'review', -2), scheduled('review-future', 'review', 1)]);
  const paused = { ...deck('off', [], [fresh('excluded'), scheduled('paused', 'review', -3)]), spacedRepetition: false };
  const result = summarizeStats([active, paused], { now: NOW });
  assert.equal(result.schedule.enabledDecks, 1);
  assert.equal(result.schedule.pausedDecks, 1);
  assert.equal(result.schedule.newCount, 1);
  assert.equal(result.schedule.learningCount, 2);
  assert.equal(result.schedule.reviewCount, 2);
  assert.equal(result.schedule.total, 5);
  assert.equal(result.schedule.dueCount, 2);
  assert.equal(result.schedule.readyCount, 3);
  assert.equal(result.schedule.upcoming[0].count, 2);
  assert.equal(result.schedule.upcoming[1].count, 1);
  assert.equal(result.schedule.upcoming[2].count, 1);
});

test('history is newest first and bounded, with full metrics still computed', () => {
  const history = Array.from({ length: 25 }, (_, index) => session(`s${index}`, -index));
  const data = [deck('a', history.toReversed())];
  const result = summarizeStats(data, { now: NOW });
  assert.equal(result.sessionCount, 25);
  assert.equal(result.sessions[0].id, 's0');
  assert.equal(result.sessions.at(-1).id, 's24');
  const first = renderStats(data, { now: NOW, historyLimit: 20 });
  assert.equal((first.match(/class="stats-session"/g) || []).length, 20);
  assert.match(first, /data-stats-more/);
  const all = renderStats(data, { now: NOW, historyLimit: 40 });
  assert.equal((all.match(/class="stats-session"/g) || []).length, 25);
  assert.doesNotMatch(all, /data-stats-more/);
});

test('stats HTML escapes editable text and provides accessible chart descriptions', () => {
  const hostile = { ...deck('safe-id', [session('a', 0)], [fresh('one')]), name: '<img src=x onerror="alert(1)">', source: '<b>English</b>', target: '<script>bad</script>' };
  const html = renderStats([hostile], { now: NOW });
  assert.doesNotMatch(html, /<img|<script>|<b>English/);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-stats-deck="safe-id"/);
  assert.match(html, /role="img" aria-label=/);
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.match(renderStats([hostile], { deckId: 'safe-id', now: NOW }), /data-study="safe-id"/);
  assert.match(renderStats([], { deckId: 'missing', now: NOW }), /Deck not found/);
});

test('active time is formatting of tracked duration rather than session wall time', () => {
  assert.equal(formatStudyDuration(0), '0s');
  assert.equal(formatStudyDuration(-100), '0s');
  assert.equal(formatStudyDuration(59000), '59s');
  assert.equal(formatStudyDuration(61000), '1m 1s');
  assert.equal(formatStudyDuration(3720000), '1h 2m');
  const result = summarizeStats([deck('a', [session('a', 0, { durationMs: 61000 })])], { now: NOW });
  assert.equal(result.durationMs, 61000);
});
