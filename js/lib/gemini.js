// Gemini REST call straight from the browser with the user's own key (BYOK). fetch is injectable for tests.

export const DEFAULT_MODEL = 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

export function friendlyGeminiError(status, apiMessage = '') {
  const m = String(apiMessage);
  if (status === 400 && /api key/i.test(m)) return '키가 올바르지 않아요. Google AI Studio에서 복사한 키 전체를 붙여넣었는지 확인해 주세요.';
  if (status === 400) return `요청을 처리하지 못했어요 (400). 모델 이름이 맞는지 확인해 주세요. ${m}`.trim();
  if (status === 401 || status === 403) return '이 키로는 사용할 수 없어요 (권한 없음). 키가 비활성화되었거나 API가 꺼져 있을 수 있어요.';
  if (status === 404) return '모델을 찾지 못했어요 (404). 모델 이름을 확인해 주세요 — 예: gemini-2.5-flash';
  if (status === 429) return '사용량 한도에 걸렸어요 (429). 잠시 뒤 다시 시도하거나 "내 AI 채팅에 붙여넣기"를 이용해 주세요.';
  if (status >= 500) return `Gemini 서버 오류 (${status}). 잠시 뒤 다시 시도해 주세요.`;
  return `알 수 없는 오류 (${status}). ${m}`.trim();
}

export async function generateWithGemini({ apiKey, model = DEFAULT_MODEL, prompt, fetchImpl = globalThis.fetch, signal }) {
  if (!apiKey) throw new GeminiError('Gemini API 키를 먼저 넣어 주세요.', 0);
  const id = String(model || DEFAULT_MODEL).trim().replace(/^models\//, '');
  if (!/^[\w.\-]+$/.test(id)) throw new GeminiError('모델 이름에 쓸 수 없는 글자가 있어요.', 0);
  let res;
  try {
    res = await fetchImpl(`${ENDPOINT}${encodeURIComponent(id)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
      }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new GeminiError('요청을 취소했어요.', 0);
    throw new GeminiError('네트워크 연결을 확인해 주세요. (Gemini 서버에 닿지 못했어요)', 0);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new GeminiError(friendlyGeminiError(res.status, body?.error?.message), res.status);
  const cand = body?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const reason = cand?.finishReason || body?.promptFeedback?.blockReason || '빈 응답';
    throw new GeminiError(`Gemini가 내용을 돌려주지 않았어요 (${reason}).`, res.status);
  }
  return text;
}
