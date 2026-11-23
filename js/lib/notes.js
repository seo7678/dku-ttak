// 타이핑 필기 parsing: the student's own typed notes (paste or .txt/.md), optionally anchored to 교안 pages.
// Anchor forms (at the start of a line): p.12 · p12 · P. 12 · 12쪽 · 12p · [12] · [p.12] · #12 · 슬라이드 12 ·
// 페이지 12 · --- 12 ---. An anchor applies to the following lines until the next anchor, a bare separator line
// (--- / === / ***), or two blank lines in a row. Lines before the first anchor (or after a separator) are
// unanchored and get aligned to slides by coverage.js. Pure functions; ids are stable for the same input.
import { normalizeText } from './text.js';
import { isPreviewLine } from './emphasis.js';

const TAIL = String.raw`(?=$|[\s:.)\]\-–—,>~])`; // an anchor must be followed by end / space / punctuation
const ANCHOR_RES = [
  // [12]  [p.12]  [12쪽]
  new RegExp(String.raw`^\[\s*(?:p\.?\s*|슬라이드\s*|페이지\s*)?(\d{1,3})\s*(?:쪽|p)?\s*\]`, 'i'),
  // #12
  new RegExp(String.raw`^#\s?(\d{1,3})${TAIL}`),
  // p.12  p12  P. 12
  new RegExp(String.raw`^p\.?\s?(\d{1,3})${TAIL}`, 'i'),
  // 12쪽  12p  12 p  12페이지
  new RegExp(String.raw`^(\d{1,3})\s?(?:쪽|페이지|p(?![a-z]))${TAIL}`, 'i'),
  // 슬라이드 12  페이지 12  slide 12  page 12
  new RegExp(String.raw`^(?:슬라이드|페이지|slide|page)\s*(\d{1,3})${TAIL}`, 'i'),
  // --- 12 ---   === p.12 ===
  /^[-=]{3,}\s*(?:p\.?\s*)?(\d{1,3})\s*(?:쪽)?\s*[-=]*\s*$/i,
];
const SEPARATOR_RE = /^(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/;

/**
 * Detect a page anchor at the start of a line.
 * @returns null | { page:number, rest:string, prev:boolean }  (prev: "지난주 p.9" hint for merged decks)
 */
export function parseAnchor(line) {
  let s = String(line ?? '').trim();
  const prev = /^(?:지난\s?주|지난\s?시간|지난)\s*/.test(s);
  if (prev) s = s.replace(/^(?:지난\s?주|지난\s?시간|지난)\s*/, '');
  // Markdown headings / bullets before an anchor: "## p.3", "- 12쪽". "#12" itself is an anchor form.
  if (!/^#\d/.test(s)) s = s.replace(/^(?:#{1,6}\s+|[-*•·>]\s+)/, '');
  for (const re of ANCHOR_RES) {
    const m = s.match(re);
    if (!m) continue;
    let rest = s.slice(m[0].length);
    // "p.3~5", "p.3-5": a page range — anchor to the first page, drop the range tail.
    rest = rest.replace(/^\s*[~\-–]\s*\d{1,3}\s*(?:쪽|p)?/, '');
    rest = rest.replace(/^\s*[:.)\]\-–—,>]*\s*/, '').trim();
    return { page: Number(m[1]), rest, prev };
  }
  return null;
}

/**
 * Map a page number written in the notes to a slide index of the (possibly merged) deck.
 * Labels win over positions: in a merged week-4 deck "p.9" means last week's 9쪽, "p.1" this week's 1쪽.
 */
export function resolvePage(num, slides, prevHint = false) {
  if (!slides) return num;
  const hits = slides.filter((s) => String(s.label) === String(num));
  if (hits.length === 1) return hits[0].index;
  if (hits.length > 1) {
    const pick = hits.find((s) => (prevHint ? s.carriedFrom : !s.carriedFrom)) || hits[0];
    return pick.index;
  }
  return null;
}

/**
 * Parse typed notes.
 * @param {string} raw
 * @param {{index:number,label:string,carriedFrom?:number}[]} [slides] — when given, anchors are resolved to slide indices
 * @returns {{ items: {id:string,line:number,para:number,page:number|null,written:number|null,anchored:boolean,text:string,preview:boolean}[], warnings:string[], anchors:number }}
 */
export function parseNotes(raw, slides = null) {
  const lines = normalizeText(raw).split('\n');
  const items = [];
  const warnings = [];
  const outOfRange = new Set();
  let current = null; // { page, written } or null
  let para = 0;
  let blank = 0;
  let anchors = 0;
  let k = 0;
  lines.forEach((rawLine, lineNo) => {
    const line = rawLine.replace(/\t/g, ' ').trim();
    if (!line) {
      blank++;
      if (blank === 1) para++;
      if (blank >= 2) current = null;
      return;
    }
    blank = 0;
    if (SEPARATOR_RE.test(line)) {
      current = null;
      para++;
      return;
    }
    let text = line;
    const a = parseAnchor(line);
    if (a) {
      anchors++;
      para++;
      const page = resolvePage(a.page, slides, a.prev);
      if (page == null) {
        outOfRange.add(a.page);
        current = null;
      } else current = { page, written: a.page };
      text = a.rest;
      if (!text) return;
    }
    items.push({
      id: 'n' + ++k,
      line: lineNo + 1,
      para,
      page: current ? current.page : null,
      written: current ? current.written : null,
      anchored: !!current,
      text,
      preview: isPreviewLine(text),
    });
  });
  if (outOfRange.size) {
    warnings.push(`교안에 없는 쪽 번호(${[...outOfRange].sort((a, b) => a - b).join(', ')}쪽)가 적혀 있어, 그 아래 필기는 내용으로 쪽을 찾았어요.`);
  }
  return { items, warnings, anchors };
}

/** Group consecutive unanchored lines of the same paragraph, and consecutive anchored lines of the same page. */
export function noteBlocks(items) {
  const blocks = [];
  let cur = null;
  for (const it of items) {
    if (it.preview) continue;
    const key = it.anchored ? `a${it.page}:${it.para}` : `u${it.para}`;
    if (!cur || cur.key !== key) {
      cur = { key, fixed: it.anchored ? it.page : null, items: [] };
      blocks.push(cur);
    }
    cur.items.push(it);
  }
  return blocks.map((b) => ({ ...b, text: b.items.map((x) => x.text).join('\n') }));
}
