// 딱 거기까지 — UI controller. Logic lives in ./lib (pure, tested); this file only wires DOM.
import { $, $$, h, svg, clear, toast, copyText, download, readFileText, store } from './ui/dom.js';
import { extractPdfPages, renderGrayPages, renderJpegPages, qrSvg } from './ui/vendor.js';
import { parseSlides, slidesFromPages } from './lib/parse.js';
import { analyzeLecture } from './lib/pipeline.js';
import { STATUS, STATUS_LABEL } from './lib/coverage.js';
import { cueLabel } from './lib/emphasis.js';
import { buildPrompt, buildTranscribePrompt, INK_KIND } from './lib/prompt.js';
import { parseReply, normalizeGuide, ReplyError, refType } from './lib/reply.js';
import { verifyGuide, noteOrigin, NOTE_ORIGIN } from './lib/verify.js';
import { generateWithGemini, DEFAULT_MODEL } from './lib/gemini.js';
import { inkRatio, pageInk, suggestProgress } from './lib/ink.js';
import { saveWeek, getCarryOver, mergeCarryOver, loadCourses, memoryStorage, courseKey } from './lib/weeks.js';
import { guideToMarkdown, SURVEY_ITEMS, BASELINE_ITEMS, PROGRESS_OFF_OPTIONS, buildSurveyResult } from './lib/export.js';
import * as Q from './lib/quiz.js';
import { emptyRun, mark, runSummary, formatDuration, loadRun, saveRun } from './lib/metrics.js';
import * as DEMO from './data/demo-lecture.js';

const KEYS = { guide: 'ttak.v2.lastGuide', quiz: 'ttak.v2.lastQuiz', gemKey: 'ttak.v1.geminiKey', gemModel: 'ttak.v1.geminiModel' };
const storage = store.raw() || memoryStorage();
const VIEWS = ['home', 'make', 'guide', 'quiz', 'survey', 'about'];
const SRC_CLASS = { slide: 'slide', note: 'note', ai: 'ai' };
const SRC_TAG = { slide: '교안', note: '필기', ai: 'AI 보충' };
const MAX_INK_IMAGES = 30; // Gemini: at most this many annotated pages are sent as images
const INK_WORD = { mine: '필기', pan: '판서' };

const S = {
  slidesMode: 'pdf',
  pdfSlides: null,
  pdfFile: null, // clean 교안 PDF (needed for ink comparison)
  inkFile: null, // 필기한 교안 PDF (mine) or 교수님 판서본 (pan)
  inkKind: 'mine',
  ink: null, // { ratios, statuses, baseCount, inkCount, base, file }
  inkBusy: null,
  carry: null,
  analysis: null,
  autoProgress: 0,
  progress: 0,
  input: { course: '', week: 1 },
  isDemo: false,
  engine: 'paste',
  prompt: null,
  doc: readJSON(KEYS.guide),
  quiz: readJSON(KEYS.quiz),
  run: loadRun(storage),
  filters: { slide: true, note: true, ai: true },
  step: 1,
};

function readJSON(k) {
  try {
    return JSON.parse(store.get(k) || 'null');
  } catch {
    return null;
  }
}
const writeJSON = (k, v) => store.set(k, JSON.stringify(v));
const lab = (doc, n) => {
  const v = doc?.labels?.[n];
  return v == null ? String(n) : v;
};
const REF_TITLE = { slide: '교안 쪽', typed: NOTE_ORIGIN.typed + ' 줄', ink: NOTE_ORIGIN.ink + ' 쪽', pan: NOTE_ORIGIN.pan + ' 쪽' };
function refChip(r) {
  const origin = noteOrigin(r);
  const t = refType(r) === 'slide' ? 'slide' : origin;
  return h('span.ref', { class: t === 'slide' ? 'ref--p' : t === 'ink' || t === 'pan' ? 'ref--ink' : null, title: REF_TITLE[t] || '' }, r);
}

// ======================= router =======================
function route() {
  const hash = location.hash;
  if (hash === '#main' || hash === '#why-not-gpt') return;
  const name = hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  const v = VIEWS.includes(name) ? name : 'home';
  for (const el of $$('[data-view]')) el.hidden = el.dataset.view !== v;
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === v) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const titles = { home: '', make: '만들기', guide: '해설지', quiz: '회상 퀴즈', survey: '사용 후기', about: '소개' };
  document.title = (titles[v] ? titles[v] + ' · ' : '') + '딱 거기까지 — 오늘 수업이 끝난 데까지만 만드는 AI 해설지';
  if (v === 'guide') renderGuide();
  if (v === 'quiz') renderQuiz();
  if (v === 'survey') renderSurvey();
  if (v === 'make') refreshCourseList();
  const after = S.afterRoute;
  S.afterRoute = null;
  if (after) after();
  else {
    window.scrollTo(0, 0);
    $('#main').focus({ preventScroll: true });
  }
}

/** Navigate, then run `after` once the view is shown (instead of scrolling to the top). */
function go(hash, after) {
  if (location.hash === hash) {
    if (after) after();
    return;
  }
  S.afterRoute = after || null;
  location.hash = hash;
}

// ======================= metrics =======================
function markRun(event) {
  if (event === 'start' && S.run.guideAt) S.run = emptyRun();
  S.run = mark(S.run, event);
  saveRun(storage, S.run);
}
function resetRun() {
  S.run = emptyRun();
  saveRun(storage, S.run);
}

// ======================= home =======================
function renderHeroStrip() {
  const el = $('#hero-strip');
  if (!el) return;
  clear(el);
  const light = 7;
  const stars = new Set([3, 4, 5, 8]);
  for (let i = 1; i <= 12; i++) {
    const cls = i === light ? 'is-light' : i <= 8 ? 'is-ink' : '';
    const cell = h('div', { class: ['ms', cls], style: { '--i': String(i) } }, String(i));
    if (stars.has(i)) cell.append(h('span.star', { 'aria-hidden': 'true' }, '★'));
    el.append(cell);
  }
  const line = h('div.ms-line', h('span', '진도선'));
  const next = h('div.ms-next', '다음 주 →');
  el.append(line, next);
  requestAnimationFrame(() => {
    const cells = el.querySelectorAll('.ms');
    const a = cells[7];
    const b = cells[8];
    const x = (a.offsetLeft + a.offsetWidth + b.offsetLeft) / 2;
    line.style.setProperty('left', x + 'px');
    next.style.setProperty('left', b.offsetLeft + 8 + 'px');
  });
}

