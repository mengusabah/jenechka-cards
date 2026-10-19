const LAST_ACTIVE_KEY = 'jenechka-cards-last-active-v1';
const RETURN_AFTER = 2 * 60 * 60 * 1000;
const WELCOME_DURATION = 1700;
const EXIT_DURATION = 450;
const FAILSAFE_DURATION = 3500;
const ACTIVE_INTERVAL = 60 * 1000;

export function setupWelcome() {
  let bootFinished = false;
  function finishBoot() {
    if (bootFinished) return;
    bootFinished = true;
    if (typeof window !== 'undefined') window.jenechkaBoot?.finish?.();
  }
  const noop = { ready: finishBoot, cancel() {} };
  if (typeof document === 'undefined') return noop;
  const overlay = document.getElementById('welcome');
  const image = document.getElementById('welcome-image');
  const app = document.getElementById('app');
  if (!overlay || !image || !app) return noop;

  const root = document.documentElement;
  const motion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let appReady = false, cancelled = false, pending = false, visible = false, leaving = false, imageFailed = false;
  let lastActive = null, shownAt = 0, previousFocus = null, previousInert = false;
  let closeTimer, exitTimer, failsafeTimer, activeTimer;

  function validTime(value, now) {
    const timestamp = Number(value);
    return Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= now ? timestamp : null;
  }

  function readLastActive(now) {
    let saved = null;
    try { saved = validTime(window.localStorage.getItem(LAST_ACTIVE_KEY), now); } catch {}
    const remembered = validTime(lastActive, now);
    if (saved === null) return remembered;
    return remembered === null ? saved : Math.max(saved, remembered);
  }

  function recordActivity(now = Date.now()) {
    lastActive = now;
    try { window.localStorage.setItem(LAST_ACTIVE_KEY, String(now)); } catch {}
  }

  function dismiss(restoreFocus = true) {
    const restore = restoreFocus && visible && overlay.contains(document.activeElement);
    pending = false;
    clearTimeout(closeTimer);
    clearTimeout(exitTimer);
    clearTimeout(failsafeTimer);
    image.removeEventListener('load', imageLoaded);
    image.removeEventListener('error', imageError);
    root.classList.remove('welcome-visible', 'welcome-leaving');
    overlay.hidden = true;
    if (visible) app.inert = previousInert;
    visible = false;
    leaving = false;
    if (appReady) finishBoot();
    if (restore && document.visibilityState !== 'hidden') {
      const target = previousFocus?.isConnected && previousFocus !== document.body && !previousFocus.inert
        ? previousFocus
        : !app.inert && app.querySelector('h1, button, [href], input, select, textarea, [tabindex]');
      target?.focus?.({ preventScroll: true });
    }
    previousFocus = null;
  }

  function beginExit() {
    if (!visible || leaving || !appReady) return;
    leaving = true;
    root.classList.add('welcome-leaving');
    exitTimer = setTimeout(dismiss, EXIT_DURATION);
  }

  function scheduleExit() {
    if (!visible || leaving || !appReady) return;
    clearTimeout(closeTimer);
    const remaining = WELCOME_DURATION - (Date.now() - shownAt);
    if (remaining <= 0) beginExit();
    else closeTimer = setTimeout(beginExit, remaining);
  }

  function imageLoaded() {
    if (!pending || visible || cancelled || document.visibilityState === 'hidden') return;
    if (!image.naturalWidth) return imageError();
    if (motion?.matches) return dismiss();
    previousFocus = document.activeElement;
    previousInert = app.inert;
    app.inert = true;
    overlay.hidden = false;
    root.classList.add('welcome-visible');
    visible = true;
    shownAt = Date.now();
    finishBoot();
    overlay.focus({ preventScroll: true });
    scheduleExit();
  }

  function imageError() {
    imageFailed = true;
    dismiss();
  }

  function show() {
    if (pending || visible || imageFailed || motion?.matches) return;
    pending = true;
    // This deadline also covers an image that never finishes loading.
    failsafeTimer = setTimeout(dismiss, FAILSAFE_DURATION);
    image.addEventListener('load', imageLoaded);
    image.addEventListener('error', imageError);
    if (image.complete) imageLoaded();
  }

  function keepActive() {
    clearTimeout(activeTimer);
    if (cancelled || document.visibilityState === 'hidden') return;
    activeTimer = setTimeout(() => {
      if (document.visibilityState !== 'hidden') recordActivity();
      keepActive();
    }, ACTIVE_INTERVAL);
  }

  function visit() {
    if (cancelled || document.visibilityState === 'hidden') return;
    const now = Date.now();
    const previous = readLastActive(now);
    const due = previous === null || now - previous >= RETURN_AFTER;
    // Read before writing, and claim this visit before another tab checks it.
    recordActivity(now);
    if (due) show();
    keepActive();
  }

  function visibilityChanged() {
    if (document.visibilityState === 'hidden') {
      recordActivity();
      clearTimeout(activeTimer);
      dismiss(false);
    } else visit();
  }

  function pageHidden() {
    // Closing a tab that was already hidden must not count as new activity.
    if (document.visibilityState !== 'hidden') recordActivity();
    clearTimeout(activeTimer);
    dismiss(false);
  }

  function keyPressed(event) {
    if (pending && !visible) {
      dismiss(false);
      return;
    }
    if (!visible) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') dismiss();
      else overlay.focus({ preventScroll: true });
    }
  }

  function pointerPressed() {
    if (pending && !visible) dismiss(false);
  }

  function focusChanged(event) {
    if (visible && !overlay.contains(event.target)) overlay.focus({ preventScroll: true });
  }

  function motionChanged() {
    if (motion.matches) dismiss();
  }

  document.addEventListener('visibilitychange', visibilityChanged);
  document.addEventListener('keydown', keyPressed, true);
  document.addEventListener('pointerdown', pointerPressed, true);
  document.addEventListener('focusin', focusChanged, true);
  window.addEventListener('pagehide', pageHidden);
  window.addEventListener('pageshow', visit);
  if (motion?.addEventListener) motion.addEventListener('change', motionChanged);
  else motion?.addListener?.(motionChanged);
  visit();

  return {
    ready() {
      appReady = true;
      if (!pending || visible) finishBoot();
      scheduleExit();
    },
    cancel() {
      cancelled = true;
      dismiss();
      clearTimeout(activeTimer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      document.removeEventListener('keydown', keyPressed, true);
      document.removeEventListener('pointerdown', pointerPressed, true);
      document.removeEventListener('focusin', focusChanged, true);
      window.removeEventListener('pagehide', pageHidden);
      window.removeEventListener('pageshow', visit);
      if (motion?.removeEventListener) motion.removeEventListener('change', motionChanged);
      else motion?.removeListener?.(motionChanged);
    },
  };
}
