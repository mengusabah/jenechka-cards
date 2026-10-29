// Browser-local FSRS-6, pinned to the upstream ts-fsrs 5.4.2 implementation.
// https://github.com/open-spaced-repetition/ts-fsrs/tree/v5.4.2
// The distributed library and its MIT notice live together in vendor/.
import { fsrs, createEmptyCard, Rating, State, default_w, S_MIN, S_MAX } from './vendor/ts-fsrs-5.4.2.mjs';

export const FSRS_PROFILE = 'fsrs6-default-90-v1';
export const FSRS_PARAMETERS = Object.freeze({
  w: Object.freeze([...default_w]),
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: Object.freeze(['10m']),
  relearning_steps: Object.freeze(['10m']),
});
const scheduler = fsrs(FSRS_PARAMETERS);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const count = value => clamp(value, 0, Number.MAX_SAFE_INTEGER);

function legacyMemory(previous) {
  // Approximate legacy memory using the official FSRS-6 SM-2 conversion:
  // https://docs.rs/fsrs/latest/src/fsrs/inference.rs.html#289-311
  // The historical retention is assumed to be .9; aggregate session history
  // cannot reconstruct past per-card ratings. Never manufacture review logs.
  const w = FSRS_PARAMETERS.w;
  const retention = 0.9;
  const decay = -w[20];
  const factor = 0.9 ** (1 / decay) - 1;
  const stability = clamp(Math.max(previous.intervalDays, S_MIN) * factor
    / (retention ** (1 / decay) - 1), S_MIN, S_MAX);
  const difficulty = clamp(11 - (previous.ease - 1)
    / (Math.exp(w[8]) * stability ** (-w[9]) * Math.expm1((1 - retention) * w[10])), 1, 10);
  return { stability, difficulty };
}

function toFSRSCard(previous, now) {
  if (!previous) return createEmptyCard(now);
  const isFSRS = previous.algorithm === 'fsrs-6';
  if (previous.algorithm !== undefined && !isFSRS) throw new Error('Unknown review algorithm. Update the app before studying this deck.');
  if (isFSRS && previous.profile !== FSRS_PROFILE) throw new Error('Unknown FSRS profile. Update the app before studying this deck.');
  return {
    due: new Date(previous.dueAt),
    ...(isFSRS ? { stability: previous.stability, difficulty: previous.difficulty } : legacyMemory(previous)),
    elapsed_days: isFSRS ? previous.elapsedDays : 0,
    scheduled_days: previous.intervalDays,
    reps: previous.reviews,
    lapses: previous.lapses,
    state: isFSRS ? previous.state : previous.stage === 'review' ? State.Review : State.Learning,
    learning_steps: isFSRS ? previous.learningSteps : 0,
    last_review: new Date(previous.lastReviewedAt),
  };
}

export function scheduleFSRSCard(previous, result, completedAt) {
  const now = new Date(completedAt);
  // A finished Mixed session is one combined recall test per word. A miss on
  // either side wins; immediate retries do not become extra FSRS successes.
  const rating = result.againCount > 0 ? Rating.Again : Rating.Good;
  const { card } = scheduler.next(toFSRSCard(previous, now), now, rating);
  const wasFSRS = previous?.algorithm === 'fsrs-6';
  return {
    algorithm: 'fsrs-6',
    profile: FSRS_PROFILE,
    stage: card.state === State.Review ? 'review' : 'learning',
    dueAt: card.due.toISOString(),
    intervalDays: card.scheduled_days,
    lapses: count(card.lapses),
    reviews: count(card.reps),
    lastReviewedAt: now.toISOString(),
    introducedAt: previous?.introducedAt ?? now.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    state: card.state,
    learningSteps: card.learning_steps,
    elapsedDays: card.elapsed_days,
    reviewLogComplete: wasFSRS ? previous.reviewLogComplete : !previous,
    reviewLog: [
      ...(wasFSRS ? previous.reviewLog.map(entry => ({ ...entry })) : []),
      { at: now.toISOString(), rating },
    ],
  };
}
