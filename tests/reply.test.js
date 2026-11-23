import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parseReply, ReplyError, normalizeSource, refKey } from '../js/lib/reply.js';
import { verifyGuide, noteOrigin } from '../js/lib/verify.js';
import { analyzeLecture } from '../js/lib/pipeline.js';
import { DEMO_SLIDES_TEXT, DEMO_NOTES } from '../js/data/demo-lecture.js';

const A = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, notesText: DEMO_NOTES });
const ctx = (extra = {}) => ({ slides: A.slides, notes: A.notes.items, progress: 8, coverage: A.coverage, ...extra });

const GOOD = {
  slides: [
    {
      slide: 3,
      title: '구간법의 원리',
      summary: [{ text: 'f(x_l)·f(x_u) < 0 이면 구간 안에 근이 있다', source: '교안', refs: ['P3'] }],
      notes: [{ text: '그래프를 먼저 그려 보기', source: '필기', refs: ['n9'] }],
      emphasis: [{ text: '중간값 정리', quote: '★중요', refs: ['n8'] }],
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
  assert.equal(g.slides[0].notes[0].source, 'note');
  assert.deepEqual(g.slides[0].notes[0].refs, ['n9']);
  assert.equal(g.questions[0].type, '예측');
});

test('unfenced JSON buried in text, smart quotes, plain-string statements', () => {
  const raw = '다음은 결과입니다: {“slides”: [{“slide”: “8쪽”, “summary”: [“반복식 x_{i+1} = x_i − f/f′”], “notes”: [“접선을 따라간다고 적어 둠”]}]} 끝.';
  const g = parseReply(raw);
  assert.equal(g.slides[0].slide, 8);
  assert.equal(g.slides[0].summary[0].text, '반복식 x_{i+1} = x_i − f/f′');
  assert.equal(g.slides[0].notes[0].source, 'note');
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

test('source normalization and ref keys (typed notes, my ink, 교수님 판서)', () => {
  assert.equal(normalizeSource('필기'), 'note');
  assert.equal(normalizeSource('내 필기'), 'note');
  assert.equal(normalizeSource('판서'), 'note');
  assert.equal(normalizeSource('AI 보충'), 'ai');
  assert.equal(normalizeSource('교안'), 'slide');
  assert.equal(normalizeSource('', ['n3']), 'note');
  assert.equal(normalizeSource('', ['ink-p3']), 'note');
  assert.equal(refKey('N03'), 'n3');
  assert.equal(refKey('[n12]'), 'n12');
  assert.equal(refKey('p12'), 'P12');
  assert.equal(refKey('ink-p05'), 'ink-p5');
  assert.equal(refKey('ink5'), 'ink-p5');
  assert.equal(refKey('PAN-P7'), 'pan-p7');
  assert.equal(refKey('T03'), null);
  assert.equal(noteOrigin('n3'), 'typed');
  assert.equal(noteOrigin('ink-p3'), 'ink');
  assert.equal(noteOrigin('pan-p3'), 'pan');
});

test('verify: slides beyond the 진도선 are dropped, a bad 필기 citation is downgraded, preview is titles only', () => {
  const g = parseReply(
    JSON.stringify({
      slides: [
        { slide: 8, summary: [{ text: '반복식 x_{i+1} = x_i − f(x_i)/f′(x_i)', source: '교안' }], notes: [{ text: 'MATLAB 코드도 따라 쳐 봄', source: '필기', refs: ['n99'] }] },
        { slide: 9, summary: [{ text: '2차 수렴', source: '교안' }] },
      ],
      recall_questions: [{ slide: 9, question: '수렴 차수?', answer: '2차' }, { slide: 8, question: '분모?', answer: "f'" }],
    }),
  );
  const v = verifyGuide(g, ctx());
  assert.ok(!v.slides.some((s) => s.slide === 9));
  assert.deepEqual(v.stats.droppedSlides, [9]);
  const s8 = v.slides.find((s) => s.slide === 8);
  assert.equal(s8.notes[0].source, 'ai');
  assert.equal(s8.notes[0].check, 'downgraded');
  assert.deepEqual(s8.notes[0].refs, []);
  assert.equal(v.stats.downgraded, 1);
  assert.equal(v.stats.unknownRefs, 1);
  assert.ok(v.warnings.some((w) => /AI 보충으로 바꿔/.test(w)));
  assert.equal(v.questions.length, 1);
  assert.deepEqual(v.nextPreview.map((p) => p.slide), [9, 10, 11, 12]);
  assert.ok(v.nextPreview.every((p) => Object.keys(p).join() === 'slide,title'));
  // slides 1–7 that the AI skipped still get (empty) cards
  assert.equal(v.slides.length, 8);
  assert.ok(v.slides.find((s) => s.slide === 1).missing);
  // evidence comes from the deterministic placement of the typed notes
  assert.deepEqual(s8.evidence.map((e) => e.id), ['n22', 'n23', 'n24', 'n25']);
  assert.ok(s8.evidence.every((e) => e.origin === 'typed'));
  assert.ok(v.warnings.some((w) => /9쪽/.test(w)));
});

test('verify: an ink citation counts only when that ink page was actually given, with the right kind', () => {
  const g = () => parseReply(JSON.stringify({ slides: [{ slide: 3, notes: [{ text: '그래프에 별 표시', source: '필기', refs: ['ink-p3'] }, { text: '구간 반으로 화살표', source: '판서', refs: ['pan-p3'] }] }] }));
  // no ink given → both downgraded
  let v = verifyGuide(g(), ctx());
  let s3 = v.slides.find((s) => s.slide === 3);
  assert.deepEqual(s3.notes.map((x) => x.source), ['ai', 'ai']);
  assert.equal(v.stats.downgraded, 2);
  // my annotated deck given → ink-p3 holds, pan-p3 does not
  v = verifyGuide(g(), ctx({ ink: { kind: 'mine', pages: [1, 2, 3] } }));
  s3 = v.slides.find((s) => s.slide === 3);
  assert.deepEqual(s3.notes.map((x) => x.source), ['note', 'ai']);
  assert.ok(s3.evidence.some((e) => e.id === 'ink-p3' && e.origin === 'ink'));
  // professor's 판서본 given → pan-p3 holds
  v = verifyGuide(g(), ctx({ ink: { kind: 'pan', pages: [3] } }));
  s3 = v.slides.find((s) => s.slide === 3);
  assert.deepEqual(s3.notes.map((x) => x.source), ['ai', 'note']);
  assert.ok(s3.evidence.some((e) => e.id === 'pan-p3' && e.origin === 'pan'));
});

test('verify: a "필기" statement without refs is rescued by a matching note line', () => {
  const g = parseReply(JSON.stringify({ slides: [{ slide: 5, notes: [{ text: '반복 횟수 n = log2(Δx0 / Ea,d), 시험 나옴', source: '필기' }] }] }));
  const v = verifyGuide(g, ctx());
  const st = v.slides.find((s) => s.slide === 5).notes[0];
  assert.equal(st.source, 'note');
  assert.deepEqual(st.refs, ['n16']);
  assert.equal(v.stats.downgraded, 0);
});
