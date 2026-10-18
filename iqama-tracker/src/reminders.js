// تذكير الموظف نفسه برسالة SMS على جواله قبل انتهاء إقامته:
// رسالة واحدة عند كل موعد (مثلًا قبل 30 يوم وقبل 7 أيام) ولكل تاريخ انتهاء، فلو اتجددت الإقامة يبدأ العد من جديد
const express = require('express');
const { pool, getSetting, setSetting } = require('./db');
const { today, addDays } = require('./residencies');
const { gregorianToHijri } = require('../public/hijri');
const notify = require('./notify');
const audit = require('./audit');

// صياغة تصلح للموظف والموظفة
const DEFAULT_TEMPLATE = '{الاسم}، نذكّرك بأن إقامتك رقم {رقم_الإقامة} تنتهي {المتبقي} ({تاريخ_الانتهاء}). يرجى مراجعة شؤون الموظفين لتجديدها. {المنشأة}';
const MAX_ATTEMPTS = 3;
const str = (v) => (v == null ? '' : String(v).trim());

// "30، 7" → [30, 7] (من الأكبر للأصغر، 3 مواعيد بحد أقصى)
function parseDays(v) {
  const list = String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).split(/[,،\s]+/).filter(Boolean).map(Number);
  if (!list.length || list.some((n) => !Number.isInteger(n) || n < 0 || n > 180)) return null;
  const days = [...new Set(list)].sort((a, b) => b - a);
  return days.length <= 3 ? days : null;
}

async function getConfig() {
  return {
    enabled: (await getSetting('employee_sms_enabled')) === 'true',
    days: parseDays(await getSetting('employee_sms_days')) || [30, 7],
    template: (await getSetting('employee_sms_template')) || DEFAULT_TEMPLATE,
  };
}

function remainingText(days) {
  if (days <= 0) return 'اليوم';
  if (days === 1) return 'غدًا';
  if (days === 2) return 'بعد يومين';
  return `بعد ${days} ${days <= 10 ? 'أيام' : 'يوم'}`;
}

function placeholders(r, company) {
  return {
    '{الاسم}': r.name,
    '{رقم_الإقامة}': r.iqama_number,
    '{تاريخ_الانتهاء}': r.expiry_date.split('-').reverse().join('/'),
    '{التاريخ_الهجري}': `${gregorianToHijri(r.expiry_date)} هـ`,
    '{الأيام}': String(r.days_left),
    '{المتبقي}': remainingText(r.days_left),
    '{المنشأة}': company,
  };
}

function render(template, r, company) {
  const values = placeholders(r, company);
  return template.replace(/\{[^{}]+\}/g, (k) => values[k] ?? k).replace(/[ \t]+/g, ' ').trim();
}

// موظف مثال للمعاينة ورسالة التجربة
const sampleEmployee = (cfg) => ({ name: 'محمد أحمد', iqama_number: '2123456789', expiry_date: addDays(today(), cfg.days[0]), days_left: cfg.days[0] });

// الموظفون المستحق لهم رسالة الآن: أقرب موعد لسه ما اتبعتلوش (أو فشل وفيه محاولات متبقية)
async function due(cfg, branch = null) {
  const max = Math.max(...cfg.days);
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.iqama_number, e.expiry_date, e.phone, (e.expiry_date - $1::date) AS days_left
     FROM residencies e
     WHERE e.employment_status = 'active' AND e.expiry_date BETWEEN $1::date AND $1::date + $2::int
       AND ($3::bigint IS NULL OR e.branch_id = $3::bigint)
     ORDER BY e.expiry_date, e.id`,
    [today(), max, branch]);
  if (!rows.length) return { list: [], noPhone: 0 };
  const { rows: sent } = await pool.query(
    `SELECT residency_id, expiry_date, threshold, status, attempts FROM employee_notices
     WHERE residency_id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
  const done = new Map(sent.map((n) => [`${n.residency_id}|${n.expiry_date}|${n.threshold}`, n]));
  const list = [];
  let noPhone = 0;
  for (const r of rows) {
    const threshold = Math.min(...cfg.days.filter((d) => d >= r.days_left));
    const prev = done.get(`${r.id}|${r.expiry_date}|${threshold}`);
    if (prev && (prev.status === 'sent' || prev.attempts >= MAX_ATTEMPTS)) continue;
    const phone = notify.normalizePhone(r.phone);
    if (!phone) {
      noPhone++;
      continue;
    }
    list.push({ ...r, threshold, phone, attempts: prev ? prev.attempts : 0 });
  }
  return { list, noPhone };
}

async function record(r, message, error) {
  await pool.query(
    `INSERT INTO employee_notices (residency_id, expiry_date, threshold, phone, message, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (residency_id, expiry_date, threshold) DO UPDATE SET
       phone = EXCLUDED.phone, message = EXCLUDED.message, status = EXCLUDED.status, error = EXCLUDED.error,
       attempts = employee_notices.attempts + 1, sent_at = now()`,
    [r.id, r.expiry_date, r.threshold, r.phone, message, error ? 'failed' : 'sent', error ? error.slice(0, 300) : '']);
}

