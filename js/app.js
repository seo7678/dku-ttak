// 딱 거기까지 — UI controller. Logic lives in ./lib (pure, tested); this file only wires DOM.
import { $, $$, h, svg, clear, toast, copyText, download, readFileText, store } from './ui/dom.js';
import { extractPdfPages, qrSvg } from './ui/vendor.js';
import { parseSlides, slidesFromPages } from './lib/parse.js';
import { analyzeLecture } from './lib/pipeline.js';
import { STATUS, STATUS_LABEL } from './lib/coverage.js';
import { cueLabel } from './lib/emphasis.js';
import { buildPrompt } from './lib/prompt.js';
import { parseReply, normalizeGuide, ReplyError } from './lib/reply.js';
import { verifyGuide } from './lib/verify.js';
import { generateWithGemini, DEFAULT_MODEL } from './lib/gemini.js';
import { saveWeek, getCarryOver, mergeCarryOver, loadCourses, memoryStorage, courseKey } from './lib/weeks.js';
import { guideToMarkdown, SURVEY_ITEMS, BASELINE_ITEMS, buildSurveyResult } from './lib/export.js';
import * as Q from './lib/quiz.js';
import { emptyRun, mark, runSummary, formatDuration, loadRun, saveRun } from './lib/metrics.js';
import { formatTime } from './lib/text.js';
import * as DEMO from './data/demo-lecture.js';

const KEYS = { guide: 'ttak.v1.lastGuide', quiz: 'ttak.v1.lastQuiz', gemKey: 'ttak.v1.geminiKey', gemModel: 'ttak.v1.geminiModel' };
const storage = store.raw() || memoryStorage();
const VIEWS = ['home', 'make', 'guide', 'quiz', 'survey', 'about'];
const FORMAT_LABEL = { speaker: '참석자 + 시간 형식 (클로바노트 등)', srt: 'SRT 자막', vtt: 'WebVTT 자막', timestamped: '시간 표시 텍스트', plain: '일반 텍스트' };
const SRC_CLASS = { slide: 'slide', lecture: 'lecture', ai: 'ai' };
const SRC_TAG = { slide: '교안', lecture: '수업 녹음', ai: 'AI 보충' };

const S = {
  slidesMode: 'pdf',
  pdfSlides: null,
  transcriptName: '',
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
  filters: { slide: true, lecture: true, ai: true },
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
const refDisplay = (r) => (r[0] === 'T' ? 'T' + r.slice(1).padStart(2, '0') : r);

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
  const brief = 7;
  const stars = new Set([3, 5, 8]);
  for (let i = 1; i <= 12; i++) {
    const cls = i === brief ? 'is-brief' : i <= 8 ? 'is-covered' : '';
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
    h('div.carry__head', h('span.carry__icon', { 'aria-hidden': 'true' }, '↩'), h('div', h('p.carry__msg', c.message), c.stoppedTitle ? h('p.carry__sub', `지난주 마지막으로 다룬 쪽: ${c.stoppedLabel}쪽 「${c.stoppedTitle}」`) : null)),
  );
  if (c.uncovered.length) {
    box.append(h('div.carry__pages', c.uncovered.map((u) => h('span', `${u.label}. ${u.title}`))));
    box.append(h('label.check', h('input', { type: 'checkbox', id: 'carry-merge', checked: true }), `지난주 남은 ${c.uncovered.length}쪽을 이번 주 교안 앞에 붙여서 진도 감지하기`));
  }
  if (courseKey(course) === courseKey(DEMO.DEMO_COURSE) && week === 4) {
    box.append(h('div.actions.actions--tight', h('button.btn.btn--small', { type: 'button', onClick: () => demoFillWeek4() }, '예시 4주차 교안 · 녹음 채우기')));
  }
}

function inputError(msg) {
  const e = $('#input-error');
  e.textContent = msg;
  e.hidden = !msg;
  if (msg) e.scrollIntoView({ block: 'center' });
}

