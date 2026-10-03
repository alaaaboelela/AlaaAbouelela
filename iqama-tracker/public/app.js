const $ = (id) => document.getElementById(id);
const form = $('form');
let residencies = [];

const STATUS_LABEL = { expired: 'منتهية', expiring: 'قريبة من الانتهاء', valid: 'سارية' };

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function formatDates(iso) {
  const date = new Date(iso + 'T00:00:00');
  const greg = date.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
  let hijri = '';
  try {
    hijri = date.toLocaleDateString('ar-SA-u-ca-islamic-umalqura', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { /* المتصفح لا يدعم التقويم الهجري */ }
  return { greg, hijri };
}

function remainingText(days) {
  if (days < 0) return `منتهية منذ ${-days} يوم`;
  if (days === 0) return 'تنتهي اليوم';
  return `${days} يوم`;
}

// ---------- العرض ----------

function render() {
  const query = $('search').value.trim().toLowerCase();
  const filter = $('filter').value;
  const visible = residencies.filter((r) =>
    (filter === 'all' || r.status === filter) &&
    (!query || r.name.toLowerCase().includes(query) || r.iqamaNumber.includes(query)));

  $('rows').innerHTML = visible.map((r) => {
    const { greg, hijri } = formatDates(r.expiryDate);
    return `
      <tr class="${r.status}">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.iqamaNumber)}</td>
        <td>${escapeHtml(r.nationality || '—')}</td>
        <td>${greg}${hijri ? `<span class="hijri">${hijri}</span>` : ''}</td>
        <td>${remainingText(r.daysLeft)}</td>
        <td><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span></td>
        <td><div class="row-actions">
          <button class="small secondary" data-edit="${r.id}">تعديل</button>
          <button class="small danger" data-delete="${r.id}">حذف</button>
        </div></td>
      </tr>`;
  }).join('');
  $('empty').hidden = visible.length > 0;

  const count = (s) => residencies.filter((r) => r.status === s).length;
  $('statTotal').textContent = residencies.length;
  $('statExpiring').textContent = count('expiring');
  $('statExpired').textContent = count('expired');
  $('statValid').textContent = count('valid');
}

function renderAlerts({ alerts, alertDays }) {
  const banner = $('alertBanner');
  if (!alerts.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <strong>⚠️ تنبيه: ${alerts.length} إقامة منتهية أو ستنتهي خلال ${alertDays} يوم</strong>
    <ul>${alerts.map((r) =>
      `<li>${escapeHtml(r.name)} (${escapeHtml(r.iqamaNumber)}) — ${remainingText(r.daysLeft)}</li>`).join('')}
    </ul>`;
}

// إشعار المتصفح مرة واحدة يوميًا لكل إقامة
function notify(alerts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = new Date().toISOString().slice(0, 10);
  let shown = {};
  try { shown = JSON.parse(localStorage.getItem('notified') || '{}'); } catch { /* تجاهل */ }

  for (const r of alerts) {
    if (shown[r.id] === today) continue;
    new Notification('تنبيه انتهاء إقامة', {
      body: `${r.name} (${r.iqamaNumber}): ${remainingText(r.daysLeft)}`,
      tag: r.id,
    });
    shown[r.id] = today;
  }
  try { localStorage.setItem('notified', JSON.stringify(shown)); } catch { /* تجاهل */ }
}

async function refresh() {
  const [list, alertData] = await Promise.all([api('/api/residencies'), api('/api/alerts')]);
  residencies = list;
  render();
  renderAlerts(alertData);
  notify(alertData.alerts);
}

// ---------- النموذج ----------

function resetForm() {
  form.reset();
  form.elements.id.value = '';
  $('formTitle').textContent = 'إضافة إقامة جديدة';
  $('submitBtn').textContent = 'إضافة';
  $('cancelEdit').hidden = true;
  $('formError').hidden = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const id = data.id;
  delete data.id;
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

$('cancelEdit').addEventListener('click', resetForm);

$('rows').addEventListener('click', async (e) => {
  const editId = e.target.dataset.edit;
  const deleteId = e.target.dataset.delete;

  if (editId) {
    const r = residencies.find((x) => x.id === editId);
    for (const key of ['id', 'name', 'iqamaNumber', 'expiryDate', 'nationality', 'phone', 'employer', 'notes']) {
      form.elements[key].value = r[key] || '';
    }
    $('formTitle').textContent = `تعديل إقامة: ${r.name}`;
    $('submitBtn').textContent = 'حفظ التعديل';
    $('cancelEdit').hidden = false;
    form.scrollIntoView({ behavior: 'smooth' });
  }

  if (deleteId) {
    const r = residencies.find((x) => x.id === deleteId);
    if (!confirm(`حذف إقامة ${r.name}؟`)) return;
    await api(`/api/residencies/${deleteId}`, { method: 'DELETE' });
    await refresh();
  }
});

$('search').addEventListener('input', render);
$('filter').addEventListener('change', render);

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
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    try { localStorage.removeItem('notified'); } catch { /* تجاهل */ }
    await refresh();
  }
});

(async () => {
  const settings = await api('/api/settings');
  $('alertDays').value = settings.alertDays;
  await refresh();
  setInterval(refresh, 60 * 60 * 1000); // تحديث كل ساعة
})();
