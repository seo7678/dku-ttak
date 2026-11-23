// 진도 찾기: where did today's class stop, judged from the student's notes (typed text and/or ink on the deck).
// Deterministic — no AI.
// - Typed notes anchored to a page (p.12, 12쪽 …) belong to that page.
// - Unanchored note paragraphs are aligned to slides: TF-IDF cosine over Hangul char 2/3-grams + Latin/number
//   tokens, then a Viterbi path that prefers moving forward one slide at a time (notes follow the class order).
//   Anchored blocks take part in the same path as fixed points, so a loose line between p.4 and p.5 lands near them.
// - Ink (필기한 교안 PDF vs 수업용 교안) comes in as per-page 'ink' | 'light' | 'none' from ink.js.
// Per page: 필기 있음 / 필기 조금 / 필기 없음. Suggested 진도선 = last page with notes (max of text and ink).
import { features, idfOf, tfidf, cosine } from './text.js';
import { detectEmphasis } from './emphasis.js';
import { noteBlocks } from './notes.js';

export const STATUS = { INK: 'ink', LIGHT: 'light', NONE: 'none' };
export const STATUS_LABEL = { ink: '필기 있음', light: '필기 조금', none: '필기 없음' };
const RANK = { none: 0, light: 1, ink: 2 };

const DEFAULTS = {
  minSim: 0.035, // an unanchored block below this matches no slide (date line, 잡담 메모 …)
  alignMinSim: 0.1, // an unanchored block needs this much similarity to move the 진도선
  stepPenalty: 0.12, // moving to the next slide
  skipPenalty: 0.3, // each additional slide skipped forward
  backPenalty: 0.55, // going back to an earlier slide
  startPenalty: 0.08, // per slide away from the first slide at the start
  emitRef: 0.3, // blocks whose best similarity is below this get damped emissions (transitions dominate)
  fixedEmit: 5, // anchored blocks: emission +5 on their page, −5 elsewhere (a hard constraint in practice)
  fullChars: 30, // ≥ this many characters of typed notes on a page → 필기 있음, fewer → 필기 조금
};

export function maxStatus(a, b) {
  return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a || 'none' : b || 'none';
}

/** Suggested 진도선 when both typed notes and ink are present: the later of the two. */
export function mergeProgress(textProgress, inkProgress) {
  return Math.max(textProgress || 0, inkProgress || 0);
}

/**
 * @param {{index:number,label:string,title:string,text:string}[]} slides
 * @param {{id:string,page:number|null,anchored:boolean,text:string,preview:boolean,para:number}[]} items — parseNotes(...).items
 * @param {object} [ink] — { statuses: ('ink'|'light'|'none')[], ratios: number[], progress: number } already mapped to slide order (index-1)
 */
