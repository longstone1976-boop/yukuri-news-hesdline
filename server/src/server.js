import express from 'express';
import cron from 'node-cron';
import { pool, migrate } from './db.js';
import { runCollection } from './collect.js';
import { loadFeed } from './fetchers.js';
import { escapeHtml as h, fmtJst, len } from './text.js';
import { layout, flash, mailBox } from './views.js';
import {
  hashPassword, verifyPassword, passwordOk, PASSWORD_RULE, normEmail, emailOk, newToken, newUserId,
  safeEq, signer, readCookie, setCookie, clearCookie, safeNext,
} from './auth.js';

const PORT = Number(process.env.PORT || 3000);
const PER_PAGE = 20;
const MAX_SITES = 20;           // 1ユーザーにつき最大20件（8.4）
const SESSION_DAYS = 30;        // 最後に操作してから30日（9.3）
const LOCK_MS = 15 * 60_000;    // 5回失敗で15分停止（9.3）
const TOKEN_HOURS = 24;         // 確認用URL・リセット用URLの有効期限（8.3・9.2・9.4）
const ID_RETRY_MAX = 5;         // ユーザーIDの作り直しは最大5回（8.1）
const ADMIN_USER = (process.env.APP_USER || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.APP_PASSWORD;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  throw new Error('環境変数 APP_PASSWORD（管理者のパスワード、12文字以上）を設定してください。');
}
const SECRET = process.env.SESSION_SECRET || `derived:${ADMIN_PASSWORD}`;
const userSessions = signer(`user:${SECRET}`);
const adminSessions = signer(`admin:${SECRET}:${ADMIN_USER}:${ADMIN_PASSWORD}`); // 管理者パスワードを変えると管理者は全端末でログアウト
const USER_COOKIE = 'yn_user';
const ADMIN_COOKIE = 'yn_admin';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.get('/healthz', (_req, res) => res.send('ok'));

