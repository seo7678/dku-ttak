import test from 'node:test';
import assert from 'node:assert/strict';
import { guideToMarkdown, buildSurveyResult } from '../js/lib/export.js';
import { generateWithGemini, GeminiError } from '../js/lib/gemini.js';
import { buildPrompt } from '../js/lib/prompt.js';
import { analyzeLecture } from '../js/lib/pipeline.js';
import { DEMO_SLIDES_TEXT, DEMO_TRANSCRIPT } from '../js/data/demo-lecture.js';

const a = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: DEMO_TRANSCRIPT });

test('prompt contains only covered slides, aligned excerpts and emphasis, plus the schema', () => {
  const p = buildPrompt({ course: '공학수치해석', week: 3, slides: a.slides, chunks: a.chunks, coverage: a.coverage, progress: 8 });
  assert.match(p.text, /### P8/);
  assert.doesNotMatch(p.text, /### P9/);
  assert.doesNotMatch(p.text, /2차 수렴: E_/); // slide 9 body never sent
  assert.match(p.text, /T05 \(19:05\)/);
  assert.match(p.text, /\[출제\] "로그 2 들어가는 반복 횟수 공식, 이거 시험에 나옵니다\."/);
  assert.match(p.text, /"recall_questions"/);
  assert.match(p.text, /아직 안 배운 쪽 \(해설 금지, 참고만\): 9\. 뉴턴-랩슨법의 수렴/);
  assert.equal(p.coveredCount, 8);
});

test('moving the 진도선 changes what is sent', () => {
  const p = buildPrompt({ course: 'x', week: 1, slides: a.slides, chunks: a.chunks, coverage: a.coverage, progress: 4 });
  assert.doesNotMatch(p.text, /### P5/);
  assert.doesNotMatch(p.text, /T05/);
});

test('markdown export', () => {
  const md = guideToMarkdown({
    course: '공학수치해석',
    week: 3,
    progress: 8,
    total: 12,
    engine: '데모',
    createdAt: '2026-11-23T00:00:00Z',
    slides: [{ slide: 3, title: '구간법', coverage: 'covered', summary: [{ text: '중간값 정리', source: 'slide', refs: ['P3'] }], spoken: [], emphasis: [{ text: '중요', source: 'lecture', refs: ['T3'], quote: '이거 중요합니다.' }], pitfalls: [], evidence: [{ id: 'T03', time: 465, text: '구간법은…' }] }],
    questions: [{ slide: 3, type: '예측', question: 'Q?', answer: 'A' }],
    nextPreview: [{ slide: 9, title: '뉴턴-랩슨법의 수렴' }],
  });
  assert.match(md, /^# 공학수치해석 3주차 해설지/);
  assert.match(md, /- \[교안\] 중간값 정리 \(근거: P3\)/);
  assert.match(md, /“이거 중요합니다\.”/);
  assert.match(md, /T03 \(07:45\)/);
  assert.match(md, /## 다음 수업 예고/);
  assert.match(md, /- 9쪽\. 뉴턴-랩슨법의 수렴/);
});

test('survey result: self-report + baseline + auto-measured values, no personal data', () => {
  const r = buildSurveyResult(
    { accuracy: 5, usefulness: 4, quiz: '4', reuse: 5, baselineMinutes: '90', baselineConfidence: 2, improve: 'PDF 그림도 읽으면 좋겠어요', nickname: '기계과 4' },
    { engine: '데모', demo: true, slides: 12, progress: 8, covered: 7, brief: 1, emphasis: 8, toGuideMs: 150000, quizFirstPct: 60, quizAfterPct: 90, quizTotal: 10 },
    new Date('2026-11-23T03:00:00Z'),
  );
  assert.ok(r.ok);
  assert.equal(r.json.v, 2);
  assert.equal(r.json.scores.quiz, 4);
  assert.deepEqual(r.json.baseline, { minutes: 90, confidence: 2 });
  assert.equal(r.json.measured.toGuideMin, 2.5);
  assert.equal(r.json.measured.quizFirstPct, 60);
  assert.equal(r.json.measured.quizAfterPct, 90);
  assert.equal(r.json.nickname, '기계과 4');
  assert.match(r.text, /●●●●● 5\/5/);
  assert.match(r.text, /복습 자료 만드는 데 걸리던 시간: 90분/);
  assert.match(r.text, /입력 시작 → 해설지: 2분 30초/);
  assert.equal(r.json.measured.toGuideSec, 150);
  assert.match(r.text, /첫 시도 60% → 다시 풀기 후 90% \(10문항\)/);
  assert.match(r.text, /12쪽 중 8쪽까지/);
  assert.match(r.text, /JSON: \{"v":2/);
  assert.ok(!('email' in r.json) && !('name' in r.json));
  const bad = buildSurveyResult({ accuracy: 9, baselineMinutes: -3 });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes('accuracy'));
  assert.equal(bad.json.baseline.minutes, null);
  assert.match(bad.text, /측정 안 됨/);
});

test('gemini: builds the REST request and returns text', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"slides":[]}' }] } }] }) };
  };
  const out = await generateWithGemini({ apiKey: 'k-123', model: 'gemini-2.5-flash', prompt: 'P', fetchImpl });
  assert.equal(out, '{"slides":[]}');
  assert.match(seen.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'k-123');
  assert.doesNotMatch(seen.url, /k-123/); // key never in the URL
  const body = JSON.parse(seen.init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('gemini: friendly errors', async () => {
  const mk = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { message } }) });
  await assert.rejects(generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: mk(400, 'API key not valid') }), (e) => e instanceof GeminiError && /키가 올바르지/.test(e.message));
  await assert.rejects(generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: mk(429, 'quota') }), /한도/);
  await assert.rejects(generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: mk(404, 'nf') }), /모델을 찾지/);
  await assert.rejects(generateWithGemini({ apiKey: '', prompt: 'p' }), /키를 먼저/);
  await assert.rejects(generateWithGemini({ apiKey: 'x', model: 'bad/../id', prompt: 'p', fetchImpl: mk(200) }), /모델 이름/);
  await assert.rejects(
    generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: async () => { throw new TypeError('fail'); } }),
    /네트워크/,
  );
});
