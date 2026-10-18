// تكلفة تجديد الإقامة: تكلفة سنوية افتراضية للمنشأة (من الإعدادات)، ولكل موظف تكلفة خاصة اختيارية.
// الموظف السعودي (رقم الهوية يبدأ بـ 1) مالوش إقامة يجددها فتكلفته صفر.
const express = require('express');
const { getSetting, setSetting } = require('./db');
const audit = require('./audit');

// بنود تقديرية تعدّلها كل منشأة حسب وضعها (المقابل المالي 800 ر.س شهريًا = 9,600 سنويًا)
const ITEMS = [
  { key: 'iqama', label: 'رسوم الإقامة', default: 650 },
  { key: 'levy', label: 'المقابل المالي (رخصة العمل)', default: 9600 },
  { key: 'insurance', label: 'التأمين الطبي', default: 0 },
  { key: 'other', label: 'رسوم أخرى', default: 0 },
];

async function getCostItems() {
  let saved = {};
  try { saved = JSON.parse((await getSetting('renewal_costs')) || '{}'); } catch { /* تجاهل */ }
  return ITEMS.map((i) => ({ ...i, value: Number.isFinite(saved[i.key]) ? saved[i.key] : i.default }));
}

async function defaultCost() {
  return (await getCostItems()).reduce((s, i) => s + i.value, 0);
}

// تعبير SQL لتكلفة تجديد الموظف (alias = اسم جدول الإقامات في الاستعلام)
const costSql = (param, alias = 'residencies') => `(CASE WHEN ${alias}.iqama_number LIKE '1%' THEN 0
  ELSE COALESCE(${alias}.renewal_cost, ${param}::numeric) END)`;

const router = express.Router();

router.get('/costs', async (req, res) => {
  const items = await getCostItems();
  res.json({ items, total: items.reduce((s, i) => s + i.value, 0) });
});

router.put('/costs', async (req, res) => {
  const body = req.body || {};
  const before = await getCostItems();
  const next = {};
  for (const i of before) {
    const raw = body[i.key] === undefined ? i.value : Number(body[i.key]);
    if (!Number.isFinite(raw) || raw < 0 || raw > 1000000) return res.status(400).json({ error: `${i.label}: مبلغ غير صحيح` });
    next[i.key] = Math.round(raw * 100) / 100;
  }
  await setSetting('renewal_costs', JSON.stringify(next));
  const total = Object.values(next).reduce((s, v) => s + v, 0);
  const old = before.reduce((s, i) => s + i.value, 0);
  if (total !== old || before.some((i) => i.value !== next[i.key])) {
    audit.log(req, 'settings', 'settings', '', `تكلفة تجديد الإقامة السنوية: ${old} ← ${total} ر.س`);
  }
  const items = await getCostItems();
  return res.json({ items, total });
});

module.exports = { router, getCostItems, defaultCost, costSql, ITEMS };
