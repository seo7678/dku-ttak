// Deterministic grounding check of an AI-written guide against the actual inputs.
// - drops slides beyond the 진도선 (never explain what the class has not reached)
// - "필기" statements must cite a note that exists in the input: a typed note id (n12) or an ink page that was
//   actually given (ink-p5 = my annotated deck, pan-p5 = the professor's 판서본). Otherwise a close match to a
//   typed note line is accepted; failing that the statement is shown as "AI 보충".
// - emphasis quotes are fuzzy-matched against the typed notes
// - 다음 수업 예고 is rebuilt from the untaught slide titles only (no AI text)
import { bigramOverlap } from './text.js';
import { refKey, refType } from './reply.js';

export const NOTE_ORIGIN = { typed: '내 필기 (타이핑)', ink: '내 필기 (필기한 교안)', pan: '교수님 판서' };

/** Where a note citation comes from: 'typed' | 'ink' | 'pan'. */
export function noteOrigin(ref) {
  if (!ref) return null;
  if (ref.startsWith('pan-')) return 'pan';
  if (ref.startsWith('ink-')) return 'ink';
  if (ref[0] === 'n') return 'typed';
  return null;
}

/**
 * @param guide normalized guide (reply.normalizeGuide)
 * @param ctx {
 *   slides:[{index,title,text}], notes:[{id,text,preview}], progress:number, coverage?:analyzeNotes result,
 *   ink?: { kind:'mine'|'pan', pages:number[] }  — ink pages that were given as input
 * }
 */
export function verifyGuide(guide, ctx) {
  const notes = (ctx.notes || []).filter((n) => !n.preview);
  const noteMap = new Map(notes.map((n) => [refKey(n.id), n]));
  const slideMap = new Map(ctx.slides.map((s) => [s.index, s]));
  const inkPrefix = ctx.ink?.kind === 'pan' ? 'pan' : 'ink';
  const inkRefs = new Set((ctx.ink?.pages || []).map((p) => `${inkPrefix}-p${p}`));
  const warnings = [];
  const stats = { slide: 0, note: 0, ai: 0, downgraded: 0, droppedSlides: [], unknownRefs: 0 };

  const findNote = (q) => {
    if (!q || q.replace(/\s+/g, '').length < 4) return null;
    let best = null;
    let bestScore = 0;
    for (const n of notes) {
      const sc = bigramOverlap(q, n.text);
      if (sc > bestScore) {
        bestScore = sc;
        best = n;
      }
    }
    return bestScore >= 0.6 ? best : null;
  };

  const isValid = (r) => {
    if (refType(r) === 'slide') return slideMap.has(Number(r.slice(1)));
    if (r[0] === 'n') return noteMap.has(r);
    return inkRefs.has(r);
  };

  const checkSt = (st, slideNo, section) => {
    const valid = [];
    for (const r of st.refs) {
      if (isValid(r)) valid.push(r);
      else stats.unknownRefs++;
    }
    st.refs = valid;
    st.check = 'ok';
    if (st.source === 'note') {
      if (!valid.some((r) => refType(r) === 'note')) {
        const n = findNote(st.quote) || findNote(st.text);
        if (n) st.refs.push(refKey(n.id));
        else {
          st.source = 'ai';
          st.check = 'downgraded';
          st.note = '필기에서 근거를 찾지 못해 AI 보충으로 표시했어요.';
          stats.downgraded++;
        }
      }
    }
    if (section === 'emphasis' && st.quote) {
      const n = findNote(st.quote);
      st.quoteVerified = !!n;
      if (n && !st.refs.includes(refKey(n.id))) st.refs.push(refKey(n.id));
    }
    if (st.source === 'slide') {
      const s = slideMap.get(slideNo);
      if (s && !st.refs.length) st.refs.push('P' + slideNo);
      // Light paraphrase check — slide statements should share vocabulary with the slide.
      const ref = st.refs.find((r) => refType(r) === 'slide');
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
      coverage: cov ? cov.status : 'none',
      summary: s.summary.map((st) => checkSt(st, s.slide, 'summary')),
      notes: s.notes.map((st) => checkSt(st, s.slide, 'notes')),
      emphasis: s.emphasis.map((st) => checkSt(st, s.slide, 'emphasis')),
      pitfalls: s.pitfalls.map((st) => checkSt(st, s.slide, 'pitfalls')),
      evidence: [], // filled below
    });
  }
  if (stats.droppedSlides.length) {
    warnings.push(`진도선(${ctx.progress}쪽) 밖의 ${stats.droppedSlides.join(', ')}쪽 해설은 아직 안 배운 내용이라 뺐어요.`);
  }
  if (stats.unknownRefs) warnings.push(`입력에 없는 근거 번호 ${stats.unknownRefs}개는 무시했어요.`);
  if (stats.downgraded) warnings.push(`근거 없는 "필기" 문장 ${stats.downgraded}개를 AI 보충으로 바꿔 표시했어요.`);

  // Evidence = notes placed on the slide by 진도 찾기 + notes and ink pages cited by the AI.
  for (const s of slides) {
    const ids = new Set();
    const cov = ctx.coverage?.slides.find((p) => p.index === s.slide);
    (cov?.noteIds || []).forEach((id) => ids.add(refKey(id)));
    for (const sec of ['summary', 'notes', 'emphasis', 'pitfalls']) for (const st of s[sec]) st.refs.forEach((r) => refType(r) === 'note' && ids.add(r));
    const typed = [...ids]
      .filter((k) => k[0] === 'n')
      .map((k) => noteMap.get(k))
      .filter(Boolean)
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
      .map((n) => ({ id: n.id, origin: 'typed', text: n.text }));
    const inkEv = [...ids]
      .filter((k) => k[0] !== 'n')
      .sort()
      .map((k) => ({ id: k, origin: noteOrigin(k), text: `${k.startsWith('pan-') ? '교수님 판서본' : '필기한 교안'} ${k.replace(/^\w+-p/, '')}쪽의 손글씨 (AI가 그림에서 읽음)` }));
    s.evidence = [...typed, ...inkEv];
  }
  // Slides inside the 진도선 that the AI skipped get an empty card so nothing silently disappears.
  for (const src of ctx.slides) {
    if (src.index <= ctx.progress && !slides.some((s) => s.slide === src.index)) {
      const cov = ctx.coverage?.slides.find((p) => p.index === src.index);
      slides.push({ slide: src.index, title: src.title, coverage: cov?.status ?? 'none', summary: [], notes: [], emphasis: [], pitfalls: [], evidence: (cov?.noteIds || []).map((id) => noteMap.get(id)).filter(Boolean).map((n) => ({ id: n.id, origin: 'typed', text: n.text })), missing: true });
    }
  }
  slides.sort((a, b) => a.slide - b.slide);

  const questions = guide.questions.filter((q) => q.slide == null || q.slide <= ctx.progress);
  const droppedQ = guide.questions.length - questions.length;
  if (droppedQ) warnings.push(`진도선 밖 회상 문제 ${droppedQ}개를 뺐어요.`);
  for (const q of questions) q.refs = (q.refs || []).filter(isValid);

  const nextPreview = ctx.slides.filter((s) => s.index > ctx.progress).map((s) => ({ slide: s.index, title: s.title }));

  return { slides, questions, nextPreview, warnings, stats };
}
