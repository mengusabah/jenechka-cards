import { openDeckStore, createId, parseBackup, makeBackup, mergeDecks, MAX_BACKUP_BYTES, LIMITS } from './data.js';
import { createStudySession, rateStudyCard } from './study.js';
import { setupWelcome } from './welcome.js';
import { LANGUAGES, languageByName } from './languages.js';
import { createLibraryLoader, definitions, buildTemplate, hasImported, importTemplate, importTemplateSelection, prebuiltTargets, PREBUILT_LANGUAGES } from './prebuilt.js';
import { setupPreviewSlider } from './preview.js';
import { createSelectionState, setupDeckBuilder } from './deck-builder.js';
import { openDeckAddDialog } from './deck-add-dialog.js';

const welcome = setupWelcome();

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const copy = (value) => JSON.parse(JSON.stringify(value));
const languages = LANGUAGES.map(language => language.name);
const loadLibrary = createLibraryLoader();
let library, libraryLoading = false, libraryError = '', libraryRequest = 0;
let librarySource = 'English', libraryTarget = 'Turkish', librarySection = 'topic', previewDefinition;
let storage, decks = [], page = 'home', draft, active, session;
let dirty = false, busy = false, pendingImport = null, noticeTimer;
let offlineReady = false, offlineError = '', registration, installPrompt, reloadRequested = false;
let persistent = false;
let destroyPreview = () => {};
let selectionState;
let closeDeckAddDialog = () => {};
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isEditing = () => ['create', 'edit'].includes(page);
const blankCard = () => ({ id: createId(), front: '', back: '' });
const blankDeck = () => ({ id: createId(), name: '', source: 'English', target: 'Turkish', cards: [blankCard()] });
const countCards = (items) => items.reduce((sum, deck) => sum + deck.cards.length, 0);
const posLabel = value => ({ unknown: '', unspecified: '', intj: 'expression', pron: 'pronoun', conj: 'conjunction', prep: 'preposition', det: 'determiner', num: 'number', adj: 'adjective', adv: 'adverb' }[value] ?? value);

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').className = `notice${error ? ' error' : ''}`;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 14000 : 6500);
}

function go(next) {
  page = next;
  render();
  scrollTo(0, 0);
  $('app').querySelector('h1')?.focus({ preventScroll: true });
}

function networkLabel() {
  if (offlineReady) return navigator.onLine ? 'Ready offline' : 'Offline · ready';
  if (offlineError) return 'Online use only';
  return navigator.onLine ? 'Preparing offline…' : 'Offline setup pending';
}

const statusPill = () => `<span class="status-pill" data-network>${networkLabel()}</span>`;
const footer = () => '<div class="footer">Little moments of learning ✦</div>';
function shell(title, body, back = 'home') {
  $('app').innerHTML = `<header><button class="btn outline" data-go="${back}">← Back</button><span class="logo">jenechka<b>cards.</b></span></header>
    <h1 tabindex="-1">${esc(title)}</h1>${body}${footer()}`;
}

function cardEditor(card, index) {
  return `<div class="cardedit"><div class="head">CARD ${index + 1}<button class="btn red" data-remove="${card.id}" aria-label="Remove card ${index + 1}">✕</button></div>
    <div class="field"><label for="front-${card.id}">Source word or phrase</label><textarea id="front-${card.id}" data-front="${card.id}" placeholder="Good morning" maxlength="${LIMITS.side}">${esc(card.front)}</textarea></div>
    <div class="field"><label for="back-${card.id}">Translation</label><textarea id="back-${card.id}" data-back="${card.id}" placeholder="Günaydın" maxlength="${LIMITS.side}">${esc(card.back)}</textarea></div></div>`;
}

function languagePicker(id, label, value, allowCustom = true, options = languages) {
  const custom = !options.includes(value);
  return `<div class="field"><label for="${id}">${label}</label>
    <select id="${id}" data-language-picker>
      ${options.map((language) => `<option value="${language}" ${language === value ? 'selected' : ''}>${language}</option>`).join('')}
      ${allowCustom ? `<option value="__custom__" ${custom ? 'selected' : ''}>Other (type a language)…</option>` : ''}
    </select>
    <div id="${id}-custom-field" class="custom-language" ${custom ? '' : 'hidden'}>
      <label for="${id}-custom">${label} name</label>
      <input id="${id}-custom" value="${custom ? esc(value) : ''}" placeholder="Type a language" maxlength="${LIMITS.language}">
    </div></div>`;
}

