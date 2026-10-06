// التقويم (كل المواعيد والانتهاءات) والتقارير القابلة للطباعة
const express = require('express');
const { pool, getAlertDays, getSetting } = require('./db');
const { MODULES } = require('./modules');
const { inner, context, employeeSummary } = require('./crud');
const { columns, today, addDays, statusOf, toApi } = require('./residencies');
const { gregorianToHijri } = require('../public/hijri');
const { can } = require('./permissions');

const router = express.Router();
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
// عدد أيام من الطلب (0 مسموح)، والقيمة الافتراضية لو غير موجود
const daysParam = (v, def) => (v === undefined || v === '' ? def : Math.min(3650, Math.max(0, Number.parseInt(v, 10) || 0)));

// ---------- مصادر التقويم ----------
// كل مصدر يرجع: id, date, title, sub — و {range} يُستبدل بشرط التاريخ

const CAR_SERVICE = `JOIN LATERAL (
    SELECT next_service_date AS d FROM car_events
    WHERE car_id = t.id AND next_service_date IS NOT NULL ORDER BY event_date DESC, id DESC LIMIT 1
  ) ns ON true`;

const SOURCES = [
  {
    type: 'residency', short: 'إقامة', section: 'residencies', label: 'انتهاء إقامة', icon: 'card', open: 'employee', branch: 'e.branch_id',
    sql: 'SELECT e.id, e.expiry_date AS date, e.name AS title, e.iqama_number AS sub FROM residencies e WHERE e.expiry_date {range}',
  },
  {
    type: 'employee_doc', short: 'مستند', section: 'employee_docs', label: 'انتهاء مستند موظف', icon: 'passport', open: 'employee_docs', branch: 'e.branch_id',
    sql: `SELECT t.id, t.expiry_date AS date, e.name AS title, t.doc_type AS sub
      FROM employee_docs t JOIN residencies e ON e.id = t.employee_id WHERE t.expiry_date {range}`,
  },
  {
    type: 'driver_card', short: 'بطاقة سائق', section: 'driver_cards', label: 'انتهاء بطاقة سائق', icon: 'steering', open: 'driver_cards', branch: 'e.branch_id',
    sql: `SELECT t.id, t.expiry_date AS date, e.name AS title, t.card_number AS sub
      FROM driver_cards t JOIN residencies e ON e.id = t.employee_id WHERE t.expiry_date {range}`,
  },
  {
    type: 'visa_return', short: 'عودة', section: 'visas', label: 'آخر موعد للعودة', icon: 'plane', open: 'visas', branch: 'e.branch_id',
    sql: `SELECT t.id, t.return_deadline AS date, e.name AS title, concat_ws(' · ', t.visa_type, NULLIF(t.destination, '')) AS sub
      FROM visas t JOIN residencies e ON e.id = t.employee_id
      WHERE t.actual_return_date IS NULL AND t.visa_type <> 'خروج نهائي' AND t.return_deadline {range}`,
  },
  {
    type: 'leave_start', short: 'إجازة', section: 'leaves', label: 'بداية إجازة', icon: 'sun-palm', open: 'leaves', branch: 'e.branch_id',
    sql: `SELECT t.id, t.start_date AS date, e.name AS title, concat(t.leave_type, ' · ', t.end_date - t.start_date + 1, ' يوم') AS sub
      FROM leaves t JOIN residencies e ON e.id = t.employee_id WHERE t.approval <> 'مرفوضة' AND t.start_date {range}`,
  },
  {
    type: 'leave_end', short: 'عودة إجازة', section: 'leaves', label: 'عودة من إجازة', icon: 'sun-palm', open: 'leaves', branch: 'e.branch_id',
    sql: `SELECT t.id, t.end_date + 1 AS date, e.name AS title, t.leave_type AS sub
      FROM leaves t JOIN residencies e ON e.id = t.employee_id WHERE t.approval <> 'مرفوضة' AND t.end_date + 1 {range}`,
  },
  {
    type: 'contract', short: 'عقد', section: 'contracts', label: 'انتهاء عقد', icon: 'contract', open: 'contracts', branch: 't.branch_id',
    sql: 'SELECT t.id, t.end_date AS date, t.company_name AS title, t.contract_number AS sub FROM contracts t WHERE t.end_date {range}',
  },
  {
    type: 'car_registration', short: 'استمارة', section: 'cars', label: 'انتهاء استمارة', icon: 'car', open: 'cars', branch: 't.branch_id',
    sql: `SELECT t.id, t.registration_expiry AS date, t.plate_number AS title, concat_ws(' ', t.make, t.model) AS sub
      FROM cars t WHERE t.registration_expiry {range}`,
  },
  {
    type: 'car_insurance', short: 'تأمين', section: 'cars', label: 'انتهاء تأمين سيارة', icon: 'car', open: 'cars', branch: 't.branch_id',
    sql: `SELECT t.id, t.insurance_expiry AS date, t.plate_number AS title, concat_ws(' ', t.make, t.model) AS sub
      FROM cars t WHERE t.insurance_expiry {range}`,
  },
  {
    type: 'car_service', short: 'صيانة', section: 'cars', label: 'موعد صيانة', icon: 'wrench', open: 'cars', branch: 't.branch_id',
    sql: `SELECT t.id, ns.d AS date, t.plate_number AS title, concat_ws(' ', t.make, t.model) AS sub
      FROM cars t ${CAR_SERVICE} WHERE ns.d {range}`,
  },
];

