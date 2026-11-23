// The bundled demo output must itself pass the same grounding check real AI replies go through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGuide } from '../js/lib/reply.js';
import { verifyGuide } from '../js/lib/verify.js';
import { analyzeLecture } from '../js/lib/pipeline.js';
import { DEMO_SLIDES_TEXT, DEMO_NOTES } from '../js/data/demo-lecture.js';

const raw = JSON.parse(readFileSync(new URL('../data/demo-guide.json', import.meta.url), 'utf8'));
const a = analyzeLecture({ slidesText: DEMO_SLIDES_TEXT, notesText: DEMO_NOTES });
const g = normalizeGuide(raw);
const v = verifyGuide(g, { slides: a.slides, notes: a.notes.items, progress: a.coverage.progress, coverage: a.coverage });
const ids = new Set(a.notes.items.map((x) => x.id));

test('demo guide covers exactly slides 1–8 (the 진도선 the notes suggest)', () => {
  assert.equal(a.coverage.progress, 8);
  assert.deepEqual(g.slides.map((s) => s.slide), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('demo guide: every ref exists, nothing downgraded or dropped', () => {
  assert.equal(v.stats.unknownRefs, 0);
  assert.equal(v.stats.downgraded, 0);
  assert.deepEqual(v.stats.droppedSlides, []);
  assert.deepEqual(v.warnings, []);
});

test('demo guide: every 필기 statement cites an existing note id', () => {
  for (const s of v.slides) for (const st of s.notes) {
    assert.equal(st.source, 'note', st.text);
    assert.ok(st.refs.some((r) => r[0] === 'n' && ids.has(r)), `${s.slide}: ${st.text}`);
  }
  // …and the raw file only ever cites ids that exist (no rescue by fuzzy match needed)
  const cited = JSON.stringify(raw).match(/"n\d+"/g).map((x) => x.slice(1, -1));
  assert.ok(cited.length > 10);
  for (const id of cited) assert.ok(ids.has(id), id);
});

test('demo guide: emphasis quotes are verbatim note lines', () => {
  const n = v.slides.flatMap((s) => s.emphasis);
  assert.ok(n.length >= 3);
  for (const st of n) {
    assert.ok(st.quoteVerified, st.quote);
    assert.ok(DEMO_NOTES.includes(st.quote), st.quote);
  }
});

test('demo guide: recall questions use the three types and stay inside the 진도선', () => {
  assert.ok(v.questions.length >= 8);
  assert.deepEqual([...new Set(v.questions.map((q) => q.type))].sort(), ['개념', '계산', '예측']);
  assert.ok(v.questions.every((q) => q.slide <= 8));
});

test('demo guide: has 교안, 필기 and some AI 보충 statements, clearly separated', () => {
  assert.ok(v.stats.ai >= 1);
  assert.ok(v.stats.note > 10);
  assert.ok(v.stats.slide > 10);
});

test('demo guide: slide 7 (필기 조금) is still explained from 교안', () => {
  const s7 = v.slides.find((s) => s.slide === 7);
  assert.equal(s7.coverage, 'light');
  assert.ok(s7.summary.length >= 1);
});
