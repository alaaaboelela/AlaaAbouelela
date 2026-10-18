// اختبارات تذكير الموظفين بالـ SMS (بدون إرسال حقيقي: نلتقط الطلبات بدل إرسالها)
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';
process.env.ALERT_PHONES = '';
process.env.SMS_PROVIDER = 'unifonic';
process.env.UNIFONIC_APP_SID = 'app-sid';
process.env.SMS_SENDER = 'IQAMA';

function isoInDays(n) {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('مواعيد التذكير', () => {
  const { parseDays } = require('../src/reminders');
  assert.deepEqual(parseDays('7، 30'), [30, 7]);
  assert.deepEqual(parseDays('٣٠,٧ 0'), [30, 7, 0]);
  assert.equal(parseDays('200'), null);
  assert.equal(parseDays('1,2,3,4'), null);
  assert.equal(parseDays(''), null);
});

test('تذكير الموظفين بالـ SMS', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate, setSetting } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  const notify = require('../src/notify');
  const reminders = require('../src/reminders');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("DELETE FROM settings WHERE key LIKE 'employee_sms_%'");
  await setSetting('company_name', 'مؤسسة الاختبار');
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin'), ('hr1', $1, 'hr')", [hashPassword('secret123')]);

  const sent = [];
  const failFor = new Set();
  notify.setTransport(async (url, options) => {
    const form = new URLSearchParams(options.body);
    if (failFor.has(form.get('Recipient'))) return { ok: false, status: 400, body: { success: false, message: 'Invalid recipient' } };
    sent.push({ to: form.get('Recipient'), text: form.get('Body') });
    return { ok: true, status: 200, body: { success: true } };
  });

  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const login = async (u) => (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }),
  })).headers.get('set-cookie').split(';')[0];
  const cookie = await login('boss');
  const call = async (url, method = 'GET', body, c = cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const add = async (name, iqama, days, phone) => (await call('/residencies', 'POST', {
    name, iqamaNumber: iqama, expiryDate: isoInDays(days), phone,
  })).data;

  const a = await add('سالم', '2000000001', 25, '0501111111');
  const b = await add('ماجد', '2000000002', 5, '+966 55 222 2222');
  await add('بدون جوال', '2000000003', 10, '');
  await add('رقم غلط', '2000000004', 10, '123');
  const left = await add('ترك العمل', '2000000005', 5, '0503333333');
  await call(`/residencies/${left.id}/employment`, 'PUT', { status: 'left', leftDate: isoInDays(-1), leftReason: 'استقالة' });
  await add('بعيد', '2000000006', 60, '0504444444');
  await add('منتهية', '2000000007', -1, '0505555555');

  await t.test('الصلاحيات والحالة', async () => {
    assert.equal((await call('/reminders', 'GET', null, await login('hr1'))).status, 403);
    const r = (await call('/reminders')).data;
    assert.equal(r.enabled, false);
    assert.deepEqual(r.days, [30, 7]);
    assert.equal(r.providerReady, true);
    assert.equal(r.due, 2);
    assert.equal(r.noPhone, 2);
    assert.equal(r.sample['{المنشأة}'], 'مؤسسة الاختبار');
  });

  await t.test('الإعدادات', async () => {
    assert.equal((await call('/reminders', 'PUT', { days: '200' })).status, 400);
    const saved = await call('/reminders', 'PUT', { enabled: true, days: '7، 30', template: 'أهلًا {الاسم}، إقامتك {رقم_الإقامة} باقي عليها {الأيام} يوم. {المنشأة}' });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.enabled, true);
    assert.deepEqual(saved.data.days, [30, 7]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call('/audit?action=settings')).data.items.length, 1);
  });

  await t.test('الإرسال مرة واحدة لكل موعد', async () => {
    sent.length = 0;
    const res = (await call('/reminders/run', 'POST')).data;
    assert.deepEqual([res.sent, res.failed, res.noPhone], [2, 0, 2]);
    assert.deepEqual(sent.map((m) => m.to).sort(), ['966501111111', '966552222222']);
    assert.equal(sent.find((m) => m.to === '966501111111').text, 'أهلًا سالم، إقامتك 2000000001 باقي عليها 25 يوم. مؤسسة الاختبار');

    sent.length = 0;
    assert.equal((await call('/reminders/run', 'POST')).data.sent, 0);
    assert.equal(sent.length, 0);
    assert.equal((await call('/reminders')).data.recent.length, 2);

    // مرور الوقت: سالم بقى فاضله 6 أيام على نفس تاريخ الانتهاء ← موعد الـ 7 أيام
    await pool.query('UPDATE residencies SET expiry_date = $1 WHERE id = $2', [isoInDays(6), a.id]);
    await pool.query('UPDATE employee_notices SET expiry_date = $1 WHERE residency_id = $2', [isoInDays(6), a.id]);
    assert.equal((await call('/reminders/run', 'POST')).data.sent, 1);
    assert.equal(sent[0].to, '966501111111');

    // تجديد الإقامة لسنة: يخرج من التذكير، ولو قرب تاني يتبعتله من جديد
    await call(`/residencies/${b.id}`, 'PUT', { name: 'ماجد', iqamaNumber: '2000000002', expiryDate: isoInDays(400), phone: '0552222222' });
    assert.equal((await call('/reminders')).data.due, 0);
    await pool.query('UPDATE residencies SET expiry_date = $1 WHERE id = $2', [isoInDays(20), b.id]);
    assert.equal((await call('/reminders')).data.due, 1);
  });

  await t.test('المحاولات الفاشلة تتكرر 3 مرات بس', async () => {
    failFor.add('966552222222');
    for (let i = 0; i < 4; i++) await reminders.run();
    const { rows } = await pool.query('SELECT status, attempts, error FROM employee_notices WHERE residency_id = $1 AND expiry_date = $2', [b.id, isoInDays(20)]);
    assert.deepEqual([rows[0].status, rows[0].attempts], ['failed', 3]);
    assert.match(rows[0].error, /Invalid recipient/);
    assert.equal((await call('/reminders')).data.due, 0);
    failFor.clear();
  });

  await t.test('التشغيل اليومي مرة واحدة', async () => {
    await pool.query("DELETE FROM settings WHERE key = 'employee_sms_day'");
    await pool.query('UPDATE residencies SET expiry_date = $1 WHERE id = $2', [isoInDays(3), b.id]);
    sent.length = 0;
    assert.equal((await reminders.dailyRun()).sent, 1);
    assert.equal(await reminders.dailyRun(), null);
    await call('/reminders', 'PUT', { enabled: false });
    await pool.query("DELETE FROM settings WHERE key = 'employee_sms_day'");
    assert.equal(await reminders.dailyRun(), null);
    assert.equal(sent.length, 1);
  });

  await t.test('رسالة تجربة', async () => {
    assert.equal((await call('/reminders/test', 'POST', { phone: 'abc' })).status, 400);
    sent.length = 0;
    const r = await call('/reminders/test', 'POST', { phone: '0509999999' });
    assert.equal(r.status, 200);
    assert.equal(sent[0].to, '966509999999');
    assert.match(sent[0].text, /محمد أحمد/);
    assert.match(sent[0].text, /باقي عليها 30 يوم/);
    const [y, m, d] = isoInDays(30).split('-');
    assert.equal(reminders.render('{تاريخ_الانتهاء} {الاسم}', { name: 'س', expiry_date: isoInDays(30) }, ''), `${d}/${m}/${y} س`);
    const left = (n) => reminders.render('تنتهي {المتبقي}', { name: '', expiry_date: isoInDays(n), days_left: n }, '');
    assert.deepEqual([0, 1, 2, 7, 25].map(left), ['تنتهي اليوم', 'تنتهي غدًا', 'تنتهي بعد يومين', 'تنتهي بعد 7 أيام', 'تنتهي بعد 25 يوم']);
  });
});
