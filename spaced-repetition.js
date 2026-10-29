import { scheduleFSRSCard } from './fsrs-scheduler.js';

const DAILY_NEW_LIMIT = 20;
const SESSION_LIMIT = 50;

function timeOf(value) {
  const time = new Date(typeof value === 'function' ? value() : value).getTime();
  if (!Number.isFinite(time)) throw new RangeError('Invalid study time.');
  return time;
}

function localDate(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function introducedToday(cards, now) {
  const today = localDate(now);
  return cards.filter((card) => card.srs && localDate(card.srs.introducedAt) === today).length;
}

export function isSpacedEnabled(deck) {
  return deck.spacedRepetition !== false;
}

export function getDeckSchedule(deck, now = Date.now()) {
  const time = timeOf(now);
  let newCount = 0;
  let learningCount = 0;
  let dueLearningCount = 0;
  let dueCount = 0;
  let scheduledCount = 0;
  let nextDue = Infinity;
  for (const card of deck.cards) {
    if (!card.srs) { newCount++; continue; }
    const due = timeOf(card.srs.dueAt);
    if (card.srs.stage === 'learning') {
      learningCount++;
      if (due <= time) dueLearningCount++;
    } else if (due <= time) dueCount++;
    else scheduledCount++;
    if (due > time) nextDue = Math.min(nextDue, due);
  }
  const newAvailable = Math.min(newCount, Math.max(0, DAILY_NEW_LIMIT - introducedToday(deck.cards, time)));
  return {
    newCount, learningCount, dueLearningCount, dueCount, scheduledCount, newAvailable,
    readyCount: dueLearningCount + dueCount + newAvailable,
    nextDueAt: Number.isFinite(nextDue) ? new Date(nextDue).toISOString() : null,
  };
}

export function selectStudyCards(deck, now = Date.now()) {
  if (!isSpacedEnabled(deck)) return deck.cards.slice();
  const time = timeOf(now);
  // Introduced cards whose deadline has arrived take priority over new cards.
  // Sorting a separate array preserves the user's deck order.
  const due = deck.cards.filter((card) => card.srs && timeOf(card.srs.dueAt) <= time)
    .sort((a, b) => timeOf(a.srs.dueAt) - timeOf(b.srs.dueAt));
  const available = getDeckSchedule(deck, time).newAvailable;
  const fresh = deck.cards.filter((card) => !card.srs).slice(0, available);
  return [...due, ...fresh].slice(0, SESSION_LIMIT);
}

function finished(session) {
  if (!session || session.total <= 0 || session.done !== session.total || session.queue.length || !session.completedAt) return false;
  if (!Array.isArray(session.cardResults) || session.cardResults.length !== session.cardCount) return false;
  const totals = { questions: 0, attempts: 0, again: 0, first: 0 };
  for (const result of session.cardResults) {
    const directions = Object.values(result.directions);
    if (!result.completed || directions.length !== result.questionCount || !directions.every((direction) => direction.completed)) return false;
    if (result.attempts !== result.questionCount + result.againCount) return false;
    totals.questions += result.questionCount;
    totals.attempts += result.attempts;
    totals.again += result.againCount;
    totals.first += result.firstPassGood;
  }
  return totals.questions === session.total && totals.attempts === session.attempts
    && totals.again === session.againCount && totals.first === session.firstPassGood;
}

function sameSchedule(left, right) {
  if (!left || !right) return !left && !right;
  const fields = Object.keys(left);
  return fields.length === Object.keys(right).length && fields.every(key => key === 'reviewLog'
    ? Array.isArray(right.reviewLog) && left.reviewLog.length === right.reviewLog.length
      && left.reviewLog.every((entry, index) => entry.at === right.reviewLog[index].at && entry.rating === right.reviewLog[index].rating)
    : left[key] === right[key]);
}

export function completeStudyDeck(deck, session, { id, completedAt, durationMs = 0 } = {}) {
  if (!finished(session)) return deck;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError('A study history ID is required.');
  const history = deck.history ?? [];
  if (history.some((record) => record.id === id)) return deck;
  const startedTime = timeOf(session.startedAt);
  const completedTime = Math.max(startedTime, timeOf(completedAt ?? session.completedAt));
  const end = new Date(completedTime).toISOString();
  const activeDuration = Number.isFinite(durationMs) ? Math.min(completedTime - startedTime, Math.max(0, Math.floor(durationMs))) : 0;
  const newCards = session.cardResults.filter((result) => result.isNew).length;
  const record = {
    id, startedAt: session.startedAt, completedAt: end, mode: session.mode, kind: session.kind,
    cardCount: session.cardCount, questionCount: session.total, attempts: session.attempts,
    againCount: session.againCount, firstPassGood: session.firstPassGood,
    durationMs: activeDuration, newCards, reviewCards: session.cardCount - newCards,
  };
  let cards = deck.cards;
  if (session.kind === 'spaced') {
    const byId = new Map(deck.cards.map((card) => [card.id, card]));
    const updates = new Map();
    let newRemaining = Math.max(0, DAILY_NEW_LIMIT - introducedToday(deck.cards, completedTime));
    const results = session.cardResults.slice().sort((a, b) => Number(a.isNew) - Number(b.isNew));
    for (const result of results) {
      const card = byId.get(result.cardId);
      if (!card || updates.size >= SESSION_LIMIT || !sameSchedule(card.srs, result.initialSrs)) continue;
      // Even a caller passing an entire deck cannot postpone early cards.
      // A concurrent save that changed a schedule also retains that newer state.
      if (card.srs && timeOf(card.srs.dueAt) > startedTime) continue;
      if (!card.srs) {
        if (newRemaining <= 0) continue;
        newRemaining--;
      }
      updates.set(card.id, { ...card, srs: scheduleFSRSCard(card.srs, result, end) });
    }
    cards = deck.cards.map((card) => updates.get(card.id) ?? card);
  }
  return { ...deck, cards, history: [...history, record] };
}