// ======================= make: step 1 =======================
function setSlidesMode(mode) {
  S.slidesMode = mode;
  for (const b of $$('[data-slides-mode]')) {
    const on = b.dataset.slidesMode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('#slides-pdf').hidden = mode !== 'pdf';
  $('#slides-text-wrap').hidden = mode !== 'text';
}

function showStep(n, scroll = true) {
  S.step = n;
  $('#step-coverage').hidden = n < 2;
  $('#step-generate').hidden = n < 3;
  for (const li of $$('.stepper li')) {
    const k = Number(li.dataset.step);
    li.classList.toggle('is-current', k === n);
    li.classList.toggle('is-done', k < n);
    if (k === n) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
  if (scroll) {
    const target = n === 1 ? $('#step-input') : n === 2 ? $('#step-coverage') : $('#step-generate');
    requestAnimationFrame(() => target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
  }
}

function refreshCourseList() {
  const dl = $('#course-list');
  clear(dl);
  for (const c of Object.values(loadCourses(storage))) dl.append(h('option', { value: c.name }));
}

function updateCarry() {
  const course = $('#course').value.trim();
  const week = Number($('#week').value);
  const box = $('#carry');
  S.carry = course && week ? getCarryOver(storage, course, week) : null;
  clear(box);
  if (!S.carry) {
    box.hidden = true;
    return;
  }
  const c = S.carry;
  box.hidden = false;
  box.append(
    h('div.carry__head', h('span.carry__icon', { 'aria-hidden': 'true' }, '↩'), h('div', h('p.carry__msg', c.message), c.stoppedTitle ? h('p.carry__sub', `지난주 마지막으로 나간 쪽: ${c.stoppedLabel}쪽 「${c.stoppedTitle}」`) : null)),
  );
  if (c.uncovered.length) {
    box.append(h('div.carry__pages', c.uncovered.map((u) => h('span', `${u.label}. ${u.title}`))));
    box.append(h('label.check', h('input', { type: 'checkbox', id: 'carry-merge', checked: true }), `지난주 남은 ${c.uncovered.length}쪽을 이번 주 교안 앞에 붙여서 진도 찾기`));
  }
  if (courseKey(course) === courseKey(DEMO.DEMO_COURSE) && week === 4) {
    box.append(h('div.actions.actions--tight', h('button.btn.btn--small', { type: 'button', onClick: () => demoFillWeek4() }, '예시 4주차 교안 · 필기 채우기')));
  }
}

function inputError(msg) {
  const e = $('#input-error');
  e.textContent = msg;
  e.hidden = !msg;
  if (msg) e.scrollIntoView({ block: 'center' });
}

function clearInk() {
  S.inkFile = null;
  S.ink = null;
  S.inkBusy = null;
  $('#ink-file').value = '';
  $('#ink-status').textContent = '';
}

function demoFill() {
  resetRun();
  markRun('start');
  $('#course').value = DEMO.DEMO_COURSE;
  $('#week').value = String(DEMO.DEMO_WEEK);
  setSlidesMode('text');
  $('#slides-text').value = DEMO.DEMO_SLIDES_TEXT;
  $('#notes').value = DEMO.DEMO_NOTES;
  S.pdfSlides = null;
  S.pdfFile = null;
  $('#pdf-status').textContent = '';
  clearInk();
  $('#notes-status').textContent = '예시 타이핑 필기 (창작) · 1–8쪽에 쪽 번호가 달려 있어요';
  inputError('');
  updateCarry();
  // the demo itself never merges an older demo week
  const m = $('#carry-merge');
  if (m) m.checked = false;
}

function demoFillWeek4() {
  resetRun();
  markRun('start');
  setSlidesMode('text');
  $('#slides-text').value = DEMO.DEMO_WEEK4_SLIDES_TEXT;
  $('#notes').value = DEMO.DEMO_WEEK4_NOTES;
  clearInk();
  $('#notes-status').textContent = '예시 4주차 타이핑 필기 (창작)';
  toast('예시 4주차를 채웠어요. “진도 찾기”를 눌러 보세요.');
}

function isDemoInput(slides) {
  return (
    S.slidesMode === 'text' &&
    $('#slides-text').value === DEMO.DEMO_SLIDES_TEXT &&
    $('#notes').value === DEMO.DEMO_NOTES &&
    !S.ink &&
    slides.length === 12 &&
    !slides.some((s) => s.carriedFrom)
  );
}

function currentSlides() {
  return S.slidesMode === 'pdf' ? S.pdfSlides || [] : parseSlides($('#slides-text').value);
}

// ----- 필기한 교안 PDF ↔ 깨끗한 교안: per-page ink -----
async function compareInk() {
  const status = $('#ink-status');
  const file = S.inkFile;
  const base = S.pdfFile;
  if (!file) {
    status.textContent = '';
    S.ink = null;
    return;
  }
  if (S.ink && S.ink.file === file && S.ink.base === base) return renderInkStatus();
  S.ink = null;
  if (!base) {
    status.textContent = `「${file.name}」 준비됨 — 쪽마다 비교하려면 ① 교안도 PDF로 올려 주세요.`;
    return;
  }
  const job = (async () => {
    const b = await renderGrayPages(base, { width: 320, onProgress: (i, n) => (status.textContent = `깨끗한 교안 그리는 중… ${i}/${n}쪽`) });
    const a = await renderGrayPages(file, {
      width: 320,
      sizes: b.map((p) => ({ width: p.width, height: p.height })),
      onProgress: (i, n) => (status.textContent = `필기한 교안과 비교하는 중… ${i}/${n}쪽`),
    });
    const m = Math.min(a.length, b.length);
    const ratios = [];
    for (let i = 0; i < m; i++) ratios.push(inkRatio(b[i].gray, a[i].gray, b[i].width, b[i].height));
    return { ratios, statuses: pageInk(ratios), baseCount: b.length, inkCount: a.length, base, file };
  })();
  S.inkBusy = job;
  try {
    const r = await job;
    if (S.inkBusy !== job) return;
    S.ink = r;
    renderInkStatus();
  } catch (e) {
    if (S.inkBusy === job) status.textContent = `필기한 교안을 비교하지 못했어요: ${e?.message || e}. 인터넷 연결을 확인하거나 타이핑 필기를 써 주세요.`;
  } finally {
    if (S.inkBusy === job) S.inkBusy = null;
  }
}

function renderInkStatus() {
  const r = S.ink;
  const status = $('#ink-status');
  clear(status);
  if (!r) return;
  const w = INK_WORD[S.inkKind];
  const m = r.ratios.length;
  const ink = r.statuses.filter((x) => x === 'ink').length;
  const light = r.statuses.filter((x) => x === 'light').length;
  const last = suggestProgress(r.statuses);
  status.append(`✓ ${m}쪽 비교 · ${w} 있는 쪽 ${ink} · ${w} 조금 ${light} · ${last ? `${w}가 있는 마지막 쪽 ${last}쪽` : `${w}를 찾지 못했어요`}`);
  if (r.baseCount !== r.inkCount) {
    status.append(h('span.warn-inline', ` ⚠ 쪽 수가 달라요 (교안 ${r.baseCount}쪽, 필기한 교안 ${r.inkCount}쪽) — 겹치는 ${m}쪽만 비교했어요.`));
  }
}

async function analyze() {
  inputError('');
  const course = $('#course').value.trim();
  const week = Number($('#week').value) || 1;
  if (!course) return inputError('과목명을 적어 주세요. 주차 이어가기에 쓰여요.');
  let slides = currentSlides();
  if (!slides || !slides.length) return inputError(S.slidesMode === 'pdf' ? '교안 PDF를 올리거나 “텍스트 붙여넣기”로 교안을 넣어 주세요.' : '교안 텍스트를 붙여넣어 주세요.');
  if (S.inkBusy) {
    const btn = $('#analyze-btn');
    btn.disabled = true;
    try {
      await S.inkBusy;
    } catch {
      /* status already shown */
    } finally {
      btn.disabled = false;
    }
  }
  const notesText = $('#notes').value;
  const ink = S.ink ? { ratios: S.ink.ratios, statuses: S.ink.statuses, kind: S.inkKind } : null;
  if (!notesText.trim() && !ink) {
    return inputError(S.inkFile && !S.pdfFile ? '필기한 교안을 비교하려면 ① 교안도 PDF로 올려 주세요. 아니면 타이핑 필기(b)를 넣어 주세요.' : '필기를 넣어 주세요 — 필기한 교안 PDF(a) 또는 타이핑 필기(b) 중 하나면 돼요.');
  }
  if (S.carry && $('#carry-merge')?.checked) slides = mergeCarryOver(S.carry, slides);
  const a = analyzeLecture({ slides, notesText, ink });
  if (!a.notes.items.length && !ink) return inputError('필기에서 글을 찾지 못했어요. 내용이 맞는지 확인해 주세요.');
  S.analysis = a;
  S.input = { course, week };
  S.isDemo = isDemoInput(slides);
  S.autoProgress = a.coverage.progress;
  markRun('start');
  markRun('analyzed');
  const items = a.notes.items;
  if (items.length) {
    const loose = items.filter((x) => !x.anchored && !x.preview).length;
    $('#notes-status').textContent =
      `타이핑 필기 ${items.length}줄 · 쪽 번호 ${a.notes.anchors}곳 (근거 번호 ${items[0].id}–${items[items.length - 1].id})` +
      (loose ? ` · 번호 없는 ${loose}줄은 내용으로 쪽을 찾았어요` : '') +
      (a.notes.warnings.length ? ` · ${a.notes.warnings.join(' ')}` : '');
  }
  renderCoverage();
  setProgress(a.coverage.progress, false);
  showStep(2);
}

// ======================= make: step 2 =======================
function slideLabel(s) {
  return s.carriedFrom ? `지난주 ${s.label}` : s.label;
}

function renderCoverage() {
  const a = S.analysis;
  const cov = a.coverage;
  const n = a.slides.length;

  // strip
  const strip = $('#strip');
  clear(strip);
  strip.style.setProperty('--n', String(n));
  cov.slides.forEach((p, i) => {
    const s = a.slides[i];
    const cell = h(
      'button.cell',
      { type: 'button', tabindex: '-1', class: `is-${p.status}`, dataset: { index: String(p.index) }, title: `${slideLabel(s)}쪽 · ${p.title} — ${STATUS_LABEL[p.status]}` },
      h('span.cell__no', s.label),
      h('span.cell__title', p.title),
    );
    if (p.emphasis.length) cell.append(h('span.cell__star', { 'aria-hidden': 'true' }, '★' + (p.emphasis.length > 1 ? p.emphasis.length : '')));
    if (s.carriedFrom) cell.append(h('span.cell__carried', '지난주'));
    strip.append(cell);
  });
  strip.append(h('div.pline', { id: 'pline' }, h('span.pline__flag', { id: 'pline-flag' })));

  const range = $('#progress-range');
  range.max = String(n);
  range.setAttribute('aria-valuetext', '');

  // emphasis
  const list = $('#em-list');
  clear(list);
  $('#em-count').textContent = cov.emphasis.length ? `${cov.emphasis.length}곳` : '';
  if (!cov.emphasis.length) {
    list.append(
      h(
        'li.empty-note',
        a.notes.items.length
          ? '★ · ! · 중요 · 시험 · 외워 · 헷갈 · 기출 같은 표시를 찾지 못했어요.'
          : '강조 표시는 타이핑 필기에서 찾아요. 필기한 교안 그림 속 ★·동그라미는 AI 엔진(Gemini, 내 AI 채팅)이 그림을 보고 읽어요.',
      ),
    );
  }
  for (const e of cov.emphasis) {
    const s = a.slides.find((x) => x.index === e.slideIndex);
    list.append(
      h(
        'li.em-item',
        h('div.em-item__meta', s ? `${slideLabel(s)}쪽` : '쪽 없음', ...e.cues.map((c) => h('span.tag.tag--em', cueLabel(c))), refChip(e.noteId)),
        h('q', e.text),
      ),
    );
  }
  renderPreviewCallout();
  renderAmount();
  renderSlideRows();
}

function renderPreviewCallout() {
  const a = S.analysis;
  const box = $('#preview-callout');
  clear(box);
  const p = a.coverage.previews[0];
  const next = a.slides.find((s) => s.index === S.progress + 1);
  if (!p) return;
  box.append(
    h(
      'div.callout',
      h('b', '다음 시간 메모 '),
      '“',
      p.text,
      '”',
      h('div.small', '이런 줄은 진도선을 옮기지 않아요.'),
      next ? h('div', `→ 다음 수업은 ${slideLabel(next)}쪽 「${next.title}」부터`) : null,
    ),
  );
}

/** 쪽별 필기량: one column per page — typed-note characters and/or ink share, coloured by status. */
function renderAmount() {
  const a = S.analysis;
  const per = a.coverage.slides;
  const box = $('#amount');
  clear(box);
  const n = per.length;
  const hasText = per.some((p) => p.chars > 0);
  const hasInk = per.some((p) => p.inkRatio != null);
  const word = INK_WORD[S.inkKind];
  $('#amount-sub').textContent = [hasText ? '타이핑 필기 글자 수' : null, hasInk ? `${word} 잉크 비율` : null].filter(Boolean).join(' · ');
  const W = globalThis.innerWidth < 600 ? 360 : 560;
  const H = 180;
  const m = { l: 10, r: 10, t: 22, b: 26 };
  const maxChars = Math.max(1, ...per.map((p) => p.chars));
  const maxInk = Math.max(1e-6, ...per.map((p) => p.inkRatio || 0));
  const colW = (W - m.l - m.r) / n;
  const barW = Math.max(4, Math.min(26, colW * 0.62));
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `쪽별 필기량: 진도선 ${S.progress}쪽` });
  root.append(svg('line', { class: 'a-base', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  const labelStep = n > 16 ? Math.ceil(n / 12) : 1;
  per.forEach((p, i) => {
    const v = Math.max(p.chars / maxChars, (p.inkRatio || 0) / maxInk);
    const hgt = p.status === STATUS.NONE ? 0 : Math.max(6, v * (H - m.t - m.b));
    const cx = m.l + colW * (i + 0.5);
    if (hgt) {
      root.append(
        svg(
          'rect',
          { class: `a-bar a-bar--${p.status}${p.index > S.progress ? ' is-after' : ''}`, x: cx - barW / 2, y: H - m.b - hgt, width: barW, height: hgt, rx: 3 },
          svg('title', {}, `${a.slides[i].label}쪽 · ${STATUS_LABEL[p.status]}${p.chars ? ` · 타이핑 ${p.chars}자` : ''}${p.inkRatio != null ? ` · 잉크 ${(p.inkRatio * 100).toFixed(2)}%` : ''}`),
        ),
      );
    } else root.append(svg('rect', { class: 'a-empty', x: cx - barW / 2, y: H - m.b - 3, width: barW, height: 3, rx: 1.5 }));
    if (p.emphasis.length) root.append(svg('text', { class: 'a-star', x: cx, y: H - m.b - hgt - 5, 'text-anchor': 'middle' }, '★'));
    if (i % labelStep === 0) root.append(svg('text', { class: 'a-label', x: cx, y: H - 8, 'text-anchor': 'middle' }, a.slides[i].label));
  });
  if (S.progress > 0) {
    const x = m.l + colW * S.progress;
    root.append(svg('line', { class: 'a-prog', x1: x, x2: x, y1: 6, y2: H - m.b + 4 }));
    root.append(svg('text', { class: 'a-prog-label', x: x + (S.progress > n * 0.75 ? -4 : 4), y: 14, 'text-anchor': S.progress > n * 0.75 ? 'end' : 'start' }, '진도선'));
  }
  box.append(root);
}

function renderSlideRows() {
  const a = S.analysis;
  const ol = $('#slide-rows');
  clear(ol);
  const noteById = new Map(a.notes.items.map((x) => [x.id, x]));
  a.coverage.slides.forEach((p, i) => {
    const s = a.slides[i];
    const gap = p.status === STATUS.NONE && p.index <= S.progress;
    ol.append(
      h(
        'li.slide-row',
        h(
          'div.slide-row__head',
          h('span', `${slideLabel(s)}쪽`),
          h('span', p.title),
          h('span', { class: ['st', gap ? 'st--gap' : `st--${p.status}`] }, gap ? '필기 없음 · 교안으로 설명' : STATUS_LABEL[p.status]),
          p.chars ? h('small', `타이핑 ${p.chars}자`) : null,
          p.inkRatio != null && p.inkStatus !== STATUS.NONE ? h('small', `${INK_WORD[S.inkKind]} ${(p.inkRatio * 100).toFixed(1)}%`) : null,
        ),
        p.noteIds.length
          ? h(
              'ul.slide-row__notes',
              p.noteIds.map((id) => {
                const x = noteById.get(id);
                return h('li', refChip(id), ' ', x.anchored ? null : h('span.loose', { title: '쪽 번호 없이 적은 줄 — 내용으로 이 쪽을 찾았어요' }, '번호 없음 '), x.text);
              }),
            )
          : null,
      ),
    );
  });
  const box = $('#unplaced');
  clear(box);
  if (a.coverage.unplaced.length) {
    box.append(
      h('p.small', '어느 쪽에도 붙지 않은 필기 (진도에는 안 써요):'),
      h('ul.slide-row__notes', a.coverage.unplaced.map((id) => h('li', refChip(id), ' ', noteById.get(id)?.text ?? ''))),
    );
  }
}

function setProgress(p, manual = true) {
  const a = S.analysis;
  if (!a) return;
  const n = a.slides.length;
  p = Math.max(0, Math.min(n, Math.round(p)));
  S.progress = p;
  const cells = $$('#strip .cell');
  cells.forEach((c, i) => {
    const idx = i + 1;
    const cov = a.coverage.slides[i];
    c.classList.toggle('is-after', idx > p);
    c.classList.toggle('is-gap', cov.status === STATUS.NONE && idx <= p);
  });
  positionLine();
  const range = $('#progress-range');
  range.value = String(p);
  const s = a.slides[p - 1];
  const txt = p ? `${s ? slideLabel(s) : p}쪽까지` : '아직 없음';
  $('#progress-out').textContent = txt;
  range.setAttribute('aria-valuetext', txt);
  $('#progress-reset').hidden = p === S.autoProgress;
  renderCovSummary();
  renderPreviewCallout();
  renderAmount();
  $('#to-generate').disabled = p === 0;
  if (S.step === 3) refreshGenerate();
  if (manual) renderSlideRows();
}

function positionLine() {
  const strip = $('#strip');
  const line = $('#pline');
  const flag = $('#pline-flag');
  if (!strip || !line) return;
  const cells = $$('#strip .cell');
  if (!cells.length) return;
  const p = S.progress;
  let x;
  if (p <= 0) x = cells[0].offsetLeft - 3;
  else if (p >= cells.length) x = cells[cells.length - 1].offsetLeft + cells[cells.length - 1].offsetWidth + 3;
  else x = (cells[p - 1].offsetLeft + cells[p - 1].offsetWidth + cells[p].offsetLeft) / 2;
  line.style.setProperty('left', x + 'px');
  const s = S.analysis.slides[p - 1];
  flag.textContent = p ? `딱 여기까지 · ${s ? slideLabel(s) : p}쪽` : '진도 없음';
  flag.classList.toggle('is-left', x > strip.scrollWidth - 150);
  // Narrow screens scroll the strip sideways (swipes move the line, not the strip), so keep the line in view.
  const pad = 40;
  if (strip.clientWidth && (x < strip.scrollLeft + pad || x > strip.scrollLeft + strip.clientWidth - pad)) {
    strip.scrollLeft = Math.max(0, x - strip.clientWidth * 0.6);
  }
}

function covEndText(a, s) {
  const carried = a.slides.filter((x) => x.carriedFrom).length;
  if (!s) return '';
  const where = s.carriedFrom ? `지난주 교안 ${s.label}쪽` : carried ? `이번 주 교안 ${s.label}쪽` : `${s.label}쪽`;
  return `${where} 「${s.title ?? ''}」까지 수업한 것으로 해설지를 만들어요${carried ? ` · 지난주 남은 ${carried}쪽 포함` : ''}`;
}

/** "제안: 8쪽 — 마지막 필기 쪽" / "판서가 있는 마지막 쪽 8쪽" (판서본) / both sources → the later one. */
function suggestionText(a) {
  const cov = a.coverage;
  const lab = (i) => {
    const s = a.slides[i - 1];
    return s ? `${slideLabel(s)}쪽` : `${i}쪽`;
  };
  if (!cov.progress) return '필기가 있는 쪽을 찾지 못했어요. 오늘 수업이 끝난 쪽으로 진도선을 옮겨 주세요.';
  const parts = [];
  if (cov.inkProgress) parts.push(S.inkKind === 'pan' ? `판서가 있는 마지막 쪽 ${lab(cov.inkProgress)}` : `마지막 필기 쪽 ${lab(cov.inkProgress)} (필기한 교안)`);
  if (cov.textProgress) parts.push(`마지막 필기 쪽 ${lab(cov.textProgress)} (타이핑 필기)`);
  const why = parts.length > 1 && cov.inkProgress !== cov.textProgress ? `${parts.join(' · ')} 중 뒤쪽` : parts[0];
  return `제안: ${lab(cov.progress)}까지 — ${why}. 맞으면 그대로, 아니면 진도선을 옮겨 주세요.`;
}

/** One headline number. Merged deck (지난주 남은 쪽 + 이번 주): "이번 주 N쪽까지 · 지난주 M쪽에서 이어서". */
function covBig(a, s, n) {
  const carried = a.slides.filter((x) => x.carriedFrom);
  if (!carried.length || !s) return h('div.cov-big', h('span.acc', String(S.progress)), h('small', ` / ${n}쪽`));
  const from = `지난주 ${carried[0].label}쪽에서 이어서`;
  if (s.carriedFrom) return h('div.cov-big', h('small', '지난주 교안 '), h('span.acc', s.label), h('small', `쪽까지 · ${from} (이번 주 교안은 시작 전)`));
  return h('div.cov-big', h('small', '이번 주 '), h('span.acc', s.label), h('small', `쪽까지 · ${from}`));
}

function renderCovSummary() {
  const a = S.analysis;
  const cov = a.coverage;
  const box = $('#cov-summary');
  clear(box);
  const n = a.slides.length;
  const count = (st) => cov.slides.filter((p) => p.status === st).length;
  const gaps = cov.slides.filter((p) => p.status === STATUS.NONE && p.index <= S.progress).length;
  const s = a.slides[S.progress - 1];
  box.append(
    covBig(a, s, n),
    h('div.cov-text', h('p.cov-suggest', suggestionText(a)), S.progress ? h('p', covEndText(a, s)) : null),
    h(
      'div.cov-chips',
      h('span.c-ink', `필기 있음 ${count(STATUS.INK)}`),
      h('span.c-light', `필기 조금 ${count(STATUS.LIGHT)}`),
      h('span', `필기 없음 ${count(STATUS.NONE)}`),
      gaps ? h('span.c-gap', `진도선 안 필기 없는 쪽 ${gaps} · 교안으로 설명`) : null,
      h('span.c-em', `★ 강조 ${cov.emphasis.length}곳`),
      S.progress !== S.autoProgress ? h('span.c-manual', `직접 조정 (제안: ${S.autoProgress}쪽)`) : null,
    ),
  );
}

function bindStripDrag() {
  const strip = $('#strip');
  let dragging = false;
  const pick = (clientX) => {
    const cells = $$('#strip .cell');
    let best = null;
    let bestD = Infinity;
    cells.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      const right = r.right;
      const d = Math.abs(clientX - right);
      if (d < bestD) {
        bestD = d;
        best = i + 1;
      }
      if (clientX >= r.left && clientX <= r.right) {
        // inside a cell → line after this cell
        best = i + 1;
        bestD = -1;
      }
    });
    return best;
  };
  strip.addEventListener('pointerdown', (e) => {
    if (!S.analysis || e.button !== 0) return;
    dragging = true;
    strip.classList.add('is-dragging');
    strip.setPointerCapture(e.pointerId);
    const p = pick(e.clientX);
    if (p != null) setProgress(p);
  });
  strip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = pick(e.clientX);
    if (p != null && p !== S.progress) setProgress(p);
  });
  const end = () => {
    dragging = false;
    strip.classList.remove('is-dragging');
  };
  strip.addEventListener('pointerup', end);
  strip.addEventListener('pointercancel', end);
  $('#progress-range').addEventListener('input', (e) => setProgress(Number(e.target.value)));
  $('#progress-reset').addEventListener('click', () => setProgress(S.autoProgress));
  window.addEventListener('resize', () => S.analysis && positionLine());
}

