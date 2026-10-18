// كشف خصم أقساط السلف من الرواتب (من قسم السلف)
// يعتمد على الأدوات العامة في app.js: $, $$, api, esc, fmt, icon, toast, openModal, confirmDialog, can, Branch

const Payroll = (() => {
  let data = null;
  const money = (v) => `${fmt(Math.round(Number(v) * 100) / 100)} ر.س`;
  const branchQs = () => (Branch.current && !Branch.locked ? `&branch=${encodeURIComponent(Branch.current)}` : '');

  async function load() {
    const month = $('payrollMonth').value;
    try {
      data = await api(`/api/payroll?month=${encodeURIComponent(month)}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    render();
  }

  function render() {
    const t = data.totals;
    const writable = can('advances', 'write');
    $('payrollTitle').textContent = `كشف خصم أقساط السلف · ${data.monthName}`;
    $('payrollKpis').innerHTML = [
      ['إجمالي الخصم', money(t.deduction)],
      ['الموظفون', fmt(t.employees)],
      ['الأقساط', fmt(data.lines.length)],
      ['غير مسجّل بعد', t.pending ? `${fmt(t.pending)} · ${money(t.pendingAmount)}` : '—'],
    ].map(([label, value]) => `<div><small>${label}</small><b>${value}</b></div>`).join('');

    $('payrollEmpty').hidden = data.lines.length > 0;
    $('payrollRows').closest('.table-wrap').hidden = !data.lines.length;
    $('payrollRows').innerHTML = data.lines.map((l) => `
      <tr class="${l.recorded ? 'recorded' : ''}">
        <td class="pick">${l.recorded || !writable ? '' : `<input type="checkbox" data-advance="${esc(l.advanceId)}" aria-label="خصم قسط ${esc(l.name)}" checked>`}</td>
        <td><strong>${esc(l.name)}</strong><span class="sub"><span class="mono">${esc(l.iqama)}</span>${l.branch ? ` · ${esc(l.branch)}` : ''}</span></td>
        <td>${money(l.amount)}<span class="sub">${esc(fmtGregorian(l.issueDate, 'short'))}</span></td>
        <td>${money(l.before)}</td>
        <td class="deduct">${money(l.deduction)}</td>
        <td>${l.after > 0 ? money(l.after) : `<span class="pill valid sm">${icon('check', 'icon-sm')}تُسدَّد</span>`}</td>
        <td>${l.recorded ? `<span class="pill valid sm">${icon('check', 'icon-sm')}مسجّل</span>` : '<span class="pill expiring sm">غير مسجّل</span>'}</td>
      </tr>`).join('');
    const table = $('payrollRows').closest('table');
    table.querySelector('tfoot')?.remove();
    if (data.lines.length) {
      table.insertAdjacentHTML('beforeend', `<tfoot><tr><td></td><td>الإجمالي</td><td></td><td></td><td>${money(t.deduction)}</td><td></td><td></td></tr></tfoot>`);
    }

    $('payrollNote').hidden = !data.noInstallment.length;
    $('payrollNote').innerHTML = data.noInstallment.length
      ? `${icon('alert', 'icon-sm')} ${fmt(data.noInstallment.length)} سلفة قائمة بدون قسط شهري ومش داخلة في الكشف: ${data.noInstallment.slice(0, 4).map((l) => esc(l.name)).join('، ')}${data.noInstallment.length > 4 ? '…' : ''}. حددي القسط من تعديل السلفة.`
      : '';

    $('payrollAll').checked = true;
    $('payrollAll').hidden = !writable || !t.pending;
    $('payrollRecord').hidden = !writable;
    updateSelection();
    $('payrollUndo').hidden = !writable || !t.recorded;
    $('payrollExport').href = `/api/payroll/export.xlsx?month=${data.month}${branchQs()}`;
    $('payrollPrint').href = `/report.html?key=payroll&month=${data.month}${branchQs()}`;
  }

  // الأقساط المحددة للتسجيل (الكل افتراضيًا)
  const picked = () => $$('#payrollRows [data-advance]').filter((el) => el.checked).map((el) => el.dataset.advance);

  function updateSelection() {
    const ids = new Set(picked());
    const lines = data.lines.filter((l) => ids.has(l.advanceId));
    for (const el of $$('#payrollRows [data-advance]')) el.closest('tr').classList.toggle('skipped', !el.checked);
    const rec = $('payrollRecord');
    rec.disabled = !lines.length;
    rec.textContent = !data.totals.pending ? 'الشهر مسجّل بالكامل' : `تسجيل الخصم (${fmt(lines.length)})`;
    return lines;
  }

  $('payrollRows').addEventListener('change', updateSelection);
  $('payrollAll').addEventListener('change', () => {
    for (const el of $$('#payrollRows [data-advance]')) el.checked = $('payrollAll').checked;
    updateSelection();
  });

  async function open() {
    const input = $('payrollMonth');
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()).slice(0, 7);
    input.max = now;
    if (!input.value) input.value = now;
    openModal($('payrollModal'));
    await load();
  }

  $('payrollMonth').addEventListener('change', () => { if ($('payrollMonth').value) load(); });
  $('mPayrollBtn').addEventListener('click', open);

  $('payrollRecord').addEventListener('click', async () => {
    const lines = updateSelection();
    const total = lines.reduce((sum, l) => sum + l.deduction, 0);
    if (!(await confirmDialog(`هيتسجل ${fmt(lines.length)} قسط بإجمالي ${money(total)} كدفعات على السلف، بتاريخ آخر يوم في ${data.monthName}.`,
      { title: 'تسجيل خصم الشهر؟', ok: 'تسجيل الخصم', iconName: 'wallet', danger: false }))) return;
    try {
      const r = await api('/api/payroll/record', { method: 'POST', body: JSON.stringify({ month: data.month, advanceIds: lines.map((l) => l.advanceId) }) });
      toast(`تم تسجيل ${fmt(r.recorded)} قسط بإجمالي ${money(r.amount)}`);
      await load();
      Modules.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('payrollUndo').addEventListener('click', async () => {
    if (!(await confirmDialog(`هتتحذف دفعات الخصم المسجّلة من كشف ${data.monthName} (${fmt(data.totals.recorded)} قسط)، وترجع المبالغ متبقية على السلف.`,
      { title: 'إلغاء تسجيل الشهر؟', ok: 'إلغاء التسجيل' }))) return;
    try {
      const r = await api(`/api/payroll/record?month=${data.month}`, { method: 'DELETE' });
      toast(`تم حذف ${fmt(r.removed)} دفعة`);
      await load();
      Modules.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  return { open };
})();