function demoFill() {
  resetRun();
  markRun('start');
  $('#course').value = DEMO.DEMO_COURSE;
  $('#week').value = String(DEMO.DEMO_WEEK);
  setSlidesMode('text');
  $('#slides-text').value = DEMO.DEMO_SLIDES_TEXT;
  $('#transcript').value = DEMO.DEMO_TRANSCRIPT;
  S.transcriptName = '';
  S.pdfSlides = null;
  $('#pdf-status').textContent = '';
  $('#transcript-status').textContent = '예시 녹음 전사 (창작) · 참석자 + 시간 형식';
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
  $('#transcript').value = DEMO.DEMO_WEEK4_TRANSCRIPT;
  $('#transcript-status').textContent = '예시 4주차 녹음 전사 (창작)';
  toast('예시 4주차를 채웠어요. “진도 감지하기”를 눌러 보세요.');
}

function isDemoInput(slides) {
  return (
    S.slidesMode === 'text' &&
    $('#slides-text').value === DEMO.DEMO_SLIDES_TEXT &&
    $('#transcript').value === DEMO.DEMO_TRANSCRIPT &&
    slides.length === 12 &&
    !slides.some((s) => s.carriedFrom)
  );
}

function analyze() {
  inputError('');
  const course = $('#course').value.trim();
  const week = Number($('#week').value) || 1;
  if (!course) return inputError('과목명을 적어 주세요. 주차 이어가기에 쓰여요.');
  let slides = S.slidesMode === 'pdf' ? S.pdfSlides : parseSlides($('#slides-text').value);
  if (!slides || !slides.length) return inputError(S.slidesMode === 'pdf' ? '교안 PDF를 올리거나 “텍스트 붙여넣기”로 교안을 넣어 주세요.' : '교안 텍스트를 붙여넣어 주세요.');
  const transcript = $('#transcript').value;
  if (!transcript.trim()) return inputError('수업 녹음 전사를 붙여넣거나 파일로 열어 주세요.');
  if (S.carry && $('#carry-merge')?.checked) slides = mergeCarryOver(S.carry, slides);
  const a = analyzeLecture({ slides, transcriptText: transcript, transcriptName: S.transcriptName });
  if (!a.chunks.length) return inputError('전사에서 문장을 찾지 못했어요. 텍스트가 맞는지 확인해 주세요.');
  S.analysis = a;
  S.input = { course, week };
  S.isDemo = isDemoInput(slides);
  S.autoProgress = a.coverage.progress;
  markRun('start');
  markRun('analyzed');
  $('#transcript-status').textContent = `${FORMAT_LABEL[a.transcriptFormat] || a.transcriptFormat}으로 읽음 · 문단 ${a.chunks.length}개 (근거 번호 ${a.chunks[0].id}–${a.chunks[a.chunks.length - 1].id})`;
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
  if (!cov.emphasis.length) list.append(h('li.empty-note', '“시험·중요·꼭·헷갈’ 같은 강조 표현을 찾지 못했어요.'));
  for (const e of cov.emphasis) {
    const s = a.slides.find((x) => x.index === e.slideIndex);
    list.append(
      h(
        'li.em-item',
        h('div.em-item__meta', s ? `${slideLabel(s)}쪽` : '', ...e.cues.map((c) => h('span.tag.tag--em', cueLabel(c))), h('span.ref', e.chunkId), e.time != null ? h('span.time', formatTime(e.time)) : null),
        h('q', e.sentence),
      ),
    );
  }
  renderPreviewCallout();
  renderFlow();
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
      h('b', '다음 시간 예고 '),
      '교수님: “',
      p.sentence,
      '”',
      next ? h('div', `→ 다음 수업은 ${slideLabel(next)}쪽 「${next.title}」부터`) : null,
    ),
  );
}

