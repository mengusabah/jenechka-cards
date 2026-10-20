import { sampleTemplateCards } from './prebuilt.js';

const PAGE_SIZE = 20;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const searchText = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ı', 'i').replaceAll('ß', 'ss');

export function filterSelectionCards(cards, query) {
  const terms = searchText(query).trim().split(/\s+/).filter(Boolean);
  return terms.length ? cards.filter(card => {
    const text = searchText(`${card.front} ${card.back}`);
    return terms.every(term => text.includes(term));
  }) : cards;
}

export function createSelectionState(template, mode) {
  const count = Math.min(25, template.cards.length);
  return { templateId: template.templateId, mode, count: String(count),
    randomIds: count ? sampleTemplateCards(template, count) : [], manualIds: new Set(),
    query: '', selectedOnly: false, page: 0, name: '' };
}

// Only one short page is mounted, even for several thousand words. Selection
// lives separately from the rendered search results and survives pagination.
export function setupDeckBuilder(root, template, state, { onSave, canSave = true }) {
  const abort = new AbortController();
  let saving = false;
  const selectedIds = () => state.mode === 'random' ? state.randomIds : [...state.manualIds];
  const validCount = () => Number.isInteger(Number(state.count)) && Number(state.count) >= 1 && Number(state.count) <= template.cards.length;
  const matches = () => filterSelectionCards(template.cards, state.query);
  const displayedCards = () => {
    const ids = new Set(selectedIds());
    if (state.mode === 'random') return template.cards.filter(card => ids.has(card.entryId));
    return matches().filter(card => !state.selectedOnly || ids.has(card.entryId));
  };
  const listen = (element, type, fn) => element.addEventListener(type, fn, { signal: abort.signal });

  root.innerHTML = `
    <div class="builder-modes" role="group" aria-label="How to choose words">
      <button class="btn" data-builder-mode="random">⇄ Random words</button>
      <button class="btn" data-builder-mode="manual">✓ Choose words</button>
    </div>
    <section class="panel builder-random" data-random-options>
      <label for="builder-count">How many words?</label>
      <div class="builder-number-row"><input id="builder-count" type="number" inputmode="numeric" min="1" max="${template.cards.length}" step="1" value="${esc(state.count)}" aria-describedby="builder-count-hint builder-count-error"><span>of ${template.cards.length}</span></div>
      <div class="builder-presets" role="group" aria-label="Quick word counts">${[10, 25, 50, 100].filter(count => count <= template.cards.length).map(count => `<button class="btn outline" data-builder-size="${count}">${count}</button>`).join('')}</div>
      <p class="help" id="builder-count-hint">A fresh mix, with no repeated cards.</p>
      <p class="builder-error" id="builder-count-error" role="status" hidden></p>
      <div class="builder-random-actions"><button class="btn outline" data-builder-shuffle>↻ Shuffle again</button><button class="text-button" data-builder-edit>Edit these words</button></div>
    </section>
    <section class="builder-manual" data-manual-options>
      <label for="builder-search">Find words</label>
      <input id="builder-search" type="search" placeholder="Search either language…" value="${esc(state.query)}" autocomplete="off" spellcheck="false">
      <div class="builder-tools"><button class="btn outline" data-builder-selected-only>Selected only</button><button class="text-button" data-builder-select-results></button><button class="text-button" data-builder-clear>Clear selection</button></div>
    </section>
    <div class="builder-list-heading"><h2 data-builder-list-title></h2><span class="help" data-builder-results role="status"></span></div>
    <div class="builder-column-labels"><span>${esc(template.targetName)}</span><span>${esc(template.sourceName)}</span></div>
    <div class="builder-words" data-builder-words></div>
    <nav class="builder-pagination" aria-label="Word pages"><button class="btn outline" data-builder-previous aria-label="Previous words">‹ Previous</button><span data-builder-page-count></span><button class="btn outline" data-builder-next aria-label="Next words">Next ›</button></nav>
    <div class="field builder-name"><label for="builder-name">Deck name <span class="optional">(optional)</span></label><input id="builder-name" maxlength="1000" value="${esc(state.name)}"></div>
    <div class="builder-save"><div role="status"><strong data-builder-total></strong><small>selected</small></div><button class="btn primary" data-builder-save>Create deck</button></div>`;

  const node = selector => root.querySelector(selector);
  function updateSummary() {
    const count = selectedIds().length;
    node('[data-builder-total]').textContent = `${count} ${count === 1 ? 'word' : 'words'}`;
    node('[data-builder-save]').disabled = saving || !canSave || !count || (state.mode === 'random' && !validCount());
    node('#builder-name').placeholder = `${template.name} · ${count} words · ${template.targetName}`;
    node('[data-builder-clear]').disabled = !state.manualIds.size;
    node('[data-builder-selected-only]').setAttribute('aria-pressed', String(state.selectedOnly));
    const results = matches();
    const allSelected = results.every(card => state.manualIds.has(card.entryId));
    node('[data-builder-select-results]').textContent = state.query.trim() ? `Select results (${results.length})` : 'Select all';
    node('[data-builder-select-results]').hidden = state.selectedOnly;
    node('[data-builder-select-results]').disabled = !results.length || allSelected;
  }
  function renderList() {
    const cards = displayedCards();
    const pageCount = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
    state.page = Math.max(0, Math.min(state.page, pageCount - 1));
    const start = state.page * PAGE_SIZE;
    const manual = state.mode === 'manual';
    node('[data-builder-list-title]').textContent = manual ? 'Choose your words' : 'Your random mix';
    node('[data-builder-results]').textContent = `${cards.length} ${cards.length === 1 ? 'word' : 'words'}`;
    node('.builder-column-labels').classList.toggle('has-checkboxes', manual);
    node('[data-builder-words]').innerHTML = cards.slice(start, start + PAGE_SIZE).map(card => {
      const checked = state.manualIds.has(card.entryId);
      const words = `<span class="builder-word"><strong lang="${esc(template.targetCode)}" dir="auto">${esc(card.back)}</strong>${card.pos && !['unknown', 'unspecified'].includes(card.pos) ? `<small>${esc(card.pos)}</small>` : ''}</span><span class="builder-translation" lang="${esc(template.sourceCode)}" dir="auto">${esc(card.front)}</span>`;
      return manual ? `<label class="builder-word-row${checked ? ' is-selected' : ''}"><input type="checkbox" data-builder-word="${esc(card.entryId)}" ${checked ? 'checked' : ''}>${words}</label>` : `<div class="builder-word-row random-row">${words}</div>`;
    }).join('') || `<div class="builder-empty">${state.selectedOnly ? 'No selected words match this view.' : 'No matching words. Try another search.'}</div>`;
    node('[data-builder-page-count]').textContent = cards.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, cards.length)} / ${cards.length}` : '0 / 0';
    node('[data-builder-previous]').disabled = state.page <= 0;
    node('[data-builder-next]').disabled = state.page >= pageCount - 1;
    node('.builder-pagination').hidden = pageCount <= 1;
    updateSummary();
  }
  function updateCount() {
    const valid = validCount();
    const error = node('#builder-count-error');
    error.hidden = valid;
    error.textContent = valid ? '' : `Choose a whole number from 1 to ${template.cards.length}.`;
    node('#builder-count').setAttribute('aria-invalid', String(!valid));
    node('[data-builder-shuffle]').disabled = !valid;
    node('[data-builder-edit]').disabled = !valid || !state.randomIds.length;
    root.querySelectorAll('[data-builder-size]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.builderSize) === Number(state.count))));
  }
  function showMode() {
    root.querySelectorAll('[data-builder-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.builderMode === state.mode)));
    node('[data-random-options]').hidden = state.mode !== 'random';
    node('[data-manual-options]').hidden = state.mode !== 'manual';
    updateCount();
    renderList();
  }
  function sample() {
    updateCount();
    if (validCount()) {
      state.randomIds = sampleTemplateCards(template, Number(state.count));
      state.page = 0;
      renderList();
    } else updateSummary();
  }
  listen(node('#builder-count'), 'input', event => { state.count = event.target.value; sample(); });
  listen(node('#builder-name'), 'input', event => { state.name = event.target.value; });
  listen(node('#builder-search'), 'input', event => { state.query = event.target.value; state.page = 0; renderList(); });
  listen(root, 'change', event => {
    const input = event.target.closest('[data-builder-word]');
    if (!input || saving) return;
    if (input.checked) state.manualIds.add(input.dataset.builderWord); else state.manualIds.delete(input.dataset.builderWord);
    input.closest('label').classList.toggle('is-selected', input.checked);
    if (state.selectedOnly) {
      // Keep keyboard focus on a nearby checkbox when removing a filtered row.
      const index = [...root.querySelectorAll('[data-builder-word]')].indexOf(input);
      renderList();
      const remaining = [...root.querySelectorAll('[data-builder-word]')];
      (remaining[Math.min(index, remaining.length - 1)] || node('[data-builder-selected-only]')).focus({ preventScroll: true });
    } else updateSummary();
  });
  listen(root, 'click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || saving) return;
    const action = button.dataset;
    if (action.builderMode) { state.mode = action.builderMode; state.page = 0; showMode(); }
    else if (action.builderSize) { state.count = action.builderSize; node('#builder-count').value = state.count; sample(); }
    else if ('builderShuffle' in action) sample();
    else if ('builderEdit' in action) { state.manualIds = new Set(state.randomIds); state.mode = 'manual'; state.query = ''; node('#builder-search').value = ''; state.selectedOnly = true; state.page = 0; showMode(); node('#builder-search').focus({ preventScroll: true }); }
    else if ('builderSelectedOnly' in action) { state.selectedOnly = !state.selectedOnly; state.page = 0; renderList(); }
    else if ('builderSelectResults' in action) { matches().forEach(card => state.manualIds.add(card.entryId)); renderList(); }
    else if ('builderClear' in action) { state.manualIds.clear(); state.selectedOnly = false; renderList(); }
    else if ('builderPrevious' in action || 'builderNext' in action) {
      state.page += 'builderNext' in action ? 1 : -1;
      renderList();
      node('.builder-list-heading').scrollIntoView({ block: 'start', behavior: 'instant' });
      if (button.disabled) node(button.hasAttribute('data-builder-next') ? '[data-builder-previous]' : '[data-builder-next]').focus({ preventScroll: true });
    } else if ('builderSave' in action) {
      saving = true;
      updateSummary();
      button.textContent = 'Saving…';
      try { await onSave(selectedIds(), state.name.trim() || undefined); }
      finally {
        saving = false;
        if (root.isConnected) { button.textContent = 'Create deck'; updateSummary(); }
      }
    }
  });
  showMode();
  return () => abort.abort();
}