function languageValue(id) {
  return $(id).value === '__custom__' ? $(`${id}-custom`).value : $(id).value;
}

function render() {
  closeDeckAddDialog();
  closeDeckAddDialog = () => {};
  destroyPreview();
  destroyPreview = () => {};
  $('app').setAttribute('aria-busy', String(busy));
  $('app').classList.toggle('building-deck', page === 'prebuilt-builder');
  if (page === 'home') {
    $('app').innerHTML = `<header><span class="logo">jenechka<b>cards.</b></span>${statusPill()}</header>
      ${storage.warning ? `<div class="storage-warning" role="alert">${esc(storage.warning)} <button class="text-button" data-go="settings">Open backups</button></div>` : ''}
      <div class="hero"><div class="eyebrow">YOUR LANGUAGE COMPANION</div><h1 tabindex="-1">Small cards.<br>Big progress<span class="accent">.</span></h1><p>Build your vocabulary, one flip at a time. Simple, focused, and made for you.</p></div>
      <button class="tile" data-go="create"><span class="icon" aria-hidden="true">✚</span><span><strong>Create Deck</strong><small>Start a vocabulary collection</small></span><span class="arrow" aria-hidden="true">›</span></button>
      <button class="tile" data-go="decks"><span class="icon" aria-hidden="true">📚</span><span><strong>My Decks</strong><small>${decks.length} saved decks · Ready to study</small></span><span class="arrow" aria-hidden="true">›</span></button>
      <button class="tile" data-go="settings"><span class="icon" aria-hidden="true">↥</span><span><strong>App & Backups</strong><small>Install, export, and restore your words</small></span><span class="arrow" aria-hidden="true">›</span></button>
      <div class="footer">Your words stay on this device ✦</div>`;
  } else if (page === 'decks') {
    shell('My Decks', `<div class="section-intro"><p>Your vocabulary collections, in one place.</p><button class="text-button" data-go="settings">Backups ↗</button></div>
      ${decks.length ? decks.map((deck) => `<div class="deck"><h2>${esc(deck.name)}</h2><small>${esc(deck.source)} → ${esc(deck.target)} · ${deck.cards.length} cards</small>
        <div class="buttons"><button class="btn primary" data-study="${deck.id}" ${deck.cards.length ? '' : 'disabled'}>Study →</button><button class="btn outline" data-edit="${deck.id}">Edit</button><button class="btn red" data-delete="${deck.id}">Delete</button></div></div>`).join('') : '<div class="panel center"><h2>📚 No decks yet</h2><p>Create your first deck or import a backup.</p></div>'}
      <div class="stack"><button class="btn outline full" data-go="create">+ Create Deck</button>
      <button class="btn primary full" data-go="prebuilt">Add Prebuilt Deck</button></div>`);
  } else if (page === 'prebuilt') {
    renderPrebuilt();
  } else if (page === 'prebuilt-preview') {
    renderPrebuiltPreview();
  } else if (page === 'prebuilt-builder') {
    renderPrebuiltBuilder();
  } else if (isEditing()) {
    shell(page === 'edit' ? 'Edit Deck' : 'Create Deck', `<p>Make a collection of words worth remembering.</p>
      <div class="panel"><div class="field"><label for="name">Deck name</label><input id="name" value="${esc(draft.name)}" placeholder="English Vocabulary" maxlength="${LIMITS.name}"></div>
      <div class="row">${languagePicker('source', 'Source language', draft.source)}${languagePicker('target', 'Target language', draft.target)}</div></div>
      <h2>Flashcards (${draft.cards.length})</h2>${draft.cards.map(cardEditor).join('')}
      <button class="btn outline full" data-add>+ Add another card</button>
      <div class="panel stack"><button class="btn primary full" data-save>Save Deck</button><button class="btn outline full" data-export-draft>Download draft backup</button><button class="btn outline full" data-cancel>Cancel</button><small>Your changes are stored after you tap Save Deck. If saving fails, download a backup here to keep your completed changes.</small></div>`, 'decks');
  } else if (page === 'modes') {
    const deck = decks.find((item) => item.id === active);
    if (!deck) return go('decks');
    shell('Study direction', `<p>Choose how to study <b>${esc(deck.name)}</b>.</p>${[
      ['forward', '→', `${deck.source} → ${deck.target}`, 'Translate source to target'],
      ['reverse', '←', `${deck.target} → ${deck.source}`, 'Translate target to source'],
      ['mixed', '⇄', 'Mixed Mode', `Every card in both directions · ${deck.cards.length * 2} questions`]
    ].map(([mode, icon, title, subtitle]) => `<button class="mode" data-mode="${mode}"><span class="icon" aria-hidden="true">${icon}</span><span><strong>${esc(title)}</strong><small>${subtitle}</small></span></button>`).join('')}`, 'decks');
  } else if (page === 'study') {
    const card = session.queue[0];
    const deck = decks.find((item) => item.id === active);
    const front = card.reverse ? card.back : card.front;
    const back = card.reverse ? card.front : card.back;
    shell('Study time', `<div class="study-toolbar"><small>${session.done} / ${session.total} questions completed</small><button class="btn outline" data-exit>Exit ✕</button></div>
      <div class="progress" role="progressbar" aria-label="Study progress" aria-valuemin="0" aria-valuemax="${session.total}" aria-valuenow="${session.done}"><div style="width:${session.done / session.total * 100}%"></div></div>
      <div class="space"><button class="flip ${session.flipped ? 'flipped' : ''}" data-flip aria-label="${esc(session.flipped ? `Answer: ${back}. Tap to see question.` : `Question: ${front}. Tap to reveal answer.`)}">
      <span class="face" aria-hidden="true"><span class="tag">${esc(card.reverse ? deck.target : deck.source)}</span><span class="word">${esc(front)}</span><span class="hint">Tap to reveal answer ↻</span></span>
      <span class="face answer" aria-hidden="true"><span class="tag">${esc(card.reverse ? deck.source : deck.target)}</span><span class="word">${esc(back)}</span><span class="hint">Tap to see question ↻</span></span></button></div>
      <div class="ratings" style="visibility:${session.flipped ? 'visible' : 'hidden'}"><button class="btn red" data-rate="again">✕ Again</button><button class="btn green" data-rate="good">✓ Good</button></div>
      <p class="center"><small>${session.queue.length} questions in queue</small></p>`, 'decks');
  } else if (page === 'complete') {
    shell('Session complete!', `<div class="center completion"><div class="celebration">🎉</div><h2>Nicely done!</h2><p>You completed all ${session.total} questions.</p><div class="stack"><button class="btn primary full" data-restart>Study Again ↻</button><button class="btn outline full" data-go="decks">My Decks</button></div></div>`, 'decks');
  } else if (page === 'settings') {
    renderSettings();
  }
  updateAppStatus();
}

