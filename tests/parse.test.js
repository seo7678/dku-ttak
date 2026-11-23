import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlides, slidesFromPages } from '../js/lib/parse.js';
import { DEMO_SLIDES_TEXT } from '../js/data/demo-lecture.js';

test('demo slides split into 12 pages with titles', () => {
  const s = parseSlides(DEMO_SLIDES_TEXT);
  assert.equal(s.length, 12);
  assert.equal(s[0].title, '3장 비선형 방정식의 근');
  assert.equal(s[7].title, '뉴턴-랩슨법(Newton-Raphson)');
  assert.deepEqual(s.map((x) => x.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('slide separators: [n], 슬라이드 n, ===, form feed, blank-line fallback', () => {
  assert.equal(parseSlides('[1]\n가\n[2]\n나\n[3]\n다').length, 3);
  assert.equal(parseSlides('슬라이드 1\n가나\n슬라이드 2\n다라').length, 2);
  assert.equal(parseSlides('===\n하나\n===\n둘').length, 2);
  assert.equal(parseSlides('첫 쪽\f둘째 쪽').length, 2);
  assert.equal(parseSlides('첫 쪽 내용\n\n\n둘째 쪽 내용\n\n\n셋째').length, 3);
  assert.equal(parseSlides('   ').length, 0);
});

test('titles keep chapter numbers but drop bullets', () => {
  const s = parseSlides('--- 1 ---\n• 개요\n--- 2 ---\n3장 오차\n--- 3 ---\n1. 이분법');
  assert.deepEqual(s.map((x) => x.title), ['개요', '3장 오차', '이분법']);
});

test('pdf pages keep true page numbers, including empty pages', () => {
  const s = slidesFromPages(['표지', '', '내용']);
  assert.equal(s.length, 3);
  assert.equal(s[1].title, '(빈 쪽)');
  assert.equal(s[2].label, '3');
});
