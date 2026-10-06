// صفحة التقرير القابلة للطباعة: تقرأ نوع التقرير وخياراته من الرابط وتعرضه بتنسيق A4
(async () => {
  const sheet = document.getElementById('sheet');
  const qs = new URLSearchParams(location.search);
  const key = qs.get('key');
  qs.delete('key');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const nf = new Intl.NumberFormat('ar-SA-u-nu-latn');
  const money = (v) => (v == null || v === '' ? '—' : `${nf.format(Math.round(Number(v) * 100) / 100)} ر.س`);
  const greg = (iso) => new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
  const hijri = (iso) => {
    try {
      return new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${iso}T00:00:00Z`));
    } catch {
      return `${Hijri.gregorianToHijri(iso)} هـ`;
    }
  };
  const days = (d) => {
    if (d == null || d === '') return '—';
    const n = Number(d);
    if (n < 0) return `<span class="t-expired">منذ ${nf.format(-n)} يوم</span>`;
    if (n === 0) return '<span class="t-expiring">اليوم</span>';
    return `${nf.format(n)} يوم`;
  };

  function cell(v, type) {
    if (type === 'status') return v?.label ? `<span class="pill ${esc(v.tone)}">${esc(v.label)}</span>` : '—';
    if (v == null || v === '') return '<span class="muted">—</span>';
    switch (type) {
      case 'money': return money(v);
      case 'number': return nf.format(Number(v));
      case 'days': return days(v);
      case 'date': return `${esc(greg(v))}<small>${esc(hijri(v))}</small>`;
      case 'mono': return `<span class="mono">${esc(v)}</span>`;
      default: return esc(v);
    }
  }

  const kpiValue = (k) => (k.type === 'money' ? money(k.value) : k.type === 'days' ? days(k.value)
    : typeof k.value === 'number' ? nf.format(k.value) : esc(k.value));

  let data;
  try {
    const res = await fetch(`/api/reports/${encodeURIComponent(key)}?${qs}`);
    if (res.status === 401) { location.replace('/login.html'); return; }
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر تجهيز التقرير');
  } catch (err) {
    sheet.innerHTML = `<div class="loading error">${esc(err.message)}</div>`;
    return;
  }

  document.title = `${data.title} — ${data.today}`;
  const time = new Date(data.generatedAt).toLocaleTimeString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit' });

  sheet.innerHTML = `
    <header class="head">
      <div class="brand">
        <span class="mark"><svg class="icon"><use href="icons.svg#i-logo"/></svg></span>
        <div><strong>${esc(data.company || 'منصة الإقامات')}</strong><small>${esc(data.branch || 'كل الفروع')}</small></div>
      </div>
      <div class="when">
        <div>${esc(greg(data.today))} م</div>
        <div>${esc(hijri(data.today))}</div>
        <small>الساعة ${esc(time)} · ${esc(data.generatedBy)}</small>
      </div>
    </header>

    <h1>${esc(data.title)}</h1>
    ${data.subtitle ? `<p class="subtitle">${esc(data.subtitle)}</p>` : ''}

    ${data.meta?.length ? `<dl class="meta">${data.meta.map((m) => `<div><dt>${esc(m.label)}</dt><dd>${cell(m.value, m.type)}</dd></div>`).join('')}</dl>` : ''}

    ${data.kpis?.length ? `<div class="kpis">${data.kpis.map((k) => `
      <div class="kpi ${esc(k.tone || '')}"><small>${esc(k.label)}</small><b>${kpiValue(k)}</b></div>`).join('')}</div>` : ''}

    ${data.sections.map((s) => `
      <section>
        ${s.title ? `<h2>${esc(s.title)} <span>${nf.format(s.rows.length)}</span></h2>` : ''}
        ${s.rows.length ? `<table>
          <thead><tr><th class="n">#</th>${s.columns.map((c) => `<th class="c-${esc(c.type || 'text')}">${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${s.rows.map((r, i) => `<tr><td class="n">${nf.format(i + 1)}</td>${r.map((v, j) => `<td class="c-${esc(s.columns[j].type || 'text')}">${cell(v, s.columns[j].type)}</td>`).join('')}</tr>`).join('')}</tbody>
          ${s.totals ? `<tfoot><tr><td></td>${s.totals.map((v, j) => `<td class="c-${esc(s.columns[j].type || 'text')}">${v === '' ? '' : j === 0 ? esc(v) : cell(v, s.columns[j].type)}</td>`).join('')}</tr></tfoot>` : ''}
        </table>` : `<p class="empty">${esc(s.empty || 'لا توجد بيانات في هذا التقرير')}</p>`}
      </section>`).join('')}
    ${!data.sections.length ? '<p class="empty">لا توجد بيانات في هذا التقرير</p>' : ''}

    <footer class="foot">تقرير آلي من منصة الإقامات · ${esc(greg(data.today))} م / ${esc(hijri(data.today))}</footer>`;

  const printBtn = document.getElementById('print');
  printBtn.disabled = false;
  printBtn.addEventListener('click', () => window.print());
  document.getElementById('back').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else window.close();
  });
  if (new URLSearchParams(location.search).get('print') === '1') setTimeout(() => window.print(), 400);
})();
