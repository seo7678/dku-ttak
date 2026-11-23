// Markdown export of a verified guide + survey result builder. Pure functions.
import { formatDuration } from './metrics.js';

export const SOURCE_LABEL = { slide: '교안', note: '필기', ai: 'AI 보충' };
export const COVERAGE_LABEL = { ink: '필기 있음', light: '필기 조금', none: '필기 없음 · 교안으로 설명' };
const ORIGIN_LABEL = { typed: '내 필기', ink: '내 필기 (필기한 교안)', pan: '교수님 판서' };

function line(st) {
  const tag = `[${SOURCE_LABEL[st.source] || st.source}]`;
  const refs = st.refs?.length ? ` (근거: ${st.refs.join(', ')})` : '';
  const quote = st.quote ? ` — “${st.quote}”` : '';
  return `- ${tag} ${st.text}${quote}${refs}`;
}

/**
 * @param doc { course, week, progress, total, engine, createdAt, slides, questions, nextPreview, labels?: Map index→label }
 */
export function guideToMarkdown(doc) {
  const L = [];
  const lab = (n) => doc.labels?.get?.(n) ?? String(n);
  L.push(`# ${doc.course || '강의'} ${doc.week ? doc.week + '주차' : ''} 복습 노트`.trim());
  L.push('');
  L.push(`> 딱 거기까지 — 오늘 수업이 실제로 끝난 **${lab(doc.progress)}쪽**까지만 만든 복습 노트 (전체 ${doc.total}쪽)  `);
  L.push(`> 생성: ${doc.engine || ''} · ${doc.createdAt ? doc.createdAt.slice(0, 10) : ''}  `);
  L.push('> 출처 표시: [교안] 슬라이드 글 · [필기] 내 필기 또는 교수님 판서 (근거 n··· = 타이핑 필기 줄, ink-p··· = 필기한 교안 쪽, pan-p··· = 판서본 쪽) · [AI 보충] 교안·필기에 없는 AI 설명(확인 필요)');
  L.push('');
  for (const s of doc.slides) {
    L.push(`## ${lab(s.slide)}쪽. ${s.title}${s.coverage && s.coverage !== 'ink' ? ` _(${COVERAGE_LABEL[s.coverage] || s.coverage})_` : ''}`);
    if (s.missing) L.push('_AI가 이 쪽 해설을 만들지 않았어요._');
    const sec = (name, arr) => {
      if (!arr?.length) return;
      L.push('');
      L.push(`**${name}**`);
      arr.forEach((st) => L.push(line(st)));
    };
    sec('핵심 정리', s.summary);
    sec('내 필기에만 있는 것 (교안에 없음)', s.notes);
    sec('강조 포인트', s.emphasis);
    sec('헷갈리기 쉬운 점', s.pitfalls);
    if (s.evidence?.length) {
      L.push('');
      L.push('<details><summary>필기 근거</summary>');
      L.push('');
      s.evidence.forEach((e) => L.push(`- ${e.id} (${ORIGIN_LABEL[e.origin] || '필기'}): ${e.text}`));
      L.push('');
      L.push('</details>');
    }
    L.push('');
  }
  if (doc.questions?.length) {
    L.push('## 떠올리기 퀴즈 (답을 가리고 먼저 떠올려 보세요)');
    L.push('');
    doc.questions.forEach((q, i) => {
      L.push(`${i + 1}. [${q.type}${q.slide ? ` · ${lab(q.slide)}쪽` : ''}] ${q.question}`);
      L.push(`   <details><summary>정답</summary>${q.answer}</details>`);
    });
    L.push('');
  }
  if (doc.nextPreview?.length) {
    L.push('## 다음 수업 예고 (아직 안 배움 — 해설 없음)');
    L.push('');
    doc.nextPreview.forEach((p) => L.push(`- ${lab(p.slide)}쪽. ${p.title}`));
    L.push('');
  }
  return L.join('\n');
}

export const SURVEY_ITEMS = [
  { key: 'usefulness', label: '복습 노트가 공부에 쓸모 있었나요?' },
  { key: 'tags', label: '문장마다 붙은 교안 · 필기 · AI 보충 표시가 도움이 됐나요?' },
  { key: 'quiz', label: '떠올리기 퀴즈가 기억을 떠올리는 데 도움이 됐나요?' },
  { key: 'reuse', label: '다음 주 수업에도 다시 쓸 생각이 있나요?' },
];

// 제안된 진도선이 실제 수업과 맞았나 — 0 = 맞음, 1/2 = 그만큼 차이, 3 = 3쪽 이상.
export const PROGRESS_OFF_OPTIONS = [
  { value: '0', label: '맞았어요' },
  { value: '1', label: '1쪽 차이' },
  { value: '2', label: '2쪽 차이' },
  { value: '3', label: '3쪽 이상 차이' },
];

// Before/after baseline asked of the user (self-report), next to what the app measured itself.
export const BASELINE_ITEMS = {
  minutes: '평소 교안 + 필기로 복습 자료를 만드는 데 걸리는 시간 (분)',
  confidence: '평소 방식으로 복습했을 때, 이런 퀴즈를 풀 자신감 (1–5)',
  progressOff: '앱이 제안한 진도선(“오늘 어디까지”)이 실제 수업과 맞았나요?',
};

