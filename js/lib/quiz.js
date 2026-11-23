// 회상 퀴즈 state machine: answer first → reveal → self-grade ○ △ ✕ → ✕/△ come back in a retry round.
// Pure: every function returns a new state.

export const MARK_SCORE = { o: 1, t: 0.5, x: 0 };
export const MARK_LABEL = { o: '○', t: '△', x: '✕' };

export function createQuiz(questions) {
  return {
    questions: questions.map((q, i) => ({ ...q, qid: i })),
    round: 1,
    queue: questions.map((_, i) => i),
    pos: 0,
    revealed: false,
    answers: {}, // qid → last typed answer
    first: {}, // qid → first-round mark
    last: {}, // qid → latest mark
    history: [], // {qid, round, mark, answer}
    done: questions.length === 0,
  };
}

export function current(state) {
  if (state.done) return null;
  return state.questions[state.queue[state.pos]];
}

/** Reveal is only allowed after the student typed something (or explicitly said 모르겠어요). */
export function canReveal(answer) {
  return String(answer ?? '').trim().length >= 1;
}

export function reveal(state, answer) {
  if (state.done || !canReveal(answer)) return state;
  const q = current(state);
  return { ...state, revealed: true, answers: { ...state.answers, [q.qid]: String(answer).trim() } };
}

export function grade(state, mark) {
  if (state.done || !state.revealed || !(mark in MARK_SCORE)) return state;
  const q = current(state);
  const next = {
    ...state,
    revealed: false,
    last: { ...state.last, [q.qid]: mark },
    first: state.round === 1 ? { ...state.first, [q.qid]: mark } : state.first,
    history: [...state.history, { qid: q.qid, round: state.round, mark, answer: state.answers[q.qid] }],
    pos: state.pos + 1,
  };
  if (next.pos < next.queue.length) return next;
  // end of round: retry ✕/△ once more each round until all ○ or the student stops
  const retry = next.queue.filter((qid) => next.last[qid] !== 'o');
  if (!retry.length) return { ...next, done: true };
  return { ...next, round: next.round + 1, queue: retry, pos: 0, roundEnded: true };
}

/** Continue after a round summary (clears the roundEnded flag). */
export function continueRetry(state) {
  return { ...state, roundEnded: false };
}

export function finish(state) {
  return { ...state, done: true, roundEnded: false };
}

function scoreOf(marks, total) {
  const vals = Object.values(marks);
  const pts = vals.reduce((a, m) => a + MARK_SCORE[m], 0);
  return { points: pts, total, percent: total ? Math.round((pts / total) * 100) : 0, o: vals.filter((m) => m === 'o').length, t: vals.filter((m) => m === 't').length, x: vals.filter((m) => m === 'x').length };
}

/** First-attempt score vs score after retries (each question counted once, latest mark). */
export function summary(state) {
  const total = state.questions.length;
  const first = scoreOf(state.first, total);
  const after = scoreOf(state.last, total);
  const weak = state.questions.filter((q) => state.first[q.qid] && state.first[q.qid] !== 'o').map((q) => ({ qid: q.qid, slide: q.slide, question: q.question, first: state.first[q.qid], last: state.last[q.qid] }));
  return { total, first, after, rounds: state.round, weak, answered: Object.keys(state.first).length };
}