// 別サイトからのフォーム送信を受け付けない
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers.origin) {
    let host = null;
    try { host = new URL(req.headers.origin).host; } catch { /* "null" など */ }
    if (host !== req.headers.host) return res.status(403).send('不正なリクエストです（別のサイトからの送信は受け付けません）');
  }
  next();
});
app.use((_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'");
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// ===== ログイン状態の読み込み =====
app.use(async (req, res, next) => {
  const parts = userSessions.read(readCookie(req, USER_COOKIE));
  if (parts && parts.length === 2) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE user_id=$1 AND status='active'`, [parts[0]]);
    if (rows[0] && String(rows[0].session_version) === parts[1]) {
      req.user = rows[0];
      if (req.method === 'GET') loginUser(req, res, rows[0]); // 操作するたびに30日を延長
    }
  }
  const ap = adminSessions.read(readCookie(req, ADMIN_COOKIE));
  req.admin = !!(ap && ap[0] === 'admin');
  next();
});
function loginUser(req, res, u) {
  setCookie(req, res, USER_COOKIE, userSessions.make([u.user_id, u.session_version], SESSION_DAYS), SESSION_DAYS * 86400);
}
function needUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(401).send('ログインが必要です');
}
function needAdmin(req, res, next) {
  if (req.admin) return next();
  if (req.method === 'GET') return res.redirect(303, '/admin/login');
  res.status(401).send('管理者ログインが必要です');
}
const go = (res, path, msg, bad) => res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}${bad ? '&bad=1' : ''}`);
const msgOf = (req) => flash(req.query.msg, req.query.bad);

// ===== モックのメール（実際には送らず、DBに残す） =====
async function sendMail({ to, subject, body, link, linkLabel }) {
  const key = newToken();
  const { rows } = await pool.query(
    `INSERT INTO mock_mails (to_email, subject, body, link_url, link_label, view_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING mail_id`,
    [to, subject, body, link || null, linkLabel || null, key]);
  console.log(`[mail:mock] 宛先 ${to}「${subject}」`);
  return { m: rows[0].mail_id, k: key };
}
const SENT = {
  signup: ['確認用のメールを送信しました', '入力されたメールアドレス宛てに確認用のメールを送信しました。メール内のURLを24時間以内に開いて、登録を完了してください。', '/login', 'ログイン画面に戻る'],
  reset: ['メールを送信しました', '入力されたメールアドレス宛てにメールを送信しました。メール内のURLを24時間以内に開いてください。', '/login', 'ログイン画面に戻る'],
  resetSelf: ['メールを送信しました', '登録されているメールアドレス宛てに、パスワード変更用のメールを送信しました。メール内のURLを24時間以内に開いてください。', '/mypage', 'MYページに戻る'],
  email: ['確認用のメールを送信しました', '入力されたメールアドレス宛てに確認用のメールを送信しました。メール内のURLを24時間以内に開くと、変更が完了します。', '/mypage', 'MYページに戻る'],
  emailDone: ['メールアドレスを変更しました', 'メールアドレスの変更が完了しました。変更前のメールアドレスにも、変更があったことをお知らせしています。', '/mypage', 'MYページに戻る'],
};
const sentUrl = (kind, mail) => `/sent?kind=${kind}${mail ? `&m=${mail.m}&k=${mail.k}` : ''}`;
app.get('/sent', async (req, res) => {
  const s = SENT[req.query.kind] || SENT.reset;
  let mail = null;
  if (req.query.m && req.query.k) {
    const { rows } = await pool.query('SELECT * FROM mock_mails WHERE mail_id=$1 AND view_key=$2', [parseInt(req.query.m, 10) || 0, String(req.query.k)]);
    mail = rows[0] || null;
  }
  res.send(layout(s[0], { nav: req.user ? 'user' : 'none' }, `<div class="mid">
    <section class="card" style="padding:28px;display:flex;flex-direction:column;gap:12px">
      <h1 style="margin:0">${h(s[0])}</h1><p style="margin:0">${h(s[1])}</p><a href="${s[2]}">${h(s[3])}</a></section>
    ${mail ? mailBox(mail) : `<section class="mail"><div class="meta">モックの説明：パスワードリセットのメールなど、他人に見られると困るメールはこの画面には表示しません。管理者の「モック受信箱」で確認できます。</div></section>`}
  </div>`));
});

// ===== ログイン（9.3） =====
function loginPage(next, email, error, msg) {
  return layout('ログイン', { nav: 'none' }, `${msg || ''}<form class="card narrow" method="post" action="/login">
    <h1 style="margin:0">ログイン</h1>
    <input type="hidden" name="next" value="${h(next)}">
    <label class="f">メールアドレス<input class="inp" type="email" name="email" value="${h(email)}" autocomplete="username" required></label>
    <label class="f">パスワード<input class="inp" type="password" name="password" autocomplete="current-password" required></label>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn" type="submit">ログイン</button>
    <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px"><a href="/signup" style="padding:12px 0">新規登録</a><a href="/reset" style="padding:12px 0">パスワードを忘れた場合</a></div>
  </form>`);
}
app.get('/login', (req, res) => {
  if (req.user) return res.redirect(303, safeNext(req.query.next));
  res.send(loginPage(safeNext(req.query.next), '', '', msgOf(req)));
});
app.post('/login', async (req, res) => {
  const email = normEmail(req.body.email);
  const next = safeNext(req.body.next);
  const { rows: [att] } = await pool.query('SELECT * FROM login_attempts WHERE email=$1', [email]);
  if (att?.locked_until && new Date(att.locked_until) > new Date()) {
    return res.status(429).send(loginPage(next, email, 'ログインが一時的に停止されています。15分ほど待ってから、もう一度お試しください。'));
  }
  const { rows: [u] } = await pool.query(`SELECT * FROM users WHERE email=$1 AND status='active'`, [email]);
  if (u && verifyPassword(String(req.body.password || ''), u.password_hash)) {
    await pool.query('DELETE FROM login_attempts WHERE email=$1', [email]);
    loginUser(req, res, u);
    return res.redirect(303, next);
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO login_attempts (email, fail_count) VALUES ($1, 1)
     ON CONFLICT (email) DO UPDATE SET fail_count = login_attempts.fail_count + 1 RETURNING fail_count`, [email]);
  if (r.fail_count >= 5) {
    await pool.query(`UPDATE login_attempts SET fail_count=0, locked_until=now() + interval '15 minutes' WHERE email=$1`, [email]);
    return res.status(401).send(loginPage(next, email, '5回続けて失敗したため、このメールアドレスでのログインを15分間停止しました。'));
  }
  res.status(401).send(loginPage(next, email, 'メールアドレスまたはパスワードが正しくありません'));
});
app.post('/logout', (_req, res) => { clearCookie(res, USER_COOKIE); go(res, '/login', 'ログアウトしました。'); });

// ===== 新規登録（9.2） =====
function signupPage(email, error) {
  return layout('新規登録', { nav: 'none' }, `<form class="card narrow" method="post" action="/signup">
    <h1 style="margin:0">新規登録</h1>
    <label class="f">メールアドレス<input class="inp" type="email" name="email" value="${h(email)}" autocomplete="email" required></label>
    <label class="f">パスワード<input class="inp" type="password" name="password" autocomplete="new-password" required></label>
    <label class="f">パスワード（確認）<input class="inp" type="password" name="password2" autocomplete="new-password" required></label>
    <div class="meta" style="font-size:13px;line-height:1.6">${h(PASSWORD_RULE)}</div>
    <label style="display:flex;gap:10px;align-items:center;min-height:44px;font-size:14px"><input type="checkbox" name="agree" value="1" required style="width:20px;height:20px">
      <span><a href="/terms" target="_blank">利用規約</a>と<a href="/privacy" target="_blank">プライバシーポリシー</a>に同意する</span></label>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn" type="submit">登録</button>
    <a href="/login" style="padding:12px 0">ログイン画面に戻る</a>
  </form>`);
}
app.get('/signup', (req, res) => (req.user ? res.redirect(303, '/') : res.send(signupPage('', ''))));
app.post('/signup', async (req, res) => {
  const email = normEmail(req.body.email);
  const pw = String(req.body.password || '');
  if (!emailOk(email)) return res.status(400).send(signupPage(email, 'メールアドレスの形式が正しくありません'));
  if (!passwordOk(pw)) return res.status(400).send(signupPage(email, 'パスワードが条件を満たしていません。' + PASSWORD_RULE));
  if (pw !== String(req.body.password2 || '')) return res.status(400).send(signupPage(email, '確認用のパスワードが一致しません'));
  if (req.body.agree !== '1') return res.status(400).send(signupPage(email, '利用規約とプライバシーポリシーへの同意が必要です'));
  const { rows: ex } = await pool.query(`SELECT 1 FROM users WHERE email=$1`, [email]);
  if (ex.length) {
    // 登録済み：画面の表示は同じ。そのアドレスに「登録済み」のお知らせを送る（9.2）
    const mail = await sendMail({ to: email, subject: '【ゆっくりNEWS】ご登録について',
      body: 'このメールアドレスは、すでに登録済みです。\nパスワードを忘れた場合は、ログイン画面の「パスワードを忘れた場合」からパスワードリセットをご利用ください。' });
    return res.redirect(303, sentUrl('signup', mail));
  }
  const token = newToken();
  // 仮登録中に同じアドレスで再度登録したら、前の確認用URLは無効にする
  await pool.query(
    `INSERT INTO pending_registrations (token, email, password_hash, expires_at) VALUES ($1,$2,$3, now() + interval '${TOKEN_HOURS} hours')
     ON CONFLICT (email) DO UPDATE SET token=EXCLUDED.token, password_hash=EXCLUDED.password_hash, expires_at=EXCLUDED.expires_at`,
    [token, email, hashPassword(pw)]);
  const mail = await sendMail({ to: email, subject: '【ゆっくりNEWS】登録の確認',
    body: 'ゆっくりNEWSへのご登録ありがとうございます。\n下のURLを開くと登録が完了します（有効期限：24時間）。',
    link: `/verify?token=${token}`, linkLabel: '確認用URLを開く' });
  res.redirect(303, sentUrl('signup', mail));
});

// 確認用URL → 本登録。ユーザーIDはここで発行する（8.1・9.2）
app.get('/verify', async (req, res) => {
  const { rows: [p] } = await pool.query(`SELECT * FROM pending_registrations WHERE token=$1 AND expires_at > now()`, [String(req.query.token || '')]);
  if (!p) return go(res, '/signup', 'この確認用URLは無効か、有効期限（24時間）が切れています。最初から登録をやり直してください。', true);
  let user = null;
  for (let attempt = 0; attempt <= ID_RETRY_MAX && !user; attempt++) {
    const id = newUserId();
    try {
      const { rows } = await pool.query(`INSERT INTO users (user_id, email, password_hash) VALUES ($1,$2,$3) RETURNING *`, [id, p.email, p.password_hash]);
      user = rows[0];
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'users_pkey') { // IDの重複：作り直す
        await pool.query('INSERT INTO id_retry_logs DEFAULT VALUES');
        const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM id_retry_logs WHERE occurred_at > now() - interval '1 day'`);
        console.log(`[user-id] ID重複のため作り直し（${attempt + 1}回目）`);
        if (n > 10) console.log('[user-id][管理者通知（モック）] 1日の作り直しが10回を超えました。乱数の作り方を確認してください');
        continue;
      }
      if (e.code === '23505') { // メールアドレスの重複：作り直さない
        await pool.query('DELETE FROM pending_registrations WHERE token=$1', [p.token]);
        return go(res, '/login', 'このメールアドレスは登録済みです。ログインしてください。');
      }
      throw e;
    }
  }
  if (!user) {
    console.log('[user-id][管理者通知（モック）] ユーザーIDを6回作り直しても登録できませんでした');
    return go(res, '/signup', '登録に失敗しました。時間をおいて再度お試しください', true);
  }
  await pool.query('DELETE FROM pending_registrations WHERE email=$1', [p.email]);
  loginUser(req, res, user);
  go(res, '/', `登録が完了しました。ユーザーID：${user.user_id}　MYページで収集元のURLを登録すると、ニュースが表示されます。`);
});

