// بوابة الموظف: صفحة مستقلة خفيفة للموبايل، الموظف يشوف ملفه ويطلب إجازة
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(n);
const money = (n) => `${fmt(Math.round(Number(n) * 100) / 100)} ر.س`;
const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="icons.svg#i-${name}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const greg = (iso, month = 'long') => new Date(`${iso}T12:00:00`).toLocaleDateString(I18N.locale, { day: 'numeric', month, year: 'numeric' });
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TONE = { expired: ['expired', 'منتهية'], expiring: ['expiring', 'قريبة من الانتهاء'], valid: ['valid', 'سارية'] };
const APPROVAL = { معلقة: ['expiring', 'بانتظار الاعتماد'], معتمدة: ['valid', 'معتمدة'], مرفوضة: ['expired', 'مرفوضة'] };

function remaining(days) {
  if (days < 0) return `منتهية منذ ${fmt(-days)} يوم`;
  if (days === 0) return 'تنتهي اليوم';
  if (days === 1) return 'تنتهي غدًا';
  return `باقي ${fmt(days)} ${days <= 10 ? 'أيام' : 'يوم'}`;
}

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('يجب تسجيل الدخول');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 3800);
}

function openModal(d) {
  d.classList.remove('closing');
  d.showModal();
}
function closeModal(d) {
  if (!d.open) return;
  if (reduceMotion) return d.close();
  d.classList.add('closing');
  return d.addEventListener('animationend', () => { d.classList.remove('closing'); d.close(); }, { once: true });
}
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(d); });
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) closeModal(d); });
}

const empty = (text) => `<li class="portal-empty">${esc(text)}</li>`;
let data = null;

function render() {
  const e = data.employee;
  $('pCompany').textContent = data.company || 'بوابة الموظف';
  document.title = `بوابة الموظف · ${e.name}`;
  const [tone, label] = TONE[e.status];
  // الحلقة: نسبة ما تبقى من سنة الإقامة
  const pct = Math.max(0, Math.min(1, e.daysLeft / 365));
  const initials = e.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
  $('pHero').innerHTML = `
    <div class="portal-me">
      ${e.photo ? '<img class="portal-photo" src="/api/portal/photo" alt="">' : `<span class="portal-photo initials">${esc(initials)}</span>`}
      <div>
        <h1>${esc(e.name)}</h1>
        <p><span class="mono">${esc(e.iqamaNumber)}</span>${e.nationality ? ` · ${esc(e.nationality)}` : ''}</p>
        <p class="muted">${esc([e.branch, e.employer].filter(Boolean).join(' · '))}</p>
      </div>
    </div>
    <div class="portal-iqama ${tone}">
      <div class="iq-ring" style="--p:${pct}"><b>${e.daysLeft < 0 ? '!' : fmt(e.daysLeft)}</b><small>${e.daysLeft < 0 ? '' : 'يوم'}</small></div>
      <div>
        <small>انتهاء الإقامة</small>
        <strong>${esc(greg(e.expiryDate))}</strong>
        <span class="muted">${esc(e.expiryHijri)} هـ</span>
        <span class="pill ${tone} sm">${esc(label)} · ${esc(remaining(e.daysLeft))}</span>
      </div>
    </div>`;

  const l = data.leave;
  $('pLeaveSub').textContent = `الرصيد السنوي ${fmt(l.entitlement)} يوم`;
  const usedPct = l.entitlement ? Math.min(100, (l.used / l.entitlement) * 100) : 0;
  $('pLeaveMeter').innerHTML = `
    <div class="meter-nums"><span><b>${fmt(Math.max(0, l.balance))}</b> يوم متبقي</span><span class="muted">استخدمت ${fmt(l.used)} هذا العام</span></div>
    <div class="meter"><span style="width:${usedPct}%"></span></div>`;
  $('pLeaveList').innerHTML = l.requests.length ? l.requests.map((r) => {
    const [t, lbl] = APPROVAL[r.approval] || ['neutral', r.approval];
    return `<li>
      <div class="li-main"><strong>${esc(r.type)} · ${fmt(r.days)} ${r.days <= 10 && r.days > 2 ? 'أيام' : 'يوم'}</strong>
        <small>${esc(greg(r.start, 'short'))} ← ${esc(greg(r.end, 'short'))}</small></div>
      <span class="pill ${t} sm">${esc(lbl)}</span>
      ${r.approval === 'معلقة' ? `<button class="icon-btn danger" data-cancel="${esc(r.id)}" title="إلغاء الطلب" aria-label="إلغاء الطلب">${icon('x')}</button>` : ''}
    </li>`;
  }).join('') : empty('لا توجد طلبات إجازة');

  $('pDocsList').innerHTML = data.docs.length ? data.docs.map((d) => {
    const [t, lbl] = TONE[d.status];
    return `<li><div class="li-main"><strong>${esc(d.type)}</strong><small>${d.number ? `<span class="mono">${esc(d.number)}</span> · ` : ''}${esc(greg(d.expiryDate, 'short'))}</small></div>
      <span class="pill ${t} sm" title="${esc(remaining(d.daysLeft))}">${esc(lbl)}</span></li>`;
  }).join('') : empty('لا توجد مستندات مسجّلة');

  const open = data.advances.filter((a) => a.remaining > 0);
  $('pAdvSub').textContent = open.length ? `المتبقي عليك: ${money(open.reduce((s, a) => s + a.remaining, 0))}` : 'لا توجد سلف قائمة';
  $('pAdvList').innerHTML = data.advances.length ? data.advances.map((a) => `
    <li><div class="li-main"><strong>${money(a.amount)}</strong><small>${esc(greg(a.issue_date, 'short'))}${a.installment ? ` · القسط ${money(a.installment)} شهريًا` : ''}</small>
      <div class="meter sm"><span style="width:${a.amount ? Math.min(100, (a.paid / a.amount) * 100) : 0}%"></span></div></div>
      ${a.remaining > 0 ? `<span class="li-amount">باقي ${money(a.remaining)}</span>` : `<span class="pill valid sm">${icon('check', 'icon-sm')}مسددة</span>`}</li>`).join('') : empty('لا توجد سلف');

  $('pCustodyList').innerHTML = data.custody.length ? data.custody.map((c) => `
    <li><div class="li-main"><strong>${esc(c.item)}${c.quantity > 1 ? ` × ${fmt(c.quantity)}` : ''}</strong>
      <small>${esc([c.category, c.serial].filter(Boolean).join(' · '))}${c.category || c.serial ? ' · ' : ''}من ${esc(greg(c.handed, 'short'))}</small></div></li>`).join('') : empty('لا توجد عهد مسلّمة لك');

  $('pVisas').hidden = !data.visas.length;
  $('pVisasList').innerHTML = data.visas.map((v) => {
    const late = !v.returned && v.deadline < data.today;
    return `<li><div class="li-main"><strong>${esc(v.type)}${v.destination ? ` · ${esc(v.destination)}` : ''}</strong>
      <small>${v.departure ? `سفر ${esc(greg(v.departure, 'short'))} · ` : ''}آخر موعد للعودة ${esc(greg(v.deadline, 'short'))}</small></div>
      ${v.returned ? `<span class="pill valid sm">رجعت ${esc(greg(v.returned, 'short'))}</span>` : late ? '<span class="pill expired sm">متأخر عن العودة</span>' : ''}</li>`;
  }).join('');

  $('leaveType').innerHTML = l.types.map((t) => `<option>${esc(t)}</option>`).join('');
  $('pMain').setAttribute('aria-busy', 'false');
}

