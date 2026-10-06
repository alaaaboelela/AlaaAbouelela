const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// الفروع: current = الفرع المعروض (فارغ = كل الفروع)، locked = الحساب مربوط بفرع
const Branch = { list: [], current: null, locked: false };
const branchName = (id) => Branch.list.find((b) => b.id === String(id))?.name || '';
const branchOptions = (selected, emptyLabel = '— بدون فرع —') => `<option value="">${esc(emptyLabel)}</option>` +
  Branch.list.map((b) => `<option value="${b.id}"${b.id === String(selected ?? '') ? ' selected' : ''}>${esc(b.name)}</option>`).join('');

const state = {
  view: 'dashboard',
  page: 1,
  pageSize: 25,
  status: 'all',
  items: [],
  stats: null,
  me: null,
};

const VIEWS = {
  dashboard: { title: 'لوحة المتابعة', subtitle: 'نظرة عامة على حالة إقامات الموظفين' },
  residencies: { title: 'الإقامات', subtitle: 'إدارة بيانات الإقامات وتواريخ انتهائها' },
  settings: { title: 'الإعدادات', subtitle: 'التنبيهات والمظهر والاستيراد' },
  users: { title: 'المستخدمين', subtitle: 'حسابات الدخول والأدوار والصلاحيات' },
  audit: { title: 'سجل العمليات', subtitle: 'كل الإضافات والتعديلات والحذف ومين عملها' },
};

// ---------- الصلاحيات ----------

// القسم الذي تتبعه كل صفحة (الأقسام العامة تتبع نفسها)
const VIEW_SECTION = { residencies: 'residencies', users: 'users', audit: 'audit', dashboard: null, settings: null };
const sectionOfView = (view) => (view in VIEW_SECTION ? VIEW_SECTION[view] : view);

function can(section, mode = 'read') {
  if (!section) return true;
  const level = state.me?.permissions?.[section];
  return mode === 'read' ? Boolean(level) : level === 'write';
}

function applyNavPermissions() {
  for (const link of $$('.nav a')) link.hidden = !can(sectionOfView(link.dataset.view));
  // إخفاء عناوين المجموعات الفارغة
  for (const label of $$('.nav .nav-label')) {
    let el = label.nextElementSibling;
    let visible = false;
    while (el && !el.classList.contains('nav-label')) {
      if (el.tagName === 'A' && !el.hidden) visible = true;
      el = el.nextElementSibling;
    }
    label.hidden = !visible;
  }
}

const STATUS = {
  expired: { label: 'منتهية', icon: 'x-circle' },
  expiring: { label: 'قريبة من الانتهاء', icon: 'clock' },
  valid: { label: 'سارية', icon: 'check' },
};

// ---------- أدوات عامة ----------

const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(n);
const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="icons.svg#i-${name}"/></svg>`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function dateOf(iso) {
  return new Date(iso + 'T12:00:00');
}

function fmtGregorian(iso, month = 'long') {
  return dateOf(iso).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month, year: 'numeric' });
}

function fmtHijri(iso) {
  try {
    return dateOf(iso).toLocaleDateString('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return Hijri.gregorianToHijri(iso) + ' هـ';
  }
}

function remainingText(days) {
  if (days < 0) return `منتهية منذ ${fmt(-days)} يوم`;
  if (days === 0) return 'تنتهي اليوم';
  if (days === 1) return 'تنتهي غدًا';
  return `${fmt(days)} يوم`;
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
}

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (!Branch.locked && Branch.current) headers['X-Branch'] = Branch.current;
  const res = await fetch(url, { ...options, headers });
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
  el.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'info' ? 'bell' : 'check')}<span>${esc(message)}</span>`;
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, 3800);
}

// عدّاد متحرك للأرقام
function countUp(el, to) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = to;
  if (reduceMotion || from === to) {
    el.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const duration = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- النوافذ المنبثقة ----------

function openModal(dialog) {
  dialog.classList.remove('closing');
  dialog.showModal();
}

function closeModal(dialog) {
  if (!dialog.open) return;
  if (reduceMotion) return dialog.close();
  dialog.classList.add('closing');
  dialog.addEventListener('animationend', () => {
    dialog.classList.remove('closing');
    dialog.close();
  }, { once: true });
}

for (const dialog of $$('dialog')) {
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeModal(dialog);
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) closeModal(dialog);
  });
}

