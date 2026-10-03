// تعريف الأقسام (العقود، بطاقات السائقين، السيارات، السلف، العهد)
// كل قسم يصف حقوله وحالاته، والمحرك العام في crud.js يبني له الـ API تلقائيًا.

// شرط حالة مبني على تاريخ انتهاء: منتهي / قريب من الانتهاء / ساري
function expiryStatus(col, { p, today, alertEnd }, labels) {
  const t = p.add(today);
  const e = p.add(alertEnd);
  return `CASE WHEN ${col} < ${t}::date THEN 'expired'
               WHEN ${col} <= ${e}::date THEN 'expiring'
               ELSE '${labels}' END`;
}

const EVENT_TYPES = ['صيانة دورية', 'تغيير زيت', 'إصلاح', 'إطارات', 'حادث', 'فحص دوري', 'تجديد استمارة', 'تجديد تأمين', 'تحديث بيانات', 'أخرى'];
const CAR_STATUSES = ['في الخدمة', 'في الصيانة', 'متوقفة', 'مباعة'];
const CONTRACT_TYPES = ['تشغيل', 'توريد عمالة', 'خدمات', 'نقل', 'إيجار', 'صيانة', 'أخرى'];

const MODULES = {
  contracts: {
    label: 'العقود',
    singular: 'عقد',
    icon: 'contract',
    group: 'company',
    table: 'contracts',
    from: 'contracts t',
    fields: [
      { name: 'company_name', label: 'اسم الشركة', type: 'text', required: true, wide: true },
      { name: 'contract_number', label: 'رقم العقد', type: 'text', mono: true },
      { name: 'contract_type', label: 'نوع العقد', type: 'select', options: CONTRACT_TYPES },
      { name: 'start_date', label: 'تاريخ البداية', type: 'date' },
      { name: 'end_date', label: 'تاريخ الانتهاء', type: 'date', required: true },
      { name: 'value', label: 'قيمة العقد', type: 'money' },
      { name: 'contact_person', label: 'مسؤول التواصل', type: 'text' },
      { name: 'contact_phone', label: 'جوال التواصل', type: 'text', mono: true },
      { name: 'notes', label: 'ملاحظات', type: 'textarea' },
    ],
    extra: (ctx) => `(t.end_date - ${ctx.p.add(ctx.today)}::date) AS days_left`,
    status: (ctx) => expiryStatus('t.end_date', ctx, 'active'),
    statuses: {
      expiring: { label: 'ينتهي قريبًا', tone: 'expiring' },
      expired: { label: 'منتهي', tone: 'expired' },
      active: { label: 'ساري', tone: 'valid' },
    },
    search: ['t.company_name', 't.contract_number', 't.contract_type', 't.contact_person'],
    sort: 'end_date ASC, id ASC',
    columns: [
      { key: 'company_name', type: 'title', sub: 'contract_type' },
      { key: 'contract_number', label: 'رقم العقد', type: 'mono' },
      { key: 'value', label: 'القيمة', type: 'money' },
      { key: 'end_date', label: 'تاريخ الانتهاء', type: 'date' },
      { key: 'days_left', label: 'المتبقي', type: 'days' },
    ],
    title: 'company_name',
  },

  driver_cards: {
    label: 'بطاقات السائقين',
    singular: 'بطاقة سائق',
    icon: 'steering',
    group: 'people',
    table: 'driver_cards',
    from: 'driver_cards t JOIN residencies e ON e.id = t.employee_id',
    fields: [
      { name: 'employee_id', label: 'السائق (الموظف)', type: 'employee', required: true, wide: true },
      { name: 'card_number', label: 'رقم بطاقة السائق', type: 'text', required: true, mono: true },
      { name: 'license_number', label: 'رقم رخصة القيادة', type: 'text', mono: true },
      { name: 'issue_date', label: 'تاريخ الإصدار', type: 'date' },
      { name: 'expiry_date', label: 'تاريخ الانتهاء', type: 'date', required: true },
      { name: 'notes', label: 'ملاحظات', type: 'textarea' },
    ],
    extra: (ctx) => `e.name AS employee_name, e.iqama_number AS employee_iqama,
      (t.expiry_date - ${ctx.p.add(ctx.today)}::date) AS days_left`,
    status: (ctx) => expiryStatus('t.expiry_date', ctx, 'valid'),
    statuses: {
      expiring: { label: 'تنتهي قريبًا', tone: 'expiring' },
      expired: { label: 'منتهية', tone: 'expired' },
      valid: { label: 'سارية', tone: 'valid' },
    },
    search: ['e.name', 'e.iqama_number', 't.card_number', 't.license_number'],
    sort: 'expiry_date ASC, id ASC',
    columns: [
      { key: 'employee_name', type: 'person', sub: 'employee_iqama' },
      { key: 'card_number', label: 'رقم البطاقة', type: 'mono' },
      { key: 'license_number', label: 'رقم الرخصة', type: 'mono' },
      { key: 'expiry_date', label: 'تاريخ الانتهاء', type: 'date' },
      { key: 'days_left', label: 'المتبقي', type: 'days' },
    ],
    title: 'employee_name',
  },

  cars: {
    label: 'السيارات',
    singular: 'سيارة',
    icon: 'car',
    group: 'company',
    table: 'cars',
    from: `cars t
      LEFT JOIN residencies e ON e.id = t.driver_id
      LEFT JOIN LATERAL (
        SELECT next_service_date FROM car_events
        WHERE car_id = t.id AND next_service_date IS NOT NULL
        ORDER BY event_date DESC, id DESC LIMIT 1
      ) ns ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS events_count, COALESCE(sum(cost), 0) AS maintenance_cost
        FROM car_events WHERE car_id = t.id
      ) ev ON true`,
    fields: [
      { name: 'plate_number', label: 'رقم اللوحة', type: 'text', required: true, placeholder: 'أ ب ج 1234' },
      { name: 'make', label: 'الشركة المصنعة', type: 'text', placeholder: 'تويوتا' },
      { name: 'model', label: 'الموديل', type: 'text', placeholder: 'هايلكس' },
      { name: 'year', label: 'سنة الصنع', type: 'int', min: 1980, max: 2100 },
      { name: 'color', label: 'اللون', type: 'text' },
      { name: 'vin', label: 'رقم الهيكل', type: 'text', mono: true },
      { name: 'value', label: 'قيمة السيارة', type: 'money' },
      { name: 'purchase_date', label: 'تاريخ الشراء', type: 'date' },
      { name: 'driver_id', label: 'السائق', type: 'employee', wide: true },
      { name: 'registration_expiry', label: 'انتهاء الاستمارة', type: 'date' },
      { name: 'insurance_expiry', label: 'انتهاء التأمين', type: 'date' },
      { name: 'odometer', label: 'العداد (كم)', type: 'int' },
      { name: 'car_status', label: 'حالة السيارة', type: 'select', options: CAR_STATUSES, default: 'في الخدمة' },
      { name: 'notes', label: 'ملاحظات', type: 'textarea' },
    ],
    extra: () => `e.name AS driver_name, e.iqama_number AS driver_iqama,
      ns.next_service_date, ev.events_count, ev.maintenance_cost`,
    // تحتاج انتباه: استمارة أو تأمين أو صيانة قريبة/متأخرة
    status: ({ p, today, alertEnd }) => {
      const t = p.add(today);
      const e = p.add(alertEnd);
      return `CASE
        WHEN t.registration_expiry < ${t}::date OR t.insurance_expiry < ${t}::date THEN 'expired'
        WHEN t.registration_expiry <= ${e}::date OR t.insurance_expiry <= ${e}::date
          OR ns.next_service_date <= ${e}::date THEN 'attention'
        ELSE 'ok' END`;
    },
    statuses: {
      attention: { label: 'تحتاج متابعة', tone: 'expiring' },
      expired: { label: 'وثائق منتهية', tone: 'expired' },
      ok: { label: 'سليمة', tone: 'valid' },
    },
    search: ['t.plate_number', 't.make', 't.model', 't.vin', 'e.name'],
    sort: 'plate_number ASC, id ASC',
    columns: [
      { key: 'plate_number', type: 'plate', sub: ['make', 'model', 'year'] },
      { key: 'driver_name', label: 'السائق', type: 'text' },
      { key: 'value', label: 'القيمة', type: 'money' },
      { key: 'registration_expiry', label: 'الاستمارة', type: 'date' },
      { key: 'insurance_expiry', label: 'التأمين', type: 'date' },
      { key: 'next_service_date', label: 'الصيانة القادمة', type: 'date' },
    ],
    title: 'plate_number',
    // أي تعديل على هذه الحقول يُسجل تلقائيًا في سجل السيارة
    trackChanges: ['plate_number', 'value', 'driver_id', 'odometer', 'car_status', 'registration_expiry', 'insurance_expiry', 'color'],
    children: {
      events: {
        label: 'سجل الصيانة والتحديثات',
        table: 'car_events',
        fk: 'car_id',
        order: 'event_date DESC, id DESC',
        fields: [
          { name: 'event_date', label: 'التاريخ', type: 'date', required: true, defaultToday: true },
          { name: 'event_type', label: 'النوع', type: 'select', options: EVENT_TYPES, required: true },
          { name: 'cost', label: 'التكلفة', type: 'money' },
          { name: 'odometer', label: 'العداد (كم)', type: 'int' },
          { name: 'next_service_date', label: 'موعد الصيانة القادمة', type: 'date' },
          { name: 'description', label: 'التفاصيل', type: 'textarea' },
        ],
      },
    },
  },

  advances: {
    label: 'السلف',
    singular: 'سلفة',
    icon: 'wallet',
    group: 'people',
    table: 'advances',
    from: `advances t
      JOIN residencies e ON e.id = t.employee_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(amount), 0) AS paid FROM advance_payments WHERE advance_id = t.id
      ) pay ON true`,
    fields: [
      { name: 'employee_id', label: 'الموظف', type: 'employee', required: true, wide: true },
      { name: 'amount', label: 'مبلغ السلفة', type: 'money', required: true, positive: true },
      { name: 'issue_date', label: 'تاريخ الصرف', type: 'date', required: true, defaultToday: true },
      { name: 'monthly_installment', label: 'القسط الشهري', type: 'money' },
      { name: 'reason', label: 'السبب', type: 'text' },
      { name: 'notes', label: 'ملاحظات', type: 'textarea' },
    ],
    extra: () => `e.name AS employee_name, e.iqama_number AS employee_iqama,
      pay.paid, (t.amount - pay.paid) AS remaining`,
    status: () => `CASE WHEN pay.paid >= t.amount THEN 'settled' ELSE 'open' END`,
    statuses: {
      open: { label: 'قائمة', tone: 'expiring' },
      settled: { label: 'مسددة', tone: 'valid' },
    },
    search: ['e.name', 'e.iqama_number', 't.reason'],
    sort: 'issue_date DESC, id DESC',
    columns: [
      { key: 'employee_name', type: 'person', sub: 'employee_iqama' },
      { key: 'amount', label: 'المبلغ', type: 'money' },
      { key: 'issue_date', label: 'تاريخ الصرف', type: 'date' },
      { key: 'remaining', label: 'المتبقي', type: 'progress', of: 'amount' },
    ],
    title: 'employee_name',
    totals: { amount: 'sum(t.amount)', remaining: 'sum(t.amount - pay.paid)' },
    children: {
      payments: {
        label: 'الدفعات',
        table: 'advance_payments',
        fk: 'advance_id',
        order: 'paid_date DESC, id DESC',
        fields: [
          { name: 'paid_date', label: 'تاريخ السداد', type: 'date', required: true, defaultToday: true },
          { name: 'amount', label: 'المبلغ', type: 'money', required: true, positive: true },
          { name: 'note', label: 'ملاحظة', type: 'text' },
        ],
      },
    },
  },

  custody: {
    label: 'العهد',
    singular: 'عهدة',
    icon: 'box',
    group: 'people',
    table: 'custody',
    from: 'custody t JOIN residencies e ON e.id = t.employee_id',
    fields: [
      { name: 'employee_id', label: 'الموظف المستلم', type: 'employee', required: true, wide: true },
      { name: 'item_name', label: 'الصنف', type: 'text', required: true, placeholder: 'لابتوب، جوال، أدوات...' },
      { name: 'category', label: 'التصنيف', type: 'select', options: ['أجهزة', 'أدوات', 'مفاتيح', 'نقدية', 'ملابس ومعدات سلامة', 'أخرى'] },
      { name: 'serial_number', label: 'الرقم التسلسلي', type: 'text', mono: true },
      { name: 'quantity', label: 'الكمية', type: 'int', min: 1, default: 1 },
      { name: 'value', label: 'القيمة', type: 'money' },
      { name: 'handed_date', label: 'تاريخ التسليم', type: 'date', required: true, defaultToday: true },
      { name: 'returned_date', label: 'تاريخ الإرجاع', type: 'date' },
      { name: 'notes', label: 'ملاحظات', type: 'textarea' },
    ],
    extra: () => 'e.name AS employee_name, e.iqama_number AS employee_iqama',
    status: () => `CASE WHEN t.returned_date IS NULL THEN 'held' ELSE 'returned' END`,
    statuses: {
      held: { label: 'لدى الموظف', tone: 'expiring' },
      returned: { label: 'تم الإرجاع', tone: 'valid' },
    },
    search: ['e.name', 'e.iqama_number', 't.item_name', 't.serial_number'],
    sort: 'handed_date DESC, id DESC',
    columns: [
      { key: 'item_name', type: 'title', sub: 'category' },
      { key: 'employee_name', label: 'الموظف', type: 'text' },
      { key: 'serial_number', label: 'الرقم التسلسلي', type: 'mono' },
      { key: 'value', label: 'القيمة', type: 'money' },
      { key: 'handed_date', label: 'تاريخ التسليم', type: 'date' },
    ],
    title: 'item_name',
    totals: { value: "sum(t.value * t.quantity) FILTER (WHERE t.returned_date IS NULL)" },
  },
};

// نسخة آمنة للواجهة (بدون SQL)
function publicSchema() {
  const out = {};
  for (const [key, m] of Object.entries(MODULES)) {
    out[key] = {
      label: m.label,
      singular: m.singular,
      icon: m.icon,
      group: m.group,
      fields: m.fields,
      statuses: m.statuses,
      columns: m.columns,
      title: m.title,
      children: Object.fromEntries(Object.entries(m.children || {}).map(([k, c]) => [k, { label: c.label, fields: c.fields }])),
    };
  }
  return out;
}

module.exports = { MODULES, publicSchema };
