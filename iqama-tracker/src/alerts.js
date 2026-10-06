// تنبيه يومي بالإيميل بالإقامات المنتهية والقريبة من الانتهاء
const nodemailer = require('nodemailer');
const { pool, getAlertDays, getSetting, setSetting } = require('./db');
const { statusCondition, columns, params, today, toApi } = require('./residencies');
const config = require('./config');

const MAX_ROWS = 500;

function emailEnabled() {
  return Boolean(config.smtp.host && config.alertEmails.length);
}

async function collectAlerts(branch = null) {
  const alertDays = await getAlertDays();
  const p = params();
  // المنتهية خلال آخر 30 يوم فقط، حتى لا تتكرر الإقامات القديمة كل يوم
  const expiring = statusCondition('expiring', p, alertDays);
  const recentStart = p.add(new Date(Date.parse(today()) - 30 * 86400000).toISOString().slice(0, 10));
  const todayParam = p.add(today());
  const branchCond = branch ? ` AND branch_id = ${p.add(branch)}` : '';
  const where = `((${expiring}) OR (expiry_date >= ${recentStart}::date AND expiry_date < ${todayParam}::date))${branchCond}`;

  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    pool.query(
      `SELECT ${columns(todayParam)} FROM residencies WHERE ${where}
       ORDER BY expiry_date ASC LIMIT ${MAX_ROWS}`,
      p.values,
    ),
    pool.query(`SELECT count(*)::int AS total FROM residencies WHERE ${where}`, p.values),
  ]);
  return { alertDays, total, items: rows.map((r) => toApi(r, alertDays)) };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function buildEmail({ alertDays, total, items, modules = [] }) {
  const remaining = (d) => (d < 0 ? `منتهية منذ ${-d} يوم` : d === 0 ? 'تنتهي اليوم' : `${d} يوم`);
  const rowsHtml = items.map((r) => `
    <tr style="background:${r.daysLeft < 0 ? '#fee2e2' : '#fef3c7'}">
      <td>${escapeHtml(r.name)}</td><td>${r.iqamaNumber}</td><td>${escapeHtml([r.branchName, r.employer].filter(Boolean).join(' · '))}</td>
      <td>${r.expiryDate}<br><small>${r.expiryDateHijri} هـ</small></td><td>${remaining(r.daysLeft)}</td>
    </tr>`).join('');
  const more = total > items.length ? `<p>و ${total - items.length} إقامة أخرى، راجعي النظام.</p>` : '';

  return {
    subject: `تنبيه: ${total} إقامة منتهية أو ستنتهي خلال ${alertDays} يوم`,
    text: items.map((r) => `${r.name} (${r.iqamaNumber}): ${remaining(r.daysLeft)}`).join('\n'),
    html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif">
      <h2>تنبيه انتهاء الإقامات</h2>
      <p>عدد الإقامات المنتهية حديثًا أو التي ستنتهي خلال ${alertDays} يوم: <b>${total}</b></p>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
        <tr><th>الاسم</th><th>رقم الإقامة</th><th>الفرع / جهة العمل</th><th>تاريخ الانتهاء</th><th>المتبقي</th></tr>
        ${rowsHtml}
      </table>${more}${modulesHtml(modules)}</div>`,
  };
}

let transporter;
// العقود وبطاقات السائقين والسيارات التي تحتاج متابعة
async function collectModuleAlerts() {
  const { MODULES } = require('./modules');
  const { inner, context } = require('./crud');
  const base = await context();
  const sections = [
    ['contracts', ['expiring', 'expired'], (r) => [r.company_name, r.contract_number, r.end_date]],
    ['driver_cards', ['expiring', 'expired'], (r) => [r.employee_name, r.card_number, r.expiry_date]],
    ['employee_docs', ['expiring', 'expired'], (r) => [r.employee_name, `${r.doc_type}${r.doc_number ? ` ${r.doc_number}` : ''}`, r.expiry_date]],
    ['visas', ['late'], (r) => [r.employee_name, r.visa_type, `آخر موعد للعودة ${r.return_deadline}`]],
    ['cars', ['attention', 'expired'], (r) => [r.plate_number, r.driver_name || '', [
      r.registration_expiry && `الاستمارة ${r.registration_expiry}`,
      r.insurance_expiry && `التأمين ${r.insurance_expiry}`,
      r.next_service_date && `الصيانة ${r.next_service_date}`,
    ].filter(Boolean).join(' · ')]],
  ];
  const out = [];
  for (const [key, statuses, cols] of sections) {
    const m = MODULES[key];
    const { sql, p } = inner(m, base);
    const { rows } = await pool.query(
      `SELECT * FROM (${sql}) x WHERE status = ANY(${p.add(statuses)}) ORDER BY ${m.sort} LIMIT 100`,
      p.values,
    );
    if (rows.length) {
      out.push({ label: m.label, rows: rows.map((r) => ({ cells: cols(r), status: m.statuses[r.status].label, expired: m.statuses[r.status].tone === 'expired' })) });
    }
  }
  return out;
}

function modulesHtml(modules) {
  return modules.map((s) => `
    <h3 style="margin-top:24px">${escapeHtml(s.label)} (${s.rows.length})</h3>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      ${s.rows.map((r) => `<tr style="background:${r.expired ? '#fee2e2' : '#fef3c7'}">
        ${r.cells.map((c) => `<td>${escapeHtml(c ?? '')}</td>`).join('')}<td>${escapeHtml(r.status)}</td></tr>`).join('')}
    </table>`).join('');
}

async function sendAlertEmail() {
  if (!emailEnabled()) throw new Error('إعدادات SMTP أو ALERT_EMAILS غير مضبوطة');
  const data = await collectAlerts();
  data.modules = await collectModuleAlerts();
  const moduleCount = data.modules.reduce((n, sct) => n + sct.rows.length, 0);
  if (!data.total && !moduleCount) return { sent: false, total: 0 };
  transporter ||= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transporter.sendMail({ from: config.smtp.from, to: config.alertEmails, ...buildEmail(data) });
  return { sent: true, total: data.total + moduleCount };
}

// يُفحص كل ساعة، ويُرسل مرة واحدة يوميًا بعد ساعة ALERT_HOUR بتوقيت السعودية
async function dailyCheck() {
  if (!emailEnabled()) return;
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: config.timeZone, hour: 'numeric', hourCycle: 'h23',
  }).format(new Date()));
  if (hour < config.alertHour) return;
  if ((await getSetting('last_alert_email')) === today()) return;
  try {
    const result = await sendAlertEmail();
    await setSetting('last_alert_email', today());
    if (result.sent) console.log(`تم إرسال إيميل التنبيه (${result.total} إقامة)`);
  } catch (err) {
    console.error('فشل إرسال إيميل التنبيه:', err.message);
  }
}

function startScheduler() {
  if (!emailEnabled()) {
    console.log('تنبيهات الإيميل غير مفعلة (اضبطي SMTP_HOST و ALERT_EMAILS في ملف .env)');
    return;
  }
  dailyCheck();
  setInterval(dailyCheck, 60 * 60 * 1000).unref();
}

module.exports = { collectAlerts, collectModuleAlerts, buildEmail, sendAlertEmail, startScheduler, emailEnabled };
