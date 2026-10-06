// الأدوار والصلاحيات: لكل قسم قراءة (read) أو تعديل (write)

const SECTIONS = {
  residencies: 'الإقامات',
  driver_cards: 'بطاقات السائقين',
  employee_docs: 'مستندات الموظفين',
  visas: 'تأشيرات الخروج والعودة',
  leaves: 'الإجازات',
  advances: 'السلف',
  custody: 'العهد',
  evaluations: 'التقييمات',
  contracts: 'العقود',
  cars: 'السيارات',
  branches: 'الفروع',
  settings: 'الإعدادات',
  users: 'المستخدمين',
  audit: 'سجل العمليات',
};

const HR = ['residencies', 'driver_cards', 'employee_docs', 'visas', 'leaves', 'custody', 'evaluations'];
const DATA = Object.keys(SECTIONS).filter((s) => !['settings', 'users', 'audit'].includes(s));

const ROLES = {
  admin: { label: 'مدير النظام', write: Object.keys(SECTIONS), read: [] },
  hr: { label: 'موارد بشرية', write: HR, read: DATA },
  accountant: { label: 'محاسب', write: ['advances', 'contracts', 'custody', 'cars'], read: DATA },
  viewer: { label: 'مشاهد فقط', write: [], read: DATA },
};

function permissionsFor(role) {
  const r = ROLES[role] || ROLES.viewer;
  const out = {};
  for (const s of Object.keys(SECTIONS)) {
    out[s] = r.write.includes(s) ? 'write' : r.read.includes(s) ? 'read' : null;
  }
  return out;
}

function can(user, section, mode) {
  const level = permissionsFor(user?.role)[section];
  return mode === 'read' ? Boolean(level) : level === 'write';
}

module.exports = { SECTIONS, ROLES, permissionsFor, can };
