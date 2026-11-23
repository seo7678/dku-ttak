// Build one compact prompt that contains ONLY the covered slides, their aligned transcript excerpts,
// and the professor's emphasis quotes, and asks for a strict JSON schema.
import { formatTime } from './text.js';
import { cueLabel } from './emphasis.js';
import { STATUS_LABEL } from './coverage.js';

export const SCHEMA_EXAMPLE = `{
  "slides": [
    {
      "slide": 3,
      "title": "구간법의 원리",
      "summary": [
        { "text": "f(x_l)·f(x_u) < 0 이면 구간 안에 근이 있다 (중간값 정리)", "source": "교안", "refs": ["P3"] }
      ],
      "spoken": [
        { "text": "그래프를 먼저 그려 보고 초기 구간을 잡으라고 하셨다", "refs": ["T03"] }
      ],
      "emphasis": [
        { "text": "중간값 정리 조건", "quote": "이거 중요합니다.", "refs": ["T03"] }
      ],
      "pitfalls": [
        { "text": "중근은 부호가 안 바뀌어 구간법으로 못 잡는다", "source": "수업", "refs": ["T03"] }
      ]
    }
  ],
  "recall_questions": [
    { "slide": 3, "type": "예측", "question": "…", "answer": "…", "refs": ["T03"] }
  ]
}`;

/**
 * @param {object} p
 * @param {string} p.course
 * @param {number|string} p.week
 * @param {{index,label,title,text}[]} p.slides
 * @param {{id,time,text}[]} p.chunks
 * @param {ReturnType<import('./coverage.js').analyzeCoverage>} p.coverage
 * @param {number} p.progress  — 진도선 (slide index)
 * @param {number} [p.maxChars] — soft cap on the transcript part
 */
export function buildPrompt({ course, week, slides, chunks, coverage, progress, maxChars = 60000 }) {
  const covered = slides.filter((s) => s.index <= progress);
  const upcoming = slides.filter((s) => s.index > progress);
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const first = covered[0]?.index ?? 1;
  const L = [];
  L.push(`너는 대학 강의 복습용 "강의 해설지"를 만드는 조교다. 아래 [교안]과 [수업 녹음 전사]만 근거로, 오늘 수업이 실제로 다룬 ${first}~${progress}쪽에 대해서만 해설지를 만든다.`);
  L.push('');
  L.push('## 규칙');
  L.push(`1. ${progress}쪽 다음부터는 아직 수업에서 안 다룬 내용이다. 그 쪽들의 해설·문제는 절대 만들지 않는다.`);
  L.push('2. 모든 문장에 출처(source)를 단다: "교안"(슬라이드에 적힌 내용, refs에 P번호), "수업"(교수님이 말한 내용, refs에 T번호 필수), "AI"(교안·녹음 어디에도 없는 보충 설명이나 추정).');
  L.push('3. spoken에는 교안에 없고 교수님이 말로만 덧붙인 내용만 넣는다. 반드시 T번호를 단다.');
  L.push('4. emphasis에는 아래 [교수님 강조]를 바탕으로, quote에 교수님 말을 그대로 옮긴다.');
  L.push('5. 지어내지 않는다. 근거가 없으면 source를 "AI"로 쓴다. 숫자·공식은 교안/녹음과 똑같이 쓴다.');
  L.push('6. recall_questions는 학생이 정답을 보기 전에 스스로 떠올리게 하는 질문 6~10개. type은 "예측"(결과를 먼저 예상), "개념", "계산" 중 하나. 답은 짧고 정확하게.');
  L.push('7. "잠깐 언급"인 쪽은 짧게 정리한다.');
  L.push('8. 출력은 아래 스키마의 JSON 객체 하나만. 앞뒤 설명 없이.');
  L.push('');
  L.push('## 출력 스키마 (예시 값)');
  L.push(SCHEMA_EXAMPLE);
  L.push('');
  L.push(`## 과목: ${course || '(미입력)'} / ${week ? week + '주차' : ''}`);
  L.push('');
  L.push(`## [교안] — 오늘 다룬 ${first}~${progress}쪽 (P번호 = 쪽)`);
  for (const s of covered) {
    const st = coverage?.slides.find((p) => p.index === s.index)?.status;
    L.push(`### P${s.index} (${STATUS_LABEL[st] || '다룸'})`);
    L.push(s.text.trim() || '(텍스트 없음)');
  }
  L.push('');
  L.push('## [수업 녹음 전사] — 쪽별로 정렬된 발췌 (T번호 = 근거 번호)');
  let used = 0;
  let truncated = false;
  for (const s of covered) {
    const ids = coverage?.slides.find((p) => p.index === s.index)?.chunkIds || [];
    if (!ids.length) continue;
    L.push(`### ${s.index}쪽 설명 중`);
    for (const id of ids) {
      const c = chunkById.get(id);
      if (!c) continue;
      if (used + c.text.length > maxChars) {
        truncated = true;
        continue;
      }
      used += c.text.length;
      const t = formatTime(c.time);
      L.push(`${c.id}${t ? ` (${t})` : ''}: ${c.text}`);
    }
  }
  const ems = (coverage?.emphasis || []).filter((e) => e.slideIndex != null && e.slideIndex <= progress);
  if (ems.length) {
    L.push('');
    L.push('## [교수님 강조] — 녹음에서 찾은 강조 표현');
    for (const e of ems) L.push(`- ${e.slideIndex}쪽 · ${e.chunkId} · [${e.cues.map(cueLabel).join(', ')}] "${e.sentence}"`);
  }
  if (upcoming.length) {
    L.push('');
    L.push(`## 아직 안 배운 쪽 (해설 금지, 참고만): ${upcoming.map((s) => `${s.index}. ${s.title}`).join(' / ')}`);
  }
  L.push('');
  L.push('JSON만 출력하라.');
  return { text: L.join('\n'), truncated, coveredCount: covered.length };
}
