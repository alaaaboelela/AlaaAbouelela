const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

// إرجاع أعمدة DATE كنص "YYYY-MM-DD" بدل كائن Date لتجنب مشاكل فرق التوقيت
types.setTypeParser(1082, (v) => v);
// أعمدة NUMERIC (المبالغ) كأرقام
types.setTypeParser(1700, (v) => Number.parseFloat(v));

const pool = new Pool({ connectionString: config.databaseUrl });

async function migrate() {
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
