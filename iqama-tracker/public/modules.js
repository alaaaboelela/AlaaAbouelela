// الأقسام: العقود، بطاقات السائقين، السيارات، السلف، العهد
// + الدرج الجانبي (التفاصيل، السجلات التابعة، المستندات) وملف الموظف
// يعتمد على الأدوات العامة في app.js: $, $$, api, esc, fmt, icon, toast, openModal, closeModal, confirmDialog ...

const Modules = (() => {
  let schema = {};
  const ms = { key: null, page: 1, status: 'all', items: [], data: null };

  const SUBTITLES = {
    contracts: 'عقود التشغيل والشراكة مع الشركات ومستنداتها',
    driver_cards: 'بطاقات السائقين وتواريخ انتهائها',
    cars: 'أسطول السيارات، الصيانة، وسجل التحديثات',
    advances: 'السلف المصروفة للموظفين والدفعات المسددة',
    custody: 'العهد المسلّمة للموظفين وحالة إرجاعها',
    evaluations: 'تقييم أداء الموظفين ومتابعة تطورهم',
  };

  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  const money = (v) => (v == null || v === '' ? '—' : `${fmt(Number(v))} ر.س`);
  const dateCell = (v) => (v ? `${esc(fmtGregorian(v, 'short'))}<span class="sub">${esc(fmtHijri(v))}</span>` : '<span class="muted">—</span>');

  // عرض التقييم بالنجوم (يدعم الأنصاف)
  function stars(score, withNumber = true) {
    if (score == null) return '<span class="muted">—</span>';
    const n = Number(score);
    let html = '';
    for (let i = 1; i <= 5; i++) {
      const fill = Math.max(0, Math.min(1, n - i + 1));
      html += `<span class="star">${icon('star-fill', 'icon-sm')}<span class="star-on" style="width:${Math.round(fill * 100)}%">${icon('star-fill', 'icon-sm')}</span></span>`;
    }
    return `<span class="stars" title="${n} من 5">${html}</span>${withNumber ? `<b class="score">${n.toFixed(1)}</b>` : ''}`;
  }

  function statusPill(m, status) {
    const s = m.statuses[status];
    if (!s) return '';
    const ic = { expired: 'x-circle', expiring: 'clock', valid: 'check' }[s.tone];
    return `<span class="pill ${s.tone}">${icon(ic, 'icon-sm')}${esc(s.label)}</span>`;
  }

  // ---------- الخلايا ----------

  function cell(col, r, m) {
    const v = r[col.key];
    switch (col.type) {
      case 'title': {
        const sub = col.sub ? r[col.sub] : '';
        return `<strong>${esc(v)}</strong>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
      }
      case 'person':
        return `<div class="person"><span class="initials">${esc(initials(v || '؟'))}</span>
          <div><strong>${esc(v)}</strong><small class="mono">${esc(r[col.sub] || '')}</small></div></div>`;
      case 'plate': {
        const sub = (col.sub || []).map((k) => r[k]).filter(Boolean).join(' · ');
        return `<span class="plate">${esc(v)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
      }
      case 'mono':
        return v ? `<span class="mono">${esc(v)}</span>` : '<span class="muted">—</span>';
      case 'money':
        return money(v);
      case 'stars':
        return `<span class="stars-cell">${stars(v)}</span>`;
      case 'date':
        return dateCell(v);
      case 'days':
        return `<span class="days ${m.statuses[r.status]?.tone || ''}">${remainingText(v)}</span>`;
      case 'progress': {
        const total = Number(r[col.of]) || 0;
        const remaining = Number(v) || 0;
        const paidPct = total ? Math.round(((total - remaining) / total) * 100) : 0;
        return `<div class="remain valid"><span>${remaining > 0 ? `متبقي ${money(remaining)}` : 'مسددة بالكامل'}</span>
          <span class="track"><span class="fill" style="width:${paidPct}%"></span></span></div>`;
      }
      default:
        return v == null || v === '' ? '<span class="muted">—</span>' : esc(v);
    }
  }

  // ---------- عرض القسم ----------

  function show(key) {
    if (ms.key !== key) {
      ms.key = key;
      ms.page = 1;
      ms.status = 'all';
      ms.items = [];
      $('mSearch').value = '';
      $('mSort').value = 'default';
    }
    const m = schema[key];
    $('mTitle').textContent = `سجل ${m.label}`;
    $('mSearch').placeholder = `ابحث في ${m.label}...`;
    $('mStatus').innerHTML = [['all', 'الكل'], ...Object.entries(m.statuses).map(([k, s]) => [k, s.label])]
      .map(([k, label]) => `<button type="button" data-status="${k}" aria-pressed="${k === ms.status}">${esc(label)} <span class="count" data-mcount="${k}"></span></button>`)
      .join('');
    $('mHead').innerHTML = `<tr>${m.columns.map((c) => `<th>${esc(c.label || m.fields.find((f) => f.name === c.key)?.label || '')}</th>`).join('')}
      <th>الحالة</th><th><span class="sr-only">إجراءات</span></th></tr>`;
    load();
  }

  let req = 0;
  async function load() {
    const key = ms.key;
    const m = schema[key];
    const id = ++req;
    if (!ms.items.length) {
      $('mRows').innerHTML = Array.from({ length: 5 }, () =>
        `<tr class="skeleton">${m.columns.map(() => '<td><span style="width:90px"></span></td>').join('')}<td><span style="width:60px"></span></td><td></td></tr>`).join('');
    }
    const qs = new URLSearchParams({ page: ms.page, pageSize: 25, sort: $('mSort').value });
    if (ms.status !== 'all') qs.set('status', ms.status);
    if ($('mSearch').value.trim()) qs.set('q', $('mSearch').value.trim());
    const data = await api(`/api/m/${key}?${qs}`);
    if (id !== req || key !== ms.key) return;
    ms.items = data.items;
    ms.data = data;

    $('mRows').innerHTML = data.items.map((r, i) => `
      <tr class="clickable" data-open="${r.id}" style="animation-delay:${Math.min(i, 12) * 25}ms">
        ${m.columns.map((c) => `<td>${cell(c, r, m)}</td>`).join('')}
        <td>${statusPill(m, r.status)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" data-mopen="${r.id}" title="التفاصيل والمستندات">${icon('folder')}</button>
          <button class="icon-btn" data-medit="${r.id}" title="تعديل">${icon('edit')}</button>
          <button class="icon-btn danger" data-mdelete="${r.id}" title="حذف">${icon('trash')}</button>
        </div></td>
      </tr>`).join('');
    $('mEmpty').hidden = data.items.length > 0;

    for (const el of $$('[data-mcount]')) el.textContent = fmt(data.counts[el.dataset.mcount === 'all' ? 'total' : el.dataset.mcount] ?? 0);
    $('mSub').textContent = `${fmt(data.counts.total)} ${m.label}`;
    $('mTotals').innerHTML = totalsHtml(key, data.totals);

    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
    $('mPageInfo').textContent = `عرض ${fmt(from)}–${fmt(Math.min(data.total, data.page * data.pageSize))} من ${fmt(data.total)}`;
    $('mPrev').disabled = data.page <= 1;
    $('mNext').disabled = data.page >= pages;
  }

  function totalsHtml(key, t) {
    if (!t) return '';
    if (key === 'advances') {
      return `<span class="total-chip">إجمالي السلف <b>${money(t.amount)}</b></span>
        <span class="total-chip warn">المتبقي للتحصيل <b>${money(t.remaining)}</b></span>`;
    }
    if (key === 'custody') return `<span class="total-chip">قيمة العهد لدى الموظفين <b>${money(t.value)}</b></span>`;
    if (key === 'evaluations' && t.average) return `<span class="total-chip">متوسط التقييمات <b>${Number(t.average).toFixed(1)} / 5</b></span>`;
    return '';
  }

  $('mStatus').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ms.status = b.dataset.status;
    ms.page = 1;
    for (const x of $$('#mStatus button')) x.setAttribute('aria-pressed', String(x === b));
    load();
  });
  let timer;
  $('mSearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { ms.page = 1; load(); }, 300);
  });
  $('mSort').addEventListener('change', () => { ms.page = 1; load(); });
  $('mPrev').addEventListener('click', () => { ms.page -= 1; load(); });
  $('mNext').addEventListener('click', () => { ms.page += 1; load(); });

  $('mRows').addEventListener('click', async (e) => {
    const find = (id) => ms.items.find((r) => r.id === id);
    const edit = e.target.closest('[data-medit]');
    const del = e.target.closest('[data-mdelete]');
    if (edit) return openForm(ms.key, find(edit.dataset.medit));
    if (del) return remove(ms.key, find(del.dataset.mdelete));
    const row = e.target.closest('[data-open]');
    if (row) return openDrawer(ms.key, row.dataset.open);
    return undefined;
  });

  async function remove(key, r, after) {
    const m = schema[key];
    const name = r[m.title] || '';
    if (!(await confirmDialog(`سيتم حذف ${m.singular} "${name}" وكل مستنداته نهائيًا.`))) return;
    try {
      await api(`/api/m/${key}/${r.id}`, { method: 'DELETE' });
      toast(`تم حذف ${m.singular}`);
      closeDrawer();
      if (after) after(); else load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------- النموذج العام ----------

  function fieldHtml(f, value, displayName) {
    const req = f.required ? ' <b class="req">*</b>' : '';
    const cls = `field${f.wide || f.type === 'textarea' ? ' wide' : ''}`;
    const v = value ?? (f.defaultToday ? todayIso() : (f.default ?? ''));
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    let input;
    switch (f.type) {
      case 'textarea':
        input = `<textarea class="input" name="${f.name}" rows="2" maxlength="2000">${esc(v)}</textarea>`;
        break;
      case 'select':
        input = `<select class="input" name="${f.name}"><option value="">— اختر —</option>
          ${f.options.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        break;
      case 'date':
        input = `<input class="input" type="date" name="${f.name}" value="${esc(v)}"><span class="hint" data-hijri-for="${f.name}"></span>`;
        break;
      case 'money':
        input = `<div class="input-suffix"><input class="input" name="${f.name}" inputmode="decimal" value="${esc(v)}"${ph}><span>ر.س</span></div>`;
        break;
      case 'int':
        input = `<input class="input" name="${f.name}" inputmode="numeric" value="${esc(v)}"${ph}>`;
        break;
      case 'rating':
        input = `<div class="rating-input" role="radiogroup" aria-label="${esc(f.label)}">
          ${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="r-${f.name}-${n}" name="${f.name}" value="${n}"${Number(v) === n ? ' checked' : ''}>
          <label for="r-${f.name}-${n}" title="${n} من 5">${icon('star-fill')}</label>`).join('')}
          <span class="rating-text">${RATING_TEXT[v] || 'اختر التقييم'}</span></div>`;
        break;
      case 'employee':
        input = `<div class="combo" data-combo="${f.name}">
          <div class="input-icon"><svg class="icon"><use href="icons.svg#i-search"/></svg>
            <input class="input" data-combo-input placeholder="ابحث بالاسم أو رقم الإقامة" autocomplete="off" value="${esc(displayName || '')}"></div>
          <input type="hidden" name="${f.name}" value="${esc(v)}">
          <ul class="combo-list" hidden></ul></div>`;
        break;
      default:
        input = `<input class="input${f.mono ? ' mono' : ''}" name="${f.name}" value="${esc(v)}" maxlength="200"${ph}>`;
    }
    return `<label class="${cls}"><span>${esc(f.label)}${req}</span>${input}</label>`;
  }

  const RATING_TEXT = { 1: 'ضعيف', 2: 'مقبول', 3: 'جيد', 4: 'جيد جدًا', 5: 'ممتاز' };

  function bindFormExtras(root) {
    for (const group of $$('.rating-input', root)) {
      group.addEventListener('change', (e) => {
        group.querySelector('.rating-text').textContent = RATING_TEXT[e.target.value];
      });
    }
    // التاريخ الهجري المقابل
    for (const input of $$('input[type=date]', root)) {
      const hint = root.querySelector(`[data-hijri-for="${input.name}"]`);
      const update = () => { hint.textContent = input.value ? `يوافق ${fmtHijri(input.value)}` : ''; };
      input.addEventListener('input', update);
      update();
    }
    // اختيار الموظف بالبحث
    for (const combo of $$('[data-combo]', root)) {
      const text = combo.querySelector('[data-combo-input]');
      const hidden = combo.querySelector('input[type=hidden]');
      const list = combo.querySelector('.combo-list');
      let t;
      let results = [];
      let active = -1;
      const render = () => {
        list.hidden = !results.length;
        list.innerHTML = results.map((r, i) => `<li data-i="${i}" class="${i === active ? 'active' : ''}">
          <span class="initials">${esc(initials(r.name))}</span><div><strong>${esc(r.name)}</strong><small class="mono">${esc(r.iqamaNumber)}</small></div></li>`).join('');
      };
      const choose = (r) => {
        hidden.value = r.id;
        text.value = r.name;
        results = [];
        render();
      };
      text.addEventListener('input', () => {
        hidden.value = '';
        clearTimeout(t);
        t = setTimeout(async () => {
          results = await api(`/api/employees?q=${encodeURIComponent(text.value.trim())}`);
          active = -1;
          render();
        }, 200);
      });
      text.addEventListener('focus', () => { if (!text.value) text.dispatchEvent(new Event('input')); });
      text.addEventListener('keydown', (e) => {
        if (!results.length) return;
        if (e.key === 'ArrowDown') { active = (active + 1) % results.length; render(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { active = (active - 1 + results.length) % results.length; render(); e.preventDefault(); }
        if (e.key === 'Enter' && active >= 0) { choose(results[active]); e.preventDefault(); }
        if (e.key === 'Escape') { results = []; render(); e.stopPropagation(); }
      });
      list.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li');
        if (li) { e.preventDefault(); choose(results[Number(li.dataset.i)]); }
      });
      text.addEventListener('blur', () => setTimeout(() => { results = []; render(); }, 150));
    }
  }

  const displayNameFor = (record, f) => record?.[f.name.replace(/_id$/, '_name')];

  let formCtx = null;
  function openForm(key, record, onSaved) {
    const m = schema[key];
    formCtx = { key, record, onSaved };
    $('mModalTitle').textContent = record ? `تعديل ${m.singular}` : `إضافة ${m.singular}`;
    $('mModalIcon').setAttribute('href', `icons.svg#i-${m.icon}`);
    $('mSubmit').textContent = record ? 'حفظ التعديلات' : `إضافة ${m.singular}`;
    $('mFields').innerHTML = `<div class="form-error" id="mError" role="alert" hidden>${icon('alert')}<span></span></div>` +
      m.fields.map((f) => fieldHtml(f, record?.[f.name], displayNameFor(record, f))).join('');
    bindFormExtras($('mFields'));
    openModal($('moduleModal'));
    setTimeout(() => $('mFields').querySelector('input:not([type=hidden]), select')?.focus(), 50);
  }

  function formError(msg) {
    const box = $('mError');
    box.querySelector('span').textContent = msg;
    box.hidden = false;
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.animation = '';
  }

  $('mForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { key, record, onSaved } = formCtx;
    const m = schema[key];
    const data = Object.fromEntries(new FormData($('mForm')));
    for (const f of m.fields) {
      if (f.type === 'employee' && f.required && !data[f.name]) return formError(`اختر ${f.label} من القائمة`);
    }
    const btn = $('mSubmit');
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const saved = await api(record ? `/api/m/${key}/${record.id}` : `/api/m/${key}`, {
        method: record ? 'PUT' : 'POST',
        body: JSON.stringify(data),
      });
      closeModal($('moduleModal'));
      toast(record ? 'تم حفظ التعديلات' : `تمت إضافة ${m.singular}`);
      if (onSaved) onSaved(saved);
      else if (ms.key === key && state.view === key) load();
      if (drawerCtx?.key === key && drawerCtx.id === saved.id) openDrawer(key, saved.id);
    } catch (err) {
      formError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
    return undefined;
  });

  // ---------- الدرج الجانبي ----------

  let drawerCtx = null;

  function openDrawerShell({ iconName, title, sub, actions = '' }) {
    $('dIcon').setAttribute('href', `icons.svg#i-${iconName}`);
    $('dTitle').textContent = title;
    $('dSub').innerHTML = sub || '';
    $('dActions').innerHTML = actions;
    document.body.classList.add('drawer-open');
    $('drawer').setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    document.body.classList.remove('drawer-open');
    $('drawer').setAttribute('aria-hidden', 'true');
    drawerCtx = null;
  }
  $('dClose').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open') && !document.querySelector('dialog[open]')) closeDrawer();
  });

  function detailsHtml(m, r) {
    return `<dl class="details">${m.fields.map((f) => {
      let v = r[f.name];
      if (f.type === 'employee') v = displayNameFor(r, f);
      let html;
      if (v == null || v === '') html = '<span class="muted">—</span>';
      else if (f.type === 'money') html = money(v);
      else if (f.type === 'rating') html = `<span class="stars-cell">${stars(v, false)} <small class="muted">${RATING_TEXT[v]}</small></span>`;
      else if (f.type === 'date') html = dateCell(v);
      else if (f.type === 'int' && f.name !== 'year') html = fmt(v);
      else html = `<span class="${f.mono ? 'mono' : ''}" style="white-space:pre-line">${esc(v)}</span>`;
      return `<div class="${f.type === 'textarea' ? 'wide' : ''}"><dt>${esc(f.label)}</dt><dd>${html}</dd></div>`;
    }).join('')}</dl>`;
  }

  async function openDrawer(key, id) {
    const m = schema[key];
    drawerCtx = { key, id };
    openDrawerShell({ iconName: m.icon, title: m.singular, sub: '' });
    $('dBody').innerHTML = '<div class="drawer-loading"><span class="spinner"></span></div>';
    const r = await api(`/api/m/${key}/${id}`);
    if (drawerCtx?.id !== id) return;
    const reload = () => { if (state.view === key) load(); };

    $('dTitle').textContent = r[m.title] || m.singular;
    $('dSub').innerHTML = statusPill(m, r.status) + (r.days_left != null ? ` <span class="muted">${remainingText(r.days_left)}</span>` : '');
    $('dActions').innerHTML = `<button class="icon-btn bordered" data-d="edit" title="تعديل">${icon('edit')}</button>
      <button class="icon-btn bordered danger" data-d="delete" title="حذف">${icon('trash')}</button>`;
    $('dActions').onclick = (e) => {
      const a = e.target.closest('[data-d]')?.dataset.d;
      if (a === 'edit') openForm(key, r, () => { reload(); openDrawer(key, id); });
      if (a === 'delete') remove(key, r, reload);
    };

    let extra = '';
    if (key === 'advances') {
      const pct = r.amount ? Math.round((r.paid / r.amount) * 100) : 0;
      extra = `<div class="summary-strip">
        <div><small>المبلغ</small><b>${money(r.amount)}</b></div>
        <div><small>المسدد</small><b class="ok">${money(r.paid)}</b></div>
        <div><small>المتبقي</small><b class="warn">${money(r.remaining)}</b></div>
        <div class="bar"><span style="width:${pct}%"></span></div></div>`;
    }
    if (key === 'evaluations') {
      extra = `<div class="summary-strip score-strip">
        <div><small>التقييم العام</small><b class="big">${Number(r.score).toFixed(1)}<small> / 5</small></b></div>
        <div class="wide-cell">${stars(r.score, false)}<small>${esc(m.statuses[r.status].label)}</small></div></div>`;
    }
    if (key === 'cars') {
      extra = `<div class="summary-strip">
        <div><small>قيمة السيارة</small><b>${money(r.value)}</b></div>
        <div><small>تكاليف الصيانة</small><b>${money(r.maintenance_cost)}</b></div>
        <div><small>الصيانة القادمة</small><b>${r.next_service_date ? esc(fmtGregorian(r.next_service_date, 'short')) : '—'}</b></div></div>`;
    }

    $('dBody').innerHTML = `${extra}
      <section class="d-section"><h3>${icon('file', 'icon-sm')}البيانات</h3>${detailsHtml(m, r)}</section>
      ${Object.entries(m.children).map(([ck, c]) => `<section class="d-section" data-child="${ck}">
        <div class="d-head"><h3>${icon(ck === 'events' ? 'wrench' : 'wallet', 'icon-sm')}${esc(c.label)}</h3>
          <button class="btn btn-ghost btn-sm" data-add-child>${icon('plus', 'icon-sm')}إضافة</button></div>
        <form class="child-form" hidden novalidate></form>
        <div class="child-list"><div class="drawer-loading"><span class="spinner"></span></div></div></section>`).join('')}
      <section class="d-section" id="dDocs"></section>`;

    for (const [ck, c] of Object.entries(m.children)) {
      setupChild($(`dBody`).querySelector(`[data-child="${ck}"]`), key, id, ck, c, () => { reload(); openDrawer(key, id); });
    }
    renderDocuments($('dDocs'), key, id);
  }

  async function setupChild(section, key, id, ck, c, refresh) {
    const formEl = section.querySelector('.child-form');
    const listEl = section.querySelector('.child-list');
    formEl.innerHTML = `<div class="form-error" hidden>${icon('alert')}<span></span></div>
      <div class="child-grid">${c.fields.map((f) => fieldHtml(f)).join('')}</div>
      <div class="child-actions"><button class="btn btn-ghost btn-sm" type="button" data-cancel>إلغاء</button>
      <button class="btn btn-primary btn-sm" type="submit">حفظ</button></div>`;
    bindFormExtras(formEl);
    section.querySelector('[data-add-child]').onclick = () => { formEl.hidden = !formEl.hidden; };
    formEl.querySelector('[data-cancel]').onclick = () => { formEl.hidden = true; };
    formEl.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/m/${key}/${id}/${ck}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(formEl))) });
        toast('تم الحفظ');
        refresh();
      } catch (err) {
        const box = formEl.querySelector('.form-error');
        box.querySelector('span').textContent = err.message;
        box.hidden = false;
      }
    };

    const rows = await api(`/api/m/${key}/${id}/${ck}`);
    if (!rows.length) {
      listEl.innerHTML = `<p class="muted small">لا توجد سجلات بعد.</p>`;
      return;
    }
    listEl.innerHTML = ck === 'events'
      ? `<ol class="timeline">${rows.map((ev) => `
          <li class="${ev.event_type === 'تحديث بيانات' ? 'update' : ''}">
            <div class="tl-head"><strong>${esc(ev.event_type)}</strong><span class="muted">${esc(fmtGregorian(ev.event_date, 'short'))}</span>
              <button class="icon-btn danger tiny" data-del-child="${ev.id}" title="حذف">${icon('trash', 'icon-sm')}</button></div>
            <div class="tl-meta">
              ${ev.cost != null ? `<span>${icon('wallet', 'icon-sm')}${money(ev.cost)}</span>` : ''}
              ${ev.odometer != null ? `<span>${icon('steering', 'icon-sm')}${fmt(ev.odometer)} كم</span>` : ''}
              ${ev.next_service_date ? `<span>${icon('calendar', 'icon-sm')}الصيانة القادمة ${esc(fmtGregorian(ev.next_service_date, 'short'))}</span>` : ''}
            </div>
            ${ev.description ? `<p>${esc(ev.description)}</p>` : ''}
            ${ev.created_by ? `<small class="muted">بواسطة ${esc(ev.created_by)}</small>` : ''}
          </li>`).join('')}</ol>`
      : `<ul class="payments">${rows.map((p) => `
          <li><span class="pay-icon">${icon('check', 'icon-sm')}</span>
            <div><strong>${money(p.amount)}</strong><small class="muted">${esc(fmtGregorian(p.paid_date, 'short'))}${p.note ? ` · ${esc(p.note)}` : ''}</small></div>
            <button class="icon-btn danger tiny" data-del-child="${p.id}" title="حذف">${icon('trash', 'icon-sm')}</button></li>`).join('')}</ul>`;
    listEl.onclick = async (e) => {
      const b = e.target.closest('[data-del-child]');
      if (!b || !(await confirmDialog('حذف هذا السجل نهائيًا؟'))) return;
      await api(`/api/m/${key}/${id}/${ck}/${b.dataset.delChild}`, { method: 'DELETE' });
      toast('تم الحذف');
      refresh();
    };
  }

  // ---------- المستندات ----------

  const FILE_ICONS = { pdf: ['file', 'pdf'], png: ['image', 'img'], jpg: ['image', 'img'], jpeg: ['image', 'img'], webp: ['image', 'img'], doc: ['file', 'word'], docx: ['file', 'word'], xls: ['file', 'excel'], xlsx: ['file', 'excel'] };
  const sizeText = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} م.ب` : `${Math.max(1, Math.round(b / 1024))} ك.ب`);

  async function renderDocuments(section, entity, id) {
    section.innerHTML = `<div class="d-head"><h3>${icon('paperclip', 'icon-sm')}المستندات <span class="count" id="docCount"></span></h3></div>
      <label class="dropzone" id="dropzone">
        <input type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx">
        <span class="dz-icon">${icon('upload')}</span>
        <strong>اسحب الملفات هنا أو اضغط للاختيار</strong>
        <small>PDF، صور، Word، Excel — حتى 20 م.ب للملف</small>
      </label>
      <ul class="docs" id="docList"></ul>`;
    const dz = section.querySelector('#dropzone');
    const input = dz.querySelector('input');
    const listEl = section.querySelector('#docList');

    const refresh = async () => {
      const docs = await api(`/api/documents?entity=${entity}&id=${id}`);
      section.querySelector('#docCount').textContent = docs.length ? fmt(docs.length) : '';
      listEl.innerHTML = docs.map((d) => {
        const ext = d.original_name.split('.').pop().toLowerCase();
        const [ic, tone] = FILE_ICONS[ext] || ['file', ''];
        const viewable = /^(application\/pdf|image\/)/.test(d.mime_type);
        return `<li>
          <span class="doc-icon ${tone}">${icon(ic)}<b>${esc(ext.toUpperCase())}</b></span>
          <div class="doc-info"><strong>${esc(d.title)}</strong>
            <small class="muted">${sizeText(d.size_bytes)} · ${esc(fmtGregorian(d.created_at.slice(0, 10), 'short'))}${d.uploaded_by ? ` · ${esc(d.uploaded_by)}` : ''}</small></div>
          ${viewable ? `<a class="icon-btn" href="/api/documents/${d.id}/file?inline=1" target="_blank" rel="noopener" title="عرض">${icon('eye')}</a>` : ''}
          <a class="icon-btn" href="/api/documents/${d.id}/file" title="تنزيل">${icon('download')}</a>
          <button class="icon-btn danger" data-del-doc="${d.id}" title="حذف">${icon('trash')}</button>
        </li>`;
      }).join('') || '<li class="muted small empty-docs">لا توجد مستندات مرفوعة بعد.</li>';
    };

    const upload = (file) => new Promise((resolve) => {
      const li = document.createElement('li');
      li.className = 'uploading';
      li.innerHTML = `<span class="doc-icon">${icon('upload')}</span><div class="doc-info"><strong>${esc(file.name)}</strong>
        <span class="track"><span class="fill"></span></span></div>`;
      listEl.prepend(li);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/documents?entity=${entity}&id=${id}`);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) li.querySelector('.fill').style.width = `${(e.loaded / e.total) * 100}%`;
      };
      xhr.onload = () => {
        if (xhr.status === 201) toast(`تم رفع ${file.name}`);
        else {
          let msg = 'تعذر رفع الملف';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { if (xhr.status === 413) msg = 'الملف أكبر من الحد المسموح'; }
          toast(`${file.name}: ${msg}`, 'error');
        }
        resolve();
      };
      xhr.onerror = () => { toast('تعذر الاتصال بالخادم', 'error'); resolve(); };
      xhr.send(file);
    });

    const handle = async (files) => {
      for (const f of files) await upload(f);
      refresh();
    };
    input.addEventListener('change', () => { handle([...input.files]); input.value = ''; });
    for (const ev of ['dragenter', 'dragover']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); });
    dz.addEventListener('drop', (e) => handle([...e.dataTransfer.files]));
    listEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del-doc]');
      if (!b || !(await confirmDialog('حذف هذا المستند نهائيًا؟'))) return;
      await api(`/api/documents/${b.dataset.delDoc}`, { method: 'DELETE' });
      toast('تم حذف المستند');
      refresh();
    });
    refresh();
  }

  // ---------- ملف الموظف ----------

  async function openEmployee(r) {
    drawerCtx = { key: 'residencies', id: r.id };
    openDrawerShell({
      iconName: 'user',
      title: r.name,
      sub: `<span class="mono">${esc(r.iqamaNumber)}</span> · ${esc(r.employer || r.nationality || '')}`,
    });
    $('dBody').innerHTML = '<div class="drawer-loading"><span class="spinner"></span></div>';
    const s = await api(`/api/employees/${r.id}/summary`);
    if (drawerCtx?.id !== r.id) return;
    const openAdv = s.advances.filter((a) => a.status === 'open');
    const remaining = openAdv.reduce((sum, a) => sum + Number(a.remaining), 0);
    const held = s.custody.filter((c) => c.status === 'held');

    const list = (key, rows, render) => `<section class="d-section">
      <div class="d-head"><h3>${icon(schema[key].icon, 'icon-sm')}${esc(schema[key].label)} <span class="count">${rows.length || ''}</span></h3>
        <button class="btn btn-ghost btn-sm" data-emp-add="${key}">${icon('plus', 'icon-sm')}إضافة</button></div>
      ${rows.length ? `<ul class="mini-list">${rows.map((x) => `<li data-emp-open="${key}:${x.id}">${render(x)}${statusPill(schema[key], x.status)}</li>`).join('')}</ul>`
        : '<p class="muted small">لا يوجد.</p>'}</section>`;

    $('dBody').innerHTML = `
      <div class="summary-strip">
        <div><small>الإقامة</small><b class="${r.status === 'valid' ? 'ok' : 'warn'}">${remainingText(r.daysLeft)}</b></div>
        <div><small>سلف متبقية</small><b class="${remaining ? 'warn' : ''}">${money(remaining)}</b></div>
        <div><small>عهد لديه</small><b>${fmt(held.length)}</b></div>
        ${s.evaluations.length ? `<div><small>آخر تقييم</small><b>${Number(s.evaluations[0].score).toFixed(1)} / 5</b></div>` : ''}
      </div>
      <section class="d-section"><h3>${icon('card', 'icon-sm')}بيانات الإقامة</h3>
        <dl class="details">
          <div><dt>رقم الإقامة</dt><dd class="mono">${esc(r.iqamaNumber)}</dd></div>
          <div><dt>تاريخ الانتهاء</dt><dd>${dateCell(r.expiryDate)}</dd></div>
          <div><dt>الجنسية</dt><dd>${esc(r.nationality || '—')}</dd></div>
          <div><dt>الجوال</dt><dd class="mono">${esc(r.phone || '—')}</dd></div>
          <div class="wide"><dt>جهة العمل</dt><dd>${esc(r.employer || '—')}</dd></div>
        </dl></section>
      ${list('driver_cards', s.driverCards, (x) => `<div><strong class="mono">${esc(x.card_number)}</strong><small class="muted">تنتهي ${esc(fmtGregorian(x.expiry_date, 'short'))}</small></div>`)}
      ${list('advances', s.advances, (x) => `<div><strong>${money(x.amount)}</strong><small class="muted">متبقي ${money(x.remaining)} · ${esc(fmtGregorian(x.issue_date, 'short'))}</small></div>`)}
      ${list('custody', s.custody, (x) => `<div><strong>${esc(x.item_name)}</strong><small class="muted">${x.value != null ? money(x.value) + ' · ' : ''}${esc(fmtGregorian(x.handed_date, 'short'))}</small></div>`)}
      ${list('evaluations', s.evaluations, (x) => `<div><strong class="stars-cell">${stars(x.score)}</strong><small class="muted">${esc(fmtGregorian(x.evaluation_date, 'short'))}${x.period ? ` · ${esc(x.period)}` : ''}${x.recommendation ? ` · ${esc(x.recommendation)}` : ''}</small></div>`)}
      ${list('cars', s.cars, (x) => `<div><strong class="plate sm">${esc(x.plate_number)}</strong><small class="muted">${esc([x.make, x.model].filter(Boolean).join(' '))}</small></div>`)}
      <section class="d-section" id="dDocs"></section>`;

    $('dBody').onclick = (e) => {
      const add = e.target.closest('[data-emp-add]');
      if (add) {
        const key = add.dataset.empAdd;
        const field = key === 'cars' ? 'driver_id' : 'employee_id';
        openForm(key, null, () => openEmployee(r));
        // تعبئة الموظف تلقائيًا
        setTimeout(() => {
          const combo = $('mFields').querySelector(`[data-combo="${field}"]`);
          if (combo) {
            combo.querySelector('input[type=hidden]').value = r.id;
            combo.querySelector('[data-combo-input]').value = r.name;
          }
        }, 0);
        return;
      }
      const open = e.target.closest('[data-emp-open]');
      if (open) {
        const [key, id] = open.dataset.empOpen.split(':');
        openDrawer(key, id);
      }
    };
    renderDocuments($('dDocs'), 'residencies', r.id);
  }

  // ---------- ملخص لوحة المتابعة ----------

  async function loadOverview() {
    const o = await api('/api/overview');
    const tile = (key, value, label, tone, extra = '') => `
      <a class="ov-tile ${tone}" href="#${key}">
        <span class="ov-icon">${icon(schema[key].icon)}</span>
        <div><small>${esc(schema[key].label)}</small><b>${value}</b><span>${label}</span></div>${extra}
      </a>`;
    const c = (k) => o[k].counts;
    $('overview').innerHTML = [
      tile('contracts', fmt(c('contracts').expiring + c('contracts').expired), `ينتهي قريبًا ${fmt(c('contracts').expiring)} · منتهي ${fmt(c('contracts').expired)}`, c('contracts').expiring + c('contracts').expired ? 'warn' : 'ok'),
      tile('driver_cards', fmt(c('driver_cards').expiring + c('driver_cards').expired), `تنتهي قريبًا ${fmt(c('driver_cards').expiring)} · منتهية ${fmt(c('driver_cards').expired)}`, c('driver_cards').expiring + c('driver_cards').expired ? 'warn' : 'ok'),
      tile('cars', fmt(c('cars').attention + c('cars').expired), `من ${fmt(c('cars').total)} سيارة تحتاج متابعة`, c('cars').attention + c('cars').expired ? 'warn' : 'ok'),
      tile('advances', money(o.advances.totals.remaining), `${fmt(c('advances').open)} سلفة قائمة`, c('advances').open ? 'info' : 'ok'),
      tile('custody', fmt(c('custody').held), `بقيمة ${money(o.custody.totals.value)}`, 'info'),
      tile('evaluations', o.evaluations.totals.average ? `${Number(o.evaluations.totals.average).toFixed(1)} / 5` : '—',
        `${fmt(c('evaluations').total)} تقييم · ضعيف ${fmt(c('evaluations').weak)}`, c('evaluations').weak ? 'warn' : 'ok'),
    ].join('');

    for (const el of $$('[data-badge]')) {
      const k = el.dataset.badge;
      const n = (c(k).expiring || 0) + (c(k).expired || 0) + (c(k).attention || 0);
      el.textContent = n ? fmt(n) : '';
    }
  }

  // ---------- البدء ----------

  async function init() {
    schema = await api('/api/schema');
    loadOverview().catch(() => {});
  }

  return {
    init,
    has: (key) => Boolean(schema[key]),
    meta: (key) => ({ title: schema[key].label, subtitle: SUBTITLES[key] || '', singular: schema[key].singular }),
    show,
    openForm,
    openEmployee,
    loadOverview,
  };
})();
