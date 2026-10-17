import express from 'express';
import cron from 'node-cron';
import crypto from 'node:crypto';
import { pool, migrate } from './db.js';
import { runCollection } from './collect.js';
import { loadFeed } from './fetchers.js';
import { escapeHtml as h, fmtJst, len } from './text.js';

const PORT = Number(process.env.PORT || 3000);
const PER_PAGE = 20;
const MAX_SITES = 20;
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD;

if (!APP_PASSWORD || APP_PASSWORD.length < 12) {
  throw new Error('環境変数 APP_PASSWORD（12文字以上）を設定してください。公開サーバーをパスワードなしで動かさないためです。');
}

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));

// --- ログイン画面（管理者1人。ユーザー名・パスワードは環境変数） ---
// ログイン状態は署名付きCookieで保持する。最後に操作してから30日で切れる（仕様書 9.3）
const SESSION_DAYS = 30;
const COOKIE = 'yn_session';
// パスワードを変えると、それまでのログイン状態はすべて無効になる
const SECRET = crypto.createHash('sha256').update(`${process.env.SESSION_SECRET || ''}:${APP_USER}:${APP_PASSWORD}`).digest();

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() {
  const v = `${Buffer.from(APP_USER).toString('base64url')}.${Date.now() + SESSION_DAYS * 86400_000}`;
  return `${v}.${sign(v)}`;
}
function validToken(t) {
  const parts = String(t || '').split('.');
  if (parts.length !== 3) return false;
  const v = `${parts[0]}.${parts[1]}`;
  return safeEq(parts[2], sign(v)) && Number(parts[1]) > Date.now();
}
function readCookie(req, name) {
  for (const c of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = c.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setSession(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
const clearSession = (res) => res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : '/');

// ログイン失敗：同じユーザー名で5回続けて失敗したら15分間止める（仕様書 9.3）
const fails = new Map();
const LOCK_MS = 15 * 60_000;

app.get('/healthz', (_req, res) => res.send('ok'));
app.use((req, res, next) => {
  if (req.path === '/login') return next();
  if (validToken(readCookie(req, COOKIE))) {
    if (req.method === 'GET') setSession(req, res); // 操作するたびに30日を延長
    return next();
  }
  if (req.method === 'GET') return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(401).send('ログインが必要です');
});
// 別サイトからのフォーム送信を受け付けない
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* "null" など */ }
      if (host !== req.headers.host) return res.status(403).send('不正なリクエストです（別のサイトからの送信は受け付けません）');
    }
  }
  next();
});
app.use((_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'");
  res.set('Referrer-Policy', 'same-origin'); // 同じサイトへの送信では送信元が分かるようにする（外部リンクには送らない）
  next();
});

