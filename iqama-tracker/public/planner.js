// صفحة التقارير والتقويم الشهري لكل الانتهاءات والمواعيد
// يعتمد على الأدوات العامة في app.js و modules.js

const Reports = (() => {
  let list = null;

  async function show() {
    list ||= await api('/api/reports');
    $('reportsGrid').innerHTML = list.map((r, i) => `
      <form class="card report-card" data-report="${r.key}" style="animation-delay:${i * 40}ms">
        <div class="setting-head">
          <span class="setting-icon">${icon(r.icon)}</span>
          <div><h2 class="card-title">${esc(r.title)}</h2><p class="card-sub">${esc(r.description)}</p></div>
        </div>
        ${r.params.length ? `<div class="report-params">${r.params.map(paramHtml).join('')}</div>` : ''}
        <div class="report-actions">
          <button class="btn btn-primary" type="submit">${icon('report')}عرض التقرير</button>
          <button class="btn btn-ghost" type="submit" data-print>${icon('printer')}طباعة / PDF</button>
        </div>
      </form>`).join('');
    Modules.bindFormExtras($('reportsGrid'));
  }

  function paramHtml(p) {
    if (p.type === 'bool') {
      return `<label class="check"><input type="checkbox" name="${p.name}"${p.default ? ' checked' : ''}> ${esc(p.label)}</label>`;
    }
    const def = p.default === 'alert' ? state.stats?.alertDays ?? 30 : p.default;
    return Modules.fieldHtml({ name: p.name, label: p.label, type: p.type, required: p.required, wide: p.type === 'employee' }, def);
  }

  $('reportsGrid').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const key = form.dataset.report;
    const def = list.find((r) => r.key === key);
    const qs = new URLSearchParams({ key });
    for (const p of def.params) {
      const el = form.elements[p.name];
      const v = p.type === 'bool' ? (el.checked ? '1' : '0') : el.value.trim();
      if (p.required && !v) {
        toast(`اختاري ${p.label} أولًا`, 'error');
        form.querySelector('[data-combo-input]')?.focus();
        return;
      }
      if (v !== '') qs.set(p.name, v);
    }
    if (Branch.current) qs.set('branch', Branch.current);
    if (e.submitter?.hasAttribute('data-print')) qs.set('print', '1');
    window.open(`/report.html?${qs}`, '_blank', 'noopener');
  });

  return { show };
})();

