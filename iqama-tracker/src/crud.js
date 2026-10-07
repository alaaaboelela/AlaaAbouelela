// محرك عام يبني الـ API لكل قسم معرّف في modules.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, getAlertDays } = require('./db');
const { MODULES, publicSchema } = require('./modules');
const { params, today, addDays } = require('./residencies');
const config = require('./config');
const audit = require('./audit');
const { can } = require('./permissions');
const { writeXlsx, readTable, parseDateCell, toLatinDigits } = require('./xlsx');

const router = express.Router();
const str = (v) => (v == null ? '' : String(v).trim());

// ---------- التحقق من الحقول ----------

function validateFields(fields, body) {
  const errors = [];
  const values = {};
  for (const f of fields) {
    const raw = body[f.name];
    const s = str(raw);
    let v;
    switch (f.type) {
      case 'date':
        v = s || null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${f.label}: تاريخ غير صحيح`);
        break;
      case 'money':
      case 'int': {
        if (s === '') { v = f.default ?? null; break; }
        v = Number(s.replace(/,/g, ''));
        if (!Number.isFinite(v) || v < 0) { errors.push(`${f.label}: رقم غير صحيح`); break; }
        if (f.type === 'int' && !Number.isInteger(v)) errors.push(`${f.label}: يجب أن يكون رقمًا صحيحًا`);
        if (f.positive && v <= 0) errors.push(`${f.label}: يجب أن يكون أكبر من صفر`);
        if (f.min != null && v < f.min) errors.push(`${f.label}: أقل قيمة ${f.min}`);
        if (f.max != null && v > f.max) errors.push(`${f.label}: أكبر قيمة ${f.max}`);
        if (f.type === 'money') v = Math.round(v * 100) / 100;
        break;
      }
      case 'rating':
        v = s === '' ? null : Number(s);
        if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 5)) errors.push(`${f.label}: التقييم من 1 إلى 5`);
        break;
      case 'employee':
      case 'branch':
        v = s || null;
        if (v && !/^\d{1,18}$/.test(v)) errors.push(`${f.label}: اختيار غير صحيح`);
        break;
      case 'select':
        v = s || (f.default ?? '');
        if (v && !f.options.includes(v)) errors.push(`${f.label}: اختيار غير صحيح`);
        break;
      default:
        v = s.slice(0, f.type === 'textarea' ? 2000 : 200);
    }
    if (f.required && (v === null || v === '')) errors.push(`${f.label} مطلوب`);
    values[f.name] = v;
  }
  return { errors, values };
}

function dbError(err, res) {
  if (err.code === '23505') return res.status(409).json({ error: 'القيمة مسجلة من قبل (مكررة)' });
  if (err.code === '23503' || err.code === '23001') {
    return res.status(409).json({ error: 'لا يمكن الحذف أو الحفظ لوجود بيانات مرتبطة (مثل موظفين أو سلف أو عهد)' });
  }
  if (err.code === '23514') return res.status(400).json({ error: 'قيمة غير مسموح بها' });
  throw err;
}

const parseId = (v) => (/^\d{1,18}$/.test(String(v)) ? String(v) : null);

// ---------- بناء الاستعلامات ----------

// الفرع الحالي يأتي من req.branch (يحدده server.js)؛ بدون req = كل الفروع
async function context(req) {
  const alertDays = await getAlertDays();
  const t = today();
  return { today: t, alertEnd: addDays(t, alertDays), alertDays, branch: req?.branch || null };
}

function inner(m, base, { q, id } = {}) {
  const p = params();
  const ctx = { ...base, p };
  const where = [];
  if (id) where.push(`t.id = ${p.add(id)}`);
  if (base.branch) where.push(`${m.branch} = ${p.add(base.branch)}`);
  if (q) {
    const like = p.add(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(${m.search.map((c) => `${c} ILIKE ${like}`).join(' OR ')})`);
  }
  const sql = `SELECT t.*, ${m.extra(ctx)}, ${m.status(ctx)} AS status
    FROM ${m.from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return { sql, p, where };
}

async function getOne(m, id, req) {
  const { sql, p } = inner(m, await context(req), { id });
  const { rows } = await pool.query(sql, p.values);
  return rows[0] || null;
}

async function counts(m, base, q) {
  const { sql, p } = inner(m, base, { q });
  const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM (${sql}) x GROUP BY status`, p.values);
  const out = Object.fromEntries(Object.keys(m.statuses).map((k) => [k, 0]));
  for (const r of rows) out[r.status] = r.n;
  out.total = rows.reduce((s, r) => s + r.n, 0);
  return out;
}