// ===== パスワードリセット（9.4） =====
function resetPage(error) {
  return layout('パスワードリセット', { nav: 'none' }, `<form class="card narrow" method="post" action="/reset">
    <h1 style="margin:0">パスワードリセット</h1>
    <p style="margin:0;font-size:14px">登録しているメールアドレスを入力してください。パスワードを設定し直すためのメールを送ります。</p>
    <label class="f">メールアドレス<input class="inp" type="email" name="email" autocomplete="email" required></label>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn" type="submit">メールを送る</button>
    <a href="/login" style="padding:12px 0">ログイン画面に戻る</a>
  </form>`);
}
async function startReset(user) {
  const token = newToken();
  await pool.query(`INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1,$2, now() + interval '${TOKEN_HOURS} hours')`, [token, user.user_id]);
  return sendMail({ to: user.email, subject: '【ゆっくりNEWS】パスワードの再設定',
    body: '下のURLを開いて、新しいパスワードを設定してください。\n有効期限は24時間で、1回使うと無効になります。',
    link: `/reset/confirm?token=${token}`, linkLabel: 'パスワード再設定用URLを開く' });
}
app.get('/reset', (_req, res) => res.send(resetPage('')));
app.post('/reset', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!emailOk(email)) return res.status(400).send(resetPage('メールアドレスの形式が正しくありません'));
  const { rows: [u] } = await pool.query(`SELECT * FROM users WHERE email=$1 AND status='active'`, [email]);
  if (u) await startReset(u); // ログインしていない人のリセットメールは画面に出さない（管理者のモック受信箱のみ）
  res.redirect(303, sentUrl('reset', null)); // 登録の有無に関係なく同じ表示
});
// MYページの「パスワードを変更する」：本人のメールアドレスに送る（本人の画面にモックのメールを表示）
app.post('/mypage/password', needUser, async (req, res) => {
  const mail = await startReset(req.user);
  res.redirect(303, sentUrl('resetSelf', mail));
});
async function validReset(token) {
  const { rows: [r] } = await pool.query(
    `SELECT r.*, u.email FROM password_resets r JOIN users u USING (user_id)
      WHERE r.token=$1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status='active'`, [String(token || '')]);
  return r || null;
}
function resetConfirmPage(token, error) {
  return layout('新しいパスワードの設定', { nav: 'none' }, `<form class="card narrow" method="post" action="/reset/confirm">
    <h1 style="margin:0">新しいパスワードの設定</h1>
    <input type="hidden" name="token" value="${h(token)}">
    <label class="f">新しいパスワード<input class="inp" type="password" name="password" autocomplete="new-password" required></label>
    <label class="f">新しいパスワード（確認）<input class="inp" type="password" name="password2" autocomplete="new-password" required></label>
    <div class="meta" style="font-size:13px;line-height:1.6">${h(PASSWORD_RULE)}</div>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn" type="submit">変更する</button>
  </form>`);
}
app.get('/reset/confirm', async (req, res) => {
  if (!(await validReset(req.query.token))) return go(res, '/reset', 'このURLは無効か、有効期限が切れているか、すでに使用されています。もう一度お試しください。', true);
  res.send(resetConfirmPage(String(req.query.token), ''));
});
app.post('/reset/confirm', async (req, res) => {
  const r = await validReset(req.body.token);
  if (!r) return go(res, '/reset', 'このURLは無効か、有効期限が切れているか、すでに使用されています。もう一度お試しください。', true);
  const pw = String(req.body.password || '');
  if (!passwordOk(pw)) return res.status(400).send(resetConfirmPage(r.token, 'パスワードが条件を満たしていません。' + PASSWORD_RULE));
  if (pw !== String(req.body.password2 || '')) return res.status(400).send(resetConfirmPage(r.token, '確認用のパスワードが一致しません'));
  // パスワードを変え、全端末のログインを無効にし、ログイン停止も解除する
  await pool.query(`UPDATE users SET password_hash=$2, session_version=session_version+1 WHERE user_id=$1`, [r.user_id, hashPassword(pw)]);
  await pool.query(`UPDATE password_resets SET used_at=now() WHERE token=$1`, [r.token]);
  await pool.query(`DELETE FROM login_attempts WHERE email=$1`, [r.email]);
  await sendMail({ to: r.email, subject: '【ゆっくりNEWS】パスワード変更のお知らせ', body: 'パスワードが変更されました。\nお心当たりがない場合は、お問い合わせ窓口までご連絡ください。' });
  clearCookie(res, USER_COOKIE);
  go(res, '/login', 'パスワードを変更しました。すべての端末でログアウトしました。新しいパスワードでログインしてください。');
});

