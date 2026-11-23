import test from 'node:test';
import assert from 'node:assert/strict';
import { saveWeek, getCarryOver, mergeCarryOver, memoryStorage, courseKey, lectureLabel, loadCourses, STORE_KEY } from '../js/lib/weeks.js';
import { parseSlides } from '../js/lib/parse.js';
import { DEMO_SLIDES_TEXT } from '../js/data/demo-lecture.js';

const slides = parseSlides(DEMO_SLIDES_TEXT);

test('course keys ignore spaces, case and brackets', () => {
  assert.equal(courseKey('공학수치해석 (예시)'), courseKey('공학 수치해석 예시'));
  assert.equal(courseKey('Fluid Mechanics'), courseKey('fluidmechanics'));
});

test('lecture label picks the chapter', () => {
  assert.equal(lectureLabel(slides), '3장');
});

test('week 3 stops at slide 8 → week 4 notice says "8쪽에서 멈춤 → 9쪽부터"', () => {
  const st = memoryStorage();
  saveWeek(st, { course: '공학수치해석', week: 3, progress: 8, slides });
  const c = getCarryOver(st, '공학 수치해석', 4);
  assert.equal(c.fromWeek, 3);
  assert.equal(c.stoppedLabel, '8');
  assert.equal(c.nextLabel, '9');
  assert.equal(c.message, '지난주(3주차) 3장 8쪽에서 멈춤 → 이번 주는 9쪽부터');
  assert.deepEqual(c.uncovered.map((u) => u.label), ['9', '10', '11', '12']);
  assert.match(c.uncovered[0].text, /2차 수렴/);
});

test('no notice for the same or an earlier week, or another course', () => {
  const st = memoryStorage();
  saveWeek(st, { course: '공학수치해석', week: 3, progress: 8, slides });
  assert.equal(getCarryOver(st, '공학수치해석', 3), null);
  assert.equal(getCarryOver(st, '공학수치해석', 2), null);
  assert.equal(getCarryOver(st, '열역학', 4), null);
});

test('most recent earlier week is used', () => {
  const st = memoryStorage();
  saveWeek(st, { course: 'A', week: 2, progress: 3, slides });
  saveWeek(st, { course: 'A', week: 3, progress: 10, slides });
  assert.equal(getCarryOver(st, 'A', 5).stoppedLabel, '10');
});

test('finished deck → no "부터" page', () => {
  const st = memoryStorage();
  saveWeek(st, { course: 'A', week: 1, progress: 12, slides });
  const c = getCarryOver(st, 'A', 2);
  assert.equal(c.nextLabel, null);
  assert.match(c.message, /끝까지/);
});

test('merge puts last week’s uncovered slides first and renumbers', () => {
  const st = memoryStorage();
  saveWeek(st, { course: 'A', week: 3, progress: 8, slides });
  const c = getCarryOver(st, 'A', 4);
  const thisWeek = parseSlides('--- 1 ---\n4장 연립방정식\n--- 2 ---\n가우스 소거법');
  const merged = mergeCarryOver(c, thisWeek);
  assert.equal(merged.length, 6);
  assert.deepEqual(merged.map((s) => s.index), [1, 2, 3, 4, 5, 6]);
  assert.equal(merged[0].label, '9');
  assert.equal(merged[0].carriedFrom, 3);
  assert.equal(merged[4].title, '4장 연립방정식');
});

test('corrupted storage does not throw', () => {
  const st = memoryStorage();
  st.setItem(STORE_KEY, '{not json');
  assert.deepEqual(loadCourses(st), {});
  assert.equal(getCarryOver(st, 'A', 2), null);
});
