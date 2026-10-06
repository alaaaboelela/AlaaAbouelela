// اختبارات الصلاحيات وإدارة المستخدمين وسجل العمليات
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';

test('الصلاحيات وسجل العمليات', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');

  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves RESTART IDENTITY CASCADE`);
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin')", [hashPassword('bosspass1')]);

  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;

  async function login(username, password) {
    const res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const as = (cookie) => async (url, method = 'GET', body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* نص */ }
    return { status: res.status, data };
  };

  const admin = as((await login('boss', 'bosspass1')).cookie);

  await t.test('المدير ينشئ مستخدمين بأدوار مختلفة', async () => {
    assert.equal((await admin('/users', 'POST', { username: 'X y', role: 'hr', password: 'secret123' })).status, 400);
    assert.equal((await admin('/users', 'POST', { username: 'hr1', role: 'nope', password: 'secret123' })).status, 400);
    for (const [username, role] of [['hr1', 'hr'], ['acc1', 'accountant'], ['view1', 'viewer']]) {
      const r = await admin('/users', 'POST', { username, full_name: username.toUpperCase(), role, password: 'secret123' });
      assert.equal(r.status, 201);
    }
    assert.equal((await admin('/users', 'POST', { username: 'hr1', role: 'hr', password: 'secret123' })).status, 409);
    assert.equal((await admin('/users')).data.length, 4);
  });

  await t.test('الصلاحيات تُطبّق في الخادم', async () => {
    const hr = as((await login('hr1', 'secret123')).cookie);
    const acc = as((await login('acc1', 'secret123')).cookie);
    const viewer = as((await login('view1', 'secret123')).cookie);

    const me = (await hr('/me')).data;
    assert.equal(me.role, 'hr');
    assert.equal(me.permissions.residencies, 'write');
    assert.equal(me.permissions.advances, 'read');
    assert.equal(me.permissions.users, null);

    const emp = await hr('/residencies', 'POST', { name: 'سالم', iqamaNumber: '2000000001', expiryDate: '2027-01-01' });
    assert.equal(emp.status, 201);
    // الموارد البشرية تقرأ السلف ولا تضيفها
    assert.equal((await hr('/m/advances')).status, 200);
    assert.equal((await hr('/m/advances', 'POST', { employee_id: emp.data.id, amount: 100, issue_date: '2026-10-01' })).status, 403);
    // المحاسب يضيف السلف ولا يعدّل الإقامات
    assert.equal((await acc('/m/advances', 'POST', { employee_id: emp.data.id, amount: 100, issue_date: '2026-10-01' })).status, 201);
    assert.equal((await acc(`/residencies/${emp.data.id}`, 'DELETE')).status, 403);
    // المشاهد يقرأ فقط
    assert.equal((await viewer('/residencies')).status, 200);
    assert.equal((await viewer('/m/contracts', 'POST', { company_name: 'x', end_date: '2027-01-01' })).status, 403);
    assert.equal((await viewer('/settings', 'PUT', { alertDays: 10 })).status, 403);
    // إدارة المستخدمين وسجل العمليات للمدير فقط
    for (const u of [hr, acc, viewer]) {
      assert.equal((await u('/users')).status, 403);
      assert.equal((await u('/audit')).status, 403);
    }
  });

  await t.test('إيقاف المستخدم يسري فورًا', async () => {
    const viewerCookie = (await login('view1', 'secret123')).cookie;
    const users = (await admin('/users')).data;
    const v = users.find((u) => u.username === 'view1');
    await admin(`/users/${v.id}`, 'PUT', { full_name: 'V', role: 'viewer', active: false });
    assert.equal((await as(viewerCookie)('/residencies')).status, 401);
    assert.equal((await login('view1', 'secret123')).status, 403);
  });

  await t.test('حماية آخر مدير وحساب المستخدم نفسه', async () => {
    const users = (await admin('/users')).data;
    const boss = users.find((u) => u.username === 'boss');
    assert.equal((await admin(`/users/${boss.id}`, 'PUT', { role: 'viewer', active: true })).status, 400);
    assert.equal((await admin(`/users/${boss.id}`, 'DELETE')).status, 400);
  });

  await t.test('تغيير كلمة المرور', async () => {
    const hr = as((await login('hr1', 'secret123')).cookie);
    assert.equal((await hr('/me/password', 'POST', { current: 'wrong', next: 'newsecret1' })).status, 400);
    assert.equal((await hr('/me/password', 'POST', { current: 'secret123', next: 'newsecret1' })).status, 204);
    assert.equal((await login('hr1', 'secret123')).status, 401);
    assert.equal((await login('hr1', 'newsecret1')).status, 200);
  });

  await t.test('سجل العمليات يسجّل كل شيء', async () => {
    await new Promise((r) => setTimeout(r, 200)); // السجل يُكتب بدون انتظار
    const log = (await admin('/audit')).data;
    const actions = log.items.map((i) => `${i.user_name}:${i.action}:${i.entity_type}`);
    assert.ok(actions.includes('hr1:create:residencies'));
    assert.ok(actions.includes('acc1:create:advances'));
    assert.ok(actions.includes('boss:create:users'));
    assert.ok(actions.includes('boss:update:users'));
    assert.ok(actions.includes('hr1:password:users'));
    assert.ok(log.items.some((i) => i.action === 'login_failed'));
    const update = log.items.find((i) => i.action === 'update' && i.entity_type === 'users');
    assert.deepEqual(update.details['فعّال'], ['true', 'false']);
    assert.equal((await admin('/audit?user=acc1')).data.items.every((i) => i.user_name === 'acc1'), true);
  });
});
