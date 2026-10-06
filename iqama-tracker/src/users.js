// إدارة المستخدمين، تغيير كلمة المرور، وسجل العمليات
const express = require('express');
const { pool } = require('./db');
const { hashPassword, verifyPassword, forgetUser } = require('./auth');
const { ROLES, SECTIONS, permissionsFor, can } = require('./permissions');
const audit = require('./audit');

const router = express.Router();
const str = (v) => (v == null ? '' : String(v).trim());
const parseId = (v) => (/^\d{1,18}$/.test(String(v)) ? String(v) : null);

function adminOnly(section) {
  return (req, res, next) => (can(req.user, section, 'write') ? next() : res.status(403).json({ error: 'ليس لديك صلاحية' }));
}

function validateUser(body, { isNew }) {
  const errors = [];
  const username = str(body.username).toLowerCase();
  const fullName = str(body.full_name).slice(0, 100);
  const role = str(body.role);
  const password = String(body.password || '');
  const active = body.active === undefined ? true : body.active === true || body.active === 'true';
  if (isNew && !/^[a-z0-9._-]{3,30}$/.test(username)) {
    errors.push('اسم المستخدم من 3 إلى 30 حرفًا إنجليزيًا أو أرقام (بدون مسافات)');
  }
  if (!ROLES[role]) errors.push('اختر الدور');
  if ((isNew || password) && password.length < 8) errors.push('كلمة المرور 8 أحرف على الأقل');
  return { errors, value: { username, fullName, role, password, active } };
}

const userColumns = 'id, username, full_name, role, active, last_login, created_at';

async function activeAdmins(exceptId) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1",
    [exceptId || 0],
  );
  return rows[0].n;
}

// ---------- الأدوار ----------

router.get('/roles', (req, res) => {
  res.json({
    sections: SECTIONS,
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { label: r.label, permissions: permissionsFor(k) }])),
  });
});

// ---------- المستخدمين ----------

router.get('/users', adminOnly('users'), async (req, res) => {
  const { rows } = await pool.query(`SELECT ${userColumns} FROM users ORDER BY username`);
  res.json(rows.map((u) => ({ ...u, id: String(u.id), roleLabel: ROLES[u.role]?.label || u.role })));
});

router.post('/users', adminOnly('users'), async (req, res) => {
  const { errors, value } = validateUser(req.body || {}, { isNew: true });
  if (errors.length) return res.status(400).json({ error: errors.join('، ') });
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, full_name, role, active, password_hash) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${userColumns}`,
      [value.username, value.fullName, value.role, value.active, hashPassword(value.password)],
    );
    audit.log(req, 'create', 'users', rows[0].id, `مستخدم: ${value.username} (${ROLES[value.role].label})`);
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'اسم المستخدم مستخدم من قبل' });
    throw err;
  }
});

router.put('/users/:id', adminOnly('users'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).end();
  const { errors, value } = validateUser(req.body || {}, { isNew: false });
  if (errors.length) return res.status(400).json({ error: errors.join('، ') });
  const { rows: [before] } = await pool.query(`SELECT ${userColumns} FROM users WHERE id = $1`, [id]);
  if (!before) return res.status(404).json({ error: 'المستخدم غير موجود' });

  const losingAdmin = before.role === 'admin' && before.active && (value.role !== 'admin' || !value.active);
  if (losingAdmin && (await activeAdmins(id)) === 0) {
    return res.status(400).json({ error: 'لازم يفضل مدير نظام واحد فعّال على الأقل' });
  }
  if (String(req.user.id) === id && !value.active) return res.status(400).json({ error: 'لا يمكنك إيقاف حسابك' });

  const { rows } = await pool.query(
    `UPDATE users SET full_name = $2, role = $3, active = $4,
       password_hash = COALESCE($5, password_hash)
     WHERE id = $1 RETURNING ${userColumns}`,
    [id, value.fullName, value.role, value.active, value.password ? hashPassword(value.password) : null],
  );
  forgetUser(id);
  const changes = audit.diff(before, { full_name: value.fullName, role: value.role, active: value.active },
    { full_name: 'الاسم', role: 'الدور', active: 'فعّال' });
  if (value.password) changes['كلمة المرور'] = ['***', 'تم تغييرها'];
  audit.log(req, 'update', 'users', id, `مستخدم: ${before.username}`, changes);
  return res.json(rows[0]);
});

router.delete('/users/:id', adminOnly('users'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).end();
  if (String(req.user.id) === id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك' });
  const { rows: [u] } = await pool.query('SELECT username, role, active FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (u.role === 'admin' && u.active && (await activeAdmins(id)) === 0) {
    return res.status(400).json({ error: 'لازم يفضل مدير نظام واحد فعّال على الأقل' });
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  forgetUser(id);
  audit.log(req, 'delete', 'users', id, `مستخدم: ${u.username}`);
  return res.status(204).end();
});

// ---------- كلمة المرور الخاصة بي ----------

router.post('/me/password', async (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (next.length < 8) return res.status(400).json({ error: 'كلمة المرور الجديدة 8 أحرف على الأقل' });
  const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!u || !verifyPassword(current, u.password_hash)) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hashPassword(next)]);
  audit.log(req, 'password', 'users', req.user.id, 'غيّر كلمة المرور الخاصة به');
  return res.status(204).end();
});

// ---------- سجل العمليات ----------

router.get('/audit', adminOnly('audit'), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = 50;
  const where = [];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (str(req.query.user)) where.push(`user_name = ${add(str(req.query.user))}`);
  if (audit.ACTIONS[req.query.action]) where.push(`action = ${add(req.query.action)}`);
  if (str(req.query.entity)) where.push(`entity_type = ${add(str(req.query.entity))}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(req.query.from))) where.push(`created_at >= ${add(req.query.from)}::date`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(req.query.to))) where.push(`created_at < ${add(req.query.to)}::date + 1`);
  if (str(req.query.q)) where.push(`summary ILIKE ${add(`%${str(req.query.q).replace(/[\\%_]/g, '\\$&')}%`)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [list, count, users] = await Promise.all([
    pool.query(`SELECT * FROM audit_log ${w} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
    pool.query(`SELECT count(*)::int AS n FROM audit_log ${w}`, params),
    pool.query("SELECT DISTINCT user_name FROM audit_log WHERE user_name <> '' ORDER BY 1"),
  ]);
  res.json({
    page,
    pageSize,
    total: count.rows[0].n,
    items: list.rows.map((r) => ({ ...r, id: String(r.id), actionLabel: audit.ACTIONS[r.action] || r.action })),
    users: users.rows.map((r) => r.user_name),
    actions: audit.ACTIONS,
  });
});

module.exports = { router };