async function totals(m, base) {
  if (!m.totals) return null;
  const exprs = Object.entries(m.totals).map(([k, e]) => `COALESCE(${e}, 0) AS "${k}"`).join(', ');
  const scoped = base?.branch;
  const { rows } = await pool.query(`SELECT ${exprs} FROM ${m.from}${scoped ? ` WHERE ${m.branch} = $1` : ''}`, scoped ? [scoped] : []);
  return rows[0];
}

// قواعد الفرع عند الحفظ: المستخدم المربوط بفرع يحفظ في فرعه دائمًا،
// والسجل الجديد بدون فرع يأخذ الفرع المختار حاليًا
function applyBranch(m, values, req, isNew) {
  if (!m.fields.some((f) => f.type === 'branch')) return;
  if (req.branchLocked) values.branch_id = req.branch;
  else if (isNew && !values.branch_id && req.branch) values.branch_id = req.branch;
}

// الموظفون المختارون لازم يكونوا من نفس الفرع الحالي
async function employeesOutsideBranch(m, values, req) {
  if (!req.branch) return [];
  const fields = m.fields.filter((f) => f.type === 'employee' && values[f.name]);
  if (!fields.length) return [];
  const { rows } = await pool.query('SELECT id FROM residencies WHERE id = ANY($1::bigint[]) AND branch_id = $2',
    [fields.map((f) => values[f.name]), req.branch]);
  const ok = new Set(rows.map((x) => String(x.id)));
  return fields.filter((f) => !ok.has(String(values[f.name]))).map((f) => `${f.label}: الموظف غير موجود في هذا الفرع`);
}

// ---------- المستندات ----------

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 20;
const ALLOWED = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const DOC_ENTITIES = { ...Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [k, m.table])), residencies: 'residencies' };

// السجل موجود وضمن فرع المستخدم
async function entityVisible(type, id, req) {
  if (!DOC_ENTITIES[type] || !parseId(id)) return false;
  if (type === 'residencies') {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM residencies WHERE id = $1 AND ($2::bigint IS NULL OR branch_id = $2::bigint)', [id, req.branch || null]);
    return rowCount > 0;
  }
  return Boolean(await getOne(MODULES[type], id, req));
}

async function deleteDocuments(type, id) {
  const { rows } = await pool.query(
    'DELETE FROM documents WHERE entity_type = $1 AND entity_id = $2 RETURNING stored_name',
    [type, id],
  );
  await Promise.all(rows.map((r) => fs.promises.unlink(path.join(UPLOAD_DIR, r.stored_name)).catch(() => {})));
}

const docColumns = 'id, entity_type, entity_id, title, original_name, mime_type, size_bytes, uploaded_by, created_at';

router.get('/documents', async (req, res) => {
  const { entity, id } = req.query;
  if (!DOC_ENTITIES[entity] || !parseId(id)) return res.status(400).json({ error: 'طلب غير صحيح' });
  if (!(await entityVisible(entity, id, req))) return res.status(404).json({ error: 'السجل غير موجود' });
  const { rows } = await pool.query(
    `SELECT ${docColumns} FROM documents WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC`,
    [entity, id],
  );
  return res.json(rows);
});

router.post(
  '/documents',
  express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }),
  async (req, res) => {
    const { entity, id } = req.query;
    if (!(await entityVisible(entity, id, req))) return res.status(404).json({ error: 'السجل غير موجود' });

    let name = '';
    try { name = decodeURIComponent(req.get('X-File-Name') || ''); } catch { /* اسم غير صالح */ }
    name = path.basename(name).slice(0, 200);
    const ext = path.extname(name).toLowerCase();
    if (!name || !ALLOWED[ext]) {
      return res.status(400).json({ error: 'نوع الملف غير مسموح. المسموح: PDF، صور، Word، Excel' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'الملف فارغ' });

    const stored = `${crypto.randomUUID()}${ext}`;
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), req.body);
    const title = str(req.query.title).slice(0, 200) || path.basename(name, ext);
    const { rows } = await pool.query(
      `INSERT INTO documents (entity_type, entity_id, title, original_name, stored_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${docColumns}`,
      [entity, id, title, name, stored, ALLOWED[ext], req.body.length, req.user.name],
    );
    audit.log(req, 'upload', entity, id, `مستند: ${title} (${name})`);
    return res.status(201).json(rows[0]);
  },
);