// ======================= make: step 3 =======================
/** Slide indices inside the 진도선 whose annotated page has ink (capped for Gemini). */
function inkPagesWithin(progress) {
  const a = S.analysis;
  if (!a?.ink || !S.inkFile) return [];
  return a.coverage.slides.filter((p) => p.index <= progress && p.inkStatus && p.inkStatus !== STATUS.NONE).map((p) => p.index).slice(-MAX_INK_IMAGES);
}

function toGenerate() {
  if (!S.analysis || !S.progress) return;
  const saved = saveWeek(storage, { course: S.input.course, week: S.input.week, progress: S.progress, slides: S.analysis.slides });
  if (saved) toast(`${S.input.week}주차 진도선(${saved.stoppedLabel}쪽)을 저장했어요 — 다음 주에 이어서 보여 드려요`, 2800);
  selectEngine(S.isDemo ? 'demo' : S.engine === 'demo' ? 'paste' : S.engine);
  showStep(3);
}

function refreshGenerate() {
  const a = S.analysis;
  const first = a.slides[0];
  const last = a.slides[S.progress - 1];
  $('#gen-range').textContent = `${slideLabel(first)}–${last ? slideLabel(last) : S.progress}쪽만 사용`;
  const pages = inkPagesWithin(S.progress);
  const kind = INK_KIND[S.inkKind];
  S.prompt = buildPrompt({
    course: S.input.course,
    week: S.input.week,
    slides: a.slides,
    notes: a.notes.items,
    coverage: a.coverage,
    progress: S.progress,
    ink: pages.length ? { pages, kind: S.inkKind, attached: S.engine === 'gemini' } : null,
  });
  $('#prompt-box').value = S.prompt.text;
  $('#prompt-meta').textContent = `약 ${S.prompt.text.length.toLocaleString()}자 · 교안 ${S.prompt.coveredCount}쪽 + 그 쪽들의 필기만 들어 있어요${S.prompt.truncated ? ' · 너무 길어 일부 필기를 뺐어요' : ''}`;
  const hint = $('#paste-ink-hint');
  hint.hidden = !pages.length;
  hint.textContent = pages.length
    ? `손글씨도 쓰려면 AI 채팅에 ${kind.what} PDF(진도선 안쪽 ${pages[0]}–${pages[pages.length - 1]}쪽)를 함께 첨부하세요. 근거는 ${kind.prefix}-p번호로 달려요.`
    : '';
  $('#gemini-ink-note').textContent = pages.length ? ` + ${S.inkKind === 'pan' ? '판서본' : '필기한 교안'} ${pages.length}쪽의 그림(1024px)` : '';
  const demoBtn = $('#eng-demo');
  demoBtn.disabled = !S.isDemo;
  demoBtn.title = S.isDemo ? '' : '예시 수업을 넣었을 때만 쓸 수 있어요';
  $('#demo-pane-text').textContent = S.isDemo
    ? S.progress === S.autoProgress
      ? '예시 수업이라 미리 만들어 둔 해설지를 바로 보여 드려요. (실제 수업에서는 옆의 두 방법으로 만들어요.)'
      : `미리 만든 예시 해설지는 진도선 ${S.autoProgress}쪽 기준이에요. 지금 진도선(${S.progress}쪽)에 맞춰 밖의 쪽은 빼고 보여 드려요.`
    : '예시 결과는 “예시 수업 채우기”로 넣은 예시에서만 쓸 수 있어요.';
}