function renderFlow() {
  const a = S.analysis;
  const tl = a.coverage.timeline;
  const box = $('#flow');
  clear(box);
  if (!tl.length) return;
  const n = a.slides.length;
  const W = globalThis.innerWidth < 600 ? 360 : 560; // narrower canvas on phones keeps labels readable
  const H = Math.max(200, Math.min(320, 40 + n * 18));
  const m = { l: 40, r: 16, t: 14, b: 28 };
  const hasTime = tl.every((t) => t.time != null);
  const xs = tl.map((t, i) => (hasTime ? t.time : i));
  const last = tl[tl.length - 1];
  const xEnd = hasTime ? last.time + Math.max(60, (last.chars / 280) * 60) : tl.length;
  const xMax = Math.max(xEnd, 1);
  const X = (v) => m.l + (v / xMax) * (W - m.l - m.r);
  const Y = (idx) => m.t + ((idx - 0.5) / n) * (H - m.t - m.b);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `수업 흐름: 녹음 순서대로 1쪽부터 ${S.autoProgress}쪽까지 설명` });
  const step = n > 16 ? Math.ceil(n / 12) : 1;
  for (let i = 1; i <= n; i += step) {
    root.append(svg('line', { class: 'f-grid', x1: m.l, x2: W - m.r, y1: Y(i), y2: Y(i) }));
    root.append(svg('text', { class: 'f-label', x: m.l - 8, y: Y(i) + 4, 'text-anchor': 'end' }, a.slides[i - 1].label));
  }
  const ticks = hasTime ? [0, xMax / 2, xMax] : [0, xMax];
  for (const t of ticks) {
    root.append(svg('text', { class: 'f-label', x: X(t), y: H - 8, 'text-anchor': t === 0 ? 'start' : t === xMax ? 'end' : 'middle' }, hasTime ? formatTime(t) : t === 0 ? '시작' : '끝'));
  }
  // progress line
  const py = S.progress > 0 ? Y(S.progress) + (H - m.t - m.b) / n / 2 : m.t;
  root.append(svg('line', { class: 'f-prog', x1: m.l, x2: W - m.r, y1: py, y2: py, id: 'flow-prog' }));
  root.append(svg('text', { class: 'f-prog-label', x: m.l + 4, y: py + 13, 'text-anchor': 'start', id: 'flow-prog-label' }, `진도선 ${a.slides[S.progress - 1] ? slideLabel(a.slides[S.progress - 1]) : S.progress}쪽 ↑ 여기까지 수업`));
  // path
  let d = '';
  tl.forEach((t, i) => {
    const x0 = X(xs[i]);
    const x1 = X(i + 1 < tl.length ? xs[i + 1] : xEnd);
    const y = Y(t.slideIndex);
    d += `${i === 0 ? 'M' : 'L'}${x0.toFixed(1)} ${y.toFixed(1)} L${x1.toFixed(1)} ${y.toFixed(1)} `;
  });
  root.append(svg('path', { class: 'f-path', d }));
  tl.forEach((t, i) => root.append(svg('circle', { class: t.offTopic ? 'f-dot off' : 'f-dot', cx: X(xs[i]), cy: Y(t.slideIndex), r: 3.2 }, svg('title', {}, `${t.chunkId} → ${t.slideIndex}쪽`))));
  for (const e of a.coverage.emphasis) {
    const i = tl.findIndex((t) => t.chunkId === e.chunkId);
    if (i < 0) continue;
    root.append(svg('circle', { class: 'f-em', cx: X(xs[i]) + 8, cy: Y(e.slideIndex) - 7, r: 5 }, svg('title', {}, `강조: ${e.sentence}`)));
  }
  if (a.coverage.previews.length) {
    const xp = X(xEnd);
    const yp = Y(Math.min(n, (a.coverage.previews[0].slideIndex || S.progress + 1)));
    root.append(svg('path', { class: 'f-prev', d: `M${xp - 2} ${yp} l-9 -6 v12 z` }, svg('title', {}, '“다음 시간에” — 예고된 쪽')));
  }
  box.append(root);
}

