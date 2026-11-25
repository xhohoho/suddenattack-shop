import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlides, slideWrites, MAX_SLIDES } from '../server/lib/slides.js';

test('old sheet (nothing in F2) falls back to B2:C2', () => {
  assert.deepEqual(parseSlides(['a', 'b', 'ticker']), ['a', 'b']);
  assert.deepEqual(parseSlides(['a']), ['a']);
  assert.deepEqual(parseSlides([]), []);
  assert.deepEqual(parseSlides(undefined), []);
});

test('F2 JSON list wins and can hold more than two slides', () => {
  const row = ['a', 'b', 'ticker', '', JSON.stringify(['a', 'b', 'c', 'd'])];
  assert.deepEqual(parseSlides(row), ['a', 'b', 'c', 'd']);
});

test('broken JSON falls back to B2:C2 instead of throwing', () => {
  assert.deepEqual(parseSlides(['a', 'b', '', '', '[oops']), ['a', 'b']);
});

test('list is capped at MAX_SLIDES and trailing blanks are dropped', () => {
  const many = Array.from({ length: MAX_SLIDES + 5 }, (_, i) => 'u' + i);
  assert.equal(parseSlides(['', '', '', '', JSON.stringify(many)]).length, MAX_SLIDES);
  assert.deepEqual(parseSlides(['', '', '', '', JSON.stringify(['a', '', ''])]), ['a']);
});

test('writes: JSON cell holds everything, B2:C2 mirror the first two', () => {
  const [legacy, json] = slideWrites(['a', 'b', 'c']);
  assert.deepEqual(legacy, { range: 'Settings!B2:C2', values: [['a', 'b']] });
  assert.equal(json.range, 'Settings!F2');
  assert.deepEqual(JSON.parse(json.values[0][0]), ['a', 'b', 'c']);
});

test('writes: empty list clears both places; a hole in the middle is kept', () => {
  const [l1, j1] = slideWrites([]);
  assert.deepEqual(l1.values, [['', '']]);
  assert.equal(j1.values[0][0], '[]');
  const [, j2] = slideWrites(['a', '', 'c']);
  assert.deepEqual(JSON.parse(j2.values[0][0]), ['a', '', 'c']);
});
