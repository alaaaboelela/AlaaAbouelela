// اختبارات العقود، السيارات، السلف، العهد، بطاقات السائقين، والمستندات
//   TEST_DATABASE_URL=postgres://iqama:iqama@localhost:5432/iqama_test npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iqama-docs-'));

function isoInDays(n) {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('الأقسام', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');

  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents RESTART IDENTITY CASCADE`);
  await pool.query("UPDATE settings SET value = '30' WHERE key = 'alert_days'");
  await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', ['admin', hashPassword('secret123')]);
  const { rows: [emp] } = await pool.query(
    "INSERT INTO residencies (name, iqama_number, expiry_date) VALUES ('سالم', '2000000001', $1) RETURNING id",
    [isoInDays(100)],
  );
  const { rows: [emp2] } = await pool.query(
    "INSERT INTO residencies (name, iqama_number, expiry_date) VALUES ('ماجد', '2000000002', $1) RETURNING id",
    [isoInDays(100)],
  );

  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (url, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* نص */ }
    return { status: res.status, data, headers: res.headers };
  };

  await t.test('المخطط يُرسل للواجهة بدون SQL', async () => {
    const { data } = await call('/schema');
    assert.deepEqual(Object.keys(data).sort(), ['advances', 'cars', 'contracts', 'custody', 'driver_cards']);
    assert.equal(JSON.stringify(data).includes('SELECT'), false);
  });

  await t.test('العقود وحالاتها', async () => {
    const bad = await call('/m/contracts', 'POST', { company_name: '', end_date: 'x' });
    assert.equal(bad.status, 400);
    const soon = await call('/m/contracts', 'POST', { company_name: 'شركة أ', end_date: isoInDays(10), value: '1,500,000.5' });
    assert.equal(soon.status, 201);
    assert.equal(soon.data.status, 'expiring');
    assert.equal(soon.data.value, 1500000.5);
    await call('/m/contracts', 'POST', { company_name: 'شركة ب', end_date: isoInDays(-5) });
    await call('/m/contracts', 'POST', { company_name: 'شركة ج', end_date: isoInDays(300) });

    const list = (await call('/m/contracts?status=expired')).data;
    assert.equal(list.total, 1);
    assert.equal(list.items[0].company_name, 'شركة ب');
    assert.deepEqual(list.counts, { expiring: 1, expired: 1, active: 1, total: 3 });
    assert.equal((await call('/m/contracts?q=' + encodeURIComponent('شركة ج'))).data.total, 1);
    assert.equal((await call('/m/contracts', 'POST', { company_name: 'x', end_date: isoInDays(1), contract_type: 'غير موجود' })).status, 400);
  });

  await t.test('السيارات: سجل الصيانة وتسجيل التعديلات تلقائيًا', async () => {
    const car = (await call('/m/cars', 'POST', {
      plate_number: 'أ ب ج 1111', value: 100000, driver_id: emp.id, insurance_expiry: isoInDays(5),
    })).data;
    assert.equal(car.status, 'attention');
    assert.equal(car.driver_name, 'سالم');
    assert.equal((await call('/m/cars', 'POST', { plate_number: 'أ ب ج 1111' })).status, 409);

    const upd = await call(`/m/cars/${car.id}`, 'PUT', { ...car, value: 90000, driver_id: emp2.id, insurance_expiry: isoInDays(200) });
    assert.equal(upd.data.status, 'ok');

    await call(`/m/cars/${car.id}/events`, 'POST', {
      event_date: isoInDays(0), event_type: 'تغيير زيت', cost: 300, odometer: 52000, next_service_date: isoInDays(20),
    });
    const events = (await call(`/m/cars/${car.id}/events`)).data;
    assert.equal(events.length, 2);
    const log = events.find((e) => e.event_type === 'تحديث بيانات');
    assert.match(log.description, /قيمة السيارة: 100000 ← 90000/);
    assert.match(log.description, /السائق: سالم ← ماجد/);

    const after = (await call(`/m/cars/${car.id}`)).data;
    assert.equal(after.odometer, 52000);
    assert.equal(after.next_service_date, isoInDays(20));
    assert.equal(after.status, 'attention'); // الصيانة القادمة خلال فترة التنبيه
    assert.equal(after.maintenance_cost, 300);
  });

  await t.test('السلف والدفعات', async () => {
    const adv = (await call('/m/advances', 'POST', { employee_id: emp.id, amount: 1000, issue_date: isoInDays(-30) })).data;
    assert.equal(adv.status, 'open');
    assert.equal(adv.remaining, 1000);
    assert.equal((await call(`/m/advances/${adv.id}/payments`, 'POST', { paid_date: isoInDays(0), amount: 1200 })).status, 400);
    await call(`/m/advances/${adv.id}/payments`, 'POST', { paid_date: isoInDays(0), amount: 400 });
    await call(`/m/advances/${adv.id}/payments`, 'POST', { paid_date: isoInDays(0), amount: 600 });
    const done = (await call(`/m/advances/${adv.id}`)).data;
    assert.equal(done.remaining, 0);
    assert.equal(done.status, 'settled');
    assert.equal((await call('/m/advances', 'POST', { employee_id: emp.id, amount: 0, issue_date: isoInDays(0) })).status, 400);
  });

  await t.test('العهد، بطاقات السائقين، والملف الشامل للموظف', async () => {
    await call('/m/custody', 'POST', { employee_id: emp.id, item_name: 'لابتوب', handed_date: isoInDays(-3), value: 4000, quantity: 1 });
    await call('/m/custody', 'POST', { employee_id: emp.id, item_name: 'جوال', handed_date: isoInDays(-3), returned_date: isoInDays(0), value: 900 });
    const custody = (await call('/m/custody')).data;
    assert.deepEqual(custody.counts, { held: 1, returned: 1, total: 2 });
    assert.equal(custody.totals.value, 4000);

    const card = (await call('/m/driver_cards', 'POST', { employee_id: emp.id, card_number: 'DC-1', expiry_date: isoInDays(-1) })).data;
    assert.equal(card.status, 'expired');
    assert.equal(card.employee_name, 'سالم');

    const summary = (await call(`/employees/${emp.id}/summary`)).data;
    assert.equal(summary.driverCards.length, 1);
    assert.equal(summary.advances.length, 1);
    assert.equal(summary.custody.length, 2);

    // لا يمكن حذف موظف عليه سلف أو عهد
    const del = await call(`/residencies/${emp.id}`, 'DELETE');
    assert.equal(del.status, 409);

    const found = (await call(`/employees?q=${encodeURIComponent('سال')}`)).data;
    assert.equal(found[0].name, 'سالم');
  });

  await t.test('المستندات: رفع، تنزيل، رفض الأنواع الخطرة، حذف', async () => {
    const contract = (await call('/m/contracts?q=' + encodeURIComponent('شركة أ'))).data.items[0];
    const up = await call(`/documents?entity=contracts&id=${contract.id}&title=${encodeURIComponent('العقد الموقع')}`, 'POST',
      Buffer.from('%PDF-1.4 test'), { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('عقد.pdf') });
    assert.equal(up.status, 201);
    assert.equal(up.data.title, 'العقد الموقع');

    const html = await call(`/documents?entity=contracts&id=${contract.id}`, 'POST', Buffer.from('<script>'),
      { 'Content-Type': 'text/html', 'X-File-Name': 'x.html' });
    assert.equal(html.status, 400);
    const pdf = { 'Content-Type': 'application/pdf', 'X-File-Name': 'a.pdf' };
    assert.equal((await call('/documents?entity=users&id=1', 'POST', Buffer.from('x'), pdf)).status, 404);
    assert.equal((await call('/documents?entity=contracts&id=99999', 'POST', Buffer.from('x'), pdf)).status, 404);

    const file = await fetch(`${base}/documents/${up.data.id}/file`, { headers: { cookie } });
    assert.equal(await file.text(), '%PDF-1.4 test');
    assert.match(file.headers.get('content-disposition'), /^attachment/);
    assert.equal((await fetch(`${base}/documents/${up.data.id}/file`)).status, 401);

    // حذف العقد يحذف مستنداته
    assert.equal((await call(`/m/contracts/${contract.id}`, 'DELETE')).status, 204);
    assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0);
    assert.deepEqual((await call(`/documents?entity=contracts&id=${contract.id}`)).data, []);
  });

  await t.test('النظرة العامة', async () => {
    const o = (await call('/overview')).data;
    assert.equal(o.contracts.counts.total, 2);
    assert.equal(o.advances.totals.remaining, 0);
    assert.equal(o.custody.counts.held, 1);
  });
});
