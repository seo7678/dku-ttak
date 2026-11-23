// Professor-emphasis cues and "next time" previews, detected per sentence. Deterministic.

export const EMPHASIS_CUES = [
  { key: '시험', label: '시험', re: /시험/ },
  { key: '출제', label: '출제', re: /(?:시험|문제|퀴즈)[^.?!]{0,14}(?:나와|나옵|나온|낼|냅|낸다|출제)|(?:나와요|나옵니다|나온다)[^.?!]{0,8}시험/ },
  { key: '중요', label: '중요', re: /중요/ },
  { key: '꼭', label: '꼭', re: /꼭(?![짓지대])/ },
  { key: '암기', label: '암기', re: /외워|외우|외울|암기/ },
  { key: '반복', label: '다시 한 번', re: /다시\s?한\s?번|한\s?번\s?더\s?(?:말|강조)/ },
  { key: '포인트', label: '포인트', re: /포인트|핵심/ },
  { key: '주의', label: '헷갈림 주의', re: /헷갈|혼동|실수/ },
];

// "다음 시간에 하겠습니다", "다음 주에 볼게요" … — the professor announcing what is NOT covered today.
export const PREVIEW_RE = /다음\s?(?:시간|주|수업|차시|번)|다음에\s?(?:하|보|할|다루|설명)|다음 장에서/;

export function emphasisCues(sentence) {
  const s = String(sentence);
  const hits = [];
  for (const c of EMPHASIS_CUES) if (c.re.test(s)) hits.push(c.key);
  // "출제" already implies "시험"; keep the stronger label only.
  if (hits.includes('출제')) return hits.filter((k) => k !== '시험');
  return hits;
}

export function isPreviewSentence(sentence) {
  return PREVIEW_RE.test(String(sentence));
}

export function cueLabel(key) {
  return EMPHASIS_CUES.find((c) => c.key === key)?.label ?? key;
}

/**
 * Find emphasis sentences in transcript chunks.
 * @returns {{chunkId:string, sentenceIndex:number, sentence:string, cues:string[], time:number|null}[]}
 */
export function detectEmphasis(chunks) {
  const out = [];
  for (const ch of chunks) {
    ch.sentences.forEach((s, i) => {
      if (isPreviewSentence(s)) return;
      const cues = emphasisCues(s);
      if (cues.length) out.push({ chunkId: ch.id, sentenceIndex: i, sentence: s, cues, time: ch.time ?? null });
    });
  }
  return out;
}
