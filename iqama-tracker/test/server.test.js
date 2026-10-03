const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iqama-')), 'db.json');
const { server } = require('../server');

function isoInDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('API الإقامات والتنبيهات', async (t) => {
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const call = async (url, method = 'GET', body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };

  const bad = await call('/api/residencies', 'POST', { name: '' });
  assert.equal(bad.status, 400);

  const soon = await call('/api/residencies', 'POST', { name: 'أحمد', iqamaNumber: '2111', expiryDate: isoInDays(10) });
  assert.equal(soon.status, 201);
  assert.equal(soon.data.status, 'expiring');
  assert.equal(soon.data.daysLeft, 10);

  const expired = await call('/api/residencies', 'POST', { name: 'محمد', iqamaNumber: '2222', expiryDate: isoInDays(-3) });
  assert.equal(expired.data.status, 'expired');

  const valid = await call('/api/residencies', 'POST', { name: 'سارة', iqamaNumber: '2333', expiryDate: isoInDays(200) });
  assert.equal(valid.data.status, 'valid');

  const alerts = await call('/api/alerts');
  assert.equal(alerts.data.count, 2);
  assert.deepEqual(alerts.data.alerts.map((a) => a.name), ['محمد', 'أحمد']);

  // تغيير فترة التنبيه إلى 5 أيام يخرج أحمد من التنبيهات
  await call('/api/settings', 'PUT', { alertDays: 5 });
  assert.equal((await call('/api/alerts')).data.count, 1);

  const updated = await call(`/api/residencies/${valid.data.id}`, 'PUT', { name: 'سارة', iqamaNumber: '2333', expiryDate: isoInDays(2) });
  assert.equal(updated.data.status, 'expiring');

  assert.equal((await call(`/api/residencies/${expired.data.id}`, 'DELETE')).status, 204);
  assert.equal((await call('/api/residencies')).data.length, 2);
});
