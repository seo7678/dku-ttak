// The bundled demo output must itself pass the same grounding check real AI replies go through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGuide } from '../js/lib/reply.js';
import { verifyGuide } from '../js/lib/verify.js';
import { analyzeLecture } from '../js/lib/pipeline.js';
import { DEMO_SLIDES_TEXT, DEMO_TRANSCRIPT } from '../js/data/demo-lecture.js';

const raw = JSON.parse(readFileSync(new URL('../data/demo-guide.json', import.meta.url), 'utf8'));
const a = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, transcriptText: DEMO_TRANSCRIPT });
const g = normalizeGuide(raw);
const v = verifyGuide(g, { slides: a.slides, chunks: a.chunks, progress: a.coverage.progress, coverage: a.coverage });

test('demo guide covers exactly slides 1–8', () => {
  assert.deepEqual(g.slides.map((s) => s.slide), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('demo guide: every ref exists, nothing downgraded or dropped', () => {
  assert.equal(v.stats.unknownRefs, 0);
  assert.equal(v.stats.downgraded, 0);
  assert.deepEqual(v.stats.droppedSlides, []);
  assert.deepEqual(v.warnings, []);
});

test('demo guide: every "교수님이 말로 덧붙인 것" cites the transcript', () => {
  for (const s of v.slides) for (const st of s.spoken) assert.ok(st.refs.some((r) => r[0] === 'T'), `${s.slide}: ${st.text}`);
});

test('demo guide: emphasis quotes are verbatim from the transcript', () => {
  for (const s of v.slides) for (const st of s.emphasis) {
    assert.ok(st.quoteVerified, st.quote);
    assert.ok(DEMO_TRANSCRIPT.includes(st.quote), st.quote);
  }
});

test('demo guide: recall questions use the three types and stay inside the 진도선', () => {
  assert.ok(v.questions.length >= 8);
  assert.deepEqual([...new Set(v.questions.map((q) => q.type))].sort(), ['개념', '계산', '예측']);
  assert.ok(v.questions.every((q) => q.slide <= 8));
});

test('demo guide: has some AI 보충 statements, clearly separated', () => {
  assert.ok(v.stats.ai >= 1);
  assert.ok(v.stats.lecture > 10);
});
