import { len, TITLE_MAX, SUMMARY_MAX } from './text.js';

// APIキーはサーバーの環境変数だけに置く（ブラウザには出さない）
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 30_000; // 30秒以内に応答がなければ失敗（2.3）
// 無料枠は「1分あたりの回数」が少ないため、初期値は4秒に1回（1分に15回）にする
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS || 4000);
const MAX_ATTEMPTS = 3;          // 混雑（503）・回数超過（429）のときは最大3回まで試す
const MAX_WAIT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function pace() {
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
}

export class GeminiError extends Error {}

// 1日の上限に達したら、この収集の間はもう呼ばない（残りは「要約未完了」にして次の収集で再要約）
let dailyQuotaHitAt = 0;
export function resetQuotaFlag() { dailyQuotaHitAt = 0; }
export const isQuotaExhausted = () => !!dailyQuotaHitAt;

function retryDelayMs(body, attempt) {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  const ms = m ? Math.ceil(Number(m[1]) * 1000) + 500 : 15_000 * attempt;
  return Math.min(ms, MAX_WAIT_MS);
}

async function generate(prompt) {
  if (!API_KEY) throw new GeminiError('GEMINI_API_KEY が設定されていません');
  if (dailyQuotaHitAt) throw new GeminiError('Gemini の1日の利用上限に達しているため、次の収集で再要約します');
  for (let attempt = 1; ; attempt++) {
    try {
      return await callOnce(prompt);
    } catch (e) {
      const status = e.status;
      if (status === 429 && /PerDay|per day/i.test(e.body || '')) {
        dailyQuotaHitAt = Date.now();
        throw new GeminiError(`Gemini の1日の利用上限に達しました（429）: ${e.message}`);
      }
      if ((status === 429 || status === 503 || status === 500) && attempt < MAX_ATTEMPTS) {
        const wait = retryDelayMs(e.body || '', attempt);
        console.log(`[gemini] ${status} のため ${Math.round(wait / 1000)} 秒待って再試行（${attempt + 1}/${MAX_ATTEMPTS}回目）`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

async function callOnce(prompt) {
  await pace();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      let msg = body;
      try { msg = JSON.parse(body).error?.message || body; } catch { /* JSONでない */ }
      const err = new GeminiError(`Gemini API エラー ${res.status}: ${String(msg).replace(/\s+/g, ' ').slice(0, 600)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    const data = JSON.parse(body);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new GeminiError('Gemini の応答が空でした');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new GeminiError('Gemini が30秒以内に応答しませんでした');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new GeminiError('Gemini の応答がJSONではありませんでした');
  return JSON.parse(m[0]);
}

/**
 * 見出し（必要な場合）と概要を1回の呼び出しで要約する。
 * 戻り値: { title: string|null, summary: string|null, titleError, summaryError }
 * 各項目は「空でない」「決められた文字数以内」を満たさなければ失敗扱い（2.3 失敗の定義）。
 */
export async function summarize({ title, needTitle, sourceText, needSummary }) {
  const tasks = [];
  if (needTitle) tasks.push(`- "title": 次の記事タイトルを、意味を変えずに${TITLE_MAX}文字以内の日本語の見出しにする。`);
  if (needSummary) tasks.push(`- "summary": 次の記事本文を、${SUMMARY_MAX}文字以内の日本語で要約する。事実だけを書き、本文にないことは書かない。`);
  const prompt = [
    'あなたはニュースアプリの編集者です。次の作業をして、JSONだけを返してください。',
    ...tasks,
    '',
    `記事タイトル: ${title}`,
    needSummary ? `記事本文:\n${sourceText}` : '',
  ].join('\n');

  const out = { title: null, summary: null, titleError: null, summaryError: null };
  let obj;
  try {
    obj = parseJson(await generate(prompt));
  } catch (e) {
    if (needTitle) out.titleError = e.message;
    if (needSummary) out.summaryError = e.message;
    return out;
  }
  if (needTitle) {
    const t = String(obj.title || '').trim();
    if (!t) out.titleError = '見出しが空でした';
    else if (len(t) > TITLE_MAX) out.titleError = `見出しが${TITLE_MAX}文字を超えました`;
    else out.title = t;
  }
  if (needSummary) {
    const s = String(obj.summary || '').trim();
    if (!s) out.summaryError = '要約が空でした';
    else if (len(s) > SUMMARY_MAX) out.summaryError = `要約が${SUMMARY_MAX}文字を超えました`;
    else out.summary = s;
  }
  return out;
}