function cacheLibraryPair() {
  if ((!library && !libraryLoading) || librarySource === libraryTarget) return;
  // A memory-cached language may not issue a fetch. Tell the offline cache
  // which pair is in use, including when first installation gains control.
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'VOCABULARY_PAIR',
      languages: [languageByName(librarySource).code, languageByName(libraryTarget).code],
    });
  } catch { /* Optional offline caching must not prevent opening a deck. */ }
}

async function refreshLibrary() {
  const request = ++libraryRequest;
  library = null;
  libraryError = '';
  libraryLoading = librarySource !== libraryTarget;
  if (!libraryLoading) libraryError = 'Choose two different languages to see translated decks.';
  if (page === 'prebuilt') render();
  if (!libraryLoading) return;
  try {
    const sourceCode = languageByName(librarySource).code;
    const targetCode = languageByName(libraryTarget).code;
    cacheLibraryPair();
    const result = await loadLibrary(sourceCode, targetCode);
    if (request !== libraryRequest) return;
    library = result;
  } catch (error) {
    if (request !== libraryRequest) return;
    libraryError = error.message || 'This pair has not been downloaded. Connect to the internet and try again.';
  } finally {
    if (request === libraryRequest) {
      libraryLoading = false;
      if (page === 'prebuilt') render();
    }
  }
}

