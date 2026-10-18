// كشف خصم أقساط السلف من الرواتب: لكل شهر، القسط المستحق على كل سلفة قائمة،
// وتسجيل الكشف كله كدفعات بضغطة واحدة (مرة واحدة لكل سلفة في الشهر)، وتصديره Excel
const express = require('express');
const { pool } = require('./db');
const { writeXlsx } = require('./xlsx');
const audit = require('./audit');
const config = require('./config');

const router = express.Router();
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const round = (n) => Math.round(n * 100) / 100;

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date()).slice(0, 7);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date());
const lastDay = (month) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const monthName = (month) => new Date(`${month}-15T12:00:00Z`)
  .toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { month: 'long', year: 'numeric' });

// شهر صالح من الطلب: من سنتين لحد الشهر الحالي
function parseMonth(v) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : thisMonth();
  return m > thisMonth() ? null : m;
}

async function sheet(req, month) {
  const { rows } = await pool.query(
    `SELECT t.id::text AS advance_id, e.id::text AS employee_id, e.name, e.iqama_number, COALESCE(b.name, '') AS branch,
       t.amount::float AS amount, t.issue_date, t.monthly_installment::float AS installment,
       COALESCE((SELECT sum(p.amount) FROM advance_payments p WHERE p.advance_id = t.id), 0)::float AS paid,
       (SELECT p.amount::float FROM advance_payments p WHERE p.advance_id = t.id AND p.payroll_month = $1) AS recorded
     FROM advances t
     JOIN residencies e ON e.id = t.employee_id
     LEFT JOIN branches b ON b.id = e.branch_id
     WHERE e.employment_status = 'active' AND t.issue_date <= $2::date
       AND ($3::bigint IS NULL OR e.branch_id = $3::bigint)
     ORDER BY e.name, t.issue_date, t.id`,
    [month, lastDay(month), req.branch || null]);
  const lines = [];
  const noInstallment = [];
  for (const r of rows) {
    const base = {
      advanceId: r.advance_id, employeeId: r.employee_id, name: r.name, iqama: r.iqama_number, branch: r.branch,
      amount: r.amount, issueDate: r.issue_date, installment: r.installment,
    };
    if (r.recorded != null) {
      lines.push({ ...base, before: round(r.amount - r.paid + r.recorded), deduction: r.recorded, after: round(r.amount - r.paid), recorded: true });
      continue;
    }
    const remaining = round(r.amount - r.paid);
    if (remaining <= 0) continue;
    if (!r.installment) {
      noInstallment.push({ ...base, remaining });
      continue;
    }
    const deduction = Math.min(r.installment, remaining);
    lines.push({ ...base, before: remaining, deduction, after: round(remaining - deduction), recorded: false });
  }
  const sum = (list) => round(list.reduce((s, l) => s + l.deduction, 0));
  const pending = lines.filter((l) => !l.recorded);
  return {
    month,
    monthName: monthName(month),
    lines,
    noInstallment,
    totals: {
      employees: new Set(lines.map((l) => l.employeeId)).size,
      deduction: sum(lines),
      pending: pending.length,
      pendingAmount: sum(pending),
      recorded: lines.length - pending.length,
    },
  };
}

router.get('/payroll', async (req, res) => {
  const month = parseMonth(req.query.month);
  if (!month) return res.status(400).json({ error: 'لا يمكن عرض كشف لشهر لم يبدأ بعد' });
  return res.json({ ...(await sheet(req, month)), thisMonth: thisMonth() });
});

// تسجيل أقساط الكشف كدفعات (كلها أو المحددة فقط)
router.post('/payroll/record', async (req, res) => {
  const month = parseMonth(req.body?.month);
  if (!month) return res.status(400).json({ error: 'لا يمكن تسجيل خصم لشهر لم يبدأ بعد' });
  const only = Array.isArray(req.body?.advanceIds) ? new Set(req.body.advanceIds.map(String)) : null;
  const data = await sheet(req, month);
  const todo = data.lines.filter((l) => !l.recorded && (!only || only.has(l.advanceId)));
  if (!todo.length) return res.json({ recorded: 0, amount: 0 });
  // تاريخ الدفعة: آخر يوم في الشهر، أو النهارده لو الشهر لسه ما خلصش
  const paidDate = lastDay(month) < today() ? lastDay(month) : today();
  const note = `خصم راتب ${data.monthName}`;
  const client = await pool.connect();
  let recorded = 0;
  let amount = 0;
  try {
    await client.query('BEGIN');
    for (const l of todo) {
      const r = await client.query(
        `INSERT INTO advance_payments (advance_id, amount, paid_date, note, created_by, payroll_month)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (advance_id, payroll_month) WHERE payroll_month IS NOT NULL DO NOTHING`,
        [l.advanceId, l.deduction, paidDate, note, req.user.name, month]);
      if (r.rowCount) {
        recorded++;
        amount += l.deduction;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  amount = round(amount);
  audit.log(req, 'create', 'advances', '', `كشف خصم السلف لشهر ${data.monthName}: ${recorded} قسط بإجمالي ${amount} ر.س`);
  return res.json({ recorded, amount });
});

// إلغاء تسجيل كشف شهر (لو اتسجل بالغلط)
router.delete('/payroll/record', async (req, res) => {
  const month = parseMonth(req.query.month);
  if (!month) return res.status(400).json({ error: 'الشهر غير صحيح' });
  const { rows } = await pool.query(
    `DELETE FROM advance_payments p USING advances t, residencies e
     WHERE p.advance_id = t.id AND e.id = t.employee_id AND p.payroll_month = $1
       AND ($2::bigint IS NULL OR e.branch_id = $2::bigint)
     RETURNING p.amount::float AS amount`,
    [month, req.branch || null]);
  const amount = round(rows.reduce((s, r) => s + r.amount, 0));
  if (rows.length) audit.log(req, 'delete', 'advances', '', `إلغاء كشف خصم السلف لشهر ${monthName(month)}: ${rows.length} قسط بإجمالي ${amount} ر.س`);
  res.json({ removed: rows.length, amount });
});

router.get('/payroll/export.xlsx', async (req, res) => {
  const month = parseMonth(req.query.month);
  if (!month) return res.status(400).json({ error: 'الشهر غير صحيح' });
  const data = await sheet(req, month);
  const header = ['الموظف', 'رقم الإقامة', 'الفرع', 'تاريخ السلفة', 'مبلغ السلفة', 'المتبقي قبل الخصم', 'الخصم هذا الشهر', 'المتبقي بعد الخصم', 'الحالة'];
  const rows = data.lines.map((l) => [l.name, l.iqama, l.branch, l.issueDate, l.amount, l.before, l.deduction, l.after, l.recorded ? 'مسجّل' : 'غير مسجّل']);
  rows.push(['الإجمالي', '', '', '', '', '', data.totals.deduction, '', '']);
  const sheets = [{ name: `خصم ${month}`, header, rows, widths: [26, 14, 16, 13, 13, 16, 16, 16, 12] }];
  if (data.noInstallment.length) {
    sheets.push({
      name: 'بدون قسط شهري',
      header: ['الموظف', 'رقم الإقامة', 'الفرع', 'تاريخ السلفة', 'مبلغ السلفة', 'المتبقي'],
      rows: data.noInstallment.map((l) => [l.name, l.iqama, l.branch, l.issueDate, l.amount, l.remaining]),
    });
  }
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(`كشف-خصم-السلف-${month}.xlsx`)}`);
  return res.send(writeXlsx(sheets));
});

module.exports = { router, sheet, parseMonth };
