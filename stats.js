import { getDeckSchedule, isSpacedEnabled } from './spaced-repetition.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const count = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
const number = value => Math.round(value).toLocaleString('en-US');
const percent = value => value === null ? '—' : `${Math.round(value)}%`;
const validTime = value => typeof value === 'string' ? Date.parse(value) : NaN;
const localDate = value => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// Calendar arithmetic deliberately avoids adding 24-hour intervals: a local day
// can be 23 or 25 hours when daylight-saving time changes.
function dayAt(value, offset = 0) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 12);
}

export function formatStudyDuration(milliseconds) {
  const seconds = Math.floor(count(milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function completedSessions(deck, now) {
  return (Array.isArray(deck.history) ? deck.history : []).flatMap(session => {
    const completedMs = validTime(session?.completedAt);
    const questionCount = Math.floor(count(session?.questionCount));
    if (!Number.isFinite(completedMs) || completedMs > now || !questionCount) return [];
    return [{
      ...session,
      deckId: deck.id,
      deckName: deck.name,
      completedMs,
      questionCount,
      firstPassGood: Math.min(questionCount, Math.floor(count(session.firstPassGood))),
      cardCount: Math.floor(count(session.cardCount)),
      attempts: Math.floor(count(session.attempts)),
      againCount: Math.floor(count(session.againCount)),
      durationMs: count(session.durationMs),
      newCards: Math.floor(count(session.newCards)),
      reviewCards: Math.floor(count(session.reviewCards)),
    }];
  });
}

function totalsFor(sessions) {
  const totals = sessions.reduce((total, session) => {
    for (const key of ['questionCount', 'firstPassGood', 'cardCount', 'attempts', 'againCount', 'durationMs', 'newCards', 'reviewCards']) total[key] += session[key];
    return total;
  }, { questionCount: 0, firstPassGood: 0, cardCount: 0, attempts: 0, againCount: 0, durationMs: 0, newCards: 0, reviewCards: 0 });
  return { ...totals, sessionCount: sessions.length, recall: totals.questionCount ? totals.firstPassGood / totals.questionCount * 100 : null };
}

function activeStreak(activeDates, now) {
  let offset = activeDates.has(localDate(now)) ? 0 : -1;
  let streak = 0;
  while (activeDates.has(localDate(dayAt(now, offset)))) { streak++; offset--; }
  return streak;
}

function scheduleSummary(decks, now) {
  const summary = { enabledDecks: 0, pausedDecks: 0, newCount: 0, learningCount: 0, reviewCount: 0, dueCount: 0, readyCount: 0, newAvailable: 0, nextDueAt: null };
  const upcoming = Array.from({ length: 7 }, (_, index) => ({ date: localDate(dayAt(now, index)), count: 0 }));
  const upcomingMap = new Map(upcoming.map(day => [day.date, day]));
  const today = localDate(now);
  for (const deck of decks) {
    if (!isSpacedEnabled(deck)) { summary.pausedDecks++; continue; }
    summary.enabledDecks++;
    const schedule = getDeckSchedule(deck, now);
    summary.dueCount += count(schedule.dueCount) + count(schedule.dueLearningCount);
    summary.readyCount += count(schedule.readyCount);
    summary.newAvailable += count(schedule.newAvailable);
    if (schedule.nextDueAt && (!summary.nextDueAt || Date.parse(schedule.nextDueAt) < Date.parse(summary.nextDueAt))) summary.nextDueAt = schedule.nextDueAt;
    for (const card of deck.cards || []) {
      if (!card.srs) { summary.newCount++; continue; }
      if (card.srs.stage === 'learning') summary.learningCount++;
      else summary.reviewCount++;
      const due = validTime(card.srs.dueAt);
      if (!Number.isFinite(due)) continue;
      const dueDate = localDate(due);
      // The Today bucket includes overdue cards, so the chart reflects the
      // whole backlog rather than hiding cards with an earlier due date.
      const bucket = dueDate <= today ? upcoming[0] : upcomingMap.get(dueDate);
      if (bucket) bucket.count++;
    }
  }
  return { ...summary, total: summary.newCount + summary.learningCount + summary.reviewCount, upcoming };
}

/** Pure completed-session summaries; old decks never acquire invented history. */
export function summarizeStats(decks, { deckId = null, now = Date.now(), days = 14 } = {}) {
  const selected = deckId === null ? decks : decks.filter(deck => deck.id === deckId);
  const byDeck = new Map(selected.map(deck => [deck.id, completedSessions(deck, now)]));
  const seen = new Set();
  let duplicateSessionCount = 0;
  const sessions = selected.flatMap(deck => byDeck.get(deck.id)).filter(session => {
    if (deckId !== null || !session.id) return true;
    // A backup imported as a separate deck can carry the same completed
    // sessions. Count an exact copy once globally; preserve each deck's history.
    const identity = JSON.stringify([session.id, session.startedAt, session.completedAt, session.mode, session.kind,
      session.cardCount, session.questionCount, session.attempts, session.againCount, session.firstPassGood,
      session.durationMs, session.newCards, session.reviewCards]);
    if (seen.has(identity)) { duplicateSessionCount++; return false; }
    seen.add(identity);
    return true;
  }).sort((a, b) => b.completedMs - a.completedMs);
  const totals = totalsFor(sessions);
  const activeDates = new Set(sessions.map(session => localDate(session.completedMs)));
  const dayCount = Math.max(1, Math.min(90, Math.floor(days) || 14));
  const activity = Array.from({ length: dayCount }, (_, index) => ({ date: localDate(dayAt(now, index - dayCount + 1)), sessions: [] }));
  const activityMap = new Map(activity.map(day => [day.date, day]));
  for (const session of sessions) activityMap.get(localDate(session.completedMs))?.sessions.push(session);
  const recentStart = localDate(dayAt(now, -6));
  const previousStart = localDate(dayAt(now, -13));
  const today = localDate(now);
  const recent = totalsFor(sessions.filter(session => localDate(session.completedMs) >= recentStart && localDate(session.completedMs) <= today));
  const previous = totalsFor(sessions.filter(session => localDate(session.completedMs) >= previousStart && localDate(session.completedMs) < recentStart));
  const trend = recent.questionCount >= 5 && previous.questionCount >= 5
    ? { recentRecall: recent.recall, previousRecall: previous.recall, difference: recent.recall - previous.recall, recentQuestions: recent.questionCount, previousQuestions: previous.questionCount }
    : null;
  return {
    ...totals,
    sessions,
    duplicateSessionCount,
    deckCount: selected.length,
    cardTotal: selected.reduce((total, deck) => total + (deck.cards?.length || 0), 0),
    activeDays: activeDates.size,
    streak: activeStreak(activeDates, now),
    activity: activity.map(({ date, sessions: daySessions }) => ({ date, ...totalsFor(daySessions) })),
    trend,
    schedule: scheduleSummary(selected, now),
    decks: selected.map(deck => ({
      id: deck.id, name: deck.name, source: deck.source, target: deck.target,
      cardTotal: deck.cards?.length || 0,
      spacedEnabled: isSpacedEnabled(deck),
      ...totalsFor(byDeck.get(deck.id)),
      schedule: getDeckSchedule(deck, now),
    })),
  };
}

const shortDate = key => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const exactDate = value => new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const modeName = mode => ({ forward: 'Forward', reverse: 'Reverse', mixed: 'Mixed' })[mode] || 'Study';
const icon = name => {
  const paths = {
    spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    leaf: '<path d="M20 4C9 2 2 9 6 16s16 4 14-12ZM5 21l10-10"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
};

function activityChart(days) {
  const width = 500, height = 148, bottom = 116, top = 12;
  const max = Math.max(1, ...days.map(day => day.questionCount));
  const step = width / days.length;
  const active = days.filter(day => day.sessionCount);
  const label = active.length ? active.map(day => `${shortDate(day.date)}: ${number(day.questionCount)} prompts in ${number(day.sessionCount)} sessions`).join('; ') : 'No completed sessions in this period.';
  return `<svg class="stats-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    <title>Study activity: prompts completed each day</title>
    <line x1="0" x2="${width}" y1="${bottom}" y2="${bottom}" class="stats-chart-axis"/>
    ${days.map((day, index) => {
      const barHeight = day.questionCount ? Math.max(4, day.questionCount / max * (bottom - top)) : 3;
      return `<rect x="${index * step + step * .2}" y="${bottom - barHeight}" width="${step * .6}" height="${barHeight}" rx="4" class="${day.questionCount ? 'stats-chart-bar' : 'stats-chart-empty'}"><title>${esc(`${shortDate(day.date)}: ${number(day.questionCount)} prompts`)}</title></rect>`;
    }).join('')}
    <text x="2" y="141" class="stats-chart-label">${esc(shortDate(days[0].date))}</text>
    <text x="${width - 2}" y="141" text-anchor="end" class="stats-chart-label">Today</text>
  </svg>`;
}

function recallChart(days) {
  const width = 500, height = 158, left = 35, right = 485, top = 12, bottom = 120;
  const points = days.flatMap((day, index) => day.recall === null ? [] : [{ ...day, x: left + index / Math.max(1, days.length - 1) * (right - left), y: bottom - day.recall / 100 * (bottom - top) }]);
  if (!points.length) return '<div class="stats-chart-placeholder"><span class="stats-placeholder-line" aria-hidden="true"></span><p>Your first completed session starts this chart.</p></div>';
  const label = points.map(day => `${shortDate(day.date)}: ${percent(day.recall)} first-pass recall across ${number(day.questionCount)} prompts`).join('; ');
  return `<svg class="stats-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    <title>Daily first-pass recall, weighted by prompts</title>
    ${[0, 50, 100].map(value => {
      const y = bottom - value / 100 * (bottom - top);
      return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" class="stats-chart-grid"/><text x="25" y="${y + 4}" text-anchor="end" class="stats-chart-label">${value}</text>`;
    }).join('')}
    ${points.length > 1 ? `<polyline points="${points.map(day => `${day.x},${day.y}`).join(' ')}" class="stats-chart-line"/>` : ''}
    ${points.map(day => `<circle cx="${day.x}" cy="${day.y}" r="4.5" class="stats-chart-point"><title>${esc(`${shortDate(day.date)}: ${percent(day.recall)}`)}</title></circle>`).join('')}
    <text x="${left}" y="151" class="stats-chart-label">${esc(shortDate(days[0].date))}</text><text x="${right}" y="151" text-anchor="end" class="stats-chart-label">Today</text>
  </svg>`;
}

function scheduleView(stats, deck) {
  const schedule = stats.schedule;
  if (!schedule.enabledDecks) return `<section class="stats-panel stats-muted-panel" aria-labelledby="stats-schedule-title"><div class="stats-section-heading"><h2 id="stats-schedule-title">Spaced repetition</h2><span class="stats-badge">Off</span></div><p>Turn it on in ${deck ? 'this deck’s settings' : 'a deck’s settings'} to see upcoming reviews here. Practice sessions still count toward your stats.</p></section>`;
  const stages = [['New', schedule.newCount, 'new'], ['Learning', schedule.learningCount, 'learning'], ['Review', schedule.reviewCount, 'review']];
  const maxDue = Math.max(1, ...schedule.upcoming.map(day => day.count));
  return `<section class="stats-panel" aria-labelledby="stats-schedule-title">
    <div class="stats-section-heading"><h2 id="stats-schedule-title">Spaced repetition</h2><span class="stats-badge">${deck ? 'On' : `${number(schedule.enabledDecks)} ${schedule.enabledDecks === 1 ? 'deck' : 'decks'} on`}</span></div>
    <div class="stats-ready"><div><strong>${number(schedule.readyCount)}</strong><span>ready to study</span></div><p>${number(schedule.dueCount)} scheduled ${schedule.dueCount === 1 ? 'card' : 'cards'} due<br>${number(schedule.newAvailable)} new available today</p></div>
    <div class="stats-distribution" role="img" aria-label="${esc(stages.map(([name, value]) => `${number(value)} ${name.toLowerCase()} cards`).join(', '))}">${stages.filter(([, value]) => value).map(([, value, type]) => `<span class="stats-stage-${type}" style="flex-grow:${value}"></span>`).join('') || '<span class="stats-stage-empty" style="flex-grow:1"></span>'}</div>
    <div class="stats-stage-legend">${stages.map(([name, value, type]) => `<div><span class="stats-dot stats-stage-${type}" aria-hidden="true"></span><span>${name}</span><strong>${number(value)}</strong></div>`).join('')}</div>
    <div class="stats-section-heading stats-upcoming-heading"><h3>Next 7 days</h3><span>Scheduled cards</span></div>
    <div class="stats-upcoming" role="img" aria-label="${esc(schedule.upcoming.map((day, index) => `${index ? shortDate(day.date) : 'Today including overdue'}: ${number(day.count)} scheduled cards`).join('; '))}">
      ${schedule.upcoming.map((day, index) => `<div class="stats-upcoming-day"><strong>${number(day.count)}</strong><div class="stats-upcoming-track"><span style="height:${day.count ? Math.max(5, day.count / maxDue * 100) : 3}%" class="${day.count ? '' : 'stats-upcoming-empty'}"></span></div><span>${index ? esc(new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })) : 'Today'}</span></div>`).join('')}
    </div>
    <p class="stats-caption">Today includes overdue cards. Upcoming dates change as you study.${schedule.pausedDecks ? ` ${number(schedule.pausedDecks)} ${schedule.pausedDecks === 1 ? 'deck with spaced repetition off is' : 'decks with spaced repetition off are'} excluded.` : ''}</p>
  </section>`;
}

function insightsView(stats) {
  const insights = [];
  if (stats.trend) {
    const delta = Math.round(stats.trend.difference);
    insights.push({ title: delta > 0 ? `Recall is up ${delta} ${delta === 1 ? 'point' : 'points'}` : delta < 0 ? `Recall is down ${-delta} ${delta === -1 ? 'point' : 'points'}` : 'Recall is holding steady', text: `Your last 7 days: ${percent(stats.trend.recentRecall)}, compared with ${percent(stats.trend.previousRecall)} in the previous 7 days. These sessions may cover different cards.` });
  } else if (stats.questionCount >= 10) {
    if (stats.recall >= 90) insights.push({ title: 'A strong first try', text: `You recalled ${percent(stats.recall)} of prompts on the first try across your completed sessions.` });
    else if (stats.recall < 65) insights.push({ title: 'Room for another look', text: `${number(stats.questionCount - stats.firstPassGood)} of ${number(stats.questionCount)} prompts needed another try. Small, regular sessions can make difficult cards easier to revisit.` });
  }
  if (stats.streak >= 2) insights.push({ title: `${number(stats.streak)} days of showing up`, text: 'You have completed a session on each of these consecutive days. Your streak stays open until the end of today.' });
  if (stats.schedule.enabledDecks && stats.schedule.total && !stats.schedule.readyCount && stats.schedule.nextDueAt) insights.push({ title: 'Caught up for now', text: `Your next scheduled card is due ${exactDate(stats.schedule.nextDueAt)}.` });
  if (stats.againCount > 0) insights.push({ title: 'Every retry is part of learning', text: `You worked through ${number(stats.againCount)} ${stats.againCount === 1 ? 'Again rating' : 'Again ratings'} in completed sessions. Retries count as practice, not extra first-pass answers.` });
  if (!insights.length) insights.push({ title: stats.sessionCount ? 'Your baseline is taking shape' : 'A fresh starting point', text: stats.sessionCount ? 'Keep completing sessions to see recall trends and patterns over time.' : 'Complete a study session to start your history. Sessions from before tracking was added are not included.' });
  return `<section class="stats-insights" aria-labelledby="stats-insights-title"><h2 id="stats-insights-title">A little perspective</h2>${insights.slice(0, 3).map(insight => `<div class="stats-insight"><span class="stats-insight-icon">${icon('spark')}</span><div><h3>${esc(insight.title)}</h3><p>${esc(insight.text)}</p></div></div>`).join('')}</section>`;
}

function decksView(decks) {
  if (!decks.length) return '<section class="stats-panel stats-empty"><h2>No decks yet</h2><p>Create a deck to start learning and build your first stats.</p><button class="btn primary" data-go="decks">Go to My Decks</button></section>';
  return `<section class="stats-decks" aria-labelledby="stats-decks-title"><div class="stats-section-heading"><h2 id="stats-decks-title">Your decks</h2><span>${number(decks.length)} total</span></div><div class="stats-deck-list">${decks.map(deck => `<button class="stats-deck" data-stats-deck="${esc(deck.id)}" aria-label="${esc(`${deck.name} stats`)}">
    <span class="stats-deck-top"><span><strong>${esc(deck.name)}</strong><small>${esc(deck.source)} → ${esc(deck.target)}</small></span><span class="stats-deck-arrow">${icon('arrow')}</span></span>
    <span class="stats-deck-performance"><span><b>${percent(deck.recall)}</b> first-pass recall</span><span>${number(deck.sessionCount)} ${deck.sessionCount === 1 ? 'session' : 'sessions'}</span></span>
    <span class="stats-deck-meter" aria-hidden="true"><span style="width:${deck.recall ?? 0}%"></span></span>
    <span class="stats-deck-schedule">${deck.spacedEnabled ? `<span><i class="stats-dot stats-stage-new" aria-hidden="true"></i>${number(deck.schedule.newCount)} new</span><span><i class="stats-dot stats-stage-learning" aria-hidden="true"></i>${number(deck.schedule.learningCount)} learning</span><span><i class="stats-dot stats-stage-review" aria-hidden="true"></i>${number(deck.schedule.dueCount)} review due</span>` : '<span>Spaced repetition off</span>'}</span>
  </button>`).join('')}</div></section>`;
}

function historyView(stats, deckId, historyLimit) {
  const limit = Math.max(1, Math.floor(historyLimit) || 20);
  const visible = stats.sessions.slice(0, limit);
  return `<section class="stats-history" aria-labelledby="stats-history-title"><div class="stats-section-heading"><h2 id="stats-history-title">Study history</h2><span>Completed sessions</span></div>${stats.duplicateSessionCount ? '<p class="stats-caption stats-copy-note">Sessions shared by deck copies count once in this overview.</p>' : ''}
    ${visible.length ? `<ol class="stats-history-list">${visible.map(session => {
      const recall = session.firstPassGood / session.questionCount * 100;
      return `<li class="stats-session">
        <div class="stats-session-heading"><div>${deckId === null ? `<h3>${esc(session.deckName)}</h3>` : ''}<time datetime="${esc(session.completedAt)}">${esc(exactDate(session.completedAt))}</time><div class="stats-session-tags"><span>${modeName(session.mode)}</span><span class="${session.kind === 'spaced' ? 'stats-tag-spaced' : ''}">${session.kind === 'spaced' ? 'Spaced repetition' : 'Practice'}</span></div></div><div class="stats-session-score"><strong>${percent(recall)}</strong><span>first pass</span></div></div>
        <dl class="stats-session-details"><div><dt>Cards</dt><dd>${number(session.cardCount)}</dd></div><div><dt>First try</dt><dd>${number(session.firstPassGood)}<span> / ${number(session.questionCount)}</span></dd></div><div><dt>Active time</dt><dd>${formatStudyDuration(session.durationMs)}</dd></div><div><dt>Attempts</dt><dd>${number(session.attempts)}</dd></div><div><dt>Again</dt><dd>${number(session.againCount)}</dd></div>${session.kind === 'spaced' ? `<div><dt>New / returning</dt><dd>${number(session.newCards)}<span> / ${number(session.reviewCards)}</span></dd></div>` : ''}</dl>
      </li>`;
    }).join('')}</ol>${stats.sessions.length > limit ? `<button class="btn outline full stats-more" data-stats-more>Show more sessions <span>(${number(stats.sessions.length - limit)} remaining)</span></button>` : ''}` : '<div class="stats-panel stats-empty"><span class="stats-empty-icon" aria-hidden="true">' + icon('calendar') + '</span><h3>Your story starts here</h3><p>Completed sessions will appear here with their results. Past sessions from before tracking was added are not available.</p></div>'}
  </section>`;
}

/** Returns the screen body; the app supplies its shared page header and routing. */
export function renderStats(decks, { deckId = null, now = Date.now(), historyLimit = 20 } = {}) {
  const deck = deckId === null ? null : decks.find(item => item.id === deckId);
  if (deckId !== null && !deck) return '<div class="stats-panel stats-empty"><h2>Deck not found</h2><p>This deck may have been removed.</p><button class="btn outline" data-go="decks">Go to My Decks</button></div>';
  const stats = summarizeStats(decks, { deckId, now });
  const recent = totalsFor(stats.activity);
  const recentSessions = stats.activity.reduce((total, day) => total + day.sessionCount, 0);
  return `<div class="stats-screen">
    <div class="stats-intro"><p>${deck ? `${esc(deck.name)}<span>${esc(deck.source)} → ${esc(deck.target)}</span>` : 'Your learning, at a glance.<span>All your decks. Every completed session.</span>'}</p>${deck ? `<button class="btn primary" data-study="${esc(deck.id)}" ${deck.cards.length ? '' : 'disabled'}>Study ${icon('arrow')}</button>` : ''}</div>
    <section class="stats-hero" aria-labelledby="stats-recall-title"><div><h2 id="stats-recall-title">First-pass recall</h2><strong class="stats-hero-value">${percent(stats.recall)}</strong><p>${stats.questionCount ? `${number(stats.firstPassGood)} of ${number(stats.questionCount)} prompts<br>answered Good on the first try` : 'Complete a session<br>to see your first result'}</p></div><div class="stats-recall-ring" style="--stats-recall:${stats.recall ?? 0}%" aria-hidden="true"><span>${icon('leaf')}</span></div></section>
    <div class="stats-metrics"><div>${icon('calendar')}<strong>${number(stats.sessionCount)}</strong><span>Sessions</span></div><div>${icon('clock')}<strong>${formatStudyDuration(stats.durationMs)}</strong><span>Active study</span></div><div>${icon('spark')}<strong>${number(stats.streak)}<small> ${stats.streak === 1 ? 'day' : 'days'}</small></strong><span>Current streak</span></div></div>
    <p class="stats-definition">First-pass recall measures your first answer to each prompt. Mixed study counts both directions separately.</p>
    <section class="stats-panel" aria-labelledby="stats-activity-title"><div class="stats-section-heading"><h2 id="stats-activity-title">A little, often</h2><span>Last 14 days</span></div><p class="stats-chart-summary"><strong>${number(recent.questionCount)}</strong> prompts · <strong>${number(recentSessions)}</strong> completed ${recentSessions === 1 ? 'session' : 'sessions'}</p>${activityChart(stats.activity)}</section>
    <section class="stats-panel" aria-labelledby="stats-trend-title"><div class="stats-section-heading"><h2 id="stats-trend-title">Recall over time</h2><span>Last 14 days</span></div>${recallChart(stats.activity)}<p class="stats-caption">Each dot is a day’s first-pass recall. Days without completed sessions have no score.</p></section>
    ${scheduleView(stats, deck)}
    ${insightsView(stats)}
    ${deckId === null ? decksView(stats.decks) : ''}
    ${historyView(stats, deckId, historyLimit)}
  </div>`;
}