const CSS = `
:root{--ink:#1B1F24;--sub:#4A535C;--line:#DCE1E6;--accent:#0B5E5E;--dark:#0B3B3B;--bg:#F3F5F7;--err:#A1271C}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Zen Kaku Gothic New",system-ui,sans-serif}
a{color:var(--accent)}a:hover{color:#063F3F}
header{background:var(--dark);color:#fff}
.wrap{max-width:1040px;margin:0 auto;padding:12px 20px}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.logo{font-size:24px;font-weight:700;color:#fff;text-decoration:none}
nav{display:flex;gap:6px;flex-wrap:wrap}nav a{color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:10px 14px;text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
nav a.on{background:#fff;color:var(--dark);font-weight:700}
.navbtn{color:#fff;background:transparent;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:0 14px;min-height:44px;font:inherit;cursor:pointer}
.navbtn:hover{background:rgba(255,255,255,.12)}
.login{max-width:420px;margin:40px auto;padding:28px;display:flex;flex-direction:column;gap:16px}
.login label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:700}
main{max-width:1040px;margin:0 auto;padding:24px 20px 120px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px}
.item{padding:16px;display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px}
.thumb{flex:1 1 180px;max-width:220px;aspect-ratio:16/10;border-radius:8px;object-fit:cover;background:#E4E7EA}
.noimg{flex:1 1 180px;max-width:220px;aspect-ratio:16/10;border-radius:8px;border:1px dashed #9AA5AF;background:#E4E7EA;display:flex;align-items:center;justify-content:center;font-size:13px;color:#3D464E}
.body{flex:999 1 320px;min-width:0}
.meta{font-size:12px;color:var(--sub)}
h1{font-size:24px;margin:0 0 16px}h2{font-size:18px;margin:4px 0 6px;line-height:1.4}
p{line-height:1.8}
.btn{min-height:44px;padding:0 20px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;text-decoration:none}
.btn:hover{background:#094C4C;color:#fff}
.btn2{min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #9AA5AF;background:#fff;color:var(--ink);font:inherit;cursor:pointer;display:inline-flex;align-items:center;text-decoration:none}
.danger{border-color:var(--err);background:var(--err);color:#fff}
.pager a,.pager span{position:fixed;bottom:16px;box-shadow:0 4px 12px rgba(0,0,0,.2)}
.pager .prev{left:16px}.pager .next{right:16px}
.pager span{opacity:.45;pointer-events:none}
.inp{min-height:44px;width:100%;padding:8px 12px;border:1px solid #8A949E;border-radius:8px;font:inherit;font-size:16px}
.err{color:var(--err)}.ok{color:#134A37}
.flash{padding:12px 16px;border-radius:8px;background:#E3F1EC;border:1px solid #8CC2AE;margin-bottom:16px}
.flash.bad{background:#FBEAEA;border-color:#E1A3A3}
table{border-collapse:collapse;width:100%}td,th{padding:8px 10px;border-bottom:1px solid #EEF1F4;text-align:left;font-size:14px;vertical-align:top}
.scroll{overflow-x:auto}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#EEF1F4;color:var(--sub)}
`;

function layout(title, active, inner) {
  const nav = active === 'login' ? '' : [['/', 'ニュース', 'field'], ['/admin', '収集元URL・収集', 'admin']]
    .map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`).join('')
    + '<form method="post" action="/logout" style="margin:0"><button class="navbtn" type="submit">ログアウト</button></form>';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}｜ゆっくりNEWS</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header><div class="wrap top"><a class="logo" href="/">ゆっくりNEWS</a><nav>${nav}</nav></div></header>
<main>${inner}</main></body></html>`;
}

async function lastCollection() {
  const { rows } = await pool.query(`SELECT completed_at FROM collections WHERE status='done' ORDER BY completed_at DESC LIMIT 1`);
  return rows[0]?.completed_at || null;
}

const thumbHtml = (url) => url
  ? `<img class="thumb" src="${h(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;noimg&quot;>No Image</div>'">`
  : '<div class="noimg">No Image</div>';

// ログイン画面
function loginPage(next, error) {
  return layout('ログイン', 'login', `<form class="card login" method="post" action="/login">
    <h1 style="margin:0">ログイン</h1>
    <input type="hidden" name="next" value="${h(next)}">
    <label>ユーザー名<input class="inp" name="user" autocomplete="username" required autofocus></label>
    <label>パスワード<input class="inp" type="password" name="password" autocomplete="current-password" required></label>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn" type="submit" style="justify-content:center">ログイン</button>
  </form>`);
}
app.get('/login', (req, res) => {
  if (validToken(readCookie(req, COOKIE))) return res.redirect(303, safeNext(req.query.next));
  res.send(loginPage(safeNext(req.query.next), ''));
});
app.post('/login', (req, res) => {
  const user = String(req.body.user || '').trim();
  const next = safeNext(req.body.next);
  const f = fails.get(user) || { n: 0, until: 0 };
  if (f.until > Date.now()) {
    return res.status(429).send(loginPage(next, 'ログインが一時的に停止されています。15分ほど待ってから、もう一度お試しください。'));
  }
  if (safeEq(user, APP_USER) && safeEq(String(req.body.password || ''), APP_PASSWORD)) {
    fails.delete(user);
    setSession(req, res);
    return res.redirect(303, next);
  }
  const n = f.n + 1;
  fails.set(user, n >= 5 ? { n: 0, until: Date.now() + LOCK_MS } : { n, until: 0 });
  res.status(401).send(loginPage(next, n >= 5
    ? '5回続けて失敗したため、ログインを15分間停止しました。'
    : 'ユーザー名またはパスワードが正しくありません'));
});
app.post('/logout', (_req, res) => {
  clearSession(res);
  res.redirect(303, '/login');
});