function renderPrebuilt() {
  const templates = library ? definitions(library.catalog).filter(item => item.kind === librarySection)
    .map(item => buildTemplate(library, item)) : [];
  const available = templates.filter(template => template.cards.length);
  const unavailable = templates.filter(template => !template.cards.length);
  shell('Prebuilt decks', `<div class="panel">
      <div class="row">${languagePicker('library-source', 'Source · translations in', librarySource, false, PREBUILT_LANGUAGES.map(language => language.name))}
      ${languagePicker('library-target', 'Target · learning', libraryTarget, false, prebuiltTargets(languageByName(librarySource).code).map(language => language.name))}</div>
      <button class="text-button" data-swap-languages>⇄ Swap languages</button>
    </div>
    <div class="library-sections" aria-label="Deck sections">${[
      ['frequency', 'Most Common Words'], ['cefr', 'CEFR Levels'], ['topic', 'Topics & Categories'], ['dictionary', 'Dictionary'],
    ].map(([id, name]) => `<button class="btn ${id === librarySection ? 'primary' : 'outline'}" data-library-section="${id}" aria-pressed="${id === librarySection}">${name}</button>`).join('')}</div>
    <div id="library-results" aria-live="polite" aria-busy="${libraryLoading}">
      ${libraryLoading ? '<div class="panel"><p>Opening this language pair…</p></div>' : ''}
      ${libraryError ? `<div class="panel"><p role="status">${esc(libraryError)}</p>${librarySource !== libraryTarget ? '<button class="btn outline" data-retry-library>Try again</button>' : ''}</div>` : ''}
      ${library ? `
        ${available.length ? available.map(template => `<button class="tile library-deck" data-preview-prebuilt="${esc(template.id)}">
          <span><strong>${esc(template.name)}</strong><small>${template.cards.length} cards${template.estimatedCount ? template.estimatedCount === template.cards.length ? ' · Estimated' : ' · Includes estimates' : ''}${hasImported(decks, template) ? ' · Already added' : ''}</small></span><span class="arrow" aria-hidden="true">›</span>
          </button>`).join('') : '<div class="panel"><h2>No translated decks in this section yet</h2><p>Try Topics & Categories or another language pair.</p></div>'}
        ${unavailable.length && librarySection !== 'dictionary' ? `<details class="panel"><summary>Not yet available (${unavailable.length})</summary><p class="help">${unavailable.map(template => esc(template.name)).join(' · ')}</p></details>` : ''}` : ''}
    </div>`, 'decks');
}

function renderPrebuiltPreview() {
  if (!library || !previewDefinition) return go('prebuilt');
  const template = buildTemplate(library, previewDefinition);
  shell(template.name, `<p>Translations in <strong>${esc(template.sourceName)}</strong> · Learning <strong>${esc(template.targetName)}</strong></p>
    <div class="panel"><span class="status-pill">${template.cards.length} cards</span>
      ${template.estimatedCount ? `<span class="status-pill">${template.estimatedCount === template.cards.length ? 'Estimated level' : 'Includes estimated levels'}</span>` : ''}
    </div>
    <section class="preview-slider" aria-labelledby="preview-title" aria-roledescription="carousel">
      <h2 id="preview-title">A look inside</h2>
      <div class="vocabulary-heading"><span>${esc(template.targetName)}</span><span>${esc(template.sourceName)}</span></div>
      <div id="preview-slider-viewport" class="preview-viewport" data-preview-viewport tabindex="0" aria-label="Vocabulary preview" dir="ltr"></div>
      <div class="preview-controls">
        <button class="btn outline preview-arrow" data-preview-previous aria-label="Previous words" aria-controls="preview-slider-viewport">‹</button>
        <output class="preview-count" data-preview-count aria-live="polite" aria-atomic="true"></output>
        <button class="btn outline preview-arrow" data-preview-next aria-label="Next words" aria-controls="preview-slider-viewport">›</button>
      </div>
      <input class="preview-range" data-preview-range type="range" min="1" value="1" step="1" aria-label="Preview page" aria-controls="preview-slider-viewport">
    </section>
    <div class="panel stack"><button class="btn primary full" data-add-prebuilt aria-haspopup="dialog" ${!template.cards.length || storage.backend === 'memory' ? 'disabled' : ''}>Add to My Decks</button>
      <button class="btn outline full" data-go="prebuilt">Browse more decks</button></div>`, 'prebuilt');
  destroyPreview = setupPreviewSlider(document.querySelector('.preview-slider'), template.cards, card => `
    <div class="vocabulary-row" role="listitem">
      <div><strong lang="${template.targetCode}" dir="auto">${esc(card.back)}</strong><small>${[posLabel(card.pos), template.kind === 'cefr' ? card.estimated ? 'Estimated level' : 'Source-listed level' : ''].filter(Boolean).map(esc).join(' · ')}</small></div>
      <div><span lang="${template.sourceCode}" dir="auto">${esc(card.front)}</span></div>
    </div>`);
}

