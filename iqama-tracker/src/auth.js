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

// تذكرة مؤقتة بين كلمة المرور ورمز التحقق (موقّعة بمفتاح مختلف فما تنفعش كجلسة)
const TICKET_MS = 5 * 60 * 1000;
const ticketFails = new Map();

function createTicket(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id, n: crypto.randomBytes(9).toString('base64url'), exp: Date.now() + TICKET_MS,
  })).toString('base64url');
  return `${payload}.${sign(`2fa.${payload}`)}`;
}

function readTicket(ticket) {
  const [payload, sig] = String(ticket || '').split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(`2fa.${payload}`));
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
    'SELECT id, username, password_hash, active, role, totp_secret IS NOT NULL AS two_factor FROM users WHERE username = $1',
    [username],
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(req.ip);
    audit.log({ ...req, auditUser: username.slice(0, 100), ip: req.ip }, 'login_failed', 'users', '', 'كلمة مرور خاطئة');
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  if (!user.active) return res.status(403).json({ error: 'هذا الحساب موقوف، تواصل مع مدير النظام' });
  // الحساب عليه تحقق بخطوتين: لسه محتاج رمز التطبيق قبل الجلسة
  if (user.two_factor) return res.json({ twoFactor: true, ticket: createTicket(user) });
  return finishLogin(req, res, user, 'تسجيل دخول');
}

async function finishLogin(req, res, user, summary) {
  attempts.delete(req.ip);
  await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);
  audit.log({ user: { name: user.username }, ip: req.ip }, 'login', 'users', user.id, summary);
  setSessionCookie(res, createToken(user), config.sessionHours * 3600);
  // حساب الموظف يفتح على بوابة الموظف
  return res.json({ username: user.username, home: user.role === 'employee' ? '/portal.html' : '/' });
}

// الخطوة التانية: رمز التطبيق أو رمز احتياطي (5 محاولات لكل تذكرة)
async function loginTwoFactor(req, res) {
  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد ربع ساعة' });
  }
  const ticket = readTicket(req.body?.ticket);
  const fails = ticket ? ticketFails.get(ticket.n)?.count || 0 : 0;
  if (!ticket || fails >= 5) {
    return res.status(401).json({ error: 'انتهت مهلة التحقق، سجّل الدخول من جديد', expired: true });
  }
  const { rows } = await pool.query('SELECT id, username, active, role FROM users WHERE id = $1', [ticket.uid]);
  const user = rows[0];
  if (!user?.active) return res.status(401).json({ error: 'انتهت مهلة التحقق، سجّل الدخول من جديد', expired: true });
  const result = await require('./twofactor').verifyUserCode(user.id, req.body?.code);
  if (!result.ok) {
    for (const [k, v] of ticketFails) if (v.exp < Date.now()) ticketFails.delete(k);
    ticketFails.set(ticket.n, { count: fails + 1, exp: ticket.exp });
    recordFailure(req.ip);
    audit.log({ auditUser: user.username, ip: req.ip }, 'login_failed', 'users', user.id, 'رمز تحقق خاطئ');
    return res.status(401).json({ error: 'رمز التحقق غير صحيح', left: 4 - fails });
  }
  ticketFails.set(ticket.n, { count: 5, exp: ticket.exp }); // التذكرة ما تتستخدمش تاني
  return finishLogin(req, res, user, result.method === 'recovery'
    ? `تسجيل دخول برمز احتياطي (باقي ${result.left})` : 'تسجيل دخول بالتحقق بخطوتين');
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
  const { rows } = await pool.query(`SELECT u.id, u.username, u.full_name, u.role, u.active, u.branch_id, b.name AS branch_name,
       u.totp_secret IS NOT NULL AS two_factor, u.employee_id
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
    twoFactor: Boolean(user.two_factor),
    employeeId: user.employee_id ? String(user.employee_id) : null,
  };
  return next();
}

module.exports = { hashPassword, verifyPassword, createToken, readToken, login, loginTwoFactor, logout, requireAuth, forgetUser };
