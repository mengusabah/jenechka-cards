let nextDialogId = 0;
let activeCleanup = null;

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const arrow = icon('<path d="m9 5 7 7-7 7"/>');

// Fixing the body also prevents background scrolling in installed iOS apps.
// Restore each property separately so unrelated inline styles remain intact.
function lockScroll() {
  const body = document.body;
  const root = document.documentElement;
  const x = window.scrollX;
  const y = window.scrollY;
  const properties = ['position', 'top', 'left', 'width', 'overflow', 'padding-right'];
  const previous = properties.map(property => [property, body.style.getPropertyValue(property), body.style.getPropertyPriority(property)]);
  const rootOverflow = [root.style.getPropertyValue('overflow'), root.style.getPropertyPriority('overflow')];
  const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
  const padding = parseFloat(getComputedStyle(body).paddingRight) || 0;
  body.style.position = 'fixed';
  body.style.top = `${-y}px`;
  body.style.left = `${-x}px`;
  body.style.width = '100%';
  body.style.overflow = 'hidden';
  if (scrollbarWidth) body.style.paddingRight = `${padding + scrollbarWidth}px`;
  root.style.overflow = 'hidden';
  return () => {
    for (const [property, value, priority] of previous) {
      if (value) body.style.setProperty(property, value, priority);
      else body.style.removeProperty(property);
    }
    if (rootOverflow[0]) root.style.setProperty('overflow', ...rootOverflow);
    else root.style.removeProperty('overflow');
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  };
}

export function openDeckAddDialog({ template, alreadyImported = false, onAll, onChoose }) {
  activeCleanup?.();
  const opener = document.activeElement;
  const abort = new AbortController();
  const id = `deck-add-${++nextDialogId}`;
  const count = template.cards.length;
  const wordCount = `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'deck-add-dialog';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-description`);
  dialog.innerHTML = `
    <section class="deck-add-sheet">
      <span class="deck-add-handle" aria-hidden="true"></span>
      <div class="deck-add-heading">
        <div>
          <h2 id="${id}-title" tabindex="-1" autofocus>Add to My Decks</h2>
          <p id="${id}-description">${escapeHTML(template.name)} <span aria-hidden="true">·</span> ${wordCount}</p>
        </div>
        <button class="deck-add-close" type="button" data-add-close aria-label="Close">${icon('<path d="m6 6 12 12M18 6 6 18"/>')}</button>
      </div>
      <div class="deck-add-options">
        <button class="deck-add-option" type="button" data-add-choice="all"${alreadyImported || !count ? ' disabled' : ''}>
          <span class="deck-add-icon">${icon('<rect x="7" y="7" width="13" height="14" rx="3"/><path d="M16 7V5a2 2 0 0 0-2-2H6a3 3 0 0 0-3 3v10a2 2 0 0 0 2 2h2"/>')}</span>
          <span class="deck-add-copy"><strong data-add-all-label>Add all words</strong><span>${alreadyImported ? 'Already in My Decks' : `All ${wordCount} in one deck`}</span></span>
          <span class="deck-add-arrow">${alreadyImported ? icon('<path d="m5 12 4 4L19 6"/>') : arrow}</span>
        </button>
        <button class="deck-add-option" type="button" data-add-choice="random"${!count ? ' disabled' : ''}>
          <span class="deck-add-icon">${icon('<path d="M3 6h2c5 0 9 12 14 12h2M17 14l4 4-4 4M3 18h2c2.2 0 4.2-2.3 6.2-5M13 9c2-2 3.8-3 6-3h2M17 2l4 4-4 4"/>')}</span>
          <span class="deck-add-copy"><strong>Random words</strong><span>Choose how many</span></span>
          <span class="deck-add-arrow">${arrow}</span>
        </button>
        <button class="deck-add-option" type="button" data-add-choice="manual"${!count ? ' disabled' : ''}>
          <span class="deck-add-icon">${icon('<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m7 12 3 3 7-7"/>')}</span>
          <span class="deck-add-copy"><strong>Choose words</strong><span>Pick the words you want</span></span>
          <span class="deck-add-arrow">${arrow}</span>
        </button>
      </div>
      <p class="deck-add-error" role="alert" hidden></p>
      <button class="deck-add-back" type="button" data-add-back>Back to preview</button>
    </section>`;
  let disposed = false;
  let pending = false;
  let backdropStarted = false;
  const buttons = [...dialog.querySelectorAll('button')];
  const initialDisabled = new Map(buttons.map(button => [button, button.disabled]));
  const allLabel = dialog.querySelector('[data-add-all-label]');
  const error = dialog.querySelector('.deck-add-error');
  document.body.append(dialog);
  const unlockScroll = lockScroll();

  function cleanup() {
    if (disposed) return;
    disposed = true;
    abort.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    unlockScroll();
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    if (activeCleanup === cleanup) activeCleanup = null;
  }
  activeCleanup = cleanup;

  function setPending(value) {
    pending = value;
    dialog.setAttribute('aria-busy', String(value));
    for (const button of buttons) button.disabled = value || initialDisabled.get(button);
    allLabel.textContent = value ? 'Adding words…' : 'Add all words';
  }

  async function addAll() {
    if (disposed || pending || alreadyImported || !count) return;
    error.hidden = true;
    setPending(true);
    let message = 'We couldn’t add this deck. Please try again.';
    try {
      const added = await onAll();
      if (disposed) return;
      if (added === true) { cleanup(); return; }
    } catch (failure) {
      if (disposed) return;
      if (typeof failure?.message === 'string' && failure.message.trim()) message = failure.message;
    }
    setPending(false);
    error.textContent = message;
    error.hidden = false;
    dialog.querySelector('[data-add-choice="all"]').focus({ preventScroll: true });
  }

  const listen = (type, callback) => dialog.addEventListener(type, callback, { signal: abort.signal });
  listen('pointerdown', event => { backdropStarted = event.target === dialog; });
  listen('pointercancel', () => { backdropStarted = false; });
  listen('click', event => {
    const backdropClick = event.target === dialog && backdropStarted;
    backdropStarted = false;
    if (disposed || pending) return;
    if (backdropClick) { cleanup(); return; }
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-add-close') || button.hasAttribute('data-add-back')) {
      cleanup();
      return;
    }
    const choice = button.dataset.addChoice;
    if (choice === 'all') { void addAll(); return; }
    if (choice === 'random' || choice === 'manual') {
      cleanup();
      onChoose(choice);
    }
  });
  listen('cancel', event => {
    event.preventDefault();
    if (!pending) cleanup();
  });
  listen('close', cleanup);
  try {
    dialog.showModal();
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
