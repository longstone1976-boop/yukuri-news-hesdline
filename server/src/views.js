import { escapeHtml as h } from './text.js';

const CSS = `
:root{--ink:#1d1d1f;--sub:#6e6e73;--line:#d2d2d7;--accent:#0071e3;--link:#0066cc;--dark:#1d1d1f;--bg:#f5f5f7;--err:#d70015;--radius:18px}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"SF Pro JP","SF Pro Text","Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,system-ui,sans-serif;
font-size:17px;line-height:1.47;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header{position:sticky;top:0;z-index:10;background:rgba(29,29,31,.97);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);color:#f5f5f7}
footer{background:var(--dark);color:#86868b;font-size:12px}
footer .wrap{display:flex;flex-direction:column;align-items:center;gap:2px;padding:14px 20px 22px;text-align:center}
footer nav{gap:28px;justify-content:center}footer nav a,footer nav a:hover{color:#d2d2d7;background:none;border:none;padding:0;min-height:44px;display:inline-flex;align-items:center;font-size:12px;font-weight:400}
footer nav a:hover{color:#fff;text-decoration:none}
.wrap{max-width:1040px;margin:0 auto;padding:6px 22px}
.top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px}
.logo{font-size:19px;font-weight:600;letter-spacing:-.02em;color:#f5f5f7;text-decoration:none;min-height:44px;display:inline-flex;align-items:center}.logo:hover{text-decoration:none;color:#fff}
.logo small{font-size:12px;font-weight:400;margin-left:8px;color:#a1a1a6}
nav{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
nav a{color:#d2d2d7;font-size:14px;padding:0 12px;min-height:44px;display:inline-flex;align-items:center;border-radius:980px}
nav a:hover{color:#fff;text-decoration:none}
nav a.on{color:#fff;font-weight:600}
.navbtn{color:#d2d2d7;background:transparent;border:none;padding:0 12px;min-height:44px;font:inherit;font-size:14px;cursor:pointer}
.navbtn:hover{color:#fff}
main{flex:1 0 auto;width:100%;max-width:1040px;margin:0 auto;padding:40px 22px 120px}
.card{background:#fff;border:none;border-radius:var(--radius)}
.item{padding:20px;display:flex;flex-wrap:wrap;gap:20px;margin-bottom:16px}
.thumb{flex:1 1 180px;max-width:220px;aspect-ratio:16/10;border-radius:12px;object-fit:cover;background:#e8e8ed}
.noimg{flex:1 1 180px;max-width:220px;aspect-ratio:16/10;border-radius:12px;background:#e8e8ed;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--sub)}
.body{flex:999 1 320px;min-width:0}
.meta{font-size:12px;color:var(--sub)}
h1{font-size:40px;font-weight:600;letter-spacing:-.02em;line-height:1.1;margin:0 0 28px}
h2{font-size:21px;font-weight:600;letter-spacing:-.015em;margin:4px 0 8px;line-height:1.35}
p{line-height:1.7}
.btn{min-height:44px;padding:0 22px;border-radius:980px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-size:15px;font-weight:400;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.btn:hover{background:#0077ed;border-color:#0077ed;color:#fff;text-decoration:none}
.btn2{min-height:44px;padding:0 22px;border-radius:980px;border:1px solid var(--accent);background:transparent;color:var(--accent);font:inherit;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.btn2:hover{background:var(--accent);color:#fff;text-decoration:none}
.danger,.danger:hover{border-color:var(--err);background:var(--err);color:#fff}
.btn2.danger{background:transparent;color:var(--err)}.btn2.danger:hover{background:var(--err);color:#fff}
.btn:disabled,.btn2:disabled{opacity:.4;cursor:default}
.linkbtn{background:none;border:none;padding:0;min-height:44px;font:inherit;color:var(--link);cursor:pointer}.linkbtn:hover{text-decoration:underline}
.pager a,.pager span{position:fixed;bottom:20px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.pager .prev{left:20px}.pager .next{right:20px}
.pager span{opacity:.4;pointer-events:none}
.inp{min-height:48px;width:100%;padding:10px 14px;border:1px solid #86868b;border-radius:12px;background:#fff;font:inherit;font-size:17px;color:var(--ink)}
.inp:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px rgba(0,113,227,.2)}
label.f{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600;color:var(--ink)}
.err{color:var(--err);font-size:14px}
.flash{padding:14px 18px;border-radius:14px;background:#fff;border:1px solid #c6e7d2;border-left:4px solid #1a8f3c;margin-bottom:20px;font-size:15px}
.flash.bad{border-color:#f3c4c9;border-left-color:var(--err)}
.narrow{max-width:460px;margin:24px auto;padding:36px;display:flex;flex-direction:column;gap:18px}
.mid{max-width:680px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:14px 0;border-bottom:1px solid #e8e8ed}
table{border-collapse:collapse;width:100%}td,th{padding:10px 10px;border-bottom:1px solid #e8e8ed;text-align:left;font-size:14px;vertical-align:top}th{color:var(--sub);font-weight:600;font-size:12px}
.scroll{overflow-x:auto}
.badge{display:inline-block;font-size:12px;padding:2px 10px;border-radius:999px;background:#e8e8ed;color:var(--sub)}
.mail{border:1px dashed #a1a1a6;border-radius:var(--radius);background:#fbfbfd;padding:22px;display:flex;flex-direction:column;gap:8px}
.mono{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em}
input[type=checkbox]{accent-color:var(--accent)}
/* ニュース一覧：3列の正方形タイル（角丸・余白多め） */
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:1000px;margin:0 auto}
.tile{position:relative;display:block;aspect-ratio:1/1;overflow:hidden;background:var(--tile,#3a3a3c);color:#fff;text-decoration:none;border-radius:var(--radius);transition:transform .3s ease,box-shadow .3s ease}
.tile:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.14);text-decoration:none}
.tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s ease}
.tile:hover,.tile:visited{color:#fff}
.tile:hover img,.tile:focus-visible img{transform:scale(1.03)}
.tile:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.tile .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;font-weight:600;font-size:15px;line-height:1.4;color:rgba(255,255,255,.92)}
.tile .cap{position:absolute;left:0;right:0;bottom:0;padding:36px 14px 12px;background:linear-gradient(transparent,rgba(0,0,0,.72));display:flex;flex-direction:column;gap:3px}
.tile .t{font-size:15px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tile .m{font-size:11px;color:rgba(255,255,255,.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile.noimg-tile .cap{background:none;padding-top:8px}
.tile.noimg-tile .ph{bottom:44px}
@media (max-width:734px){h1{font-size:32px;margin-bottom:20px}main{padding-top:28px}.narrow{padding:28px 22px}}
@media (max-width:600px){.grid{gap:6px}.tile{border-radius:12px}.tile .t{font-size:11px}.tile .m{display:none}.tile .cap{padding:20px 8px 8px}.tile .ph{font-size:12px;padding:8px}.tile.noimg-tile .ph{bottom:28px}}
`;