function showPrebuiltAddChoices() {
  if (!library || !previewDefinition || busy) return;
  const template = buildTemplate(library, previewDefinition);
  closeDeckAddDialog();
  clearTimeout(noticeTimer);
  $('notice').hidden = true;
  closeDeckAddDialog = openDeckAddDialog({
    template,
    alreadyImported: hasImported(decks, template),
    async onAll() {
      const next = [...decks, importTemplate(template, decks)];
      if (!await saveDecks(next)) throw new Error($('notice').textContent || 'Unable to save this deck. Please try again.');
      selectionState = null;
      go('decks');
      notify(`Added ${template.cards.length} editable cards. Saved on this device.`);
      return true;
    },
    onChoose(mode) {
      if (selectionState?.templateId !== template.templateId) selectionState = createSelectionState(template, mode);
      else { selectionState.mode = mode; selectionState.page = 0; }
      go('prebuilt-builder');
    },
  });
}

function renderPrebuiltBuilder() {
  if (!library || !previewDefinition || !selectionState) return go('prebuilt');
  const template = buildTemplate(library, previewDefinition);
  shell('Build your deck', `<p>${esc(template.name)} · ${esc(template.sourceName)} → ${esc(template.targetName)}</p><div class="deck-builder" data-deck-builder></div>`, 'prebuilt-preview');
  destroyPreview = setupDeckBuilder(document.querySelector('[data-deck-builder]'), template, selectionState, {
    canSave: storage.backend !== 'memory',
    async onSave(entryIds, name) {
      try {
        const deck = importTemplateSelection(template, entryIds, { name });
        if (await saveDecks([...decks, deck])) {
          selectionState = null;
          go('decks');
          notify(`Created a deck with ${deck.cards.length} words.`);
        }
      } catch (error) { notify(error.message || 'Unable to create this deck. Your selection is still here.', true); }
    },
  });
}

function renderSettings() {
  const preview = pendingImport ? mergeDecks(decks, pendingImport.decks) : null;
  shell('App & Backups', `<p>Keep your words close. Take a copy with you.</p>
    <section class="panel"><div class="panel-heading"><span class="icon" aria-hidden="true">↥</span><div><h2>Back up your words</h2><small>${decks.length} decks · ${countCards(decks)} cards saved here</small></div></div>
      <p>Export all saved decks as a JSON file. Keep it in Files, iCloud Drive, or another safe place.</p>
      <div class="stack"><button class="btn primary full" data-export>Download backup (.json)</button>${canShareBackup() ? '<button class="btn outline full" data-share>Save / Share backup…</button>' : ''}</div>
      <p class="help">On iPhone, Save / Share lets you choose Save to Files. Backups include your words and translations.</p>
    </section>
    <section class="panel"><h2>Restore a backup</h2><p>Import a Jenechka Cards JSON backup from this or another device. Existing decks are kept. Identical decks are skipped; changed decks are added as separate copies.</p>
      <label class="btn outline full file-button" for="import-file">Choose backup file</label><input class="file-input" id="import-file" type="file" accept=".json,application/json">
      <small>JSON files up to 10 MB. You can review the file before saving.</small>
      ${pendingImport ? `<div class="import-preview" role="status"><strong>${esc(pendingImport.name)}</strong><p>${pendingImport.decks.length} decks · ${countCards(pendingImport.decks)} cards in this backup.<br>${preview.added} new decks · ${preview.skipped} identical decks skipped.</p>
      <div class="stack"><button class="btn primary full" data-import ${preview.added && storage.backend !== 'memory' ? '' : 'disabled'}>Import ${preview.added} decks</button><button class="btn outline full" data-cancel-import>Cancel import</button></div></div>` : ''}
    </section>
    <section class="panel"><div class="panel-heading"><img class="app-icon" src="./icons/icon-192.png" width="56" height="56" alt=""><div><h2>Install Jenechka Cards</h2><small data-install-status>${installed() ? 'Opened as an installed app' : 'Your cards, one tap away'}</small></div></div>
      <button class="btn primary full" id="install-app" data-install ${installPrompt && !installed() ? '' : 'hidden'}>Install app</button>
      <ol class="install-steps"><li>On iPhone, open this site in <strong>Safari</strong>.</li><li>Tap <strong>Share → Add to Home Screen</strong>. Keep <strong>Open as Web App</strong> enabled if shown.</li><li>Open Jenechka Cards from its new home screen icon.</li></ol>
      <p class="help">Safari and the home screen app can have separate saved decks. Export in Safari first, then import in the installed app.</p>
      <div class="status-line">${statusPill()}</div><p class="help" id="offline-detail"></p>
    </section>
    <section class="panel"><h2>Storage on this device</h2>
      ${storage.warning ? `<p class="storage-warning" role="alert">${esc(storage.warning)}</p>` : ''}
      <p>${storage.backend === 'indexeddb' ? 'Decks are saved in an on-device database. A save is confirmed only after it finishes.' : storage.backend === 'localstorage' ? 'Using browser storage as a fallback on this device.' : 'Storage is unavailable. Export any available decks before reloading.'}</p>
      <p id="persistence-status" class="help"></p><button class="btn outline full" data-persist ${persistent ? 'disabled' : ''}>${persistent ? 'Storage protection enabled' : 'Request storage protection'}</button>
      <p class="help">Keep a JSON backup: clearing website data, removing the app, or device storage cleanup can remove local words. No account or cloud sync is used.</p>
    </section>`);
}

