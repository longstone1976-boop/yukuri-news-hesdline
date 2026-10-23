import { pool } from './db.js';
import { loadFeed, readArticlePage, rssImage } from './fetchers.js';
import { summarizeBatch, resetQuotaFlag, isQuotaError } from './gemini.js';
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

/** 新しい記事の準備：記事ページを1回だけ読み込み、本文・サムネイル・og:description を取る（Gemini はまだ呼ばない） */
async function prepareNewArticle(siteId, item, collectedAt) {
  const url = item.url;
  const titleOriginal = stripHtml(item.title || '') || url;
  const rssDesc = stripHtml(item.content || item.contentSnippet || item.summary || '') || null;
  const page = await readArticlePage(url);
  const sourceText = page.body || rssDesc || ''; // 要約の元：本文 → 取れなければRSSの説明文（2.3）
  return {
    siteId, item, url, titleOriginal, rssDesc, page, sourceText, collectedAt,
    thumbnail: rssImage(item) || page.ogImage || page.twitterImage || null,
    needTitle: len(titleOriginal) > TITLE_MAX,
    needSummary: len(sourceText) > SUMMARY_MAX, // 250文字以内なら要約せずそのまま使う
  };
}

/** 要約の結果（r）を当てはめて DB に保存する */
async function saveNewArticle(p, r) {
  let title = p.titleOriginal, titleStatus = 'done';
  let summary, summaryStatus = 'done', summarySource, keepSource = null;
  if (p.needTitle) {
    if (r?.title) title = r.title;
    else { title = truncateTitle(p.titleOriginal); titleStatus = 'pending'; log('見出しの要約に失敗:', p.url, r?.titleError); }
  }
  if (p.needSummary) {
    if (r?.summary) { summary = r.summary; summarySource = 'ai'; }
    else {
      log('概要の要約に失敗:', p.url, r?.summaryError);
      const fb = fallbackSummary(p.rssDesc, p.page.ogDescription);
      summary = fb.summary; summarySource = fb.source; summaryStatus = 'pending'; keepSource = p.sourceText;
    }
  } else if (p.sourceText) { summary = p.sourceText; summarySource = 'raw'; }
  else { const fb = fallbackSummary(p.rssDesc, p.page.ogDescription); summary = fb.summary; summarySource = fb.source; }

  const postedAt = p.item.postedAt || p.collectedAt;
  const { rows } = await pool.query(
    `INSERT INTO articles (url, site_id, title, title_original, title_status, summary, summary_status, summary_source, source_text,
       rss_description, og_description, thumbnail_url, posted_at, posted_at_estimated, collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (url) DO NOTHING
     RETURNING article_id`,
    [p.url, p.siteId, title, p.titleOriginal, titleStatus, summary, summaryStatus, summarySource, keepSource,
      p.rssDesc, p.page.ogDescription, p.thumbnail, postedAt, !p.item.postedAt, p.collectedAt],
  );
  return rows[0]?.article_id ?? null;
}

