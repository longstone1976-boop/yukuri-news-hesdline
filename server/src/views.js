import { escapeHtml as h } from './text.js';

const CSS = `
:root{--ink:#1B1F24;--sub:#4A535C;--line:#DCE1E6;--accent:#0B5E5E;--dark:#0B3B3B;--bg:#F3F5F7;--err:#A1271C}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Zen Kaku Gothic New",system-ui,sans-serif}
a{color:var(--accent)}a:hover{color:#063F3F}
header{background:var(--dark);color:#fff}
.wrap{max-width:1040px;margin:0 auto;padding:12px 20px}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.logo{font-size:24px;font-weight:700;color:#fff;text-decoration:none}.logo small{font-size:12px;font-weight:400;margin-left:8px;color:#BFD9D9}
nav{display:flex;gap:6px;flex-wrap:wrap;align-items:center}nav a{color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:0 14px;text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
nav a.on{background:#fff;color:var(--dark);font-weight:700}
.navbtn{color:#fff;background:transparent;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:0 14px;min-height:44px;font:inherit;cursor:pointer}
.navbtn:hover{background:rgba(255,255,255,.12)}
main{max-width:1040px;margin:0 auto;padding:24px 20px 120px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px}
.item{padding:16px;display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px}
.thumb{flex:1 1 180px;max-width:220px;aspect-ratio:16/10;border-radius:8px;object-fit:cover;background:#E4E7EA}
.noimg{flex:1 1 180px;max-width:220px;aspect-ratio:16/10;border-radius:8px;border:1px dashed #9AA5AF;background:#E4E7EA;display:flex;align-items:center;justify-content:center;font-size:13px;color:#3D464E}
.body{flex:999 1 320px;min-width:0}
.meta{font-size:12px;color:var(--sub)}
h1{font-size:24px;margin:0 0 16px}h2{font-size:18px;margin:4px 0 6px;line-height:1.4}
p{line-height:1.8}
.btn{min-height:44px;padding:0 20px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.btn:hover{background:#094C4C;color:#fff}
.btn2{min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #9AA5AF;background:#fff;color:var(--ink);font:inherit;cursor:pointer;display:inline-flex;align-items:center;text-decoration:none}
.danger{border-color:var(--err);background:var(--err);color:#fff}
.linkbtn{background:none;border:none;padding:0;min-height:44px;font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer}
.pager a,.pager span{position:fixed;bottom:16px;box-shadow:0 4px 12px rgba(0,0,0,.2)}
.pager .prev{left:16px}.pager .next{right:16px}
.pager span{opacity:.45;pointer-events:none}
.inp{min-height:44px;width:100%;padding:8px 12px;border:1px solid #8A949E;border-radius:8px;font:inherit;font-size:16px}
label.f{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:700}
.err{color:var(--err)}
.flash{padding:12px 16px;border-radius:8px;background:#E3F1EC;border:1px solid #8CC2AE;margin-bottom:16px}
.flash.bad{background:#FBEAEA;border-color:#E1A3A3}
.narrow{max-width:460px;margin:24px auto;padding:28px;display:flex;flex-direction:column;gap:16px}
.mid{max-width:680px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid #EEF1F4}
table{border-collapse:collapse;width:100%}td,th{padding:8px 10px;border-bottom:1px solid #EEF1F4;text-align:left;font-size:14px;vertical-align:top}
.scroll{overflow-x:auto}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#EEF1F4;color:var(--sub)}
.mail{border:1px dashed #9AA5AF;border-radius:12px;background:#FBFCFD;padding:20px;display:flex;flex-direction:column;gap:8px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em}
`;

/** nav: 'user'（会員向け）/ 'admin'（管理者向け）/ 'none' */
export function layout(title, { nav = 'user', active = '' } = {}, inner) {
  let navHtml = '';
  if (nav === 'user') {
    navHtml = [['/', 'ニュース', 'field'], ['/mypage', 'MYページ', 'mypage']]
      .map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`).join('')
      + '<form method="post" action="/logout" style="margin:0"><button class="navbtn" type="submit">ログアウト</button></form>';
  } else if (nav === 'admin') {
    navHtml = [['/admin', '収集・状況', 'admin'], ['/admin/mails', 'モック受信箱', 'mails']]
      .map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`).join('')
      + '<form method="post" action="/admin/logout" style="margin:0"><button class="navbtn" type="submit">管理者ログアウト</button></form>';
  }
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}｜ゆっくりNEWS</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header><div class="wrap top"><a class="logo" href="${nav === 'admin' ? '/admin' : '/'}">ゆっくりNEWS${nav === 'admin' ? '<small>管理者</small>' : ''}</a><nav>${navHtml}</nav></div></header>
<main>${inner}</main></body></html>`;
}

export const flash = (msg, bad) => (msg ? `<div class="flash ${bad ? 'bad' : ''}" role="status">${h(msg)}</div>` : '');

/** モックメールの表示（実際には送らない） */
export function mailBox(mail) {
  if (!mail) return '';
  return `<section class="mail" aria-label="モックのメール">
    <div class="meta" style="font-weight:700">モックのメール（メール送信機能の代わりに画面に表示しています）</div>
    <div class="meta">宛先：${h(mail.to_email)}</div>
    <div style="font-weight:700">${h(mail.subject)}</div>
    <div style="white-space:pre-line;line-height:1.7;font-size:14px">${h(mail.body)}</div>
    ${mail.link_url ? `<div><a class="btn2" href="${h(mail.link_url)}">${h(mail.link_label || 'URLを開く')}</a></div>` : ''}
  </section>`;
}
