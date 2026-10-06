// اختبارات التقويم والتقارير واسم المنشأة
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';

function isoInDays(n) {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('التقويم والتقارير', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');

  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("UPDATE settings SET value = '30' WHERE key = 'alert_days'");
  await pool.query("DELETE FROM settings WHERE key = 'company_name'");
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin')", [hashPassword('secret123')]);

  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const login = async (u) => (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }),
  })).headers.get('set-cookie').split(';')[0];
  const as = (cookie) => async (url, method = 'GET', body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const admin = as(await login('boss'));

  const b1 = (await admin('/m/branches', 'POST', { name: 'أ' })).data;
  const b2 = (await admin('/m/branches', 'POST', { name: 'ب' })).data;
  const emp = (await admin('/residencies', 'POST', { name: 'سالم', iqamaNumber: '2000000001', expiryDate: isoInDays(5), branchId: b1.id })).data;
  const emp2 = (await admin('/residencies', 'POST', { name: 'ماجد', iqamaNumber: '2000000002', expiryDate: isoInDays(5), branchId: b2.id })).data;
  await admin('/m/contracts', 'POST', { company_name: 'شركة', end_date: isoInDays(5), branch_id: b1.id });
  await admin('/m/employee_docs', 'POST', { employee_id: emp.id, doc_type: 'جواز السفر', expiry_date: isoInDays(-3) });
  await admin('/m/visas', 'POST', { employee_id: emp.id, visa_type: 'خروج وعودة مفردة', departure_date: isoInDays(-10), return_deadline: isoInDays(5) });
  await admin('/m/leaves', 'POST', { employee_id: emp2.id, leave_type: 'سنوية', approval: 'معتمدة', start_date: isoInDays(5), end_date: isoInDays(7) });
  const car = (await admin('/m/cars', 'POST', { plate_number: 'أ ب ج 1', registration_expiry: isoInDays(5), value: 50000, branch_id: b1.id })).data;
  await admin(`/m/cars/${car.id}/events`, 'POST', { event_date: isoInDays(-1), event_type: 'صيانة دورية', cost: 300, next_service_date: isoInDays(5) });
  await admin('/m/advances', 'POST', { employee_id: emp.id, amount: 1000, issue_date: isoInDays(-1) });

  await t.test('التقويم يجمع كل الأنواع في اليوم', async () => {
    const day = isoInDays(5);
    const cal = (await admin(`/calendar?month=${day.slice(0, 7)}`)).data;
    const types = cal.days[day].map((x) => x.type).sort();
    assert.deepEqual(types, ['car_registration', 'car_service', 'contract', 'leave_start', 'residency', 'visa_return']);
    assert.equal(cal.days[day].find((x) => x.type === 'residency').count, 2);
    const items = (await admin(`/calendar/items?from=${day}`)).data.items;
    assert.equal(items.length, 7);
    assert.ok(items.every((x) => x.id && x.title));
    const range = (await admin(`/calendar/items?from=${isoInDays(-5)}&to=${isoInDays(10)}`)).data.items;
    assert.ok(range.some((x) => x.type === 'employee_doc'));
    assert.ok(range.some((x) => x.type === 'leave_end' && x.date === isoInDays(8)));
  });

  await t.test('التقويم يحترم الفرع', async () => {
    await admin('/users', 'POST', { username: 'hr.b', role: 'hr', password: 'secret123', branch_id: b2.id });
    const hr = as(await login('hr.b'));
    const day = isoInDays(5);
    const items = (await hr(`/calendar/items?from=${day}`)).data.items;
    assert.deepEqual(items.map((x) => x.type).sort(), ['leave_start', 'residency']);
    assert.equal((await hr(`/reports/employee?id=${emp.id}`)).status, 404);
    assert.equal((await hr('/reports/residencies')).data.sections[0].rows.length, 1);
  });

  await t.test('التقارير', async () => {
    const list = (await admin('/reports')).data.map((r) => r.key);
    assert.deepEqual(list, ['residencies', 'expiries', 'advances', 'custody', 'cars', 'employee']);

    const res = (await admin('/reports/residencies?days=30')).data;
    assert.equal(res.sections[0].rows.length, 2);
    assert.equal(res.kpis[0].value, 2);
    assert.equal(res.today, isoInDays(0));
    assert.ok(res.todayHijri);

    const exp = (await admin('/reports/expiries?days=30&overdue=10')).data;
    assert.ok(exp.sections.some((s) => s.title === 'انتهاء مستند موظف'));
    assert.equal(exp.kpis[1].value, 1); // المستند المنتهي

    const adv = (await admin('/reports/advances')).data;
    assert.equal(adv.kpis[2].value, 1000);
    assert.equal(adv.sections[0].totals[6], 1000);

    const cars = (await admin(`/reports/cars?from=${isoInDays(-30)}`)).data;
    assert.equal(cars.kpis[2].value, 300);
    const carsLater = (await admin(`/reports/cars?from=${isoInDays(1)}`)).data;
    assert.equal(carsLater.kpis[2].value, 0);

    const profile = (await admin(`/reports/employee?id=${emp.id}`)).data;
    assert.equal(profile.title, 'ملف الموظف: سالم');
    assert.equal(profile.sections.find((s) => s.title === 'المستندات').rows.length, 1);
    assert.equal((await admin('/reports/employee?id=abc')).status, 404);
    assert.equal((await admin('/reports/nope')).status, 404);
  });

  await t.test('اسم المنشأة يظهر في التقارير', async () => {
    assert.equal((await admin('/settings', 'PUT', { companyName: 'شركة النخبة' })).data.companyName, 'شركة النخبة');
    assert.equal((await admin('/settings')).data.alertDays, 30);
    assert.equal((await admin('/reports/custody')).data.company, 'شركة النخبة');
    const viewerCreated = await admin('/users', 'POST', { username: 'viewer1', role: 'viewer', password: 'secret123' });
    assert.equal(viewerCreated.status, 201);
    const viewer = as(await login('viewer1'));
    assert.equal((await viewer('/settings', 'PUT', { companyName: 'x' })).status, 403);
  });
});
