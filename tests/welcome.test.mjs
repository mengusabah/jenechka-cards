import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../welcome.js', import.meta.url), 'utf8');
const KEY = 'jenechka-cards-last-active-v1';
const TWO_HOURS = 2 * 60 * 60 * 1000;
const START = 1_800_000_000_000;

class Events {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  fire(type, event = {}) {
    for (const callback of [...(this.listeners.get(type) || [])]) callback(event);
  }
}

function fixture(options = {}) {
  let now = options.now ?? START, nextTimer = 0;
  const timers = new Map();
  const records = options.records ?? new Map();
  const writes = [];
  const document = new Events();
  document.visibilityState = options.hidden ? 'hidden' : 'visible';
  const element = () => Object.assign(new Events(), {
    hidden: false, inert: false, isConnected: true,
    children: new Set(),
    contains(candidate) { return candidate === this || this.children.has(candidate); },
    focus() { document.activeElement = this; document.fire('focusin', { target: this }); },
  });
  const app = element(), overlay = element(), image = element(), heading = element(), priorFocus = element();
  overlay.hidden = true;
  app.children.add(heading);
  app.querySelector = () => heading;
  app.inert = options.inert ?? false;
  image.complete = options.imageComplete ?? true;
  image.naturalWidth = options.imageWidth ?? 192;
  document.body = element();
  document.activeElement = options.priorFocus ? priorFocus : document.body;
  const classes = new Set();
  const bootCalls = [];
  if (options.boot) classes.add('booting');
  document.documentElement = { classList: {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
  } };
  const elements = { welcome: overlay, 'welcome-image': image, app };
  if (options.missing) delete elements[options.missing];
  document.getElementById = (id) => elements[id];
  const motion = Object.assign(new Events(), { matches: options.reducedMotion ?? false });
  const window = Object.assign(new Events(), {
    matchMedia: () => motion,
    localStorage: {
      getItem(key) {
        if (options.storageReadThrows) throw new Error('Read denied');
        return records.get(key) ?? null;
      },
      setItem(key, value) {
        if (options.storageWriteThrows) throw new Error('Quota exceeded');
        writes.push([key, value]);
        records.set(key, value);
      },
    },
  });
  if (options.boot) window.jenechkaBoot = { finish() {
    bootCalls.push({ overlayHidden: overlay.hidden, welcomeVisible: classes.has('welcome-visible') });
    classes.delete('booting');
  } };
  if (options.storageGetterThrows) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage disabled'); } });
  const setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const setup = vm.runInNewContext(source.replace('export function setupWelcome', 'function setupWelcome') + '\nsetupWelcome;', {
    window, document, setTimeout, clearTimeout, Date: { now: () => now },
  });
  function advance(milliseconds) {
    const end = now + milliseconds;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  }
  function visibility(state) {
    document.visibilityState = state;
    document.fire('visibilitychange');
  }
  return { setup, advance, visibility, document, window, app, overlay, image, heading, priorFocus, motion, classes, records, writes, timers, bootCalls, now: () => now };
}

test('first visit shows, focuses the overlay, and waits for ready before its 450ms exit', () => {
  const f = fixture();
  const welcome = f.setup();
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.app.inert, true);
  assert.equal(f.document.activeElement, f.overlay);
  assert.ok(f.classes.has('welcome-visible'));
  f.advance(1900);
  assert.equal(f.classes.has('welcome-leaving'), false);
  welcome.ready();
  assert.ok(f.classes.has('welcome-leaving'));
  f.advance(449);
  assert.equal(f.overlay.hidden, false);
  f.advance(1);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.app.inert, false);
  assert.equal(f.classes.size, 0);
  assert.equal(f.document.activeElement, f.heading);
  welcome.cancel();
  assert.equal(f.timers.size, 0);
});

test('ready app gets a 1700ms welcome and a 450ms exit, and restores existing focus', () => {
  const f = fixture({ priorFocus: true });
  const welcome = f.setup();
  welcome.ready();
  f.advance(1699);
  assert.equal(f.classes.has('welcome-leaving'), false);
  f.advance(1);
  assert.ok(f.classes.has('welcome-leaving'));
  f.advance(450);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.document.activeElement, f.priorFocus);
  welcome.cancel();
});

test('the independent 3500ms failsafe restores the app even if initialization never finishes', () => {
  const f = fixture();
  const welcome = f.setup();
  f.advance(3499);
  assert.equal(f.overlay.hidden, false);
  f.advance(1);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.app.inert, false);
  assert.equal(f.classes.size, 0);
  welcome.ready();
  f.advance(500);
  assert.equal(f.overlay.hidden, true);
  welcome.cancel();
});

test('recent activity suppresses welcome and the 2-hour boundary allows it', () => {
  for (const [elapsed, shouldShow] of [[TWO_HOURS - 1, false], [TWO_HOURS, true]]) {
    const f = fixture({ records: new Map([[KEY, String(START - elapsed)]]) });
    const welcome = f.setup();
    assert.equal(!f.overlay.hidden, shouldShow);
    assert.equal(f.records.get(KEY), String(START));
    welcome.cancel();
  }
});