/** nav: 'user'（会員向け）/ 'admin'（管理者向け）/ 'none' */
export function layout(title, { nav = 'user', active = '' } = {}, inner) {
  let navHtml = '';
  if (nav === 'user') {
    navHtml = [['/', 'News', 'field'], ['/mypage', 'MYページ', 'mypage']]
      .map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`).join('')
      + '<form method="post" action="/logout" style="margin:0"><button class="navbtn" type="submit">ログアウト</button></form>';
  } else if (nav === 'admin') {
    navHtml = [['/admin', '収集・状況', 'admin'], ['/admin/mails', 'モック受信箱', 'mails']]
      .map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`).join('')
      + '<form method="post" action="/admin/logout" style="margin:0"><button class="navbtn" type="submit">管理者ログアウト</button></form>';
  }
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}｜ゆっくりNEWS</title>
<style>${CSS}</style></head><body>
<header><div class="wrap top"><a class="logo" href="${nav === 'admin' ? '/admin' : '/'}">ゆっくりNEWS${nav === 'admin' ? '<small>管理者</small>' : ''}</a><nav>${navHtml}</nav></div></header>
<main>${inner}</main>
<footer><div class="wrap"><nav aria-label="フッター"><a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a></nav><span>© ゆっくりNEWS</span></div></footer></body></html>`;
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
