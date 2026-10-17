import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { stripHtml } from './text.js';

const UA = process.env.FETCH_USER_AGENT || 'YukkuriNewsBot/0.1 (+https://example.com/bot)';
const PAGE_TIMEOUT_MS = 10_000; // 記事ページ・フィードの読み込みは10秒（2.3・8.4）
const MAX_BYTES = 3 * 1024 * 1024;
const SOURCE_MAX_CHARS = 8000;  // Gemini に渡す本文の上限

const parser = new Parser({
  customFields: { item: [['media:thumbnail', 'mediaThumbnail'], ['media:content', 'mediaContent', { keepArray: true }]] },
});

async function fetchText(url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('サイズが大きすぎます');
    return { text: new TextDecoder('utf-8').decode(buf), contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

/** フィードを読み込む。読めなければ例外（8.4 の登録チェックにも使う） */
export async function loadFeed(feedUrl) {
  const { text } = await fetchText(feedUrl, 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5');
  const feed = await parser.parseString(text);
  return feed;
}

function attrUrl(v) {
  if (!v) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = attrUrl(x);
      if (u) return u;
    }
    return null;
  }
  const a = v.$ || v;
  if (a.medium && a.medium !== 'image') return null;
  if (a.type && !String(a.type).startsWith('image')) return null;
  return a.url || null;
}

/** RSSの中の画像（media:thumbnail／media:content／画像のenclosure）（5.2 の1番目） */
export function rssImage(item) {
  return (
    attrUrl(item.mediaThumbnail) ||
    attrUrl(item.mediaContent) ||
    (item.enclosure && String(item.enclosure.type || '').startsWith('image') ? item.enclosure.url : null) ||
    null
  );
}

/**
 * 記事ページを1回だけ読み込み、本文・og:image・twitter:image・og:description を取り出す（2.3・5.2）
 * 読めなかった場合は全部 null を返す（例外にしない）
 */
export async function readArticlePage(url) {
  try {
    const { text, contentType } = await fetchText(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
    if (contentType && !/html/i.test(contentType)) return { body: null, ogImage: null, twitterImage: null, ogDescription: null };
    const $ = cheerio.load(text);
    const meta = (sel) => ($(sel).attr('content') || '').trim() || null;
    const abs = (u) => {
      if (!u) return null;
      try { return new URL(u, url).href; } catch { return null; }
    };
    $('script, style, noscript, nav, header, footer, aside, form, iframe').remove();
    let root = $('article').first();
    if (!root.length) root = $('main').first();
    let body = root.length ? root.text() : $('p').map((_, el) => $(el).text()).get().join('\n');
    body = stripHtml(body).slice(0, SOURCE_MAX_CHARS);
    return {
      body: body || null,
      ogImage: abs(meta('meta[property="og:image"]')),
      twitterImage: abs(meta('meta[name="twitter:image"]') || meta('meta[property="twitter:image"]')),
      ogDescription: meta('meta[property="og:description"]'),
    };
  } catch {
    return { body: null, ogImage: null, twitterImage: null, ogDescription: null };
  }
}
