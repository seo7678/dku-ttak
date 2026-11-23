// 진도 감지: map transcript chunks onto slides and find the last substantively covered slide.
// Deterministic — no AI. Similarity = TF-IDF cosine over Hangul char 2/3-grams + Latin/number tokens;
// sequence = Viterbi path that prefers moving forward one slide at a time (lectures mostly do).
import { features, idfOf, tfidf, cosine } from './text.js';
import { isPreviewSentence, detectEmphasis } from './emphasis.js';

export const STATUS = { COVERED: 'covered', BRIEF: 'brief', NONE: 'none' };
export const STATUS_LABEL = { covered: '다룸', brief: '잠깐 언급', none: '안 다룸' };

const DEFAULTS = {
  minSim: 0.035, // below this a chunk is treated as off-topic (출석, 잡담 …)
  stepPenalty: 0.12, // moving to the next slide
  skipPenalty: 0.3, // each additional slide skipped forward
  backPenalty: 0.55, // going back to an earlier slide
  startPenalty: 0.08, // per slide away from the first slide at the start
  coverRatio: 0.4, // a slide is "covered" if it got ≥ 40% of the median talk time of talked-about slides
  coverMinChars: 60,
  emitRef: 0.3, // chunks whose best similarity is below this get damped emissions (transitions dominate)
  coverMinSim: 0.2, // "다룸" needs at least one chunk that matches the slide this well
};

/**
 * @param {{index:number,label:string,title:string,text:string}[]} slides
 * @param {{id:string,time:number|null,text:string,sentences:string[]}[]} chunks
 */
export function analyzeCoverage(slides, chunks, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const n = slides.length;
  const slideFeat = slides.map((s) => features(s.text));
  const idf = idfOf(slideFeat);
  const slideVec = slideFeat.map((f) => tfidf(f, idf));

  // Remove "다음 시간에 …" sentences from alignment; keep them as previews.
  const previews = [];
  const items = chunks.map((ch) => {
    const kept = [];
    for (const s of ch.sentences) {
      if (isPreviewSentence(s)) previews.push({ chunkId: ch.id, sentence: s, time: ch.time ?? null });
      else kept.push(s);
    }
    const alignText = kept.join(' ');
    const vec = tfidf(features(alignText), idf);
    const sims = slideVec.map((sv) => cosine(vec, sv));
    const max = Math.max(0, ...sims);
    return { chunk: ch, alignText, sims, max, offTopic: !alignText.trim() || max < opt.minSim };
  });

  // Viterbi over on-topic chunks.
  const on = items.filter((it) => !it.offTopic);
  const path = viterbi(on, n, opt);
  on.forEach((it, k) => {
    it.slidePos = path[k];
  });
  // Off-topic chunks inherit the previous on-topic position (for emphasis pinning / timeline).
  let last = on.length ? on[0].slidePos : 0;
  for (const it of items) {
    if (it.offTopic) it.slidePos = last;
    else last = it.slidePos;
  }

  // Aggregate per slide.
  const per = slides.map((s, j) => ({
    index: s.index,
    label: s.label,
    title: s.title,
    chunkIds: [],
    chars: 0,
    bestSim: 0,
    status: STATUS.NONE,
    emphasis: [],
  }));
  for (const it of items) {
    if (it.offTopic) continue;
    const p = per[it.slidePos];
    p.chunkIds.push(it.chunk.id);
    p.chars += it.alignText.length;
    p.bestSim = Math.max(p.bestSim, it.sims[it.slidePos]);
  }
  const talked = per.filter((p) => p.chars > 0).map((p) => p.chars).sort((a, b) => a - b);
  const median = talked.length ? talked[Math.floor((talked.length - 1) / 2)] : 0;
  const coverChars = Math.max(opt.coverMinChars, median * opt.coverRatio);
  for (const p of per) {
    if (p.chars >= coverChars && p.bestSim >= opt.coverMinSim) p.status = STATUS.COVERED;
    else if (p.chars > 0) p.status = STATUS.BRIEF;
  }
  // Note: a "best match but assigned elsewhere" mention rule was tried and removed — summary slides
  // (정리 표) and shared vocabulary made it flag untouched slides as 잠깐 언급.

  // 진도선 = the last slide the lecture actually reached on its forward path (다룸 or 잠깐 언급).
  // Using only 다룸 stopped the line early on every miss in the real-lecture eval: the last slides of a
  // class are often talked through briefly (wrap-up, worked-example continuation) yet were taught.
  // A 잠깐 언급 slide needs at least coverMinChars of talk to move the line, so one stray sentence
  // that lands on the next slide (e.g. a single subtitle cue) does not.
  let progress = 0;
  for (const p of per) {
    if (p.status === STATUS.COVERED || (p.status === STATUS.BRIEF && p.chars >= opt.coverMinChars)) progress = p.index;
  }

  // Previews ("다음 시간에 …"): which upcoming slides were announced? Prefer the earliest strong match.
  for (const p of previews) {
    const vec = tfidf(features(p.sentence), idf);
    const cands = slides
      .map((s, j) => ({ index: s.index, sim: cosine(vec, slideVec[j]) }))
      .filter((c) => c.index > progress && c.sim >= opt.minSim);
    const best = Math.max(0, ...cands.map((c) => c.sim));
    const strong = cands.filter((c) => c.sim >= best * 0.6);
    p.slideIndices = strong.map((c) => c.index);
    p.slideIndex = strong.length ? strong[0].index : null;
  }

  // Emphasis pinned to the slide being discussed at that moment.
  const emphasis = detectEmphasis(chunks).map((e) => {
    const it = items.find((x) => x.chunk.id === e.chunkId);
    const slideIndex = slides[it.slidePos]?.index ?? null;
    return { ...e, slideIndex };
  });
  for (const e of emphasis) {
    const p = per.find((x) => x.index === e.slideIndex);
    if (p) p.emphasis.push(e);
  }

  const timeline = items.map((it, k) => ({
    chunkId: it.chunk.id,
    time: it.chunk.time ?? null,
    order: k,
    chars: it.chunk.text.length,
    slideIndex: slides[it.slidePos]?.index ?? null,
    offTopic: it.offTopic,
    sim: it.offTopic ? 0 : it.sims[it.slidePos],
  }));

  return { slides: per, progress, emphasis, previews, timeline, coverChars };
}

function viterbi(items, n, opt) {
  if (!items.length || !n) return [];
  const T = items.length;
  const score = Array.from({ length: T }, () => new Float64Array(n));
  const back = Array.from({ length: T }, () => new Int32Array(n));
  const emit = (it, j) => (it.max > 0 ? it.sims[j] / Math.max(it.max, opt.emitRef) : 0);
  const trans = (i, j) => {
    const d = j - i;
    if (d === 0) return 0;
    if (d > 0) return -opt.stepPenalty - opt.skipPenalty * (d - 1);
    return -opt.backPenalty - opt.skipPenalty * 0.5 * (-d - 1);
  };
  for (let j = 0; j < n; j++) score[0][j] = emit(items[0], j) - opt.startPenalty * j;
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

/** Split slides into covered (≤ progress) and upcoming (> progress) by slide index. */
export function splitByProgress(slides, progress) {
  return {
    covered: slides.filter((s) => s.index <= progress),
    upcoming: slides.filter((s) => s.index > progress),
  };
}
