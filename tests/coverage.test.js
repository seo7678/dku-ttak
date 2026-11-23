import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLecture } from '../js/lib/pipeline.js';
import { STATUS } from '../js/lib/coverage.js';
import { DEMO_SLIDES_TEXT, DEMO_TRANSCRIPT } from '../js/data/demo-lecture.js';

const demo = () => analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: DEMO_TRANSCRIPT });

test('demo: 진도선 lands on slide 8', () => {
  assert.equal(demo().coverage.progress, 8);
});

test('demo: 1–6 & 8 다룸, 7 잠깐 언급, 9–12 안 다룸', () => {
  const st = demo().coverage.slides.map((s) => s.status);
  assert.deepEqual(st.slice(0, 6), Array(6).fill(STATUS.COVERED));
  assert.equal(st[6], STATUS.BRIEF);
  assert.equal(st[7], STATUS.COVERED);
  assert.deepEqual(st.slice(8), Array(4).fill(STATUS.NONE));
});

test('demo: transcript chunks map monotonically onto the right slides', () => {
  const tl = demo().coverage.timeline.map((t) => t.slideIndex);
  assert.deepEqual(tl, [1, 2, 3, 4, 5, 6, 7, 8, 8]);
});

test('demo: "다음 시간에" sentences are previews, not coverage, and point at slide 9', () => {
  const { previews, slides } = demo().coverage;
  assert.equal(previews.length, 2);
  assert.equal(previews[0].slideIndex, 9);
  assert.ok(previews.every((p) => p.slideIndex > 8));
  assert.equal(slides[8].chunkIds.length, 0);
});

test('demo: emphasis cues are pinned to slides 3, 4, 5, 8', () => {
  const ems = demo().coverage.emphasis;
  assert.deepEqual([...new Set(ems.map((e) => e.slideIndex))], [3, 4, 5, 8]);
  const exam = ems.find((e) => e.cues.includes('출제'));
  assert.equal(exam.slideIndex, 5);
  assert.match(exam.sentence, /시험에 나옵니다/);
});

test('off-topic chatter (출석, 잡담) does not move the 진도선', () => {
  const noisy =
    '참석자 1 00:00\n출석 부르겠습니다. 김민수, 이서연, 박지훈.\n\n' +
    DEMO_TRANSCRIPT.replace('참석자 1 47:40', '참석자 1 47:00\n오늘 점심 학식 메뉴가 좋다더라고요. 다들 맛있게 드세요.\n\n참석자 1 47:40');
  const r = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: noisy });
  assert.equal(r.coverage.progress, 8);
  assert.ok(r.coverage.timeline.some((t) => t.offTopic));
});

test('a class that stops early (slides 1–4) puts the 진도선 at 4', () => {
  const cut = DEMO_TRANSCRIPT.slice(0, DEMO_TRANSCRIPT.indexOf('참석자 1 19:05'));
  const r = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: cut });
  assert.equal(r.coverage.progress, 4);
});

test('the same lecture as SRT subtitles (one sentence per cue) still lands on slide 8', () => {
  const blocks = DEMO_TRANSCRIPT.split(/\n\s*\n/)
    .map((b) => b.split('\n').slice(1).join(' ').trim())
    .filter(Boolean);
  const f = (x) => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')},000`;
  let n = 0;
  let t = 0;
  const cues = [];
  for (const b of blocks) {
    for (const s of b.split(/(?<=[.?!])\s+/)) {
      cues.push(`${++n}\n${f(t)} --> ${f(t + 4)}\n${s}\n`);
      t += 5;
    }
  }
  const r = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: cues.join('\n'), transcriptName: 'x.srt' });
  assert.equal(r.transcriptFormat, 'srt');
  assert.equal(r.coverage.progress, 8);
});

test('empty transcript → nothing covered', () => {
  const r = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: '' });
  assert.equal(r.coverage.progress, 0);
  assert.ok(r.coverage.slides.every((s) => s.status === STATUS.NONE));
});

test('week 4: last week’s 9–12쪽 merged in front; class covers 9–11 then 4장 1–2', async () => {
  const D = await import('../js/data/demo-lecture.js');
  const { parseSlides } = await import('../js/lib/parse.js');
  const W = await import('../js/lib/weeks.js');
  const st = W.memoryStorage();
  W.saveWeek(st, { course: D.DEMO_COURSE, week: 3, progress: 8, slides: parseSlides(D.DEMO_SLIDES_TEXT) });
  const carry = W.getCarryOver(st, D.DEMO_COURSE, 4);
  const deck = W.mergeCarryOver(carry, parseSlides(D.DEMO_WEEK4_SLIDES_TEXT));
  const r = analyzeLecture({ slides: deck, transcriptText: D.DEMO_WEEK4_TRANSCRIPT });
  assert.equal(r.coverage.progress, 6); // = this week's 2쪽 (전진 소거)
  assert.deepEqual(r.coverage.slides.map((s) => s.label), ['9', '10', '11', '12', '1', '2', '3', '4']);
  assert.deepEqual(r.coverage.slides.slice(0, 3).map((s) => s.status), [STATUS.COVERED, STATUS.COVERED, STATUS.COVERED]);
  assert.equal(r.coverage.slides[3].status, STATUS.NONE); // 12쪽 정리 — skipped inside the 진도선
});