// ニュースフィールド画面（4章）
app.get('/', async (req, res, next) => {
  try {
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM feed_items');
    const total = Math.max(1, Math.ceil(n / PER_PAGE));
    const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), total);
    const { rows } = await pool.query(
      `SELECT a.article_id, a.title, a.summary, a.thumbnail_url, a.posted_at, s.name AS site
         FROM feed_items f JOIN articles a USING (article_id) LEFT JOIN sites s ON s.site_id = a.site_id
        ORDER BY f.position LIMIT $1 OFFSET $2`, [PER_PAGE, (page - 1) * PER_PAGE]);
    const { rows: [{ c: siteCount }] } = await pool.query('SELECT count(*)::int AS c FROM sites');
    const last = await lastCollection();
    let inner = `<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px"><h1>ニュース</h1>
      <div class="meta" style="font-size:14px">${page}/${total}ページ　／　最新記事の取得：${last ? fmtJst(last) : 'まだ収集していません'}</div></div>`;
    if (!siteCount) inner += `<div class="card" style="padding:24px">収集元のURLを登録してください。<a href="/admin">収集元URLの登録へ</a></div>`;
    else if (!n) inner += `<div class="card" style="padding:24px">次の収集（6:00／11:55／16:00）から記事が表示されます。すぐに確かめる場合は<a href="/admin">収集元URL・収集</a>の画面から「今すぐ収集」を実行してください。</div>`;
    inner += rows.map((a) => {
      const short = len(a.summary) > 80 ? [...a.summary].slice(0, 79).join('') + '…' : a.summary;
      return `<article class="card item">${thumbHtml(a.thumbnail_url)}<div class="body">
        <div class="meta">${h(a.site || '')}　${fmtJst(a.posted_at)}</div><h2>${h(a.title)}</h2>
        <p style="margin:0 0 8px;font-size:14px">${h(short)}</p><a class="btn2" href="/articles/${a.article_id}?from=${page}">詳細</a></div></article>`;
    }).join('');
    if (n) {
      inner += `<div class="pager">${page > 1 ? `<a class="btn prev" href="/?page=${page - 1}">戻る</a>` : '<span class="btn prev">戻る</span>'}
        ${page < total ? `<a class="btn next" href="/?page=${page + 1}">進む</a>` : '<span class="btn next">進む</span>'}</div>`;
    }
    res.send(layout('ニュース', 'field', inner));
  } catch (e) { next(e); }
});

// 記事詳細画面（5章）
app.get('/articles/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, s.name AS site FROM articles a LEFT JOIN sites s ON s.site_id=a.site_id WHERE a.article_id=$1`, [parseInt(req.params.id, 10) || 0]);
    if (!rows.length) return res.status(404).send(layout('見つかりません', 'field', '<p>記事が見つかりませんでした。</p><a href="/">ニュース一覧に戻る</a>'));
    const a = rows[0];
    const back = parseInt(req.query.from, 10) || 1;
    const status = { done: '', pending: '<span class="badge">要約未完了（次の収集で再要約）</span>', final: '<span class="badge">要約できなかったため、代わりの説明文を表示</span>' }[a.summary_status] || '';
    const inner = `<article class="card" style="padding:28px;max-width:760px;margin:0 auto">
      <div class="meta" style="font-size:13px">${h(a.site || '')}　投稿日時：${fmtJst(a.posted_at)}${a.posted_at_estimated ? '（収集時刻）' : ''}</div>
      <h1 style="margin:8px 0 16px;line-height:1.4">${h(a.title)}</h1>
      ${a.thumbnail_url ? `<img src="${h(a.thumbnail_url)}" alt="" referrerpolicy="no-referrer" style="width:100%;border-radius:10px;max-height:380px;object-fit:cover" onerror="this.outerHTML='<div class=&quot;noimg&quot; style=&quot;max-width:none;width:100%&quot;>No Image</div>'">` : '<div class="noimg" style="max-width:none;width:100%">No Image</div>'}
      <p style="font-size:16px">${h(a.summary)}</p>${status}
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:16px">
        <a class="btn" href="${h(a.url)}" target="_blank" rel="noopener noreferrer">記事参照（新しいタブで開く）</a>
        <a class="btn2" href="/?page=${back}">ニュース一覧に戻る</a></div>
      <details style="margin-top:24px"><summary class="meta">データの確認用（開発中のみ）</summary>
        <table><tr><th>元のタイトル</th><td>${h(a.title_original)}</td></tr>
        <tr><th>概要の出どころ</th><td>${h({ ai: 'Gemini の要約', raw: '本文（250文字以内のため要約なし）', description: 'RSSの説明文', og: 'og:description', none: '取得できず' }[a.summary_source] || a.summary_source)}</td></tr>
        <tr><th>要約の状態</th><td>${h(a.summary_status)}（再要約 ${a.summary_retry} 回）</td></tr>
        <tr><th>URL</th><td style="word-break:break-all">${h(a.url)}</td></tr></table></details>
    </article>`;
    res.send(layout(a.title, 'field', inner));
  } catch (e) { next(e); }
});