async function load() {
  try {
    data = await api('/api/portal');
    render();
  } catch (err) {
    $('pHero').innerHTML = `<div class="portal-error">${icon('alert')}<span>${esc(err.message)}</span></div>`;
    for (const id of ['pLeave', 'pDocs', 'pAdvances', 'pCustody', 'pVisas']) $(id).hidden = true;
  }
}

// ---------- طلب إجازة ----------

function leaveDays() {
  const f = $('leaveForm').elements;
  const s = f.start.value;
  const e = f.end.value;
  if (!s || !e) return null;
  return Math.round((Date.parse(e) - Date.parse(s)) / 86400000) + 1;
}

$('pLeaveBtn').addEventListener('click', () => {
  $('leaveForm').reset();
  $('leaveError').hidden = true;
  $('leaveDays').innerHTML = '&nbsp;';
  openModal($('leaveModal'));
});

$('leaveForm').addEventListener('input', () => {
  const n = leaveDays();
  const f = $('leaveForm').elements;
  if (f.start.value && !f.end.value) f.end.min = f.start.value;
  $('leaveDays').textContent = n == null ? ' ' : n < 1 ? 'تاريخ النهاية قبل البداية'
    : `${fmt(n)} ${n > 2 && n <= 10 ? 'أيام' : 'يوم'}${f.type.value === 'سنوية' ? ` · رصيدك ${fmt(Math.max(0, data.leave.balance))} يوم` : ''}`;
});

$('leaveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('/api/portal/leaves', {
      method: 'POST',
      body: JSON.stringify({ type: f.type.value, start: f.start.value, end: f.end.value, reason: f.reason.value }),
    });
    closeModal($('leaveModal'));
    toast('تم إرسال طلب الإجازة لشؤون الموظفين');
    load();
  } catch (err) {
    $('leaveError').querySelector('span').textContent = err.message;
    $('leaveError').hidden = false;
  }
});

$('pLeaveList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  try {
    await api(`/api/portal/leaves/${b.dataset.cancel}`, { method: 'DELETE' });
    toast('تم إلغاء الطلب');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- الحساب ----------

$('pPwd').addEventListener('click', () => {
  $('pwdForm').reset();
  $('pwdError').hidden = true;
  openModal($('pwdModal'));
});

$('pwdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const fail = (msg) => {
    $('pwdError').querySelector('span').textContent = msg;
    $('pwdError').hidden = false;
  };
  if (f.next.value !== f.confirm.value) return fail('كلمتا المرور غير متطابقتين');
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: f.current.value, next: f.next.value }) });
    closeModal($('pwdModal'));
    toast('تم تغيير كلمة المرور');
  } catch (err) {
    fail(err.message);
  }
  return undefined;
});

$('pLogout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login.html');
});

function syncThemeIcon() {
  $('pThemeIcon').setAttribute('href', `icons.svg#i-${Theme.isDark() ? 'sun' : 'moon'}`);
}
$('pTheme').addEventListener('click', () => Theme.toggle());
document.addEventListener('themechange', syncThemeIcon);
syncThemeIcon();

(async () => {
  const me = await api('/api/me').catch(() => null);
  if (!me) return;
  if (me.role !== 'employee') {
    location.replace('/');
    return;
  }
  load();
})();
