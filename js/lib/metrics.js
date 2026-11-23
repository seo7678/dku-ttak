// Local, honest measurement: how long did it take from first input to a usable 복습 노트 (and quiz)?
// Timestamps only — no content, no identity. Stored in localStorage on the user's device.

export const METRICS_KEY = 'ttak.v1.metrics';

export function emptyRun() {
  return { startedAt: null, analyzedAt: null, guideAt: null, quizStartedAt: null, quizDoneAt: null, engine: null, demo: false };
}

export function mark(run, event, now = Date.now()) {
  const r = { ...run };
  if (event === 'start') {
    if (!r.startedAt) r.startedAt = now;
  } else if (event === 'analyzed') r.analyzedAt = now;
  else if (event === 'guide') r.guideAt = now;
  else if (event === 'quizStart') {
    if (!r.quizStartedAt) r.quizStartedAt = now;
  } else if (event === 'quizDone') r.quizDoneAt = now;
  return r;
}

export function durationMs(from, to) {
  return from && to && to >= from ? to - from : null;
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  const s = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  if (m === 0) return `${r}초`;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

export function runSummary(run) {
  return {
    toGuideMs: durationMs(run.startedAt, run.guideAt),
    quizMs: durationMs(run.quizStartedAt, run.quizDoneAt),
    totalMs: durationMs(run.startedAt, run.quizDoneAt || run.guideAt),
  };
}

export function loadRun(storage) {
  try {
    return { ...emptyRun(), ...(JSON.parse(storage.getItem(METRICS_KEY) || 'null') || {}) };
  } catch {
    return emptyRun();
  }
}

export function saveRun(storage, run) {
  try {
    storage.setItem(METRICS_KEY, JSON.stringify(run));
  } catch {
    /* storage full / disabled — measurement is best-effort */
  }
}
