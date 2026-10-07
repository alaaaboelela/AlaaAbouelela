// اختبارات تنبيهات SMS وواتساب (بدون إرسال حقيقي: نلتقط الطلبات بدل إرسالها)
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = TEST_DB || '';
process.env.ALERT_EMAILS = '';
process.env.ALERT_PHONES = '0501234567, +966 55 111 2222, رقم-غلط';
process.env.SMS_PROVIDER = 'unifonic';
process.env.UNIFONIC_APP_SID = 'app-sid';
process.env.SMS_SENDER = 'IQAMA';
process.env.WHATSAPP_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
process.env.WHATSAPP_TEMPLATE = 'iqama_alert';

const config = require('../src/config');
const notify = require('../src/notify');

const sent = [];
notify.setTransport(async (url, options) => {
  sent.push({ url, ...options });
  return { ok: true, status: 200, body: { success: true } };
});

test('توحيد أرقام الجوال', () => {
  assert.equal(notify.normalizePhone('0501234567'), '966501234567');
  assert.equal(notify.normalizePhone('٠٥٠١٢٣٤٥٦٧'), '966501234567');
  assert.equal(notify.normalizePhone('+966 50 123 4567'), '966501234567');
  assert.equal(notify.normalizePhone('00966501234567'), '966501234567');
  assert.equal(notify.normalizePhone('501234567'), '966501234567');
  assert.equal(notify.normalizePhone('+201001234567'), '201001234567');
  assert.equal(notify.normalizePhone('abc'), null);
});

test('الملخص القصير', () => {
  const text = notify.buildSummary({ total: 5, expired: 2, alertDays: 30 }, [{ label: 'العقود', rows: [1, 2] }]);
  assert.match(text, /3 تنتهي خلال 30 يوم، 2 منتهية/);
  assert.match(text, /العقود: 2/);
  assert.equal(notify.buildSummary({ total: 0, expired: 0, alertDays: 30 }, []), null);
});

test('المزودون', async (t) => {
  await t.test('Unifonic', async () => {
    sent.length = 0;
    assert.equal(notify.smsEnabled(), true);
    assert.equal(await notify.sendSms(config.alertPhones, 'نص'), 2);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].url, 'https://el.cloud.unifonic.com/rest/SMS/messages');
    const form = new URLSearchParams(sent[0].body);
    assert.deepEqual([form.get('AppSid'), form.get('SenderID'), form.get('Recipient'), form.get('Body')],
      ['app-sid', 'IQAMA', '966501234567', 'نص']);
    assert.equal(new URLSearchParams(sent[1].body).get('Recipient'), '966551112222');
  });

  await t.test('تقنيات', async () => {
    sent.length = 0;
    Object.assign(config.sms, { provider: 'taqnyat', taqnyatToken: 'tq' });
    await notify.sendSms(config.alertPhones, 'نص');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers.Authorization, 'Bearer tq');
    assert.deepEqual(JSON.parse(sent[0].body), { recipients: ['966501234567', '966551112222'], body: 'نص', sender: 'IQAMA' });
  });

  await t.test('Twilio', async () => {
    sent.length = 0;
    Object.assign(config.sms, { provider: 'twilio', twilioSid: 'AC1', twilioToken: 'tok', sender: '+15005550006' });
    await notify.sendSms(['0501234567'], 'نص');
    assert.equal(sent[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    assert.equal(new URLSearchParams(sent[0].body).get('To'), '+966501234567');
    assert.equal(sent[0].headers.Authorization, `Basic ${Buffer.from('AC1:tok').toString('base64')}`);
  });

  await t.test('واتساب بقالب معتمد', async () => {
    sent.length = 0;
    await notify.sendWhatsapp(['0501234567'], 'سطر 1\nسطر 2');
    assert.equal(sent[0].url, 'https://graph.facebook.com/v21.0/123456/messages');
    const body = JSON.parse(sent[0].body);
    assert.equal(body.to, '966501234567');
    assert.equal(body.template.name, 'iqama_alert');
    assert.equal(body.template.components[0].parameters[0].text, 'سطر 1 · سطر 2');
  });

  await t.test('خطأ من المزود يظهر برسالته', async () => {
    notify.setTransport(async () => ({ ok: true, status: 200, body: { success: false, message: 'Invalid AppSid' } }));
    Object.assign(config.sms, { provider: 'unifonic' });
    await assert.rejects(notify.sendSms(['0501234567'], 'x'), /Unifonic: Invalid AppSid/);
    notify.setTransport(async (url, options) => {
      sent.push({ url, ...options });
      return { ok: true, status: 200, body: { success: true } };
    });
  });
});

test('إرسال التنبيه من المنصة', { skip: !TEST_DB && 'TEST_DATABASE_URL غير مضبوط' }, async (t) => {
  const { pool, migrate } = require('../src/db');
  const { hashPassword } = require('../src/auth');
  const { createApp } = require('../src/server');
  await migrate();
  await pool.query(`TRUNCATE residencies, users, contracts, driver_cards, cars, car_events, advances,
    advance_payments, custody, documents, evaluations, audit_log, employee_docs, visas, leaves, branches RESTART IDENTITY CASCADE`);
  await pool.query("UPDATE settings SET value = '30' WHERE key = 'alert_days'");
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
  const post = async (url, c = cookie) => {
    const res = await fetch(base + url, { method: 'POST', headers: { cookie: c } });
    return { status: res.status, data: await res.json() };
  };

  const me = await (await fetch(`${base}/me`, { headers: { cookie } })).json();
  assert.equal(me.messaging.sms.enabled, true);
  assert.equal(me.messaging.whatsapp.enabled, true);
  assert.deepEqual(me.messaging.phones, ['96650•••567', '96655•••222', 'رقم-غلط (رقم غير صحيح)']);

  // لا يوجد شيء للتنبيه عنه
  assert.deepEqual((await post('/alerts/send-sms')).data, { sent: false, recipients: 0 });

  const d = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  await pool.query("INSERT INTO residencies (name, iqama_number, expiry_date) VALUES ('سالم', '2000000001', $1)", [d]);
  sent.length = 0;
  const r = await post('/alerts/send-whatsapp');
  assert.equal(r.status, 200);
  assert.equal(r.data.recipients, 2);
  assert.match(r.data.text, /1 تنتهي خلال 30 يوم/);
  assert.equal(sent.length, 2);

  assert.equal((await post('/alerts/send-sms', await login('hr1'))).status, 403);
});
