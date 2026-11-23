import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnchor, parseNotes, resolvePage, noteBlocks } from '../js/lib/notes.js';
import { parseSlides } from '../js/lib/parse.js';
import { DEMO_SLIDES_TEXT, DEMO_NOTES } from '../js/data/demo-lecture.js';

const slides = parseSlides(DEMO_SLIDES_TEXT);

test('anchor marker forms: p.12, p12, P. 12, 12쪽, 12p, [12], [p.12], #12, 슬라이드 12, --- 12 ---', () => {
  const cases = {
    'p.12': 12,
    p12: 12,
    'P. 12': 12,
    '12쪽': 12,
    '12p': 12,
    '12 p': 12,
    '[12]': 12,
    '[p.12]': 12,
    '[12쪽]': 12,
    '#12': 12,
    '슬라이드 12': 12,
    '페이지 12': 12,
    '--- 12 ---': 12,
    '## p.12': 12,
    '- 12쪽': 12,
  };
  for (const [line, page] of Object.entries(cases)) {
    const a = parseAnchor(line);
    assert.ok(a, line);
    assert.equal(a.page, page, line);
    assert.equal(a.rest, '', line);
  }
});

test('anchor with text on the same line keeps the text', () => {
  assert.deepEqual(parseAnchor('p.7 가위치법 → 교재로 보기'), { page: 7, rest: '가위치법 → 교재로 보기', prev: false });
  assert.equal(parseAnchor('12쪽: 그래프 확인').rest, '그래프 확인');
  assert.equal(parseAnchor('[3] 중간값 정리').rest, '중간값 정리');
  assert.equal(parseAnchor('#5 - 종료 조건').rest, '종료 조건');
  assert.equal(parseAnchor('p.3~5 구간법 정리').page, 3);
  assert.equal(parseAnchor('p.3~5 구간법 정리').rest, '구간법 정리');
  assert.equal(parseAnchor('지난주 p.9').prev, true);
});

test('ordinary note lines are not anchors', () => {
  for (const line of ['1. 중간값 정리', '3장 비선형 방정식', '12쪽까지 했음', 'pivot 행 교환', '# 오늘 정리', '2페이지에 그래프', 'p값이 작다', 'n = log2(10)', '12px 여백']) {
    assert.equal(parseAnchor(line), null, line);
  }
});

test('parseNotes: anchors apply to following lines; separators and double blank lines end them', () => {
  const r = parseNotes('머리말 줄\np.2\n가\n\n나\n---\n다\np.3 라\n\n\n마', slides);
  const by = Object.fromEntries(r.items.map((x) => [x.text, x]));
  assert.equal(by['머리말 줄'].page, null);
  assert.equal(by['가'].page, 2);
  assert.equal(by['나'].page, 2); // one blank line keeps the anchor
  assert.equal(by['다'].page, null); // after ---
  assert.equal(by['라'].page, 3);
  assert.equal(by['마'].page, null); // two blank lines end it
  assert.equal(r.anchors, 2);
});

test('note ids are stable n1…nK in line order and skip anchor-only lines', () => {
  const a = parseNotes(DEMO_NOTES, slides);
  const b = parseNotes(DEMO_NOTES, slides);
  assert.deepEqual(a.items.map((x) => x.id), b.items.map((x) => x.id));
  assert.equal(a.items[0].id, 'n1');
  assert.ok(a.items.every((x, i) => x.id === 'n' + (i + 1)));
  assert.ok(!a.items.some((x) => /^p\.\d+$/.test(x.text)));
  assert.equal(a.items.find((x) => x.page === 7).text, '가위치법 → 교재로 보기 (넘어감)');
});

test('anchors beyond the deck become unanchored with a warning', () => {
  const r = parseNotes('p.30\n없는 쪽 메모', slides);
  assert.equal(r.items[0].page, null);
  assert.match(r.warnings[0], /30쪽/);
});

test('preview lines are flagged and left out of alignment blocks', () => {
  const r = parseNotes('p.8\n뉴턴법\n다음 시간: 수렴 조건', slides);
  assert.equal(r.items[1].preview, true);
  const blocks = noteBlocks(r.items);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].items.map((x) => x.id), ['n1']);
});

test('resolvePage: labels first, carried pages only when hinted', () => {
  const merged = [
    { index: 1, label: '3', carriedFrom: 3 },
    { index: 2, label: '1' },
    { index: 3, label: '2' },
    { index: 4, label: '3' },
  ];
  assert.equal(resolvePage(1, merged), 2);
  assert.equal(resolvePage(3, merged), 4);
  assert.equal(resolvePage(3, merged, true), 1);
  assert.equal(resolvePage(9, merged), null);
  assert.equal(resolvePage(9, null), 9);
});
