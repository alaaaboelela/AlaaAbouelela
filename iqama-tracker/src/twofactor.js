// التحقق بخطوتين (TOTP): رمز من 6 أرقام يتغير كل 30 ثانية من تطبيق على الجوال
// (Google Authenticator أو Microsoft Authenticator أو أي تطبيق مشابه)، مع رموز احتياطية لو الجوال ضاع.
const crypto = require('crypto');
const express = require('express');
const qrcode = require('qrcode-generator');
const { pool } = require('./db');
const { verifyPassword, forgetUser } = require('./auth');
const { can } = require('./permissions');
const audit = require('./audit');

const ISSUER = 'منصة الإقامات';
const STEP = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

const counterNow = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/** يرجّع رقم الخطوة لو الرمز صحيح (±30 ثانية لفرق الساعة) وأحدث من آخر رمز اتستخدم، وإلا null */
function checkTotp(secret, code, lastCounter = -1, now = Date.now()) {
  const c = String(code || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
  if (c.length !== 6) return null;
  const base = counterNow(now);
  for (const n of [base, base - 1, base + 1]) {
    if (n <= lastCounter) continue;
    const expected = Buffer.from(hotp(secret, n));
    if (crypto.timingSafeEqual(expected, Buffer.from(c))) return n;
  }
  return null;
}

// ---------- الرموز الاحتياطية: تُعرض مرة واحدة ويُحفظ منها البصمة فقط ----------

const hashCode = (code) => crypto.createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = base32(crypto.randomBytes(5)).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
}

/**
 * التحقق من رمز الدخول (رمز التطبيق أو رمز احتياطي) وتحديث المستخدم:
 * رمز التطبيق ما يتقبلش مرتين، والرمز الاحتياطي يُشطب بعد استخدامه
 */
async function verifyUserCode(userId, code) {
  const { rows } = await pool.query('SELECT totp_secret, totp_last, recovery_codes FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u?.totp_secret) return { ok: false };
  const counter = checkTotp(u.totp_secret, code, u.totp_last == null ? -1 : Number(u.totp_last));
  if (counter != null) {
    // الشرط في الـ UPDATE يمنع استخدام نفس الرمز في طلبين متزامنين
    const r = await pool.query('UPDATE users SET totp_last = $2 WHERE id = $1 AND (totp_last IS NULL OR totp_last < $2)', [userId, counter]);
    return { ok: r.rowCount > 0, method: 'totp' };
  }
  const list = JSON.parse(u.recovery_codes || '[]');
  const h = hashCode(String(code || ''));
  if (String(code || '').replace(/[^a-z0-9]/gi, '').length === 8 && list.includes(h)) {
    const left = list.filter((x) => x !== h);
    const r = await pool.query('UPDATE users SET recovery_codes = $2 WHERE id = $1 AND recovery_codes = $3',
      [userId, JSON.stringify(left), u.recovery_codes]);
    return { ok: r.rowCount > 0, method: 'recovery', left: left.length };
  }
  return { ok: false };
}

function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// ---------- المسارات (للمستخدم الحالي) ----------

const router = express.Router();

async function checkPassword(req) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  return rows[0] && verifyPassword(String(req.body?.password || ''), rows[0].password_hash);
}

router.get('/me/2fa', async (req, res) => {
  const { rows } = await pool.query('SELECT totp_secret IS NOT NULL AS enabled, recovery_codes FROM users WHERE id = $1', [req.user.id]);
  res.json({ enabled: rows[0].enabled, recoveryLeft: rows[0].enabled ? JSON.parse(rows[0].recovery_codes || '[]').length : 0 });
});

// الخطوة 1: سر جديد مؤقت + QR (بكلمة المرور الحالية)
router.post('/me/2fa/setup', async (req, res) => {
  if (!(await checkPassword(req))) return res.status(400).json({ error: 'كلمة المرور غير صحيحة' });
  const secret = base32(crypto.randomBytes(20));
  await pool.query('UPDATE users SET totp_pending = $2 WHERE id = $1', [req.user.id, secret]);
  const label = `${ISSUER}:${req.user.name}`;
  const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${STEP}`;
  res.json({ secret: secret.match(/.{1,4}/g).join(' '), uri, qr: qrSvg(uri) });
});

// الخطوة 2: تأكيد أول رمز من التطبيق ← التفعيل والرموز الاحتياطية
router.post('/me/2fa/enable', async (req, res) => {
  const { rows } = await pool.query('SELECT totp_pending FROM users WHERE id = $1', [req.user.id]);
  const secret = rows[0]?.totp_pending;
  if (!secret) return res.status(400).json({ error: 'ابدأ الإعداد من جديد' });
  const counter = checkTotp(secret, req.body?.code);
  if (counter == null) return res.status(400).json({ error: 'الرمز غير صحيح، تأكد من وقت الجوال وجرب الرمز الجديد' });
  const codes = newRecoveryCodes();
  await pool.query(
    'UPDATE users SET totp_secret = $2, totp_pending = NULL, totp_last = $3, recovery_codes = $4 WHERE id = $1',
    [req.user.id, secret, counter, JSON.stringify(codes.map(hashCode))]);
  forgetUser(req.user.id);
  audit.log(req, 'settings', 'users', req.user.id, 'تفعيل التحقق بخطوتين');
  res.json({ enabled: true, recoveryCodes: codes });
});

router.post('/me/2fa/disable', async (req, res) => {
  if (!(await checkPassword(req))) return res.status(400).json({ error: 'كلمة المرور غير صحيحة' });
  if (!(await verifyUserCode(req.user.id, req.body?.code)).ok) return res.status(400).json({ error: 'رمز التحقق غير صحيح' });
  await pool.query('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last = NULL, recovery_codes = NULL WHERE id = $1', [req.user.id]);
  forgetUser(req.user.id);
  audit.log(req, 'settings', 'users', req.user.id, 'إيقاف التحقق بخطوتين');
  res.json({ enabled: false });
});

router.post('/me/2fa/recovery', async (req, res) => {
  if (!(await checkPassword(req))) return res.status(400).json({ error: 'كلمة المرور غير صحيحة' });
  const codes = newRecoveryCodes();
  const r = await pool.query('UPDATE users SET recovery_codes = $2 WHERE id = $1 AND totp_secret IS NOT NULL', [req.user.id, JSON.stringify(codes.map(hashCode))]);
  if (!r.rowCount) return res.status(400).json({ error: 'التحقق بخطوتين غير مفعّل' });
  audit.log(req, 'settings', 'users', req.user.id, 'إنشاء رموز احتياطية جديدة للتحقق بخطوتين');
  res.json({ recoveryCodes: codes });
});

// مدير النظام يلغي التحقق بخطوتين لمستخدم ضاع جواله
router.post('/users/:id/2fa/reset', async (req, res) => {
  if (!can(req.user, 'users', 'write')) return res.status(403).json({ error: 'ليس لديك صلاحية' });
  const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : null;
  const { rows } = await pool.query(
    `UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last = NULL, recovery_codes = NULL
     WHERE id = $1 RETURNING username`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
  forgetUser(id);
  audit.log(req, 'settings', 'users', id, `إلغاء التحقق بخطوتين للمستخدم ${rows[0].username}`);
  return res.json({ ok: true });
});

module.exports = { router, verifyUserCode, checkTotp, hotp, base32, unbase32, hashCode, newRecoveryCodes };
