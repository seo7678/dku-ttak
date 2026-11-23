// Markdown export of a verified guide + survey result builder. Pure functions.
import { formatTime } from './text.js';
import { formatDuration } from './metrics.js';

export const SOURCE_LABEL = { slide: '교안', lecture: '수업 녹음', ai: 'AI 보충' };
export const COVERAGE_LABEL = { covered: '다룸', brief: '잠깐 언급', none: '안 다룸' };

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
  L.push(`# ${doc.course || '강의'} ${doc.week ? doc.week + '주차' : ''} 해설지`.trim());
  L.push('');
  L.push(`> 딱 거기까지 — 오늘 수업이 실제로 끝난 **${lab(doc.progress)}쪽**까지만 만든 해설지 (전체 ${doc.total}쪽)  `);
  L.push(`> 생성: ${doc.engine || ''} · ${doc.createdAt ? doc.createdAt.slice(0, 10) : ''}  `);
  L.push('> 출처 표시: [교안] 슬라이드 글 · [수업 녹음] 교수님 말 · [AI 보충] 교안/녹음에 없는 AI 설명(확인 필요)');
  L.push('');
  for (const s of doc.slides) {
    L.push(`## ${lab(s.slide)}쪽. ${s.title}${s.coverage && s.coverage !== 'covered' ? ` _(${COVERAGE_LABEL[s.coverage] || s.coverage})_` : ''}`);
    if (s.missing) L.push('_AI가 이 쪽 해설을 만들지 않았어요._');
    const sec = (name, arr) => {
      if (!arr?.length) return;
      L.push('');
      L.push(`**${name}**`);
      arr.forEach((st) => L.push(line(st)));
    };
    sec('핵심 정리', s.summary);
    sec('교수님이 말로 덧붙인 것', s.spoken);
    sec('강조 포인트', s.emphasis);
    sec('헷갈리기 쉬운 점', s.pitfalls);
    if (s.evidence?.length) {
      L.push('');
      L.push('<details><summary>수업 녹음 근거</summary>');
      L.push('');
      s.evidence.forEach((e) => L.push(`- ${e.id}${e.time != null ? ` (${formatTime(e.time)})` : ''}: ${e.text}`));
      L.push('');
      L.push('</details>');
    }
    L.push('');
  }
  if (doc.questions?.length) {
    L.push('## 회상 퀴즈 (답을 가리고 먼저 떠올려 보세요)');
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
  { key: 'accuracy', label: '진도 감지가 실제 수업 진도와 맞았나요?' },
  { key: 'usefulness', label: '해설지가 복습에 쓸모 있었나요?' },
  { key: 'quiz', label: '회상 퀴즈가 기억을 떠올리는 데 도움이 됐나요?' },
  { key: 'reuse', label: '다음 주 수업에도 다시 쓸 생각이 있나요?' },
];

// Before/after baseline asked of the user (self-report), next to what the app measured itself.
export const BASELINE_ITEMS = {
  minutes: '평소 이 작업(교안 + 녹음으로 복습 자료 만들기)에 걸리던 시간 (분)',
  confidence: '평소 방식으로 복습했을 때, 이런 퀴즈를 풀 자신감 (1–5)',
};

const int1to5 = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

/**
 * @param answers { accuracy, usefulness, quiz, reuse, baselineConfidence: 1..5, baselineMinutes: number, improve, nickname? }
 * @param meta { engine, slides, progress, covered, brief, emphasis, toGuideMs, quizFirstPct, quizAfterPct, quizTotal, app }
 */
export function buildSurveyResult(answers, meta = {}, now = new Date()) {
  const scores = {};
  for (const it of SURVEY_ITEMS) scores[it.key] = int1to5(answers[it.key]);
  const missing = SURVEY_ITEMS.filter((it) => scores[it.key] == null).map((it) => it.key);
  const bm = Number(answers.baselineMinutes);
  const baseline = {
    minutes: Number.isFinite(bm) && bm > 0 && bm < 10000 ? Math.round(bm) : null,
    confidence: int1to5(answers.baselineConfidence),
  };
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
    progress: meta.progress ?? null,
    covered: meta.covered ?? null,
    brief: meta.brief ?? null,
    emphasis: meta.emphasis ?? null,
    engine: meta.engine ?? null,
    demo: meta.demo ?? null,
  };
  const json = {
    v: 2,
    app: meta.app || 'ttak-geogikkaji',
    date: now.toISOString().slice(0, 10),
    nickname,
    scores,
    baseline,
    measured,
    improve,
  };
  const stars = (n) => (n ? '●'.repeat(n) + '○'.repeat(5 - n) + ` ${n}/5` : '미응답');
  const pct = (v) => (v == null ? '—' : `${v}%`);
  const text = [
    `[딱 거기까지 사용 후기]${nickname ? ` ${nickname}` : ''} · ${json.date}`,
    ...SURVEY_ITEMS.map((it, i) => `${i + 1}. ${it.label} ${stars(scores[it.key])}`),
    `5. 개선점: ${improve || '(없음)'}`,
    '',
    '[평소 방식 (본인 응답)]',
    `- 복습 자료 만드는 데 걸리던 시간: ${baseline.minutes != null ? baseline.minutes + '분' : '미응답'}`,
    `- 평소 방식의 퀴즈 자신감: ${stars(baseline.confidence)}`,
    '',
    '[이번에 앱이 잰 값 (자동)]',
    `- 입력 시작 → 해설지: ${meta.toGuideMs != null ? formatDuration(meta.toGuideMs) : '측정 안 됨'}`,
    `- 회상 퀴즈 첫 시도 ${pct(measured.quizFirstPct)} → 다시 풀기 후 ${pct(measured.quizAfterPct)}${measured.quizTotal ? ` (${measured.quizTotal}문항)` : ''}`,
    `- 진도: 전체 ${measured.slides ?? '—'}쪽 중 ${measured.progress ?? '—'}쪽까지 (다룸 ${measured.covered ?? '—'} · 잠깐 언급 ${measured.brief ?? '—'} · 강조 ${measured.emphasis ?? '—'}곳)`,
    `- 엔진: ${measured.engine ?? '—'}${measured.demo ? ' (예시 데이터)' : ''}`,
    '',
    'JSON: ' + JSON.stringify(json),
  ].join('\n');
  return { ok: missing.length === 0, missing, json, text };
}
