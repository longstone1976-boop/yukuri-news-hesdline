// 文字数は見た目の1文字（コードポイント）で数える
export const len = (s) => [...(s || '')].length;
export const cut = (s, n) => [...(s || '')].slice(0, n).join('');

export const TITLE_MAX = 25;
export const SUMMARY_MAX = 250;

// 見出しの要約に失敗したとき：先頭24文字＋「…」（2.3）
export const truncateTitle = (t) => (len(t) > TITLE_MAX ? cut(t, TITLE_MAX - 1) + '…' : t);
// 説明文が250文字を超えるとき：先頭249文字＋「…」（2.3）
export const truncateSummary = (t) => (len(t) > SUMMARY_MAX ? cut(t, SUMMARY_MAX - 1) + '…' : t);

export const NO_SUMMARY = '概要を取得できませんでした。記事参照ボタンから元の記事をご覧ください。';

// HTMLタグを取り除き、空白を詰める
export function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 日本時間で「YYYY/MM/DD HH:mm」（2.1）
export function fmtJst(d) {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}