function confirmDialog(text) {
  $('confirmText').textContent = text;
  openModal($('confirmModal'));
  return new Promise((resolve) => {
    const dialog = $('confirmModal');
    const onYes = () => { cleanup(); closeModal(dialog); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    function cleanup() {
      $('confirmDelete').removeEventListener('click', onYes);
      dialog.removeEventListener('close', onClose);
    }
    $('confirmDelete').addEventListener('click', onYes);
    dialog.addEventListener('close', onClose);
  });
}

// ---------- التنقل ----------

function showView(view) {
  let isModule = typeof Modules !== 'undefined' && Modules.has(view);
  if ((!VIEWS[view] && !isModule) || !can(sectionOfView(view))) {
    view = 'dashboard';
    isModule = false;
  }
  state.view = view;
  const sectionId = isModule ? 'view-module' : `view-${view}`;
  for (const section of $$('.view')) section.classList.toggle('active', section.id === sectionId);
  for (const link of $$('.nav a')) link.classList.toggle('active', link.dataset.view === view);
  const meta = isModule ? Modules.meta(view) : VIEWS[view];
  $('viewTitle').textContent = meta.title;
  $('viewSubtitle').textContent = meta.subtitle;
  document.title = `${meta.title} — منصة الإقامات`;
  $('addBtn').querySelector('.add-label').textContent = isModule ? `إضافة ${meta.singular}`
    : view === 'users' ? 'إضافة مستخدم' : 'إضافة إقامة';
  const addSection = isModule ? view : view === 'users' ? 'users' : view === 'audit' ? '__none' : 'residencies';
  $('addBtn').hidden = !can(addSection, 'write');
  document.body.classList.remove('nav-open');
  window.scrollTo({ top: 0 });

  if (view === 'dashboard') loadDashboard();
  if (view === 'residencies') loadList();
  if (view === 'settings') loadSettings();
  if (view === 'users') Admin.showUsers();
  if (view === 'audit') Admin.showAudit();
  if (isModule) Modules.show(view);
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

function goToStatus(status) {
  state.status = status;
  state.page = 1;
  syncStatusButtons();
  if (location.hash === '#residencies') loadList();
  else location.hash = 'residencies';
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-go-status]');
  if (target) {
    e.preventDefault();
    goToStatus(target.dataset.goStatus);
  }
});

$('menuBtn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
window.addEventListener('scroll', () => $('topbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });

// ---------- الإحصائيات ----------

async function loadStats() {
  const s = await api('/api/stats');
  state.stats = s;
  for (const el of $$('[data-kpi]')) countUp(el, s[el.dataset.kpi]);
  for (const el of $$('[data-count]')) el.textContent = fmt(s[el.dataset.count]);
  $('navBadge').textContent = s.expiring ? fmt(s.expiring) : '';
  $('expiringMeta').textContent = s.withinWeek
    ? `منها ${fmt(s.withinWeek)} خلال 7 أيام`
    : `خلال ${s.alertDays} يومًا القادمة`;
  $('validMeta').textContent = s.total ? `${Math.round((s.valid / s.total) * 100)}% من الإجمالي` : '—';

  const banner = $('banner');
  banner.hidden = !(s.expiring || s.expired);
  $('bannerTitle').textContent = s.expiring
    ? `${fmt(s.expiring)} إقامة ستنتهي خلال ${s.alertDays} يومًا`
    : `${fmt(s.expired)} إقامة منتهية`;
  $('bannerText').textContent = [
    s.withinWeek ? `${fmt(s.withinWeek)} منها خلال الأسبوع القادم` : '',
    s.expired ? `${fmt(s.expired)} إقامة منتهية تحتاج تجديدًا` : '',
  ].filter(Boolean).join(' · ') || 'راجع القائمة لاتخاذ الإجراء اللازم';

  notifyBrowser(s);
  return s;
}

function notifyBrowser(s) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !s.expiring) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem('notifiedOn') === today) return;
    localStorage.setItem('notifiedOn', today);
  } catch { /* تجاهل */ }
  new Notification('تنبيه انتهاء الإقامات', {
    body: `${s.expiring} إقامة ستنتهي خلال ${s.alertDays} يومًا، و ${s.expired} منتهية`,
    tag: 'iqama-alert',
  });
}

