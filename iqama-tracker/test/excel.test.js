// اختبارات Excel: القراءة والكتابة، التصدير، النماذج، والاستيراد لكل الأقسام
const test = require('node:test');
const assert = require('node:assert');
const { writeXlsx, readXlsx, parseDateCell } = require('../src/xlsx');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';

test('قراءة وكتابة xlsx', () => {
  const buf = writeXlsx([{ name: 'ورقة', header: ['الاسم', 'الرقم'], rows: [['أحمد & <علي>', 12.5], ['', 3]] }]);
  assert.deepEqual(readXlsx(buf), [['الاسم', 'الرقم'], ['أحمد & <علي>', 12.5], ['', 3]]);
  assert.equal(parseDateCell(46447), '2027-03-01');
  assert.equal(parseDateCell('31/12/2026'), '2026-12-31');
  assert.equal(parseDateCell('١٤٤٨-٠٢-٢٣'), '2026-08-06');
  assert.equal(parseDateCell(''), '');
});

test('استيراد وتصدير Excel', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');

  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin'), ('viewer', $1, 'viewer')",
    [hashPassword('secret123')]);

  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const loginAs = async (username) => (await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'secret123' }),
  })).headers.get('set-cookie').split(';')[0];
  const cookie = await loginAs('admin');
  const upload = async (url, buf, c = cookie) => {
    const res = await fetch(base + url, { method: 'POST', headers: { cookie: c, 'Content-Type': 'application/octet-stream' }, body: buf });
    return { status: res.status, data: await res.json() };
  };
  const download = async (url) => {
    const res = await fetch(base + url, { headers: { cookie } });
    return { status: res.status, type: res.headers.get('content-type'), rows: readXlsx(Buffer.from(await res.arrayBuffer())) };
  };

  await t.test('استيراد الإقامات من Excel (ميلادي، هجري، رقم Excel)', async () => {
    const file = writeXlsx([{
      name: 'x',
      header: ['الاسم', 'رقم الإقامة', 'تاريخ الانتهاء', 'الجنسية', 'رصيد الإجازة السنوية'],
      rows: [
        ['سالم', 2000000001, '2027-01-15', 'مصر', 30],
        ['ماجد', '٢٠٠٠٠٠٠٠٠٢', '1448-02-23', 'الهند', ''],
        ['خالد', '2000000003', 46447, '', ''],
        ['', '', '', '', ''],
        ['ناقص', '123', '2027-01-01', '', ''],
      ],
    }]);
    const r = await upload('/residencies/import', file);
    assert.equal(r.status, 200);
    assert.equal(r.data.inserted, 3);
    assert.equal(r.data.failed, 1);
    assert.equal(r.data.errors[0].line, 6);
    const { rows } = await pool.query('SELECT iqama_number, expiry_date, annual_leave_days FROM residencies ORDER BY iqama_number');
    assert.deepEqual(rows.map((x) => [x.expiry_date, x.annual_leave_days]),
      [['2027-01-15', 30], ['2026-08-06', 21], ['2027-03-01', 21]]);

    // إعادة الاستيراد بدون عمود الرصيد لا تمسح الرصيد
    const again = writeXlsx([{ name: 'x', header: ['الاسم', 'رقم الإقامة', 'تاريخ الانتهاء'], rows: [['سالم', '2000000001', '2027-02-01']] }]);
    assert.deepEqual((await upload('/residencies/import', again)).data.updated, 1);
    const { rows: [salem] } = await pool.query("SELECT annual_leave_days, expiry_date FROM residencies WHERE iqama_number = '2000000001'");
    assert.deepEqual([salem.annual_leave_days, salem.expiry_date], [30, '2027-02-01']);

    assert.equal((await upload('/residencies/import', Buffer.from('PK\x03\x04garbage'))).status, 400);
  });

  await t.test('تصدير الإقامات', async () => {
    const x = await download('/residencies/export.xlsx');
    assert.equal(x.status, 200);
    assert.match(x.type, /spreadsheetml/);
    assert.equal(x.rows.length, 4);
    assert.equal(x.rows[0][0], 'الاسم');
    assert.ok(x.rows[0].includes('رصيد الإجازة السنوية'));
    const t2 = await download('/residencies/template.xlsx');
    assert.equal(t2.rows.length, 1);
  });

  await t.test('نموذج واستيراد قسم بحقل موظف', async () => {
    const tpl = await download('/m/advances/template.xlsx');
    assert.deepEqual(tpl.rows[0].slice(0, 3), ['الموظف - رقم الإقامة', 'مبلغ السلفة', 'تاريخ الصرف']);

    const file = writeXlsx([{
      name: 'x',
      header: tpl.rows[0],
      rows: [
        ['2000000001', 1500, '2026-09-01', 300, 'سفر'],
        ['2000000002', '2,000', '15/09/2026', '', ''],
        ['2999999999', 100, '2026-09-01', '', ''],
        ['2000000003', -5, '2026-09-01', '', ''],
        ['2000000003', 100, 'غير تاريخ', '', ''],
      ],
    }]);
    const r = await upload('/m/advances/import', file);
    assert.equal(r.status, 200);
    assert.equal(r.data.inserted, 2);
    assert.deepEqual(r.data.errors.map((e) => e.line), [4, 5, 6]);
    assert.match(r.data.errors[0].error, /2999999999/);
    const list = (await (await fetch(`${base}/m/advances`, { headers: { cookie } })).json());
    assert.equal(list.total, 2);
    assert.equal(list.totals.remaining, 3500);

    // الأعمدة المطلوبة
    const bad = writeXlsx([{ name: 'x', header: ['مبلغ السلفة'], rows: [[100]] }]);
    const b = await upload('/m/advances/import', bad);
    assert.equal(b.status, 400);
    assert.match(b.data.error, /الموظف - رقم الإقامة/);
  });

  await t.test('تصدير ثم إعادة استيراد العقود', async () => {
    const add = (body) => fetch(`${base}/m/contracts`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await add({ company_name: 'شركة أ', contract_type: 'تشغيل', end_date: '2027-05-01', value: 120000 });
    await add({ company_name: 'شركة ب', end_date: '2026-01-01' });
    const x = await download('/m/contracts/export.xlsx');
    assert.equal(x.rows.length, 3);
    assert.ok(x.rows[0].includes('الحالة'));
    const valueCol = x.rows[0].indexOf('قيمة العقد');
    assert.ok(x.rows.some((row) => row[valueCol] === 120000));

    const r = await upload('/m/contracts/import', writeXlsx([{ name: 'x', header: x.rows[0], rows: x.rows.slice(1) }]));
    assert.equal(r.data.inserted, 2);
    assert.equal(r.data.failed, 0);
    const expired = await download('/m/contracts/export.xlsx?status=expired');
    assert.equal(expired.rows.length, 3);
  });

  await t.test('الصلاحيات وسجل العمليات', async () => {
    const viewer = await loginAs('viewer');
    const file = writeXlsx([{ name: 'x', header: ['اسم الشركة', 'تاريخ الانتهاء'], rows: [['x', '2027-01-01']] }]);
    assert.equal((await upload('/m/contracts/import', file, viewer)).status, 403);
    assert.equal((await fetch(`${base}/m/contracts/export.xlsx`, { headers: { cookie: viewer } })).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    const { rows } = await pool.query("SELECT entity_type FROM audit_log WHERE action = 'import' ORDER BY id");
    assert.deepEqual([...new Set(rows.map((r) => r.entity_type))], ['residencies', 'advances', 'contracts']);
  });
});