function syncDraft() {
  draft.name = $('name').value;
  draft.source = languageValue('source');
  draft.target = languageValue('target');
  for (const card of draft.cards) {
    card.front = $(`front-${card.id}`).value;
    card.back = $(`back-${card.id}`).value;
  }
}

function mayLeave() {
  if (isEditing() && dirty) return confirm('Discard unsaved changes?');
  if (page === 'study') return confirm('Exit this study session?');
  return true;
}

async function saveDecks(next) {
  busy = true;
  updateAppStatus();
  $('app').setAttribute('aria-busy', 'true');
  const fields = [...$('app').querySelectorAll('button, input, select, textarea')].map((field) => [field, field.disabled]);
  fields.forEach(([field]) => { field.disabled = true; });
  try {
    await storage.save(next);
    decks = copy(next);
    return true;
  } catch (error) {
    notify(error.message || 'Unable to save. Export a backup and check device storage.', true);
    return false;
  } finally {
    busy = false;
    fields.forEach(([field, disabled]) => { field.disabled = disabled; });
    $('app').setAttribute('aria-busy', 'false');
    updateAppStatus();
  }
}

function start(mode) {
  const deck = decks.find((item) => item.id === active);
  if (!deck?.cards.length) return go('decks');
  session = createStudySession(deck.cards, mode);
  go('study');
}

function draftCollection() {
  syncDraft();
  const saved = copy(draft);
  saved.name = saved.name.trim(); saved.source = saved.source.trim(); saved.target = saved.target.trim();
  if (!saved.name || !saved.source || !saved.target) throw new Error('Enter a deck name and both languages.');
  if (saved.cards.some((card) => Boolean(card.front.trim()) !== Boolean(card.back.trim()))) throw new Error('Complete both sides of each card.');
  saved.cards = saved.cards.filter((card) => card.front.trim() && card.back.trim()).map((card) => ({ ...card, front: card.front.trim(), back: card.back.trim() }));
  const next = copy(decks);
  const index = next.findIndex((deck) => deck.id === saved.id);
  if (index < 0) next.push(saved); else next[index] = saved;
  return next;
}

function backupFile(items = decks) {
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  return new File([JSON.stringify(makeBackup(items), null, 2)], `jenechka-cards-backup-${date}.json`, { type: 'application/json' });
}
function canShareBackup() {
  try { return Boolean(navigator.canShare?.({ files: [new File(['{}'], 'backup.json', { type: 'application/json' })] })); }
  catch { return false; }
}
function downloadBackup(items = decks) {
  const file = backupFile(items);
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  notify('Backup download started. Keep the JSON file somewhere safe.');
}
async function shareBackup() {
  try { await navigator.share({ files: [backupFile()], title: 'Jenechka Cards backup' }); }
  catch (error) { if (error.name !== 'AbortError') notify('Sharing is unavailable. Use Download backup instead.', true); }
}

