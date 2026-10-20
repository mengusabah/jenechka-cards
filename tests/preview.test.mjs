import test from 'node:test';
import assert from 'node:assert/strict';
import { previewWindow } from '../preview.js';

test('six-card page boundaries handle empty, exact and partial pages', () => {
  const cases = [
    [0, []],
    [1, [[0, 1]]],
    [6, [[0, 6]]],
    [7, [[0, 6], [6, 7]]],
    [12, [[0, 6], [6, 12]]],
    [13, [[0, 6], [6, 12], [12, 13]]],
  ];
  for (const [total, expected] of cases) {
    const initial = previewWindow(total);
    assert.equal(initial.page, 0);
    assert.equal(initial.pageCount, expected.length, `${total} cards`);
    if (!total) {
      assert.deepEqual(initial.pages, []);
      assert.deepEqual(previewWindow(total, 99), initial);
      continue;
    }
    for (const [index, [start, end]] of expected.entries()) {
      const current = previewWindow(total, index);
      assert.equal(current.page, index);
      assert.equal(current.pageCount, expected.length);
      assert.deepEqual(current.pages.find(page => page.index === index), { index, start, end });
    }
  }
});

test('visiting every active page exposes every card exactly once, including the final card', () => {
  for (const total of [1, 6, 7, 12, 13, 35, 13_000, 13_217]) {
    const cards = Array.from({ length: total }, (_, index) => `card-${index}`);
    const visited = [];
    const { pageCount } = previewWindow(total);
    for (let index = 0; index < pageCount; index++) {
      const window = previewWindow(total, index);
      const active = window.pages.filter(page => page.index === window.page);
      assert.equal(active.length, 1, `one active page at ${index}/${pageCount}`);
      visited.push(...cards.slice(active[0].start, active[0].end));
    }
    assert.deepEqual(visited, cards, `${total} cards remain in order without gaps or repeats`);
    assert.equal(new Set(visited).size, total);
  }
});

test('even large decks render only the active page and its immediate neighbors', () => {
  for (const total of [0, 1, 6, 7, 12, 13, 35, 13_217]) {
    const { pageCount } = previewWindow(total);
    for (let index = 0; index < Math.max(1, pageCount); index++) {
      const { pages } = previewWindow(total, index);
      assert.ok(pages.length <= 3);
      assert.ok(pages.reduce((count, page) => count + page.end - page.start, 0) <= 18);
      const expectedNeighbors = [index - 1, index, index + 1]
        .filter(page => page >= 0 && page < pageCount);
      assert.deepEqual(pages.map(page => page.index), expectedNeighbors);
      for (const page of pages) {
        assert.ok(Number.isInteger(page.start) && Number.isInteger(page.end));
        assert.ok(page.start >= 0 && page.end <= total);
        assert.ok(page.end > page.start && page.end - page.start <= 6);
      }
    }
  }
});

test('requests clamp to first and last pages and truncate fractional page numbers', () => {
  const first = previewWindow(35, 0);
  const last = previewWindow(35, 5);
  for (const request of [-Infinity, -100, -1, -0.9, 0.9, NaN]) {
    assert.deepEqual(previewWindow(35, request), first);
  }
  for (const request of [5.1, 5.9, 6, 100, Infinity]) {
    assert.deepEqual(previewWindow(35, request), last);
  }
  assert.deepEqual(previewWindow(35, 1.9), previewWindow(35, 1));
  assert.deepEqual(previewWindow(35, 4.99), previewWindow(35, 4));
  assert.deepEqual(previewWindow(6, 100), previewWindow(6, -100));
});