// ===== ニュースフィールド画面（4章）：ユーザーごとの一覧 =====
async function lastCollection() {
  const { rows } = await pool.query(`SELECT completed_at FROM collections WHERE status='done' ORDER BY completed_at DESC LIMIT 1`);
  return rows[0]?.completed_at || null;
}
const thumbHtml = (url) => url
  ? `<img class="thumb" src="${h(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;noimg&quot;>No Image</div>'">`
  : '<div class="noimg">No Image</div>';

app.get('/', needUser, async (req, res) => {
  const uid = req.user.user_id;
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM user_feed_items WHERE user_id=$1', [uid]);
  const total = Math.max(1, Math.ceil(n / PER_PAGE));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), total);
  const { rows } = await pool.query(
    `SELECT a.article_id, a.title, a.summary, a.thumbnail_url, a.posted_at, s.name AS site
       FROM user_feed_items f JOIN articles a USING (article_id) LEFT JOIN sites s ON s.site_id = a.site_id
      WHERE f.user_id=$1 ORDER BY f.position LIMIT $2 OFFSET $3`, [uid, PER_PAGE, (page - 1) * PER_PAGE]);
  const { rows: [{ c: siteCount }] } = await pool.query('SELECT count(*)::int AS c FROM user_sites WHERE user_id=$1', [uid]);
  const last = await lastCollection();
  let inner = `${msgOf(req)}<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px"><h1>ニュース</h1>
    <div class="meta" style="font-size:14px">${page}/${total}ページ　／　最新記事の取得：${last ? fmtJst(last) : 'まだ収集していません'}</div></div>`;
  if (!siteCount) inner += `<div class="card" style="padding:24px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between"><span>MYページで収集元のURLを登録してください</span><a class="btn" href="/mypage">MYページへ</a></div>`;
  else if (!n) inner += `<div class="card" style="padding:24px">次の収集（6:00／11:55／16:00）から記事が表示されます</div>`;
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
  res.send(layout('ニュース', { active: 'field' }, inner));
});