$('app').addEventListener('input', () => { if (isEditing()) dirty = true; });
$('app').addEventListener('change', async (event) => {
  if (event.target.matches('[data-language-picker]')) {
    const id = event.target.id;
    if (id === 'library-source' || id === 'library-target') {
      const previousSource = librarySource;
      librarySource = languageValue('library-source');
      libraryTarget = languageValue('library-target');
      const targets = prebuiltTargets(languageByName(librarySource).code).map(language => language.name);
      if (!targets.includes(libraryTarget)) libraryTarget = targets.includes(previousSource) ? previousSource : targets[0];
      await refreshLibrary();
      if (page === 'prebuilt') $(id)?.focus({ preventScroll: true });
      return;
    }
    const custom = event.target.value === '__custom__';
    $(`${id}-custom-field`).hidden = !custom;
    if (custom) $(`${id}-custom`).focus();
    dirty = true;
    return;
  }
  if (event.target.id !== 'import-file') return;
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  pendingImport = null;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('This file is larger than 10 MB. Choose a smaller backup.');
    const imported = parseBackup(await file.text());
    // Validate the complete merge as well, before presenting a save action.
    mergeDecks(decks, imported);
    pendingImport = { name: file.name, decks: imported };
    if (page === 'settings') render();
  } catch (error) {
    if (page === 'settings') render();
    notify(error.message || 'This is not a valid Jenechka Cards backup.', true);
  }
});

$('app').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled || busy) return;
  const action = button.dataset;
  try {
    if (action.go) {
      if (!mayLeave()) return;
      const returnToChoices = page === 'prebuilt-builder' && action.go === 'prebuilt-preview';
      if (action.go === 'create') { draft = blankDeck(); dirty = false; }
      go(action.go);
      if (returnToChoices) showPrebuiltAddChoices();
      if (action.go === 'prebuilt' && !library && !libraryLoading) refreshLibrary();
    } else if ('swapLanguages' in action) {
      [librarySource, libraryTarget] = [libraryTarget, librarySource];
      await refreshLibrary();
    } else if (action.librarySection) {
      librarySection = action.librarySection; render();
      document.querySelector(`[data-library-section="${librarySection}"]`)?.focus({ preventScroll: true });
    } else if ('retryLibrary' in action) {
      await refreshLibrary();
    } else if (action.previewPrebuilt && library) {
      previewDefinition = definitions(library.catalog).find(item => item.id === action.previewPrebuilt);
      if (previewDefinition) go('prebuilt-preview');
    } else if ('addPrebuilt' in action) {
      showPrebuiltAddChoices();
    } else if ('cancel' in action) {
      if (mayLeave()) { dirty = false; go('decks'); }
    } else if ('add' in action) {
      syncDraft(); draft.cards.push(blankCard()); dirty = true; render();
      $(`front-${draft.cards.at(-1).id}`).focus();
    } else if (action.remove) {
      syncDraft(); draft.cards = draft.cards.filter((card) => card.id !== action.remove); dirty = true; render();
    } else if ('save' in action) {
      const next = draftCollection();
      if (await saveDecks(next)) { dirty = false; go('decks'); notify('Deck saved on this device.'); }
    } else if ('exportDraft' in action && isEditing()) {
      downloadBackup(draftCollection());
    } else if (action.edit) {
      draft = copy(decks.find((deck) => deck.id === action.edit)); dirty = false; go('edit');
    } else if (action.delete) {
      if (confirm('Delete this deck and all its cards? Export a backup first if you want to keep a copy.')) {
        if (await saveDecks(decks.filter((deck) => deck.id !== action.delete))) { render(); notify('Deck deleted.'); }
      }
    } else if (action.study) { active = action.study; go('modes'); }
    else if (action.mode) start(action.mode);
    else if ('flip' in action) {
      session.flipped = !session.flipped;
      button.classList.toggle('flipped', session.flipped);
      const card = session.queue[0];
      const value = session.flipped ? (card.reverse ? card.front : card.back) : (card.reverse ? card.back : card.front);
      button.setAttribute('aria-label', `${session.flipped ? 'Answer' : 'Question'}: ${value}. Tap to ${session.flipped ? 'see question' : 'reveal answer'}.`);
      document.querySelector('.ratings').style.visibility = session.flipped ? 'visible' : 'hidden';
    } else if (action.rate && session.flipped) {
      if (rateStudyCard(session, action.rate)) go('complete'); else render();
    } else if ('restart' in action) start(session.mode);
    else if ('exit' in action) { if (mayLeave()) go('decks'); }
    else if ('export' in action) downloadBackup();
    else if ('share' in action) await shareBackup();
    else if ('cancelImport' in action) { pendingImport = null; render(); }
    else if ('import' in action && pendingImport) {
      const merged = mergeDecks(decks, pendingImport.decks);
      if (merged.added && await saveDecks(merged.decks)) {
        pendingImport = null; render(); notify(`Imported ${merged.added} decks. Your existing decks were kept.`);
      }
    } else if ('persist' in action) {
      if (!navigator.storage?.persist) return notify('Storage protection is not supported here. Keep a JSON backup.', true);
      persistent = await navigator.storage.persist();
      render();
      notify(persistent ? 'Storage protection enabled. Keep backups for extra safety.' : 'Protection was not granted. On iPhone, try from the home screen app and keep JSON backups.');
    } else if ('install' in action && installPrompt) {
      const prompt = installPrompt; installPrompt = null;
      await prompt.prompt(); await prompt.userChoice; updateAppStatus();
    }
  } catch (error) { notify(error.message || 'Something went wrong. Your saved decks were not changed.', true); }
});

