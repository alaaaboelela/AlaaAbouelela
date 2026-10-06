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
        <td>${u.active ? `<span class="pill valid">${icon('check', 'icon-sm')}فعّال</span>` : '<span class="pill expired">موقوف</span>'}</td>
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
