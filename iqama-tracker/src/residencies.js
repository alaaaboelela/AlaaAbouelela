const express = require('express');
const { pool, getAlertDays, setSetting } = require('./db');
const { toCsv } = require('./csv');
const { writeXlsx, readTable, parseDateCell, toLatinDigits } = require('./xlsx');
const { hijriToGregorian, gregorianToHijri } = require('../public/hijri');
const config = require('./config');
const audit = require('./audit');

const router = express.Router();

// تاريخ اليوم بتوقيت السعودية (YYYY-MM-DD)
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date());
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// يبني قائمة المعاملات ويرجع رمز $n لكل قيمة
function params() {
  const values = [];
  return { values, add: (v) => { values.push(v); return `$${values.length}`; } };
}

const columns = (todayParam) => `id, name, iqama_number, expiry_date, nationality, phone, employer, notes, annual_leave_days,
  created_at, updated_at, (expiry_date - ${todayParam}::date) AS days_left`;

const SORTS = {
  expiry: 'expiry_date ASC, id ASC',
  '-expiry': 'expiry_date DESC, id DESC',
  name: 'name ASC, id ASC',
  newest: 'created_at DESC, id DESC',
};

function statusOf(daysLeft, alertDays) {
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= alertDays) return 'expiring';
  return 'valid';
}

function toApi(row, alertDays) {
  return {
    id: String(row.id),
    name: row.name,
    iqamaNumber: row.iqama_number,
    expiryDate: row.expiry_date,
    expiryDateHijri: gregorianToHijri(row.expiry_date),
    nationality: row.nationality,
    phone: row.phone,
    employer: row.employer,
    notes: row.notes,
    annualLeaveDays: row.annual_leave_days,
    daysLeft: row.days_left,
    status: statusOf(row.days_left, alertDays),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// شرط SQL لكل حالة (كلها مقارنات على expiry_date فتستخدم الفهرس)
function statusCondition(status, p, alertDays) {
  const start = today();
  const end = addDays(start, alertDays);
  if (status === 'expired') return `expiry_date < ${p.add(start)}::date`;
  if (status === 'expiring') return `expiry_date BETWEEN ${p.add(start)}::date AND ${p.add(end)}::date`;
  if (status === 'valid') return `expiry_date > ${p.add(end)}::date`;
  return null;
}

const str = (v) => (v == null ? '' : String(v).trim());

// رقم الإقامة السعودية: 10 أرقام يبدأ بـ 2
function normalizeIqama(v) {
  return str(v).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\s|-/g, '');
}

function validate(body) {
  const errors = [];
  const name = str(body.name);
  const iqamaNumber = normalizeIqama(body.iqamaNumber);
  let expiryDate = str(body.expiryDate);
  const hijri = str(body.expiryDateHijri);

  if (!expiryDate && hijri) {
    expiryDate = hijriToGregorian(hijri) || '';
    if (!expiryDate) errors.push('تاريخ الانتهاء الهجري غير صحيح');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) || gregorianToHijri(expiryDate) === null) {
    errors.push('تاريخ الانتهاء غير صحيح');
  }
  if (!name) errors.push('الاسم مطلوب');
  if (name.length > 200) errors.push('الاسم طويل جدا');
  if (!/^2\d{9}$/.test(iqamaNumber)) errors.push('رقم الإقامة يجب أن يكون 10 أرقام ويبدأ بـ 2');
  const leaveRaw = str(body.annualLeaveDays);
  const annualLeaveDays = leaveRaw === '' ? 21 : Number(leaveRaw);
  if (!Number.isInteger(annualLeaveDays) || annualLeaveDays < 0 || annualLeaveDays > 365) errors.push('رصيد الإجازة السنوية غير صحيح');

  return {
    errors,
    value: {
      name,
      iqamaNumber,
      expiryDate,
      nationality: str(body.nationality).slice(0, 100),
      phone: str(body.phone).slice(0, 30),
      employer: str(body.employer).slice(0, 200),
      notes: str(body.notes).slice(0, 2000),
      annualLeaveDays,
    },
  };
}

function duplicateError(err, res) {
  if (err.code === '23505') {
    res.status(409).json({ error: 'رقم الإقامة مسجل من قبل' });
    return true;
  }
  return false;
}

// ---------- القائمة مع الصفحات والبحث والفلترة ----------

