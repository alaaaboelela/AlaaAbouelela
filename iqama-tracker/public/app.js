const $ = (id) => document.getElementById(id);
const form = $('form');
const STATUS_LABEL = { expired: 'منتهية', expiring: 'قريبة من الانتهاء', valid: 'سارية' };
const state = { page: 1, pageSize: 50, total: 0, items: [] };

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('يجب تسجيل الدخول');
  }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function remainingText(days) {
  if (days < 0) return `منتهية منذ ${-days} يوم`;
  if (days === 0) return 'تنتهي اليوم';
  return `${days} يوم`;
}

function formatGregorian(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ---------- القائمة ----------

function listQuery() {
  const params = new URLSearchParams({
    page: state.page,
    pageSize: state.pageSize,
    sort: $('sort').value,
  });
  if ($('filter').value !== 'all') params.set('status', $('filter').value);
  if ($('search').value.trim()) params.set('q', $('search').value.trim());
  return params;
}

async function loadList() {
  const data = await api(`/api/residencies?${listQuery()}`);
  Object.assign(state, data);

  $('rows').innerHTML = data.items.map((r) => `
    <tr class="${r.status}">
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.iqamaNumber)}</td>
      <td>${escapeHtml(r.employer || '—')}</td>
      <td>${escapeHtml(r.nationality || '—')}</td>
      <td>${escapeHtml(r.expiryDateHijri)} هـ<span class="sub">${formatGregorian(r.expiryDate)}</span></td>
      <td>${remainingText(r.daysLeft)}</td>
      <td><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span></td>
      <td><div class="row-actions">
        <button class="small secondary" data-edit="${r.id}">تعديل</button>
        <button class="small danger" data-delete="${r.id}">حذف</button>
      </div></td>
    </tr>`).join('');
  $('empty').hidden = data.items.length > 0;

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  $('pageInfo').textContent = `صفحة ${data.page} من ${pages} — ${data.total.toLocaleString('ar-EG')} نتيجة`;
  $('prev').disabled = data.page <= 1;
  $('next').disabled = data.page >= pages;
}

async function loadStats() {
  const s = await api('/api/stats');
  $('statTotal').textContent = s.total.toLocaleString('ar-EG');
  $('statExpiring').textContent = s.expiring.toLocaleString('ar-EG');
  $('statExpired').textContent = s.expired.toLocaleString('ar-EG');
  $('statValid').textContent = s.valid.toLocaleString('ar-EG');

  const banner = $('alertBanner');
  banner.hidden = s.expiring === 0;
  banner.innerHTML = `
    <strong>⚠️ تنبيه: ${s.expiring.toLocaleString('ar-EG')} إقامة ستنتهي خلال ${s.alertDays} يوم</strong>
    ${s.withinWeek ? `— منها <b>${s.withinWeek.toLocaleString('ar-EG')}</b> خلال أسبوع` : ''}
    <button class="small" data-status="expiring">عرضها</button>`;
  notify(s);
}

// إشعار واحد يوميًا بملخص العدد
function notify(stats) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !stats.expiring) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem('notifiedOn') === today) return;
    localStorage.setItem('notifiedOn', today);
  } catch { /* تجاهل */ }
  new Notification('تنبيه انتهاء الإقامات', {
    body: `${stats.expiring} إقامة ستنتهي خلال ${stats.alertDays} يوم، و ${stats.expired} منتهية`,
    tag: 'iqama-alert',
  });
}

async function refresh() {
  await Promise.all([loadList(), loadStats()]);
}

function showStatus(status) {
  $('filter').value = status;
  state.page = 1;
  loadList();
  $('rows').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- النموذج ----------

function calendar() {
  return form.elements.calendar.value;
}

function updateDateHint() {
  const hijri = form.elements.expiryDateHijri;
  const greg = form.elements.expiryDate;
  if (calendar() === 'hijri') {
    const g = hijri.value ? Hijri.hijriToGregorian(hijri.value) : null;
    $('dateHint').textContent = hijri.value ? (g ? `يوافق ${formatGregorian(g)}` : 'تاريخ هجري غير صحيح') : '';
  } else {
    const h = greg.value ? Hijri.gregorianToHijri(greg.value) : null;
    $('dateHint').textContent = h ? `يوافق ${h} هـ` : '';
  }
}

function setCalendar(value) {
  const hijri = form.elements.expiryDateHijri;
  const greg = form.elements.expiryDate;
  // نقل القيمة الحالية للتقويم الآخر
  if (value === 'gregorian' && hijri.value) greg.value = Hijri.hijriToGregorian(hijri.value) || '';
  if (value === 'hijri' && greg.value) hijri.value = Hijri.gregorianToHijri(greg.value) || '';
  form.querySelector(`input[name=calendar][value=${value}]`).checked = true;
  hijri.hidden = value !== 'hijri';
  greg.hidden = value === 'hijri';
  hijri.required = value === 'hijri';
  greg.required = value !== 'hijri';
  updateDateHint();
}

function resetForm() {
  form.reset();
  form.elements.id.value = '';
  setCalendar('hijri');
  $('formTitle').textContent = 'إضافة إقامة جديدة';
  $('submitBtn').textContent = 'إضافة';
  $('cancelEdit').hidden = true;
  $('formError').hidden = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const { id } = data;
  if (calendar() === 'hijri') {
    data.expiryDate = Hijri.hijriToGregorian(data.expiryDateHijri) || '';
    if (!data.expiryDate) {
      $('formError').textContent = 'تاريخ الانتهاء الهجري غير صحيح (مثال: 1448-04-22)';
      $('formError').hidden = false;
      return;
    }
  }
  delete data.id;
  delete data.calendar;
  delete data.expiryDateHijri;
  try {
    await api(id ? `/api/residencies/${id}` : '/api/residencies', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(data),
    });
    resetForm();
    await refresh();
  } catch (err) {
    $('formError').textContent = err.message;
    $('formError').hidden = false;
  }
});