function selectEngine(e) {
  if (e === 'demo' && !S.isDemo) e = 'paste';
  S.engine = e;
  for (const b of $$('[data-engine]')) {
    const on = b.dataset.engine === e;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('#pane-demo').hidden = e !== 'demo';
  $('#pane-paste').hidden = e !== 'paste';
  $('#pane-gemini').hidden = e !== 'gemini';
  if (S.analysis && S.progress) refreshGenerate(); // the prompt says whether ink pages are attached
}

function showBoxError(sel, err) {
  const box = $(sel);
  clear(box);
  if (!err) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.append(h('b', err.message || String(err)));
  if (err.hint) box.append(h('span', err.hint));
}

async function runDemoEngine() {
  try {
    const res = await fetch('data/demo-guide.json');
    if (!res.ok) throw new Error(`예시 해설지를 불러오지 못했어요 (${res.status})`);
    const guide = normalizeGuide(await res.json());
    finalizeGuide(guide, '예시 (미리 만든 결과)');
  } catch (e) {
    toast(e.message || '예시 해설지를 불러오지 못했어요');
  }
}

function runPasteEngine() {
  showBoxError('#reply-error', null);
  try {
    const guide = parseReply($('#reply-box').value);
    finalizeGuide(guide, '내 AI 채팅 (붙여넣기)');
  } catch (e) {
    showBoxError('#reply-error', e instanceof ReplyError ? e : new ReplyError(e.message || '알 수 없는 오류', ''));
  }
}

let geminiAbort = null;
async function runGeminiEngine() {
  showBoxError('#gemini-error', null);
  const key = $('#gemini-key').value.trim();
  const model = $('#gemini-model').value.trim() || DEFAULT_MODEL;
  if ($('#gemini-remember').checked && key) store.set(KEYS.gemKey, key);
  store.set(KEYS.gemModel, model);
  const btn = $('#gemini-run');
  const status = $('#gemini-status');
  btn.disabled = true;
  geminiAbort = new AbortController();
  const timer = setTimeout(() => geminiAbort.abort(), 180000);
  try {
    if (!key) throw new ReplyError('Gemini API 키를 먼저 넣어 주세요.', '');
    refreshGenerate();
    let images = [];
    const pages = S.prompt.inkPages || [];
    if (pages.length) {
      const own = S.analysis.slides.filter((s) => !s.carriedFrom);
      const pdfPageOf = (idx) => own.findIndex((s) => s.index === idx) + 1;
      const prefix = INK_KIND[S.inkKind].prefix;
      const shots = await renderJpegPages(S.inkFile, pages.map(pdfPageOf), { width: 1024, onProgress: (i, n) => (status.textContent = `${S.inkKind === 'pan' ? '판서본' : '필기한 교안'} 그림 만드는 중… ${i}/${n}쪽`) });
      images = shots.map((im) => {
        const idx = own[im.page - 1].index;
        return { label: `${prefix}-p${idx} (교안 ${idx}쪽에 ${S.inkKind === 'pan' ? '교수님이 판서한' : '내가 필기한'} 페이지)`, mimeType: im.mimeType, data: im.data };
      });
    }
    status.textContent = `${model}로 만드는 중… 보통 20–60초 걸려요`;
    const text = await generateWithGemini({ apiKey: key, model, prompt: S.prompt.text, images, signal: geminiAbort.signal });
    status.textContent = '받았어요. 근거를 대조하는 중…';
    const guide = parseReply(text);
    status.textContent = '';
    finalizeGuide(guide, `Gemini API (${model})`);
  } catch (e) {
    status.textContent = '';
    showBoxError('#gemini-error', e);
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
  }
}

function finalizeGuide(guide, engine) {
  const a = S.analysis;
  const inkPages = inkPagesWithin(S.progress);
  const v = verifyGuide(guide, {
    slides: a.slides,
    notes: a.notes.items,
    progress: S.progress,
    coverage: a.coverage,
    ink: inkPages.length ? { kind: S.inkKind, pages: inkPages } : null,
  });
  if (!v.slides.some((s) => !s.missing)) {
    const err = new ReplyError('진도선 안쪽 쪽에 대한 해설이 하나도 없어요.', 'AI가 다른 쪽 번호를 썼을 수 있어요. 프롬프트를 다시 보내 보세요.');
    showBoxError(S.engine === 'gemini' ? '#gemini-error' : '#reply-error', err);
    if (S.engine === 'demo') toast(err.message);
    return;
  }
  markRun('guide');
  S.run = { ...S.run, engine, demo: S.isDemo };
  saveRun(storage, S.run);
  const labels = {};
  for (const s of a.slides) labels[s.index] = slideLabel(s);
  const cov = a.coverage;
  S.doc = {
    v: 2,
    course: S.input.course,
    week: S.input.week,
    progress: S.progress,
    autoProgress: S.autoProgress,
    total: a.slides.length,
    engine,
    demo: S.isDemo,
    inkKind: a.ink ? S.inkKind : null,
    createdAt: new Date().toISOString(),
    labels,
    slides: v.slides,
    questions: v.questions,
    nextPreview: v.nextPreview,
    warnings: v.warnings,
    stats: v.stats,
    toGuideMs: runSummary(S.run).toGuideMs,
    coverageStats: {
      noted: cov.slides.filter((p) => p.status === STATUS.INK).length,
      light: cov.slides.filter((p) => p.status === STATUS.LIGHT).length,
      emphasis: cov.emphasis.length,
      noteLines: a.notes.items.length,
    },
    emphasisBySlide: Object.fromEntries(cov.slides.map((p) => [p.index, [...new Set(p.emphasis.flatMap((e) => e.cues))]])),
    quizResult: null,
  };
  saveWeek(storage, { course: S.input.course, week: S.input.week, progress: S.progress, slides: a.slides });
  writeJSON(KEYS.guide, S.doc);
  S.quiz = null;
  store.remove(KEYS.quiz);
  location.hash = '#/guide';
  if (location.hash === '#/guide') renderGuide();
}

// ======================= guide =======================
function stmtEl(st) {
  const src = SRC_CLASS[st.source] || 'ai';
  const origins = [...new Set((st.refs || []).map(noteOrigin).filter(Boolean))];
  const tagTitle = src === 'note' && origins.length ? `출처: ${origins.map((o) => NOTE_ORIGIN[o]).join(', ')}` : null;
  return h(
    'li',
    { class: ['stmt', `stmt--${src}`] },
    h('span', { class: ['tag', `tag--${src}`], title: tagTitle }, SRC_TAG[src], src === 'note' && origins.includes('pan') ? h('small.tag__origin', '판서') : null),
    h(
      'div.stmt__text',
      st.text,
      st.refs?.length ? h('span.stmt__refs', st.refs.map(refChip)) : null,
      st.check === 'unverified' ? h('span.unv', { title: '교안 글과 겹치는 표현이 적어요 — 직접 확인해 보세요' }, '확인 필요') : null,
      st.quote ? h('span.stmt__q', `“${st.quote}”`) : null,
      st.note ? h('span.stmt__note', st.note) : null,
    ),
  );
}

function renderGuide() {
  const doc = S.doc;
  const root = $('#guide-root');
  clear(root);
  $('#guide-empty').hidden = !!doc;
  if (!doc) return;
  root.className = Object.entries(S.filters)
    .filter(([, on]) => !on)
    .map(([k]) => `hide-${k}`)
    .join(' ');
  const first = doc.slides[0];
  const st = doc.stats;
  const head = h(
    'header.guide-head',
    h('div.guide-head__top', h('h1#guide-title.view__title', `${doc.course} ${doc.week}주차 해설지`), doc.demo ? h('span.pill.pill--demo', '예시 · 창작 데이터') : null),
    h(
      'div.guide-meta',
      h('span', h('b', `${lab(doc, first?.slide ?? 1)}–${lab(doc, doc.progress)}쪽`), ` 해설 (전체 ${doc.total}쪽 중, `, h('b.acc', `진도선 ${lab(doc, doc.progress)}쪽`), ')'),
      h('span', `만든 방법: ${doc.engine}`),
      doc.toGuideMs != null ? h('span.measure', { title: '입력을 시작한 때부터 해설지가 나올 때까지, 이 브라우저가 잰 시간' }, `⏱ 해설지까지 ${formatDuration(doc.toGuideMs)}`) : null,
    ),
    h(
      'div.toolbar.no-print',
      h('a.btn.btn--primary', { href: '#/quiz' }, `회상 퀴즈 시작 (${doc.questions.length}문제)`),
      h('button.btn', { type: 'button', onClick: () => printGuide() }, '인쇄 · PDF로 저장'),
      h('button.btn', { type: 'button', onClick: () => downloadMd() }, 'Markdown 저장'),
    ),
    h(
      'div.verify',
      h('span.verify__label', '출처'),
      ...['slide', 'note', 'ai'].map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: ['tag', `tag--${k}`],
            'aria-pressed': String(S.filters[k]),
            title: '눌러서 이 출처 문장 숨기기/보이기',
            onClick: () => {
              S.filters[k] = !S.filters[k];
              renderGuide();
            },
          },
          `${SRC_TAG[k]} ${st[k] ?? 0}`,
        ),
      ),
      h(
        'span.verify__note',
        '필기 근거: ',
        h('span.ref', 'n··'),
        ' 내 필기(타이핑) 줄 · ',
        h('span.ref.ref--ink', 'ink-p··'),
        ' 내가 필기한 교안 쪽 · ',
        h('span.ref.ref--ink', 'pan-p··'),
        ' 교수님 판서본 쪽 · ',
        h('span.ref.ref--p', 'P··'),
        ' 교안 쪽. 브라우저가 실제 입력과 다시 대조해서, 필기 근거가 없는 “필기” 문장은 AI 보충으로 내립니다.',
      ),
    ),
    doc.warnings?.length ? h('ul.warn-list', doc.warnings.map((w) => h('li', w))) : null,
  );
  root.append(head);

  for (const s of doc.slides) {
    const cues = doc.emphasisBySlide?.[s.slide] || [];
    const card = h(
      'article.scard',
      { id: `s-${s.slide}` },
      h(
        'div.scard__head',
        h('span', { class: ['scard__no', s.coverage === 'light' ? 'is-light' : s.coverage === 'none' ? 'is-none' : ''] }, lab(doc, s.slide)),
        h(
          'div',
          h('h2.scard__title', s.title),
          h(
            'div.scard__sub',
            h('span', { class: ['st', `st--${s.coverage === 'none' ? 'gap' : s.coverage || 'ink'}`] }, s.coverage === 'none' ? '필기 없음 · 교안으로 설명' : STATUS_LABEL[s.coverage] || STATUS_LABEL.ink),
            ...cues.map((c) => h('span.badge-em', cueLabel(c))),
          ),
        ),
      ),
    );
    if (s.missing) card.append(h('p.missing', 'AI가 이 쪽 해설을 만들지 않았어요. 아래 필기와 교안을 직접 확인해 주세요.'));
    const sec = (title, arr) => {
      if (!arr?.length) return;
      card.append(h('section.sec', h('h3.sec__title', title), h('ul.stmts', arr.map(stmtEl))));
    };
    sec('핵심 정리', s.summary);
    sec('필기에서 — 교안에 없는 것', s.notes);
    sec('강조 포인트', s.emphasis);
    sec('헷갈리기 쉬운 점', s.pitfalls);
    if (s.evidence?.length) {
      card.append(
        h(
          'details.evidence',
          h('summary', `필기 근거 ${s.evidence.length}개 보기`),
          h('ol', s.evidence.map((e) => h('li', refChip(e.id), ' ', h('small.origin', NOTE_ORIGIN[e.origin] || ''), ' ', e.text))),
        ),
      );
    }
    root.append(card);
  }

  const next = h(
    'section.next-card',
    h('h2', '다음 수업 예고'),
    doc.nextPreview.length ? h('p.small', '아직 안 배운 쪽이라 해설을 만들지 않았어요. 제목만 미리 봐 두세요.') : h('p.small', '교안을 끝까지 나갔어요.'),
    doc.nextPreview.length ? h('ol', doc.nextPreview.map((p) => h('li', h('b', `${lab(doc, p.slide)}쪽`), p.title))) : null,
    h('div.actions.no-print', h('button.btn.btn--primary', { type: 'button', onClick: () => startNextWeek() }, `${doc.week + 1}주차 이어서 만들기 →`), h('a.btn.btn--ghost', { href: '#/survey' }, '사용 후기 남기기')),
  );
  root.append(next);
}