/** 要約未完了の見出し・概要を、まとめて再要約する（どちらも最大2回。収集の対象期間から外れていても行う） */
async function retryPending(skipIds, siteIds = null) {
  const { rows } = await pool.query(
    `SELECT article_id, url, title_original, source_text, summary_status, summary_retry, title_status, title_retry FROM articles
      WHERE (summary_status = 'pending' OR title_status = 'pending') AND NOT (article_id = ANY($1::int[]))
        AND ($2::int[] IS NULL OR site_id = ANY($2::int[]))
      ORDER BY article_id`,
    [skipIds, siteIds],
  );
  if (!rows.length) return;
  const jobs = rows.map((a) => ({
    title: a.title_original, needTitle: a.title_status === 'pending',
    sourceText: a.source_text || '', needSummary: a.summary_status === 'pending',
  }));
  const results = await summarizeBatch(jobs);
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i], j = jobs[i], r = results[i];
    if (j.needTitle) {
      const retry = a.title_retry + 1;
      if (r.title) {
        await pool.query(`UPDATE articles SET title=$2, title_status='done', title_retry=$3 WHERE article_id=$1`, [a.article_id, r.title, retry]);
        log('見出しの再要約に成功:', a.url);
      } else if (isQuotaError(r.titleError)) {
        // 1日の上限で呼べなかった分は、回数に数えず次の収集へ回す
      } else if (retry >= MAX_RETRY) {
        await pool.query(`UPDATE articles SET title_status='final', title_retry=$2 WHERE article_id=$1`, [a.article_id, retry]);
        log('見出しの再要約を2回失敗したため、先頭24文字＋…で確定:', a.url);
      } else {
        await pool.query(`UPDATE articles SET title_retry=$2 WHERE article_id=$1`, [a.article_id, retry]);
      }
    }
    if (j.needSummary) {
      const retry = a.summary_retry + 1;
      if (r.summary) {
        await pool.query(
          `UPDATE articles SET summary=$2, summary_status='done', summary_source='ai', summary_retry=$3, source_text=NULL WHERE article_id=$1`,
          [a.article_id, r.summary, retry],
        );
        log('概要の再要約に成功:', a.url);
      } else if (isQuotaError(r.summaryError)) {
        // 同上
      } else if (retry >= MAX_RETRY) {
        await pool.query(`UPDATE articles SET summary_status='final', summary_retry=$2, source_text=NULL WHERE article_id=$1`, [a.article_id, retry]);
        log('概要の再要約を2回失敗したため、代わりの概要で確定:', a.url);
      } else {
        await pool.query(`UPDATE articles SET summary_retry=$2 WHERE article_id=$1`, [a.article_id, retry]);
      }
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

/**
 * 1回分の収集。userId を渡すと、そのユーザーが登録したサイトだけを読み込み、そのユーザーの一覧だけを作り直す
 * （MYページの「今すぐ読み込む」用）
 */
export async function runCollection({ userId = null } = {}) {
  const client = await pool.connect();
  const { rows: lk } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (!lk[0].ok) { client.release(); log('別の収集が実行中のため、スキップしました'); return { skipped: true }; }

  const { rows: c } = await pool.query(`INSERT INTO collections (user_id) VALUES ($1) RETURNING collection_id, started_at`, [userId]);
  const collectionId = c[0].collection_id;
  resetQuotaFlag();
  const collectedAt = c[0].started_at;
  const notes = [];
  try {
    // 1人以上のユーザーが登録しているサイトだけを、1回ずつ収集する（8.4）
    const { rows: sites } = await pool.query(
      `SELECT s.site_id, s.name, s.feed_url FROM sites s
        WHERE EXISTS (SELECT 1 FROM user_sites us JOIN users u USING (user_id)
                       WHERE us.site_id = s.site_id AND u.status = 'active' AND ($1::text IS NULL OR us.user_id = $1))
        ORDER BY s.site_id`, [userId]);
    const since = Date.now() - WINDOW_MS;
    const seen = new Set();
    const bySite = new Map(); // site_id → その回に集めた記事
    const touched = [];
    const newEntries = [];

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
        if (ex.length) {
          list.push({ id: ex[0].article_id, posted: new Date(ex[0].posted_at).getTime() }); // 収集済み：取り直さない
        } else {
          const prep = await prepareNewArticle(site.site_id, it, collectedAt);
          const entry = { id: null, posted: (it.postedAt || collectedAt).getTime(), prep };
          list.push(entry);
          newEntries.push(entry);
        }
      }
      bySite.set(site.site_id, list);
    }

    // 新しい記事の見出し・概要を、まとめて要約してから保存する
    const needAi = newEntries.filter((e) => e.prep.needTitle || e.prep.needSummary);
    const aiResults = await summarizeBatch(needAi.map((e) => e.prep));
    needAi.forEach((e, i) => { e.result = aiResults[i]; });
    for (const e of newEntries) {
      e.id = await saveNewArticle(e.prep, e.result);
      if (e.id) touched.push(e.id);
    }
    for (const [k, list] of bySite) bySite.set(k, list.filter((e) => e.id).map(({ id, posted }) => ({ id, posted })));

    await retryPending(touched, userId ? sites.map((x) => x.site_id) : null);

    // ユーザーごとに、そのユーザーが登録したサイトの記事だけで一覧を作り直す（3.2）
    const { rows: members } = await pool.query(
      `SELECT us.user_id, array_agg(us.site_id) AS site_ids FROM user_sites us JOIN users u USING (user_id)
        WHERE u.status = 'active' AND ($1::text IS NULL OR us.user_id = $1) GROUP BY us.user_id`, [userId]);
    const listedIds = new Set();
    let listedTotal = 0;
    // 一覧の作り直しは1つのトランザクションで行う（途中で一覧が空にならないように）
    await client.query('BEGIN');
    if (userId) await client.query('DELETE FROM user_feed_items WHERE user_id=$1', [userId]);
    else await client.query('DELETE FROM user_feed_items');
    for (const m of members) {
      const picked = selectRoundRobin(m.site_ids.map((id) => bySite.get(id) || []));
      for (let i = 0; i < picked.length; i++) {
        await client.query('INSERT INTO user_feed_items (user_id, position, article_id, collection_id) VALUES ($1,$2,$3,$4)',
          [m.user_id, i + 1, picked[i].id, collectionId]);
        listedIds.add(picked[i].id);
      }
      listedTotal += picked.length;
    }
    await client.query('UPDATE articles SET last_listed_at = now() WHERE article_id = ANY($1::int[])', [[...listedIds]]);
    await client.query('COMMIT');

    // 一覧から外れて24時間が過ぎた記事を削除（3.2。閲覧履歴の機能は今回の範囲外）
    const { rowCount: removed } = userId ? { rowCount: 0 } : await pool.query(
      `DELETE FROM articles WHERE summary_status <> 'pending' AND title_status <> 'pending'
         AND COALESCE(last_listed_at, collected_at) < now() - interval '24 hours'
         AND article_id NOT IN (SELECT article_id FROM user_feed_items)`,
    );
    // 期限切れの仮登録・確認URL、古いモックメール、古いログイン失敗の記録を消す
    if (!userId) {
      await pool.query(`DELETE FROM pending_registrations WHERE expires_at < now()`);
      await pool.query(`DELETE FROM email_changes WHERE expires_at < now()`);
      await pool.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`);
      await pool.query(`DELETE FROM mock_mails WHERE created_at < now() - interval '7 days'`);
      await pool.query(`DELETE FROM login_attempts WHERE COALESCE(locked_until, now()) < now() - interval '1 day'`);
    }

    await pool.query(`UPDATE collections SET completed_at=now(), status='done', note=$2 WHERE collection_id=$1`, [collectionId, notes.join('\n') || null]);
    log(`完了${userId ? '（ユーザーの今すぐ読み込み）' : ''}：ユーザー${members.length}人・一覧合計${listedTotal}件、新規${touched.length}件、削除${removed}件`);
    return { collectionId, users: members.length, listed: listedTotal, added: touched.length, removed, notes };
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
