// Parse an AI chat reply (often dirty: prose around it, ```json fences, smart quotes, trailing commas)
// into the normalized guide model. Pure functions.

export class ReplyError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ReplyError';
    this.hint = hint;
  }
}

/** Find balanced {...} object substrings, respecting JSON strings. */
export function findJsonObjects(text) {
  const out = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          start = i; // continue after this object
          break;
        }
      }
    }
    if (depth > 0) {
      out.push({ unterminated: text.slice(start) });
      break;
    }
  }
  return out;
}

function repairs(s) {
  return [
    s,
    s.replace(/,\s*([}\]])/g, '$1'),
    s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1'),
    s
      .replace(/[“”]/g, '"')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1'),
  ];
}

function tryParse(s) {
  for (const cand of repairs(s)) {
    try {
      return { ok: true, value: JSON.parse(cand) };
    } catch {
      /* next repair */
    }
  }
  return { ok: false };
}

/**
 * Extract the guide JSON object from a reply. Throws ReplyError with a Korean, user-facing message.
 */
export function extractJson(reply) {
  const text = String(reply ?? '').replace(/^﻿/, '').trim();
  if (!text) throw new ReplyError('붙여넣은 내용이 비어 있어요.', 'AI 채팅의 답변 전체를 복사해서 붙여넣어 주세요.');
  const candidates = [];
  // 1) fenced blocks first (```json … ``` or ``` … ```)
  const fence = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text))) candidates.push(m[1].trim());
  // 2) whole text
  candidates.push(text);
  let sawUnterminated = false;
  for (const c of candidates) {
    const direct = tryParse(c);
    if (direct.ok && direct.value && typeof direct.value === 'object' && !Array.isArray(direct.value)) return direct.value;
    const objs = findJsonObjects(c);
    // Prefer the largest object that parses and looks like a guide.
    const parsed = [];
    for (const o of objs) {
      if (typeof o !== 'string') {
        sawUnterminated = true;
        continue;
      }
      const r = tryParse(o);
      if (r.ok && r.value && typeof r.value === 'object') parsed.push({ len: o.length, value: r.value });
    }
    parsed.sort((a, b) => b.len - a.len);
    const guideLike = parsed.find((p) => looksLikeGuide(p.value));
    if (guideLike) return guideLike.value;
    if (parsed.length) return parsed[0].value;
  }
  if (sawUnterminated) {
    throw new ReplyError(
      'JSON이 중간에 끊긴 것 같아요 (괄호가 끝까지 닫히지 않았어요).',
      'AI 채팅에 "방금 JSON을 처음부터 끝까지 코드블록 하나로 다시 보내줘"라고 요청한 뒤 다시 붙여넣어 주세요.',
    );
  }
  throw new ReplyError(
    '답변에서 JSON을 찾지 못했어요.',
    '프롬프트를 그대로 보냈는지, 답변 전체(중괄호 { 부터 } 까지)를 복사했는지 확인해 주세요.',
  );
}

function looksLikeGuide(v) {
  return v && typeof v === 'object' && (Array.isArray(v.slides) || Array.isArray(v['슬라이드']) || Array.isArray(v.pages));
}

// ---------- normalization ----------

const KEY_ALIASES = {
  slides: ['slides', '슬라이드', 'pages', '해설'],
  slide: ['slide', '쪽', 'page', '슬라이드번호', 'slide_no'],
  title: ['title', '제목'],
  coverage: ['coverage', '진도', '다룬정도'],
  summary: ['summary', '핵심정리', '핵심 정리', 'key_points', 'core'],
  notes: ['notes', 'from_notes', 'note', '필기', '내 필기', '필기에서', '필기 내용'],
  emphasis: ['emphasis', '강조', '강조 포인트', '강조포인트'],
  pitfalls: ['pitfalls', '헷갈리기 쉬운 점', '헷갈리는점', 'confusions'],
  questions: ['recall_questions', 'questions', '회상문제', '회상 질문', 'quiz'],
  question: ['question', 'q', '질문'],
  answer: ['answer', 'a', '정답', '답'],
  type: ['type', '유형'],
  nextPreview: ['next_preview', '다음 수업 예고', 'next'],
  text: ['text', '내용', 'statement'],
  source: ['source', '출처'],
  refs: ['refs', '근거', 'evidence', 'ref'],
  quote: ['quote', '인용'],
};

function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of KEY_ALIASES[key] || [key]) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

export function normalizeSource(src, refs = [], fallback = 'ai') {
  const s = String(src ?? '').toLowerCase().replace(/\s+/g, '');
  if (/^(교안|slide|슬라이드|ppt|자료)/.test(s)) return 'slide';
  if (/^(필기|내필기|노트|메모|판서|note|notes|ink|수업|강의)/.test(s)) return 'note';
  if (/^(ai|추정|보충|guess)/.test(s)) return 'ai';
  if (refs.some((r) => refType(r) === 'note')) return 'note';
  if (refs.some((r) => refType(r) === 'slide')) return 'slide';
  return fallback;
}

