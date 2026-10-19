export function createStudySession(cards, mode, random = Math.random) {
  if (!['forward', 'reverse', 'mixed'].includes(mode)) throw new RangeError('Unknown study mode.');

  const queue = cards.flatMap((card) => mode === 'mixed'
    ? [{ ...card, reverse: false }, { ...card, reverse: true }]
    : [{ ...card, reverse: mode === 'reverse' }]);

  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  return { mode, total: queue.length, done: 0, flipped: false, queue };
}

export function rateStudyCard(session, rating) {
  if (!['again', 'good'].includes(rating)) throw new RangeError('Unknown study rating.');
  if (!session.flipped || !session.queue.length) return false;

  const card = session.queue.shift();
  if (rating === 'good') session.done++;
  else session.queue.splice(Math.min(session.queue.length, Math.max(1, Math.floor(session.queue.length / 2))), 0, card);
  session.flipped = false;
  return session.done === session.total;
}
