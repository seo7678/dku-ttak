import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLecture, mapInk } from '../js/lib/pipeline.js';
import { STATUS, STATUS_LABEL, mergeProgress, maxStatus } from '../js/lib/coverage.js';
import { DEMO_SLIDES_TEXT, DEMO_NOTES } from '../js/data/demo-lecture.js';

const demo = (notesText = DEMO_NOTES, ink = null) => analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, notesText, ink });

test('status labels are about notes, not lecture talk', () => {
  assert.deepEqual(STATUS_LABEL, { ink: '필기 있음', light: '필기 조금', none: '필기 없음' });
});

test('demo notes: 진도선 lands on slide 8', () => {
  const c = demo().coverage;
  assert.equal(c.progress, 8);
  assert.equal(c.textProgress, 8);
  assert.equal(c.inkProgress, 0);
});

test('demo notes: 1–6 & 8 필기 있음, 7 필기 조금, 9–12 필기 없음', () => {
  const st = demo().coverage.slides.map((s) => s.status);
  assert.deepEqual(st.slice(0, 6), Array(6).fill(STATUS.INK));
  assert.equal(st[6], STATUS.LIGHT);
  assert.equal(st[7], STATUS.INK);
  assert.deepEqual(st.slice(8), Array(4).fill(STATUS.NONE));
});

test('demo notes: unanchored lines are aligned to sensible slides and nothing is left unplaced', () => {
  const a = demo();
  const page = a.coverage.pageOfNote;
  const loose = a.notes.items.filter((x) => !x.anchored && !x.preview);
  assert.ok(loose.length >= 2);
  assert.equal(page[loose[0].id], 1); // "11/20(목) 수치해석 3주차 — 3장 비선형 방정식의 근"
  assert.ok(loose.every((x) => page[x.id] >= 1 && page[x.id] <= 8));
  assert.deepEqual(a.coverage.unplaced, []);
});

test('demo notes: the 「다음 시간」 line is a preview, does not move the line, and points past it', () => {
  const { previews, slides, progress } = demo().coverage;
  assert.equal(previews.length, 1);
  assert.match(previews[0].text, /^다음 시간/);
  assert.ok(previews[0].slideIndex > progress);
  assert.equal(slides[8].noteIds.length, 0);
});

test('a 「다음 시간」 line never moves the 진도선 — even anchored to the next page or unanchored and on-topic', () => {
  const anchored = DEMO_NOTES + '\np.9\n다음 시간: 뉴턴-랩슨법의 수렴, 2차 수렴, 유효숫자 두 배\n';
  assert.equal(demo(anchored).coverage.progress, 8);
  const loose = DEMO_NOTES + '\n---\n다음 시간에 할선법(Secant Method) 차분 근사, 초기값 두 개\n';
  assert.equal(demo(loose).coverage.progress, 8);
  // …whereas a real note on p.9 does move it
  assert.equal(demo(DEMO_NOTES + '\np.9\n2차 수렴: 유효숫자 자릿수가 반복마다 두 배\n').coverage.progress, 9);
});

test('demo notes: emphasis pins (★ / ! / 중요 / 시험 / 헷갈) on slides 3, 4, 5, 8', () => {
  const ems = demo().coverage.emphasis;
  assert.deepEqual([...new Set(ems.map((e) => e.slideIndex))], [3, 4, 5, 8]);
  const stars = ems.filter((e) => e.cues.includes('별표'));
  assert.ok(stars.length >= 2);
  assert.ok(ems.some((e) => e.cues.includes('시험') && e.slideIndex === 5));
  assert.ok(ems.some((e) => e.cues.includes('헷갈') && e.slideIndex === 4));
});

test('notes that stop early (anchored 1–4 only) put the 진도선 at 4', () => {
  const cut = DEMO_NOTES.slice(0, DEMO_NOTES.indexOf('p.5'));
  assert.equal(demo(cut).coverage.progress, 4);
});

test('unanchored notes only (no page numbers at all) still find 8 via alignment', () => {
  const plain = DEMO_NOTES.split('\n')
    .filter((l) => !/^p\.\d+\s*$/.test(l.trim()))
    .map((l) => l.replace(/^p\.\d+\s+/, ''))
    .join('\n');
  const a = demo(plain);
  assert.equal(a.notes.anchors, 0);
  assert.equal(a.coverage.progress, 8);
});