const Calendar = (() => {
  const cal = { month: null, data: null, selected: null, hidden: new Set() };
  try { for (const t of JSON.parse(localStorage.getItem('calHidden') || '[]')) cal.hidden.add(t); } catch { /* التخزين غير متاح */ }

  const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const iso = (d) => d.toISOString().slice(0, 10);
  const hijriDay = (d) => new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', timeZone: 'UTC' }).format(d);
  const hijriMonth = (d) => new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  const monthName = (d) => new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);

  // لون حسب قرب الموعد: متأخر / خلال مدة التنبيه / لاحقًا، والإجازات لونها مستقل
  function tone(type, date) {
    if (type.startsWith('leave_')) return 'info';
    const diff = (Date.parse(date) - Date.parse(cal.data.today)) / 86400000;
    if (diff < 0) return 'expired';
    if (diff <= cal.data.alertDays) return 'expiring';
    return 'neutral';
  }

  async function show() {
    cal.month ||= todayMonth();
    await load();
  }

  const todayMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()).slice(0, 7);

  async function load() {
    $('calGrid').classList.add('loading');
    const data = await api(`/api/calendar?month=${cal.month}`);
    cal.data = data;
    $('calGrid').classList.remove('loading');
    renderFilters();
    renderGrid();
    if (!cal.selected || !cal.selected.startsWith(cal.month)) {
      cal.selected = data.today.startsWith(cal.month) ? data.today : `${cal.month}-01`;
    }
    selectDay(cal.selected);
  }

  function renderFilters() {
    const used = new Set(Object.values(cal.data.days).flat().map((x) => x.type));
    $('calFilters').innerHTML = Object.entries(cal.data.types).filter(([t]) => used.has(t) || cal.hidden.has(t)).map(([t, info]) => `
      <button type="button" class="cal-filter" data-type="${t}" aria-pressed="${!cal.hidden.has(t)}">
        ${icon(info.icon, 'icon-sm')}${esc(info.label)}</button>`).join('')
      || '<span class="card-sub">لا توجد مواعيد في هذا الشهر</span>';
  }

  function renderGrid() {
    const first = new Date(`${cal.month}-01T00:00:00Z`);
    $('calTitle').textContent = monthName(first);
    const last = new Date(first);
    last.setUTCMonth(last.getUTCMonth() + 1);
    last.setUTCDate(0);
    const hFirst = hijriMonth(first);
    const hLast = hijriMonth(last);
    $('calHijri').textContent = hFirst === hLast ? hFirst : `${hFirst.replace(/\s*\d+\s*هـ$/, '')} – ${hLast}`;

    const start = new Date(first);
    start.setUTCDate(1 - first.getUTCDay());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      if (i === 35 && d.getUTCMonth() !== first.getUTCMonth()) break;
      const key = iso(d);
      const inMonth = d.getUTCMonth() === first.getUTCMonth();
      const events = inMonth ? (cal.data.days[key] || []).filter((x) => !cal.hidden.has(x.type)) : [];
      const total = events.reduce((s, x) => s + x.count, 0);
      const worst = events.some((x) => tone(x.type, key) === 'expired') ? 'expired'
        : events.some((x) => tone(x.type, key) === 'expiring') ? 'expiring' : events.length ? 'neutral' : '';
      cells.push(`<button type="button" class="cal-cell${inMonth ? '' : ' out'}${key === cal.data.today ? ' today' : ''}${key === cal.selected ? ' selected' : ''}"
          data-date="${key}" ${inMonth ? '' : 'tabindex="-1" disabled'} aria-label="${esc(fmtGregorian(key))}${total ? `، ${total} موعد` : ''}">
        <span class="cal-num"><b>${d.getUTCDate()}</b><small>${esc(hijriDay(d))}</small></span>
        ${events.slice(0, 3).map((x) => `<span class="cal-chip ${tone(x.type, key)}" title="${esc(cal.data.types[x.type].label)}${x.count === 1 ? `: ${esc(x.sample[0])}` : ''}">
          ${icon(cal.data.types[x.type].icon, 'icon-sm')}<span class="cal-chip-text">${x.count > 1 ? `${fmt(x.count)} ${esc(cal.data.types[x.type].short)}` : esc(x.sample[0])}</span>
          <span class="cal-chip-n">${fmt(x.count)}</span></span>`).join('')}
        ${events.length > 3 ? `<span class="cal-more">+${fmt(events.length - 3)} أنواع</span>` : ''}
        ${total ? `<span class="cal-dot ${worst}">${fmt(total)}</span>` : ''}
      </button>`);
    }
    $('calGrid').innerHTML = WEEKDAYS.map((w) => `<span class="cal-wd">${w}</span>`).join('') + cells.join('');
  }

  async function selectDay(date) {
    cal.selected = date;
    for (const c of $$('.cal-cell')) c.classList.toggle('selected', c.dataset.date === date);
    $('calDayTitle').textContent = fmtGregorian(date);
    $('calDaySub').textContent = fmtHijri(date);
    const box = $('calDayList');
    box.innerHTML = '<div class="drawer-loading"><span class="spinner"></span></div>';
    const { items } = await api(`/api/calendar/items?from=${date}`);
    if (cal.selected !== date) return;
    const visible = items.filter((x) => !cal.hidden.has(x.type));
    if (!visible.length) {
      box.innerHTML = `<div class="cal-empty">${icon('calendar')}<p>لا توجد مواعيد في هذا اليوم</p></div>`;
      return;
    }
    const groups = {};
    for (const x of visible) (groups[x.type] ||= []).push(x);
    box.innerHTML = Object.entries(groups).map(([t, rows]) => {
      const info = cal.data.types[t];
      return `<section class="d-section"><h3>${icon(info.icon, 'icon-sm')}${esc(info.label)} <span class="count">${fmt(rows.length)}</span></h3>
        <ul class="mini-list">${rows.map((x) => `<li data-open="${t}:${x.id}">
          <div><strong>${esc(x.title)}</strong><small class="muted">${esc(x.sub || '')}</small></div>
          <span class="pill ${tone(t, date)}">${remainingText(Math.round((Date.parse(date) - Date.parse(cal.data.today)) / 86400000))}</span></li>`).join('')}</ul>
        ${rows.length >= 500 ? '<p class="card-sub">يتم عرض أول 500 فقط</p>' : ''}</section>`;
    }).join('');
  }

  $('calGrid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell');
    if (cell && !cell.disabled) {
      selectDay(cell.dataset.date);
      if (matchMedia('(max-width: 1100px)').matches) $('calDay').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  $('calFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    const t = b.dataset.type;
    if (cal.hidden.has(t)) cal.hidden.delete(t); else cal.hidden.add(t);
    try { localStorage.setItem('calHidden', JSON.stringify([...cal.hidden])); } catch { /* التخزين غير متاح */ }
    b.setAttribute('aria-pressed', String(!cal.hidden.has(t)));
    renderGrid();
    selectDay(cal.selected);
  });

  const shift = (n) => {
    const d = new Date(`${cal.month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    cal.month = iso(d).slice(0, 7);
    cal.selected = null;
    load();
  };
  $('calPrev').addEventListener('click', () => shift(-1));
  $('calNext').addEventListener('click', () => shift(1));
  $('calToday').addEventListener('click', () => { cal.month = todayMonth(); cal.selected = null; load(); });

  $('calDayList').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-open]');
    if (!li) return;
    const [type, id] = li.dataset.open.split(':');
    const target = cal.data.types[type].open;
    if (target === 'employee') {
      try {
        Modules.openEmployee(await api(`/api/residencies/${id}`));
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (Modules.has(target)) {
      Modules.openDrawer(target, id);
    }
  });

  return { show };
})();
