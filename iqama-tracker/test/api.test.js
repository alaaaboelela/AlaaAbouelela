// تحتاج قاعدة بيانات اختبار:
//   TEST_DATABASE_URL=postgres://iqama:iqama@localhost:5432/iqama_test npm test
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';

const { hijriToGregorian, gregorianToHijri } = require('../public/hijri');
const { parseCsv } = require('../src/csv');

test('التحويل بين الهجري والميلادي', () => {
  assert.equal(hijriToGregorian('1445-09-01'), '2024-03-11');
  assert.equal(gregorianToHijri('2024-03-11'), '1445-09-01');
  assert.equal(hijriToGregorian('1448/4/22'), '2026-10-03');
  assert.equal(hijriToGregorian('1448-13-01'), null);
  assert.equal(hijriToGregorian('abc'), null);
});

test('قراءة CSV مع علامات التنصيص والفاصلة المنقوطة', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

function isoInDays(n) {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('API', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');

  await migrate();
  await pool.query('TRUNCATE residencies, users RESTART IDENTITY');
  await pool.query("UPDATE settings SET value = '30' WHERE key = 'alert_days'");
  await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', ['admin', hashPassword('secret123')]);

  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (url, method = 'GET', body, contentType = 'application/json') => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': contentType, cookie },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* نص */ }
    return { status: res.status, data, headers: res.headers };
  };

  await t.test('تسجيل الدخول مطلوب', async () => {
    assert.equal((await call('/api/residencies')).status, 401);
    assert.equal((await call('/api/login', 'POST', { username: 'admin', password: 'wrong' })).status, 401);
    const ok = await call('/api/login', 'POST', { username: 'admin', password: 'secret123' });
    assert.equal(ok.status, 200);
    cookie = ok.headers.get('set-cookie').split(';')[0];
  });

  let ahmed;
  await t.test('إضافة وتحقق', async () => {
    const bad = await call('/api/residencies', 'POST', { name: 'x', iqamaNumber: '123', expiryDate: '2026-01-01' });
    assert.equal(bad.status, 400);

    ahmed = (await call('/api/residencies', 'POST', { name: 'أحمد', iqamaNumber: '2111111111', expiryDate: isoInDays(10), employer: 'شركة النور' })).data;
    assert.equal(ahmed.status, 'expiring');
    assert.equal(ahmed.daysLeft, 10);

    // أرقام عربية + تاريخ هجري
    const hijri = await call('/api/residencies', 'POST', { name: 'محمد', iqamaNumber: '٢٢٢٢٢٢٢٢٢٢', expiryDateHijri: gregorianToHijri(isoInDays(-3)) });
    assert.equal(hijri.status, 201);
    assert.equal(hijri.data.iqamaNumber, '2222222222');
    assert.equal(hijri.data.status, 'expired');

    await call('/api/residencies', 'POST', { name: 'سارة', iqamaNumber: '2333333333', expiryDate: isoInDays(200) });

    const dup = await call('/api/residencies', 'POST', { name: 'مكرر', iqamaNumber: '2111111111', expiryDate: isoInDays(5) });
    assert.equal(dup.status, 409);
  });

  await t.test('الإحصائيات والفلترة والبحث والصفحات', async () => {
    const stats = (await call('/api/stats')).data;
    assert.deepEqual(
      { total: stats.total, expired: stats.expired, expiring: stats.expiring, valid: stats.valid, withinWeek: stats.withinWeek },
      { total: 3, expired: 1, expiring: 1, valid: 1, withinWeek: 0 },
    );

    const expiring = (await call('/api/residencies?status=expiring')).data;
    assert.deepEqual(expiring.items.map((r) => r.name), ['أحمد']);

    assert.equal((await call('/api/residencies?q=النور')).data.total, 1);
    assert.equal((await call('/api/residencies?q=2333')).data.items[0].name, 'سارة');
    assert.equal((await call('/api/residencies?q=%25')).data.total, 0);

    const page2 = (await call('/api/residencies?pageSize=2&page=2')).data;
    assert.equal(page2.total, 3);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].name, 'سارة');
  });

  await t.test('تعديل وإعدادات وحذف', async () => {
    await call('/api/settings', 'PUT', { alertDays: 5 });
    assert.equal((await call('/api/stats')).data.expiring, 0);

    const updated = await call(`/api/residencies/${ahmed.id}`, 'PUT', { ...ahmed, expiryDate: isoInDays(2) });
    assert.equal(updated.data.status, 'expiring');

    assert.equal((await call(`/api/residencies/${ahmed.id}`, 'DELETE')).status, 204);
    assert.equal((await call(`/api/residencies/${ahmed.id}`)).status, 404);
    assert.equal((await call('/api/residencies/abc')).status, 404);
  });

  await t.test('استيراد وتصدير', async () => {
    const csv = [
      'الاسم,رقم الإقامة,تاريخ الانتهاء,تاريخ الانتهاء هجري,جهة العمل',
      `خالد,2444444444,${isoInDays(3)},,مؤسسة`,
      `سارة المعدلة,2333333333,,${gregorianToHijri(isoInDays(100))},`,
      'خطأ,999,2026-01-01,,',
    ].join('\n');
    const res = (await call('/api/residencies/import', 'POST', csv, 'text/csv')).data;
    assert.equal(res.inserted, 1);
    assert.equal(res.updated, 1);
    assert.equal(res.failed, 1);
    assert.equal(res.errors[0].line, 4);

    const exp = await call('/api/residencies/export.csv?status=expiring');
    assert.match(exp.headers.get('content-type'), /text\/csv/);
    const rows = parseCsv(exp.data);
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], 'خالد');
  });

  await t.test('بيانات التنبيه', async () => {
    const alerts = (await call('/api/alerts')).data;
    assert.deepEqual(alerts.items.map((r) => r.name), ['محمد', 'خالد']);
    assert.equal(alerts.emailEnabled, false);
  });
});