test('off-topic lines (date, 잡담) are left unplaced and do not move the line', () => {
  const noisy = '점심 학식 맛있었음 ㅋㅋ\n\n' + DEMO_NOTES + '\n---\n과대표 공지: 금요일 회식\n';
  const a = demo(noisy);
  assert.equal(a.coverage.progress, 8);
  assert.ok(a.coverage.unplaced.length >= 1);
});

test('no notes → nothing taught', () => {
  const r = demo('');
  assert.equal(r.coverage.progress, 0);
  assert.ok(r.coverage.slides.every((s) => s.status === STATUS.NONE));
});

test('progress suggestion merges ink + text: the later of the two wins', () => {
  assert.equal(mergeProgress(5, 8), 8);
  assert.equal(mergeProgress(9, 7), 9);
  assert.equal(mergeProgress(0, 0), 0);
  assert.equal(maxStatus('light', 'ink'), 'ink');
  assert.equal(maxStatus('none', 'light'), 'light');
  // ink on 1–8 (7 light), typed notes only up to p.4 → 8
  const ratios = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.0004, 0.01, 0, 0, 0, 0];
  const cut = DEMO_NOTES.slice(0, DEMO_NOTES.indexOf('p.5'));
  const a = demo(cut, { ratios, kind: 'pan' });
  assert.equal(a.coverage.textProgress, 4);
  assert.equal(a.coverage.inkProgress, 8);
  assert.equal(a.coverage.progress, 8);
  assert.equal(a.ink.kind, 'pan');
  // per-page status = the stronger of text and ink
  assert.equal(a.coverage.slides[6].status, STATUS.LIGHT);
  assert.equal(a.coverage.slides[5].status, STATUS.INK);
  // typed notes reach further than the ink → text wins
  const b = demo(DEMO_NOTES + '\np.10\n실패하는 경우: f′(x) ≈ 0 극값 근처에서 멀리 튐\n', { ratios: [0.01, 0.01, 0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  assert.equal(b.coverage.inkProgress, 3);
  assert.equal(b.coverage.progress, 10);
});

test('ink-only input (no typed notes) works; page-count mismatch compares only the overlap', () => {
  const a = demo('', { ratios: [0.01, 0.01, 0.01, 0.01, 0.01] }); // annotated deck has 5 pages, clean has 12
  assert.equal(a.ink.compared, 5);
  assert.equal(a.coverage.progress, 5);
  assert.equal(a.coverage.slides[11].inkStatus, STATUS.NONE);
});

test('mapInk puts this week’s ink after carried-over slides', () => {
  const slides = [{ index: 1, carriedFrom: 3 }, { index: 2, carriedFrom: 3 }, { index: 3 }, { index: 4 }];
  const m = mapInk(slides, { ratios: [0.01, 0] });
  assert.deepEqual(m.statuses, ['none', 'none', 'ink', 'none']);
  assert.equal(m.progress, 3);
});

test('week 4: last week’s 9–12쪽 merged in front; notes cover 9–11 then 4장 1–2', async () => {
  const D = await import('../js/data/demo-lecture.js');
  const { parseSlides } = await import('../js/lib/parse.js');
  const W = await import('../js/lib/weeks.js');
  const st = W.memoryStorage();
  W.saveWeek(st, { course: D.DEMO_COURSE, week: 3, progress: 8, slides: parseSlides(D.DEMO_SLIDES_TEXT) });
  const carry = W.getCarryOver(st, D.DEMO_COURSE, 4);
  const deck = W.mergeCarryOver(carry, parseSlides(D.DEMO_WEEK4_SLIDES_TEXT));
  const r = analyzeLecture({ slides: deck, notesText: D.DEMO_WEEK4_NOTES });
  assert.equal(r.coverage.progress, 6); // = this week's 2쪽 (전진 소거)
  assert.deepEqual(r.coverage.slides.map((s) => s.label), ['9', '10', '11', '12', '1', '2', '3', '4']);
  assert.deepEqual(r.coverage.slides.slice(0, 3).map((s) => s.status), [STATUS.INK, STATUS.INK, STATUS.INK]);
  assert.equal(r.coverage.slides[3].status, STATUS.NONE); // 12쪽 정리 — no notes, still inside the 진도선
  assert.deepEqual(r.notes.warnings, []);
  // "p.9" resolved by label to the carried slide (index 1), "p.1" to this week's 1쪽 (index 5)
  const first9 = r.notes.items.find((x) => x.written === 9);
  const first1 = r.notes.items.find((x) => x.written === 1);
  assert.equal(first9.page, 1);
  assert.equal(first1.page, 5);
});
