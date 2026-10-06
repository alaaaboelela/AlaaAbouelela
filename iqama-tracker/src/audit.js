// سجل العمليات: مين عمل إيه وإمتى
const { pool } = require('./db');

const ACTIONS = {
  create: 'إضافة',
  update: 'تعديل',
  delete: 'حذف',
  import: 'استيراد',
  upload: 'رفع مستند',
  login: 'تسجيل دخول',
  login_failed: 'محاولة دخول فاشلة',
  password: 'تغيير كلمة المرور',
  settings: 'تعديل الإعدادات',
};

function log(req, action, entityType, entityId, summary, details) {
  const user = req?.user?.name || req?.auditUser || '';
  pool.query(
    `INSERT INTO audit_log (user_name, action, entity_type, entity_id, summary, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [user, action, entityType || '', entityId == null ? '' : String(entityId), String(summary || '').slice(0, 500),
      details ? JSON.stringify(details) : null, req?.ip || ''],
  ).catch((err) => console.error('تعذر حفظ سجل العمليات:', err.message));
}

// الفرق بين قيمتين لسجل التعديل
function diff(before, after, labels = {}) {
  const changes = {};
  for (const [k, v] of Object.entries(after)) {
    const a = before?.[k] == null ? '' : String(before[k]);
    const b = v == null ? '' : String(v);
    if (a !== b) changes[labels[k] || k] = [a, b];
  }
  return changes;
}

module.exports = { log, diff, ACTIONS };
