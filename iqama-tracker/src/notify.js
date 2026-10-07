// تنبيهات SMS وواتساب: Unifonic أو تقنيات أو Twilio أو Webhook عام، وواتساب للأعمال (Meta Cloud API)
const config = require('./config');

// طريقة الإرسال الفعلية (قابلة للاستبدال في الاختبارات)
let transport = async (url, options) => {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new Error(`تعذر الاتصال بمزود الرسائل (${new URL(url).host}): ${err.cause?.code || err.message}`);
  }
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* نص */ }
  return { ok: res.ok, status: res.status, body };
};
function setTransport(fn) { transport = fn; }

const PROVIDERS = { unifonic: 'Unifonic', taqnyat: 'تقنيات (Taqnyat)', twilio: 'Twilio', webhook: 'Webhook' };

/** رقم سعودي بأي صيغة (05.., 5.., 9665.., +9665.., ٠٥..) → 9665XXXXXXXX؛ الأرقام الدولية الأخرى تبقى كما هي */
function normalizePhone(v) {
  let s = String(v || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[\s\-()]/g, '');
  s = s.replace(/^\+/, '').replace(/^00/, '');
  if (/^05\d{8}$/.test(s)) s = `966${s.slice(1)}`;
  else if (/^5\d{8}$/.test(s)) s = `966${s}`;
  return /^\d{8,15}$/.test(s) ? s : null;
}

const mask = (p) => (p.length > 6 ? `${p.slice(0, 5)}•••${p.slice(-3)}` : p);

function smsEnabled() {
  const c = config.sms;
  if (!config.alertPhones.length) return false;
  switch (c.provider) {
    case 'unifonic': return Boolean(c.unifonicAppSid);
    case 'taqnyat': return Boolean(c.taqnyatToken && c.sender);
    case 'twilio': return Boolean(c.twilioSid && c.twilioToken && c.sender);
    case 'webhook': return Boolean(c.webhookUrl);
    default: return false;
  }
}

function whatsappEnabled() {
  const w = config.whatsapp;
  return Boolean(config.alertPhones.length && w.token && w.phoneNumberId);
}

function status() {
  return {
    phones: config.alertPhones.map((p) => (normalizePhone(p) ? mask(normalizePhone(p)) : `${p} (رقم غير صحيح)`)),
    sms: { enabled: smsEnabled(), provider: PROVIDERS[config.sms.provider] || null },
    whatsapp: { enabled: whatsappEnabled(), template: config.whatsapp.template || null },
  };
}

function check(res, provider) {
  // Unifonic ترجع 200 مع success:false عند الخطأ
  if (!res.ok || res.body?.success === false || res.body?.success === 'false') {
    const msg = res.body?.message || res.body?.error?.message || res.body?.errorCode || `HTTP ${res.status}`;
    throw new Error(`${provider}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return res.body;
}

async function sendSms(phones, text) {
  const c = config.sms;
  const to = phones.map(normalizePhone).filter(Boolean);
  if (!to.length) throw new Error('لا توجد أرقام جوال صحيحة في ALERT_PHONES');
  switch (c.provider) {
    case 'unifonic':
      for (const p of to) {
        check(await transport('https://el.cloud.unifonic.com/rest/SMS/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ AppSid: c.unifonicAppSid, SenderID: c.sender, Recipient: p, Body: text }).toString(),
        }), 'Unifonic');
      }
      break;
    case 'taqnyat':
      check(await transport('https://api.taqnyat.sa/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.taqnyatToken}` },
        body: JSON.stringify({ recipients: to, body: text, sender: c.sender }),
      }), 'Taqnyat');
      break;
    case 'twilio':
      for (const p of to) {
        check(await transport(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.twilioSid)}/Messages.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${c.twilioSid}:${c.twilioToken}`).toString('base64')}`,
          },
          body: new URLSearchParams({ To: `+${p}`, From: c.sender, Body: text }).toString(),
        }), 'Twilio');
      }
      break;
    case 'webhook':
      check(await transport(c.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'sms', to, message: text }),
      }), 'Webhook');
      break;
    default:
      throw new Error('SMS_PROVIDER غير مضبوط');
  }
  return to.length;
}

async function sendWhatsapp(phones, text) {
  const w = config.whatsapp;
  const to = phones.map(normalizePhone).filter(Boolean);
  if (!to.length) throw new Error('لا توجد أرقام جوال صحيحة في ALERT_PHONES');
  const url = `https://graph.facebook.com/${w.apiVersion}/${encodeURIComponent(w.phoneNumberId)}/messages`;
  for (const p of to) {
    // القالب المعتمد يسمح بالإرسال في أي وقت؛ بدون قالب الرسالة النصية توصل فقط لو المستلم راسل الرقم خلال 24 ساعة
    const message = w.template
      ? {
        type: 'template',
        template: {
          name: w.template,
          language: { code: w.language },
          components: [{ type: 'body', parameters: [{ type: 'text', text: text.replace(/\s*\n+\s*/g, ' · ').slice(0, 1000) }] }],
        },
      }
      : { type: 'text', text: { body: text } };
    check(await transport(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${w.token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: p, ...message }),
    }), 'WhatsApp');
  }
  return to.length;
}

/** ملخص قصير يناسب SMS: الأعداد فقط، والتفاصيل في المنصة والإيميل */
function buildSummary({ total, alertDays, expired: expiredCount, items = [] }, modules = []) {
  const expired = expiredCount ?? items.filter((r) => r.daysLeft < 0).length;
  const lines = [];
  if (total) {
    lines.push(`الإقامات: ${total - expired > 0 ? `${total - expired} تنتهي خلال ${alertDays} يوم` : ''}${total - expired > 0 && expired ? '، ' : ''}${expired ? `${expired} منتهية` : ''}`);
  }
  for (const m of modules) lines.push(`${m.label}: ${m.rows.length}`);
  if (!lines.length) return null;
  return `تنبيه منصة الإقامات\n${lines.join('\n')}\nالتفاصيل في المنصة.`;
}

module.exports = { normalizePhone, smsEnabled, whatsappEnabled, status, sendSms, sendWhatsapp, buildSummary, setTransport };