test('hidden startup waits until visible, then compares the old timestamp before writing', () => {
  const records = new Map([[KEY, String(START - TWO_HOURS)]]);
  const f = fixture({ records, hidden: true });
  const welcome = f.setup();
  welcome.ready();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.writes.length, 0);
  f.visibility('visible');
  assert.equal(f.overlay.hidden, false);
  f.advance(2150);
  assert.equal(f.overlay.hidden, true);
  welcome.cancel();
});

test('short tab returns stay quiet, a long absence plays again, and hiding releases inert', () => {
  const f = fixture();
  const welcome = f.setup();
  welcome.ready();
  f.visibility('hidden');
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.app.inert, false);
  assert.equal(f.timers.size, 0);
  f.advance(TWO_HOURS - 1);
  f.visibility('visible');
  assert.equal(f.overlay.hidden, true);
  f.visibility('hidden');
  f.advance(TWO_HOURS);
  f.visibility('visible');
  assert.equal(f.overlay.hidden, false);
  f.advance(2150);
  assert.equal(f.overlay.hidden, true);
  welcome.cancel();
});

test('shared storage suppresses repeated welcomes across tabs and tracks a still-active tab', () => {
  const records = new Map();
  const first = fixture({ records });
  const welcome = first.setup();
  welcome.ready();
  first.advance(TWO_HOURS + 500);
  assert.ok(Number(records.get(KEY)) >= first.now() - 60_000);
  const second = fixture({ records, now: first.now() });
  const otherWelcome = second.setup();
  assert.equal(second.overlay.hidden, true);
  welcome.cancel();
  otherWelcome.cancel();
});

test('a long-hidden tab closing does not overwrite the last active timestamp', () => {
  const f = fixture();
  const welcome = f.setup();
  f.visibility('hidden');
  const hiddenAt = f.records.get(KEY);
  f.advance(TWO_HOURS);
  f.window.fire('pagehide');
  assert.equal(f.records.get(KEY), hiddenAt);
  f.document.visibilityState = 'visible';
  f.window.fire('pageshow');
  assert.equal(f.overlay.hidden, false);
  welcome.cancel();
});

test('reduced motion skips welcome and changing the preference dismisses an active welcome', () => {
  const reduced = fixture({ reducedMotion: true });
  const reducedWelcome = reduced.setup();
  assert.equal(reduced.overlay.hidden, true);
  assert.equal(reduced.app.inert, false);
  reducedWelcome.cancel();
  const f = fixture();
  const welcome = f.setup();
  f.motion.matches = true;
  f.motion.fire('change');
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.app.inert, false);
  assert.equal(f.classes.size, 0);
  welcome.cancel();
});

test('a pending image is hidden until loaded; failures and stalled loads never block the app', () => {
  const f = fixture({ imageComplete: false });
  const welcome = f.setup();
  welcome.ready();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.app.inert, false);
  f.advance(400);
  f.image.fire('load');
  assert.equal(f.overlay.hidden, false);
  f.advance(2150);
  assert.equal(f.overlay.hidden, true);
  welcome.cancel();
  for (const outcome of ['error', 'timeout']) {
    const stalled = fixture({ imageComplete: false });
    const stalledWelcome = stalled.setup();
    if (outcome === 'error') stalled.image.fire('error');
    else stalled.advance(3500);
    stalled.image.fire('load');
    assert.equal(stalled.overlay.hidden, true);
    assert.equal(stalled.app.inert, false);
    stalledWelcome.cancel();
  }
  const broken = fixture({ imageWidth: 0 });
  const brokenWelcome = broken.setup();
  assert.equal(broken.overlay.hidden, true);
  assert.equal(broken.app.inert, false);
  brokenWelcome.cancel();
});

