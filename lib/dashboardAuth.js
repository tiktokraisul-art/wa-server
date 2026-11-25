// Dashboard er jonno shoja-shapta password login.
// Kono notun npm package lagena - Node-er nijer 'crypto' module use kora hoyeche.

const crypto = require('crypto');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const COOKIE_NAME = 'wa_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 din

// Password theke ekta secret key banano hoy, cookie sign/verify korte
const SECRET = crypto
  .createHash('sha256')
  .update((DASHBOARD_PASSWORD || 'no-password-set') + ':wa-dashboard-secret')
  .digest('hex');

function sign(value) {
  const h = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${h}`;
}

function verify(signed) {
  if (!signed || typeof signed !== 'string') return false;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return false;
  const value = signed.slice(0, idx);
  const h = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  try {
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b) ? value : false;
  } catch (e) {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function loginHandler(req, res) {
  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD set kora nai (Render Environment e dao)' });
  }
  const password = req.body && req.body.password;
  if (password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Password vul' });
  }
  const token = sign('ok:' + Date.now() + ':' + crypto.randomBytes(8).toString('hex'));
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=None`
  );
  res.json({ ok: true });
}

function logoutHandler(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=None`);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const value = verify(cookies[COOKIE_NAME]);
  if (!value) return res.status(401).json({ error: 'Login dorkar' });
  next();
}

module.exports = { loginHandler, logoutHandler, requireAuth, parseCookies, verify };
