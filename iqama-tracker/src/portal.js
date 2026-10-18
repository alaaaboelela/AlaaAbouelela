// بوابة الموظف: الموظف يدخل بحساب مربوط بملفه، ويشوف بياناته بس (الإقامة والمستندات والإجازات والسلف والعهد)
// ويقدّم طلب إجازة يوصل لشؤون الموظفين "بانتظار الاعتماد"
const path = require('path');
const express = require('express');
const { pool, getAlertDays, getSetting } = require('./db');
const { today } = require('./residencies');
const { UPLOAD_DIR } = require('./crud');
const { gregorianToHijri } = require('../public/hijri');
const { MODULES } = require('./modules');
const audit = require('./audit');

const router = express.Router();
const PHOTO_DIR = path.join(UPLOAD_DIR, 'photos');
const PHOTO_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const LEAVE_TYPES = MODULES.leaves.fields.find((f) => f.name === 'leave_type').options;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && gregorianToHijri(String(v)) !== null;
const statusOf = (days, alertDays) => (days < 0 ? 'expired' : days <= alertDays ? 'expiring' : 'valid');

// كل مسارات البوابة لحساب موظف مربوط بملف فقط
router.use('/portal', async (req, res, next) => {
  if (req.user.role !== 'employee' || !req.user.employeeId) {
    return res.status(403).json({ error: 'بوابة الموظف لحسابات الموظفين فقط' });
  }
  // الموظف اللي ترك العمل ما يدخلش البوابة
  const { rows } = await pool.query('SELECT employment_status FROM residencies WHERE id = $1', [req.user.employeeId]);
  if (rows[0]?.employment_status !== 'active') {
    return res.status(403).json({ error: 'ملفك غير نشط، تواصل مع شؤون الموظفين' });
  }
  return next();
});

router.get('/portal', async (req, res) => {
  const id = req.user.employeeId;
  const t = today();
  const alertDays = await getAlertDays();
  const { rows: [e] } = await pool.query(
    `SELECT e.name, e.iqama_number, e.expiry_date, e.nationality, e.phone, e.employer, e.annual_leave_days, e.photo,
       (e.expiry_date - $2::date) AS days_left, b.name AS branch
     FROM residencies e LEFT JOIN branches b ON b.id = e.branch_id WHERE e.id = $1`, [id, t]);
  if (!e) return res.status(404).json({ error: 'ملف الموظف غير موجود، تواصل مع شؤون الموظفين' });
  const [docs, visas, leaves, used, advances, custody] = await Promise.all([
    pool.query(`SELECT doc_type, doc_number, expiry_date, (expiry_date - $2::date) AS days_left
      FROM employee_docs WHERE employee_id = $1 ORDER BY expiry_date`, [id, t]),
    pool.query(`SELECT visa_type, departure_date, return_deadline, actual_return_date, destination
      FROM visas WHERE employee_id = $1 ORDER BY COALESCE(departure_date, return_deadline) DESC LIMIT 10`, [id]),
    pool.query(`SELECT id::text AS id, leave_type, start_date, end_date, (end_date - start_date + 1) AS days, approval, notes, created_at
      FROM leaves WHERE employee_id = $1 ORDER BY start_date DESC, id DESC LIMIT 30`, [id]),
    pool.query(`SELECT COALESCE(sum(end_date - start_date + 1), 0)::int AS n FROM leaves
      WHERE employee_id = $1 AND leave_type = 'سنوية' AND approval = 'معتمدة' AND extract(year FROM start_date) = extract(year FROM $2::date)`, [id, t]),
    pool.query(`SELECT t.amount::float AS amount, t.issue_date, t.monthly_installment::float AS installment,
        COALESCE((SELECT sum(p.amount) FROM advance_payments p WHERE p.advance_id = t.id), 0)::float AS paid
      FROM advances t WHERE t.employee_id = $1 ORDER BY t.issue_date DESC`, [id]),
    pool.query(`SELECT item_name, category, serial_number, quantity, handed_date FROM custody
      WHERE employee_id = $1 AND returned_date IS NULL ORDER BY handed_date DESC`, [id]),
  ]);
  return res.json({
    company: (await getSetting('company_name')) || '',
    today: t,
    employee: {
      name: e.name,
      iqamaNumber: e.iqama_number,
      expiryDate: e.expiry_date,
      expiryHijri: gregorianToHijri(e.expiry_date),
      daysLeft: e.days_left,
      status: statusOf(e.days_left, alertDays),
      nationality: e.nationality,
      phone: e.phone,
      employer: e.employer,
      branch: e.branch || '',
      photo: Boolean(e.photo),
    },
    docs: docs.rows.map((d) => ({
      type: d.doc_type, number: d.doc_number, expiryDate: d.expiry_date, daysLeft: d.days_left, status: statusOf(d.days_left, alertDays),
    })),
    visas: visas.rows.map((v) => ({
      type: v.visa_type, departure: v.departure_date, deadline: v.return_deadline, returned: v.actual_return_date, destination: v.destination,
    })),
    leave: {
      entitlement: e.annual_leave_days,
      used: used.rows[0].n,
      balance: e.annual_leave_days - used.rows[0].n,
      types: LEAVE_TYPES,
      requests: leaves.rows.map((l) => ({
        id: l.id, type: l.leave_type, start: l.start_date, end: l.end_date, days: l.days, approval: l.approval, notes: l.notes,
      })),
    },
    advances: advances.rows.map((a) => ({ ...a, remaining: Math.round((a.amount - a.paid) * 100) / 100 })),
    custody: custody.rows.map((c) => ({ item: c.item_name, category: c.category, serial: c.serial_number, quantity: c.quantity, handed: c.handed_date })),
  });
});