// شرط الفرع يُضاف مع شرط التاريخ داخل WHERE ($1 من، $2 إلى، $3 الفرع)
function sourceSql(s, branch) {
  const range = 'BETWEEN $1::date AND $2::date';
  const sql = s.sql.replace('{range}', branch ? `${range} AND ${s.branch} = $3::bigint` : range);
  return `SELECT '${s.type}' AS type, x.* FROM (${sql}) x`;
}

function calendarSql(req, types) {
  const list = SOURCES.filter((s) => can(req.user, s.section, 'read') && (!types || types.includes(s.type)));
  return list.length ? list.map((s) => sourceSql(s, req.branch)).join('\nUNION ALL\n') : null;
}

const calendarParams = (req, from, to) => (req.branch ? [from, to, req.branch] : [from, to]);
const sourceInfo = Object.fromEntries(SOURCES.map((s) => [s.type, { label: s.label, short: s.short, icon: s.icon, open: s.open, section: s.section }]));

// شهر كامل: عدد كل نوع في كل يوم + أول 3 عناصر لعرضها مباشرة
router.get('/calendar', async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? req.query.month : today().slice(0, 7);
  const from = `${month}-01`;
  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const to = addDays(end.toISOString().slice(0, 10), -1);
  const sql = calendarSql(req);
  const days = {};
  if (sql) {
    const { rows } = await pool.query(
      `SELECT type, to_char(date, 'YYYY-MM-DD') AS date, count(*)::int AS n,
         (array_agg(title ORDER BY title))[1:3] AS sample
       FROM (${sql}) u GROUP BY type, date ORDER BY date`,
      calendarParams(req, from, to),
    );
    for (const r of rows) (days[r.date] ||= []).push({ type: r.type, count: r.n, sample: r.sample });
  }
  res.json({ month, from, to, today: today(), alertDays: await getAlertDays(), types: sourceInfo, days });
});

// تفاصيل يوم (أو فترة) — كل العناصر مع معرّفاتها لفتحها
router.get('/calendar/items', async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : today();
  const to = isDate(req.query.to) && req.query.to >= from ? req.query.to : from;
  const sql = calendarSql(req);
  if (!sql) return res.json({ items: [] });
  const { rows } = await pool.query(
    `SELECT type, id::text AS id, to_char(date, 'YYYY-MM-DD') AS date, title, sub FROM (${sql}) u
     ORDER BY date, type, title LIMIT 500`,
    calendarParams(req, from, to),
  );
  return res.json({ items: rows, types: sourceInfo });
});

// ---------- التقارير ----------

const statusCell = (label, tone) => ({ label, tone });

function residencyRow(r, alertDays) {
  const status = statusOf(r.days_left, alertDays);
  return [r.name, r.iqama_number, r.nationality, [r.branch_name, r.employer].filter(Boolean).join(' · '),
    r.expiry_date, r.days_left,
    statusCell({ expired: 'منتهية', expiring: 'قريبة من الانتهاء', valid: 'سارية' }[status], status)];
}