function buildWhere(query, p, alertDays) {
  const where = [];
  const status = statusCondition(query.status, p, alertDays);
  if (status) where.push(status);
  const q = str(query.q);
  if (q) {
    const like = p.add(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(name ILIKE ${like} OR iqama_number LIKE ${like} OR employer ILIKE ${like})`);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

router.get('/residencies', async (req, res) => {
  const alertDays = await getAlertDays();
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 50));
  const order = SORTS[req.query.sort] || SORTS.expiry;

  const countP = params();
  const countWhere = buildWhere(req.query, countP, alertDays);
  const listP = params();
  const listWhere = buildWhere(req.query, listP, alertDays);
  const todayParam = listP.add(today());

  const [list, count] = await Promise.all([
    pool.query(
      `SELECT ${columns(todayParam)} FROM residencies ${listWhere} ORDER BY ${order}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      listP.values,
    ),
    pool.query(`SELECT count(*)::int AS total FROM residencies ${countWhere}`, countP.values),
  ]);

  res.json({
    page,
    pageSize,
    total: count.rows[0].total,
    items: list.rows.map((r) => toApi(r, alertDays)),
  });
});

router.get('/stats', async (req, res) => {
  const alertDays = await getAlertDays();
  const p = params();
  const expired = statusCondition('expired', p, alertDays);
  const expiring = statusCondition('expiring', p, alertDays);
  const valid = statusCondition('valid', p, alertDays);
  const weekEnd = p.add(addDays(today(), 7));
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE ${expired})::int AS expired,
       count(*) FILTER (WHERE ${expiring})::int AS expiring,
       count(*) FILTER (WHERE ${valid})::int AS valid,
       count(*) FILTER (WHERE ${expiring} AND expiry_date <= ${weekEnd}::date)::int AS "withinWeek"
     FROM residencies`,
    p.values,
  );
  res.json({ alertDays, ...rows[0] });
});

// عدد الإقامات التي تنتهي في كل شهر من الأشهر الـ 12 القادمة
router.get('/stats/monthly', async (req, res) => {
  const monthStart = `${today().slice(0, 7)}-01`;
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(monthStart + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    months.push(d.toISOString().slice(0, 7));
  }
  const end = new Date(monthStart + 'T00:00:00Z');
  end.setUTCMonth(end.getUTCMonth() + 12);

  const { rows } = await pool.query(
    `SELECT to_char(expiry_date, 'YYYY-MM') AS month, count(*)::int AS count
     FROM residencies WHERE expiry_date >= $1::date AND expiry_date < $2::date
     GROUP BY 1`,
    [monthStart, end.toISOString().slice(0, 10)],
  );
  const counts = Object.fromEntries(rows.map((r) => [r.month, r.count]));
  res.json(months.map((month) => ({ month, count: counts[month] || 0 })));
});

// ---------- تصدير / استيراد ----------

const EXPORT_HEADER = ['الاسم', 'رقم الإقامة', 'تاريخ الانتهاء', 'تاريخ الانتهاء هجري', 'الجنسية', 'الجوال', 'جهة العمل',
  'رصيد الإجازة السنوية', 'ملاحظات', 'الأيام المتبقية', 'الحالة'];
const STATUS_LABELS = { expired: 'منتهية', expiring: 'قريبة من الانتهاء', valid: 'سارية' };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function exportRows(query) {
  const alertDays = await getAlertDays();
  const p = params();
  const where = buildWhere(query, p, alertDays);
  const todayParam = p.add(today());
  const { rows } = await pool.query(
    `SELECT ${columns(todayParam)} FROM residencies ${where} ORDER BY ${SORTS.expiry}`,
    p.values,
  );
  return rows.map((r) => [
    r.name, r.iqama_number, r.expiry_date, gregorianToHijri(r.expiry_date),
    r.nationality, r.phone, r.employer, r.annual_leave_days, r.notes, r.days_left, STATUS_LABELS[statusOf(r.days_left, alertDays)],
  ]);
}

router.get('/residencies/export.csv', async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="residencies.csv"');
  res.send(toCsv(EXPORT_HEADER, await exportRows(req.query)));
});

router.get('/residencies/export.xlsx', async (req, res) => {
  const rows = await exportRows(req.query);
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="residencies-${today()}.xlsx"; filename*=UTF-8''${encodeURIComponent(`الإقامات-${today()}.xlsx`)}`);
  res.send(writeXlsx([{ name: 'الإقامات', header: EXPORT_HEADER, rows }]));
});