router.get('/portal/photo', async (req, res) => {
  const { rows } = await pool.query('SELECT photo FROM residencies WHERE id = $1', [req.user.employeeId]);
  const photo = rows[0]?.photo;
  if (!photo) return res.status(404).end();
  res.setHeader('Content-Type', PHOTO_MIME[path.extname(photo)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  return res.sendFile(path.join(PHOTO_DIR, path.basename(photo)), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// طلب إجازة جديد ← "معلقة" لحد ما شؤون الموظفين تعتمده
router.post('/portal/leaves', async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  const start = String(b.start || '');
  const end = String(b.end || '');
  const reason = String(b.reason || '').trim().slice(0, 500);
  const errors = [];
  if (!LEAVE_TYPES.includes(type)) errors.push('اختر نوع الإجازة');
  if (!isDate(start) || !isDate(end)) errors.push('تاريخ البداية والنهاية مطلوبين');
  else if (end < start) errors.push('تاريخ النهاية قبل تاريخ البداية');
  else if ((Date.parse(end) - Date.parse(start)) / 86400000 > 365) errors.push('مدة الإجازة طويلة جدًا');
  if (errors.length) return res.status(400).json({ error: errors.join('، ') });
  const { rows: overlap } = await pool.query(
    `SELECT 1 FROM leaves WHERE employee_id = $1 AND approval <> 'مرفوضة' AND start_date <= $3::date AND end_date >= $2::date LIMIT 1`,
    [req.user.employeeId, start, end]);
  if (overlap.length) return res.status(409).json({ error: 'عندك طلب إجازة تاني في نفس الفترة' });
  const { rows } = await pool.query(
    `INSERT INTO leaves (employee_id, leave_type, start_date, end_date, approval, notes)
     VALUES ($1, $2, $3, $4, 'معلقة', $5) RETURNING id::text AS id`,
    [req.user.employeeId, type, start, end, `طلب من بوابة الموظف${reason ? `: ${reason}` : ''}`]);
  audit.log(req, 'create', 'leaves', rows[0].id, `طلب إجازة ${type} من بوابة الموظف (${start} ← ${end})`);
  return res.status(201).json({ id: rows[0].id });
});

// إلغاء طلب لسه ما اتراجعش
router.delete('/portal/leaves/:id', async (req, res) => {
  const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : null;
  const { rows } = await pool.query(
    `DELETE FROM leaves WHERE id = $1 AND employee_id = $2 AND approval = 'معلقة' RETURNING leave_type`,
    [id, req.user.employeeId]);
  if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود أو اتراجع بالفعل' });
  audit.log(req, 'delete', 'leaves', id, `إلغاء طلب إجازة ${rows[0].leave_type} من بوابة الموظف`);
  return res.status(204).end();
});

module.exports = { router };
