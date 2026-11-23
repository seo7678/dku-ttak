import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlides, slidesFromPages, parseTranscript, chunkTranscript, detectTranscriptFormat, parseTimestamp } from '../js/lib/parse.js';
import { DEMO_SLIDES_TEXT, DEMO_TRANSCRIPT } from '../js/data/demo-lecture.js';

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

test('timestamps', () => {
  assert.equal(parseTimestamp('01:02'), 62);
  assert.equal(parseTimestamp('1:00:05'), 3605);
  assert.equal(parseTimestamp('00:00:01,500'), 1.5);
  assert.equal(parseTimestamp('nope'), null);
});

test('Clova-style speaker transcript', () => {
  const tr = parseTranscript(DEMO_TRANSCRIPT);
  assert.equal(tr.format, 'speaker');
  assert.equal(tr.segments.length, 9);
  assert.equal(tr.segments[1].time, 190);
  assert.equal(tr.segments[0].speaker, '참석자 1');
});

test('SRT transcript merges short cues and strips indices/markup', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\n오늘은 이분법을\n\n2\n00:00:03,000 --> 00:00:05,000\n배워 보겠습니다.\n\n3\n00:00:06,000 --> 00:00:09,000\n<i>중간값 정리</i>가 핵심입니다.\n';
  assert.equal(detectTranscriptFormat(srt), 'srt');
  const tr = parseTranscript(srt, 'lecture.srt');
  assert.equal(tr.segments[0].text, '오늘은 이분법을 배워 보겠습니다.');
  assert.equal(tr.segments[0].time, 1);
  assert.ok(tr.segments.some((s) => s.text === '중간값 정리가 핵심입니다.'));
});

test('VTT transcript with voice tags', () => {
  const vtt = 'WEBVTT\n\nNOTE 테스트\n\n00:00.000 --> 00:02.000\n<v 교수>뉴턴법은 접선을 씁니다.\n\n00:02.500 --> 00:04.000\n<v 교수>분모는 도함수예요.\n';
  const tr = parseTranscript(vtt);
  assert.equal(tr.format, 'vtt');
  assert.equal(tr.segments.length, 2);
  assert.equal(tr.segments[0].speaker, '교수');
  assert.equal(tr.segments[1].text, '분모는 도함수예요.');
});

test('inline-timestamp and plain transcripts', () => {
  const ts = parseTranscript('[00:10] 첫 문장입니다.\n[01:20] 두 번째 문장입니다.');
  assert.equal(ts.format, 'timestamped');
  assert.equal(ts.segments[1].time, 80);
  const pl = parseTranscript('문단 하나.\n이어지는 줄.\n\n문단 둘.');
  assert.equal(pl.format, 'plain');
  assert.equal(pl.segments.length, 2);
});

test('chunks get stable T-ids and keep short asides separate from long blocks', () => {
  const chunks = chunkTranscript(parseTranscript(DEMO_TRANSCRIPT).segments);
  assert.equal(chunks.length, 9);
  assert.equal(chunks[0].id, 'T01');
  assert.equal(chunks[6].id, 'T07');
  assert.match(chunks[6].text, /가위치법/);
  // decimals are not split into separate sentences
  assert.ok(chunks[5].sentences.some((s) => s.includes('1.5214')));
});

test('a very long single segment is split under the max chunk size', () => {
  const long = Array.from({ length: 40 }, (_, i) => `이것은 ${i}번째 문장으로 꽤 길게 이어지는 설명입니다.`).join(' ');
  const chunks = chunkTranscript([{ time: 0, text: long }]);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.text.length <= 420));
});
