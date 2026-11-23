// Parsing of slide text (pasted or extracted from PDF). Pure functions.
import { normalizeText } from './text.js';

// ---------- slides ----------

const SEP_PATTERNS = [
  // --- 3 ---   === p.3 ===   ---   ===== 슬라이드 3 =====
  /^\s*(?:-{3,}|={3,}|#{3,})\s*(?:(?:p\.?|page|slide|슬라이드|페이지)\s*)?(\d{1,3})?\s*(?:쪽|p)?\s*(?:-{3,}|={3,}|#{3,})?\s*$/i,
  // [3]  [슬라이드 3]  [p.3]  [3쪽]
  /^\s*\[\s*(?:(?:p\.?|page|slide|슬라이드|페이지)\s*)?(\d{1,3})\s*(?:쪽)?\s*\]\s*$/i,
  // 슬라이드 3   Slide 3:   Page 3   p.3
  /^\s*(?:p\.|page|slide|슬라이드|페이지)\s*(\d{1,3})\s*[:.)]?\s*$/i,
];

function matchSeparator(line) {
  if (line.includes('\f')) return { num: null };
  for (const re of SEP_PATTERNS) {
    const m = line.match(re);
    if (m) return { num: m[1] ? Number(m[1]) : null };
  }
  return null;
}

export function titleOf(text) {
  const first = normalizeText(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return '(빈 쪽)';
  const t = first.replace(/^(?:[•·\-–*#]+\s*|\d{1,2}[.)]\s+)/, '').trim() || first;
  return t.length > 48 ? t.slice(0, 47) + '…' : t;
}

function mkSlide(index, text, label) {
  const clean = normalizeText(text).replace(/\f/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { index, label: label ?? String(index), title: titleOf(clean), text: clean };
}

/**
 * Split pasted slide text into slides.
 * Separators: lines such as `--- 3 ---`, `[3]`, `슬라이드 3`, `p.3`, `===`, or a form-feed.
 * Fallback: blocks separated by two or more blank lines.
 */
export function parseSlides(raw) {
  const text = normalizeText(raw).replace(/\f/g, '\n\f\n');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const blocks = [];
  let cur = [];
  let sawSep = false;
  for (const line of lines) {
    const sep = matchSeparator(line);
    if (sep) {
      sawSep = true;
      if (cur.join('').trim()) blocks.push(cur.join('\n'));
      cur = [];
      const rest = line.replace(/\f/g, '');
      if (line.includes('\f') && rest.trim()) cur.push(rest);
    } else {
      cur.push(line);
    }
  }
  if (cur.join('').trim()) blocks.push(cur.join('\n'));
  let chunks = blocks;
  if (!sawSep) {
    chunks = text.split(/\n\s*\n\s*\n+/).filter((b) => b.trim());
  }
  return chunks.map((b, i) => mkSlide(i + 1, b));
}

/** Slides from per-page PDF text (pdf.js output). Empty pages are kept so page numbers stay true. */
export function slidesFromPages(pages) {
  return pages.map((p, i) => mkSlide(i + 1, p || '', String(i + 1)));
}
