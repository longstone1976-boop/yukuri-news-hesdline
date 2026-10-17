import crypto from 'node:crypto';

// ===== パスワード（8.2） =====
const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [kind, s, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !s || !h) return false;
  const hb = Buffer.from(h, 'base64');
  const c = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), hb.length, SCRYPT);
  return crypto.timingSafeEqual(c, hb);
}
// 半角12〜64文字。英大文字・英小文字・数字をそれぞれ1文字以上。記号も可
export const passwordOk = (p) => /^[\x21-\x7e]{12,64}$/.test(p) && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p);
export const PASSWORD_RULE = '半角12〜64文字で、英大文字・英小文字・数字をそれぞれ1文字以上含めてください（記号も使えます）。';
export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const emailOk = (e) => e.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e);

export const newToken = () => crypto.randomBytes(24).toString('base64url');

// ===== ユーザーID（8.1）：西暦4桁＋ランダム8文字（O・I・l・o を除く58種類） =====
const ID_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
export function newUserId() {
  const year = new Date(Date.now() + 9 * 3600_000).getUTCFullYear(); // 日本時間の年
  let s = String(year);
  while (s.length < 12) {
    const b = crypto.randomBytes(1)[0];
    if (b < ID_CHARS.length * 4) s += ID_CHARS[b % ID_CHARS.length]; // 偏りが出ないように 232 以上は捨てる
  }
  return s;
}

// ===== 署名付きCookie =====
export function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function signer(secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const sign = (v) => crypto.createHmac('sha256', key).update(v).digest('base64url');
  return {
    make(fields, days) {
      const v = [...fields, Date.now() + days * 86400_000].join('.');
      return `${v}.${sign(v)}`;
    },
    read(token) {
      const parts = String(token || '').split('.');
      if (parts.length < 2) return null;
      const sig = parts.pop();
      const v = parts.join('.');
      if (!safeEq(sig, sign(v))) return null;
      const exp = Number(parts.pop());
      if (!(exp > Date.now())) return null;
      return parts;
    },
  };
}
export function readCookie(req, name) {
  for (const c of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = c.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
export function setCookie(req, res, name, value, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
export const clearCookie = (res, name) => res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
export const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : '/');
