// Emphasis marks in notes (★, !, 중요, 시험 …) and "다음 시간" preview lines, detected per note line.
// Deterministic — a fixed dictionary, no AI.

export const EMPHASIS_CUES = [
  // ★ ☆, "**", or an asterisk glued to a word ("*중요"). A bullet "* 항목" or "a * b" does not count.
  { key: '별표', label: '★ 별표', re: /[★☆]|\*{2,}|(?:^|\s)\*(?=[^\s*])/ },
  // "!!", or "!" after Hangul / a closing bracket / space. Excludes "n!" (factorial) and "!=".
  { key: '느낌표', label: '! 느낌표', re: /!{2,}|(?:^|[가-힣\s)\]'′])!(?!=)/ },
  { key: '중요', label: '중요', re: /중요/ },
  { key: '시험', label: '시험', re: /시험|출제/ },
  { key: '기출', label: '기출', re: /기출/ },
  { key: '암기', label: '암기', re: /외워|외우|외울|암기/ },
  { key: '헷갈', label: '헷갈림 주의', re: /헷갈|혼동/ },
];

// "다음 시간: …", "다음 주에 …", "다음 수업" — a note about what was NOT taught today. Never moves the 진도선.
export const PREVIEW_RE = /다음\s?(?:시간|주|수업|차시|번\s?시간)|다음에\s?(?:하|보|할|다루|설명|이어)|다음 장에서/;

export function emphasisCues(line) {
  const s = String(line ?? '');
  return EMPHASIS_CUES.filter((c) => c.re.test(s)).map((c) => c.key);
}

export function isPreviewLine(line) {
  return PREVIEW_RE.test(String(line ?? ''));
}

export function cueLabel(key) {
  return EMPHASIS_CUES.find((c) => c.key === key)?.label ?? key;
}

/**
 * Emphasis pins from note lines.
 * @param {{id:string,text:string,preview:boolean}[]} items
 * @returns {{noteId:string, text:string, cues:string[]}[]}
 */
export function detectEmphasis(items) {
  const out = [];
  for (const it of items) {
    if (it.preview) continue;
    const cues = emphasisCues(it.text);
    if (cues.length) out.push({ noteId: it.id, text: it.text, cues });
  }
  return out;
}