router.get('/residencies/template.xlsx', (req, res) => {
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="residencies-template.xlsx"; filename*=UTF-8''${encodeURIComponent('نموذج-استيراد-الإقامات.xlsx')}`);
  res.send(writeXlsx([
    { name: 'الإقامات', header: ['الاسم', 'رقم الإقامة', 'تاريخ الانتهاء', 'الجنسية', 'الجوال', 'جهة العمل', 'رصيد الإجازة السنوية', 'ملاحظات'], rows: [] },
    {
      name: 'تعليمات',
      header: ['العمود', 'مطلوب', 'ملاحظات'],
      rows: [
        ['الاسم', 'نعم', ''],
        ['رقم الإقامة', 'نعم', '10 أرقام تبدأ بـ 2. لو الرقم موجود يتم تحديث بياناته بدل التكرار'],
        ['تاريخ الانتهاء', 'نعم', 'ميلادي (2026-12-31 أو 31/12/2026) أو هجري (1448-06-15)'],
        ['الجنسية', 'لا', ''], ['الجوال', 'لا', ''], ['جهة العمل', 'لا', ''],
        ['رصيد الإجازة السنوية', 'لا', 'عدد الأيام في السنة، الافتراضي 21'],
        ['ملاحظات', 'لا', ''],
      ],
    },
  ]));
});

// أسماء الأعمدة المقبولة في ملف الاستيراد (عربي أو إنجليزي)
const IMPORT_COLUMNS = {
  name: ['name', 'الاسم'],
  iqamaNumber: ['iqama_number', 'iqama', 'رقم الإقامة', 'رقم الاقامة'],
  expiryDate: ['expiry_date', 'تاريخ الانتهاء', 'تاريخ الانتهاء ميلادي'],
  expiryDateHijri: ['expiry_date_hijri', 'تاريخ الانتهاء هجري'],
  nationality: ['nationality', 'الجنسية'],
  phone: ['phone', 'الجوال', 'رقم الجوال'],
  employer: ['employer', 'جهة العمل', 'الكفيل'],
  notes: ['notes', 'ملاحظات'],
  annualLeaveDays: ['annual_leave_days', 'رصيد الإجازة السنوية', 'رصيد الإجازة'],
};

router.post('/residencies/import', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  let rows;
  try {
    rows = readTable(req.body);
  } catch {
    return res.status(400).json({ error: 'تعذر قراءة الملف، تأكدي أنه ملف Excel (xlsx) أو CSV' });
  }
  if (rows.length < 2) return res.status(400).json({ error: 'الملف فارغ أو بدون صف عناوين' });

  const header = rows[0].map((h) => String(h ?? '').trim().toLowerCase());
  const index = {};
  for (const [field, names] of Object.entries(IMPORT_COLUMNS)) {
    index[field] = header.findIndex((h) => names.includes(h));
  }
  if (index.name < 0 || index.iqamaNumber < 0 || (index.expiryDate < 0 && index.expiryDateHijri < 0)) {
    return res.status(400).json({ error: 'الملف يجب أن يحتوي أعمدة: الاسم، رقم الإقامة، تاريخ الانتهاء (ميلادي أو هجري)' });
  }

  const errors = [];
  const valid = new Map(); // آخر صف لكل رقم إقامة
  rows.slice(1).forEach((cells, i) => {
    const body = {};
    if (!cells.some((c) => str(c))) return; // صف فارغ
    for (const [field, col] of Object.entries(index)) if (col >= 0) body[field] = cells[col];
    body.iqamaNumber = toLatinDigits(body.iqamaNumber);
    // عمود التاريخ يقبل رقم Excel أو ميلادي أو هجري؛ لو فارغ نستخدم عمود الهجري
    body.expiryDate = parseDateCell(body.expiryDate);
    if (!str(body.expiryDate)) delete body.expiryDate;
    const { errors: e, value } = validate(body);
    if (e.length) errors.push({ line: i + 2, error: e.join('، ') });
    else valid.set(value.iqamaNumber, value);
  });

  let inserted = 0;
  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const records = [...valid.values()];
    for (let i = 0; i < records.length; i += 1000) {
      const { rows: result } = await client.query(
        `INSERT INTO residencies (name, iqama_number, expiry_date, nationality, phone, employer, notes, annual_leave_days)
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           name text, "iqamaNumber" text, "expiryDate" date, nationality text, phone text, employer text, notes text,
           "annualLeaveDays" int)
         ON CONFLICT (iqama_number) DO UPDATE SET
           name = EXCLUDED.name, expiry_date = EXCLUDED.expiry_date, nationality = EXCLUDED.nationality,
           phone = EXCLUDED.phone, employer = EXCLUDED.employer, notes = EXCLUDED.notes,
           annual_leave_days = CASE WHEN $2 THEN EXCLUDED.annual_leave_days ELSE residencies.annual_leave_days END,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [JSON.stringify(records.slice(i, i + 1000)), index.annualLeaveDays >= 0],
      );
      for (const r of result) if (r.inserted) inserted++; else updated++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  audit.log(req, 'import', 'residencies', '', `استيراد إقامات: إضافة ${inserted}، تحديث ${updated}، أخطاء ${errors.length}`);
  res.json({ inserted, updated, failed: errors.length, errors: errors.slice(0, 200) });
});

