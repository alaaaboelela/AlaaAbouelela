// خادم بسيط لإدارة الإقامات وتنبيهات قرب انتهائها
// بدون أي مكتبات خارجية: Node.js فقط (الإصدار 18 أو أحدث)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'residencies.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_SETTINGS = { alertDays: 30 };

// ---------- التخزين ----------

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      residencies: Array.isArray(db.residencies) ? db.residencies : [],
      settings: { ...DEFAULT_SETTINGS, ...db.settings },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('تعذر قراءة ملف البيانات:', err.message);
    return { residencies: [], settings: { ...DEFAULT_SETTINGS } };
  }
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- منطق الحالة ----------

function todayUtc() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysLeft(expiryDate) {
  const [y, m, d] = expiryDate.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - todayUtc()) / 86400000);
}

function withStatus(r, alertDays) {
  const left = daysLeft(r.expiryDate);
  let status = 'valid';
  if (left < 0) status = 'expired';
  else if (left <= alertDays) status = 'expiring';
  return { ...r, daysLeft: left, status };
}

function validate(body) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const iqamaNumber = typeof body.iqamaNumber === 'string' ? body.iqamaNumber.trim() : '';
  const expiryDate = typeof body.expiryDate === 'string' ? body.expiryDate.trim() : '';

  if (!name) errors.push('الاسم مطلوب');
  if (!iqamaNumber) errors.push('رقم الإقامة مطلوب');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) || Number.isNaN(Date.parse(expiryDate))) {
    errors.push('تاريخ الانتهاء غير صحيح');
  }

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    errors,
    value: {
      name,
      iqamaNumber,
      expiryDate,
      nationality: str(body.nationality),
      phone: str(body.phone),
      employer: str(body.employer),
      notes: str(body.notes),
    },
  };
}

// ---------- أدوات HTTP ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('الطلب كبير جدا'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON غير صالح'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'ممنوع' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'غير موجود' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- المسارات ----------

async function handleApi(req, res, pathname) {
  const db = loadDb();
  const alertDays = db.settings.alertDays;
  const idMatch = pathname.match(/^\/api\/residencies\/([\w-]+)$/);

  if (pathname === '/api/residencies' && req.method === 'GET') {
    const list = db.residencies
      .map((r) => withStatus(r, alertDays))
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return sendJson(res, 200, list);
  }

  if (pathname === '/api/residencies' && req.method === 'POST') {
    const { errors, value } = validate(await readBody(req));
    if (errors.length) return sendJson(res, 400, { error: errors.join('، ') });
    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), ...value, createdAt: now, updatedAt: now };
    db.residencies.push(record);
    saveDb(db);
    return sendJson(res, 201, withStatus(record, alertDays));
  }

  if (idMatch) {
    const index = db.residencies.findIndex((r) => r.id === idMatch[1]);
    if (index === -1) return sendJson(res, 404, { error: 'الإقامة غير موجودة' });

    if (req.method === 'GET') return sendJson(res, 200, withStatus(db.residencies[index], alertDays));

    if (req.method === 'PUT') {
      const { errors, value } = validate(await readBody(req));
      if (errors.length) return sendJson(res, 400, { error: errors.join('، ') });
      const record = { ...db.residencies[index], ...value, updatedAt: new Date().toISOString() };
      db.residencies[index] = record;
      saveDb(db);
      return sendJson(res, 200, withStatus(record, alertDays));
    }

    if (req.method === 'DELETE') {
      db.residencies.splice(index, 1);
      saveDb(db);
      res.writeHead(204);
      return res.end();
    }
  }

  // الإقامات المنتهية أو التي ستنتهي خلال فترة التنبيه
  if (pathname === '/api/alerts' && req.method === 'GET') {
    const alerts = db.residencies
      .map((r) => withStatus(r, alertDays))
      .filter((r) => r.status !== 'valid')
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return sendJson(res, 200, { alertDays, count: alerts.length, alerts });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, db.settings);
  }

  if (pathname === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    const days = Number(body.alertDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return sendJson(res, 400, { error: 'عدد أيام التنبيه يجب أن يكون بين 1 و 365' });
    }
    db.settings.alertDays = days;
    saveDb(db);
    return sendJson(res, 200, db.settings);
  }

  return sendJson(res, 404, { error: 'المسار غير موجود' });
}

// تنبيه في سجل الخادم عند التشغيل ثم كل 24 ساعة
function logAlerts() {
  const db = loadDb();
  const alerts = db.residencies
    .map((r) => withStatus(r, db.settings.alertDays))
    .filter((r) => r.status !== 'valid');
  if (!alerts.length) return;
  console.log(`\n⚠️  تنبيه: ${alerts.length} إقامة منتهية أو قريبة من الانتهاء`);
  for (const r of alerts) {
    const msg = r.daysLeft < 0 ? `منتهية منذ ${-r.daysLeft} يوم` : `متبقي ${r.daysLeft} يوم`;
    console.log(`   - ${r.name} (${r.iqamaNumber}): ${msg}`);
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`نظام الإقامات يعمل على http://localhost:${PORT}`);
    logAlerts();
    setInterval(logAlerts, 24 * 60 * 60 * 1000);
  });
}

module.exports = { server, daysLeft, withStatus, validate };
