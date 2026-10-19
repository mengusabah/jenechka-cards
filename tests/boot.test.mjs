import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const bootstrap = scripts.find(([, attributes, code]) =>
  !/\bsrc\s*=/i.test(attributes) && code.includes('window.jenechkaBoot')
);
assert.ok(bootstrap, 'the launch guard must be available inline, without a module request');

function launch() {
  const classes = new Set();
  const fallback = { hidden: true };
  const timers = new Map();
  let now = 0;
  let nextTimer = 1;
  const window = {};
  const document = {
    documentElement: {
      classList: {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
      },
    },
    getElementById: id => id === 'boot-fallback' ? fallback : null,
  };
  vm.runInNewContext(bootstrap[2], {
    window,
    document,
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  }, { filename: 'index.html:inline-bootstrap' });

  return {
    window,
    fallback,
    get masked() { return classes.has('booting'); },
    get pendingTimers() { return timers.size; },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.due;
        timers.delete(id);
        timer.callback();
      }
      now = target;
    },
  };
}

test('the inline guard shows recovery after eight seconds if modules never arrive', () => {
  const page = launch();
  assert.equal(page.masked, true);
  assert.equal(page.fallback.hidden, true);
  assert.equal(page.pendingTimers, 1);
  page.advance(7999);
  assert.equal(page.masked, true);
  assert.equal(page.fallback.hidden, true);
  page.advance(1);
  assert.equal(page.masked, false, 'the recovery screen must not remain behind the launch mask');
  assert.equal(page.fallback.hidden, false);
  assert.equal(page.pendingTimers, 0);
});

test('successful boot removes the mask and cancels recovery before it can appear', () => {
  const page = launch();
  page.advance(1200);
  page.window.jenechkaBoot.finish();
  assert.equal(page.masked, false);
  assert.equal(page.fallback.hidden, true);
  assert.equal(page.pendingTimers, 0);
  page.advance(10000);
  assert.equal(page.fallback.hidden, true, 'a stale timeout must not cover the working app');
  assert.doesNotThrow(() => page.window.jenechkaBoot.finish());
  assert.equal(page.pendingTimers, 0);
});

test('modules arriving after the deadline can dismiss the visible recovery screen', () => {
  const page = launch();
  page.advance(9000);
  assert.equal(page.fallback.hidden, false);
  page.window.jenechkaBoot.finish();
  assert.equal(page.masked, false);
  assert.equal(page.fallback.hidden, true);
  assert.equal(page.pendingTimers, 0);
  page.advance(10000);
  assert.equal(page.fallback.hidden, true);
});

test('the guard precedes external rendering dependencies and initial app content is empty', () => {
  const stylesheet = /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/i.exec(html);
  const moduleScript = scripts.find(([, attributes]) => /\btype=["']module["']/i.test(attributes));
  assert.ok(stylesheet && moduleScript);
  assert.ok(bootstrap.index < stylesheet.index);
  assert.ok(bootstrap.index < moduleScript.index);
  const main = /<main\b[^>]*\bid=["']app["'][^>]*>([\s\S]*?)<\/main>/i.exec(html);
  assert.ok(main);
  assert.equal(main[1].trim(), '', 'the first frame must not contain the previous loading message');
  assert.doesNotMatch(html, /Loading your decks/i);
});

test('the mascot image preload targets the actual welcome image', () => {
  const preload = [...html.matchAll(/<link\b[^>]*>/gi)].find(([tag]) =>
    /\brel=["']preload["']/i.test(tag) && /\bas=["']image["']/i.test(tag)
  );
  const image = /<img\b[^>]*\bid=["']welcome-image["'][^>]*>/i.exec(html);
  assert.ok(preload && image);
  const href = /\bhref=["']([^"']+)["']/i.exec(preload[0]);
  const src = /\bsrc=["']([^"']+)["']/i.exec(image[0]);
  assert.ok(href && src);
  assert.equal(href[1], src[1], 'the preload must fetch the image the welcome screen actually renders');
});
