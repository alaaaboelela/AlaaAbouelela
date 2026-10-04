// محرك عام يبني الـ API لكل قسم معرّف في modules.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, getAlertDays } = require('./db');
const { MODULES, publicSchema } = require('./modules');
const { params, today, addDays } = require('./residencies');
const config = require('./config');

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
  if (err.code === '23503') {
    return res.status(409).json({ error: 'لا يمكن الحذف أو الحفظ لوجود بيانات مرتبطة (مثل سلف أو عهد على الموظف)' });
  }
  if (err.code === '23514') return res.status(400).json({ error: 'قيمة غير مسموح بها' });
  throw err;
}

const parseId = (v) => (/^\d{1,18}$/.test(String(v)) ? String(v) : null);

// ---------- بناء الاستعلامات ----------

async function context() {
  const alertDays = await getAlertDays();
  const t = today();
  return { today: t, alertEnd: addDays(t, alertDays), alertDays };
}

function inner(m, base, { q, id } = {}) {
  const p = params();
  const ctx = { ...base, p };
  const where = [];
  if (id) where.push(`t.id = ${p.add(id)}`);
  if (q) {
    const like = p.add(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(${m.search.map((c) => `${c} ILIKE ${like}`).join(' OR ')})`);
  }
  const sql = `SELECT t.*, ${m.extra(ctx)}, ${m.status(ctx)} AS status
    FROM ${m.from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return { sql, p, where };
}

async function getOne(m, id) {
  const { sql, p } = inner(m, await context(), { id });
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

async function totals(m) {
  if (!m.totals) return null;
  const exprs = Object.entries(m.totals).map(([k, e]) => `COALESCE(${e}, 0) AS "${k}"`).join(', ');
  const { rows } = await pool.query(`SELECT ${exprs} FROM ${m.from}`);
  return rows[0];
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

async function entityExists(type, id) {
  const table = DOC_ENTITIES[type];
  if (!table || !parseId(id)) return false;
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function deleteDocuments(type, id) {
  const { rows } = await pool.query(
    'DELETE FROM documents WHERE entity_type = $1 AND entity_id = $2 RETURNING stored_name',
    [type, id],
  );
  for (const r of rows) fs.promises.unlink(path.join(UPLOAD_DIR, r.stored_name)).catch(() => {});
}

const docColumns = 'id, entity_type, entity_id, title, original_name, mime_type, size_bytes, uploaded_by, created_at';

router.get('/documents', async (req, res) => {
  const { entity, id } = req.query;
  if (!DOC_ENTITIES[entity] || !parseId(id)) return res.status(400).json({ error: 'طلب غير صحيح' });
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
    if (!(await entityExists(entity, id))) return res.status(404).json({ error: 'السجل غير موجود' });

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
    return res.status(201).json(rows[0]);
  },
);

router.get('/documents/:id/file', async (req, res) => {
  if (!parseId(req.params.id)) return res.status(404).end();
  const { rows } = await pool.query('SELECT original_name, stored_name, mime_type FROM documents WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'المستند غير موجود' });
  const doc = rows[0];
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
  const { rows } = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING stored_name', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'المستند غير موجود' });
  fs.promises.unlink(path.join(UPLOAD_DIR, rows[0].stored_name)).catch(() => {});
  return res.status(204).end();
});

// ---------- الموظفين (للاختيار والملف الشامل) ----------

router.get('/employees', async (req, res) => {
  const q = str(req.query.q);
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await pool.query(
    `SELECT id, name, iqama_number FROM residencies
     WHERE $1 = '' OR name ILIKE $2 OR iqama_number LIKE $2
     ORDER BY name LIMIT 15`,
    [q, like],
  );
  res.json(rows.map((r) => ({ id: String(r.id), name: r.name, iqamaNumber: r.iqama_number })));
});

router.get('/employees/:id/summary', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).end();
  const base = await context();
  const section = async (key, cond) => {
    const m = MODULES[key];
    const { sql, p } = inner(m, base);
    const { rows } = await pool.query(
      `SELECT * FROM (${sql}) x WHERE ${cond.replace('$ID', p.add(id))} ORDER BY ${m.sort} LIMIT 50`,
      p.values,
    );
    return rows;
  };
  const [driverCards, advances, custody, cars, evaluations, docs] = await Promise.all([
    section('driver_cards', 'employee_id = $ID'),
    section('advances', 'employee_id = $ID'),
    section('custody', 'employee_id = $ID'),
    section('cars', 'driver_id = $ID'),
    section('evaluations', 'employee_id = $ID'),
    pool.query('SELECT count(*)::int AS n FROM documents WHERE entity_type = $1 AND entity_id = $2', ['residencies', id]),
  ]);
  res.json({ driverCards, advances, custody, cars, evaluations, documents: docs.rows[0].n });
});

// ---------- نظرة عامة للوحة المتابعة ----------

router.get('/overview', async (req, res) => {
  const base = await context();
  const out = {};
  await Promise.all(Object.entries(MODULES).map(async ([key, m]) => {
    out[key] = { counts: await counts(m, base), totals: await totals(m) };
  }));
  res.json(out);
});

router.get('/schema', (req, res) => res.json(publicSchema()));

// ---------- مسارات كل قسم ----------

for (const [key, m] of Object.entries(MODULES)) {
  const sorts = { default: m.sort, newest: 'created_at DESC, id DESC' };

  router.get(`/m/${key}`, async (req, res) => {
    const base = await context();
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
      totals: await totals(m),
      items: list.rows,
    });
  });

  router.get(`/m/${key}/:id`, async (req, res) => {
    const id = parseId(req.params.id);
    const row = id && await getOne(m, id);
    if (!row) return res.status(404).json({ error: `${m.singular} غير موجود` });
    return res.json(row);
  });

  router.post(`/m/${key}`, async (req, res) => {
    const { errors, values } = validateFields(m.fields, req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('، ') });
    const cols = Object.keys(values);
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${m.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => values[c]),
      );
      return res.status(201).json(await getOne(m, rows[0].id));
    } catch (err) {
      return dbError(err, res);
    }
  });

  router.put(`/m/${key}/:id`, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).end();
    const { errors, values } = validateFields(m.fields, req.body || {});
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
    try {
      const { rowCount } = await pool.query(`DELETE FROM ${m.table} WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ error: `${m.singular} غير موجود` });
    } catch (err) {
      return dbError(err, res);
    }
    await deleteDocuments(key, id);
    return res.status(204).end();
  });

  // السجلات التابعة (سجل الصيانة، دفعات السلف)
  for (const [childKey, c] of Object.entries(m.children || {})) {
    router.get(`/m/${key}/:id/${childKey}`, async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return res.status(404).end();
      const { rows } = await pool.query(`SELECT * FROM ${c.table} WHERE ${c.fk} = $1 ORDER BY ${c.order}`, [id]);
      return res.json(rows);
    });

    router.post(`/m/${key}/:id/${childKey}`, async (req, res) => {
      const id = parseId(req.params.id);
      const parent = id && await getOne(m, id);
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
      return res.status(201).json(rows[0]);
    });

    router.delete(`/m/${key}/:id/${childKey}/:childId`, async (req, res) => {
      const id = parseId(req.params.id);
      const childId = parseId(req.params.childId);
      if (!id || !childId) return res.status(404).end();
      const { rowCount } = await pool.query(`DELETE FROM ${c.table} WHERE id = $1 AND ${c.fk} = $2`, [childId, id]);
      if (!rowCount) return res.status(404).json({ error: 'السجل غير موجود' });
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

module.exports = { router, validateFields, deleteDocuments, UPLOAD_DIR, inner, context, counts };
