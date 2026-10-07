// اختبارات صورة الموظف
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iqama-photo-'));

test('صورة الموظف', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin'), ('viewer1', $1, 'viewer')", [hashPassword('secret123')]);
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
  const call = (url, method = 'GET', body, type = 'image/jpeg', c = cookie) => fetch(base + url, { method, headers: { cookie: c, 'Content-Type': type }, body });

  const emp = await (await call('/residencies', 'POST', JSON.stringify({ name: 'سالم', iqamaNumber: '2000000001', expiryDate: '2027-01-01' }), 'application/json')).json();
  assert.equal(emp.photo, null);

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
  assert.equal((await call(`/residencies/${emp.id}/photo`, 'PUT', Buffer.from('<svg onload=alert(1)>'))).status, 400);
  assert.equal((await call(`/residencies/${emp.id}/photo`, 'PUT', jpeg, 'image/jpeg', await login('viewer1'))).status, 403);
  const up = await call(`/residencies/${emp.id}/photo`, 'PUT', jpeg);
  assert.equal(up.status, 200);

  const withPhoto = await (await call(`/residencies/${emp.id}`)).json();
  assert.match(withPhoto.photo, new RegExp(`^/api/residencies/${emp.id}/photo\\?v=\\d+$`));
  const img = await call(`/residencies/${emp.id}/photo`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/residencies/${emp.id}/photo`)).status, 401);

  // تغيير الصورة يحذف القديمة
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]);
  await call(`/residencies/${emp.id}/photo`, 'PUT', png);
  const dir = path.join(process.env.UPLOAD_DIR, 'photos');
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal((await call(`/residencies/${emp.id}/photo`)).headers.get('content-type'), 'image/png');

  // حذف الموظف يحذف صورته
  assert.equal((await call(`/residencies/${emp.id}`, 'DELETE')).status, 204);
  assert.equal(fs.readdirSync(dir).length, 0);
});