const int1to5 = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

/**
 * @param answers { usefulness, tags, quiz, reuse: 1..5, progressOff: 0..3, baselineConfidence: 1..5, baselineMinutes, improve, nickname? }
 * @param meta { engine, demo, slides, progress, suggested, noted, light, emphasis, noteLines, inkKind, toGuideMs, quizFirstPct, quizAfterPct, quizTotal, app }
 */
export function buildSurveyResult(answers, meta = {}, now = new Date()) {
  const scores = {};
  for (const it of SURVEY_ITEMS) scores[it.key] = int1to5(answers[it.key]);
  const missing = SURVEY_ITEMS.filter((it) => scores[it.key] == null).map((it) => it.key);
  const bm = Number(answers.baselineMinutes);
  const po = answers.progressOff === '' || answers.progressOff == null ? NaN : Number(answers.progressOff);
  const baseline = {
    minutes: Number.isFinite(bm) && bm > 0 && bm < 10000 ? Math.round(bm) : null,
    confidence: int1to5(answers.baselineConfidence),
  };
  const progressOff = Number.isInteger(po) && po >= 0 && po <= 3 ? po : null;
  const improve = String(answers.improve ?? '').trim().slice(0, 1000);
  const nickname = String(answers.nickname ?? '').trim().slice(0, 20) || undefined;
  const toGuideMin = meta.toGuideMs != null ? Math.round((meta.toGuideMs / 60000) * 10) / 10 : null;
  const measured = {
    toGuideMin,
    toGuideSec: meta.toGuideMs != null ? Math.round(meta.toGuideMs / 1000) : null,
    quizFirstPct: meta.quizFirstPct ?? null,
    quizAfterPct: meta.quizAfterPct ?? null,
    quizTotal: meta.quizTotal ?? null,
    slides: meta.slides ?? null,
    suggested: meta.suggested ?? null,
    progress: meta.progress ?? null,
    adjusted: meta.progress != null && meta.suggested != null ? meta.progress - meta.suggested : null,
    noted: meta.noted ?? null,
    light: meta.light ?? null,
    emphasis: meta.emphasis ?? null,
    noteLines: meta.noteLines ?? null,
    inkKind: meta.inkKind ?? null,
    engine: meta.engine ?? null,
    demo: meta.demo ?? null,
  };
  const json = {
    v: 3,
    app: meta.app || 'ttak-geogikkaji',
    date: now.toISOString().slice(0, 10),
    nickname,
    scores,
    progressOff,
    baseline,
    measured,
    improve,
  };
  const stars = (n) => (n ? '●'.repeat(n) + '○'.repeat(5 - n) + ` ${n}/5` : '미응답');
  const pct = (v) => (v == null ? '—' : `${v}%`);
  const offText = progressOff == null ? '미응답' : PROGRESS_OFF_OPTIONS.find((o) => Number(o.value) === progressOff).label;
  const inkText = { mine: '필기한 교안 PDF', pan: '교수님 판서본 PDF' }[measured.inkKind];
  const text = [
    `[딱 거기까지 사용 후기]${nickname ? ` ${nickname}` : ''} · ${json.date}`,
    ...SURVEY_ITEMS.map((it, i) => `${i + 1}. ${it.label} ${stars(scores[it.key])}`),
    `5. 제안된 진도선: ${offText}`,
    `6. 개선점: ${improve || '(없음)'}`,
    '',
    '[평소 방식 (본인 응답)]',
    `- 교안 + 필기로 복습 자료 만드는 데 걸리던 시간: ${baseline.minutes != null ? baseline.minutes + '분' : '미응답'}`,
    `- 평소 방식의 퀴즈 자신감: ${stars(baseline.confidence)}`,
    '',
    '[이번에 앱이 잰 값 (자동)]',
    `- 입력 시작 → 복습 노트: ${meta.toGuideMs != null ? formatDuration(meta.toGuideMs) : '측정 안 됨'}`,
    `- 떠올리기 퀴즈 첫 시도 ${pct(measured.quizFirstPct)} → 다시 풀기 후 ${pct(measured.quizAfterPct)}${measured.quizTotal ? ` (${measured.quizTotal}문항)` : ''}`,
    `- 진도선: 전체 ${measured.slides ?? '—'}쪽 중 제안 ${measured.suggested ?? '—'}쪽 → 최종 ${measured.progress ?? '—'}쪽${measured.adjusted ? ` (직접 ${measured.adjusted > 0 ? '+' : ''}${measured.adjusted}쪽 조정)` : ''}`,
    `- 필기: 필기 있음 ${measured.noted ?? '—'}쪽 · 필기 조금 ${measured.light ?? '—'}쪽 · 강조 ${measured.emphasis ?? '—'}곳 · 타이핑 필기 ${measured.noteLines ?? '—'}줄${inkText ? ` · ${inkText}` : ''}`,
    `- 엔진: ${measured.engine ?? '—'}${measured.demo ? ' (예시 데이터)' : ''}`,
    '',
    'JSON: ' + JSON.stringify(json),
  ].join('\n');
  return { ok: missing.length === 0, missing, json, text };
}
