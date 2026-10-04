const crypto = require('crypto');
const { pool } = require('./db');
const config = require('./config');

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
  if (config.isProduction) parts.push('Secure');
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
  const { rows } = await pool.query('SELECT id, username, password_hash FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(req.ip);
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  attempts.delete(req.ip);
  setSessionCookie(res, createToken(user), config.sessionHours * 3600);
  return res.json({ username: user.username });
}

function logout(req, res) {
  setSessionCookie(res, '', 0);
  res.status(204).end();
}

function requireAuth(req, res, next) {
  const session = readToken(getCookie(req, COOKIE));
  if (!session) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  req.user = session;
  return next();
}

module.exports = { hashPassword, verifyPassword, createToken, readToken, login, logout, requireAuth };