function printGuide() {
  const ds = $$('#guide-root details.evidence');
  const was = ds.map((d) => d.open);
  ds.forEach((d) => (d.open = true));
  const restore = () => {
    ds.forEach((d, i) => (d.open = was[i]));
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

function downloadMd() {
  const d = S.doc;
  const md = guideToMarkdown({ ...d, labels: new Map(Object.entries(d.labels).map(([k, v]) => [Number(k), v])) });
  const safe = `${d.course}-${d.week}주차-해설지`.replace(/[\\/:*?"<>|\s]+/g, '_');
  download(`${safe}.md`, md);
  toast('Markdown 파일을 저장했어요');
}

function startNextWeek() {
  const d = S.doc;
  $('#course').value = d.course;
  $('#week').value = String(d.week + 1);
  $('#slides-text').value = '';
  $('#notes').value = '';
  $('#notes-status').textContent = '';
  $('#pdf-status').textContent = '';
  $('#pdf-file').value = '';
  S.pdfSlides = null;
  S.pdfFile = null;
  clearInk();
  S.analysis = null;
  resetRun();
  showStep(1, false);
  updateCarry();
  go('#/make', () => requestAnimationFrame(() => $('#step-input').scrollIntoView({ block: 'start' })));
}

// ======================= quiz =======================
function saveQuiz() {
  writeJSON(KEYS.quiz, S.quiz);
}

function renderQuiz() {
  const root = $('#quiz-root');
  clear(root);
  const doc = S.doc;
  const wrap = h('div.quiz');
  root.append(wrap);
  if (!doc || !doc.questions?.length) {
    wrap.append(
      h('div.empty', h('h1#quiz-title.view__title', '회상 퀴즈'), h('p', doc ? '이 해설지에는 회상 문제가 없어요.' : '먼저 해설지를 만들어 주세요.'), h('div.actions', h('button.btn.btn--primary', { type: 'button', onClick: () => demoGuideFlow() }, '예시로 해 보기'), h('a.btn.btn--ghost', { href: '#/make' }, '만들기'))),
    );
    return;
  }
  const q = S.quiz;
  if (!q) {
    const types = {};
    doc.questions.forEach((x) => (types[x.type] = (types[x.type] || 0) + 1));
    wrap.append(
      h('h1#quiz-title.view__title', '회상 퀴즈'),
      h('p.view__lead', '정답을 보기 전에 ', h('b', '내 답을 먼저 써요'), '. ○ △ ✕로 스스로 채점하면, 틀리거나 애매한 문제는 끝에 다시 나와요. 첫 시도 점수와 다시 푼 뒤 점수를 둘 다 보여 드려요.'),
      h('div.qcard', h('p', `${doc.course} ${doc.week}주차 · ${lab(doc, doc.slides[0].slide)}–${lab(doc, doc.progress)}쪽 · ${doc.questions.length}문제`), h('div.qcard__meta', Object.entries(types).map(([t, c]) => h('span', { class: ['qtype', `qtype--${t}`] }, `${t} ${c}`))), h('div.actions', h('button.btn.btn--primary.btn--lg', { type: 'button', onClick: startQuiz }, '시작하기'))),
    );
    return;
  }
  if (q.done) return renderQuizResult(wrap);
  if (q.roundEnded) return renderRoundEnd(wrap);
  renderQuestion(wrap);
}

function startQuiz() {
  S.quiz = Q.createQuiz(S.doc.questions);
  markRun('quizStart');
  saveQuiz();
  renderQuiz();
}

function renderQuestion(wrap) {
  const q = S.quiz;
  const doc = S.doc;
  const cur = Q.current(q);
  const done = q.pos;
  const total = q.queue.length;
  wrap.append(
    h('div.quiz__top', h('h1#quiz-title.view__title', q.round === 1 ? '회상 퀴즈' : `다시 풀기 · ${q.round - 1}회차`), h('span.small', `문제 ${done + 1} / ${total}`)),
    h('div.quiz__progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-label': '진행' }, h('i', { style: { '--p': `${(done / total) * 100}%` } })),
  );
  const card = h('div.qcard');
  card.append(h('div.qcard__meta', h('span', { class: ['qtype', `qtype--${cur.type}`] }, cur.type === '예측' ? '예측 — 먼저 예상해 보세요' : cur.type), cur.slide ? h('span.pill', `${lab(doc, cur.slide)}쪽`) : null));
  card.append(h('p.qcard__q', cur.question));
  if (!q.revealed) {
    const ta = h('textarea#quiz-answer', { rows: '3', placeholder: cur.type === '예측' ? '내 예상: …' : '기억나는 대로 적어 보세요' });
    const revealBtn = h('button.btn.btn--primary', { type: 'button', disabled: true }, '정답 보기');
    ta.addEventListener('input', () => (revealBtn.disabled = !Q.canReveal(ta.value)));
    const doReveal = (val) => {
      S.quiz = Q.reveal(S.quiz, val);
      saveQuiz();
      renderQuiz();
      requestAnimationFrame(() => $('.grade .btn')?.focus());
    };
    revealBtn.addEventListener('click', () => doReveal(ta.value));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && Q.canReveal(ta.value)) doReveal(ta.value);
    });
    card.append(
      h('label', { for: 'quiz-answer', class: 'field' }, h('span', { class: 'small' }, '내 답 — 먼저 적어야 정답이 열려요')),
      ta,
      h('div.actions', revealBtn, h('button.btn.btn--ghost', { type: 'button', onClick: () => doReveal('(모르겠음)') }, '모르겠어요')),
      h('p.qcard__hint', 'Ctrl + Enter로도 정답을 볼 수 있어요.'),
    );
    wrap.append(card);
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
    return;
  }
  card.append(
    h('div.reveal', h('div.reveal__box.reveal__mine', h('h3', '내 답'), h('p', q.answers[cur.qid] || '')), h('div.reveal__box.reveal__ans', h('h3', '정답'), h('p', cur.answer), cur.refs?.length ? h('span.stmt__refs', cur.refs.map(refChip)) : null)),
    h(
      'div.grade',
      { role: 'group', 'aria-label': '스스로 채점' },
      h('span.grade__label', '스스로 채점'),
      h('button.btn.btn--mark.btn--o', { type: 'button', onClick: () => doGrade('o') }, '○ 맞음'),
      h('button.btn.btn--mark.btn--t', { type: 'button', onClick: () => doGrade('t') }, '△ 애매'),
      h('button.btn.btn--mark.btn--x', { type: 'button', onClick: () => doGrade('x') }, '✕ 틀림'),
    ),
  );
  wrap.append(card);
}

