// اختبارات حالة الموظف: الأرشيف يختفي من التنبيهات والأرقام ويبقى ملفه
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

test('ترك العمل والأرشيف', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("UPDATE settings SET value = '30' WHERE key = 'alert_days'");
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin')", [hashPassword('secret123')]);
  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const cookie = (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'secret123' }),
  })).headers.get('set-cookie').split(';')[0];
  const call = async (url, method = 'GET', body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const a = (await call('/residencies', 'POST', { name: 'سالم', iqamaNumber: '2000000001', expiryDate: isoInDays(5) })).data;
  const b = (await call('/residencies', 'POST', { name: 'ماجد', iqamaNumber: '2000000002', expiryDate: isoInDays(5) })).data;
  await call('/m/employee_docs', 'POST', { employee_id: a.id, doc_type: 'جواز السفر', expiry_date: isoInDays(3) });
  await call('/m/advances', 'POST', { employee_id: a.id, amount: 500, issue_date: isoInDays(-1) });
  assert.equal(a.employment, 'active');

  await t.test('التحقق من البيانات', async () => {
    assert.equal((await call(`/residencies/${a.id}/employment`, 'PUT', { status: 'left', leftReason: 'سبب غير معروف' })).status, 400);
    assert.equal((await call(`/residencies/${a.id}/employment`, 'PUT', { status: 'x' })).status, 400);
    assert.ok((await call('/employment/reasons')).data.includes('خروج نهائي'));
  });

  await t.test('الأرشفة تخفي الموظف من الأرقام والتنبيهات', async () => {
    const r = await call(`/residencies/${a.id}/employment`, 'PUT', { status: 'left', leftReason: 'خروج نهائي', leftDate: isoInDays(-1) });
    assert.equal(r.status, 200);
    assert.equal(r.data.employment, 'left');
    assert.equal(r.data.leftReason, 'خروج نهائي');

    const stats = (await call('/stats')).data;
    assert.equal(stats.total, 1);
    assert.equal(stats.expiring, 1);
    assert.equal(stats.archived, 1);
    assert.deepEqual((await call('/residencies')).data.items.map((x) => x.name), ['ماجد']);
    assert.deepEqual((await call('/residencies?employment=left')).data.items.map((x) => x.name), ['سالم']);
    assert.equal((await call('/residencies?employment=all')).data.total, 2);
    assert.equal((await call('/alerts')).data.total, 1);
    assert.deepEqual((await call('/employees?q=')).data.map((x) => x.name), ['ماجد']);
    assert.equal((await call('/m/employee_docs')).data.total, 0);
    // السلف تبقى ظاهرة (لازم تُسدد) مع علامة ترك العمل
    const adv = (await call('/m/advances')).data.items;
    assert.equal(adv.length, 1);
    assert.equal(adv[0].employee_employment, 'left');
    const day = isoInDays(5);
    const items = (await call(`/calendar/items?from=${day}`)).data.items;
    assert.deepEqual(items.map((x) => x.title), ['ماجد']);
    assert.equal((await call('/reports/residencies?days=30')).data.sections[0].rows.length, 1);
  });

  await t.test('ملف الموظف المؤرشف يبقى كاملًا', async () => {
    const s = (await call(`/employees/${a.id}/summary`)).data;
    assert.equal(s.employeeDocs.length, 1);
    assert.equal((await call(`/residencies/${a.id}`)).data.employment, 'left');
    const docId = s.employeeDocs[0].id;
    assert.equal((await call(`/m/employee_docs/${docId}`)).status, 200);
  });

  await t.test('الإعادة للعمل', async () => {
    const r = await call(`/residencies/${a.id}/employment`, 'PUT', { status: 'active' });
    assert.equal(r.data.employment, 'active');
    assert.equal(r.data.leftDate, null);
    assert.equal((await call('/stats')).data.total, 2);
    await new Promise((res) => setTimeout(res, 150)); // السجل يُكتب في الخلفية
    const log = (await pool.query("SELECT summary FROM audit_log WHERE entity_type = 'residencies' AND action = 'update' ORDER BY id")).rows;
    assert.ok(log.some((x) => x.summary.startsWith('ترك العمل: سالم')));
    assert.ok(log.some((x) => x.summary.startsWith('إعادة للعمل: سالم')));
  });

  await t.test('رقم الهوية الوطنية مقبول', async () => {
    assert.equal((await call('/residencies', 'POST', { name: 'عبدالله', iqamaNumber: '1000000001', expiryDate: isoInDays(400) })).status, 201);
    assert.equal((await call('/residencies', 'POST', { name: 'x', iqamaNumber: '3000000001', expiryDate: isoInDays(400) })).status, 400);
  });
  void b;
});