async function moduleRows(req, key, where = '', order = null) {
  const m = MODULES[key];
  const base = await context(req);
  const { sql, p } = inner(m, base);
  const { rows } = await pool.query(`SELECT * FROM (${sql}) x ${where} ORDER BY ${order || m.sort} LIMIT 5000`, p.values);
  return rows;
}

const REPORTS = {
  residencies: {
    title: 'تقرير الإقامات المنتهية والقريبة من الانتهاء',
    description: 'كل إقامة منتهية أو ستنتهي خلال عدد الأيام المختار، مرتبة بالأقرب انتهاءً.',
    section: 'residencies',
    icon: 'card',
    params: [
      { name: 'days', label: 'تنتهي خلال (يوم)', type: 'int', default: 'alert' },
      { name: 'overdue', label: 'ومنتهية منذ (يوم)', type: 'int', default: 30 },
    ],
    async run(req, q) {
      const alertDays = await getAlertDays();
      const days = Math.min(3650, Math.max(1, Number.parseInt(q.days, 10) || alertDays));
      const overdue = daysParam(q.overdue, 30);
      const t = today();
      const vals = [t, addDays(t, days), addDays(t, -overdue)];
      if (req.branch) vals.push(req.branch);
      const { rows } = await pool.query(
        `SELECT ${columns('$1')} FROM residencies
         WHERE expiry_date BETWEEN $3::date AND $2::date ${req.branch ? 'AND branch_id = $4::bigint' : ''}
         ORDER BY expiry_date, name LIMIT 10000`,
        vals,
      );
      const expired = rows.filter((r) => r.days_left < 0).length;
      return {
        subtitle: `تنتهي خلال ${days} يوم${overdue ? `، ومنتهية خلال آخر ${overdue} يوم` : ''}`,
        kpis: [
          { label: 'إجمالي التقرير', value: rows.length },
          { label: 'منتهية', value: expired, tone: 'expired' },
          { label: 'قريبة من الانتهاء', value: rows.length - expired, tone: 'expiring' },
        ],
        sections: [{
          columns: [
            { label: 'الاسم' }, { label: 'رقم الإقامة', type: 'mono' }, { label: 'الجنسية' }, { label: 'الفرع / جهة العمل' },
            { label: 'تاريخ الانتهاء', type: 'date' }, { label: 'المتبقي', type: 'days' }, { label: 'الحالة', type: 'status' },
          ],
          rows: rows.map((r) => residencyRow(r, days)),
        }],
      };
    },
  },

  expiries: {
    title: 'تقرير كل ما ينتهي خلال فترة',
    description: 'الإقامات والمستندات وبطاقات السائقين والعقود والسيارات ومواعيد العودة في تقرير واحد.',
    section: null,
    icon: 'calendar',
    params: [
      { name: 'days', label: 'خلال (يوم)', type: 'int', default: 'alert' },
      { name: 'overdue', label: 'يشمل المتأخر حتى (يوم)', type: 'int', default: 30 },
    ],
    async run(req, q) {
      const alertDays = await getAlertDays();
      const days = Math.min(3650, Math.max(1, Number.parseInt(q.days, 10) || alertDays));
      const overdue = daysParam(q.overdue, 30);
      const t = today();
      const types = SOURCES.filter((s) => !s.type.startsWith('leave_')).map((s) => s.type);
      const sql = calendarSql(req, types);
      const rows = sql ? (await pool.query(
        `SELECT type, to_char(date, 'YYYY-MM-DD') AS date, title, sub FROM (${sql}) u ORDER BY date, title LIMIT 10000`,
        calendarParams(req, addDays(t, -overdue), addDays(t, days)),
      )).rows : [];
      for (const r of rows) r.days_left = Math.round((Date.parse(r.date) - Date.parse(t)) / 86400000);
      const sections = SOURCES.filter((s) => types.includes(s.type) && can(req.user, s.section, 'read')).map((s) => ({
        title: s.label,
        columns: [{ label: 'الاسم / البيان' }, { label: 'تفاصيل' }, { label: 'التاريخ', type: 'date' }, { label: 'المتبقي', type: 'days' }],
        rows: rows.filter((r) => r.type === s.type).map((r) => [r.title, r.sub, r.date, r.days_left]),
      })).filter((s) => s.rows.length);
      return {
        subtitle: `من ${addDays(t, -overdue)} إلى ${addDays(t, days)}`,
        kpis: [
          { label: 'إجمالي البنود', value: rows.length },
          { label: 'متأخر / منتهي', value: rows.filter((r) => r.days_left < 0).length, tone: 'expired' },
          { label: 'خلال الفترة', value: rows.filter((r) => r.days_left >= 0).length, tone: 'expiring' },
        ],
        sections,
      };
    },
  },

  advances: {
    title: 'تقرير السلف القائمة',
    description: 'السلف التي لم تُسدد بالكامل: المبلغ والمسدد والمتبقي لكل موظف.',
    section: 'advances',
    icon: 'wallet',
    params: [{ name: 'all', label: 'يشمل المسددة بالكامل', type: 'bool', default: false }],
    async run(req, q) {
      const rows = await moduleRows(req, 'advances', q.all === '1' ? '' : "WHERE status = 'open'", 'employee_name, issue_date');
      const sum = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
      return {
        kpis: [
          { label: 'عدد السلف', value: rows.length },
          { label: 'إجمالي المبالغ', value: sum('amount'), type: 'money' },
          { label: 'المتبقي', value: sum('remaining'), type: 'money', tone: 'expiring' },
        ],
        sections: [{
          columns: [
            { label: 'الموظف' }, { label: 'رقم الإقامة', type: 'mono' }, { label: 'تاريخ الصرف', type: 'date' },
            { label: 'المبلغ', type: 'money' }, { label: 'القسط الشهري', type: 'money' }, { label: 'المسدد', type: 'money' },
            { label: 'المتبقي', type: 'money' }, { label: 'السبب' },
          ],
          rows: rows.map((r) => [r.employee_name, r.employee_iqama, r.issue_date, r.amount, r.monthly_installment, r.paid, r.remaining, r.reason]),
          totals: ['الإجمالي', '', '', sum('amount'), '', sum('paid'), sum('remaining'), ''],
        }],
      };
    },
  },

  custody: {
    title: 'تقرير العهد لدى الموظفين',
    description: 'كل العهد المسلّمة ولم تُرجع بعد، بقيمتها وتاريخ التسليم.',
    section: 'custody',
    icon: 'box',
    params: [{ name: 'all', label: 'يشمل المُرجعة', type: 'bool', default: false }],
    async run(req, q) {
      const rows = await moduleRows(req, 'custody', q.all === '1' ? '' : "WHERE status = 'held'", 'employee_name, handed_date');
      const total = rows.reduce((s, r) => s + Number(r.value || 0) * Number(r.quantity || 1), 0);
      return {
        kpis: [{ label: 'عدد العهد', value: rows.length }, { label: 'إجمالي القيمة', value: total, type: 'money' }],
        sections: [{
          columns: [
            { label: 'الموظف' }, { label: 'رقم الإقامة', type: 'mono' }, { label: 'الصنف' }, { label: 'التصنيف' },
            { label: 'الرقم التسلسلي', type: 'mono' }, { label: 'الكمية', type: 'number' }, { label: 'القيمة', type: 'money' },
            { label: 'تاريخ التسليم', type: 'date' }, { label: 'تاريخ الإرجاع', type: 'date' },
          ],
          rows: rows.map((r) => [r.employee_name, r.employee_iqama, r.item_name, r.category, r.serial_number, r.quantity, r.value, r.handed_date, r.returned_date]),
          totals: ['الإجمالي', '', '', '', '', '', total, '', ''],
        }],
      };
    },
  },

  cars: {
    title: 'تقرير السيارات وتكاليف الصيانة',
    description: 'قيمة كل سيارة وتكاليف صيانتها ومواعيد الاستمارة والتأمين والصيانة القادمة.',
    section: 'cars',
    icon: 'car',
    params: [
      { name: 'from', label: 'تكاليف الصيانة من', type: 'date' },
      { name: 'to', label: 'إلى', type: 'date' },
    ],
    async run(req, q) {
      const rows = await moduleRows(req, 'cars');
      const from = isDate(q.from) ? q.from : null;
      const to = isDate(q.to) ? q.to : null;
      const costs = new Map();
      if (rows.length) {
        const { rows: c } = await pool.query(
          `SELECT car_id::text AS id, COALESCE(sum(cost), 0)::float AS cost, count(*)::int AS n FROM car_events
           WHERE car_id = ANY($1::bigint[]) AND ($2::date IS NULL OR event_date >= $2::date) AND ($3::date IS NULL OR event_date <= $3::date)
           GROUP BY car_id`,
          [rows.map((r) => r.id), from, to],
        );
        for (const x of c) costs.set(x.id, x);
      }
      const cost = (r) => costs.get(String(r.id))?.cost || 0;
      const totalValue = rows.reduce((s, r) => s + Number(r.value || 0), 0);
      const totalCost = rows.reduce((s, r) => s + cost(r), 0);
      return {
        subtitle: from || to ? `تكاليف الصيانة ${from ? `من ${from} ` : ''}${to ? `إلى ${to}` : ''}` : 'تكاليف الصيانة منذ التسجيل',
        kpis: [
          { label: 'عدد السيارات', value: rows.length },
          { label: 'إجمالي القيمة', value: totalValue, type: 'money' },
          { label: 'تكاليف الصيانة', value: totalCost, type: 'money', tone: 'expiring' },
        ],
        sections: [{
          columns: [
            { label: 'اللوحة' }, { label: 'السيارة' }, { label: 'السائق' }, { label: 'القيمة', type: 'money' },
            { label: 'الصيانة', type: 'money' }, { label: 'عدد السجلات', type: 'number' },
            { label: 'الاستمارة', type: 'date' }, { label: 'التأمين', type: 'date' }, { label: 'الصيانة القادمة', type: 'date' },
            { label: 'الحالة', type: 'status' },
          ],
          rows: rows.map((r) => [r.plate_number, [r.make, r.model, r.year].filter(Boolean).join(' '), r.driver_name, r.value, cost(r),
            costs.get(String(r.id))?.n || 0, r.registration_expiry, r.insurance_expiry, r.next_service_date,
            statusCell(MODULES.cars.statuses[r.status].label, MODULES.cars.statuses[r.status].tone)]),
          totals: ['الإجمالي', '', '', totalValue, totalCost, '', '', '', '', ''],
        }],
      };
    },
  },

  employee: {
    title: 'ملف الموظف الشامل',
    description: 'كل بيانات الموظف: الإقامة والمستندات والتأشيرات والإجازات والسلف والعهد والتقييمات.',
    section: 'residencies',
    icon: 'user',
    params: [{ name: 'id', label: 'الموظف', type: 'employee', required: true }],
    async run(req, q) {
      if (!/^\d{1,18}$/.test(String(q.id))) return null;
      const t = today();
      const { rows: [r] } = await pool.query(
        `SELECT ${columns('$1')} FROM residencies WHERE id = $2 AND ($3::bigint IS NULL OR branch_id = $3::bigint)`,
        [t, q.id, req.branch || null],
      );
      const s = r && await employeeSummary(req, q.id);
      if (!s) return null;
      const alertDays = await getAlertDays();
      const e = toApi(r, alertDays);
      const tone = (m, st) => statusCell(MODULES[m].statuses[st]?.label, MODULES[m].statuses[st]?.tone);
      const sec = (key, title, cols, rows) => (can(req.user, key, 'read') ? { title, columns: cols, rows, empty: 'لا يوجد' } : null);
      return {
        title: `ملف الموظف: ${e.name}`,
        meta: [
          { label: 'رقم الإقامة', value: e.iqamaNumber, type: 'mono' },
          { label: 'الجنسية', value: e.nationality },
          { label: 'الفرع', value: e.branchName },
          { label: 'جهة العمل', value: e.employer },
          { label: 'الجوال', value: e.phone, type: 'mono' },
          { label: 'انتهاء الإقامة', value: e.expiryDate, type: 'date' },
        ],
        kpis: [
          { label: 'الإقامة', value: e.daysLeft, type: 'days', tone: e.status },
          { label: 'رصيد الإجازة السنوية', value: `${s.leaveBalance} / ${s.leaveEntitlement} يوم` },
          { label: 'سلف متبقية', value: s.advances.reduce((x, a) => x + Number(a.remaining), 0), type: 'money' },
          { label: 'عهد لديه', value: s.custody.filter((c) => c.status === 'held').length },
        ],
        sections: [
          sec('employee_docs', 'المستندات', [{ label: 'المستند' }, { label: 'الرقم', type: 'mono' }, { label: 'جهة الإصدار' }, { label: 'الانتهاء', type: 'date' }, { label: 'الحالة', type: 'status' }],
            s.employeeDocs.map((x) => [x.doc_type, x.doc_number, x.issuer, x.expiry_date, tone('employee_docs', x.status)])),
          sec('driver_cards', 'بطاقات السائق', [{ label: 'رقم البطاقة', type: 'mono' }, { label: 'رقم الرخصة', type: 'mono' }, { label: 'الانتهاء', type: 'date' }, { label: 'الحالة', type: 'status' }],
            s.driverCards.map((x) => [x.card_number, x.license_number, x.expiry_date, tone('driver_cards', x.status)])),
          sec('visas', 'تأشيرات الخروج والعودة', [{ label: 'النوع' }, { label: 'الوجهة' }, { label: 'السفر', type: 'date' }, { label: 'آخر موعد للعودة', type: 'date' }, { label: 'العودة الفعلية', type: 'date' }, { label: 'الحالة', type: 'status' }],
            s.visas.map((x) => [x.visa_type, x.destination, x.departure_date, x.return_deadline, x.actual_return_date, tone('visas', x.status)])),
          sec('leaves', 'الإجازات', [{ label: 'النوع' }, { label: 'من', type: 'date' }, { label: 'إلى', type: 'date' }, { label: 'الأيام', type: 'number' }, { label: 'الحالة', type: 'status' }],
            s.leaves.map((x) => [x.leave_type, x.start_date, x.end_date, x.days, tone('leaves', x.status)])),
          sec('advances', 'السلف', [{ label: 'تاريخ الصرف', type: 'date' }, { label: 'المبلغ', type: 'money' }, { label: 'المسدد', type: 'money' }, { label: 'المتبقي', type: 'money' }, { label: 'السبب' }],
            s.advances.map((x) => [x.issue_date, x.amount, x.paid, x.remaining, x.reason])),
          sec('custody', 'العهد', [{ label: 'الصنف' }, { label: 'الرقم التسلسلي', type: 'mono' }, { label: 'القيمة', type: 'money' }, { label: 'التسليم', type: 'date' }, { label: 'الإرجاع', type: 'date' }],
            s.custody.map((x) => [x.item_name, x.serial_number, x.value, x.handed_date, x.returned_date])),
          sec('evaluations', 'التقييمات', [{ label: 'التاريخ', type: 'date' }, { label: 'الفترة' }, { label: 'المقيّم' }, { label: 'التقييم', type: 'number' }, { label: 'التوصية' }],
            s.evaluations.map((x) => [x.evaluation_date, x.period, x.evaluator, Number(x.score).toFixed(1), x.recommendation])),
          sec('cars', 'السيارات المسلّمة له', [{ label: 'اللوحة' }, { label: 'السيارة' }, { label: 'الاستمارة', type: 'date' }],
            s.cars.map((x) => [x.plate_number, [x.make, x.model].filter(Boolean).join(' '), x.registration_expiry])),
        ].filter(Boolean),
      };
    },
  },
};

const visible = (req, r) => !r.section || can(req.user, r.section, 'read');

router.get('/reports', (req, res) => {
  res.json(Object.entries(REPORTS).filter(([, r]) => visible(req, r)).map(([key, r]) => ({
    key, title: r.title, description: r.description, icon: r.icon, params: r.params,
  })));
});

router.get('/reports/:key', async (req, res) => {
  const r = REPORTS[req.params.key];
  if (!r) return res.status(404).json({ error: 'التقرير غير موجود' });
  if (!visible(req, r)) return res.status(403).json({ error: 'ليس لديك صلاحية لهذا التقرير' });
  const data = await r.run(req, req.query);
  if (!data) return res.status(404).json({ error: 'البيانات المطلوبة غير موجودة' });
  let branchName = null;
  if (req.branch) branchName = (await pool.query('SELECT name FROM branches WHERE id = $1', [req.branch])).rows[0]?.name;
  const t = today();
  return res.json({
    title: r.title,
    ...data,
    company: (await getSetting('company_name')) || '',
    branch: branchName,
    generatedAt: new Date().toISOString(),
    today: t,
    todayHijri: gregorianToHijri(t),
    generatedBy: req.user.fullName || req.user.name,
  });
});

module.exports = { router, SOURCES };