test('Tab keeps focus on the button-free overlay and Escape restores the prior inert state', () => {
  const f = fixture({ inert: true });
  const welcome = f.setup();
  let prevented = false;
  f.document.fire('keydown', { key: 'Tab', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(f.document.activeElement, f.overlay);
  f.priorFocus.focus();
  assert.equal(f.document.activeElement, f.overlay);
  f.document.fire('pointerdown');
  assert.equal(f.overlay.hidden, false);
  f.document.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.app.inert, true);
  assert.equal(f.classes.size, 0);
  assert.equal(f.overlay.listeners.has('click'), false);
  welcome.cancel();
});

test('interaction while an image is loading cancels the pending welcome without consuming the event', () => {
  for (const type of ['pointerdown', 'keydown']) {
    const f = fixture({ imageComplete: false });
    const welcome = f.setup();
    welcome.ready();
    let prevented = false, stopped = false;
    f.heading.focus();
    f.document.fire(type, {
      key: 'Enter',
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
    });
    f.image.fire('load');
    f.advance(3500);
    assert.equal(prevented, false);
    assert.equal(stopped, false);
    assert.equal(f.overlay.hidden, true);
    assert.equal(f.app.inert, false);
    assert.equal(f.document.activeElement, f.heading);
    assert.equal(f.classes.size, 0);
    welcome.cancel();
    assert.equal(f.timers.size, 0);
    assert.equal(f.document.listeners.get('pointerdown').size, 0);
  }
});

test('storage failures are silent, use in-memory timing, and never alter card data', () => {
  for (const failure of ['storageGetterThrows', 'storageReadThrows', 'storageWriteThrows']) {
    const records = new Map([['another-app-data', 'precious vocabulary']]);
    const f = fixture({ [failure]: true, records });
    const welcome = f.setup();
    assert.equal(f.overlay.hidden, false);
    f.visibility('hidden');
    f.advance(1000);
    f.visibility('visible');
    assert.equal(f.overlay.hidden, true);
    assert.equal(records.get('another-app-data'), 'precious vocabulary');
    assert.ok(f.writes.every(([key]) => key === KEY));
    welcome.cancel();
  }
});

test('invalid and future timestamps cannot suppress welcome indefinitely and are repaired', () => {
  for (const value of ['bad', '-5', 'Infinity', '', String(START + TWO_HOURS)]) {
    const f = fixture({ records: new Map([[KEY, value]]) });
    const welcome = f.setup();
    assert.equal(f.overlay.hidden, false);
    assert.equal(f.records.get(KEY), String(START));
    welcome.cancel();
  }
});

test('cancel cleans up all timers and listeners and prevents later resumes from replaying', () => {
  const f = fixture();
  const welcome = f.setup();
  welcome.cancel();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.app.inert, false);
  assert.equal(f.timers.size, 0);
  for (const target of [f.document, f.window, f.image, f.overlay, f.motion]) {
    assert.ok([...target.listeners.values()].every((callbacks) => callbacks.size === 0));
  }
  f.advance(TWO_HOURS);
  f.visibility('visible');
  welcome.ready();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.timers.size, 0);
});

test('missing optional welcome markup makes setup a harmless no-op', () => {
  const f = fixture({ missing: 'welcome-image' });
  const welcome = f.setup();
  welcome.ready();
  welcome.cancel();
  assert.equal(f.timers.size, 0);
  assert.equal(f.writes.length, 0);
});

test('boot stays closed while a ready app waits for the welcome image and opens under the visible overlay', () => {
  const f = fixture({ boot: true, imageComplete: false });
  const welcome = f.setup();
  welcome.ready();
  f.advance(400);
  assert.ok(f.classes.has('booting'));
  assert.equal(f.bootCalls.length, 0);
  f.image.fire('load');
  assert.equal(f.classes.has('booting'), false);
  assert.deepEqual(f.bootCalls, [{ overlayHidden: false, welcomeVisible: true }]);
  f.advance(2150);
  assert.equal(f.overlay.hidden, true);
  f.visibility('hidden');
  f.advance(TWO_HOURS);
  f.visibility('visible');
  f.image.fire('load');
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.classes.has('booting'), false);
  assert.equal(f.bootCalls.length, 1);
  welcome.cancel();
});

test('a cached welcome image can replace boot before the app is ready without revealing the app', () => {
  const f = fixture({ boot: true });
  const welcome = f.setup();
  assert.equal(f.classes.has('booting'), false);
  assert.deepEqual(f.bootCalls, [{ overlayHidden: false, welcomeVisible: true }]);
  assert.equal(f.app.inert, true);
  f.advance(1800);
  assert.equal(f.classes.has('welcome-leaving'), false);
  welcome.ready();
  assert.ok(f.classes.has('welcome-leaving'));
  assert.equal(f.bootCalls.length, 1);
  welcome.cancel();
});

test('without a welcome, boot remains until the app is ready', () => {
  for (const options of [
    { records: new Map([[KEY, String(START)]]) },
    { reducedMotion: true },
    { missing: 'welcome-image' },
  ]) {
    const f = fixture({ ...options, boot: true });
    const welcome = f.setup();
    assert.ok(f.classes.has('booting'));
    assert.equal(f.bootCalls.length, 0);
    welcome.ready();
    assert.equal(f.classes.has('booting'), false);
    assert.deepEqual(f.bootCalls, [{ overlayHidden: true, welcomeVisible: false }]);
    welcome.ready();
    assert.equal(f.bootCalls.length, 1);
    welcome.cancel();
  }
});

test('image failures, cancel, and the failsafe release boot only once the app is ready', () => {
  for (const outcome of ['error', 'cancel', 'timeout', 'interaction']) {
    for (const readyFirst of [false, true]) {
      const f = fixture({ boot: true, imageComplete: false });
      const welcome = f.setup();
      if (readyFirst) welcome.ready();
      assert.ok(f.classes.has('booting'));
      if (outcome === 'error') f.image.fire('error');
      else if (outcome === 'cancel') welcome.cancel();
      else if (outcome === 'interaction') f.document.fire('pointerdown');
      else f.advance(3500);
      assert.equal(f.classes.has('booting'), !readyFirst);
      assert.equal(f.bootCalls.length, readyFirst ? 1 : 0);
      welcome.ready();
      assert.equal(f.classes.has('booting'), false);
      assert.deepEqual(f.bootCalls, [{ overlayHidden: true, welcomeVisible: false }]);
      f.image.fire('load');
      assert.equal(f.overlay.hidden, true);
      welcome.cancel();
    }
  }
});
