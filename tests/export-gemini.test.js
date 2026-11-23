import test from 'node:test';
import assert from 'node:assert/strict';
import { guideToMarkdown, buildSurveyResult } from '../js/lib/export.js';
import { generateWithGemini, GeminiError, buildParts } from '../js/lib/gemini.js';
import { buildPrompt, buildTranscribePrompt } from '../js/lib/prompt.js';
import { analyzeLecture } from '../js/lib/pipeline.js';
import { DEMO_SLIDES_TEXT, DEMO_NOTES } from '../js/data/demo-lecture.js';

const a = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, notesText: DEMO_NOTES });
const P = (progress = 8, extra = {}) => buildPrompt({ course: '공학수치해석', week: 3, slides: a.slides, notes: a.notes.items, coverage: a.coverage, progress, ...extra });

test('prompt contains only slides inside the 진도선, the notes by page with ids, emphasis, plus the schema', () => {
  const p = P();
  assert.match(p.text, /### P8 \(필기 있음\)/);
  assert.match(p.text, /### P7 \(필기 조금\)/);
  assert.doesNotMatch(p.text, /### P9/);
  assert.doesNotMatch(p.text, /2차 수렴: E_/); // slide 9 body never sent
  assert.match(p.text, /n8: 중간값 정리: 연속/);
  assert.match(p.text, /n24: 분모가 f' !!/);
  assert.doesNotMatch(p.text, /n27/); // the 「다음 시간」 line is not a note on a taught page
  assert.match(p.text, /\[★ 별표, 시험\] "반복 횟수 n = log2/);
  assert.match(p.text, /"recall_questions"/);
  assert.match(p.text, /"notes"/);
  assert.match(p.text, /아직 안 배운 쪽 \(해설 금지, 참고만\): 9\. 뉴턴-랩슨법의 수렴/);
  assert.equal(p.coveredCount, 8);
  assert.doesNotMatch(p.text, /pan-p\d|ink-p\d/); // no ink section unless ink pages are attached
});

test('moving the 진도선 changes what is sent', () => {
  const p = P(4);
  assert.doesNotMatch(p.text, /### P5/);
  assert.doesNotMatch(p.text, /n14:/);
  assert.match(p.text, /n13:/);
});

test('prompt with attached ink pages names them by kind (판서본 → pan-pN, my deck → ink-pN)', () => {
  const pan = P(8, { ink: { kind: 'pan', pages: [3, 5], attached: true } });
  assert.match(pan.text, /교수님이 수업 후 올려 주신 판서본/);
  assert.match(pan.text, /pan-p3, pan-p5/);
  assert.deepEqual(pan.inkPages, [3, 5]);
  const mine = P(8, { ink: { kind: 'mine', pages: [1, 2], attached: true } });
  assert.match(mine.text, /ink-p1, ink-p2/);
  assert.doesNotMatch(mine.text, /pan-p\d/);
});

test('「필기 옮겨 적기」 prompt asks for p.N lines and lists slide titles', () => {
  const t = buildTranscribePrompt(a.slides);
  assert.match(t, /p\.3\n/);
  assert.match(t, /p\.8 뉴턴-랩슨법\(Newton-Raphson\)/);
  assert.match(t, /\[\?\]/);
});

test('markdown export: 교안 / 필기 / AI 보충 tags and note evidence with origin', () => {
  const md = guideToMarkdown({
    course: '공학수치해석',
    week: 3,
    progress: 8,
    total: 12,
    engine: '데모',
    createdAt: '2026-11-23T00:00:00Z',
    slides: [
      {
        slide: 3,
        title: '구간법',
        coverage: 'ink',
        summary: [{ text: '중간값 정리', source: 'slide', refs: ['P3'] }],
        notes: [{ text: '그래프 먼저', source: 'note', refs: ['n10'] }],
        emphasis: [{ text: '중요', source: 'note', refs: ['n8'], quote: '★중요' }],
        pitfalls: [{ text: '보충 설명', source: 'ai', refs: [] }],
        evidence: [{ id: 'n8', origin: 'typed', text: '중간값 정리 ★중요' }, { id: 'pan-p3', origin: 'pan', text: '판서본 3쪽' }],
      },
      { slide: 7, title: '가위치법', coverage: 'light', summary: [], notes: [], emphasis: [], pitfalls: [], evidence: [] },
    ],
    questions: [{ slide: 3, type: '예측', question: 'Q?', answer: 'A' }],
    nextPreview: [{ slide: 9, title: '뉴턴-랩슨법의 수렴' }],
  });
  assert.match(md, /^# 공학수치해석 3주차 해설지/);
  assert.match(md, /- \[교안\] 중간값 정리 \(근거: P3\)/);
  assert.match(md, /- \[필기\] 그래프 먼저 \(근거: n10\)/);
  assert.match(md, /- \[AI 보충\] 보충 설명/);
  assert.match(md, /“★중요”/);
  assert.match(md, /\*\*필기에서 \(교안에 없는 것\)\*\*/);
  assert.match(md, /<summary>필기 근거<\/summary>/);
  assert.match(md, /- n8 \(내 필기\): 중간값 정리/);
  assert.match(md, /- pan-p3 \(교수님 판서\): /);
  assert.match(md, /## 7쪽\. 가위치법 _\(필기 조금\)_/);
  assert.match(md, /## 다음 수업 예고/);
  assert.match(md, /- 9쪽\. 뉴턴-랩슨법의 수렴/);
});

test('survey result v3: notes-based questions, 진도선 accuracy, baseline + auto-measured values, no personal data', () => {
  const r = buildSurveyResult(
    { usefulness: 4, tags: 5, quiz: '4', reuse: 5, progressOff: '1', baselineMinutes: '90', baselineConfidence: 2, improve: '판서본 글씨도 읽으면 좋겠어요', nickname: '기계과 4' },
    { engine: '데모', demo: true, slides: 12, suggested: 8, progress: 9, noted: 7, light: 1, emphasis: 4, noteLines: 27, inkKind: 'pan', toGuideMs: 150000, quizFirstPct: 60, quizAfterPct: 90, quizTotal: 10 },
    new Date('2026-11-23T03:00:00Z'),
  );
  assert.ok(r.ok);
  assert.equal(r.json.v, 3);
  assert.deepEqual(r.json.scores, { usefulness: 4, tags: 5, quiz: 4, reuse: 5 });
  assert.equal(r.json.progressOff, 1);
  assert.deepEqual(r.json.baseline, { minutes: 90, confidence: 2 });
  assert.equal(r.json.measured.toGuideMin, 2.5);
  assert.equal(r.json.measured.toGuideSec, 150);
  assert.equal(r.json.measured.adjusted, 1);
  assert.equal(r.json.measured.inkKind, 'pan');
  assert.equal(r.json.nickname, '기계과 4');
  assert.match(r.text, /●●●●● 5\/5/);
  assert.match(r.text, /5\. 제안된 진도선: 1쪽 차이/);
  assert.match(r.text, /교안 \+ 필기로 복습 자료 만드는 데 걸리던 시간: 90분/);
  assert.match(r.text, /입력 시작 → 해설지: 2분 30초/);
  assert.match(r.text, /첫 시도 60% → 다시 풀기 후 90% \(10문항\)/);
  assert.match(r.text, /전체 12쪽 중 제안 8쪽 → 최종 9쪽 \(직접 \+1쪽 조정\)/);
  assert.match(r.text, /교수님 판서본 PDF/);
  assert.match(r.text, /JSON: \{"v":3/);
  assert.ok(!('email' in r.json) && !('name' in r.json));
  const bad = buildSurveyResult({ usefulness: 9, baselineMinutes: -3 });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes('usefulness'));
  assert.equal(bad.json.baseline.minutes, null);
  assert.equal(bad.json.progressOff, null);
  assert.match(bad.text, /측정 안 됨/);
  assert.match(bad.text, /제안된 진도선: 미응답/);
});

test('gemini: ink page images ride along as inline JPEG parts, each after its label', () => {
  const parts = buildParts('PROMPT', [{ label: 'pan-p3 (교수님 판서본 3쪽)', mimeType: 'image/jpeg', data: 'AAAA' }, { label: 'pan-p5', data: 'BBBB' }]);
  assert.equal(parts.length, 5);
  assert.deepEqual(parts[0], { text: 'PROMPT' });
  assert.deepEqual(parts[1], { text: 'pan-p3 (교수님 판서본 3쪽)' });
  assert.deepEqual(parts[2], { inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } });
  assert.equal(parts[4].inline_data.mime_type, 'image/jpeg');
  assert.deepEqual(buildParts('X'), [{ text: 'X' }]);
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
  assert.deepEqual(body.contents[0].parts, [{ text: 'P' }]);
  await generateWithGemini({ apiKey: 'k', prompt: 'P', images: [{ label: 'ink-p2', data: 'QQ==' }], fetchImpl });
  assert.equal(JSON.parse(seen.init.body).contents[0].parts[2].inline_data.data, 'QQ==');
});

test('gemini: friendly errors', async () => {
  const mk = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { message } }) });
  await assert.rejects(generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: mk(400, 'API key not valid') }), (e) => e instanceof GeminiError && /키가 올바르지/.test(e.message));
  await assert.rejects(generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: mk(429, 'quota') }), /한도/);
  await assert.rejects(generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: mk(404, 'nf') }), /모델을 찾지/);
  await assert.rejects(generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: mk(413, 'too large') }), GeminiError);
  await assert.rejects(generateWithGemini({ apiKey: '', prompt: 'p' }), /키를 먼저/);
  await assert.rejects(generateWithGemini({ apiKey: 'x', model: 'bad/../id', prompt: 'p', fetchImpl: mk(200) }), /모델 이름/);
  await assert.rejects(
    generateWithGemini({ apiKey: 'x', prompt: 'p', fetchImpl: async () => { throw new TypeError('fail'); } }),
    /네트워크/,
  );
});
