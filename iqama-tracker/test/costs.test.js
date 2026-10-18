// اختبارات تكلفة تجديد الإقامات وتوقعاتها
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

test('تكلفة التجديد والتوقعات', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("DELETE FROM settings WHERE key = 'renewal_costs'");
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
  const call = async (url, method = 'GET', body, c = cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  await t.test('الإعدادات', async () => {
    const c = (await call('/costs', 'GET', null, hr)).data;
    assert.equal(c.total, 10250);
    assert.equal(c.items.find((i) => i.key === 'iqama').value, 650);
    assert.equal((await call('/costs', 'PUT', { levy: 8400 }, hr)).status, 403);
    assert.equal((await call('/costs', 'PUT', { levy: -1 })).status, 400);
    const saved = (await call('/costs', 'PUT', { levy: '8400' })).data;
    assert.equal(saved.total, 9050);
  });

  const add = async (name, iqama, days, extra = {}) => call('/residencies', 'POST', { name, iqamaNumber: iqama, expiryDate: isoInDays(days), ...extra });
  let a; let b;
  await t.test('تكلفة خاصة لكل موظف', async () => {
    assert.equal((await add('خطأ', '2000000009', 10, { renewalCost: '-5' })).status, 400);
    a = (await add('سالم', '2000000001', 10)).data;
    b = (await add('ماجد', '2000000002', 40, { renewalCost: '3,000' })).data;
    assert.equal(a.renewalCost, null);
    assert.equal(b.renewalCost, 3000);
    await add('سعود', '1000000003', 20);
    await add('سعودي برقم قديم', '2000000013', 25, { nationality: 'سعودي' });
    await add('متأخر', '2000000004', -5);
    const left = (await add('ترك', '2000000005', 10)).data;
    await call(`/residencies/${left.id}/employment`, 'PUT', { status: 'left', leftDate: isoInDays(-1), leftReason: 'استقالة' });
    await add('بعيد', '2000000006', 400);

    // تعديل بدون الحقل يحافظ على التكلفة الخاصة
    const kept = (await call(`/residencies/${b.id}`, 'PUT', { name: 'ماجد', iqamaNumber: '2000000002', expiryDate: isoInDays(40) })).data;
    assert.equal(kept.renewalCost, 3000);
  });

  await t.test('الإحصاء الشهري بالتكلفة', async () => {
    const { months, overdue } = (await call('/stats/monthly')).data;
    assert.equal(months.reduce((s, m) => s + m.count, 0), 4);
    assert.equal(months.reduce((s, m) => s + m.cost, 0), 9050 + 3000);
    assert.deepEqual(overdue, { count: 1, cost: 9050 });
  });

  await t.test('تقرير التوقعات', async () => {
    const r = (await call('/reports/renewals?months=12', 'GET', null, hr)).data;
    assert.equal(r.kpis[0].value, 9050 * 2 + 3000);
    assert.equal(r.kpis[1].value, 3);
    assert.equal(r.kpis[2].value, 9050);
    const byMonth = r.sections[0];
    assert.equal(byMonth.rows[0][0], 'منتهية (تجديد فوري)');
    assert.equal(byMonth.rows.length, 13);
    assert.deepEqual(byMonth.totals, ['الإجمالي', 3, 21100]);
    const details = r.sections.find((s) => s.title === 'التفاصيل');
    assert.deepEqual(details.rows.map((x) => x[0]), ['متأخر', 'سالم', 'ماجد']);
    assert.equal(details.rows[2][7], 'تكلفة خاصة');

    // مسح التكلفة الخاصة يرجّع الافتراضي
    await call(`/residencies/${b.id}`, 'PUT', { name: 'ماجد', iqamaNumber: '2000000002', expiryDate: isoInDays(40), renewalCost: '' });
    assert.equal((await call('/reports/renewals')).data.kpis[0].value, 9050 * 3);
  });
});