/**
 * Canonical ref key, or null when the id is not a ref: "p03" → "P3", "N12" → "n12",
 * "ink-p5" / "ink5" / "INK-P05" → "ink-p5", "pan-p5" → "pan-p5" (교수님 판서본 page).
 */
export function refKey(id) {
  const s = String(id ?? '').trim().replace(/^\[|\]$/g, '');
  let m;
  if ((m = s.match(/^(ink|pan)[-_ ]?p?(\d{1,4})$/i))) return `${m[1].toLowerCase()}-p${Number(m[2])}`;
  if ((m = s.match(/^n(\d{1,5})$/i))) return 'n' + Number(m[1]);
  if ((m = s.match(/^p\.?(\d{1,4})$/i))) return 'P' + Number(m[1]);
  return null;
}

/** 'slide' for P-refs, 'note' for n / ink-p / pan-p refs. */
export function refType(r) {
  if (!r) return null;
  if (r[0] === 'P') return 'slide';
  if (r[0] === 'n' || r.startsWith('ink-') || r.startsWith('pan-')) return 'note';
  return null;
}

function normRefs(r) {
  if (r == null) return [];
  const arr = Array.isArray(r) ? r : String(r).split(/[,\s]+/);
  return [...new Set(arr.map(refKey).filter(Boolean))];
}

function normStatement(item, sectionDefault) {
  if (item == null) return null;
  if (typeof item === 'string') {
    const t = item.trim();
    return t ? { text: t, source: sectionDefault, refs: [] } : null;
  }
  const text = String(pick(item, 'text') ?? '').trim();
  if (!text) return null;
  const refs = normRefs(pick(item, 'refs'));
  const aiFlag = item.ai_guess === true || item['ai_추정'] === true || item.ai === true;
  let source = aiFlag ? 'ai' : normalizeSource(pick(item, 'source'), refs, sectionDefault);
  const st = { text, source, refs };
  const quote = pick(item, 'quote');
  if (quote) st.quote = String(quote).trim();
  return st;
}

function normList(v, sectionDefault) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => normStatement(x, sectionDefault)).filter(Boolean);
}

const QTYPES = ['예측', '개념', '계산'];

/**
 * Normalize any reasonable reply object to:
 * { slides:[{slide,title,coverage,summary[],notes[],emphasis[],pitfalls[]}], questions:[{slide,type,question,answer,refs}], course, week }
 */
export function normalizeGuide(raw) {
  if (!raw || typeof raw !== 'object') throw new ReplyError('JSON 형식이 해설지 형식이 아니에요.', '프롬프트의 스키마대로 다시 요청해 주세요.');
  const slidesRaw = pick(raw, 'slides');
  if (!Array.isArray(slidesRaw) || !slidesRaw.length) {
    throw new ReplyError('JSON 안에 "slides" 목록이 없어요.', 'AI에게 "스키마의 slides 배열을 포함해서 다시"라고 요청해 주세요.');
  }
  const slides = [];
  for (const s of slidesRaw) {
    const no = Number(String(pick(s, 'slide') ?? '').replace(/[^\d]/g, ''));
    if (!no) continue;
    slides.push({
      slide: no,
      title: String(pick(s, 'title') ?? '').trim(),
      coverage: String(pick(s, 'coverage') ?? '').trim(),
      summary: normList(pick(s, 'summary'), 'slide'),
      notes: normList(pick(s, 'notes'), 'note'),
      emphasis: normList(pick(s, 'emphasis'), 'note'),
      pitfalls: normList(pick(s, 'pitfalls'), 'ai'),
    });
  }
  if (!slides.length) throw new ReplyError('slides 안에 쪽 번호(slide)가 있는 항목이 없어요.', '각 항목에 "slide": 숫자 가 있어야 해요.');
  slides.sort((a, b) => a.slide - b.slide);

  const qRaw = pick(raw, 'questions');
  const questions = (Array.isArray(qRaw) ? qRaw : [])
    .map((q) => {
      const question = String(pick(q, 'question') ?? '').trim();
      const answer = String(pick(q, 'answer') ?? '').trim();
      if (!question || !answer) return null;
      const t = String(pick(q, 'type') ?? '').trim();
      return {
        slide: Number(String(pick(q, 'slide') ?? '').replace(/[^\d]/g, '')) || null,
        type: QTYPES.find((x) => t.includes(x)) || '개념',
        question,
        answer,
        refs: normRefs(pick(q, 'refs')),
      };
    })
    .filter(Boolean);

  return {
    course: raw.course ? String(raw.course) : undefined,
    week: raw.week != null ? Number(raw.week) || undefined : undefined,
    slides,
    questions,
  };
}

/** One call: dirty text → normalized guide. */
export function parseReply(text) {
  return normalizeGuide(extractJson(text));
}