// ---------- لوحة المتابعة ----------

async function loadDashboard() {
  await Promise.all([loadStats(), loadChart(), loadUpcoming(), Modules.loadOverview()]);
}

async function loadUpcoming() {
  const { items } = await api('/api/residencies?status=expiring&pageSize=6');
  $('upcoming').innerHTML = items.length ? items.map((r, i) => `
    <li style="animation-delay:${0.25 + i * 0.05}s">
      <span class="initials">${esc(initials(r.name))}</span>
      <div class="who"><strong>${esc(r.name)}</strong><small class="mono">${esc(r.iqamaNumber)}</small></div>
      ${r.daysLeft === 0
        ? `<span class="days-chip ${r.status} today"><b>اليوم</b></span>`
        : `<span class="days-chip ${r.status}"><b>${r.daysLeft}</b><small>يوم</small></span>`}
    </li>`).join('') : `
    <li class="empty" style="padding:28px 0">
      <div style="width:100%"><span class="empty-icon">${icon('check')}</span><strong>لا توجد إقامات قريبة من الانتهاء</strong></div>
    </li>`;
}

let chartData = [];
let chartAnimated = false;

async function loadChart() {
  chartData = await api('/api/stats/monthly');
  chartAnimated = false;
  renderChart();
  $('chartTable').querySelector('tbody').innerHTML = chartData
    .map((d) => `<tr><th>${monthLabel(d.month, 'long')}</th><td>${d.count}</td></tr>`).join('');
}

function monthLabel(month, style = 'short') {
  const d = new Date(month + '-15T12:00:00');
  return style === 'long'
    ? d.toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { month: 'long', year: 'numeric' })
    : d.toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { month: 'short' });
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
}

