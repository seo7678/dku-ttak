import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parseReply, ReplyError, normalizeSource, refKey } from '../js/lib/reply.js';
import { verifyGuide } from '../js/lib/verify.js';
import { analyzeLecture } from '../js/lib/pipeline.js';
import { DEMO_SLIDES_TEXT, DEMO_TRANSCRIPT } from '../js/data/demo-lecture.js';

const GOOD = {
  slides: [
    {
      slide: 3,
      title: '구간법의 원리',
      summary: [{ text: 'f(x_l)·f(x_u) < 0 이면 구간 안에 근이 있다', source: '교안', refs: ['P3'] }],
      spoken: [{ text: '그래프를 먼저 그려 보라고 하셨다', refs: ['T03'] }],
      emphasis: [{ text: '중간값 정리', quote: '이거 중요합니다.', refs: ['T03'] }],
      pitfalls: [],
    },
  ],
  recall_questions: [{ slide: 3, type: '예측', question: '중근을 구간법으로 잡을 수 있을까?', answer: '못 잡는다' }],
};

// What ChatGPT/Gemini/Claude replies typically look like.
const DIRTY = `물론이죠! 요청하신 해설지를 JSON으로 만들었습니다.

\`\`\`json
${JSON.stringify(GOOD, null, 2).replace('"pitfalls": []', '"pitfalls": [],')}
\`\`\`

필요하면 문제를 더 만들어 드릴게요. 😊`;

test('fenced JSON with prose around it (and a trailing comma) parses', () => {
  const g = parseReply(DIRTY);
  assert.equal(g.slides.length, 1);
  assert.equal(g.slides[0].slide, 3);
  assert.equal(g.slides[0].summary[0].source, 'slide');
  assert.equal(g.slides[0].spoken[0].source, 'lecture');
  assert.equal(g.questions[0].type, '예측');
});

test('unfenced JSON buried in text, smart quotes, plain-string statements', () => {
  const raw = '다음은 결과입니다: {“slides”: [{“slide”: “8쪽”, “summary”: [“반복식 x_{i+1} = x_i − f/f′”], “spoken”: [“접선을 따라간다고 하셨다”]}]} 끝.';
  const g = parseReply(raw);
  assert.equal(g.slides[0].slide, 8);
  assert.equal(g.slides[0].summary[0].text, '반복식 x_{i+1} = x_i − f/f′');
  assert.equal(g.slides[0].spoken[0].source, 'lecture');
});

test('Korean keys are accepted', () => {
  const g = parseReply(JSON.stringify({ 슬라이드: [{ 쪽: 2, 제목: '왜', 핵심정리: [{ 내용: '해석해 없음', 출처: '교안' }] }], 회상문제: [{ 질문: 'q', 정답: 'a', 유형: '계산' }] }));
  assert.equal(g.slides[0].title, '왜');
  assert.equal(g.slides[0].summary[0].source, 'slide');
  assert.equal(g.questions[0].type, '계산');
});

test('ai_추정 flag forces AI source', () => {
  const g = parseReply(JSON.stringify({ slides: [{ slide: 1, summary: [{ text: 'x', source: '교안', ai_추정: true }] }] }));
  assert.equal(g.slides[0].summary[0].source, 'ai');
});

test('largest guide-like object wins over small objects in prose', () => {
  const raw = '예시 {"a":1} 그리고 실제: ' + JSON.stringify(GOOD);
  assert.equal(parseReply(raw).slides.length, 1);
});

test('friendly errors: empty, no JSON, truncated, wrong shape', () => {
  assert.throws(() => extractJson(''), (e) => e instanceof ReplyError && /비어/.test(e.message));
  assert.throws(() => extractJson('죄송하지만 도와드릴 수 없어요.'), (e) => e instanceof ReplyError && /찾지 못/.test(e.message));
  assert.throws(() => extractJson('```json\n{"slides": [{"slide": 1, "summary": ['), (e) => e instanceof ReplyError && /끊긴/.test(e.message));
  assert.throws(() => parseReply('{"foo": 1}'), (e) => e instanceof ReplyError && /slides/.test(e.message));
});

test('source normalization and ref keys', () => {
  assert.equal(normalizeSource('수업 녹음'), 'lecture');
  assert.equal(normalizeSource('AI 보충'), 'ai');
  assert.equal(normalizeSource('', ['T3']), 'lecture');
  assert.equal(refKey('T03'), 'T3');
  assert.equal(refKey('p12'), 'P12');
});

test('verify: slides beyond the 진도선 are dropped, ungrounded "수업" is downgraded, preview is titles only', () => {
  const a = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: DEMO_TRANSCRIPT });
  const g = parseReply(
    JSON.stringify({
      slides: [
        { slide: 8, summary: [{ text: '반복식 x_{i+1} = x_i − f(x_i)/f′(x_i)', source: '교안' }], spoken: [{ text: '교수님이 MATLAB 코드도 보여 주셨다', refs: ['T99'] }] },
        { slide: 9, summary: [{ text: '2차 수렴', source: '교안' }] },
      ],
      recall_questions: [{ slide: 9, question: '수렴 차수?', answer: '2차' }, { slide: 8, question: '분모?', answer: "f'" }],
    }),
  );
  const v = verifyGuide(g, { slides: a.slides, chunks: a.chunks, progress: 8, coverage: a.coverage });
  assert.ok(!v.slides.some((s) => s.slide === 9));
  assert.deepEqual(v.stats.droppedSlides, [9]);
  const s8 = v.slides.find((s) => s.slide === 8);
  assert.equal(s8.spoken[0].source, 'ai');
  assert.equal(s8.spoken[0].check, 'downgraded');
  assert.equal(v.questions.length, 1);
  assert.deepEqual(v.nextPreview.map((p) => p.slide), [9, 10, 11, 12]);
  assert.ok(v.nextPreview.every((p) => Object.keys(p).join() === 'slide,title'));
  // slides 1–7 that the AI skipped still get (empty) cards
  assert.equal(v.slides.length, 8);
  assert.ok(v.slides.find((s) => s.slide === 1).missing);
  // evidence comes from the deterministic alignment
  assert.deepEqual(s8.evidence.map((e) => e.id), ['T08', 'T09']);
  assert.ok(v.warnings.some((w) => /9쪽/.test(w)));
});

test('verify: a "수업" statement without refs is rescued by a matching quote', () => {
  const a = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: DEMO_TRANSCRIPT });
  const g = parseReply(JSON.stringify({ slides: [{ slide: 5, spoken: [{ text: '로그 2 들어가는 반복 횟수 공식, 이거 시험에 나옵니다' }] }] }));
  const v = verifyGuide(g, { slides: a.slides, chunks: a.chunks, progress: 8, coverage: a.coverage });
  const st = v.slides.find((s) => s.slide === 5).spoken[0];
  assert.equal(st.source, 'lecture');
  assert.deepEqual(st.refs, ['T5']);
});
