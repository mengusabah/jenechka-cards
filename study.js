const clocks = new WeakMap();
const promptResults = new WeakMap();

function timestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new RangeError('Invalid study time.');
  return time;
}

function shuffle(queue, random) {
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  return queue;
}

export function createStudySession(cards, mode, random = Math.random, { now = Date.now, kind = 'practice' } = {}) {
  if (!['forward', 'reverse', 'mixed'].includes(mode)) throw new RangeError('Unknown study mode.');
  if (!['practice', 'spaced'].includes(kind)) throw new RangeError('Unknown study kind.');

  const cardResults = [];
  const prompts = cards.flatMap((card) => {
    const directions = mode === 'mixed' ? [false, true] : [mode === 'reverse'];
    const result = {
      cardId: card.id,
      isNew: !card.srs,
      initialSrs: card.srs ? JSON.parse(JSON.stringify(card.srs)) : null,
      questionCount: directions.length,
      attempts: 0,
      againCount: 0,
      firstPassGood: 0,
      completed: false,
      directions: {},
    };
    cardResults.push(result);
    return directions.map((reverse) => {
      result.directions[reverse ? 'reverse' : 'forward'] = {
        attempts: 0, againCount: 0, firstPassGood: false, completed: false,
      };
      const prompt = { ...card, reverse };
      promptResults.set(prompt, result);
      return prompt;
    });
  });

  // Review and learning prompts start before new material. Each group is
  // shuffled independently; an Again still uses the normal retry insertion.
  const queue = kind === 'spaced'
    ? [
      ...shuffle(prompts.filter((prompt) => !promptResults.get(prompt).isNew), random),
      ...shuffle(prompts.filter((prompt) => promptResults.get(prompt).isNew), random),
    ]
    : shuffle(prompts, random);

  const session = {
    mode, kind, total: queue.length, done: 0, flipped: false, queue,
    cardCount: cards.length, cardResults, attempts: 0, againCount: 0, firstPassGood: 0,
    startedAt: new Date(timestamp(now)).toISOString(), completedAt: null,
  };
  clocks.set(session, now);
  return session;
}

export function rateStudyCard(session, rating) {
  if (!['again', 'good'].includes(rating)) throw new RangeError('Unknown study rating.');
  if (!session.flipped || !session.queue.length) return false;

  const card = session.queue.shift();
  const result = promptResults.get(card);
  const direction = result.directions[card.reverse ? 'reverse' : 'forward'];
  session.attempts++;
  result.attempts++;
  direction.attempts++;
  if (rating === 'good') {
    session.done++;
    direction.completed = true;
    if (direction.attempts === 1) {
      direction.firstPassGood = true;
      session.firstPassGood++;
      result.firstPassGood++;
    }
    result.completed = Object.values(result.directions).every((value) => value.completed);
  } else {
    session.againCount++;
    result.againCount++;
    direction.againCount++;
    session.queue.splice(Math.min(session.queue.length, Math.max(1, Math.floor(session.queue.length / 2))), 0, card);
  }
  session.flipped = false;
  const complete = session.done === session.total;
  if (complete) {
    // A device clock change must not produce a completion before the start.
    session.completedAt = new Date(Math.max(Date.parse(session.startedAt), timestamp(clocks.get(session) ?? Date.now))).toISOString();
  }
  return complete;
}
