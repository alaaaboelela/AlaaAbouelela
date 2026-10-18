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
  calendar: { title: 'التقويم', subtitle: 'كل الانتهاءات والمواعيد في شهر واحد: الإقامات، المستندات، العقود، السيارات، العودة والإجازات' },
  reports: { title: 'التقارير', subtitle: 'تقارير جاهزة للطباعة أو الحفظ كملف PDF' },
  residencies: { title: 'الإقامات', subtitle: 'إدارة بيانات الإقامات وتواريخ انتهائها' },
  settings: { title: 'الإعدادات', subtitle: 'التنبيهات والمظهر والاستيراد' },
  users: { title: 'المستخدمين', subtitle: 'حسابات الدخول والأدوار والصلاحيات' },
  audit: { title: 'سجل العمليات', subtitle: 'كل الإضافات والتعديلات والحذف ومين عملها' },
};

// ---------- الصلاحيات ----------

// القسم الذي تتبعه كل صفحة (الأقسام العامة تتبع نفسها)
const VIEW_SECTION = { residencies: 'residencies', users: 'users', audit: 'audit', dashboard: null, settings: null, calendar: null, reports: null };
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

// صورة الموظف أو الحروف الأولى من اسمه
function avatar(r, cls = '') {
  return r.photo
    ? `<img class="initials photo ${cls}" src="${esc(r.photo)}" alt="" loading="lazy" decoding="async">`
    : `<span class="initials ${cls}">${esc(initials(r.name))}</span>`;
}

// تصغير الصورة وقصّها مربعة قبل الرفع (أخف على الخادم وأسرع على الموبايل)
async function squareJpeg(file, size = 360) {
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) throw new Error('تعذر قراءة الصورة، جربي صورة JPG أو PNG');
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
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

