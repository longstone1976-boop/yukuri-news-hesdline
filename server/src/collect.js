import { pool } from './db.js';
import { loadFeed, readArticlePage, rssImage } from './fetchers.js';
import { summarize, resetQuotaFlag, isQuotaExhausted } from './gemini.js';
import { len, stripHtml, truncateTitle, truncateSummary, NO_SUMMARY, TITLE_MAX, SUMMARY_MAX } from './text.js';

const PER_SITE = 20;          // サイトごとに最新20件（3.2）
const LIST_MAX = 200;         // 一覧は最大200件（4.2）
const WINDOW_MS = 24 * 3600 * 1000;
const MAX_RETRY = 2;          // 再要約は最大2回（2.3）
const LOCK_KEY = 7262001;     // 収集が重ならないようにするロック

const log = (...a) => console.log('[collect]', ...a);

/** 要約に失敗したときの代わりの概要（2.3）：RSSの説明文 → og:description → 決まった文言 */
function fallbackSummary(rssDesc, ogDesc) {
  if (rssDesc) return { summary: truncateSummary(rssDesc), source: 'description' };
  if (ogDesc) return { summary: truncateSummary(stripHtml(ogDesc)), source: 'og' };
  return { summary: NO_SUMMARY, source: 'none' };
}

/** 新しい記事を1件処理して DB に保存する */
async function processNewArticle(siteId, item, collectedAt) {
  const url = item.url;
  const titleOriginal = stripHtml(item.title || '') || url;
  const rssDesc = stripHtml(item.content || item.contentSnippet || item.summary || '') || null;

  // 記事ページは1記事につき1回だけ読み込む（本文・サムネイル・og:description に使う）
  const page = await readArticlePage(url);
  const thumbnail = rssImage(item) || page.ogImage || page.twitterImage || null;

  // 要約の元にする文章：本文 → 取れなければRSSの説明文（2.3）
  const sourceText = page.body || rssDesc || '';
  const needTitle = len(titleOriginal) > TITLE_MAX;
  const needSummary = len(sourceText) > SUMMARY_MAX; // 250文字以内なら要約せずそのまま使う

  let title = titleOriginal;
  let summary, summaryStatus, summarySource, keepSource = null;

  if (needTitle || needSummary) {
    const r = await summarize({ title: titleOriginal, needTitle, sourceText, needSummary });
    if (needTitle) title = r.title || truncateTitle(titleOriginal);
    if (r.titleError) log('見出しの要約に失敗:', url, r.titleError);
    if (needSummary) {
      if (r.summary) {
        summary = r.summary; summaryStatus = 'done'; summarySource = 'ai';
      } else {
        log('概要の要約に失敗:', url, r.summaryError);
        const fb = fallbackSummary(rssDesc, page.ogDescription);
        summary = fb.summary; summarySource = fb.source; summaryStatus = 'pending'; keepSource = sourceText;
      }
    }
  }
  if (!needSummary) {
    if (sourceText) { summary = sourceText; summarySource = 'raw'; }
    else { const fb = fallbackSummary(rssDesc, page.ogDescription); summary = fb.summary; summarySource = fb.source; }
    summaryStatus = 'done';
  }

  const postedAt = item.postedAt || collectedAt;
  const { rows } = await pool.query(
    `INSERT INTO articles (url, site_id, title, title_original, summary, summary_status, summary_source, source_text,
       rss_description, og_description, thumbnail_url, posted_at, posted_at_estimated, collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (url) DO NOTHING
     RETURNING article_id`,
    [url, siteId, title, titleOriginal, summary, summaryStatus, summarySource, keepSource,
      rssDesc, page.ogDescription, thumbnail, postedAt, !item.postedAt, collectedAt],
  );
  return rows[0]?.article_id ?? null;
}

/** 要約未完了の記事を再要約する（収集の対象期間から外れていても行う。最大2回） */
async function retryPending(skipIds) {
  const { rows } = await pool.query(
    `SELECT article_id, url, title_original, source_text, summary_retry FROM articles
      WHERE summary_status = 'pending' AND NOT (article_id = ANY($1::int[]))`,
    [skipIds],
  );
  for (const a of rows) {
    if (isQuotaExhausted()) break; // 1日の上限に達したら、回数を数えずに次の収集へ回す
    const r = await summarize({ title: a.title_original, needTitle: false, sourceText: a.source_text || '', needSummary: true });
    if (!r.summary && isQuotaExhausted()) break;
    const retry = a.summary_retry + 1;
    if (r.summary) {
      await pool.query(
        `UPDATE articles SET summary=$2, summary_status='done', summary_source='ai', summary_retry=$3, source_text=NULL WHERE article_id=$1`,
        [a.article_id, r.summary, retry],
      );
      log('再要約に成功:', a.url);
    } else if (retry >= MAX_RETRY) {
      await pool.query(`UPDATE articles SET summary_status='final', summary_retry=$2, source_text=NULL WHERE article_id=$1`, [a.article_id, retry]);
      log('再要約を2回失敗したため、代わりの概要で確定:', a.url);
    } else {
      await pool.query(`UPDATE articles SET summary_retry=$2 WHERE article_id=$1`, [a.article_id, retry]);
    }
  }
}

