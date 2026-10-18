// اختبارات التحقق بخطوتين (TOTP) والرموز الاحتياطية
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';
process.env.SESSION_SECRET ||= 'test-secret';

test('خوارزمية الرموز (RFC 4226 / 6238)', () => {
  const { hotp, base32, unbase32, checkTotp } = require('../src/twofactor');
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(unbase32(secret).toString(), '12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  assert.deepEqual(expected.map((_, i) => hotp(secret, i)), expected);
  const now = 59 * 1000; // الخطوة رقم 1
  assert.equal(checkTotp(secret, '287082', -1, now), 1);
  assert.equal(checkTotp(secret, '٢٨٧٠٨٢', -1, now), 1); // أرقام عربية
  assert.equal(checkTotp(secret, '287082', 1, now), null); // نفس الرمز مرتين
  assert.equal(checkTotp(secret, '359152', -1, now), 2); // فرق ساعة 30 ثانية
  assert.equal(checkTotp(secret, '969429', -1, now), null);
});

test('الدخول بالتحقق بخطوتين', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  const { hotp } = require('../src/twofactor');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'admin'), ('chief', $1, 'admin')", [hashPassword('secret123')]);
  const server = createApp().listen(0);
  t.after(async () => {
    server.close();
    await pool.end();
  });
  const base = `http://localhost:${server.address().port}/api`;
  const post = (url, body, cookie) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}),
  });
  const json = async (res) => ({ status: res.status, data: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') });
  const login = async (u = 'boss', p = 'secret123') => json(await post('/login', { username: u, password: p }));
  const cookieOf = (r) => r.cookie.split(';')[0];
  const counter = () => Math.floor(Date.now() / 30000);

  const first = await login();
  const cookie = cookieOf(first);
  let secret;
  let recovery;
  let enableCode;

  await t.test('التفعيل', async () => {
    assert.equal((await json(await fetch(`${base}/me/2fa`, { headers: { cookie } }))).data.enabled, false);
    assert.equal((await json(await post('/me/2fa/setup', { password: 'wrong' }, cookie))).status, 400);
    const setup = (await json(await post('/me/2fa/setup', { password: 'secret123' }, cookie))).data;
    secret = setup.secret.replace(/ /g, '');
    assert.match(setup.uri, /^otpauth:\/\/totp\//);
    assert.match(setup.qr, /^<svg/);
    assert.equal((await json(await post('/me/2fa/enable', { code: '000000' }, cookie))).status, 400);
    enableCode = hotp(secret, counter());
    const on = (await json(await post('/me/2fa/enable', { code: enableCode }, cookie))).data;
    assert.equal(on.recoveryCodes.length, 10);
    recovery = on.recoveryCodes;
    const me = (await json(await fetch(`${base}/me`, { headers: { cookie } }))).data;
    assert.equal(me.twoFactor, true);
  });

  await t.test('كلمة المرور لوحدها ما تكفيش', async () => {
    const r = await login();
    assert.equal(r.data.twoFactor, true);
    assert.equal(r.cookie, null);
    // التذكرة ما تنفعش كجلسة
    assert.equal((await fetch(`${base}/me`, { headers: { cookie: `session=${r.data.ticket}` } })).status, 401);
    const bad = await json(await post('/login/2fa', { ticket: r.data.ticket, code: '123456' }));
    assert.equal(bad.status, 401);
    // الرمز اللي اتستخدم في التفعيل ما يتقبلش تاني
    assert.equal((await json(await post('/login/2fa', { ticket: r.data.ticket, code: enableCode }))).status, 401);
    const ok = await json(await post('/login/2fa', { ticket: r.data.ticket, code: hotp(secret, counter() + 1) }));
    assert.equal(ok.status, 200);
    assert.match(ok.cookie, /^session=/);
    assert.equal((await fetch(`${base}/me`, { headers: { cookie: cookieOf(ok) } })).status, 200);
    // التذكرة اتستخدمت
    assert.equal((await json(await post('/login/2fa', { ticket: r.data.ticket, code: hotp(secret, counter() + 1) }))).status, 401);
  });

  await t.test('الرمز الاحتياطي مرة واحدة', async () => {
    const r1 = await login();
    assert.equal((await json(await post('/login/2fa', { ticket: r1.data.ticket, code: recovery[0].toUpperCase() }))).status, 200);
    const r2 = await login();
    assert.equal((await json(await post('/login/2fa', { ticket: r2.data.ticket, code: recovery[0] }))).status, 401);
    assert.equal((await json(await fetch(`${base}/me/2fa`, { headers: { cookie } }))).data.recoveryLeft, 9);
  });

  await t.test('5 محاولات خاطئة تلغي التذكرة', async () => {
    const r = await login();
    for (let i = 0; i < 5; i++) await post('/login/2fa', { ticket: r.data.ticket, code: '000000' });
    const last = await json(await post('/login/2fa', { ticket: r.data.ticket, code: recovery[1] }));
    assert.equal(last.status, 401);
    assert.equal(last.data.expired, true);
    // دخول ناجح يصفّر عداد المحاولات
    const ok = await login();
    assert.equal((await json(await post('/login/2fa', { ticket: ok.data.ticket, code: recovery[1] }))).status, 200);
  });

  await t.test('الإيقاف وإلغاء المدير', async () => {
    assert.equal((await json(await post('/me/2fa/disable', { password: 'secret123', code: '000000' }, cookie))).status, 400);
    const chief = cookieOf(await login('chief'));
    const users = (await json(await fetch(`${base}/users`, { headers: { cookie: chief } }))).data;
    assert.equal(users.find((u) => u.username === 'boss').two_factor, true);
    const id = users.find((u) => u.username === 'boss').id;
    assert.equal((await json(await post(`/users/${id}/2fa/reset`, {}, chief))).status, 200);
    const r = await login();
    assert.equal(r.status, 200);
    assert.equal(r.data.twoFactor, undefined);
    assert.match(r.cookie, /^session=/);
    await new Promise((res) => setTimeout(res, 50));
    const log = (await json(await fetch(`${base}/audit`, { headers: { cookie: chief } }))).data.items.map((x) => x.summary);
    assert.ok(log.includes('تسجيل دخول برمز احتياطي (باقي 9)'));
    assert.ok(log.some((x) => x.startsWith('إلغاء التحقق بخطوتين')));
  });
});
