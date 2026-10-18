// اختبارات بوابة الموظف: الموظف يشوف ملفه بس ويطلب إجازة، وكل الأقسام التانية مقفولة عليه
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

test('بوابة الموظف', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin')", [hashPassword('secret123')]);
  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const login = async (u, p = 'secret123') => {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    return { cookie: res.headers.get('set-cookie')?.split(';')[0], data: await res.json() };
  };
  const admin = (await login('boss')).cookie;
  const call = async (url, method = 'GET', body, c = admin) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const a = (await call('/residencies', 'POST', { name: 'سالم أحمد', iqamaNumber: '2000000001', expiryDate: isoInDays(40), nationality: 'مصري' })).data;
  const b = (await call('/residencies', 'POST', { name: 'ماجد', iqamaNumber: '2000000002', expiryDate: isoInDays(5) })).data;
  await call('/m/employee_docs', 'POST', { employee_id: a.id, doc_type: 'جواز السفر', doc_number: 'A123', expiry_date: isoInDays(10) });
  await call('/m/employee_docs', 'POST', { employee_id: b.id, doc_type: 'جواز السفر', doc_number: 'B999', expiry_date: isoInDays(10) });
  const adv = (await call('/m/advances', 'POST', { employee_id: a.id, amount: 1000, issue_date: isoInDays(-30), monthly_installment: 250 })).data;
  await call(`/m/advances/${adv.id}/payments`, 'POST', { amount: 250, paid_date: isoInDays(-1) });
  await call('/m/custody', 'POST', { employee_id: a.id, item_name: 'لابتوب', handed_date: isoInDays(-60) });
  await call('/m/leaves', 'POST', { employee_id: a.id, leave_type: 'سنوية', approval: 'معتمدة', start_date: isoInDays(-20), end_date: isoInDays(-16) });

  let emp;
  await t.test('حساب الموظف', async () => {
    assert.equal((await call('/users', 'POST', { username: 'salem', password: 'emp-pass-1', role: 'employee' })).status, 400);
    const u = await call('/users', 'POST', { username: 'salem', password: 'emp-pass-1', role: 'employee', employee_id: a.id, branch_id: '1' });
    assert.equal(u.status, 201);
    assert.equal(u.data.employee_name, 'سالم أحمد');
    assert.equal(u.data.branch_id, null);
    const dup = await call('/users', 'POST', { username: 'salem2', password: 'emp-pass-1', role: 'employee', employee_id: a.id });
    assert.equal(dup.status, 409);
    assert.match(dup.data.error, /عنده حساب/);
    const l = await login('salem', 'emp-pass-1');
    assert.equal(l.data.home, '/portal.html');
    emp = l.cookie;
    assert.equal((await login('boss')).data.home, '/');
  });

  await t.test('بياناته هو بس', async () => {
    const p = (await call('/portal', 'GET', null, emp)).data;
    assert.equal(p.employee.name, 'سالم أحمد');
    assert.equal(p.employee.daysLeft, 40);
    assert.equal(p.employee.status, 'valid');
    assert.deepEqual(p.docs.map((d) => d.number), ['A123']);
    assert.equal(p.docs[0].status, 'expiring');
    assert.deepEqual(p.advances.map((x) => x.remaining), [750]);
    assert.deepEqual(p.custody.map((c) => c.item), ['لابتوب']);
    assert.deepEqual([p.leave.entitlement, p.leave.used, p.leave.balance], [21, 5, 16]);
    assert.equal((await fetch(`${base}/portal/photo`, { headers: { cookie: emp } })).status, 404);
    // حساب مش موظف ما يدخلش البوابة
    assert.equal((await call('/portal', 'GET', null, admin)).status, 403);
  });

  await t.test('كل الأقسام التانية مقفولة', async () => {
    for (const url of ['/residencies', `/residencies/${b.id}`, '/m/leaves', '/m/advances', '/employees?q=م', '/stats', '/overview',
      '/reports', '/reports/expiries', '/calendar', '/settings', '/users', '/audit', '/backup', '/schema', '/branches', '/costs',
      `/employees/${b.id}/summary`, `/documents?entity=residencies&id=${a.id}`]) {
      assert.equal((await call(url, 'GET', null, emp)).status, 403, url);
    }
    assert.equal((await call('/m/leaves', 'POST', { employee_id: b.id, leave_type: 'سنوية', start_date: isoInDays(1), end_date: isoInDays(2) }, emp)).status, 403);
    assert.equal((await call('/me', 'GET', null, emp)).status, 200);
    assert.equal((await call('/me/2fa', 'GET', null, emp)).status, 200);
  });

  let req1;
  await t.test('طلب الإجازة', async () => {
    assert.equal((await call('/portal/leaves', 'POST', { type: 'سفر', start: isoInDays(5), end: isoInDays(9) }, emp)).status, 400);
    assert.equal((await call('/portal/leaves', 'POST', { type: 'سنوية', start: isoInDays(9), end: isoInDays(5) }, emp)).status, 400);
    const ok = await call('/portal/leaves', 'POST', { type: 'سنوية', start: isoInDays(5), end: isoInDays(9), reason: 'سفر للأهل' }, emp);
    assert.equal(ok.status, 201);
    req1 = ok.data.id;
    assert.equal((await call('/portal/leaves', 'POST', { type: 'اضطرارية', start: isoInDays(8), end: isoInDays(10) }, emp)).status, 409);
    // يوصل لشؤون الموظفين بانتظار الاعتماد
    const pending = (await call('/m/leaves?status=pending')).data.items;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].employee_name, 'سالم أحمد');
    assert.match(pending[0].notes, /بوابة الموظف: سفر للأهل/);
  });

  await t.test('إلغاء الطلب المعلّق بس', async () => {
    const approved = (await call('/m/leaves?status=finished')).data.items[0];
    assert.equal((await call(`/portal/leaves/${approved.id}`, 'DELETE', null, emp)).status, 404);
    assert.equal((await call(`/portal/leaves/${req1}`, 'DELETE', null, emp)).status, 204);
    assert.equal((await call('/m/leaves?status=pending')).data.items.length, 0);
  });

  await t.test('الموظف اللي ترك العمل', async () => {
    await call(`/residencies/${a.id}/employment`, 'PUT', { status: 'left', leftDate: isoInDays(0), leftReason: 'استقالة' });
    const r = await call('/portal', 'GET', null, emp);
    assert.equal(r.status, 403);
    assert.match(r.data.error, /غير نشط/);
  });
});