// 記事詳細画面（5章）
app.get('/articles/:id', needUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, s.name AS site FROM articles a LEFT JOIN sites s ON s.site_id=a.site_id WHERE a.article_id=$1`, [parseInt(req.params.id, 10) || 0]);
  if (!rows.length) return res.status(404).send(layout('見つかりません', { active: 'field' }, '<p>記事が見つかりませんでした。</p><a href="/">ニュース一覧に戻る</a>'));
  const a = rows[0];
  const back = parseInt(req.query.from, 10) || 1;
  const badge = (st, what) => ({ pending: `<span class="badge">${what}は要約未完了（次の収集で再要約）</span> `, final: `<span class="badge">${what}は要約できなかったため代わりの内容</span> ` }[st] || '');
  res.send(layout(a.title, { active: 'field' }, `<article class="card" style="padding:28px;max-width:760px;margin:0 auto">
    <div class="meta" style="font-size:13px">${h(a.site || '')}　投稿日時：${fmtJst(a.posted_at)}${a.posted_at_estimated ? '（収集時刻）' : ''}</div>
    <h1 style="margin:8px 0 16px;line-height:1.4">${h(a.title)}</h1>
    ${a.thumbnail_url ? `<img src="${h(a.thumbnail_url)}" alt="" referrerpolicy="no-referrer" style="width:100%;border-radius:10px;max-height:380px;object-fit:cover" onerror="this.outerHTML='<div class=&quot;noimg&quot; style=&quot;max-width:none;width:100%&quot;>No Image</div>'">` : '<div class="noimg" style="max-width:none;width:100%">No Image</div>'}
    <p style="font-size:16px">${h(a.summary)}</p>${badge(a.title_status, '見出し')}${badge(a.summary_status, '概要')}
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:16px">
      <a class="btn" href="${h(a.url)}" target="_blank" rel="noopener noreferrer">記事参照（新しいタブで開く）</a>
      <a class="btn2" href="/?page=${back}">ニュース一覧に戻る</a></div>
  </article>`));
});

// ===== MYページ（8章） =====
app.get('/mypage', needUser, async (req, res) => {
  const u = req.user;
  const { rows: sites } = await pool.query(
    `SELECT s.site_id, s.name, s.feed_url, us.registered_at FROM user_sites us JOIN sites s USING (site_id)
      WHERE us.user_id=$1 ORDER BY us.registered_at DESC`, [u.user_id]);
  const last = await lastCollection();
  res.send(layout('MYページ', { active: 'mypage' }, `${msgOf(req)}<div class="mid">
    <h1 style="margin:0">MYページ</h1>
    <section class="card" style="padding:4px 20px">
      <div class="row"><div><div class="meta">メールアドレス</div><div>${h(u.email)}</div></div><a class="btn2" href="/mypage/email">変更</a></div>
      <div class="row"><div><div class="meta">ユーザーID（変更できません）</div><div class="mono" style="font-size:18px">${h(u.user_id)}</div></div></div>
      <div class="row"><div><div class="meta">パスワード</div><div>••••••••••••</div></div>
        <form method="post" action="/mypage/password" style="margin:0"><button class="linkbtn" type="submit">パスワードを変更する</button></form></div>
      <div class="row" style="border-bottom:none"><div><div class="meta">最新記事の取得日時</div><div>${last ? fmtJst(last) : 'まだ収集していません'}</div></div></div>
    </section>
    <section class="card" style="padding:20px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px"><h2 style="margin:0">収集元URL</h2><span class="meta">${sites.length}件（上限${MAX_SITES}件）</span></div>
      <form method="post" action="/mypage/sites" style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
        <label class="f" style="flex:999 1 260px">ニュースフィードまたはRSSのURL<input class="inp" type="url" name="url" required placeholder="https://"></label>
        <button class="btn" type="submit" style="flex:1 0 auto">追加</button></form>
      <div class="meta">追加するときにフィードを読み込めるか確認し、サイト名はフィードから取得します。記事は次の収集から表示されます。</div>
      <form method="post" action="/mypage/sites/delete" onsubmit="return confirm('選んだURLを削除します。削除したサイトの記事は、ニュース一覧に表示されなくなります。よろしいですか？')">
        <div class="scroll"><table><thead><tr><th></th><th>サイト名</th><th>URL</th><th>登録日時</th></tr></thead><tbody>
        ${sites.map((s) => `<tr><td><input type="checkbox" name="ids" value="${s.site_id}" aria-label="${h(s.name)}を選択" style="width:20px;height:20px"></td><td>${h(s.name)}</td><td style="word-break:break-all">${h(s.feed_url)}</td><td>${fmtJst(s.registered_at)}</td></tr>`).join('') || '<tr><td colspan="4">登録されているURLはありません</td></tr>'}
        </tbody></table></div>
        ${sites.length ? '<button class="btn2 danger" type="submit" style="margin-top:12px">選んだURLを削除</button>' : ''}
      </form>
    </section>
    <div style="display:flex;flex-wrap:wrap;gap:12px">
      <form method="post" action="/logout" style="margin:0"><button class="btn2" type="submit">ログアウト</button></form>
      <a class="btn2" href="/mypage/withdraw">退会</a>
    </div>
  </div>`));
});

app.post('/mypage/sites', needUser, async (req, res) => {
  const uid = req.user.user_id;
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\/\S+$/.test(url)) return go(res, '/mypage', 'URLの形式が正しくありません', true);
  const { rows: [{ c }] } = await pool.query('SELECT count(*)::int AS c FROM user_sites WHERE user_id=$1', [uid]);
  if (c >= MAX_SITES) return go(res, '/mypage', `登録できるURLは${MAX_SITES}件までです。不要なURLを削除してください`, true);
  let { rows: [site] } = await pool.query('SELECT * FROM sites WHERE feed_url=$1', [url]);
  if (site) {
    const { rows: dup } = await pool.query('SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2', [uid, site.site_id]);
    if (dup.length) return go(res, '/mypage', 'このURLはすでに登録されています', true);
  } else {
    let feed;
    try { feed = await loadFeed(url); } catch {
      return go(res, '/mypage', 'このURLから記事を取得できませんでした。ニュースフィードまたはRSSのURLを入力してください', true);
    }
    const name = (feed.title || '').trim() || new URL(url).host;
    ({ rows: [site] } = await pool.query(
      `INSERT INTO sites (name, feed_url) VALUES ($1,$2) ON CONFLICT (feed_url) DO UPDATE SET feed_url=EXCLUDED.feed_url RETURNING *`, [name, url]));
  }
  await pool.query('INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [uid, site.site_id]);
  go(res, '/mypage', `「${site.name}」を追加しました。記事は次の収集から表示されます`);
});

app.post('/mypage/sites/delete', needUser, async (req, res) => {
  const uid = req.user.user_id;
  const ids = [].concat(req.body.ids || []).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) return go(res, '/mypage', '削除するURLを選んでください', true);
  await pool.query('DELETE FROM user_sites WHERE user_id=$1 AND site_id = ANY($2::int[])', [uid, ids]);
  // 削除したサイトの記事は、すぐにそのユーザーの一覧に表示しない（8.4）
  await pool.query(`DELETE FROM user_feed_items f USING articles a WHERE f.article_id=a.article_id AND f.user_id=$1 AND a.site_id = ANY($2::int[])`, [uid, ids]);
  await pool.query(`WITH r AS (SELECT user_id, position, row_number() OVER (ORDER BY position) AS np FROM user_feed_items WHERE user_id=$1)
    UPDATE user_feed_items f SET position = -r.np FROM r WHERE f.user_id=r.user_id AND f.position=r.position`, [uid]);
  await pool.query('UPDATE user_feed_items SET position = -position WHERE user_id=$1 AND position < 0', [uid]);
  go(res, '/mypage', `${ids.length}件のURLを削除しました`);
});

// メールアドレス変更（8.3）
function emailPage(u, email, error) {
  return layout('メールアドレスの変更', { active: 'mypage' }, `<form class="card narrow" method="post" action="/mypage/email">
    <h1 style="margin:0">メールアドレスの変更</h1>
    <div class="meta" style="font-size:14px">現在：${h(u.email)}</div>
    <label class="f">変更後のメールアドレス<input class="inp" type="email" name="email" value="${h(email)}" required></label>
    <label class="f">現在のパスワード<input class="inp" type="password" name="password" autocomplete="current-password" required></label>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn" type="submit">更新</button>
    <a href="/mypage" style="padding:12px 0">MYページに戻る</a>
  </form>`);
}
app.get('/mypage/email', needUser, (req, res) => res.send(emailPage(req.user, '', '')));
app.post('/mypage/email', needUser, async (req, res) => {
  const u = req.user;
  const email = normEmail(req.body.email);
  if (!verifyPassword(String(req.body.password || ''), u.password_hash)) return res.status(401).send(emailPage(u, email, 'パスワードが正しくありません'));
  if (!emailOk(email)) return res.status(400).send(emailPage(u, email, 'メールアドレスの形式が正しくありません'));
  if (email === u.email) return res.status(400).send(emailPage(u, email, '現在のメールアドレスと同じです'));
  const { rows: taken } = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (taken.length) {
    const mail = await sendMail({ to: email, subject: '【ゆっくりNEWS】メールアドレス変更について',
      body: 'このメールアドレスはすでに登録済みのため、変更先として使用できません。\n変更は行われていません。' });
    return res.redirect(303, sentUrl('email', mail));
  }
  const token = newToken();
  await pool.query('DELETE FROM email_changes WHERE user_id=$1', [u.user_id]);
  await pool.query(`INSERT INTO email_changes (token, user_id, new_email, expires_at) VALUES ($1,$2,$3, now() + interval '${TOKEN_HOURS} hours')`, [token, u.user_id, email]);
  const mail = await sendMail({ to: email, subject: '【ゆっくりNEWS】メールアドレス変更の確認',
    body: '下のURLを開くと、メールアドレスの変更が完了します（有効期限：24時間）。', link: `/mypage/email/confirm?token=${token}`, linkLabel: '確認用URLを開く' });
  res.redirect(303, sentUrl('email', mail));
});
app.get('/mypage/email/confirm', async (req, res) => {
  const { rows: [c] } = await pool.query(
    `SELECT c.*, u.email AS old_email FROM email_changes c JOIN users u USING (user_id)
      WHERE c.token=$1 AND c.expires_at > now() AND u.status='active'`, [String(req.query.token || '')]);
  if (!c) return go(res, req.user ? '/mypage' : '/login', 'この確認用URLは無効か、有効期限（24時間）が切れています。最初からやり直してください。', true);
  try {
    await pool.query('UPDATE users SET email=$2 WHERE user_id=$1', [c.user_id, c.new_email]);
  } catch (e) {
    if (e.code === '23505') { await pool.query('DELETE FROM email_changes WHERE token=$1', [c.token]); return go(res, req.user ? '/mypage' : '/login', 'このメールアドレスは使用できません。変更は行われていません。', true); }
    throw e;
  }
  await pool.query('DELETE FROM email_changes WHERE user_id=$1', [c.user_id]);
  await pool.query('DELETE FROM login_attempts WHERE email=$1', [c.old_email]);
  const mail = await sendMail({ to: c.old_email, subject: '【ゆっくりNEWS】メールアドレス変更のお知らせ',
    body: `ご登録のメールアドレスが ${c.new_email} に変更されました。\nお心当たりがない場合は、お問い合わせ窓口までご連絡ください。` });
  res.redirect(303, sentUrl('emailDone', mail));
});

// 退会（9.6）
function withdrawPage(error) {
  return layout('退会', { active: 'mypage' }, `<form class="card narrow" method="post" action="/mypage/withdraw"
      onsubmit="return confirm('本当に退会しますか？メールアドレス・登録した収集元URLなどはすぐに削除され、元に戻せません。')">
    <h1 style="margin:0">退会</h1>
    <p style="margin:0">退会すると、メールアドレスと登録した収集元URLはすぐに削除され、元に戻せません。ユーザーIDは使用済みとして残し、使い回しません。</p>
    <label class="f">パスワード<input class="inp" type="password" name="password" autocomplete="current-password" required></label>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn2 danger" type="submit">退会する</button>
    <a href="/mypage" style="padding:12px 0">MYページに戻る</a>
  </form>`);
}
app.get('/mypage/withdraw', needUser, (_req, res) => res.send(withdrawPage('')));
app.post('/mypage/withdraw', needUser, async (req, res) => {
  const u = req.user;
  if (!verifyPassword(String(req.body.password || ''), u.password_hash)) return res.status(401).send(withdrawPage('パスワードが正しくありません'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of ['user_sites', 'user_feed_items', 'email_changes', 'password_resets']) {
      await client.query(`DELETE FROM ${t} WHERE user_id=$1`, [u.user_id]);
    }
    await client.query('DELETE FROM login_attempts WHERE email=$1', [u.email]);
    await client.query(`UPDATE users SET email=NULL, password_hash=NULL, status='withdrawn', withdrawn_at=now(), session_version=session_version+1 WHERE user_id=$1`, [u.user_id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  clearCookie(res, USER_COOKIE);
  go(res, '/login', `退会しました。メールアドレスと登録した収集元URLを削除しました（ユーザーID ${u.user_id} は使用済みとして残し、使い回しません）。`);
});

// 規約・ポリシー（仮）
app.get('/privacy', (req, res) => res.send(layout('プライバシーポリシー', { nav: req.user ? 'user' : 'none' },
  '<div class="card mid" style="padding:28px"><h1 style="margin:0">プライバシーポリシー（準備中）</h1><p>正式な内容は公開前に掲載します。案は仕様書の付録Aにあります。</p></div>')));
app.get('/terms', (req, res) => res.send(layout('利用規約', { nav: req.user ? 'user' : 'none' },
  '<div class="card mid" style="padding:28px"><h1 style="margin:0">利用規約（準備中）</h1><p>正式な内容は公開前に掲載します。</p></div>')));

// ===== 管理者（収集の実行・状況・モック受信箱） =====
const adminFails = { n: 0, until: 0 };
function adminLoginPage(error) {
  return layout('管理者ログイン', { nav: 'none' }, `<form class="card narrow" method="post" action="/admin/login">
    <h1 style="margin:0">管理者ログイン</h1>
    <label class="f">ログインID<input class="inp" name="user" autocomplete="username" required></label>
    <label class="f">パスワード<input class="inp" type="password" name="password" autocomplete="current-password" required></label>
    ${error ? `<div class="err" role="alert">${h(error)}</div>` : ''}
    <button class="btn" type="submit">ログイン</button>
  </form>`);
}
app.get('/admin/login', (req, res) => (req.admin ? res.redirect(303, '/admin') : res.send(adminLoginPage(''))));
app.post('/admin/login', (req, res) => {
  if (adminFails.until > Date.now()) return res.status(429).send(adminLoginPage('ログインが一時的に停止されています。15分ほど待ってから、もう一度お試しください。'));
  if (safeEq(String(req.body.user || '').trim().toLowerCase(), ADMIN_USER) && safeEq(String(req.body.password || ''), ADMIN_PASSWORD)) {
    adminFails.n = 0;
    setCookie(req, res, ADMIN_COOKIE, adminSessions.make(['admin'], 1), 86400);
    return res.redirect(303, '/admin');
  }
  adminFails.n += 1;
  if (adminFails.n >= 5) { adminFails.n = 0; adminFails.until = Date.now() + LOCK_MS; }
  res.status(401).send(adminLoginPage('ログインIDまたはパスワードが正しくありません'));
});
app.post('/admin/logout', (_req, res) => { clearCookie(res, ADMIN_COOKIE); res.redirect(303, '/admin/login'); });

let running = null;
const startCollection = () => {
  if (!running) running = runCollection().catch((e) => console.error(e)).finally(() => { running = null; });
};
app.get('/admin', needAdmin, async (req, res) => {
  const { rows: cols } = await pool.query('SELECT * FROM collections ORDER BY collection_id DESC LIMIT 10');
  const { rows: [st] } = await pool.query(`SELECT
     (SELECT count(*)::int FROM users WHERE status='active') AS users,
     (SELECT count(*)::int FROM users WHERE status='withdrawn') AS withdrawn,
     (SELECT count(*)::int FROM pending_registrations) AS pending_users,
     (SELECT count(*)::int FROM articles) AS total,
     (SELECT count(*)::int FROM articles WHERE summary_source='ai') AS ai,
     (SELECT count(*)::int FROM articles WHERE summary_status='pending' OR title_status='pending') AS pending,
     (SELECT count(*)::int FROM articles WHERE summary_status='final' OR title_status='final') AS final,
     (SELECT count(*)::int FROM id_retry_logs WHERE occurred_at > now() - interval '1 day') AS id_retry`);
  const { rows: sites } = await pool.query(`SELECT s.name, s.feed_url, count(us.user_id)::int AS users FROM sites s
    LEFT JOIN user_sites us USING (site_id) GROUP BY s.site_id ORDER BY users DESC, s.name`);
  const statusJa = { running: '実行中', done: '完了', failed: '失敗' };
  res.send(layout('収集・状況', { nav: 'admin', active: 'admin' }, `${msgOf(req)}<h1>収集・状況</h1>
    <section class="card" style="padding:20px;margin-bottom:16px">
      <h2>収集</h2>
      <p class="meta" style="margin:4px 0 12px">自動収集：毎日 6:00／11:55／16:00（日本時間）。1人以上のユーザーが登録しているサイトだけを収集します。</p>
      <form method="post" action="/admin/collect"><button class="btn" type="submit" ${running ? 'disabled' : ''}>${running ? '収集中…（画面を再読み込みして確認）' : '今すぐ収集'}</button></form>
      <p style="margin:12px 0 4px">会員 ${st.users}人（退会 ${st.withdrawn}人・仮登録 ${st.pending_users}件）／ 記事 ${st.total}件（Gemini要約 ${st.ai}件・要約未完了 ${st.pending}件・代わりの内容で確定 ${st.final}件）／ 直近1日のユーザーID作り直し ${st.id_retry}回</p>
      <div class="scroll"><table><thead><tr><th>開始</th><th>完了</th><th>状態</th><th>メモ</th></tr></thead><tbody>
      ${cols.map((c) => `<tr><td>${fmtJst(c.started_at)}</td><td>${fmtJst(c.completed_at)}</td><td>${h(statusJa[c.status] || c.status)}</td><td style="white-space:pre-line">${h((c.note || '').slice(0, 500))}</td></tr>`).join('') || '<tr><td colspan="4">まだ収集していません</td></tr>'}
      </tbody></table></div>
    </section>
    <section class="card" style="padding:20px">
      <h2>登録されている収集元</h2>
      <div class="scroll"><table><thead><tr><th>サイト名</th><th>URL</th><th>登録ユーザー数</th></tr></thead><tbody>
      ${sites.map((s) => `<tr><td>${h(s.name)}</td><td style="word-break:break-all">${h(s.feed_url)}</td><td>${s.users}${s.users ? '' : '（収集しない）'}</td></tr>`).join('') || '<tr><td colspan="3">ありません</td></tr>'}
      </tbody></table></div>
    </section>`));
});
app.post('/admin/collect', needAdmin, (_req, res) => {
  startCollection();
  go(res, '/admin', '収集を開始しました。記事数によっては数分かかります。画面を再読み込みして結果を確認してください');
});
app.get('/admin/mails', needAdmin, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM mock_mails ORDER BY mail_id DESC LIMIT 100');
  res.send(layout('モック受信箱', { nav: 'admin', active: 'mails' }, `<h1>モック受信箱</h1>
    <p class="meta" style="font-size:14px">メール送信の代わりに保存したメールです（直近100件、7日で削除）。本番ではそれぞれの宛先にメールで届きます。</p>
    <div style="display:flex;flex-direction:column;gap:12px">${rows.map((m) => `<div><div class="meta">${fmtJst(m.created_at)}</div>${mailBox(m)}</div>`).join('') || '<p>まだメールはありません。</p>'}</div>`));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send(layout('エラー', { nav: 'none' }, '<p>エラーが発生しました。時間をおいて再度お試しください。</p><a href="/">トップに戻る</a>'));
});

await migrate();
if (process.env.ENABLE_SCHEDULER !== 'false') {
  for (const expr of ['0 6 * * *', '55 11 * * *', '0 16 * * *']) cron.schedule(expr, startCollection, { timezone: 'Asia/Tokyo' });
  console.log('自動収集を設定しました（6:00／11:55／16:00 日本時間）');
}
app.listen(PORT, () => console.log(`ゆっくりNEWS 起動：ポート ${PORT}`));