form.addEventListener('change', (e) => {
  if (e.target.name === 'calendar') setCalendar(e.target.value);
});
form.elements.expiryDateHijri.addEventListener('input', updateDateHint);
form.elements.expiryDate.addEventListener('input', updateDateHint);
$('cancelEdit').addEventListener('click', resetForm);

document.addEventListener('click', (e) => {
  const status = e.target.closest('[data-status]')?.dataset.status;
  if (status) showStatus(status);
});

$('rows').addEventListener('click', async (e) => {
  const editId = e.target.dataset.edit;
  const deleteId = e.target.dataset.delete;

  if (editId) {
    const r = state.items.find((x) => x.id === editId);
    for (const key of ['id', 'name', 'iqamaNumber', 'expiryDate', 'expiryDateHijri', 'nationality', 'phone', 'employer', 'notes']) {
      form.elements[key].value = r[key] || '';
    }
    setCalendar(calendar());
    $('formTitle').textContent = `تعديل إقامة: ${r.name}`;
    $('submitBtn').textContent = 'حفظ التعديل';
    $('cancelEdit').hidden = false;
    $('formError').hidden = true;
    form.scrollIntoView({ behavior: 'smooth' });
  }

  if (deleteId) {
    const r = state.items.find((x) => x.id === deleteId);
    if (!confirm(`حذف إقامة ${r.name} (${r.iqamaNumber})؟`)) return;
    await api(`/api/residencies/${deleteId}`, { method: 'DELETE' });
    await refresh();
  }
});

// ---------- البحث والفلترة والصفحات ----------

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.page = 1; loadList(); }, 300);
});
$('filter').addEventListener('change', () => { state.page = 1; loadList(); });
$('sort').addEventListener('change', () => { state.page = 1; loadList(); });
$('prev').addEventListener('click', () => { state.page -= 1; loadList(); });
$('next').addEventListener('click', () => { state.page += 1; loadList(); });

// ---------- استيراد وتصدير ----------

$('exportBtn').addEventListener('click', () => {
  const params = listQuery();
  params.delete('page');
  params.delete('pageSize');
  location.href = `/api/residencies/export.csv?${params}`;
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const out = $('importResult');
  out.hidden = false;
  out.textContent = 'جاري الاستيراد...';
  try {
    const res = await api('/api/residencies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: await file.text(),
    });
    out.innerHTML = `تمت إضافة ${res.inserted} وتحديث ${res.updated}` +
      (res.failed ? ` — <span class="error">${res.failed} صف فيه أخطاء:</span><br>` +
        res.errors.slice(0, 20).map((x) => `سطر ${x.line}: ${escapeHtml(x.error)}`).join('<br>') : '');
    await refresh();
  } catch (err) {
    out.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
});

// ---------- الإعدادات ----------

$('saveSettings').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ alertDays: Number($('alertDays').value) }),
    });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('enableNotify').addEventListener('click', async () => {
  if (!('Notification' in window)) return alert('المتصفح لا يدعم الإشعارات');
  if ((await Notification.requestPermission()) === 'granted') {
    try { localStorage.removeItem('notifiedOn'); } catch { /* تجاهل */ }
    await loadStats();
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

(async () => {
  const me = await api('/api/me').catch(() => null);
  if (!me) return; // تم التحويل لصفحة الدخول
  $('user').textContent = me.username;
  $('alertDays').value = (await api('/api/settings')).alertDays;
  setCalendar('hijri');
  await refresh();
  setInterval(loadStats, 60 * 60 * 1000);
})();
