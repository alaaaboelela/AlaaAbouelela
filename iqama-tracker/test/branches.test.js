// اختبارات الفروع: الفلترة حسب الفرع، والمستخدم المربوط بفرع لا يرى ولا يعدّل غير فرعه
const test = require('node:test');
const assert = require('node:assert');
const { writeXlsx } = require('../src/xlsx');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';

test('الفروع', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
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
  const login = async (username) => (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'secret123' }),
  })).headers.get('set-cookie').split(';')[0];
  const as = (cookie, branch) => async (url, method = 'GET', body, extra = {}) => {
    const headers = { 'Content-Type': 'application/json', cookie, ...extra };
    if (branch) headers['X-Branch'] = branch;
    const res = await fetch(base + url, { method, headers, body: Buffer.isBuffer(body) ? body : body && JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* نص */ }
    return { status: res.status, data };
  };
  const admin = as(await login('boss'));

  const riyadh = (await admin('/m/branches', 'POST', { name: 'فرع الرياض', city: 'الرياض', cr_number: '1010000001' })).data;
  const jeddah = (await admin('/m/branches', 'POST', { name: 'فرع جدة', city: 'جدة' })).data;
  assert.ok(riyadh.id && jeddah.id);
  assert.equal((await admin('/m/branches', 'POST', { name: 'فرع الرياض' })).status, 409);

  const emp = async (name, iqama, branchId) => (await admin('/residencies', 'POST',
    { name, iqamaNumber: iqama, expiryDate: '2026-10-20', branchId })).data;
  const a1 = await emp('سالم', '2000000001', riyadh.id);
  const a2 = await emp('خالد', '2000000002', riyadh.id);
  const b1 = await emp('ماجد', '2000000003', jeddah.id);
  await emp('بدون فرع', '2000000004', '');
  assert.equal(a1.branchName, 'فرع الرياض');

  await admin('/m/contracts', 'POST', { company_name: 'عقد الرياض', end_date: '2027-01-01', branch_id: riyadh.id });
  await admin('/m/contracts', 'POST', { company_name: 'عقد جدة', end_date: '2027-01-01', branch_id: jeddah.id });
  await admin('/m/advances', 'POST', { employee_id: a1.id, amount: 1000, issue_date: '2026-10-01' });
  await admin('/m/advances', 'POST', { employee_id: b1.id, amount: 500, issue_date: '2026-10-01' });

  await t.test('المدير يرى الكل أو يفلتر بالفرع', async () => {
    assert.equal((await admin('/residencies')).data.total, 4);
    const r = as(await login('boss'), riyadh.id);
    assert.equal((await r('/residencies')).data.total, 2);
    assert.equal((await r('/stats')).data.total, 2);
    assert.equal((await r('/m/contracts')).data.total, 1);
    assert.equal((await r('/m/advances')).data.totals.remaining, 1000);
    assert.equal((await r('/overview')).data.advances.totals.remaining, 1000);
    const branches = (await admin('/m/branches')).data.items;
    assert.equal(branches.find((b) => b.id === riyadh.id).employees_count, 2);
    // المدير وهو مختار فرع الرياض يقدر يضيف عقد لفرع جدة صراحةً، وبدون اختيار يأخذ الفرع الحالي
    assert.equal((await r('/m/contracts', 'POST', { company_name: 'جديد', end_date: '2027-01-01' })).data.branch_id, riyadh.id);
  });

  const hrCreated = await admin('/users', 'POST', { username: 'hr.riyadh', role: 'hr', password: 'secret123', branch_id: riyadh.id });
  assert.equal(hrCreated.status, 201);
  const hr = as(await login('hr.riyadh'));
  // حتى لو أرسل فرعًا آخر يبقى مقيّدًا بفرعه
  const hrSneaky = as(await login('hr.riyadh'), jeddah.id);

  await t.test('المستخدم المربوط بفرع يرى فرعه فقط', async () => {
    const me = (await hr('/me')).data;
    assert.deepEqual(me.branch, { id: riyadh.id, name: 'فرع الرياض' });
    assert.equal((await hrSneaky('/residencies')).data.total, 2);
    assert.equal((await hr('/m/advances')).data.total, 1);
    assert.equal((await hr('/m/branches')).data.total, 1);
    assert.deepEqual((await hr('/employees?q=')).data.map((e) => e.name).sort(), ['خالد', 'سالم']);
    assert.equal((await hr(`/residencies/${b1.id}`)).status, 404);
    assert.equal((await hr(`/employees/${b1.id}/summary`)).status, 404);
    assert.equal((await hr(`/documents?entity=residencies&id=${b1.id}`)).status, 404);
    assert.equal((await hr(`/residencies/${b1.id}`, 'PUT', { name: 'x', iqamaNumber: '2000000003', expiryDate: '2027-01-01' })).status, 404);
    assert.equal((await hr(`/residencies/${b1.id}`, 'DELETE')).status, 404);
    assert.equal((await hr('/alerts')).data.total, 2);
  });

  await t.test('الإضافة تُحفظ في فرع المستخدم دائمًا', async () => {
    const created = (await hr('/residencies', 'POST', { name: 'جديد', iqamaNumber: '2000000005', expiryDate: '2027-01-01', branchId: jeddah.id })).data;
    assert.equal(created.branchId, riyadh.id);
    const updated = (await hr(`/residencies/${a2.id}`, 'PUT', { name: 'خالد', iqamaNumber: '2000000002', expiryDate: '2027-01-01', branchId: '' })).data;
    assert.equal(updated.branchId, riyadh.id);
    // لا يمكن ربط سجل بموظف من فرع آخر
    const bad = await hr('/m/driver_cards', 'POST', { employee_id: b1.id, card_number: 'X1', expiry_date: '2027-01-01' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /فرع/);
    assert.equal((await hr('/m/driver_cards', 'POST', { employee_id: a1.id, card_number: 'X2', expiry_date: '2027-01-01' })).status, 201);
  });

  await t.test('الاستيراد يحترم الفرع', async () => {
    const file = writeXlsx([{
      name: 'x',
      header: ['الاسم', 'رقم الإقامة', 'تاريخ الانتهاء', 'الفرع'],
      rows: [['موظف جديد', '2000000006', '2027-03-01', 'فرع جدة'], ['ماجد معدل', '2000000003', '2027-03-01', '']],
    }]);
    const r = await hr('/residencies/import', 'POST', file, { 'Content-Type': 'application/octet-stream' });
    assert.equal(r.data.inserted, 1);
    assert.equal(r.data.failed, 1);
    assert.match(r.data.errors[0].error, /فرع آخر/);
    const { rows } = await pool.query("SELECT iqama_number, name, branch_id::text AS b FROM residencies WHERE iqama_number IN ('2000000003', '2000000006') ORDER BY 1");
    assert.deepEqual(rows.map((x) => [x.name, x.b]), [['ماجد', jeddah.id], ['موظف جديد', riyadh.id]]);

    // المدير يستورد بعمود الفرع
    const adminFile = writeXlsx([{ name: 'x', header: ['الاسم', 'رقم الإقامة', 'تاريخ الانتهاء', 'الفرع'], rows: [['ب', '2000000007', '2027-03-01', 'فرع جدة'], ['ج', '2000000008', '2027-03-01', 'فرع غير موجود']] }]);
    const a = await admin('/residencies/import', 'POST', adminFile, { 'Content-Type': 'application/octet-stream' });
    assert.equal(a.data.inserted, 1);
    assert.match(a.data.errors[0].error, /لا يوجد فرع/);

    // استيراد قسم: الموظف من فرع آخر غير موجود بالنسبة للمستخدم
    const docs = writeXlsx([{ name: 'x', header: ['الموظف - رقم الإقامة', 'نوع المستند', 'تاريخ الانتهاء'], rows: [['2000000003', 'جواز السفر', '2028-10-01'], ['2000000001', 'جواز السفر', '2028-10-01']] }]);
    const ai = await hr('/m/employee_docs/import', 'POST', docs, { 'Content-Type': 'application/octet-stream' });
    assert.equal(ai.data.inserted, 1);
    assert.match(ai.data.errors[0].error, /في هذا الفرع/);
  });

  await t.test('حذف فرع مرتبط ببيانات مرفوض', async () => {
    assert.equal((await admin(`/m/branches/${jeddah.id}`, 'DELETE')).status, 409);
    const empty = (await admin('/m/branches', 'POST', { name: 'فرع الدمام' })).data;
    assert.equal((await admin(`/m/branches/${empty.id}`, 'DELETE')).status, 204);
  });
});