function renderSlideRows() {
  const a = S.analysis;
  const ol = $('#slide-rows');
  clear(ol);
  const chunkById = new Map(a.chunks.map((c) => [c.id, c]));
  a.coverage.slides.forEach((p, i) => {
    const s = a.slides[i];
    const skipped = p.status === STATUS.NONE && p.index < S.progress;
    ol.append(
      h(
        'li.slide-row',
        h(
          'div.slide-row__head',
          h('span', `${slideLabel(s)}쪽`),
          h('span', p.title),
          h('span', { class: ['st', skipped ? 'st--skipped' : `st--${p.status}`] }, skipped ? '건너뜀' : STATUS_LABEL[p.status]),
          p.chars ? h('small', `${p.chars}자`) : null,
        ),
        p.chunkIds.length
          ? h(
              'ul.slide-row__chunks',
              p.chunkIds.map((id) => {
                const c = chunkById.get(id);
                return h('li', h('span.ref', id), ' ', c.time != null ? h('span.time', formatTime(c.time) + ' ') : null, c.text.length > 180 ? c.text.slice(0, 178) + '…' : c.text);
              }),
            )
          : null,
      ),
    );
  });
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
    c.classList.toggle('is-skipped', cov.status === STATUS.NONE && idx < p);
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
  const prog = $('#flow-prog');
  if (prog) renderFlow();
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
  return `${where} 「${s.title ?? ''}」에서 수업이 끝났어요${carried ? ` · 지난주 남은 ${carried}쪽 포함` : ''}`;
}