router.get('/documents/:id/file', async (req, res) => {
  if (!parseId(req.params.id)) return res.status(404).end();
  const { rows } = await pool.query(
    'SELECT original_name, stored_name, mime_type, entity_type, entity_id FROM documents WHERE id = $1',
    [req.params.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'المستند غير موجود' });
  const doc = rows[0];
  if (!can(req.user, doc.entity_type, 'read')) return res.status(403).json({ error: 'ليس لديك صلاحية' });
  if (!(await entityVisible(doc.entity_type, doc.entity_id, req))) return res.status(404).json({ error: 'المستند غير موجود' });
  const inline = req.query.inline === '1' && /^(application\/pdf|image\/)/.test(doc.mime_type);
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf");
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`,
  );
  return res.sendFile(path.join(UPLOAD_DIR, doc.stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'الملف غير موجود على الخادم' });
  });
});

router.delete('/documents/:id', async (req, res) => {
  if (!parseId(req.params.id)) return res.status(404).end();
  const { rows: [doc] } = await pool.query('SELECT entity_type, entity_id, title FROM documents WHERE id = $1', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'المستند غير موجود' });
  if (!can(req.user, doc.entity_type, 'write')) return res.status(403).json({ error: 'ليس لديك صلاحية' });
  if (!(await entityVisible(doc.entity_type, doc.entity_id, req))) return res.status(404).json({ error: 'المستند غير موجود' });
  const { rows } = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING stored_name', [req.params.id]);
  fs.promises.unlink(path.join(UPLOAD_DIR, rows[0].stored_name)).catch(() => {});
  audit.log(req, 'delete', doc.entity_type, doc.entity_id, `مستند: ${doc.title}`);
  return res.status(204).end();
});

// ---------- صورة الموظف ----------

const PHOTO_DIR = path.join(UPLOAD_DIR, 'photos');
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

// نوع الصورة من محتواها الفعلي وليس من اسمها
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  return null;
}
const PHOTO_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function deletePhotoFile(name) {
  if (name && /^[\w-]+\.(jpg|png|webp)$/.test(name)) await fs.promises.unlink(path.join(PHOTO_DIR, name)).catch(() => {});
}

async function visibleEmployee(req, id) {
  const { rows } = await pool.query(
    'SELECT id, name, photo FROM residencies WHERE id = $1 AND ($2::bigint IS NULL OR branch_id = $2::bigint)',
    [id, req.branch || null],
  );
  return rows[0] || null;
}

router.put('/residencies/:id/photo', express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), async (req, res) => {
  const id = parseId(req.params.id);
  const emp = id && await visibleEmployee(req, id);
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const type = imageType(buf);
  if (!type) return res.status(400).json({ error: 'الصورة لازم تكون JPG أو PNG أو WebP' });
  const name = `${crypto.randomUUID()}${type.ext}`;
  await fs.promises.mkdir(PHOTO_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(PHOTO_DIR, name), buf);
  await pool.query('UPDATE residencies SET photo = $2, updated_at = now() WHERE id = $1', [id, name]);
  await deletePhotoFile(emp.photo);
  audit.log(req, 'upload', 'residencies', id, `صورة الموظف: ${emp.name}`);
  return res.json({ photo: `/api/residencies/${id}/photo?v=${Date.now()}` });
});

router.delete('/residencies/:id/photo', async (req, res) => {
  const id = parseId(req.params.id);
  const emp = id && await visibleEmployee(req, id);
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  await pool.query('UPDATE residencies SET photo = NULL, updated_at = now() WHERE id = $1', [id]);
  await deletePhotoFile(emp.photo);
  audit.log(req, 'delete', 'residencies', id, `صورة الموظف: ${emp.name}`);
  return res.status(204).end();
});

router.get('/residencies/:id/photo', async (req, res) => {
  const id = parseId(req.params.id);
  const emp = id && await visibleEmployee(req, id);
  if (!emp?.photo) return res.status(404).end();
  res.setHeader('Content-Type', PHOTO_MIME[path.extname(emp.photo)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  return res.sendFile(path.join(PHOTO_DIR, emp.photo), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- الموظفين (للاختيار والملف الشامل) ----------

router.get('/employees', async (req, res) => {
  const q = str(req.query.q);
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await pool.query(
    `SELECT id, name, iqama_number FROM residencies
     WHERE ($1 = '' OR name ILIKE $2 OR iqama_number LIKE $2) AND ($3::bigint IS NULL OR branch_id = $3::bigint)
     ORDER BY name LIMIT 15`,
    [q, like, req.branch || null],
  );
  res.json(rows.map((r) => ({ id: String(r.id), name: r.name, iqamaNumber: r.iqama_number })));
});

// كل ما يخص الموظف (للملف الشامل وتقرير الموظف)؛ null لو غير موجود أو من فرع آخر
async function employeeSummary(req, id) {
  const base = await context(req);
  const section = async (key, cond) => {
    const m = MODULES[key];
    const { sql, p } = inner(m, base);
    const { rows } = await pool.query(
      `SELECT * FROM (${sql}) x WHERE ${cond.replace('$ID', p.add(id))} ORDER BY ${m.sort} LIMIT 50`,
      p.values,
    );
    return rows;
  };
  const [driverCards, advances, custody, cars, evaluations, docs, employeeDocs, visas, leaves, emp] = await Promise.all([
    section('driver_cards', 'employee_id = $ID'),
    section('advances', 'employee_id = $ID'),
    section('custody', 'employee_id = $ID'),
    section('cars', 'driver_id = $ID'),
    section('evaluations', 'employee_id = $ID'),
    pool.query('SELECT count(*)::int AS n FROM documents WHERE entity_type = $1 AND entity_id = $2', ['residencies', id]),
    section('employee_docs', 'employee_id = $ID'),
    section('visas', 'employee_id = $ID'),
    section('leaves', 'employee_id = $ID'),
    pool.query(
      `SELECT e.annual_leave_days, (e.annual_leave_days - COALESCE((
         SELECT sum(end_date - start_date + 1) FROM leaves
         WHERE employee_id = e.id AND leave_type = 'سنوية' AND approval = 'معتمدة'
           AND extract(year FROM start_date) = extract(year FROM $2::date)), 0))::int AS leave_balance
       FROM residencies e WHERE e.id = $1 AND ($3::bigint IS NULL OR e.branch_id = $3::bigint)`,
      [id, base.today, base.branch],
    ),
  ]);
  if (!emp.rows.length) return null;
  return {
    driverCards, advances, custody, cars, evaluations, employeeDocs, visas, leaves,
    documents: docs.rows[0].n,
    leaveEntitlement: emp.rows[0]?.annual_leave_days ?? 21,
    leaveBalance: emp.rows[0]?.leave_balance ?? 21,
  };
}

router.get('/employees/:id/summary', async (req, res) => {
  const id = parseId(req.params.id);
  const summary = id && await employeeSummary(req, id);
  if (!summary) return res.status(404).json({ error: 'الموظف غير موجود' });
  return res.json(summary);
});

// ---------- نظرة عامة للوحة المتابعة ----------

router.get('/overview', async (req, res) => {
  const base = await context(req);
  const out = {};
  await Promise.all(Object.entries(MODULES).map(async ([key, m]) => {
    out[key] = { counts: await counts(m, base), totals: await totals(m, base) };
  }));
  res.json(out);
});

router.get('/schema', (req, res) => res.json(publicSchema()));

// قائمة الفروع لاختيار الفرع في الواجهة (المستخدم المربوط بفرع يرى فرعه فقط)
router.get('/branches', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, city FROM branches WHERE ($1::bigint IS NULL OR id = $1::bigint) ORDER BY name',
    [req.branchLocked ? req.branch : null],
  );
  res.json(rows.map((b) => ({ id: String(b.id), name: b.name, city: b.city })));
});

// ---------- Excel: تصدير، نموذج، استيراد ----------

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IQAMA_SUFFIX = ' - رقم الإقامة';
const MAX_IMPORT_ROWS = 10000;

function sendXlsx(res, asciiName, arabicName, sheets) {
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition',
    `attachment; filename="${asciiName}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${arabicName}.xlsx`)}`);
  res.send(writeXlsx(sheets));
}

// أعمدة الملف لكل قسم: حقل الموظف = عمود رقم الإقامة (وعمود الاسم للقراءة فقط في التصدير)
function sheetFields(m) {
  return m.fields.map((f) => ({ f, header: f.type === 'employee' ? `${f.label}${IQAMA_SUFFIX}` : f.label }));
}

// أعمدة محسوبة تُضاف للتصدير فقط (المتبقي، الرصيد، التقييم...)
function computedColumns(m) {
  const names = new Set(m.fields.map((f) => f.name));
  return m.columns.filter((c) => c.label && !names.has(c.key) && c.type !== 'person' && !/_name$/.test(c.key))
    .map((c) => ({ key: c.key, header: c.type === 'days' ? `${c.label} (يوم)` : c.label, type: c.type }));
}

const asNumber = (v) => (v == null || v === '' ? '' : Number(v));

async function branchNames() {
  const { rows } = await pool.query('SELECT id, name FROM branches');
  return new Map(rows.map((b) => [String(b.id), b.name]));
}

async function exportModule(m, req) {
  const query = req.query;
  const base = await context(req);
  const { sql, p } = inner(m, base, { q: str(query.q) });
  const status = m.statuses[query.status] ? p.add(query.status) : null;
  const { rows } = await pool.query(
    `SELECT * FROM (${sql}) x ${status ? `WHERE status = ${status}` : ''} ORDER BY ${m.sort} LIMIT 100000`,
    p.values,
  );
  const empFields = m.fields.filter((f) => f.type === 'employee');
  const ids = [...new Set(rows.flatMap((r) => empFields.map((f) => r[f.name]).filter(Boolean).map(String)))];
  const emps = new Map();
  if (ids.length) {
    const res = await pool.query('SELECT id, name, iqama_number FROM residencies WHERE id = ANY($1::bigint[])', [ids]);
    for (const e of res.rows) emps.set(String(e.id), e);
  }
  const branches = await branchNames();
  const header = [];
  for (const f of m.fields) {
    if (f.type === 'employee') header.push(f.label, `${f.label}${IQAMA_SUFFIX}`);
    else header.push(f.label);
  }
  const computed = computedColumns(m);
  header.push(...computed.map((c) => c.header), 'الحالة');
  const data = rows.map((r) => {
    const out = [];
    for (const f of m.fields) {
      const v = r[f.name];
      if (f.type === 'employee') {
        const e = emps.get(String(v));
        out.push(e?.name ?? '', e?.iqama_number ?? '');
      } else if (f.type === 'branch') out.push(branches.get(String(v)) ?? '');
      else if (['money', 'int', 'rating'].includes(f.type)) out.push(asNumber(v));
      else out.push(v ?? '');
    }
    for (const c of computed) out.push(['money', 'number', 'days', 'progress', 'stars'].includes(c.type) ? asNumber(r[c.key]) : r[c.key] ?? '');
    out.push(m.statuses[r.status]?.label ?? '');
    return out;
  });
  return { header, rows: data };
}

function templateSheets(m) {
  const cols = sheetFields(m);
  const describe = (f) => {
    switch (f.type) {
      case 'date': return 'تاريخ ميلادي (2026-12-31 أو 31/12/2026) أو هجري (1448-06-15)';
      case 'money': return 'مبلغ بالريال (رقم)';
      case 'int': return 'رقم صحيح';
      case 'rating': return 'رقم من 1 إلى 5';
      case 'employee': return 'رقم إقامة الموظف (لازم يكون مسجّل في الإقامات)';
      case 'branch': return 'اسم الفرع كما هو مسجّل في الفروع (فارغ = الفرع المختار حاليًا)';
      case 'select': return `واحدة من: ${f.options.join('، ')}${f.default ? ` (الافتراضي: ${f.default})` : ''}`;
      default: return 'نص';
    }
  };
  return [
    { name: m.label, header: cols.map((c) => c.header), rows: [] },
    {
      name: 'تعليمات',
      header: ['العمود', 'مطلوب', 'القيم المقبولة'],
      rows: cols.map(({ f, header }) => [header, f.required ? 'نعم' : 'لا', describe(f)]),
    },
  ];
}

const normHeader = (h) => String(h ?? '').trim().replace(/\s+/g, ' ').replace(/\s*\*$/, '').toLowerCase();

async function importModule(m, req) {
  const buf = req.body;
  let rows;
  try {
    rows = readTable(buf);
  } catch {
    return { error: 'تعذر قراءة الملف، تأكدي أنه ملف Excel (xlsx) أو CSV' };
  }
  if (rows.length < 2) return { error: 'الملف فارغ أو بدون صف عناوين' };
  if (rows.length - 1 > MAX_IMPORT_ROWS) return { error: `أقصى عدد ${MAX_IMPORT_ROWS} صف في الملف الواحد` };

  const header = rows[0].map(normHeader);
  const index = {};
  for (const { f, header: h } of sheetFields(m)) {
    const names = [h, f.label, f.name].map(normHeader);
    index[f.name] = header.findIndex((x) => names.includes(x));
  }
  const missing = m.fields.filter((f) => f.required && index[f.name] < 0);
  if (missing.length) {
    return { error: `الملف ناقص أعمدة مطلوبة: ${missing.map((f) => (f.type === 'employee' ? `${f.label}${IQAMA_SUFFIX}` : f.label)).join('، ')}` };
  }

  // تحويل أرقام الإقامة إلى معرّفات الموظفين دفعة واحدة
  const empFields = m.fields.filter((f) => f.type === 'employee' && index[f.name] >= 0);
  const iqamas = new Set();
  for (const cells of rows.slice(1)) for (const f of empFields) iqamas.add(toLatinDigits(cells[index[f.name]]));
  iqamas.delete('');
  const byIqama = new Map();
  if (iqamas.size) {
    const res = await pool.query(
      `SELECT id, iqama_number FROM residencies
       WHERE iqama_number = ANY($1::text[]) AND ($2::bigint IS NULL OR branch_id = $2::bigint)`,
      [[...iqamas], req.branch || null],
    );
    for (const e of res.rows) byIqama.set(e.iqama_number, String(e.id));
  }
  const branchByName = new Map([...(await branchNames())].map(([id, name]) => [normHeader(name), id]));

  const errors = [];
  const valid = [];
  rows.slice(1).forEach((cells, i) => {
    if (!cells.some((c) => str(c))) return;
    const line = i + 2;
    const body = {};
    const rowErrors = [];
    for (const f of m.fields) {
      const col = index[f.name];
      if (col < 0) continue;
      let v = cells[col];
      if (f.type === 'date') v = parseDateCell(v);
      else if (f.type === 'employee') {
        const iq = toLatinDigits(v);
        v = iq ? byIqama.get(iq) : '';
        if (iq && !v) rowErrors.push(`${f.label}: لا يوجد موظف برقم الإقامة ${iq}${req.branch ? ' في هذا الفرع' : ''}`);
      } else if (f.type === 'branch') {
        const name = str(v);
        v = name ? branchByName.get(normHeader(name)) : '';
        if (name && !v) rowErrors.push(`${f.label}: لا يوجد فرع باسم ${name}`);
      } else if (['money', 'int', 'rating'].includes(f.type)) v = toLatinDigits(v);
      body[f.name] = v;
    }
    const { errors: e, values } = validateFields(m.fields, body);
    if (!e.length && m.validate) e.push(...m.validate(values));
    rowErrors.push(...e.filter((x) => !rowErrors.some((y) => x.startsWith(y.split(':')[0]))));
    if (rowErrors.length) errors.push({ line, error: rowErrors.join('، ') });
    else {
      applyBranch(m, values, req, true);
      valid.push({ line, values });
    }
  });

  let inserted = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { line, values } of valid) {
      const cols = Object.keys(values);
      await client.query('SAVEPOINT row');
      try {
        await client.query(
          `INSERT INTO ${m.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((c) => values[c]),
        );
        await client.query('RELEASE SAVEPOINT row');
        inserted++;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT row');
        if (!['23505', '23503', '23514'].includes(err.code)) throw err;
        errors.push({ line, error: err.code === '23505' ? 'القيمة مسجلة من قبل (مكررة)' : 'قيمة غير مسموح بها' });
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  errors.sort((a, b) => a.line - b.line);
  return { inserted, failed: errors.length, errors: errors.slice(0, 200) };
}

// ---------- مسارات كل قسم ----------

for (const [key, m] of Object.entries(MODULES)) {
  const sorts = { default: m.sort, newest: 'created_at DESC, id DESC' };

  router.get(`/m/${key}`, async (req, res) => {
    const base = await context(req);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 25));
    const q = str(req.query.q);
    const { sql, p } = inner(m, base, { q });
    const status = m.statuses[req.query.status] ? p.add(req.query.status) : null;
    const where = status ? `WHERE status = ${status}` : '';
    const order = sorts[req.query.sort] || sorts.default;

    const [list, c] = await Promise.all([
      pool.query(
        `SELECT * FROM (${sql}) x ${where} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        p.values,
      ),
      counts(m, base, q),
    ]);
    res.json({
      page,
      pageSize,
      total: status ? c[req.query.status] : c.total,
      counts: c,
      totals: await totals(m, base),
      items: list.rows,
    });
  });

  router.get(`/m/${key}/export.xlsx`, async (req, res) => {
    const { header, rows } = await exportModule(m, req);
    sendXlsx(res, `${key}-${today()}`, `${m.label}-${today()}`, [{ name: m.label, header, rows }]);
  });

  router.get(`/m/${key}/template.xlsx`, (req, res) => {
    sendXlsx(res, `${key}-template`, `نموذج-${m.label}`, templateSheets(m));
  });

  router.post(`/m/${key}/import`, express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
    const result = await importModule(m, req);
    if (result.error) return res.status(400).json({ error: result.error });
    audit.log(req, 'import', key, '', `استيراد ${m.label}: إضافة ${result.inserted}، أخطاء ${result.failed}`);
    return res.json(result);
  });

  router.get(`/m/${key}/:id`, async (req, res) => {
    const id = parseId(req.params.id);
    const row = id && await getOne(m, id, req);
    if (!row) return res.status(404).json({ error: `${m.singular} غير موجود` });
    return res.json(row);
  });

  router.post(`/m/${key}`, async (req, res) => {
    const { errors, values } = validateFields(m.fields, req.body || {});
    if (!errors.length && m.validate) errors.push(...m.validate(values));
    applyBranch(m, values, req, true);
    if (!errors.length) errors.push(...await employeesOutsideBranch(m, values, req));
    if (errors.length) return res.status(400).json({ error: errors.join('، ') });
    const cols = Object.keys(values);
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${m.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => values[c]),
      );
      const created = await getOne(m, rows[0].id);
      audit.log(req, 'create', key, created.id, `${m.singular}: ${created[m.title] ?? ''}`);
      return res.status(201).json(created);
    } catch (err) {
      return dbError(err, res);
    }
  });

  router.put(`/m/${key}/:id`, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).end();
    if (!(await getOne(m, id, req))) return res.status(404).json({ error: `${m.singular} غير موجود` });
    const { errors, values } = validateFields(m.fields, req.body || {});
    if (!errors.length && m.validate) errors.push(...m.validate(values));
    applyBranch(m, values, req, false);
    if (!errors.length) errors.push(...await employeesOutsideBranch(m, values, req));
    if (errors.length) return res.status(400).json({ error: errors.join('، ') });
    const cols = Object.keys(values);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query(`SELECT * FROM ${m.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${m.singular} غير موجود` });
      }
      await client.query(
        `UPDATE ${m.table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [id, ...cols.map((c) => values[c])],
      );
      if (m.trackChanges) await logChanges(client, m, id, before, values, req.user.name);
      await client.query('COMMIT');
      const labels = Object.fromEntries(m.fields.map((f) => [f.name, f.label]));
      audit.log(req, 'update', key, id, `${m.singular}: ${before[m.title] ?? values[m.title] ?? id}`,
        audit.diff(before, values, labels));
    } catch (err) {
      await client.query('ROLLBACK');
      return dbError(err, res);
    } finally {
      client.release();
    }
    return res.json(await getOne(m, id));
  });

  router.delete(`/m/${key}/:id`, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).end();
    const existing = await getOne(m, id, req);
    if (!existing) return res.status(404).json({ error: `${m.singular} غير موجود` });
    try {
      await pool.query(`DELETE FROM ${m.table} WHERE id = $1`, [id]);
    } catch (err) {
      return dbError(err, res);
    }
    await deleteDocuments(key, id);
    audit.log(req, 'delete', key, id, `${m.singular}: ${existing[m.title] ?? ''}`);
    return res.status(204).end();
  });

  // السجلات التابعة (سجل الصيانة، دفعات السلف)
  for (const [childKey, c] of Object.entries(m.children || {})) {
    router.get(`/m/${key}/:id/${childKey}`, async (req, res) => {
      const id = parseId(req.params.id);
      if (!id || !(await getOne(m, id, req))) return res.status(404).end();
      const { rows } = await pool.query(`SELECT * FROM ${c.table} WHERE ${c.fk} = $1 ORDER BY ${c.order}`, [id]);
      return res.json(rows);
    });

    router.post(`/m/${key}/:id/${childKey}`, async (req, res) => {
      const id = parseId(req.params.id);
      const parent = id && await getOne(m, id, req);
      if (!parent) return res.status(404).json({ error: `${m.singular} غير موجود` });
      const { errors, values } = validateFields(c.fields, req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('، ') });
      if (key === 'advances' && values.amount > Number(parent.remaining) + 0.001) {
        return res.status(400).json({ error: `المبلغ أكبر من المتبقي على السلفة (${parent.remaining})` });
      }
      const cols = [c.fk, ...Object.keys(values), 'created_by'];
      const vals = [id, ...Object.values(values), req.user.name];
      const { rows } = await pool.query(
        `INSERT INTO ${c.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        vals,
      );
      if (key === 'cars' && values.odometer) {
        await pool.query('UPDATE cars SET odometer = GREATEST(COALESCE(odometer, 0), $2) WHERE id = $1', [id, values.odometer]);
      }
      audit.log(req, 'create', key, id, `${c.label} — ${m.singular}: ${parent[m.title] ?? ''}`, values);
      return res.status(201).json(rows[0]);
    });

    router.delete(`/m/${key}/:id/${childKey}/:childId`, async (req, res) => {
      const id = parseId(req.params.id);
      const childId = parseId(req.params.childId);
      if (!id || !childId || !(await getOne(m, id, req))) return res.status(404).end();
      const { rowCount } = await pool.query(`DELETE FROM ${c.table} WHERE id = $1 AND ${c.fk} = $2`, [childId, id]);
      if (!rowCount) return res.status(404).json({ error: 'السجل غير موجود' });
      audit.log(req, 'delete', key, id, `${c.label}: سجل رقم ${childId}`);
      return res.status(204).end();
    });
  }
}