// ---------- عملية واحدة ----------

router.post('/residencies', async (req, res) => {
  const { errors, value } = validate(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('، ') });
  try {
    const { rows } = await pool.query(
      `INSERT INTO residencies (name, iqama_number, expiry_date, nationality, phone, employer, notes, annual_leave_days)
       VALUES ($2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${columns('$1')}`,
      [today(), value.name, value.iqamaNumber, value.expiryDate,
        value.nationality, value.phone, value.employer, value.notes, value.annualLeaveDays],
    );
    audit.log(req, 'create', 'residencies', rows[0].id, `إقامة: ${value.name} (${value.iqamaNumber})`);
    return res.status(201).json(toApi(rows[0], await getAlertDays()));
  } catch (err) {
    if (duplicateError(err, res)) return undefined;
    throw err;
  }
});

function parseId(req, res) {
  if (!/^\d{1,18}$/.test(req.params.id)) {
    res.status(404).json({ error: 'الإقامة غير موجودة' });
    return null;
  }
  return req.params.id;
}

router.get('/residencies/:id', async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const { rows } = await pool.query(`SELECT ${columns('$1')} FROM residencies WHERE id = $2`, [today(), id]);
  if (!rows.length) return res.status(404).json({ error: 'الإقامة غير موجودة' });
  res.json(toApi(rows[0], await getAlertDays()));
});

router.put('/residencies/:id', async (req, res) => {
  const id = parseId(req, res);
  if (!id) return undefined;
  const { errors, value } = validate(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('، ') });
  const { rows: [before] } = await pool.query('SELECT * FROM residencies WHERE id = $1', [id]);
  try {
    const { rows } = await pool.query(
      `UPDATE residencies SET name = $3, iqama_number = $4, expiry_date = $5, nationality = $6,
         phone = $7, employer = $8, notes = $9, annual_leave_days = $10, updated_at = now()
       WHERE id = $2 RETURNING ${columns('$1')}`,
      [today(), id, value.name, value.iqamaNumber, value.expiryDate,
        value.nationality, value.phone, value.employer, value.notes, value.annualLeaveDays],
    );
    if (!rows.length) return res.status(404).json({ error: 'الإقامة غير موجودة' });
    audit.log(req, 'update', 'residencies', id, `إقامة: ${value.name} (${value.iqamaNumber})`, audit.diff(before, {
      name: value.name, iqama_number: value.iqamaNumber, expiry_date: value.expiryDate, nationality: value.nationality,
      phone: value.phone, employer: value.employer, notes: value.notes, annual_leave_days: value.annualLeaveDays,
    }, { name: 'الاسم', iqama_number: 'رقم الإقامة', expiry_date: 'تاريخ الانتهاء', nationality: 'الجنسية', phone: 'الجوال', employer: 'جهة العمل', notes: 'ملاحظات', annual_leave_days: 'رصيد الإجازة' }));
    return res.json(toApi(rows[0], await getAlertDays()));
  } catch (err) {
    if (duplicateError(err, res)) return undefined;
    throw err;
  }
});

router.delete('/residencies/:id', async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  let rowCount;
  const { rows: [existing] } = await pool.query('SELECT name, iqama_number FROM residencies WHERE id = $1', [id]);
  try {
    ({ rowCount } = await pool.query('DELETE FROM residencies WHERE id = $1', [id]));
  } catch (err) {
    if (err.code === '23503' || err.code === '23001') {
      return res.status(409).json({ error: 'لا يمكن حذف الموظف لوجود سلف أو عهد مسجلة عليه' });
    }
    throw err;
  }
  if (!rowCount) return res.status(404).json({ error: 'الإقامة غير موجودة' });
  await require('./crud').deleteDocuments('residencies', id);
  audit.log(req, 'delete', 'residencies', id, `إقامة: ${existing.name} (${existing.iqama_number})`);
  return res.status(204).end();
});

// ---------- الإعدادات ----------

router.get('/settings', async (req, res) => {
  res.json({ alertDays: await getAlertDays() });
});

router.put('/settings', async (req, res) => {
  const days = Number(req.body?.alertDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return res.status(400).json({ error: 'عدد أيام التنبيه يجب أن يكون بين 1 و 365' });
  }
  const old = await getAlertDays();
  await setSetting('alert_days', days);
  audit.log(req, 'settings', 'settings', '', `مدة التنبيه: ${old} ← ${days} يوم`);
  return res.json({ alertDays: days });
});

module.exports = { router, validate, statusOf, statusCondition, columns, params, today, addDays, toApi };
