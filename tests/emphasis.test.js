import test from 'node:test';
import assert from 'node:assert/strict';
import { emphasisCues, isPreviewLine, detectEmphasis, cueLabel } from '../js/lib/emphasis.js';

test('emphasis marks in notes: ★ ☆ * ! 중요 시험 외워 헷갈 기출', () => {
  assert.deepEqual(emphasisCues('★ 중간값 정리'), ['별표']);
  assert.deepEqual(emphasisCues('☆ 종료 조건'), ['별표']);
  assert.deepEqual(emphasisCues('**수렴 순서**'), ['별표']);
  assert.deepEqual(emphasisCues('*이분법 반복 횟수'), ['별표']);
  assert.deepEqual(emphasisCues('분모가 도함수!!'), ['느낌표']);
  assert.deepEqual(emphasisCues('부호 바뀌는 구간 !'), ['느낌표']);
  assert.deepEqual(emphasisCues('이건 중요'), ['중요']);
  assert.deepEqual(emphasisCues('시험 범위 3장까지'), ['시험']);
  assert.deepEqual(emphasisCues('출제 예상'), ['시험']);
  assert.deepEqual(emphasisCues('작년 기출'), ['기출']);
  assert.deepEqual(emphasisCues('공식 외워 두기'), ['암기']);
  assert.deepEqual(emphasisCues('암기'), ['암기']);
  assert.deepEqual(emphasisCues('절대오차/상대오차 헷갈림'), ['헷갈']);
  assert.deepEqual(emphasisCues('★시험 나옴! 외우기'), ['별표', '느낌표', '시험', '암기']);
});

test('no false positives: bullets, products, factorial, !=, ordinary words', () => {
  for (const line of ['* 항목 하나', 'a * b 곱', 'n! 계승', 'x != 0', '삼각형의 꼭짓점', '구간을 반으로 자름', '- 오차 정의', 'f(a)·f(b) < 0']) {
    assert.deepEqual(emphasisCues(line), [], line);
  }
});

test('preview lines', () => {
  assert.ok(isPreviewLine('다음 시간: 뉴턴법 수렴 조건'));
  assert.ok(isPreviewLine('다음 주에 할선법'));
  assert.ok(isPreviewLine('나머지는 다음에 하기로'));
  assert.ok(!isPreviewLine('다음 값을 구한다'));
  assert.ok(!isPreviewLine('다음과 같이 정의'));
});

test('preview lines are never reported as emphasis', () => {
  const r = detectEmphasis([
    { id: 'n1', text: '★ 다음 시간 시험 범위 공지', preview: true },
    { id: 'n2', text: '★ 중간값 정리', preview: false },
    { id: 'n3', text: '그냥 메모', preview: false },
  ]);
  assert.deepEqual(r, [{ noteId: 'n2', text: '★ 중간값 정리', cues: ['별표'] }]);
  assert.equal(cueLabel('헷갈'), '헷갈림 주의');
});