function doGrade(m) {
  S.quiz = Q.grade(S.quiz, m);
  if (S.quiz.done) onQuizDone();
  saveQuiz();
  renderQuiz();
}

function onQuizDone() {
  markRun('quizDone');
  const sum = Q.summary(S.quiz);
  S.doc.quizResult = { firstPct: sum.first.percent, afterPct: sum.after.percent, total: sum.total, rounds: sum.rounds, quizMs: runSummary(S.run).quizMs };
  writeJSON(KEYS.guide, S.doc);
}

function renderRoundEnd(wrap) {
  const q = S.quiz;
  const sum = Q.summary(q);
  wrap.append(
    h('h1#quiz-title.view__title', `${q.round - 1}회차 끝`),
    h(
      'div.qcard',
      h('p', `첫 시도: ○ ${sum.first.o} · △ ${sum.first.t} · ✕ ${sum.first.x}`),
      h('p', h('b', `틀리거나 애매했던 ${q.queue.length}문제`), '를 다시 풀어 볼까요? 다시 떠올리는 것이 복습의 핵심이에요.'),
      h(
        'div.actions',
        h('button.btn.btn--primary', { type: 'button', onClick: () => { S.quiz = Q.continueRetry(S.quiz); saveQuiz(); renderQuiz(); } }, `${q.queue.length}문제 다시 풀기`),
        h('button.btn.btn--ghost', { type: 'button', onClick: () => { S.quiz = Q.finish(S.quiz); onQuizDone(); saveQuiz(); renderQuiz(); } }, '그만하고 결과 보기'),
      ),
    ),
  );
}

