// Deterministic grounding check of an AI-written guide against the actual inputs.
// - drops slides beyond the 진도선 (insight 1: never explain what the class has not reached)
// - "수업" statements must cite an existing transcript chunk (T-id) or quote it; otherwise → "AI 보충"
// - emphasis quotes are fuzzy-matched against the transcript
// - 다음 수업 예고 is rebuilt from the uncovered slide titles only (no AI text)
import { bigramOverlap } from './text.js';
import { refKey } from './reply.js';

/**
 * @param guide normalized guide (reply.normalizeGuide)
 * @param ctx { slides:[{index,title,text}], chunks:[{id,text,time}], progress:number, coverage?:analyzeCoverage result }
 */
export function verifyGuide(guide, ctx) {
  const chunkMap = new Map(ctx.chunks.map((c) => [refKey(c.id), c]));
  const slideMap = new Map(ctx.slides.map((s) => [s.index, s]));
  const warnings = [];
  const stats = { slide: 0, lecture: 0, ai: 0, downgraded: 0, droppedSlides: [], unknownRefs: 0 };

  const findQuoteChunk = (q) => {
    if (!q || q.length < 6) return null;
    let best = null;
    let bestScore = 0;
    for (const c of ctx.chunks) {
      const sc = bigramOverlap(q, c.text);
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    return bestScore >= 0.6 ? best : null;
  };

  const checkSt = (st, slideNo, section) => {
    const valid = [];
    for (const r of st.refs) {
      if (r[0] === 'T' && chunkMap.has(r)) valid.push(r);
      else if (r[0] === 'P' && slideMap.has(Number(r.slice(1)))) valid.push(r);
      else stats.unknownRefs++;
    }
    st.refs = valid;
    st.check = 'ok';
    if (st.source === 'lecture') {
      const hasT = valid.some((r) => r[0] === 'T');
      if (!hasT) {
        const c = findQuoteChunk(st.quote) || findQuoteChunk(st.text);
        if (c) {
          st.refs.push(refKey(c.id));
        } else {
          st.source = 'ai';
          st.check = 'downgraded';
          st.note = '수업 녹음에서 근거를 찾지 못해 AI 보충으로 표시했어요.';
          stats.downgraded++;
        }
      }
    }
    if (section === 'emphasis' && st.quote) {
      const c = findQuoteChunk(st.quote);
      st.quoteVerified = !!c;
      if (c && !st.refs.includes(refKey(c.id))) st.refs.push(refKey(c.id));
    }
    if (st.source === 'slide') {
      const s = slideMap.get(slideNo);
      if (s && !st.refs.length) st.refs.push('P' + slideNo);
      // Light paraphrase check — slide statements should share vocabulary with the slide.
      const ref = st.refs.find((r) => r[0] === 'P');
      const src = ref ? slideMap.get(Number(ref.slice(1))) : s;
      if (src && bigramOverlap(st.text, src.text) < 0.2) st.check = 'unverified';
    }
    stats[st.source]++;
    return st;
  };

  const slides = [];
  for (const s of guide.slides) {
    if (s.slide > ctx.progress) {
      stats.droppedSlides.push(s.slide);
      continue;
    }
    if (!slideMap.has(s.slide)) {
      warnings.push(`${s.slide}쪽은 교안에 없는 쪽 번호라서 뺐어요.`);
      continue;
    }
    const src = slideMap.get(s.slide);
    const cov = ctx.coverage?.slides.find((p) => p.index === s.slide);
    slides.push({
      slide: s.slide,
      title: s.title || src.title,
      coverage: cov ? cov.status : s.coverage,
      summary: s.summary.map((st) => checkSt(st, s.slide, 'summary')),
      spoken: s.spoken.map((st) => checkSt(st, s.slide, 'spoken')),
      emphasis: s.emphasis.map((st) => checkSt(st, s.slide, 'emphasis')),
      pitfalls: s.pitfalls.map((st) => checkSt(st, s.slide, 'pitfalls')),
      evidence: [], // filled below
    });
  }
  if (stats.droppedSlides.length) {
    warnings.push(`진도선(${ctx.progress}쪽) 밖의 ${stats.droppedSlides.join(', ')}쪽 해설은 아직 안 배운 내용이라 뺐어요.`);
  }
  if (stats.unknownRefs) warnings.push(`존재하지 않는 근거 번호 ${stats.unknownRefs}개는 무시했어요.`);
  if (stats.downgraded) warnings.push(`근거 없는 "수업" 문장 ${stats.downgraded}개를 AI 보충으로 바꿔 표시했어요.`);

  // Evidence = chunks aligned to the slide by 진도 감지 + chunks cited by the AI.
  for (const s of slides) {
    const ids = new Set();
    const cov = ctx.coverage?.slides.find((p) => p.index === s.slide);
    (cov?.chunkIds || []).forEach((id) => ids.add(refKey(id)));
    for (const sec of ['summary', 'spoken', 'emphasis', 'pitfalls']) for (const st of s[sec]) st.refs.forEach((r) => r[0] === 'T' && ids.add(r));
    s.evidence = [...ids]
      .map((k) => chunkMap.get(k))
      .filter(Boolean)
      .sort((a, b) => refKey(a.id).slice(1) - refKey(b.id).slice(1))
      .map((c) => ({ id: c.id, time: c.time ?? null, text: c.text }));
  }
  // Slides inside the 진도선 that the AI skipped get an empty card so nothing silently disappears.
  for (const src of ctx.slides) {
    if (src.index <= ctx.progress && !slides.some((s) => s.slide === src.index)) {
      const cov = ctx.coverage?.slides.find((p) => p.index === src.index);
      slides.push({ slide: src.index, title: src.title, coverage: cov?.status ?? 'none', summary: [], spoken: [], emphasis: [], pitfalls: [], evidence: [], missing: true });
    }
  }
  slides.sort((a, b) => a.slide - b.slide);

  const questions = guide.questions.filter((q) => q.slide == null || q.slide <= ctx.progress);
  const droppedQ = guide.questions.length - questions.length;
  if (droppedQ) warnings.push(`진도선 밖 회상 문제 ${droppedQ}개를 뺐어요.`);

  const nextPreview = ctx.slides.filter((s) => s.index > ctx.progress).map((s) => ({ slide: s.index, title: s.title }));

  return { slides, questions, nextPreview, warnings, stats };
}