// 収集元URLの登録と収集の実行（8.4。ログイン機能は範囲外のため全体で共通）
let running = null;
app.get('/admin', async (req, res, next) => {
  try {
    const { rows: sites } = await pool.query('SELECT * FROM sites ORDER BY created_at DESC');
    const { rows: cols } = await pool.query('SELECT * FROM collections ORDER BY collection_id DESC LIMIT 10');
    const { rows: [st] } = await pool.query(`SELECT count(*)::int AS total,
       count(*) FILTER (WHERE summary_source='ai')::int AS ai,
       count(*) FILTER (WHERE summary_status='pending')::int AS pending,
       count(*) FILTER (WHERE summary_status='final')::int AS final FROM articles`);
    const msg = req.query.msg ? `<div class="flash ${req.query.bad ? 'bad' : ''}" role="status">${h(req.query.msg)}</div>` : '';
    const inner = `${msg}<h1>収集元URL・収集</h1>
    <section class="card" style="padding:20px;margin-bottom:16px">
      <h2>収集元URL（${sites.length}件／上限${MAX_SITES}件）</h2>
      <form method="post" action="/admin/sites" style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:12px 0">
        <label style="flex:999 1 280px;display:flex;flex-direction:column;gap:6px;font-size:14px">ニュースフィードまたはRSSのURL<input class="inp" type="url" name="url" required placeholder="https://"></label>
        <button class="btn" type="submit">追加</button></form>
      <p class="meta" style="margin:0 0 12px">追加するときにフィードを読み込めるか確認し、サイト名はフィードから取得します。</p>
      <form method="post" action="/admin/sites/delete" onsubmit="return confirm('選んだURLを削除します。よろしいですか？')">
        <div class="scroll"><table><thead><tr><th></th><th>サイト名</th><th>URL</th><th>登録日時</th></tr></thead><tbody>
        ${sites.map((s) => `<tr><td><input type="checkbox" name="ids" value="${s.site_id}" aria-label="${h(s.name)}を選択" style="width:20px;height:20px"></td><td>${h(s.name)}</td><td style="word-break:break-all">${h(s.feed_url)}</td><td>${fmtJst(s.created_at)}</td></tr>`).join('') || '<tr><td colspan="4">登録されているURLはありません</td></tr>'}
        </tbody></table></div>
        ${sites.length ? '<button class="btn2 danger" type="submit" style="margin-top:12px">選んだURLを削除</button>' : ''}
      </form>
    </section>
    <section class="card" style="padding:20px;margin-bottom:16px">
      <h2>収集</h2>
      <p class="meta" style="margin:4px 0 12px">自動収集：毎日 6:00／11:55／16:00（日本時間）${process.env.ENABLE_SCHEDULER === 'false' ? '　※このサーバーでは自動収集を止めています（Cron Job で実行）' : ''}</p>
      <form method="post" action="/admin/collect"><button class="btn" type="submit" ${running ? 'disabled' : ''}>${running ? '収集中…（画面を再読み込みして確認）' : '今すぐ収集'}</button></form>
      <p style="margin:12px 0 4px">記事 ${st.total}件（Gemini要約 ${st.ai}件／要約未完了 ${st.pending}件／代わりの説明文で確定 ${st.final}件）</p>
      <div class="scroll"><table><thead><tr><th>開始</th><th>完了</th><th>状態</th><th>メモ</th></tr></thead><tbody>
      ${cols.map((c) => `<tr><td>${fmtJst(c.started_at)}</td><td>${fmtJst(c.completed_at)}</td><td>${h({ running: '実行中', done: '完了', failed: '失敗' }[c.status] || c.status)}</td><td style="white-space:pre-line">${h((c.note || '').slice(0, 500))}</td></tr>`).join('') || '<tr><td colspan="4">まだ収集していません</td></tr>'}
      </tbody></table></div>
    </section>`;
    res.send(layout('収集元URL・収集', 'admin', inner));
  } catch (e) { next(e); }
});