// تسجيل أي تعديل على بيانات السيارة في سجلها
async function logChanges(client, m, id, before, after, user) {
  const labels = Object.fromEntries(m.fields.map((f) => [f.name, f]));
  const fmt = async (field, v) => {
    if (v == null || v === '') return '—';
    if (labels[field].type === 'employee') {
      const r = await client.query('SELECT name FROM residencies WHERE id = $1', [v]);
      return r.rows[0]?.name || '—';
    }
    if (labels[field].type === 'branch') {
      const r = await client.query('SELECT name FROM branches WHERE id = $1', [v]);
      return r.rows[0]?.name || '—';
    }
    if (labels[field].type === 'date' && v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  const changes = [];
  for (const field of m.trackChanges) {
    const a = before[field] == null ? '' : String(before[field]);
    const b = after[field] == null ? '' : String(after[field]);
    if (a !== b) changes.push(`${labels[field].label}: ${await fmt(field, before[field])} ← ${await fmt(field, after[field])}`);
  }
  if (!changes.length) return;
  await client.query(
    `INSERT INTO car_events (car_id, event_date, event_type, description, created_by)
     VALUES ($1, $2, 'تحديث بيانات', $3, $4)`,
    [id, today(), changes.join('\n'), user],
  );
}

module.exports = { router, validateFields, deleteDocuments, deletePhotoFile, UPLOAD_DIR, inner, context, counts, employeeSummary };
