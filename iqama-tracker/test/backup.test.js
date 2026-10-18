// اختبارات النسخ الاحتياطي: تنزيل نسخة كاملة واستعادتها
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iqama-backup-'));
const STATUS = path.join(process.env.UPLOAD_DIR, '..', `iqama-status-${process.pid}.json`);
process.env.BACKUP_STATUS_FILE = STATUS;

test('النسخ الاحتياطي والاستعادة', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate, getSetting } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  const { restoreBackup } = require('../src/backup');
  const { unzip } = require('../src/xlsx');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("UPDATE settings SET value = '30' WHERE key = 'alert_days'");
  await pool.query("DELETE FROM settings WHERE key = 'last_backup_download'");
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin'), ('hr1', $1, 'hr')", [hashPassword('secret123')]);
  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
    fs.rmSync(STATUS, { force: true });
  });
  const base = `http://localhost:${server.address().port}/api`;
  const login = async (u) => (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret123' }),
  })).headers.get('set-cookie').split(';')[0];
  const cookie = await login('boss');
  const call = async (url, method = 'GET', body, headers = {}, c = cookie) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', cookie: c, ...headers }, body: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const branch = (await call('/m/branches', 'POST', { name: 'فرع الرياض' })).data;
  const a = (await call('/residencies', 'POST', { name: 'سالم', iqamaNumber: '2000000001', expiryDate: '2027-01-01', branchId: branch.id })).data;
  const b = (await call('/residencies', 'POST', { name: 'ماجد', iqamaNumber: '2000000002', expiryDate: '2027-02-01' })).data;
  const adv = (await call('/m/advances', 'POST', { employee_id: a.id, amount: 1200, issue_date: '2026-10-01' })).data;
  await call(`/m/advances/${adv.id}/payments`, 'POST', { amount: 200, paid_date: '2026-10-05' });
  const pdf = Buffer.from('%PDF-1.4 backup test');
  const doc = await call(`/documents?entity=residencies&id=${a.id}`, 'POST', pdf,
    { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('جواز.pdf') });
  assert.equal(doc.status, 201);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
  assert.equal((await call(`/residencies/${a.id}/photo`, 'PUT', jpeg, { 'Content-Type': 'image/jpeg' })).status, 200);
  await pool.query("UPDATE users SET branch_id = $1 WHERE username = 'hr1'", [branch.id]);

  await t.test('الحالة والصلاحيات', async () => {
    const hr = await login('hr1');
    assert.equal((await call('/backup', 'GET', null, {}, hr)).status, 403);
    assert.equal((await call('/backup/download', 'GET', null, {}, hr)).status, 403);
    // مدير مربوط بفرع ما ينزلش بيانات كل الفروع
    await pool.query("INSERT INTO users (username, password_hash, role, branch_id) VALUES ('badmin', $1, 'admin', $2)", [hashPassword('secret123'), branch.id]);
    assert.equal((await call('/backup', 'GET', null, {}, await login('badmin'))).status, 403);
    await pool.query("DELETE FROM users WHERE username = 'badmin'");

    let st = (await call('/backup')).data;
    assert.equal(st.serverConfigured, true);
    assert.equal(st.server, null);
    assert.equal(st.lastDownload, null);
    assert.equal(st.files, 2);
    assert.equal(st.filesSize, pdf.length + jpeg.length);

    fs.writeFileSync(STATUS, JSON.stringify({ time: '2026-10-18T03:00:00+03:00', ok: true, size: 5000, remote: 'offsite:iqama-backups', remoteOk: true }));
    st = (await call('/backup')).data;
    assert.equal(st.server.remote, 'offsite:iqama-backups');
    assert.equal(st.server.remoteOk, true);
  });

  let zipBuf;
  await t.test('تنزيل نسخة كاملة', async () => {
    const res = await fetch(`${base}/backup/download`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /iqama-backup-\d{4}-\d{2}-\d{2}\.zip/);
    zipBuf = Buffer.from(await res.arrayBuffer());
    const entries = unzip(zipBuf);
    const manifest = JSON.parse(entries['manifest.json']());
    assert.equal(manifest.app, 'iqama-tracker');
    assert.equal(manifest.tables.residencies, 2);
    assert.equal(manifest.tables.advance_payments, 1);
    assert.equal(manifest.files, 2);
    // الجدول الأب قبل الابن في ترتيب الاستعادة
    assert.ok(manifest.order.indexOf('branches') < manifest.order.indexOf('residencies'));
    assert.ok(manifest.order.indexOf('advances') < manifest.order.indexOf('advance_payments'));
    const stored = (await pool.query('SELECT stored_name FROM documents')).rows[0].stored_name;
    assert.deepEqual(entries[`uploads/${stored}`](), pdf);
    assert.ok(Object.keys(entries).some((n) => n.startsWith('uploads/photos/')));
    const people = JSON.parse(entries['data/residencies.json']());
    assert.ok(people.columns.includes('iqama_number'));

    const st = (await call('/backup')).data;
    assert.equal(st.lastDownload.user, 'boss');
    assert.equal(st.lastDownload.files, true);
    // انتظار سجل العمليات (يُحفظ في الخلفية)
    await new Promise((r) => setTimeout(r, 100));
    const log = (await call('/audit?action=backup')).data;
    assert.equal(log.items.length, 1);

    const light = unzip(Buffer.from(await (await fetch(`${base}/backup/download?files=0`, { headers: { cookie } })).arrayBuffer()));
    assert.equal(Object.keys(light).filter((n) => n.startsWith('uploads/')).length, 0);
    assert.equal(JSON.parse(light['manifest.json']()).includesFiles, false);
  });

  await t.test('الاستعادة ترجّع كل حاجة زي ما كانت', async () => {
    const photoDir = path.join(process.env.UPLOAD_DIR, 'photos');
    const photoName = fs.readdirSync(photoDir)[0];
    await call(`/residencies/${b.id}`, 'DELETE');
    await pool.query("UPDATE settings SET value = '99' WHERE key = 'alert_days'");
    await pool.query("UPDATE residencies SET name = 'تعديل بعد النسخة' WHERE id = $1", [a.id]);
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

    const result = await restoreBackup(zipBuf);
    assert.equal(result.tables.residencies, 2);
    assert.equal(result.files, 2);
    const { rows } = await pool.query('SELECT id, name, branch_id FROM residencies ORDER BY id');
    assert.deepEqual(rows.map((r) => r.name), ['سالم', 'ماجد']);
    assert.equal(String(rows[0].branch_id), String(branch.id));
    assert.equal(await getSetting('alert_days'), '30');
    const paid = (await call('/m/advances')).data.items.find((x) => String(x.id) === String(adv.id));
    assert.equal(Number(paid.paid), 200);
    assert.deepEqual(fs.readFileSync(path.join(photoDir, photoName)), jpeg);
    const audit = (await pool.query("SELECT details FROM audit_log WHERE details IS NOT NULL LIMIT 1")).rows[0];
    assert.equal(typeof audit.details, 'object');

    // العدّاد يكمل بعد أكبر رقم، والدخول شغال بنفس كلمة المرور
    const c = (await call('/residencies', 'POST', { name: 'جديد', iqamaNumber: '2000000003', expiryDate: '2027-03-01' }, {}, await login('boss'))).data;
    assert.equal(Number(c.id), Number(b.id) + 1);
    const file = await fetch(`${base}/documents/${doc.data.id}/file`, { headers: { cookie } });
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
  });

  await t.test('رفض ملف غير صالح', async () => {
    const { zipWriter } = require('../src/backup');
    const { PassThrough } = require('stream');
    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    const z = zipWriter(out);
    await z.add('hello.txt', 'x');
    await z.finish();
    await assert.rejects(restoreBackup(Buffer.concat(chunks)), /ليس نسخة احتياطية/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM residencies')).rows[0].n, 3);
  });
});
