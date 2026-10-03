// تنبيه يومي بالإيميل بالإقامات المنتهية والقريبة من الانتهاء
const nodemailer = require('nodemailer');
const { pool, getAlertDays, getSetting, setSetting } = require('./db');
const { statusCondition, columns, params, today, toApi } = require('./residencies');
const config = require('./config');

const MAX_ROWS = 500;

function emailEnabled() {
  return Boolean(config.smtp.host && config.alertEmails.length);
}

async function collectAlerts() {
  const alertDays = await getAlertDays();
  const p = params();
  // المنتهية خلال آخر 30 يوم فقط، حتى لا تتكرر الإقامات القديمة كل يوم
  const expiring = statusCondition('expiring', p, alertDays);
  const recentStart = p.add(new Date(Date.parse(today()) - 30 * 86400000).toISOString().slice(0, 10));
  const todayParam = p.add(today());
  const where = `(${expiring}) OR (expiry_date >= ${recentStart}::date AND expiry_date < ${todayParam}::date)`;

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

function buildEmail({ alertDays, total, items }) {
  const remaining = (d) => (d < 0 ? `منتهية منذ ${-d} يوم` : d === 0 ? 'تنتهي اليوم' : `${d} يوم`);
  const rowsHtml = items.map((r) => `
    <tr style="background:${r.daysLeft < 0 ? '#fee2e2' : '#fef3c7'}">
      <td>${escapeHtml(r.name)}</td><td>${r.iqamaNumber}</td><td>${escapeHtml(r.employer)}</td>
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
        <tr><th>الاسم</th><th>رقم الإقامة</th><th>جهة العمل</th><th>تاريخ الانتهاء</th><th>المتبقي</th></tr>
        ${rowsHtml}
      </table>${more}</div>`,
  };
}

let transporter;
async function sendAlertEmail() {
  if (!emailEnabled()) throw new Error('إعدادات SMTP أو ALERT_EMAILS غير مضبوطة');
  const data = await collectAlerts();
  if (!data.total) return { sent: false, total: 0 };
  transporter ||= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transporter.sendMail({ from: config.smtp.from, to: config.alertEmails, ...buildEmail(data) });
  return { sent: true, total: data.total };
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

module.exports = { collectAlerts, buildEmail, sendAlertEmail, startScheduler, emailEnabled };