function renderCovSummary() {
  const a = S.analysis;
  const cov = a.coverage;
  const box = $('#cov-summary');
  clear(box);
  const n = a.slides.length;
  const count = (st) => cov.slides.filter((p) => p.status === st).length;
  const skipped = cov.slides.filter((p) => p.status === STATUS.NONE && p.index < S.progress).length;
  const s = a.slides[S.progress - 1];
  box.append(
    h('div.cov-big', h('span.red', String(S.progress)), h('small', ` / ${n}쪽${a.slides.some((x) => x.carriedFrom) ? ' (합친 교안 기준)' : ''}`)),
    h('div.cov-text', S.progress ? covEndText(a, s) : '수업한 쪽을 찾지 못했어요. 진도선을 직접 옮겨 주세요.'),
    h(
      'div.cov-chips',
      h('span.c-covered', `다룸 ${count(STATUS.COVERED)}`),
      h('span', `잠깐 언급 ${count(STATUS.BRIEF)}`),
      h('span', `안 다룸 ${count(STATUS.NONE)}`),
      skipped ? h('span.c-manual', `진도선 안 건너뜀 ${skipped}`) : null,
      h('span.c-em', `강조 ${cov.emphasis.length}곳`),
      S.progress !== S.autoProgress ? h('span.c-manual', `직접 조정 (자동: ${S.autoProgress}쪽)`) : null,
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
function toGenerate() {
  if (!S.analysis || !S.progress) return;
  const saved = saveWeek(storage, { course: S.input.course, week: S.input.week, progress: S.progress, slides: S.analysis.slides });
  if (saved) toast(`${S.input.week}주차 진도선(${saved.stoppedLabel}쪽)을 저장했어요 — 다음 주에 이어서 보여 드려요`, 2800);
  refreshGenerate();
  selectEngine(S.isDemo ? 'demo' : S.engine === 'demo' ? 'paste' : S.engine);
  showStep(3);
}

function refreshGenerate() {
  const a = S.analysis;
  const first = a.slides[0];
  const last = a.slides[S.progress - 1];
  $('#gen-range').textContent = `${slideLabel(first)}–${last ? slideLabel(last) : S.progress}쪽만 사용`;
  S.prompt = buildPrompt({ course: S.input.course, week: S.input.week, slides: a.slides, chunks: a.chunks, coverage: a.coverage, progress: S.progress });
  $('#prompt-box').value = S.prompt.text;
  $('#prompt-meta').textContent = `약 ${S.prompt.text.length.toLocaleString()}자 · 교안 ${S.prompt.coveredCount}쪽 + 그 쪽들의 녹음 발췌만 들어 있어요${S.prompt.truncated ? ' · 너무 길어 일부 발췌를 뺐어요' : ''}`;
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
  status.textContent = `${model}로 만드는 중… 보통 20–60초 걸려요`;
  geminiAbort = new AbortController();
  const timer = setTimeout(() => geminiAbort.abort(), 180000);
  try {
    const text = await generateWithGemini({ apiKey: key, model, prompt: S.prompt.text, signal: geminiAbort.signal });
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
  const v = verifyGuide(guide, { slides: a.slides, chunks: a.chunks, progress: S.progress, coverage: a.coverage });
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
    course: S.input.course,
    week: S.input.week,
    progress: S.progress,
    autoProgress: S.autoProgress,
    total: a.slides.length,
    engine,
    demo: S.isDemo,
    createdAt: new Date().toISOString(),
    labels,
    slides: v.slides,
    questions: v.questions,
    nextPreview: v.nextPreview,
    warnings: v.warnings,
    stats: v.stats,
    toGuideMs: runSummary(S.run).toGuideMs,
    coverageStats: {
      covered: cov.slides.filter((p) => p.status === STATUS.COVERED).length,
      brief: cov.slides.filter((p) => p.status === STATUS.BRIEF).length,
      emphasis: cov.emphasis.length,
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
  return h(
    'li',
    { class: ['stmt', `stmt--${src}`] },
    h('span', { class: ['tag', `tag--${src}`] }, SRC_TAG[src]),
    h(
      'div.stmt__text',
      st.text,
      st.refs?.length ? h('span.stmt__refs', st.refs.map((r) => h('span.ref', { class: r[0] === 'P' ? 'ref--p' : null, title: r[0] === 'T' ? '수업 녹음 근거 번호' : '교안 쪽' }, refDisplay(r)))) : null,
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
      h('span', h('b', `${lab(doc, first?.slide ?? 1)}–${lab(doc, doc.progress)}쪽`), ` 해설 (전체 ${doc.total}쪽 중, `, h('b.red', `진도선 ${lab(doc, doc.progress)}쪽`), ')'),
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
      ...['slide', 'lecture', 'ai'].map((k) =>
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
          `${SRC_TAG[k]} ${st[k]}`,
        ),
      ),
      h('span.verify__note', 'AI가 단 근거 번호(T··· = 녹음 문단, P··· = 교안 쪽)를 브라우저가 실제 입력과 다시 대조했어요. 녹음 근거가 없는 “수업” 문장은 AI 보충으로 내립니다.'),
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
        h('span', { class: ['scard__no', s.coverage === 'brief' ? 'is-brief' : s.coverage === 'none' ? 'is-none' : ''] }, lab(doc, s.slide)),
        h(
          'div',
          h('h2.scard__title', s.title),
          h(
            'div.scard__sub',
            h('span', { class: ['st', `st--${s.coverage === 'none' ? 'skipped' : s.coverage || 'covered'}`] }, s.coverage === 'none' ? '수업에서 안 다룸 · 교안만' : STATUS_LABEL[s.coverage] || '다룸'),
            ...cues.map((c) => h('span.badge-em', '★ ' + cueLabel(c))),
          ),
        ),
      ),
    );
    if (s.missing) card.append(h('p.missing', 'AI가 이 쪽 해설을 만들지 않았어요. 아래 녹음 근거와 교안을 직접 확인해 주세요.'));
    const sec = (title, arr) => {
      if (!arr?.length) return;
      card.append(h('section.sec', h('h3.sec__title', title), h('ul.stmts', arr.map(stmtEl))));
    };
    sec('핵심 정리', s.summary);
    sec('교수님이 말로 덧붙인 것', s.spoken);
    sec('강조 포인트', s.emphasis);
    sec('헷갈리기 쉬운 점', s.pitfalls);
    if (s.evidence?.length) {
      card.append(
        h(
          'details.evidence',
          h('summary', `수업 녹음 근거 ${s.evidence.length}개 보기`),
          h('ol', s.evidence.map((e) => h('li', h('span.ref', e.id), ' ', e.time != null ? h('span.time', formatTime(e.time) + ' ') : null, e.text))),
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
  $('#transcript').value = '';
  $('#transcript-status').textContent = '';
  $('#pdf-status').textContent = '';
  S.pdfSlides = null;
  S.transcriptName = '';
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
    h('div.reveal', h('div.reveal__box.reveal__mine', h('h3', '내 답'), h('p', q.answers[cur.qid] || '')), h('div.reveal__box.reveal__ans', h('h3', '정답'), h('p', cur.answer), cur.refs?.length ? h('span.stmt__refs', cur.refs.map((r) => h('span.ref', { class: r[0] === 'P' ? 'ref--p' : null }, refDisplay(r)))) : null)),
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
    progress: d?.progress ?? null,
    covered: d?.coverageStats?.covered ?? null,
    brief: d?.coverageStats?.brief ?? null,
    emphasis: d?.coverageStats?.emphasis ?? null,
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
      h('div.field', h('label', { for: 'sv-improve' }, '5. 고쳤으면 하는 점 (자유롭게)'), h('textarea#sv-improve', { name: 'improve', rows: '3', placeholder: '예: 그림이 많은 교안도 읽었으면 좋겠어요' })),
      h('h2.survey-sec', '평소 방식과 비교 (선택)'),
      h('div.field.field--narrow', { style: { 'max-width': '380px' } }, h('label', { for: 'sv-minutes' }, BASELINE_ITEMS.minutes), h('input#sv-minutes', { type: 'number', name: 'baselineMinutes', min: '1', max: '600', inputmode: 'numeric', placeholder: '예: 60' })),
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
  box.append(
    h('b', '함께 보내는 자동 측정값 (이 브라우저가 잰 값, 개인정보 없음)'),
    h(
      'ul',
      h('li', `입력 시작 → 해설지: ${m.toGuideMs != null ? formatDuration(m.toGuideMs) : '아직 측정 안 됨'}`),
      h('li', `회상 퀴즈: 첫 시도 ${pct(m.quizFirstPct)} → 다시 푼 뒤 ${pct(m.quizAfterPct)}`),
      h('li', `진도: ${m.slides ?? '—'}쪽 중 ${m.progress ?? '—'}쪽까지 · 다룸 ${m.covered ?? '—'} · 강조 ${m.emphasis ?? '—'}곳`),
      h('li', `엔진: ${m.engine ?? '—'}${m.demo ? ' (예시 데이터)' : ''}`),
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
function demoStartFlow() {
  demoFill();
  analyze();
  go('#/make', () => showStep(2));
}

function demoGuideFlow() {
  demoFill();
  analyze();
  toGenerate();
  runDemoEngine();
}

// ======================= wiring =======================
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
    if (e.target.id !== 'carry-merge') markRun('start');
  });

  // PDF
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
        status.textContent = '글자를 찾지 못했어요. 스캔한 PDF일 수 있어요 — “텍스트 붙여넣기”로 넣어 주세요.';
        return;
      }
      S.pdfSlides = slides;
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
    } catch (e) {
      S.pdfSlides = null;
      status.textContent = `PDF를 읽지 못했어요: ${e?.message || e}. 인터넷 연결을 확인하거나 “텍스트 붙여넣기”를 써 주세요.`;
    }
  };
  pdfInput.addEventListener('change', () => handlePdf(pdfInput.files[0]));
  const drop = $('.drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    handlePdf(e.dataTransfer.files[0]);
  });

  // transcript file
  $('#transcript-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      $('#transcript').value = await readFileText(f);
      S.transcriptName = f.name;
      $('#transcript-status').textContent = `「${f.name}」 열었어요 (${(f.size / 1024).toFixed(1)}KB)`;
      markRun('start');
    } catch {
      $('#transcript-status').textContent = '파일을 읽지 못했어요.';
    }
  });
  $('#transcript').addEventListener('input', () => (S.transcriptName = ''));

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
