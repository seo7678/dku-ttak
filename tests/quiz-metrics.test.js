import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuiz, current, reveal, grade, summary, canReveal, continueRetry, finish } from '../js/lib/quiz.js';
import { emptyRun, mark, runSummary, formatDuration, loadRun, saveRun } from '../js/lib/metrics.js';
import { memoryStorage } from '../js/lib/weeks.js';

const QS = [
  { slide: 3, type: '개념', question: 'q1', answer: 'a1' },
  { slide: 4, type: '예측', question: 'q2', answer: 'a2' },
  { slide: 5, type: '계산', question: 'q3', answer: 'a3' },
];

test('answer must be typed before the answer can be revealed', () => {
  let s = createQuiz(QS);
  assert.equal(canReveal('  '), false);
  s = reveal(s, '');
  assert.equal(s.revealed, false);
  s = grade(s, 'o'); // grading before reveal is ignored
  assert.equal(s.pos, 0);
  s = reveal(s, '중간값 정리');
  assert.equal(s.revealed, true);
  assert.equal(s.answers[0], '중간값 정리');
});

test('✕/△ come back in a retry round; first-pass vs after-retry scores', () => {
  let s = createQuiz(QS);
  s = grade(reveal(s, 'x'), 'o');
  s = grade(reveal(s, 'x'), 't');
  s = grade(reveal(s, 'x'), 'x');
  assert.equal(s.round, 2);
  assert.equal(s.roundEnded, true);
  assert.deepEqual(s.queue, [1, 2]);
  s = continueRetry(s);
  assert.equal(current(s).question, 'q2');
  s = grade(reveal(s, 'y'), 'o');
  s = grade(reveal(s, 'y'), 't');
  assert.equal(s.round, 3);
  assert.deepEqual(s.queue, [2]);
  s = finish(s);
  assert.equal(s.done, true);
  const sum = summary(s);
  assert.equal(sum.first.percent, 50); // (1 + 0.5 + 0) / 3
  assert.equal(sum.after.percent, 83); // (1 + 1 + 0.5) / 3
  assert.deepEqual(sum.weak.map((w) => [w.first, w.last]), [['t', 'o'], ['x', 't']]);
  assert.equal(sum.first.x, 1);
});

test('all correct → done after the first round', () => {
  let s = createQuiz(QS.slice(0, 2));
  s = grade(reveal(s, 'a'), 'o');
  s = grade(reveal(s, 'a'), 'o');
  assert.equal(s.done, true);
  assert.equal(summary(s).after.percent, 100);
});

test('metrics: time from first input to 해설지 and quiz', () => {
  let r = emptyRun();
  r = mark(r, 'start', 1000);
  r = mark(r, 'start', 5000); // first start wins
  r = mark(r, 'guide', 1000 + 150000);
  r = mark(r, 'quizStart', 200000);
  r = mark(r, 'quizDone', 260000);
  const s = runSummary(r);
  assert.equal(s.toGuideMs, 150000);
  assert.equal(s.quizMs, 60000);
  assert.equal(formatDuration(s.toGuideMs), '2분 30초');
  assert.equal(formatDuration(42000), '42초');
  assert.equal(formatDuration(null), '—');
  const st = memoryStorage();
  saveRun(st, r);
  assert.equal(loadRun(st).guideAt, 151000);
});