function renderQuizResult(wrap) {
  const sum = Q.summary(S.quiz);
  const doc = S.doc;
  const qr = doc.quizResult;
  const bar = (label, pct, cls) => h('div', { class: ['scorebar', cls] }, h('span', label), h('div.scorebar__track', h('div.scorebar__fill', { style: { '--w': pct + '%' } })), h('span.scorebar__val', `${pct}%`));
  wrap.append(
    h('h1#quiz-title.view__title', '퀴즈 결과'),
    h(
      'div.qcard.result',
      h('div.scorebars', bar('첫 시도', sum.first.percent, 'scorebar--first'), bar('다시 푼 뒤', sum.after.percent, 'scorebar--after')),
      h('p', `첫 시도 ○ ${sum.first.o} · △ ${sum.first.t} · ✕ ${sum.first.x} → 다시 푼 뒤 ○ ${sum.after.o} · △ ${sum.after.t} · ✕ ${sum.after.x}  (${sum.total}문제, ${sum.rounds}회차)`),
      qr?.quizMs != null ? h('p.measure', `⏱ 퀴즈 ${formatDuration(qr.quizMs)}`) : null,
      sum.weak.length ? h('div', h('h2.sec__title', '처음에 막혔던 문제 — 해설지에서 다시 보기'), h('ul.weak', sum.weak.map((w) => h('li', h('span.marks', `${Q.MARK_LABEL[w.first]}→${Q.MARK_LABEL[w.last] || '·'}`), w.slide ? h('a', { href: '#/guide', onClick: () => setTimeout(() => $(`#s-${w.slide}`)?.scrollIntoView(), 50) }, `${lab(doc, w.slide)}쪽`) : null, h('span', w.question))))) : h('p', '처음부터 모두 ○ — 잘했어요!'),
      h('p.small', '점수는 스스로 채점한 결과예요.'),
      h('div.actions', h('a.btn.btn--primary', { href: '#/survey' }, '사용 후기 남기기'), h('a.btn', { href: '#/guide' }, '해설지로'), h('button.btn.btn--ghost', { type: 'button', onClick: () => { S.quiz = null; store.remove(KEYS.quiz); renderQuiz(); } }, '처음부터 다시')),
    ),
  );
}

// ======================= survey =======================
let surveyBuilt = false;
function scaleEl(name, label, lo = '전혀 아니다', hi = '매우 그렇다') {
  return h(
    'fieldset.scale',
    h('legend', label),
    h(
      'div.scale__opts',
      [1, 2, 3, 4, 5].map((v) => h('label', h('input', { type: 'radio', name, value: String(v), 'aria-label': `${v}점` }), h('span', { 'aria-hidden': 'true' }, String(v)))),
    ),
    h('div.scale__ends', { 'aria-hidden': 'true' }, h('span', lo), h('span', hi)),
  );
}

function surveyMeta() {
  const d = S.doc;
  return {
    engine: d?.engine ?? null,
    demo: d?.demo ?? null,
    slides: d?.total ?? null,
    suggested: d?.autoProgress ?? null,
    progress: d?.progress ?? null,
    noted: d?.coverageStats?.noted ?? null,
    light: d?.coverageStats?.light ?? null,
    emphasis: d?.coverageStats?.emphasis ?? null,
    noteLines: d?.coverageStats?.noteLines ?? null,
    inkKind: d?.inkKind ?? null,
    toGuideMs: d?.toGuideMs ?? null,
    quizFirstPct: d?.quizResult?.firstPct ?? null,
    quizAfterPct: d?.quizResult?.afterPct ?? null,
    quizTotal: d?.quizResult?.total ?? null,
  };
}

function renderSurvey() {
  const form = $('#survey-form');
  if (!surveyBuilt) {
    surveyBuilt = true;
    form.append(
      h('h2.survey-sec', '이번에 써 보니'),
      ...SURVEY_ITEMS.map((it, i) => scaleEl(it.key, `${i + 1}. ${it.label}`)),
      h(
        'fieldset.scale.scale--choice',
        h('legend', `5. ${BASELINE_ITEMS.progressOff} (선택)`),
        h('div.choice-opts', PROGRESS_OFF_OPTIONS.map((o) => h('label.check', h('input', { type: 'radio', name: 'progressOff', value: o.value }), ` ${o.label}`))),
      ),
      h('div.field', h('label', { for: 'sv-improve' }, '6. 고쳤으면 하는 점 (자유롭게)'), h('textarea#sv-improve', { name: 'improve', rows: '3', placeholder: '예: 필기 사진을 바로 읽어 주면 좋겠어요' })),
      h('h2.survey-sec', '평소 방식과 비교 (선택)'),
      h('div.field.field--narrow', { style: { 'max-width': '420px' } }, h('label', { for: 'sv-minutes' }, BASELINE_ITEMS.minutes), h('input#sv-minutes', { type: 'number', name: 'baselineMinutes', min: '1', max: '600', inputmode: 'numeric', placeholder: '예: 60' })),
      scaleEl('baselineConfidence', BASELINE_ITEMS.confidence, '자신 없음', '자신 있음'),
      h('div.field', { style: { 'max-width': '320px' } }, h('label', { for: 'sv-nick' }, '닉네임 (선택 · 실명은 적지 마세요)'), h('input#sv-nick', { type: 'text', name: 'nickname', maxlength: '20', autocomplete: 'off', placeholder: '예: 기계과 4학년' })),
      h('div.auto-box#sv-auto'),
      h('div.actions', h('button.btn.btn--primary', { type: 'submit' }, '결과 글 만들기')),
      h('p.error#sv-error', { role: 'alert', hidden: true }),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitSurvey();
    });
  }
  const m = surveyMeta();
  const box = $('#sv-auto');
  clear(box);
  const pct = (v) => (v == null ? '—' : v + '%');
  const adj = m.progress != null && m.suggested != null ? m.progress - m.suggested : null;
  box.append(
    h('b', '함께 보내는 자동 측정값 (이 브라우저가 잰 값, 개인정보 없음)'),
    h(
      'ul',
      h('li', `입력 시작 → 해설지: ${m.toGuideMs != null ? formatDuration(m.toGuideMs) : '아직 측정 안 됨'}`),
      h('li', `회상 퀴즈: 첫 시도 ${pct(m.quizFirstPct)} → 다시 푼 뒤 ${pct(m.quizAfterPct)}`),
      h('li', `진도선: ${m.slides ?? '—'}쪽 중 제안 ${m.suggested ?? '—'}쪽 → 최종 ${m.progress ?? '—'}쪽${adj ? ` (직접 ${adj > 0 ? '+' : ''}${adj}쪽)` : ''}`),
      h('li', `필기: 필기 있음 ${m.noted ?? '—'}쪽 · 강조 ${m.emphasis ?? '—'}곳 · 엔진 ${m.engine ?? '—'}${m.demo ? ' (예시 데이터)' : ''}`),
    ),
  );
}

