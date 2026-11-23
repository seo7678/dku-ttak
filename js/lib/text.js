// Korean-friendly text features: character n-grams for Hangul, whole tokens for Latin/numbers.
// Pure functions only (no DOM) so they run in the browser and under `node --test`.

// Order matters: subscripted math identifiers (x_l, x_{i+1}, ε_a) before plain Latin words.
const WORD_RE = /[a-zͰ-Ͽ]_\{?[a-z0-9+\-]+\}?|[가-힣]+|[a-z][a-z0-9]*|\d+(?:\.\d+)?|[Ͱ-Ͽ]+/g;

// Very common spoken/written Hangul fragments that carry no topic signal.
const STOP_HANGUL = new Set([
  '그래서', '그러니까', '이제', '여러분', '우리', '합니다', '있습니다', '거예요', '겁니다', '있어요',
  '이거', '그거', '저거', '이렇게', '그렇게', '하는', '하고', '해서', '하면', '그런데', '근데', '그리고',
  '네', '자', '음', '어', '좀', '뭐', '거', '것', '수', '때', '더', '잘', '또', '이', '그', '저',
]);

export function normalizeText(s) {
  return String(s ?? '').normalize('NFC').replace(/\r\n?/g, '\n');
}

/** Split text into lowercase word tokens (Hangul runs, Latin words, numbers, Greek). */
export function words(text) {
  return normalizeText(text).toLowerCase().match(WORD_RE) || [];
}

/**
 * Feature extraction. Hangul words → character bigrams + trigrams (robust to particles such as
 * 이분법은/이분법을), Latin words of length ≥ 2 and numbers → whole-token features.
 * Returns Map<feature, count>.
 */
export function features(text) {
  const out = new Map();
  const add = (f) => out.set(f, (out.get(f) || 0) + 1);
  for (const w of words(text)) {
    const first = w.charCodeAt(0);
    if (first >= 0xac00 && first <= 0xd7a3) {
      if (w.length < 2 || STOP_HANGUL.has(w)) continue;
      for (let i = 0; i + 2 <= w.length; i++) add('h2:' + w.slice(i, i + 2));
      for (let i = 0; i + 3 <= w.length; i++) add('h3:' + w.slice(i, i + 3));
    } else if (w.includes('_')) {
      add('m:' + w.replace(/[{}]/g, ''));
    } else if (/^\d/.test(w)) {
      if (w.length >= 2) add('n:' + w);
    } else if (w.length >= 2) {
      add('l:' + w);
    }
  }
  return out;
}

/** Inverse document frequency over a list of feature maps. */
export function idfOf(docs) {
  const df = new Map();
  for (const d of docs) for (const f of d.keys()) df.set(f, (df.get(f) || 0) + 1);
  const n = docs.length;
  const idf = new Map();
  for (const [f, c] of df) idf.set(f, Math.log(1 + n / c));
  return idf;
}

/** Sublinear TF-IDF vector restricted to features known by idf. */
export function tfidf(feat, idf) {
  const v = new Map();
  let norm = 0;
  for (const [f, c] of feat) {
    const w = idf.get(f);
    if (!w) continue;
    const x = (1 + Math.log(c)) * w;
    v.set(f, x);
    norm += x * x;
  }
  return { v, norm: Math.sqrt(norm) };
}

export function cosine(a, b) {
  if (!a.norm || !b.norm) return 0;
  const [small, big] = a.v.size < b.v.size ? [a.v, b.v] : [b.v, a.v];
  let dot = 0;
  for (const [f, x] of small) {
    const y = big.get(f);
    if (y) dot += x * y;
  }
  return dot / (a.norm * b.norm);
}

/** Character-bigram Dice overlap in [0,1] — used for fuzzy quote checks. */
export function bigramOverlap(needle, haystack) {
  const grams = (s) => {
    const t = normalizeText(s).toLowerCase().replace(/\s+/g, '');
    const m = new Map();
    for (let i = 0; i + 2 <= t.length; i++) {
      const g = t.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const a = grams(needle);
  if (!a.size) return 0;
  const b = grams(haystack);
  let hit = 0;
  let total = 0;
  for (const [g, c] of a) {
    total += c;
    hit += Math.min(c, b.get(g) || 0);
  }
  return hit / total;
}

/** Split Korean/English prose into sentences, keeping punctuation. */
export function splitSentences(text) {
  // Protect decimals (1.5214) and "p.3"-style references before splitting on periods.
  const DOT = '․';
  const t = normalizeText(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/(\d)\.(?=\d)/g, '$1' + DOT)
    .replace(/\b([a-zA-Z])\.(?=\s?\d)/g, '$1' + DOT);
  const parts = [];
  for (const line of t.split(/\n+/)) {
    const pieces = line.match(/[^.?!。…]+(?:[.?!。…]+["'”’)]*|$)/g) || [];
    for (const p of pieces) {
      const s = p.trim();
      if (s) parts.push(s.split(DOT).join('.'));
    }
  }
  // Re-attach tiny fragments to the previous sentence.
  const merged = [];
  for (const s of parts) {
    const prev = merged[merged.length - 1];
    if (prev && s.length < 4) merged[merged.length - 1] = prev + ' ' + s;
    else merged.push(s);
  }
  return merged;
}

export function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
