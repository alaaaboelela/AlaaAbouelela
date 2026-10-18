// صفحات الإدارة: المستخدمين، سجل العمليات، تغيير كلمة المرور
// يعتمد على الأدوات العامة في app.js

const Admin = (() => {
  let roles = null;
  let users = [];

  async function loadRoles() {
    roles ||= await api('/api/roles');
    return roles;
  }

  const fmtDateTime = (iso) => (iso
    ? new Date(iso).toLocaleString('ar-SA-u-ca-gregory-nu-latn', { dateStyle: 'medium', timeStyle: 'short' })
    : '—');

  // ---------- المستخدمين ----------

  async function showUsers() {
    const r = await loadRoles();
    users = await api('/api/users');
    $('usersSub').textContent = `${fmt(users.length)} مستخدم · ${fmt(users.filter((u) => u.active).length)} فعّال`;
    $('usersRows').innerHTML = users.map((u, i) => `
      <tr style="animation-delay:${i * 25}ms" class="${u.active ? '' : 'inactive'}">
        <td><div class="person"><span class="initials">${esc((u.full_name || u.username).slice(0, 2))}</span>
          <div><strong>${esc(u.full_name || u.username)}</strong><small class="mono">${esc(u.username)}</small></div></div></td>
        <td><span class="pill ${u.role === 'admin' ? 'valid' : 'neutral'}">${esc(u.roleLabel)}</span>
          ${Branch.list.length ? `<span class="sub">${u.branch_name ? esc(u.branch_name) : 'كل الفروع'}</span>` : ''}</td>
        <td>${u.active ? `<span class="pill valid">${icon('check', 'icon-sm')}فعّال</span>` : '<span class="pill expired">موقوف</span>'}
          ${u.two_factor ? `<span class="sub">${icon('lock', 'icon-sm')} تحقق بخطوتين</span>` : ''}</td>
        <td>${esc(fmtDateTime(u.last_login))}</td>
        <td><div class="row-actions">
          <button class="icon-btn" data-uedit="${u.id}" title="تعديل">${icon('edit')}</button>
          ${u.id === state.me.id ? '' : `<button class="icon-btn danger" data-udel="${u.id}" title="حذف">${icon('trash')}</button>`}
        </div></td>
      </tr>`).join('');

    const sections = Object.entries(r.sections);
    const mark = { write: '<span class="perm w" title="تعديل">✎</span>', read: '<span class="perm r" title="قراءة">👁</span>', null: '<span class="perm n">—</span>' };
    $('rolesMatrix').innerHTML = `<thead><tr><th>القسم</th>${Object.values(r.roles).map((x) => `<th>${esc(x.label)}</th>`).join('')}</tr></thead>
      <tbody>${sections.map(([k, label]) => `<tr><td>${esc(label)}</td>${Object.values(r.roles).map((x) => `<td>${mark[x.permissions[k]]}</td>`).join('')}</tr>`).join('')}</tbody>`;
  }

  async function openUser(u) {
    const r = await loadRoles();
    const f = $('userForm');
    f.reset();
    $('userError').hidden = true;
    $('userRole').innerHTML = Object.entries(r.roles).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join('');
    f.elements.id.value = u?.id || '';
    f.elements.username.value = u?.username || '';
    f.elements.username.disabled = Boolean(u);
    f.elements.full_name.value = u?.full_name || '';
    f.elements.role.value = u?.role || 'hr';
    $('userBranchField').hidden = !Branch.list.length;
    $('userBranch').innerHTML = branchOptions(u?.branch_id, 'كل الفروع');
    f.elements.active.checked = u ? u.active : true;
    $('userPwdLabel').innerHTML = u ? 'كلمة مرور جديدة <small class="muted">(اتركيها فارغة للإبقاء على الحالية)</small>' : 'كلمة المرور <b class="req">*</b>';
    $('userModalTitle').textContent = u ? `تعديل المستخدم ${u.username}` : 'مستخدم جديد';
    $('userTfa').hidden = !u?.two_factor;
    $('userTfaReset').dataset.id = u?.id || '';
    updateRoleHint();
    openModal($('userModal'));
  }

  function updateRoleHint() {
    if (!roles) return;
    const p = roles.roles[$('userRole').value]?.permissions || {};
    const write = Object.entries(p).filter(([, v]) => v === 'write').map(([k]) => roles.sections[k]);
    const scope = $('userBranch').value ? ` — ويرى بيانات ${branchName($('userBranch').value)} فقط` : '';
    $('roleHint').textContent = (write.length ? `يقدر يضيف ويعدّل في: ${write.join('، ')}` : 'قراءة فقط، بدون أي تعديل') + scope;
  }
  $('userRole').addEventListener('change', updateRoleHint);
  $('userBranch').addEventListener('change', updateRoleHint);

  $('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.elements.id.value;
    const body = {
      username: f.elements.username.value,
      full_name: f.elements.full_name.value,
      role: f.elements.role.value,
      password: f.elements.password.value,
      active: f.elements.active.checked,
      branch_id: f.elements.branch_id.value,
    };
    try {
      await api(id ? `/api/users/${id}` : '/api/users', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
      closeModal($('userModal'));
      toast(id ? 'تم حفظ التعديلات' : 'تمت إضافة المستخدم');
      showUsers();
    } catch (err) {
      const box = $('userError');
      box.querySelector('span').textContent = err.message;
      box.hidden = false;
    }
  });

  $('usersRows').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-uedit]');
    const del = e.target.closest('[data-udel]');
    if (edit) openUser(users.find((u) => u.id === edit.dataset.uedit));
    if (del) {
      const u = users.find((x) => x.id === del.dataset.udel);
      if (!(await confirmDialog(`حذف المستخدم "${u.username}"؟ لن يستطيع الدخول مرة أخرى. (لإيقافه مؤقتًا استخدمي التعديل بدل الحذف)`))) return;
      try {
        await api(`/api/users/${u.id}`, { method: 'DELETE' });
        toast('تم حذف المستخدم');
        showUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  // ---------- سجل العمليات ----------

  const audit = { page: 1 };
  const ENTITY_LABELS = {
    residencies: 'الإقامات', users: 'المستخدمين', settings: 'الإعدادات',
  };
  const ACTION_ICON = {
    create: 'plus', update: 'edit', delete: 'trash', import: 'upload', upload: 'paperclip',
    login: 'logout', login_failed: 'alert', password: 'key', settings: 'settings',
  };

  async function showAudit() {
    const qs = new URLSearchParams({ page: audit.page });
    for (const [id, key] of [['auditQ', 'q'], ['auditUser', 'user'], ['auditAction', 'action'], ['auditFrom', 'from'], ['auditTo', 'to']]) {
      if ($(id).value) qs.set(key, $(id).value);
    }
    const d = await api(`/api/audit?${qs}`);
    if ($('auditUser').options.length <= 1) {
      $('auditUser').insertAdjacentHTML('beforeend', d.users.map((u) => `<option>${esc(u)}</option>`).join(''));
      $('auditAction').insertAdjacentHTML('beforeend', Object.entries(d.actions).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''));
    }
    const sectionLabel = (t) => ENTITY_LABELS[t] || (Modules.has(t) ? Modules.meta(t).title : t);
    $('auditRows').innerHTML = d.items.map((it, i) => {
      const changes = it.details && typeof it.details === 'object' && it.action === 'update'
        ? Object.entries(it.details).map(([k, [a, b]]) => `<li><b>${esc(k)}:</b> <s>${esc(a || '—')}</s> ← ${esc(b || '—')}</li>`).join('')
        : '';
      return `<li class="a-${it.action}" style="animation-delay:${Math.min(i, 15) * 20}ms">
        <span class="a-icon">${icon(ACTION_ICON[it.action] || 'file', 'icon-sm')}</span>
        <div class="a-body">
          <div class="a-head"><strong>${esc(it.user_name || '—')}</strong>
            <span class="pill neutral">${esc(it.actionLabel)}</span>
            ${it.entity_type ? `<span class="muted">${esc(sectionLabel(it.entity_type))}</span>` : ''}
            <time class="muted">${esc(fmtDateTime(it.created_at))}</time></div>
          <p>${esc(it.summary)}</p>
          ${changes ? `<ul class="a-changes">${changes}</ul>` : ''}
        </div>
      </li>`;
    }).join('');
    $('auditEmpty').hidden = d.items.length > 0;
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    $('auditInfo').textContent = `${fmt(d.total)} عملية · صفحة ${fmt(d.page)} من ${fmt(pages)}`;
    $('auditPrev').disabled = d.page <= 1;
    $('auditNext').disabled = d.page >= pages;
  }

  let t;
  for (const id of ['auditQ', 'auditUser', 'auditAction', 'auditFrom', 'auditTo']) {
    $(id).addEventListener(id === 'auditQ' ? 'input' : 'change', () => {
      clearTimeout(t);
      t = setTimeout(() => { audit.page = 1; showAudit(); }, 250);
    });
  }
  $('auditPrev').addEventListener('click', () => { audit.page -= 1; showAudit(); });
  $('auditNext').addEventListener('click', () => { audit.page += 1; showAudit(); });

  $('userTfaReset').addEventListener('click', async () => {
    const u = users.find((x) => x.id === $('userTfaReset').dataset.id);
    if (!u || !(await confirmDialog(`هيقدر ${u.full_name || u.username} يدخل بكلمة المرور بس، ويفعّل التحقق بخطوتين تاني من حسابه بالجوال الجديد.`,
      { title: 'إلغاء التحقق بخطوتين؟', ok: 'إلغاء التحقق' }))) return;
    try {
      await api(`/api/users/${u.id}/2fa/reset`, { method: 'POST' });
      toast('تم إلغاء التحقق بخطوتين للمستخدم');
      $('userTfa').hidden = true;
      showUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ---------- التحقق بخطوتين للمستخدم الحالي ----------

  const tfa = { step: 'status', data: null };
  const pwdField = (label = 'كلمة المرور الحالية') => `<label class="field"><span>${label}</span>
    <input class="input" name="password" type="password" autocomplete="current-password"></label>`;
  const codeField = (label = 'الرمز من التطبيق') => `<label class="field"><span>${label}</span>
    <input class="input tfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="000000"></label>`;
  const codesHtml = (codes) => `<p>احفظ الرموز دي في مكان آمن (اطبعها أو صوّرها). كل رمز يُستخدم مرة واحدة للدخول لو الجوال مش معاك.</p>
    <div class="tfa-codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`;

  function renderTfa() {
    const d = tfa.data || {};
    $('tfaError').hidden = true;
    const views = {
      status: () => (d.enabled
        ? [`<div class="tfa-status"><span class="pill valid">${icon('check', 'icon-sm')}مفعّل</span><span>متبقي ${fmt(d.recoveryLeft)} من 10 رموز احتياطية</span></div>
            <p>عند الدخول بيُطلب منك رمز من تطبيق التحقق على جوالك بعد كلمة المرور.</p>`,
          `<button class="btn btn-ghost danger-text" type="button" data-tfa="disable">إيقاف</button>
           <button class="btn btn-ghost" type="button" data-tfa="regen">رموز احتياطية جديدة</button>`]
        : [`<p>حماية إضافية لحسابك: حتى لو حد عرف كلمة المرور، مش هيقدر يدخل من غير الرمز اللي على جوالك.</p>
            <ol class="tfa-steps"><li>نزّل تطبيق <b>Google Authenticator</b> أو <b>Microsoft Authenticator</b> على جوالك.</li>
            <li>امسح كود QR اللي هيظهر.</li><li>اكتب الرمز المكوّن من 6 أرقام للتأكيد.</li></ol>`,
          `<button class="btn btn-ghost" type="button" data-close>إغلاق</button>
           <button class="btn btn-primary" type="button" data-tfa="password">تفعيل</button>`]),
      password: () => [pwdField(), `<button class="btn btn-ghost" type="button" data-tfa="status">رجوع</button>
        <button class="btn btn-primary" type="submit">متابعة</button>`],
      scan: () => [`<div class="tfa-qr">${d.qr}<div class="tfa-secret">${esc(d.secret)}</div></div>
          <p>امسح الكود من التطبيق، أو أضف الحساب يدويًا بالمفتاح المكتوب تحته.</p>${codeField()}`,
        `<button class="btn btn-ghost" type="button" data-tfa="status">إلغاء</button><button class="btn btn-primary" type="submit">تفعيل</button>`],
      codes: () => [codesHtml(d.codes), `<button class="btn btn-ghost" type="button" data-tfa="download">تنزيل كملف</button>
        <button class="btn btn-primary" type="button" data-tfa="status">حفظتها</button>`],
      disable: () => [`<p>لإيقاف التحقق بخطوتين اكتب كلمة المرور ورمز من التطبيق (أو رمز احتياطي).</p>${pwdField()}${codeField('الرمز من التطبيق أو رمز احتياطي')}`,
        `<button class="btn btn-ghost" type="button" data-tfa="status">رجوع</button><button class="btn btn-danger" type="submit">إيقاف</button>`],
      regen: () => [`<p>الرموز الاحتياطية القديمة هتتلغي وتتعمل 10 رموز جديدة.</p>${pwdField()}`,
        `<button class="btn btn-ghost" type="button" data-tfa="status">رجوع</button><button class="btn btn-primary" type="submit">إنشاء</button>`],
    };
    const [body, foot] = views[tfa.step]();
    $('tfaBody').innerHTML = body;
    $('tfaFoot').innerHTML = foot;
    $('tfaForm').querySelector('input')?.focus();
  }

  async function goTfa(step) {
    if (step === 'status') tfa.data = await api('/api/me/2fa');
    tfa.step = step;
    renderTfa();
  }

  $('tfaBtn').addEventListener('click', async () => {
    openModal($('tfaModal'));
    await goTfa('status');
  });

  $('tfaFoot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tfa]');
    if (!b) return;
    if (b.dataset.tfa === 'download') {
      const blob = new Blob([`رموز التحقق الاحتياطية - منصة الإقامات (${state.me.username})\r\n\r\n${tfa.data.codes.join('\r\n')}\r\n`], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'iqama-recovery-codes.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    goTfa(b.dataset.tfa);
  });

  $('tfaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = { password: f.password?.value, code: f.code?.value };
    try {
      if (tfa.step === 'password') {
        tfa.data = await api('/api/me/2fa/setup', { method: 'POST', body: JSON.stringify(body) });
        tfa.step = 'scan';
      } else if (tfa.step === 'scan') {
        const r = await api('/api/me/2fa/enable', { method: 'POST', body: JSON.stringify(body) });
        tfa.data = { codes: r.recoveryCodes };
        tfa.step = 'codes';
        toast('تم تفعيل التحقق بخطوتين');
      } else if (tfa.step === 'regen') {
        const r = await api('/api/me/2fa/recovery', { method: 'POST', body: JSON.stringify(body) });
        tfa.data = { codes: r.recoveryCodes };
        tfa.step = 'codes';
      } else if (tfa.step === 'disable') {
        await api('/api/me/2fa/disable', { method: 'POST', body: JSON.stringify(body) });
        toast('تم إيقاف التحقق بخطوتين');
        await goTfa('status');
        return;
      }
      renderTfa();
    } catch (err) {
      $('tfaError').querySelector('span').textContent = err.message;
      $('tfaError').hidden = false;
    }
  });

  // ---------- تغيير كلمة المرور ----------

  $('pwdBtn').addEventListener('click', () => {
    $('pwdForm').reset();
    $('pwdError').hidden = true;
    openModal($('pwdModal'));
  });

  $('pwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const showError = (msg) => {
      $('pwdError').querySelector('span').textContent = msg;
      $('pwdError').hidden = false;
    };
    if (f.elements.next.value !== f.elements.confirm.value) return showError('كلمتا المرور غير متطابقتين');
    try {
      await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ current: f.elements.current.value, next: f.elements.next.value }),
      });
      closeModal($('pwdModal'));
      toast('تم تغيير كلمة المرور');
    } catch (err) {
      showError(err.message);
    }
    return undefined;
  });

  return { showUsers, showAudit, openUser };
})();
