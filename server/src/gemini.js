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

// 無料枠は「1日の呼び出し回数」が少ないため、複数の記事を1回の呼び出しでまとめて要約する
const BATCH_SIZE = Math.max(1, Number(process.env.GEMINI_BATCH_SIZE || 10));
const BATCH_SOURCE_MAX = 3000; // まとめて送るときの1記事あたりの本文の上限（文字）
export const isQuotaError = (msg) => /1日の利用上限/.test(String(msg || ''));

function validate(job, r) {
  const out = { title: null, summary: null, titleError: null, summaryError: null };
  if (job.needTitle) {
    const t = String(r?.title || '').trim();
    if (!t) out.titleError = '見出しが空でした';
    else if (len(t) > TITLE_MAX) out.titleError = `見出しが${TITLE_MAX}文字を超えました`;
    else out.title = t;
  }
  if (job.needSummary) {
    const s = String(r?.summary || '').trim();
    if (!s) out.summaryError = '要約が空でした';
    else if (len(s) > SUMMARY_MAX) out.summaryError = `要約が${SUMMARY_MAX}文字を超えました`;
    else out.summary = s;
  }
  return out;
}

/**
 * 複数の記事の見出し（必要な場合）と概要（必要な場合）を、最大 BATCH_SIZE 件ずつまとめて要約する。
 * jobs: [{ title, needTitle, sourceText, needSummary }]
 * 戻り値: jobs と同じ順の [{ title, summary, titleError, summaryError }]
 * 各項目は「空でない」「決められた文字数以内」を満たさなければ失敗扱い（2.3 失敗の定義）。
 */
export async function summarizeBatch(jobs) {
  const results = new Array(jobs.length);
  for (let start = 0; start < jobs.length; start += BATCH_SIZE) {
    const chunk = jobs.slice(start, start + BATCH_SIZE);
    const prompt = [
      'あなたはニュースアプリの編集者です。次の記事それぞれについて作業し、JSONだけを返してください。',
      '返す形：{"items":[{"id":記事番号,"title":"見出し","summary":"要約"}]}',
      `- "title"：「見出し：必要」の記事だけ書く。元のタイトルの意味を変えずに、${TITLE_MAX - 3}文字以内の日本語の見出しにする（記号も1文字と数える。絶対に${TITLE_MAX}文字を超えない）。`,
      `- "summary"：「要約：必要」の記事だけ書く。本文を${SUMMARY_MAX}文字以内の日本語で要約する。事実だけを書き、本文にないことは書かない。`,
      '- 記事ごとに独立して作業し、他の記事の内容を混ぜない。',
      '',
      ...chunk.map((j, k) => [
        `### 記事${k + 1}`,
        `見出し：${j.needTitle ? '必要' : '不要'}　要約：${j.needSummary ? '必要' : '不要'}`,
        `タイトル：${j.title}`,
        j.needSummary ? `本文：\n${String(j.sourceText || '').slice(0, BATCH_SOURCE_MAX)}` : '',
        '',
      ].join('\n')),
    ].join('\n');
    let items = null, err = null;
    try {
      const obj = parseJson(await generate(prompt));
      items = Array.isArray(obj.items) ? obj.items : [];
    } catch (e) {
      err = e.message;
    }
    chunk.forEach((j, k) => {
      if (err) {
        results[start + k] = { title: null, summary: null, titleError: j.needTitle ? err : null, summaryError: j.needSummary ? err : null };
      } else {
        results[start + k] = validate(j, items.find((x) => Number(x?.id) === k + 1));
      }
    });
  }
  return results;
}

/** 1件だけ要約する（summarizeBatch の1件版） */
export async function summarize(job) {
  return (await summarizeBatch([job]))[0];
}
