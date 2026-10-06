const crypto = require('crypto');
const { pool } = require('./db');
const config = require('./config');
const audit = require('./audit');

const COOKIE = 'session';

// ---------- كلمات المرور (scrypt) ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

// ---------- الجلسة: كوكي موقّع بـ HMAC ----------

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id,
    name: user.username,
    exp: Date.now() + config.sessionHours * 3600 * 1000,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ---------- الحد من محاولات الدخول ----------

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(ip) {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < Date.now()) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else entry.count += 1;
}

// ---------- المسارات والـ middleware ----------

async function login(req, res) {
  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد ربع ساعة' });
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const { rows } = await pool.query(
    'SELECT id, username, password_hash, active FROM users WHERE username = $1',
    [username],
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(req.ip);
    audit.log({ ...req, auditUser: username.slice(0, 100), ip: req.ip }, 'login_failed', 'users', '', 'كلمة مرور خاطئة');
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  if (!user.active) return res.status(403).json({ error: 'هذا الحساب موقوف، تواصل مع مدير النظام' });
  attempts.delete(req.ip);
  await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);
  audit.log({ user: { name: user.username }, ip: req.ip }, 'login', 'users', user.id, 'تسجيل دخول');
  setSessionCookie(res, createToken(user), config.sessionHours * 3600);
  return res.json({ username: user.username });
}

function logout(req, res) {
  setSessionCookie(res, '', 0);
  res.status(204).end();
}

// المستخدم يُقرأ من قاعدة البيانات (مع ذاكرة مؤقتة قصيرة) حتى يسري الإيقاف وتغيير الدور فورًا
const userCache = new Map();
const CACHE_MS = 10 * 1000;

async function loadUser(id) {
  const hit = userCache.get(id);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.user;
  const { rows } = await pool.query(`SELECT u.id, u.username, u.full_name, u.role, u.active, u.branch_id, b.name AS branch_name
     FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.id = $1`, [id]);
  const user = rows[0] || null;
  userCache.set(id, { user, at: Date.now() });
  return user;
}

function forgetUser(id) {
  userCache.delete(Number(id));
  userCache.delete(String(id));
}

async function requireAuth(req, res, next) {
  const session = readToken(getCookie(req, COOKIE));
  if (!session) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  const user = await loadUser(session.uid);
  if (!user || !user.active) {
    setSessionCookie(res, '', 0);
    return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  }
  req.user = {
    id: user.id,
    name: user.username,
    fullName: user.full_name,
    role: user.role,
    branchId: user.branch_id ? String(user.branch_id) : null,
    branchName: user.branch_name || null,
  };
  return next();
}

module.exports = { hashPassword, verifyPassword, createToken, readToken, login, logout, requireAuth, forgetUser };