function submitSurvey() {
  const fd = new FormData($('#survey-form'));
  const answers = Object.fromEntries(fd.entries());
  const r = buildSurveyResult(answers, surveyMeta());
  const err = $('#sv-error');
  if (!r.ok) {
    err.hidden = false;
    err.textContent = `1–4번 문항에 점수를 골라 주세요. (빠진 문항 ${r.missing.length}개)`;
    return;
  }
  err.hidden = true;
  const box = $('#survey-result');
  clear(box);
  box.hidden = false;
  const jsonText = JSON.stringify(r.json);
  const mail = `mailto:?subject=${encodeURIComponent('[딱 거기까지] 사용 후기')}&body=${encodeURIComponent(r.text)}`;
  box.append(
    h('h2.panel__title', '고마워요! 아래 글을 만든 사람에게 보내 주세요'),
    h('p.small', '카카오톡이나 메일에 그대로 붙여넣으면 돼요. 서버로는 아무것도 보내지 않았어요.'),
    h('pre.result-pre', r.text),
    h(
      'div.actions',
      h('button.btn.btn--primary', { type: 'button', onClick: async () => toast((await copyText(r.text)) ? '결과 글을 복사했어요' : '복사하지 못했어요. 직접 선택해 복사해 주세요') }, '결과 글 복사'),
      h('button.btn', { type: 'button', onClick: async () => toast((await copyText(jsonText)) ? 'JSON을 복사했어요' : '복사하지 못했어요') }, 'JSON만 복사'),
      h('a.btn.btn--ghost', { href: mail }, '메일 앱으로 보내기'),
    ),
  );
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ======================= present mode =======================
async function openPresent() {
  const dlg = $('#present');
  const url = location.href.split('#')[0];
  $('#present-url').textContent = url;
  const box = $('#present-qr');
  clear(box);
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  try {
    box.append(await qrSvg(url));
  } catch (e) {
    box.append(h('p', 'QR을 만들지 못했어요. 주소를 직접 알려 주세요.'));
  }
}

// ======================= demo flows =======================
async function demoStartFlow() {
  demoFill();
  await analyze();
  go('#/make', () => showStep(2));
}

async function demoGuideFlow() {
  demoFill();
  await analyze();
  toGenerate();
  runDemoEngine();
}

// ======================= wiring =======================
function bindDrop(drop, onFile) {
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    onFile(e.dataTransfer.files[0]);
  });
}

function bind() {
  window.addEventListener('hashchange', route);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'demo-start') demoStartFlow();
    if (a === 'demo-fill') demoFill();
    if (a === 'demo-guide') demoGuideFlow();
  });
  for (const b of $$('[data-slides-mode]')) b.addEventListener('click', () => setSlidesMode(b.dataset.slidesMode));
  for (const b of $$('[data-engine]')) b.addEventListener('click', () => !b.disabled && selectEngine(b.dataset.engine));
  for (const b of $$('[data-goto-step]')) b.addEventListener('click', () => showStep(Number(b.dataset.gotoStep)));

  const form = $('#step-input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    analyze();
  });
  form.addEventListener('input', (e) => {
    if (['course', 'week'].includes(e.target.id)) updateCarry();
    if (e.target.id !== 'carry-merge' && e.target.name !== 'ink-kind') markRun('start');
  });

  // 교안 PDF
  const pdfInput = $('#pdf-file');
  const handlePdf = async (file) => {
    if (!file) return;
    const status = $('#pdf-status');
    clear(status);
    status.textContent = `「${file.name}」 읽는 중…`;
    markRun('start');
    try {
      const pages = await extractPdfPages(file, (i, n) => (status.textContent = `「${file.name}」 읽는 중… ${i}/${n}쪽`));
      const slides = slidesFromPages(pages);
      const filled = slides.filter((s) => s.text.trim()).length;
      if (!filled) {
        S.pdfSlides = null;
        S.pdfFile = null;
        status.textContent = '글자를 찾지 못했어요. 스캔한 PDF일 수 있어요 — “텍스트 붙여넣기”로 넣어 주세요.';
        return;
      }
      S.pdfSlides = slides;
      S.pdfFile = file;
      clear(status);
      status.append(
        `✓ ${slides.length}쪽 읽음 (글자 있는 쪽 ${filled}) · 1쪽: 「${slides[0].title}」 `,
        h(
          'button.btn.btn--small.btn--ghost',
          {
            type: 'button',
            onClick: () => {
              $('#slides-text').value = slides.map((s) => `--- ${s.index} ---\n${s.text}`).join('\n\n');
              setSlidesMode('text');
              toast('PDF에서 읽은 글자를 텍스트로 옮겼어요. 고쳐서 쓸 수 있어요.');
            },
          },
          '텍스트로 보고 고치기',
        ),
      );
      if (S.inkFile) compareInk();
    } catch (e) {
      S.pdfSlides = null;
      S.pdfFile = null;
      status.textContent = `PDF를 읽지 못했어요: ${e?.message || e}. 인터넷 연결을 확인하거나 “텍스트 붙여넣기”를 써 주세요.`;
    }
  };
  pdfInput.addEventListener('change', () => handlePdf(pdfInput.files[0]));
  bindDrop($('#slides-pdf .drop'), handlePdf);

  // 필기한 교안 PDF (내 필기 / 교수님 판서본)
  const handleInk = (file) => {
    if (!file) return;
    markRun('start');
    S.inkFile = file;
    S.ink = null;
    compareInk();
  };
  $('#ink-file').addEventListener('change', (e) => handleInk(e.target.files[0]));
  bindDrop($('.drop--ink'), handleInk);
  for (const r of $$('input[name="ink-kind"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      S.inkKind = r.value;
      if (S.ink) renderInkStatus();
    });
  }

  // 타이핑 필기 file
  $('#notes-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      $('#notes').value = await readFileText(f);
      $('#notes-status').textContent = `「${f.name}」 열었어요 (${(f.size / 1024).toFixed(1)}KB)`;
      markRun('start');
    } catch {
      $('#notes-status').textContent = '파일을 읽지 못했어요.';
    }
  });
  $('#copy-transcribe').addEventListener('click', async () => {
    const ok = await copyText(buildTranscribePrompt(currentSlides()));
    toast(ok ? '“필기 옮겨 적기” 프롬프트를 복사했어요. AI 채팅에 붙여넣고 필기 사진을 첨부하세요' : '복사하지 못했어요');
  });

  bindStripDrag();
  // The strip is laid out only once its panel is visible; re-place the 진도선 whenever its size changes.
  if ('ResizeObserver' in globalThis) new ResizeObserver(() => S.analysis && positionLine()).observe($('#strip'));
  $('#to-generate').addEventListener('click', toGenerate);
  $('#demo-guide-btn').addEventListener('click', runDemoEngine);
  $('#copy-prompt').addEventListener('click', async () => {
    const ok = await copyText(S.prompt?.text || '');
    toast(ok ? '프롬프트를 복사했어요. AI 채팅에 붙여넣으세요' : '복사하지 못했어요. “내용 보기”에서 직접 복사해 주세요');
  });
  $('#parse-reply').addEventListener('click', runPasteEngine);

  // gemini
  const savedKey = store.get(KEYS.gemKey);
  if (savedKey) {
    $('#gemini-key').value = savedKey;
    $('#gemini-remember').checked = true;
  }
  $('#gemini-model').value = store.get(KEYS.gemModel) || DEFAULT_MODEL;
  $('#gemini-key-toggle').addEventListener('click', (e) => {
    const inp = $('#gemini-key');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? '숨기기' : '보기';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });
  $('#gemini-remember').addEventListener('change', (e) => {
    if (!e.target.checked) store.remove(KEYS.gemKey);
    else if ($('#gemini-key').value.trim()) store.set(KEYS.gemKey, $('#gemini-key').value.trim());
  });
  $('#gemini-clear').addEventListener('click', () => {
    store.remove(KEYS.gemKey);
    $('#gemini-key').value = '';
    $('#gemini-remember').checked = false;
    toast('저장된 키를 지웠어요');
  });
  $('#gemini-run').addEventListener('click', runGeminiEngine);

  $('#present-open').addEventListener('click', openPresent);
  $('#wipe-data').addEventListener('click', () => {
    const raw = store.raw();
    if (raw) for (const k of Object.keys(raw)) if (k.startsWith('ttak.')) raw.removeItem(k);
    S.doc = null;
    S.quiz = null;
    S.run = emptyRun();
    refreshCourseList();
    toast('이 브라우저에 남은 기록을 모두 지웠어요');
  });
  // Browser-menu printing: show evidence too (closed <details> never print).
  window.addEventListener('beforeprint', () => $$('#guide-root details.evidence').forEach((d) => (d.open = true)));
}

bind();
renderHeroStrip();
setSlidesMode('pdf');
route();