function updateAppStatus() {
  document.querySelectorAll('[data-network]').forEach((node) => { node.textContent = networkLabel(); });
  if ($('offline-detail')) $('offline-detail').textContent = offlineReady
    ? 'The app is saved for offline use. Open the installed app once online and wait for “Ready offline” before disconnecting.'
    : offlineError || 'Keep this page open online while the app prepares for offline use.';
  if ($('persistence-status')) $('persistence-status').textContent = persistent
    ? 'This browser has granted persistent storage. Clearing site data can still remove it.'
    : 'Storage protection depends on your browser. You can request it below.';
  if ($('install-app')) $('install-app').hidden = !installPrompt || installed();
  const waiting = Boolean(registration?.waiting);
  const unsafe = isEditing() || page === 'prebuilt-builder' || page === 'study' || busy;
  $('update-banner').hidden = !waiting;
  $('apply-update').disabled = unsafe;
  $('update-message').textContent = unsafe ? 'An update is ready. Save your deck or finish studying to update.' : 'A new version of Jenechka Cards is ready.';
}

$('apply-update').addEventListener('click', () => {
  if (!registration?.waiting || isEditing() || page === 'prebuilt-builder' || page === 'study' || busy) return;
  reloadRequested = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault(); installPrompt = event; updateAppStatus();
});
window.addEventListener('appinstalled', () => { installPrompt = null; if (page === 'settings') render(); });
window.addEventListener('online', updateAppStatus);
window.addEventListener('offline', updateAppStatus);
window.addEventListener('beforeunload', (event) => {
  if ((isEditing() && dirty) || selectionState?.manualIds.size || selectionState?.name.trim() || busy) {
    event.preventDefault(); event.returnValue = '';
  }
});

async function setupOffline() {
  if (!('serviceWorker' in navigator)) {
    offlineError = 'Offline installation is unavailable in this browser. Your saved decks can still be exported.';
    updateAppStatus(); return;
  }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    offlineReady = Boolean(registration.active);
    const watch = (worker) => worker?.addEventListener('statechange', () => {
      if (worker.state === 'activated') { offlineReady = true; offlineError = ''; }
      if (worker.state === 'redundant' && !offlineReady) offlineError = 'Offline setup did not finish. Reopen online and try again.';
      updateAppStatus();
    });
    watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      offlineReady = true;
      cacheLibraryPair();
      if (reloadRequested) location.reload(); else updateAppStatus();
    });
    navigator.serviceWorker.ready.then(() => { offlineReady = true; offlineError = ''; cacheLibraryPair(); updateAppStatus(); });
    updateAppStatus();
  } catch {
    offlineError = 'Offline setup could not finish. Reopen online in Safari or another supported browser.';
    updateAppStatus();
  }
}

try {
  storage = await openDeckStore();
  decks = copy(storage.decks);
  render();
  welcome.ready();
  navigator.storage?.persisted?.().then((value) => { persistent = value; updateAppStatus(); }).catch(() => {});
  setupOffline();
} catch (error) {
  welcome.cancel();
  $('app').setAttribute('aria-busy', 'false');
  $('app').innerHTML = `<h1>Your decks could not be opened</h1><p>${esc(error.message)}</p><p>Close other Jenechka Cards tabs and reopen the app. Do not clear website data unless you have a backup.</p>`;
  window.jenechkaBoot?.finish();
}
