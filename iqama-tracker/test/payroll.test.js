// اختبارات كشف خصم أقساط السلف من الرواتب
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()).slice(0, 7);
function shiftMonth(month, n) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

test('كشف خصم السلف', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  const { readXlsx, unzip } = require('../src/xlsx');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin'), ('acc', $1, 'accountant'), ('v', $1, 'viewer')", [hashPassword('secret123')]);
  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const login = async (u) => (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }),
  })).headers.get('set-cookie').split(';')[0];
  const cookie = await login('acc');
  const viewer = await login('v');
  const call = async (url, method = 'GET', body, c = cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const admin = await login('boss');
  const emp = async (name, iqama) => (await call('/residencies', 'POST', { name, iqamaNumber: iqama, expiryDate: '2027-06-01' }, admin)).data;
  const a = await emp('سالم', '2000000001');
  const b = await emp('ماجد', '2000000002');
  const c = await emp('بدون قسط', '2000000003');
  const left = await emp('ترك العمل', '2000000004');
  const month = thisMonth();
  const day = `${month}-01`;
  const adv = async (employee, amount, installment) => (await call('/m/advances', 'POST', {
    employee_id: employee.id, amount, issue_date: day, monthly_installment: installment,
  })).data;
  const a1 = await adv(a, 1000, 300);
  const a2 = await adv(a, 500, 200);
  const b1 = await adv(b, 250, 400); // القسط أكبر من المتبقي
  await call(`/m/advances/${b1.id}/payments`, 'POST', { amount: 100, paid_date: day });
  await adv(c, 800, '');
  await adv(left, 900, 300);
  await call(`/residencies/${left.id}/employment`, 'PUT', { status: 'left', leftDate: day, leftReason: 'استقالة' }, admin);
  const settled = await adv(b, 100, 50);
  await call(`/m/advances/${settled.id}/payments`, 'POST', { amount: 100, paid_date: day });

  await t.test('الكشف', async () => {
    assert.equal((await call(`/payroll?month=${shiftMonth(month, 1)}`)).status, 400);
    const s = (await call(`/payroll?month=${month}`, 'GET', null, viewer)).data;
    assert.deepEqual(s.lines.map((l) => [l.name, l.deduction, l.after]), [
      ['سالم', 300, 700], ['سالم', 200, 300], ['ماجد', 150, 0],
    ]);
    assert.deepEqual(s.totals, { employees: 2, deduction: 650, pending: 3, pendingAmount: 650, recorded: 0 });
    assert.deepEqual(s.noInstallment.map((l) => l.name), ['بدون قسط']);
    // سلفة صُرفت بعد الشهر المطلوب ما تظهرش
    assert.equal((await call(`/payroll?month=${shiftMonth(month, -1)}`)).data.lines.length, 0);
  });

  await t.test('التسجيل مرة واحدة', async () => {
    assert.equal((await call('/payroll/record', 'POST', { month }, viewer)).status, 403);
    const r = (await call('/payroll/record', 'POST', { month, advanceIds: [a1.id] })).data;
    assert.deepEqual(r, { recorded: 1, amount: 300 });
    const all = (await call('/payroll/record', 'POST', { month })).data;
    assert.deepEqual(all, { recorded: 2, amount: 350 });
    assert.deepEqual((await call('/payroll/record', 'POST', { month })).data, { recorded: 0, amount: 0 });

    const s = (await call(`/payroll?month=${month}`)).data;
    assert.ok(s.lines.every((l) => l.recorded));
    assert.deepEqual(s.lines.map((l) => [l.before, l.deduction, l.after]), [[1000, 300, 700], [500, 200, 300], [150, 150, 0]]);
    const pays = (await call(`/m/advances/${a2.id}/payments`)).data;
    assert.equal(pays.length, 1);
    assert.equal(Number(pays[0].amount), 200);
    assert.match(pays[0].note, /خصم راتب/);
    const b1now = (await call('/m/advances?status=settled')).data.items.map((x) => x.id);
    assert.ok(b1now.includes(b1.id));
  });

  await t.test('Excel والطباعة', async () => {
    const res = await fetch(`${base}/payroll/export.xlsx?month=${month}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    const rows = readXlsx(buf);
    assert.equal(rows[0][0], 'الموظف');
    assert.equal(Number(rows.at(-1)[6]), 650);
    assert.ok(unzip(buf)['xl/worksheets/sheet2.xml'], 'ورقة السلف بدون قسط');
    const report = (await call(`/reports/payroll?month=${month}`)).data;
    assert.equal(report.kpis[0].value, 650);
    assert.equal(report.sections[0].rows.length, 3);
  });

  await t.test('إلغاء تسجيل الشهر', async () => {
    const r = (await call(`/payroll/record?month=${month}`, 'DELETE')).data;
    assert.deepEqual(r, { removed: 3, amount: 650 });
    assert.equal((await call(`/payroll?month=${month}`)).data.totals.pending, 3);
    // الدفعات اليدوية ما اتمسحتش
    assert.equal((await call(`/m/advances/${b1.id}/payments`)).data.length, 1);
    await new Promise((res) => setTimeout(res, 50));
    const log = (await call('/audit', 'GET', null, admin)).data.items.map((x) => x.summary);
    assert.ok(log.some((x) => x.startsWith('إلغاء كشف خصم السلف')));
  });
});
