import test from 'node:test';
import assert from 'node:assert/strict';
import { emphasisCues, isPreviewSentence, detectEmphasis } from '../js/lib/emphasis.js';

test('cue detection', () => {
  assert.deepEqual(emphasisCues('이거 시험에 나옵니다.'), ['출제']);
  assert.ok(emphasisCues('이건 중요합니다').includes('중요'));
  assert.ok(emphasisCues('꼭 외워 두세요').includes('꼭'));
  assert.ok(emphasisCues('꼭 외워 두세요').includes('암기'));
  assert.ok(emphasisCues('다시 한 번 말하지만').includes('반복'));
  assert.ok(emphasisCues('여기가 포인트예요').includes('포인트'));
  assert.ok(emphasisCues('많이들 헷갈려요').includes('주의'));
  assert.ok(emphasisCues('시험 범위는 3장까지').includes('시험'));
});

test('no false positives on ordinary words', () => {
  assert.deepEqual(emphasisCues('삼각형의 꼭짓점을 잇습니다.'), []);
  assert.deepEqual(emphasisCues('앞으로 나와서 풀어 볼래요?'), []);
  assert.deepEqual(emphasisCues('구간을 반으로 자릅니다.'), []);
});

test('preview sentences', () => {
  assert.ok(isPreviewSentence('뉴턴법 수렴 조건은 다음 시간에 하겠습니다.'));
  assert.ok(isPreviewSentence('이건 다음 주에 볼게요'));
  assert.ok(!isPreviewSentence('다음 값을 구합니다.'));
});

test('preview sentences are not reported as emphasis', () => {
  const r = detectEmphasis([{ id: 'T01', time: 0, sentences: ['이거 중요한데 다음 시간에 할게요.', '이거 중요합니다.'] }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sentenceIndex, 1);
});