/** サイトごとに均等に選んで最大200件にする（3.2） */
export function selectRoundRobin(bySite, max = LIST_MAX) {
  const lists = bySite.map((l) => [...l].sort((a, b) => b.posted - a.posted));
  const picked = [];
  for (let round = 0; picked.length < max; round++) {
    const thisRound = lists.map((l) => l[round]).filter(Boolean);
    if (!thisRound.length) break;
    thisRound.sort((a, b) => b.posted - a.posted); // 途中で200件に達したら新しいものから
    for (const x of thisRound) {
      if (picked.length >= max) break;
      picked.push(x);
    }
  }
  return picked.sort((a, b) => b.posted - a.posted);
}

/** 1回分の収集（6:00／11:55／16:00 に実行） */
export async function runCollection() {
  const client = await pool.connect();
  const { rows: lk } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (!lk[0].ok) { client.release(); log('別の収集が実行中のため、スキップしました'); return { skipped: true }; }

  const { rows: c } = await pool.query(`INSERT INTO collections DEFAULT VALUES RETURNING collection_id, started_at`);
  const collectionId = c[0].collection_id;
  resetQuotaFlag();
  const collectedAt = c[0].started_at;
  const notes = [];
  try {
    const { rows: sites } = await pool.query('SELECT site_id, name, feed_url FROM sites ORDER BY site_id');
    const since = Date.now() - WINDOW_MS;
    const seen = new Set();
    const bySite = [];
    const touched = [];

    for (const site of sites) {
      let feed;
      try {
        feed = await loadFeed(site.feed_url);
      } catch (e) {
        notes.push(`${site.name}: フィードを読み込めませんでした（${e.message}）`);
        continue;
      }
      const items = (feed.items || [])
        .map((it) => {
          const d = it.isoDate || it.pubDate;
          const t = d ? new Date(d).getTime() : NaN;
          return { ...it, url: (it.link || '').trim(), postedAt: Number.isFinite(t) ? new Date(t) : null };
        })
        .filter((it) => /^https?:\/\//.test(it.url))
        .filter((it) => !it.postedAt || it.postedAt.getTime() >= since) // 直近24時間（取れない日時は対象に含める）
        .sort((a, b) => (b.postedAt?.getTime() ?? Infinity) - (a.postedAt?.getTime() ?? Infinity))
        .slice(0, PER_SITE);

      const list = [];
      for (const it of items) {
        if (seen.has(it.url)) continue; // 同じURLは1件として扱う
        seen.add(it.url);
        const { rows: ex } = await pool.query('SELECT article_id, posted_at FROM articles WHERE url=$1', [it.url]);
        let id, posted;
        if (ex.length) {
          id = ex[0].article_id; posted = new Date(ex[0].posted_at).getTime(); // 収集済み：取り直さない
        } else {
          id = await processNewArticle(site.site_id, it, collectedAt);
          if (!id) continue;
          posted = (it.postedAt || collectedAt).getTime();
          touched.push(id);
        }
        list.push({ id, posted });
      }
      bySite.push(list);
    }

    await retryPending(touched);

    const picked = selectRoundRobin(bySite);
    // 一覧の作り直しは1つのトランザクションで行う（途中で一覧が空にならないように）
    await client.query('BEGIN');
    await client.query('DELETE FROM feed_items');
    for (let i = 0; i < picked.length; i++) {
      await client.query('INSERT INTO feed_items (collection_id, position, article_id) VALUES ($1,$2,$3)', [collectionId, i + 1, picked[i].id]);
    }
    await client.query('UPDATE articles SET last_listed_at = now() WHERE article_id = ANY($1::int[])', [picked.map((p) => p.id)]);
    await client.query('COMMIT');

    // 一覧から外れて24時間が過ぎた記事を削除（3.2。閲覧履歴の機能は今回の範囲外）
    const { rowCount: removed } = await pool.query(
      `DELETE FROM articles WHERE summary_status <> 'pending'
         AND COALESCE(last_listed_at, collected_at) < now() - interval '24 hours'
         AND article_id NOT IN (SELECT article_id FROM feed_items)`,
    );

    await pool.query(`UPDATE collections SET completed_at=now(), status='done', note=$2 WHERE collection_id=$1`, [collectionId, notes.join('\n') || null]);
    log(`完了：一覧${picked.length}件、新規${touched.length}件、削除${removed}件`);
    return { collectionId, listed: picked.length, added: touched.length, removed, notes };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(`UPDATE collections SET status='failed', note=$2 WHERE collection_id=$1`, [collectionId, String(e.stack || e)]);
    log('失敗：', e);
    throw e;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
