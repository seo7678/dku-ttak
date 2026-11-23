// Parsing of slide text (pasted or extracted from PDF) and lecture transcripts (txt / srt / vtt /
// Clova-Note-style speaker+timestamp exports). Pure functions.
import { normalizeText, splitSentences } from './text.js';

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

// ---------- transcripts ----------

const TS = String.raw`(\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const CUE_RE = new RegExp(String.raw`^\s*(${TS})\s*-->\s*(${TS})`);
// "참석자 1 00:12", "화자 2  01:02:03", "Speaker 1 00:12", "홍길동 03:10"
const SPEAKER_TS_RE = /^\s*([^\s\d:][^:\n]{0,20}?)\s+((?:\d{1,2}:)?\d{1,2}:\d{2})\s*$/;
// "[00:12] text", "(00:12) text", "00:12 text"
const INLINE_TS_RE = /^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s+(.+)$/;

export function parseTimestamp(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, h, mi, se, ms] = m;
  return (Number(h || 0) * 3600) + Number(mi) * 60 + Number(se) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0);
}

function stripCueMarkup(s) {
  return s.replace(/<\/?[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
}

export function detectTranscriptFormat(raw, filename = '') {
  const t = normalizeText(raw).trimStart();
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'vtt' || /^WEBVTT/.test(t)) return 'vtt';
  if (ext === 'srt' || /^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t)) return 'srt';
  const lines = t.split('\n').slice(0, 60);
  if (lines.filter((l) => SPEAKER_TS_RE.test(l)).length >= 2) return 'speaker';
  if (lines.filter((l) => INLINE_TS_RE.test(l)).length >= 2) return 'timestamped';
  return 'plain';
}

/**
 * Parse a transcript into segments [{time, speaker, text}] (time in seconds or null).
 */
export function parseTranscript(raw, filename = '') {
  const text = normalizeText(raw);
  const format = detectTranscriptFormat(text, filename);
  const segments = [];
  const lines = text.split('\n');

  if (format === 'vtt' || format === 'srt') {
    let cur = null;
    for (const line of lines) {
      const cue = line.match(CUE_RE);
      if (cue) {
        if (cur && cur.text.trim()) segments.push(cur);
        cur = { time: parseTimestamp(cue[1]), speaker: null, text: '' };
        continue;
      }
      if (!cur) continue; // header, NOTE blocks, indices before the first cue
      const s = line.trim();
      if (!s) {
        if (cur.text.trim()) segments.push(cur);
        cur = null;
        continue;
      }
      if (/^\d+$/.test(s) && !cur.text) continue;
      let body = s;
      const v = s.match(/^<v\s+([^>]+)>/);
      if (v) cur.speaker = v[1].trim();
      body = stripCueMarkup(body);
      if (body) cur.text += (cur.text ? ' ' : '') + body;
    }
    if (cur && cur.text.trim()) segments.push(cur);
    return { format, segments: mergeShortCues(segments) };
  }

  if (format === 'speaker') {
    let cur = null;
    for (const line of lines) {
      const m = line.match(SPEAKER_TS_RE);
      if (m) {
        if (cur && cur.text.trim()) segments.push(cur);
        cur = { time: parseTimestamp(m[2]), speaker: m[1].trim(), text: '' };
        continue;
      }
      const s = line.trim();
      if (!s) continue;
      if (!cur) cur = { time: null, speaker: null, text: '' };
      cur.text += (cur.text ? ' ' : '') + s;
    }
    if (cur && cur.text.trim()) segments.push(cur);
    return { format, segments };
  }

  if (format === 'timestamped') {
    let cur = null;
    for (const line of lines) {
      const m = line.match(INLINE_TS_RE);
      if (m) {
        if (cur && cur.text.trim()) segments.push(cur);
        cur = { time: parseTimestamp(m[1]), speaker: null, text: m[2].trim() };
        continue;
      }
      const s = line.trim();
      if (!s) continue;
      if (!cur) cur = { time: null, speaker: null, text: '' };
      cur.text += (cur.text ? ' ' : '') + s;
    }
    if (cur && cur.text.trim()) segments.push(cur);
    return { format, segments };
  }

  for (const para of text.split(/\n\s*\n/)) {
    const s = para.replace(/\s*\n\s*/g, ' ').trim();
    if (s) segments.push({ time: null, speaker: null, text: s });
  }
  return { format, segments };
}

// Subtitle cues are a few words each; merge into ~sentence-sized segments.
function mergeShortCues(cues) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) {
      cur = { ...c };
      continue;
    }
    const endsSentence = /[.?!。]$/.test(cur.text);
    if (cur.text.length < 60 && !endsSentence) cur.text += ' ' + c.text;
    else {
      out.push(cur);
      cur = { ...c };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Group transcript segments into alignment chunks with stable ids (T01, T02 …).
 * A chunk never spans two segments that are each long enough on their own, and long segments
 * are split on sentence boundaries.
 */
export function chunkTranscript(segments, { target = 200, max = 420 } = {}) {
  const chunks = [];
  let buf = null;
  const flush = () => {
    if (buf && buf.sentences.length) {
      chunks.push(buf);
    }
    buf = null;
  };
  for (const seg of segments) {
    const sentences = splitSentences(seg.text);
    if (!sentences.length) continue;
    const segLen = seg.text.length;
    if (buf && (buf.text.length >= target * 0.25 || segLen >= target * 0.25)) flush();
    for (const s of sentences) {
      if (!buf) buf = { time: seg.time, text: '', sentences: [] };
      if (buf.text.length && buf.text.length + s.length > max) {
        flush();
        buf = { time: seg.time, text: '', sentences: [] };
      }
      buf.sentences.push(s);
      buf.text += (buf.text ? ' ' : '') + s;
    }
  }
  flush();
  const pad = String(chunks.length).length < 2 ? 2 : String(chunks.length).length;
  return chunks.map((c, i) => ({ id: 'T' + String(i + 1).padStart(pad, '0'), ...c }));
}
