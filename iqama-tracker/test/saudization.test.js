// اختبارات نسبة السعودة
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';

test('حساب المطلوب للوصول للهدف', () => {
  const { needed, ratio } = require('../src/saudization');
  assert.equal(needed(3, 8, 50), 2); // 5 من 10
  assert.equal(needed(3, 8, 0), 0);
  assert.equal(needed(5, 10, 50), 0);
  assert.equal(needed(0, 10, 20), 3); // 3 من 13 = 23%
  assert.equal(ratio(1, 3), 33.3);
});

test('نسبة السعودة', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("DELETE FROM settings WHERE key = 'saudization_target'");
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin'), ('hr1', $1, 'hr')", [hashPassword('secret123')]);
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
  const hr = await login('hr1');
  const call = async (url, method = 'GET', body, c = cookie, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c, ...headers }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const riyadh = (await call('/m/branches', 'POST', { name: 'الرياض' })).data;
  const jeddah = (await call('/m/branches', 'POST', { name: 'جدة' })).data;
  let n = 0;
  const add = async (iqama, nationality, branchId) => (await call('/residencies', 'POST', {
    name: `موظف ${++n}`, iqamaNumber: iqama, expiryDate: '2027-06-01', nationality, branchId,
  })).data;
  await add('1000000001', '', riyadh.id);
  await add('1000000002', 'سعودي', riyadh.id);
  await add('2000000003', ' سعودية ', jeddah.id); // جنسية سعودية برقم يبدأ بـ 2 (إدخال قديم)
  await add('2000000004', 'هندي', riyadh.id);
  await add('2000000005', 'هندي', riyadh.id);
  await add('2000000006', 'مصري', jeddah.id);
  await add('2000000007', 'باكستاني', jeddah.id);
  await add('2000000008', '', jeddah.id);
  const left = await add('1000000009', 'سعودي', riyadh.id);
  await call(`/residencies/${left.id}/employment`, 'PUT', { status: 'left', leftDate: '2026-10-01', leftReason: 'استقالة' });

  await t.test('الإجمالي والفروع', async () => {
    const s = (await call('/stats/saudization', 'GET', null, hr)).data;
    assert.deepEqual([s.total, s.saudis, s.ratio, s.target, s.needed], [8, 3, 37.5, 0, 0]);
    const r = s.branches.find((b) => b.name === 'الرياض');
    assert.deepEqual([r.total, r.saudis, r.ratio], [4, 2, 50]);
    const branchOnly = (await call('/stats/saudization', 'GET', null, cookie, { 'X-Branch': jeddah.id })).data;
    assert.deepEqual([branchOnly.total, branchOnly.saudis], [4, 1]);
  });

  await t.test('الهدف', async () => {
    assert.equal((await call('/settings', 'PUT', { saudizationTarget: 50 }, hr)).status, 403);
    assert.equal((await call('/settings', 'PUT', { saudizationTarget: 120 })).status, 400);
    assert.equal((await call('/settings', 'PUT', { saudizationTarget: 50 })).data.saudizationTarget, 50);
    const s = (await call('/stats/saudization')).data;
    assert.equal(s.needed, 2);
    assert.equal(s.branches.find((b) => b.name === 'جدة').needed, 2);
    assert.equal(s.branches.find((b) => b.name === 'الرياض').needed, 0);
  });

  await t.test('التقرير', async () => {
    const r = (await call('/reports/saudization', 'GET', null, hr)).data;
    assert.equal(r.kpis[0].value, '37.5%');
    assert.equal(r.kpis[3].value, 2);
    assert.deepEqual(r.sections[0].totals, ['الإجمالي', 8, 3, 5, '37.5%', 2]);
    const nat = r.sections[1].rows;
    assert.deepEqual(nat[0], ['سعودي', 3, '37.5%']);
    assert.deepEqual(nat[1], ['هندي', 2, '25%']);
    assert.ok(nat.some((x) => x[0] === 'غير محددة'));
  });
});