function renderChart() {
  const el = $('chart');
  const W = el.clientWidth;
  const H = el.clientHeight;
  if (!W || !chartData.length) return;

  const m = { top: 24, right: 48, bottom: 30, left: 4 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const n = chartData.length;
  const band = iw / n;
  const bw = Math.min(24, band * 0.6);
  const maxVal = Math.max(...chartData.map((d) => d.count), 1);
  const step = niceStep(maxVal / 4);
  const max = step * 4;
  const y = (v) => m.top + ih - (v / max) * ih;
  // الزمن يسير من اليمين لليسار (اتجاه القراءة العربية)
  const xCenter = (i) => m.left + iw - (i + 0.5) * band;
  const showEvery = band < 46 ? 2 : 1;
  const peak = chartData.reduce((best, d, i) => (d.count > chartData[best].count ? i : best), 0);

  let grid = '';
  for (let v = 0; v <= max; v += step) {
    grid += `<line x1="${m.left}" x2="${m.left + iw}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text x="${W - m.right + 10}" y="${y(v) + 4}" text-anchor="start">${fmt(v)}</text>`;
  }

  const cols = chartData.map((d, i) => {
    const cx = xCenter(i);
    const x = cx - bw / 2;
    const top = y(d.count);
    const h = m.top + ih - top;
    const r = Math.min(4, h, bw / 2);
    const path = h > 0
      ? `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${top + h}Z`
      : '';
    const anim = chartAnimated || reduceMotion ? '' : `class="grow" style="animation-delay:${i * 45}ms"`;
    const label = i === peak && d.count > 0
      ? `<text class="value-label" x="${cx}" y="${top - 8}" text-anchor="middle">${fmt(d.count)}</text>` : '';
    const month = i % showEvery === 0
      ? `<text x="${cx}" y="${H - 8}" text-anchor="middle">${monthLabel(d.month)}</text>` : '';
    return `<g class="col" data-i="${i}">
      <rect class="hit" x="${cx - band / 2}" y="${m.top}" width="${band}" height="${ih}"/>
      <g ${anim}><path class="bar-rect" d="${path}"/></g>${label}
      <g class="axis">${month}</g>
    </g>`;
  }).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" direction="ltr" role="img" aria-label="الإقامات المنتهية حسب الشهر">
    <g class="grid axis">${grid}</g>
    <g class="bars">${cols}</g>
  </svg>`;
  el.querySelector('svg')?.remove();
  el.insertAdjacentHTML('afterbegin', svg);
  chartAnimated = true;

  const bars = el.querySelector('.bars');
  const tip = $('tooltip');
  for (const col of $$('.col', el)) {
    col.addEventListener('mouseenter', () => {
      const i = Number(col.dataset.i);
      const d = chartData[i];
      bars.classList.add('hovering');
      col.classList.add('hover');
      tip.innerHTML = `<strong>${fmt(d.count)} إقامة</strong>${monthLabel(d.month, 'long')}`;
      tip.style.left = `${xCenter(i)}px`;
      tip.style.top = `${Math.max(y(d.count), m.top)}px`;
      tip.classList.add('show');
    });
    col.addEventListener('mouseleave', () => {
      bars.classList.remove('hovering');
      col.classList.remove('hover');
      tip.classList.remove('show');
    });
  }
}

new ResizeObserver(() => { if (state.view === 'dashboard') renderChart(); }).observe($('chart'));

// ---------- قائمة الإقامات ----------

function listParams() {
  const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize, sort: $('sort').value });
  if (state.status !== 'all') params.set('status', state.status);
  const q = $('search').value.trim();
  if (q) params.set('q', q);
  return params;
}

function skeleton() {
  const widths = [140, 90, 110, 100, 90, 70, 50];
  $('rows').innerHTML = Array.from({ length: 6 }, () =>
    `<tr class="skeleton">${widths.map((w) => `<td><span style="width:${w}px"></span></td>`).join('')}</tr>`).join('');
}

function progress(r) {
  if (r.status === 'expired') return 100;
  return Math.max(4, Math.min(100, (r.daysLeft / 365) * 100));
}

let listRequest = 0;
async function loadList() {
  const id = ++listRequest;
  if (!state.items.length) skeleton();
  const [data] = await Promise.all([api(`/api/residencies?${listParams()}`), loadStats()]);
  if (id !== listRequest) return; // تجاهل الردود القديمة
  state.items = data.items;
  state.total = data.total;

  $('rows').innerHTML = data.items.map((r, i) => `
    <tr style="animation-delay:${Math.min(i, 12) * 25}ms">
      <td><div class="person"><span class="initials">${esc(initials(r.name))}</span>
        <div><strong>${esc(r.name)}</strong><small>${esc(r.nationality || '—')}</small></div></div></td>
      <td><span class="mono">${esc(r.iqamaNumber)}</span></td>
      <td>${esc(r.employer || '—')}${r.branchName && !Branch.current ? `<span class="sub">${esc(r.branchName)}</span>` : ''}</td>
      <td>${esc(fmtHijri(r.expiryDate))}<span class="sub">${esc(fmtGregorian(r.expiryDate, 'short'))}</span></td>
      <td><div class="remain ${r.status}"><span>${remainingText(r.daysLeft)}</span>
        <span class="track"><span class="fill" style="width:${progress(r)}%"></span></span></div></td>
      <td><span class="pill ${r.status}">${icon(STATUS[r.status].icon, 'icon-sm')}${STATUS[r.status].label}</span></td>
      <td><div class="row-actions">
        <button class="icon-btn" data-profile="${r.id}" title="ملف الموظف والمستندات" aria-label="ملف ${esc(r.name)}">${icon('folder')}</button>
        ${can('residencies', 'write') ? `<button class="icon-btn" data-edit="${r.id}" title="تعديل" aria-label="تعديل ${esc(r.name)}">${icon('edit')}</button>
        <button class="icon-btn danger" data-delete="${r.id}" title="حذف" aria-label="حذف ${esc(r.name)}">${icon('trash')}</button>` : ''}
      </div></td>
    </tr>`).join('');
  $('empty').hidden = data.items.length > 0;

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = Math.min(data.total, data.page * data.pageSize);
  $('listSub').textContent = STATUS[state.status] ? `${fmt(data.total)} إقامة ${STATUS[state.status].label}` : `${fmt(data.total)} إقامة مسجلة`;
  $('pageInfo').textContent = `عرض ${fmt(from)}–${fmt(to)} من ${fmt(data.total)} · صفحة ${fmt(data.page)} من ${fmt(pages)}`;
  $('prev').disabled = data.page <= 1;
  $('next').disabled = data.page >= pages;
}

function syncStatusButtons() {
  for (const b of $$('#statusFilter button')) b.setAttribute('aria-pressed', String(b.dataset.status === state.status));
}

$('statusFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.status = b.dataset.status;
  state.page = 1;
  syncStatusButtons();
  loadList();
});

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.page = 1; loadList(); }, 300);
});
$('sort').addEventListener('change', () => { state.page = 1; loadList(); });
$('prev').addEventListener('click', () => { state.page -= 1; loadList(); });
$('next').addEventListener('click', () => { state.page += 1; loadList(); });

$('rows').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-delete]');
  const profile = e.target.closest('[data-profile]');
  if (profile) Modules.openEmployee(state.items.find((r) => r.id === profile.dataset.profile));
  if (edit) openForm(state.items.find((r) => r.id === edit.dataset.edit));
  if (del) {
    const r = state.items.find((x) => x.id === del.dataset.delete);
    if (!(await confirmDialog(`سيتم حذف إقامة "${r.name}" (${r.iqamaNumber}) نهائيًا ولا يمكن التراجع.`))) return;
    try {
      await api(`/api/residencies/${r.id}`, { method: 'DELETE' });
      toast('تم حذف الإقامة');
      await loadList();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

// ---------- استيراد وتصدير ----------

// يرفع ملف Excel/CSV ويعرض النتيجة (يُستخدم في الإقامات وكل الأقسام)
async function importSheet(url, file, out) {
  out.hidden = false;
  out.innerHTML = `<div class="inline-row"><span class="spinner"></span>جاري استيراد ${esc(file.name)}...</div>`;
  try {
    const res = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const total = res.inserted + (res.updated || 0);
    out.innerHTML = `<button class="icon-btn close-result" type="button" aria-label="إغلاق">${icon('x', 'icon-sm')}</button>
      <strong>تم الاستيراد:</strong> إضافة ${fmt(res.inserted)}${res.updated != null ? ` · تحديث ${fmt(res.updated)}` : ''}` +
      (res.failed ? ` · <span style="color:var(--danger)">${fmt(res.failed)} سطر به أخطاء لم يُستورد</span>
        <div class="errors">${res.errors.map((x) => `سطر ${x.line}: ${esc(x.error)}`).join('<br>')}</div>` : '');
    out.querySelector('.close-result').onclick = () => { out.hidden = true; };
    toast(`تم استيراد ${fmt(total)} سجل`, res.failed && !total ? 'error' : 'success');
    return res;
  } catch (err) {
    out.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
    toast(err.message, 'error');
    return null;
  }
}

$('exportBtn').addEventListener('click', () => {
  const params = listParams();
  params.delete('page');
  params.delete('pageSize');
  if (Branch.current) params.set('branch', Branch.current);
  location.href = `/api/residencies/export.xlsx?${params}`;
  toast('جاري تجهيز ملف Excel...', 'info');
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (await importSheet('/api/residencies/import', file, $('importResult'))) {
    state.page = 1;
    await loadList();
  }
});

// ---------- نموذج الإضافة والتعديل ----------

const form = $('form');
let calendar = 'hijri';

function updateDateHint() {
  const hint = $('dateHint');
  const hijri = form.elements.expiryDateHijri.value.trim();
  const greg = form.elements.expiryDate.value;
  hint.className = 'hint';
  if (calendar === 'hijri' && hijri) {
    const g = Hijri.hijriToGregorian(hijri);
    hint.textContent = g ? `يوافق ${fmtGregorian(g)} م` : 'تاريخ هجري غير صحيح — الصيغة: سنة-شهر-يوم';
    hint.classList.add(g ? 'ok' : 'bad');
  } else if (calendar === 'gregorian' && greg) {
    hint.textContent = `يوافق ${fmtHijri(greg)}`;
    hint.classList.add('ok');
  } else {
    hint.textContent = calendar === 'hijri' ? 'أدخل التاريخ كما هو في الإقامة، مثل 1448-04-22' : '';
  }
}

function setCalendar(value) {
  const hijri = form.elements.expiryDateHijri;
  const greg = form.elements.expiryDate;
  if (value === 'gregorian' && hijri.value) greg.value = Hijri.hijriToGregorian(hijri.value) || '';
  if (value === 'hijri' && greg.value) hijri.value = Hijri.gregorianToHijri(greg.value) || '';
  calendar = value;
  for (const b of $$('[data-calendar]', form)) b.setAttribute('aria-pressed', String(b.dataset.calendar === value));
  hijri.hidden = value !== 'hijri';
  greg.hidden = value === 'hijri';
  updateDateHint();
}

for (const b of $$('[data-calendar]', form)) b.addEventListener('click', () => setCalendar(b.dataset.calendar));
form.elements.expiryDateHijri.addEventListener('input', updateDateHint);
form.elements.expiryDate.addEventListener('input', updateDateHint);

function showFormError(message) {
  const box = $('formError');
  box.querySelector('span').textContent = message;
  box.hidden = false;
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';
}

function openForm(record) {
  form.reset();
  $('formError').hidden = true;
  form.elements.id.value = record?.id || '';
  for (const key of ['name', 'iqamaNumber', 'expiryDate', 'expiryDateHijri', 'nationality', 'phone', 'employer', 'notes']) {
    form.elements[key].value = record?.[key] || '';
  }
  form.elements.annualLeaveDays.value = record?.annualLeaveDays ?? 21;
  $('resBranchField').hidden = Branch.locked || !Branch.list.length;
  $('resBranch').innerHTML = branchOptions(record ? record.branchId : Branch.current);
  $('modalTitle').textContent = record ? 'تعديل بيانات الإقامة' : 'إضافة إقامة جديدة';
  $('submitBtn').textContent = record ? 'حفظ التعديلات' : 'إضافة الإقامة';
  setCalendar(calendar);
  openModal($('editModal'));
  setTimeout(() => form.elements.name.focus(), 50);
}

$('addBtn').addEventListener('click', () => {
  if (Modules.has(state.view)) return Modules.openForm(state.view);
  if (state.view === 'users') return Admin.openUser(null);
  return openForm(null);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const { id } = data;
  if (!data.name.trim()) return showFormError('الاسم مطلوب');
  if (!/^2\d{9}$/.test(data.iqamaNumber.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim())) {
    return showFormError('رقم الإقامة يجب أن يكون 10 أرقام ويبدأ بـ 2');
  }
  if (calendar === 'hijri') {
    data.expiryDate = Hijri.hijriToGregorian(data.expiryDateHijri) || '';
    if (!data.expiryDate) return showFormError('تاريخ الانتهاء الهجري غير صحيح (مثال: 1448-04-22)');
  } else if (!data.expiryDate) {
    return showFormError('تاريخ الانتهاء مطلوب');
  }
  delete data.id;
  delete data.expiryDateHijri;

  const btn = $('submitBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await api(id ? `/api/residencies/${id}` : '/api/residencies', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(data),
    });
    closeModal($('editModal'));
    toast(id ? 'تم حفظ التعديلات' : 'تمت إضافة الإقامة بنجاح');
    if (state.view === 'residencies') await loadList();
    else await loadDashboard();
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

// ---------- الإعدادات ----------

async function loadSettings() {
  const s = state.stats || await loadStats();
  $('alertDays').value = s.alertDays;
  const me = state.me;
  $('emailStatus').innerHTML = me.emailEnabled
    ? `<span class="pill valid">${icon('check', 'icon-sm')}مفعّلة</span> تُرسل إلى: <span class="mono">${me.alertEmails.map(esc).join('، ')}</span>`
    : `<span class="pill neutral">غير مفعّلة</span> اضبط إعدادات <span class="mono">SMTP</span> و <span class="mono">ALERT_EMAILS</span> في ملف <span class="mono">.env</span> على الخادم`;
  $('sendEmail').disabled = !me.emailEnabled;
  const canSettings = can('settings', 'write');
  for (const el of [$('saveSettings'), $('sendEmail'), $('alertDays'), ...$$('[data-step], [data-days]')]) el.disabled = !canSettings || (el.id === 'sendEmail' && !me.emailEnabled);
  renderNotifyStatus();
  renderThemeOptions();
}

function renderNotifyStatus() {
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const map = {
    granted: `<span class="pill valid">${icon('check', 'icon-sm')}مفعّلة</span>`,
    denied: '<span class="pill expired">محظورة من إعدادات المتصفح</span>',
    default: '<span class="pill neutral">غير مفعّلة</span>',
    unsupported: '<span class="pill neutral">المتصفح لا يدعم الإشعارات</span>',
  };
  $('notifyStatus').innerHTML = map[perm];
  $('enableNotify').hidden = perm !== 'default';
}

$('enableNotify').addEventListener('click', async () => {
  if ((await Notification.requestPermission()) === 'granted') {
    try { localStorage.removeItem('notifiedOn'); } catch { /* تجاهل */ }
    toast('تم تفعيل إشعارات المتصفح');
    notifyBrowser(state.stats);
  }
  renderNotifyStatus();
});

for (const b of $$('[data-step]')) {
  b.addEventListener('click', () => {
    const input = $('alertDays');
    input.value = Math.min(365, Math.max(1, Number(input.value || 0) + Number(b.dataset.step)));
  });
}
for (const b of $$('[data-days]')) b.addEventListener('click', () => { $('alertDays').value = b.dataset.days; });

$('saveSettings').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ alertDays: Number($('alertDays').value) }) });
    await loadStats();
    toast('تم حفظ مدة التنبيه');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('sendEmail').addEventListener('click', async () => {
  const btn = $('sendEmail');
  btn.disabled = true;
  try {
    const res = await api('/api/alerts/send-email', { method: 'POST' });
    toast(res.sent ? `تم إرسال التنبيه (${fmt(res.total)} إقامة)` : 'لا توجد إقامات تحتاج تنبيهًا الآن', res.sent ? 'success' : 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('templateBtn').addEventListener('click', () => {
  const csv = '﻿الاسم,رقم الإقامة,تاريخ الانتهاء هجري,تاريخ الانتهاء,الجنسية,الجوال,جهة العمل,ملاحظات\r\n' +
    'محمد أحمد,2123456789,1448-06-15,,مصر,0501234567,شركة المثال,\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'iqama-template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- المظهر ----------

function renderThemeOptions() {
  for (const b of $$('[data-theme-option]')) b.setAttribute('aria-pressed', String(b.dataset.themeOption === Theme.get()));
  $('themeIcon').setAttribute('href', `icons.svg#i-${Theme.isDark() ? 'sun' : 'moon'}`);
}
for (const b of $$('[data-theme-option]')) b.addEventListener('click', () => Theme.set(b.dataset.themeOption));
$('themeBtn').addEventListener('click', () => Theme.toggle());
document.addEventListener('themechange', renderThemeOptions);

// ---------- الخروج والبدء ----------

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

// ---------- اختيار الفرع ----------

async function loadBranches() {
  Branch.locked = Boolean(state.me.branch);
  Branch.list = await api('/api/branches').catch(() => []);
  if (Branch.locked) {
    Branch.current = state.me.branch.id;
    $('branchChip').querySelector('span').textContent = state.me.branch.name;
  } else {
    let saved = null;
    try { saved = localStorage.getItem('branch'); } catch { /* التخزين غير متاح */ }
    Branch.current = Branch.list.some((b) => b.id === saved) ? saved : null;
    $('branchSelect').innerHTML = branchOptions(Branch.current, 'كل الفروع');
  }
  $('branchChip').hidden = !Branch.locked;
  $('branchPicker').hidden = Branch.locked || !Branch.list.length;
  $('branchPicker').classList.toggle('active', Boolean(Branch.current));
}

$('branchSelect').addEventListener('change', (e) => {
  Branch.current = e.target.value || null;
  try { localStorage.setItem('branch', Branch.current || ''); } catch { /* التخزين غير متاح */ }
  $('branchPicker').classList.toggle('active', Boolean(Branch.current));
  state.page = 1;
  state.items = [];
  Modules.reset();
  toast(Branch.current ? `عرض بيانات ${branchName(Branch.current)}` : 'عرض بيانات كل الفروع', 'info');
  Modules.loadOverview().catch(() => {});
  showView(state.view);
});

(async () => {
  const me = await api('/api/me').catch(() => null);
  if (!me) return; // تم التحويل لصفحة الدخول
  state.me = me;
  await Modules.init();
  $('username').textContent = me.fullName || me.username;
  $('roleLabel').textContent = me.roleLabel;
  $('avatar').textContent = (me.fullName || me.username).slice(0, 1).toUpperCase();
  $('importBtn').hidden = !can('residencies', 'write');
  $('templateBtn').hidden = !can('residencies', 'write');
  await loadBranches();
  applyNavPermissions();
  renderThemeOptions();
  showView(location.hash.slice(1) || 'dashboard');
  setInterval(loadStats, 60 * 60 * 1000);
})();
