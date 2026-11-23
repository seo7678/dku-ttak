// Gemini REST call straight from the browser with the user's own key (BYOK). fetch is injectable for tests.
// Optional images: pages of an annotated deck, each preceded by a text label such as "ink-p5" so the model can cite it.

export const DEFAULT_MODEL = 'gemini-3.5-flash';
export const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest'];
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
  if (status === 413) return '보내는 내용이 너무 커요 (413). 필기 페이지 수를 줄이거나 "내 AI 채팅에 붙여넣기"를 이용해 주세요.';
  if (status === 400) return `요청을 처리하지 못했어요 (400). 모델 이름이 맞는지 확인해 주세요. ${m}`.trim();
  if (status === 401 || status === 403) return '이 키로는 사용할 수 없어요 (권한 없음). 키가 비활성화되었거나 API가 꺼져 있을 수 있어요.';
  if (status === 404) return `모델을 찾지 못했어요 (404). 모델 이름을 확인해 주세요 — 예: ${DEFAULT_MODEL}`;
  if (status === 429) return '사용량 한도에 걸렸어요 (429). 잠시 뒤 다시 시도하거나 "내 AI 채팅에 붙여넣기"를 이용해 주세요.';
  if (status >= 500) return `Gemini 서버 오류 (${status}). 잠시 뒤 다시 시도해 주세요.`;
  return `알 수 없는 오류 (${status}). ${m}`.trim();
}

/** Request parts: the prompt, then for each image a label part and an inline JPEG/PNG part. */
export function buildParts(prompt, images = []) {
  const parts = [{ text: prompt }];
  for (const im of images) {
    if (im.label) parts.push({ text: im.label });
    parts.push({ inline_data: { mime_type: im.mimeType || 'image/jpeg', data: im.data } });
  }
  return parts;
}

export async function generateWithGemini({ apiKey, model = DEFAULT_MODEL, prompt, images = [], fetchImpl = globalThis.fetch, signal }) {
  if (!apiKey) throw new GeminiError('Gemini API 키를 먼저 넣어 주세요.', 0);
  const id = String(model || DEFAULT_MODEL).trim().replace(/^models\//, '');
  if (!/^[\w.\-]+$/.test(id)) throw new GeminiError('모델 이름에 쓸 수 없는 글자가 있어요.', 0);
  let res;
  try {
    res = await fetchImpl(`${ENDPOINT}${encodeURIComponent(id)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: buildParts(prompt, images) }],
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

/** Saved model ids from old app versions (gemini-1.x / 2.x are retired for new users) fall back to the default. */
export function currentModel(saved) {
  const v = String(saved || '').trim();
  return !v || /^gemini-(1\.|2\.)/.test(v) ? DEFAULT_MODEL : v;
}

/** True when trying another model could help: model missing (404), server trouble (>=500) or timeout (-1). */
export function shouldFallBack(err) {
  return err instanceof GeminiError && (err.status === 404 || err.status >= 500 || err.status === -1);
}

/** Try `model`, then each fallback. Each try has its own timeout. Resolves { text, model }. */
export async function generateWithFallback({ model = DEFAULT_MODEL, fallbacks = FALLBACK_MODELS, perTryMs = 90000, signal, onTry, ...rest }) {
  const first = String(model || DEFAULT_MODEL).trim().replace(/^models\//, '');
  const ids = [first, ...fallbacks.filter((f) => f !== first)];
  let lastErr;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (signal?.aborted) throw lastErr || new GeminiError('요청을 취소했어요.', 0);
    if (onTry) onTry(id, i, first);
    const ctl = new AbortController();
    let timedOut = false;
    const onOuter = () => ctl.abort();
    signal?.addEventListener('abort', onOuter, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, perTryMs);
    try {
      const text = await generateWithGemini({ ...rest, model: id, signal: ctl.signal });
      return { text, model: id };
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = timedOut ? new GeminiError(`${id} 응답이 너무 늦어요.`, -1) : e;
      if (!shouldFallBack(lastErr)) throw lastErr;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuter);
    }
  }
  throw lastErr;
}
