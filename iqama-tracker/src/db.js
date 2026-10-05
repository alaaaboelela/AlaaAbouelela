const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

// إرجاع أعمدة DATE كنص "YYYY-MM-DD" بدل كائن Date لتجنب مشاكل فرق التوقيت
types.setTypeParser(1082, (v) => v);
// أعمدة NUMERIC (المبالغ) كأرقام
types.setTypeParser(1700, (v) => Number.parseFloat(v));

const pool = new Pool({ connectionString: config.databaseUrl });

// إنشاء قاعدة البيانات تلقائيًا إن لم تكن موجودة (بدون الحاجة لـ psql)
async function ensureDatabase() {
  try {
    const client = await pool.connect();
    client.release();
  } catch (err) {
    if (err.code !== '3D000') throw err;
    const url = new URL(config.databaseUrl);
    const name = decodeURIComponent(url.pathname.slice(1));
    url.pathname = '/postgres';
    const { Client } = require('pg');
    const admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`تم إنشاء قاعدة البيانات: ${name}`);
    } finally {
      await admin.end();
    }
  }
}

async function migrate() {
  await ensureDatabase();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function getAlertDays() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'alert_days'");
  return rows.length ? Number(rows[0].value) : 30;
}

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)],
  );
}

module.exports = { pool, migrate, getAlertDays, getSetting, setSetting };

// رسالة واضحة لأخطاء الاتصال بقاعدة البيانات
function describeDbError(err) {
  const inner = err.errors?.[0] || err;
  const code = inner.code || err.code;
  if (code === 'ECONNREFUSED') {
    return 'PostgreSQL غير شغال أو يعمل على بورت مختلف. شغّلي خدمة PostgreSQL وتأكدي من البورت في DATABASE_URL';
  }
  if (code === '28P01') return 'كلمة مرور قاعدة البيانات غير صحيحة (راجعي DATABASE_URL في ملف .env)';
  if (code === '3D000') return 'قاعدة البيانات غير موجودة، أنشئيها بالأمر: CREATE DATABASE iqama;';
  if (code === 'ENOTFOUND') return 'عنوان خادم قاعدة البيانات غير صحيح';
  return `${inner.message || err.message || 'خطأ غير معروف'}${code ? ` (${code})` : ''}`;
}

module.exports.describeDbError = describeDbError;