/** إرسال كل الرسائل المستحقة. يتوقف بعد 3 أخطاء متتالية (غالبًا مشكلة في حساب المزود) */
let running = null;
function run() {
  // تشغيل واحد في نفس الوقت (اليومي واليدوي) حتى لا تتكرر الرسالة
  running ||= sendDue().finally(() => { running = null; });
  return running;
}

async function sendDue() {
  if (!notify.smsProviderReady()) throw new Error('حساب مزود SMS غير مضبوط في ملف .env');
  const cfg = await getConfig();
  const company = (await getSetting('company_name')) || '';
  const { list, noPhone } = await due(cfg);
  const result = { sent: 0, failed: 0, noPhone, error: null };
  let streak = 0;
  for (const r of list) {
    const message = render(cfg.template, r, company);
    try {
      await notify.sendSms([r.phone], message);
      await record(r, message, null);
      result.sent++;
      streak = 0;
    } catch (err) {
      await record(r, message, err.message);
      result.failed++;
      result.error = err.message;
      if (++streak >= 3) break;
    }
  }
  await setSetting('employee_sms_last_run', JSON.stringify({ at: new Date().toISOString(), ...result }));
  return result;
}

// يُستدعى من الفحص اليومي: مرة واحدة في اليوم ولو التذكير مفعّل
async function dailyRun() {
  if (!notify.smsProviderReady() || !(await getConfig()).enabled) return null;
  if ((await getSetting('employee_sms_day')) === today()) return null;
  await setSetting('employee_sms_day', today());
  return run();
}

// ---------- المسارات (قسم الإعدادات) ----------

const router = express.Router();

router.get('/reminders', async (req, res) => {
  const cfg = await getConfig();
  const { list, noPhone } = await due(cfg, req.branch);
  const { rows } = await pool.query(
    `SELECT n.id, n.residency_id, e.name, n.phone, n.threshold, n.status, n.error, n.sent_at
     FROM employee_notices n JOIN residencies e ON e.id = n.residency_id
     WHERE ($1::bigint IS NULL OR e.branch_id = $1::bigint)
     ORDER BY n.sent_at DESC, n.id DESC LIMIT 15`, [req.branch || null]);
  let lastRun = null;
  try { lastRun = JSON.parse((await getSetting('employee_sms_last_run')) || 'null'); } catch { /* تجاهل */ }
  const s = list[0] || sampleEmployee(cfg);
  const company = (await getSetting('company_name')) || '';
  res.json({
    ...cfg,
    defaultTemplate: DEFAULT_TEMPLATE,
    providerReady: notify.smsProviderReady(),
    provider: notify.status().sms.provider,
    due: list.length,
    noPhone,
    // قيم مثال لمعاينة الرسالة في الواجهة
    sample: placeholders(s, company),
    lastRun,
    recent: rows.map((r) => ({ ...r, id: String(r.id), residency_id: String(r.residency_id), phone: r.phone.replace(/^(\d{5})\d+(\d{3})$/, '$1•••$2') })),
  });
});

router.put('/reminders', async (req, res) => {
  const body = req.body || {};
  const cfg = await getConfig();
  const changes = [];
  if (body.enabled !== undefined) {
    const enabled = body.enabled === true || body.enabled === 'true';
    if (enabled && !notify.smsProviderReady()) return res.status(400).json({ error: 'اضبطي حساب مزود SMS في ملف .env أولًا' });
    await setSetting('employee_sms_enabled', enabled);
    if (enabled !== cfg.enabled) changes.push(enabled ? 'تفعيل تذكير الموظفين بالـ SMS' : 'إيقاف تذكير الموظفين بالـ SMS');
  }
  if (body.days !== undefined) {
    const days = parseDays(Array.isArray(body.days) ? body.days.join(',') : body.days);
    if (!days) return res.status(400).json({ error: 'المواعيد أرقام من 0 إلى 180 يوم، 3 مواعيد بحد أقصى (مثال: 30، 7)' });
    await setSetting('employee_sms_days', days.join(','));
    if (days.join() !== cfg.days.join()) changes.push(`مواعيد التذكير: ${days.join('، ')} يوم`);
  }
  if (body.template !== undefined) {
    const template = str(body.template).slice(0, 480) || DEFAULT_TEMPLATE;
    await setSetting('employee_sms_template', template);
    if (template !== cfg.template) changes.push('نص رسالة التذكير');
  }
  if (changes.length) audit.log(req, 'settings', 'settings', '', changes.join('، '));
  return res.json(await getConfig());
});

router.post('/reminders/run', async (req, res) => {
  try {
    const result = await run();
    audit.log(req, 'settings', 'settings', '', `إرسال تذكير الموظفين يدويًا: ${result.sent} رسالة${result.failed ? `، ${result.failed} فشلت` : ''}`);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// رسالة تجربة على رقم واحد (بدون تسجيلها كتذكير لموظف)
router.post('/reminders/test', async (req, res) => {
  const phone = notify.normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'رقم الجوال غير صحيح' });
  if (!notify.smsProviderReady()) return res.status(400).json({ error: 'حساب مزود SMS غير مضبوط في ملف .env' });
  const cfg = await getConfig();
  const text = render(cfg.template, sampleEmployee(cfg), (await getSetting('company_name')) || '');
  try {
    await notify.sendSms([phone], text);
    res.json({ sent: true, text });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = { router, run, dailyRun, due, render, parseDays, getConfig, DEFAULT_TEMPLATE };
