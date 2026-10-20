// Keep large vocabulary previews small in the DOM while retaining native
// scrolling, momentum, vertical page gestures and pinch-to-zoom.
export const PREVIEW_PAGE_SIZE = 6;

export function previewWindow(totalCards, requestedPage = 0) {
  const pageCount = Math.ceil(totalCards / PREVIEW_PAGE_SIZE);
  const page = Math.max(0, Math.min(pageCount - 1, Math.trunc(requestedPage) || 0));
  const pages = [];
  for (let index = Math.max(0, page - 1); index <= Math.min(pageCount - 1, page + 1); index++) {
    pages.push({ index, start: index * PREVIEW_PAGE_SIZE, end: Math.min(totalCards, (index + 1) * PREVIEW_PAGE_SIZE) });
  }
  return { page, pageCount, pages };
}

export function setupPreviewSlider(root, cards, renderCard) {
  const viewport = root.querySelector('[data-preview-viewport]');
  const previous = root.querySelector('[data-preview-previous]');
  const next = root.querySelector('[data-preview-next]');
  const range = root.querySelector('[data-preview-range]');
  const counter = root.querySelector('[data-preview-count]');
  const controls = root.querySelector('.preview-controls');
  const abort = new AbortController();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let windowState, currentPage = 0, pendingPage = null, touching = false, destroyed = false;
  let settleTimer, resizeFrame, width = viewport.clientWidth;

  const wordRange = page => ({ start: page * PREVIEW_PAGE_SIZE + 1, end: Math.min(cards.length, (page + 1) * PREVIEW_PAGE_SIZE) });
  function updateControls(page) {
    const { start, end } = wordRange(page);
    const label = cards.length ? `Words ${start} to ${end} of ${cards.length}` : 'No words';
    counter.textContent = cards.length ? `${start}–${end} / ${cards.length}` : '0 / 0';
    counter.setAttribute('aria-label', label);
    previous.disabled = page <= 0;
    next.disabled = page >= windowState.pageCount - 1;
    range.max = String(Math.max(1, windowState.pageCount));
    range.value = String(page + 1);
    range.setAttribute('aria-valuetext', label);
    controls.hidden = range.hidden = windowState.pageCount <= 1;
  }

  function show(page) {
    clearTimeout(settleTimer);
    windowState = previewWindow(cards.length, page);
    currentPage = windowState.page;
    pendingPage = null;
    viewport.innerHTML = windowState.pages.map(part => `
      <div class="preview-page" data-preview-page="${part.index}" role="group" aria-roledescription="slide"
        aria-label="Words ${part.start + 1} to ${part.end} of ${cards.length}"${part.index === currentPage ? '' : ' aria-hidden="true" inert'}>
        <div class="vocabulary-preview" role="list">${cards.slice(part.start, part.end).map(renderCard).join('')}</div>
      </div>`).join('');
    width = viewport.clientWidth;
    viewport.scrollTo({ left: (currentPage - (windowState.pages[0]?.index || 0)) * width, behavior: 'instant' });
    updateControls(currentPage);
  }

  function settle() {
    clearTimeout(settleTimer);
    if (destroyed || touching || !width || !windowState.pages.length) return;
    // Browsers may emit scroll/scrollend while re-snapping after rotation,
    // before ResizeObserver runs. Do not interpret old offsets at a new size
    // as a user-requested page change.
    if (viewport.clientWidth !== width) { show(pendingPage ?? currentPage); return; }
    const slot = Math.max(0, Math.min(windowState.pages.length - 1, Math.round(viewport.scrollLeft / width)));
    const page = windowState.pages[slot].index;
    pendingPage = null;
    if (page !== currentPage) show(page);
    else updateControls(page);
  }

  function scheduleSettle() {
    clearTimeout(settleTimer);
    // scrollend is not available in every installed Safari version. A finger
    // held still must not trigger recentering before touchend or touchcancel.
    settleTimer = setTimeout(settle, 180);
  }

  function move(requestedPage, animate = true) {
    const page = previewWindow(cards.length, requestedPage).page;
    const slot = windowState.pages.findIndex(part => part.index === page);
    if (slot < 0 || !animate) {
      // An explicit page selection replaces any gesture on the old slides.
      touching = false;
      show(page);
      return;
    }
    pendingPage = page;
    viewport.scrollTo({ left: slot * width, behavior: motion.matches ? 'instant' : 'smooth' });
    if (motion.matches) settle(); else scheduleSettle();
  }

  const listen = (element, event, callback, options = {}) => element.addEventListener(event, callback, { ...options, signal: abort.signal });
  listen(previous, 'click', () => move((pendingPage ?? currentPage) - 1));
  listen(next, 'click', () => move((pendingPage ?? currentPage) + 1));
  listen(range, 'input', () => move(Number(range.value) - 1, false));
  listen(viewport, 'scroll', scheduleSettle, { passive: true });
  listen(viewport, 'scrollend', settle);
  listen(viewport, 'touchstart', event => { touching = event.touches.length > 0; }, { passive: true });
  const finishTouch = event => { touching = event.touches.length > 0; if (!touching) scheduleSettle(); };
  listen(viewport, 'touchend', finishTouch, { passive: true });
  listen(viewport, 'touchcancel', finishTouch, { passive: true });
  listen(viewport, 'keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const page = pendingPage ?? currentPage;
    const targets = { ArrowLeft: page - 1, ArrowRight: page + 1, PageUp: page - 1, PageDown: page + 1, Home: 0, End: windowState.pageCount - 1 };
    if (!(event.key in targets)) return;
    event.preventDefault();
    move(targets[event.key], !['Home', 'End'].includes(event.key));
  });

  show(0);
  const resize = new ResizeObserver(() => {
    if (destroyed || touching || viewport.clientWidth === width) return;
    cancelAnimationFrame(resizeFrame);
    // Keep a held touch's original target attached so its touchend can reach
    // the viewport. settle() rebases a deferred resize once the touch ends.
    resizeFrame = requestAnimationFrame(() => { if (!destroyed && !touching) show(pendingPage ?? currentPage); });
  });
  resize.observe(viewport);
  return () => {
    destroyed = true;
    abort.abort();
    clearTimeout(settleTimer);
    cancelAnimationFrame(resizeFrame);
    resize.disconnect();
  };
}