const back = (res, msg, bad) => res.redirect(303, `/admin?msg=${encodeURIComponent(msg)}${bad ? '&bad=1' : ''}`);

app.post('/admin/sites', async (req, res, next) => {
  try {
    const url = String(req.body.url || '').trim();
    if (!/^https?:\/\/\S+$/.test(url)) return back(res, 'URLの形式が正しくありません', true);
    const { rows: [{ c }] } = await pool.query('SELECT count(*)::int AS c FROM sites');
    if (c >= MAX_SITES) return back(res, `登録できるURLは${MAX_SITES}件までです。不要なURLを削除してください`, true);
    const { rows: dup } = await pool.query('SELECT 1 FROM sites WHERE feed_url=$1', [url]);
    if (dup.length) return back(res, 'このURLはすでに登録されています', true);
    let feed;
    try { feed = await loadFeed(url); } catch {
      return back(res, 'このURLから記事を取得できませんでした。ニュースフィードまたはRSSのURLを入力してください', true);
    }
    const name = (feed.title || '').trim() || new URL(url).host;
    await pool.query('INSERT INTO sites (name, feed_url) VALUES ($1,$2) ON CONFLICT (feed_url) DO NOTHING', [name, url]);
    back(res, `「${name}」を追加しました。記事は次の収集から表示されます`);
  } catch (e) { next(e); }
});

app.post('/admin/sites/delete', async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).map((x) => parseInt(x, 10)).filter(Boolean);
    if (!ids.length) return back(res, '削除するURLを選んでください', true);
    await pool.query('DELETE FROM sites WHERE site_id = ANY($1::int[])', [ids]);
    // 削除したサイトの記事は、すぐに一覧に表示しない（8.4）
    await pool.query('DELETE FROM feed_items f USING articles a WHERE f.article_id=a.article_id AND a.site_id IS NULL');
    back(res, `${ids.length}件のURLを削除しました`);
  } catch (e) { next(e); }
});

app.post('/admin/collect', (_req, res) => {
  if (!running) {
    running = runCollection().catch((e) => console.error(e)).finally(() => { running = null; });
  }
  back(res, '収集を開始しました。記事数によっては数分かかります。画面を再読み込みして結果を確認してください');
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send(layout('エラー', '', '<p>エラーが発生しました。時間をおいて再度お試しください。</p>'));
});

await migrate();
if (process.env.ENABLE_SCHEDULER !== 'false') {
  for (const expr of ['0 6 * * *', '55 11 * * *', '0 16 * * *']) {
    cron.schedule(expr, () => {
      if (running) return;
      running = runCollection().catch((e) => console.error(e)).finally(() => { running = null; });
    }, { timezone: 'Asia/Tokyo' });
  }
  console.log('自動収集を設定しました（6:00／11:55／16:00 日本時間）');
}
app.listen(PORT, () => console.log(`ゆっくりNEWS 起動：ポート ${PORT}`));