function confirmDialog(text, { title = 'تأكيد الحذف', ok = 'حذف نهائي', iconName = 'trash', danger = true } = {}) {
  $('confirmText').textContent = text;
  $('confirmTitle').textContent = title;
  $('confirmDelete').textContent = ok;
  $('confirmDelete').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  $('confirmIcon').innerHTML = icon(iconName);
  $('confirmIcon').classList.toggle('neutral', !danger);
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
  const addSection = isModule ? view : view === 'users' ? 'users' : ['audit', 'calendar', 'reports'].includes(view) ? '__none' : 'residencies';
  $('addBtn').hidden = !can(addSection, 'write');
  document.body.classList.remove('nav-open');
  window.scrollTo({ top: 0 });

  if (view === 'dashboard') loadDashboard();
  if (view === 'residencies') loadList();
  if (view === 'settings') loadSettings();
  if (view === 'users') Admin.showUsers();
  if (view === 'audit') Admin.showAudit();
  if (view === 'calendar') Calendar.show();
  if (view === 'reports') Reports.show();
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
      ${avatar(r)}
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
let chartOverdue = { count: 0, cost: 0 };
let chartAnimated = false;
let chartMetric = 'count';
try { if (localStorage.getItem('chartMetric') === 'cost') chartMetric = 'cost'; } catch { /* تجاهل */ }

const money = (n) => `${fmt(Math.round(n))} ر.س`;
const compact = new Intl.NumberFormat('ar-SA-u-nu-latn', { notation: 'compact', maximumFractionDigits: 1 });

let costCache = null;
function costDefaults() {
  costCache ||= api('/api/costs').catch((err) => { costCache = null; throw err; });
  return costCache;
}

async function loadChart() {
  const data = await api('/api/stats/monthly');
  chartData = data.months;
  chartOverdue = data.overdue;
  chartAnimated = false;
  renderChartHead();
  renderChart();
}

function renderChartHead() {
  const cost = chartMetric === 'cost';
  for (const b of $$('#chartMetric button')) b.setAttribute('aria-pressed', String(b.dataset.metric === chartMetric));
  const total = chartData.reduce((s, d) => s + d.cost, 0);
  $('chartTitle').textContent = cost ? 'تكلفة تجديد الإقامات المتوقعة' : 'الإقامات المنتهية خلال الـ 12 شهرًا القادمة';
  $('chartSub').innerHTML = cost
    ? `${money(total)} خلال 12 شهرًا${chartOverdue.cost ? ` · و<span class="text-expired">${money(chartOverdue.cost)}</span> لإقامات منتهية` : ''} · <a href="/report.html?key=renewals${Branch.current && !Branch.locked ? `&branch=${encodeURIComponent(Branch.current)}` : ''}" target="_blank" rel="noopener">التقرير</a>`
    : 'عدد الإقامات التي ينتهي تاريخها في كل شهر';
  $('chartTable').querySelector('tbody').innerHTML = chartData
    .map((d) => `<tr><th>${monthLabel(d.month, 'long')}</th><td>${cost ? money(d.cost) : d.count}</td></tr>`).join('');
}

for (const b of $$('#chartMetric button')) {
  b.addEventListener('click', () => {
    chartMetric = b.dataset.metric;
    try { localStorage.setItem('chartMetric', chartMetric); } catch { /* تجاهل */ }
    chartAnimated = false;
    renderChartHead();
    renderChart();
  });
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
  const val = (d) => d[chartMetric];
  const tick = chartMetric === 'cost' ? (v) => compact.format(v) : fmt;
  const maxVal = Math.max(...chartData.map(val), 1);
  const step = niceStep(maxVal / 4);
  const max = step * 4;
  const y = (v) => m.top + ih - (v / max) * ih;
  // الزمن يسير من اليمين لليسار (اتجاه القراءة العربية)
  const xCenter = (i) => m.left + iw - (i + 0.5) * band;
  const showEvery = band < 46 ? 2 : 1;
  const peak = chartData.reduce((best, d, i) => (val(d) > val(chartData[best]) ? i : best), 0);

  let grid = '';
  for (let v = 0; v <= max; v += step) {
    grid += `<line x1="${m.left}" x2="${m.left + iw}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text x="${W - m.right + 10}" y="${y(v) + 4}" text-anchor="start">${tick(v)}</text>`;
  }

  const cols = chartData.map((d, i) => {
    const cx = xCenter(i);
    const x = cx - bw / 2;
    const top = y(val(d));
    const h = m.top + ih - top;
    const r = Math.min(4, h, bw / 2);
    const path = h > 0
      ? `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${top + h}Z`
      : '';
    const anim = chartAnimated || reduceMotion ? '' : `class="grow" style="animation-delay:${i * 45}ms"`;
    const label = i === peak && val(d) > 0
      ? `<text class="value-label" x="${cx}" y="${top - 8}" text-anchor="middle">${tick(val(d))}</text>` : '';
    const month = i % showEvery === 0
      ? `<text x="${cx}" y="${H - 8}" text-anchor="middle">${monthLabel(d.month)}</text>` : '';
    return `<g class="col" data-i="${i}">
      <rect class="hit" x="${cx - band / 2}" y="${m.top}" width="${band}" height="${ih}"/>
      <g ${anim}><path class="bar-rect" d="${path}"/></g>${label}
      <g class="axis">${month}</g>
    </g>`;
  }).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" direction="ltr" role="img" aria-label="${chartMetric === 'cost' ? 'تكلفة التجديد حسب الشهر' : 'الإقامات المنتهية حسب الشهر'}">
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
      tip.innerHTML = chartMetric === 'cost'
        ? `<strong>${money(d.cost)}</strong>${fmt(d.count)} إقامة · ${monthLabel(d.month, 'long')}`
        : `<strong>${fmt(d.count)} إقامة</strong>${monthLabel(d.month, 'long')}`;
      tip.style.left = `${xCenter(i)}px`;
      tip.style.top = `${Math.max(y(val(d)), m.top)}px`;
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
  if ($('employment').value !== 'active') params.set('employment', $('employment').value);
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
    <tr style="animation-delay:${Math.min(i, 12) * 25}ms"${r.employment === 'left' ? ' class="left-row"' : ''}>
      <td><div class="person">${avatar(r)}
        <div><strong>${esc(r.name)}</strong><small>${esc(r.nationality || '—')}</small></div></div></td>
      <td><span class="mono">${esc(r.iqamaNumber)}</span></td>
      <td>${esc(r.employer || '—')}${r.branchName && !Branch.current ? `<span class="sub">${esc(r.branchName)}</span>` : ''}</td>
      <td>${esc(fmtHijri(r.expiryDate))}<span class="sub">${esc(fmtGregorian(r.expiryDate, 'short'))}</span></td>
      ${r.employment === 'left'
    ? `<td><span class="muted">منذ ${esc(fmtGregorian(r.leftDate, 'short'))}</span><span class="sub">${esc(r.leftReason)}</span></td>
      <td><span class="pill neutral">ترك العمل</span></td>`
    : `<td><div class="remain ${r.status}"><span>${remainingText(r.daysLeft)}</span>
        <span class="track"><span class="fill" style="width:${progress(r)}%"></span></span></div></td>
      <td><span class="pill ${r.status}">${icon(STATUS[r.status].icon, 'icon-sm')}${STATUS[r.status].label}</span></td>`}
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
  const employment = $('employment').value;
  const archived = state.stats?.archived || 0;
  $('listSub').textContent = employment === 'left' ? `${fmt(data.total)} موظف في الأرشيف (ترك العمل)`
    : (STATUS[state.status] ? `${fmt(data.total)} إقامة ${STATUS[state.status].label}` : `${fmt(data.total)} إقامة مسجلة`)
      + (employment === 'active' && archived ? ` · ${fmt(archived)} في الأرشيف` : '');
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
$('employment').addEventListener('change', () => { state.page = 1; state.items = []; loadList(); });
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
    if (!(await confirmDialog(`سيتم حذف إقامة "${r.name}" (${r.iqamaNumber}) نهائيًا ولا يمكن التراجع.`, { title: 'حذف الإقامة؟' }))) return;
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
  form.elements.renewalCost.value = record?.renewalCost ?? '';
  $('resCost').placeholder = 'الافتراضي';
  costDefaults().then((c) => { $('resCost').placeholder = `الافتراضي: ${fmt(c.total)}`; }).catch(() => {});
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
  if (!/^[12]\d{9}$/.test(data.iqamaNumber.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim())) {
    return showFormError('رقم الإقامة 10 أرقام ويبدأ بـ 2 (أو رقم الهوية للسعودي ويبدأ بـ 1)');
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
  api('/api/settings').then((x) => { $('companyName').value = x.companyName; }).catch(() => {});
  const me = state.me;
  $('emailStatus').innerHTML = me.emailEnabled
    ? `<span class="pill valid">${icon('check', 'icon-sm')}مفعّلة</span> تُرسل إلى: <span class="mono">${me.alertEmails.map(esc).join('، ')}</span>`
    : `<span class="pill neutral">غير مفعّلة</span> اضبط إعدادات <span class="mono">SMTP</span> و <span class="mono">ALERT_EMAILS</span> في ملف <span class="mono">.env</span> على الخادم`;
  $('sendEmail').disabled = !me.emailEnabled;
  const canSettings = can('settings', 'write');
  for (const el of [$('saveSettings'), $('sendEmail'), $('alertDays'), $('companyName'), $('saveCompany'), ...$$('[data-step], [data-days]')]) el.disabled = !canSettings || (el.id === 'sendEmail' && !me.emailEnabled);
  const msg = me.messaging;
  const off = (what) => `<span class="pill neutral">غير مفعّل</span> اضبطي ${what} في ملف <span class="mono">.env</span>`;
  $('smsStatus').innerHTML = `<b>SMS:</b> ${msg.sms.enabled ? `<span class="pill valid">${icon('check', 'icon-sm')}مفعّل</span> عن طريق ${esc(msg.sms.provider)}`
    : off('<span class="mono">SMS_PROVIDER</span> وبيانات الحساب')}`;
  $('waStatus').innerHTML = `<b>واتساب:</b> ${msg.whatsapp.enabled ? `<span class="pill valid">${icon('check', 'icon-sm')}مفعّل</span>${msg.whatsapp.template ? ` بالقالب <span class="mono">${esc(msg.whatsapp.template)}</span>` : ' (بدون قالب معتمد)'}`
    : off('<span class="mono">WHATSAPP_TOKEN</span> و <span class="mono">WHATSAPP_PHONE_NUMBER_ID</span>')}`;
  $('phonesStatus').innerHTML = `<b>الأرقام:</b> ${msg.phones.length ? msg.phones.map((p) => `<span class="mono">${esc(p)}</span>`).join('، ') : off('<span class="mono">ALERT_PHONES</span>')}`;
  $('sendSms').disabled = !canSettings || !msg.sms.enabled;
  $('sendWa').disabled = !canSettings || !msg.whatsapp.enabled;
  renderNotifyStatus();
  renderPwaStatus();
  renderThemeOptions();
  loadBackup();
  loadReminders();
  loadCosts();
}

// ---------- تكلفة التجديد ----------

async function loadCosts() {
  costCache = null;
  const c = await costDefaults();
  const canEdit = can('settings', 'write');
  $('costItems').innerHTML = c.items.map((i) => `<label><span>${esc(i.label)}</span>
    <input class="input" data-cost="${esc(i.key)}" inputmode="decimal" value="${i.value}" ${canEdit ? '' : 'disabled'}></label>`).join('');
  $('costSave').hidden = !canEdit;
  renderCostTotal();
}

function renderCostTotal() {
  const total = $$('[data-cost]').reduce((s, el) => s + (Number(el.value.replace(/[,٬]/g, '')) || 0), 0);
  $('costTotal').textContent = money(total);
}
$('costItems').addEventListener('input', renderCostTotal);
$('costSave').addEventListener('click', async () => {
  const body = Object.fromEntries($$('[data-cost]').map((el) => [el.dataset.cost, el.value.replace(/[,٬]/g, '')]));
  try {
    await api('/api/costs', { method: 'PUT', body: JSON.stringify(body) });
    toast('تم حفظ تكلفة التجديد');
    loadCosts();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- تذكير الموظفين بالـ SMS ----------

let remind = null;

function renderRemindPreview() {
  if (!remind) return;
  const text = ($('remindTemplate').value.trim() || remind.defaultTemplate)
    .replace(/\{[^{}]+\}/g, (k) => remind.sample[k] ?? k).replace(/[ \t]+/g, ' ').trim();
  $('remindPreview').textContent = text;
  // العربي يتبعت Unicode: 70 حرف للرسالة الواحدة و67 لكل جزء لو أطول
  // eslint-disable-next-line no-control-regex
  const unicode = /[^\x00-\x7F]/.test(text);
  const [one, part] = unicode ? [70, 67] : [160, 153];
  const parts = text.length <= one ? 1 : Math.ceil(text.length / part);
  $('remindCount').textContent = `${fmt(text.length)} حرف · ${parts === 1 ? 'رسالة واحدة' : `${fmt(parts)} رسائل`} لكل موظف`;
}

// موعد التذكير بصياغة طبيعية: قبلها بيوم / قبل 7 أيام / قبل 30 يوم
function beforeText(n) {
  if (n === 0) return 'يوم الانتهاء';
  if (n === 1) return 'قبلها بيوم';
  if (n === 2) return 'قبلها بيومين';
  return `قبل ${fmt(n)} ${n <= 10 ? 'أيام' : 'يوم'}`;
}

async function loadReminders() {
  const card = $('remindCard');
  card.hidden = !can('settings', 'read');
  if (card.hidden) return;
  try {
    remind = await api('/api/reminders');
  } catch {
    card.hidden = true;
    return;
  }
  const r = remind;
  $('remindProvider').innerHTML = r.providerReady
    ? `<b>المزود:</b> <span class="pill valid">${icon('check', 'icon-sm')}جاهز</span> ${esc(r.provider)}`
    : '<b>المزود:</b> <span class="pill neutral">غير مضبوط</span> اضبطي <span class="mono">SMS_PROVIDER</span> وبيانات الحساب في ملف <span class="mono">.env</span>';
  $('remindEnabled').checked = r.enabled;
  $('remindEnabled').disabled = !r.providerReady && !r.enabled;
  $('remindDays').value = r.days.join('، ');
  $('remindTemplate').value = r.template;
  renderRemindPreview();
  $('remindDue').innerHTML = `<b>المستحق الآن:</b> ${fmt(r.due)} موظف${r.noPhone ? ` <span class="muted">(و${fmt(r.noPhone)} بدون رقم جوال صحيح)</span>` : ''}`;
  $('remindLastRun').hidden = !r.lastRun;
  if (r.lastRun) {
    $('remindLastRun').innerHTML = `<b>آخر إرسال:</b> ${esc(fmtStamp(r.lastRun.at))} · اتبعت ${fmt(r.lastRun.sent)}${r.lastRun.failed ? ` · <span class="pill expired sm">فشل ${fmt(r.lastRun.failed)}</span>` : ''}`;
  }
  $('remindRun').disabled = !r.providerReady || !r.due;
  $('remindTest').disabled = !r.providerReady;
  $('remindLog').innerHTML = r.recent.length
    ? r.recent.map((n) => `<li>${n.status === 'sent' ? `<span class="pill valid sm">${icon('check', 'icon-sm')}اتبعتت</span>` : `<span class="pill expired sm" title="${esc(n.error)}">فشلت</span>`}
        <span class="who">${esc(n.name)} <span class="muted">· ${beforeText(n.threshold)}</span></span><span class="when">${esc(fmtStamp(n.sent_at))}</span></li>`).join('')
    : '<li class="muted">لم تُرسل أي رسالة بعد</li>';
}

$('remindTemplate').addEventListener('input', renderRemindPreview);
for (const b of $$('#remindVars [data-var]')) {
  b.addEventListener('click', () => {
    const t = $('remindTemplate');
    const at = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, at) + b.dataset.var + t.value.slice(t.selectionEnd ?? at);
    t.focus();
    t.selectionStart = t.selectionEnd = at + b.dataset.var.length;
    renderRemindPreview();
  });
}
$('remindReset').addEventListener('click', () => {
  $('remindTemplate').value = remind.defaultTemplate;
  renderRemindPreview();
});
$('remindSave').addEventListener('click', async () => {
  try {
    await api('/api/reminders', {
      method: 'PUT',
      body: JSON.stringify({ enabled: $('remindEnabled').checked, days: $('remindDays').value, template: $('remindTemplate').value }),
    });
    toast($('remindEnabled').checked ? 'تم الحفظ، والتذكير هيتبعت يوميًا' : 'تم الحفظ');
    loadReminders();
  } catch (err) {
    toast(err.message, 'error');
  }
});
$('remindRun').addEventListener('click', async () => {
  if (!(await confirmDialog(`هيتبعت ${fmt(remind.due)} رسالة SMS للموظفين المستحقين دلوقتي، كل موظف على جواله.`,
    { title: 'إرسال التذكير الآن؟', ok: 'إرسال', iconName: 'send', danger: false }))) return;
  const btn = $('remindRun');
  btn.disabled = true;
  try {
    const res = await api('/api/reminders/run', { method: 'POST' });
    toast(res.failed ? `اتبعت ${fmt(res.sent)} وفشل ${fmt(res.failed)}: ${res.error}` : `تم الإرسال: ${fmt(res.sent)} موظف`, res.failed ? 'error' : 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  loadReminders();
});
$('remindTest').addEventListener('click', async () => {
  try {
    await api('/api/reminders/test', { method: 'POST', body: JSON.stringify({ phone: $('remindTestPhone').value }) });
    toast('تم إرسال رسالة التجربة');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- النسخ الاحتياطي (مدير النظام بدون تقييد فرع) ----------

const fmtStamp = (iso) => new Date(iso).toLocaleString('ar-SA-u-ca-gregory-nu-latn', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Riyadh',
});
const fmtSize = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} ج.ب` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} م.ب` : `${Math.max(1, Math.round(b / 1024))} ك.ب`);

async function loadBackup() {
  const card = $('backupCard');
  card.hidden = state.me.role !== 'admin' || Boolean(state.me.branch);
  if (card.hidden) return;
  let b;
  try {
    b = await api('/api/backup');
  } catch {
    card.hidden = true;
    return;
  }
  const s = b.server;
  const age = s ? (Date.now() - new Date(s.time)) / 86400000 : 0;
  $('backupServer').innerHTML = !b.serverConfigured
    ? '<b>تلقائي:</b> <span class="pill neutral">غير مفعّل</span> النسخ اليومي بيشتغل على السيرفر بعد التثبيت بسكربت <span class="mono">install.sh</span>'
    : !s ? '<b>تلقائي:</b> <span class="pill neutral">لم تتم أي نسخة بعد</span>'
      : `<b>تلقائي:</b> ${s.ok && age < 2 ? `<span class="pill valid">${icon('check', 'icon-sm')}يعمل</span>` : `<span class="pill expired">${s.ok ? 'متوقف' : 'فشل'}</span>`}
        <span>آخر نسخة ${esc(fmtStamp(s.time))} · ${fmtSize(s.size)}</span>${s.error ? `<span class="muted">${esc(s.error)}</span>` : ''}`;
  $('backupRemote').hidden = !s;
  if (s) {
    $('backupRemote').innerHTML = `<b>خارج السيرفر:</b> ${!s.remote
      ? '<span class="pill neutral">غير مضبوط</span> <span>اربطيه بـ Google Drive بسكربت <span class="mono">setup-offsite-backup.sh</span></span>'
      : `${s.remoteOk ? `<span class="pill valid">${icon('check', 'icon-sm')}مرفوعة</span>` : '<span class="pill expired">فشل الرفع</span>'} <span class="mono">${esc(s.remote)}</span>`}`;
  }
  $('backupLast').innerHTML = b.lastDownload
    ? `<b>آخر تنزيل:</b> ${esc(fmtStamp(b.lastDownload.at))} بواسطة ${esc(b.lastDownload.user)}${b.lastDownload.files ? '' : ' (بدون المستندات)'}`
    : '<b>آخر تنزيل:</b> <span class="muted">لم يتم تنزيل نسخة من هنا بعد</span>';
  $('backupFilesSize').textContent = `(${fmt(b.files)} ملف · ${fmtSize(b.filesSize)})`;
}

$('backupDownload').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = `/api/backup/download?files=${$('backupFiles').checked ? 1 : 0}`;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
  toast('جاري تجهيز النسخة… هتنزل خلال ثواني', 'info');
  setTimeout(loadBackup, 4000);
});

function renderPwaStatus() {
  const st = PWA.state();
  const text = {
    installed: `<span class="pill valid">${icon('check', 'icon-sm')}مثبّتة</span> المنصة مفتوحة كتطبيق على الجهاز ده`,
    prompt: '<span class="pill neutral">غير مثبّتة</span> اضغطي الزرار وهتظهر رسالة التأكيد',
    ios: 'على الآيفون: افتحي المنصة من <b>Safari</b> ← زرار المشاركة <b>⎋</b> ← <b>إضافة إلى الشاشة الرئيسية</b>',
    manual: 'من قائمة المتصفح (⋮) اختاري <b>تثبيت التطبيق</b> أو <b>إضافة إلى الشاشة الرئيسية</b>',
    insecure: '<span class="pill neutral">غير متاح</span> التثبيت محتاج المنصة تكون على رابط <span class="mono">https</span> (بعد ربط الدومين على السيرفر)',
  }[st];
  $('pwaStatus').innerHTML = text;
  $('pwaInstall').hidden = st !== 'prompt';
}
document.addEventListener('pwachange', () => { if (state.view === 'settings') renderPwaStatus(); });
$('pwaInstall').addEventListener('click', async () => {
  if (await PWA.install()) toast('تم تثبيت المنصة كتطبيق');
  renderPwaStatus();
});

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

$('saveCompany').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ companyName: $('companyName').value }) });
    toast('تم حفظ اسم المنشأة');
  } catch (err) {
    toast(err.message, 'error');
  }
});

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

for (const [id, channel, label] of [['sendSms', 'sms', 'SMS'], ['sendWa', 'whatsapp', 'واتساب']]) {
  $(id).addEventListener('click', async () => {
    const btn = $(id);
    btn.disabled = true;
    try {
      const res = await api(`/api/alerts/send-${channel}`, { method: 'POST' });
      toast(res.sent ? `تم إرسال ${label} إلى ${fmt(res.recipients)} رقم` : 'لا يوجد شيء يحتاج تنبيهًا الآن', res.sent ? 'success' : 'info');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

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