export function analyzeNotes(slides, items, ink = null, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const n = slides.length;
  const slideFeat = slides.map((s) => features(s.text));
  const idf = idfOf(slideFeat);
  const slideVec = slideFeat.map((f) => tfidf(f, idf));
  const posOf = new Map(slides.map((s, j) => [s.index, j]));

  const blocks = noteBlocks(items).map((b) => {
    const vec = tfidf(features(b.text), idf);
    const sims = slideVec.map((sv) => cosine(vec, sv));
    const max = Math.max(0, ...sims);
    const fixed = b.fixed != null && posOf.has(b.fixed) ? posOf.get(b.fixed) : null;
    return { ...b, fixed, sims, max, offTopic: fixed == null && max < opt.minSim };
  });

  const on = blocks.filter((b) => !b.offTopic);
  const path = viterbi(on, n, opt);
  on.forEach((b, k) => (b.pos = path[k]));

  const per = slides.map((s) => ({
    index: s.index,
    label: s.label,
    title: s.title,
    noteIds: [],
    chars: 0,
    bestSim: 0,
    anchored: 0,
    counts: false, // has notes that may move the 진도선
    textStatus: STATUS.NONE,
    inkStatus: ink ? ink.statuses[s.index - 1] || STATUS.NONE : null,
    inkRatio: ink ? ink.ratios[s.index - 1] ?? null : null,
    status: STATUS.NONE,
    emphasis: [],
  }));
  const pageOfNote = new Map();
  for (const b of on) {
    const p = per[b.pos];
    for (const it of b.items) {
      p.noteIds.push(it.id);
      pageOfNote.set(it.id, p.index);
      p.chars += it.text.length;
    }
    if (b.fixed != null) {
      p.anchored += b.items.length;
      p.counts = true;
    } else {
      p.bestSim = Math.max(p.bestSim, b.sims[b.pos]);
      if (b.sims[b.pos] >= opt.alignMinSim) p.counts = true;
    }
  }
  for (const p of per) {
    if (p.chars > 0) p.textStatus = p.chars >= opt.fullChars ? STATUS.INK : STATUS.LIGHT;
    p.status = maxStatus(p.textStatus, p.inkStatus);
  }

  let textProgress = 0;
  for (const p of per) if (p.counts) textProgress = p.index;
  const inkProgress = ink ? ink.progress || 0 : 0;
  const progress = mergeProgress(textProgress, inkProgress);

  // "다음 시간: …" lines: which upcoming slides were announced? Prefer the earliest strong match after the line.
  const previews = items
    .filter((it) => it.preview)
    .map((it) => {
      const vec = tfidf(features(it.text), idf);
      const cands = slides
        .map((s, j) => ({ index: s.index, sim: cosine(vec, slideVec[j]) }))
        .filter((c) => c.index > progress && c.sim >= opt.minSim);
      const best = Math.max(0, ...cands.map((c) => c.sim));
      const strong = cands.filter((c) => c.sim >= best * 0.6);
      return { noteId: it.id, text: it.text, slideIndices: strong.map((c) => c.index), slideIndex: strong.length ? strong[0].index : null };
    });

  // Emphasis pinned to the page its note line belongs to (null when the line matched no page).
  const emphasis = detectEmphasis(items).map((e) => ({ ...e, slideIndex: pageOfNote.get(e.noteId) ?? null }));
  for (const e of emphasis) {
    const p = per.find((x) => x.index === e.slideIndex);
    if (p) p.emphasis.push(e);
  }

  const unplaced = blocks.filter((b) => b.offTopic).flatMap((b) => b.items.map((it) => it.id));

  return {
    slides: per,
    progress,
    textProgress,
    inkProgress,
    emphasis,
    previews,
    unplaced,
    pageOfNote: Object.fromEntries(pageOfNote),
  };
}

function viterbi(items, n, opt) {
  if (!items.length || !n) return [];
  const T = items.length;
  const score = Array.from({ length: T }, () => new Float64Array(n));
  const back = Array.from({ length: T }, () => new Int32Array(n));
  const emit = (it, j) => {
    if (it.fixed != null) return j === it.fixed ? opt.fixedEmit : -opt.fixedEmit;
    return it.max > 0 ? it.sims[j] / Math.max(it.max, opt.emitRef) : 0;
  };
  const trans = (i, j) => {
    const d = j - i;
    if (d === 0) return 0;
    if (d > 0) return -opt.stepPenalty - opt.skipPenalty * (d - 1);
    return -opt.backPenalty - opt.skipPenalty * 0.5 * (-d - 1);
  };
  for (let j = 0; j < n; j++) score[0][j] = emit(items[0], j) - (items[0].fixed != null ? 0 : opt.startPenalty * j);
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < n; j++) {
      let best = -Infinity;
      let arg = 0;
      for (let i = 0; i < n; i++) {
        const v = score[t - 1][i] + trans(i, j);
        if (v > best) {
          best = v;
          arg = i;
        }
      }
      score[t][j] = best + emit(items[t], j);
      back[t][j] = arg;
    }
  }
  let end = 0;
  for (let j = 1; j < n; j++) if (score[T - 1][j] > score[T - 1][end]) end = j;
  const path = new Array(T);
  path[T - 1] = end;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t][path[t]];
  return path;
}

/** Split slides into taught (≤ progress) and upcoming (> progress) by slide index. */
export function splitByProgress(slides, progress) {
  return {
    covered: slides.filter((s) => s.index <= progress),
    upcoming: slides.filter((s) => s.index > progress),
  };
}
