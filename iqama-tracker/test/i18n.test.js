// اختبارات محرك الترجمة الإنجليزية (بدون متصفح: بنحمّل القاموس ونجرب الدالة مباشرة)
const test = require('node:test');
const assert = require('node:assert');

function loadEngine() {
  global.window = { I18N: { missing: new Set() } };
  global.document = { documentElement: {}, createTreeWalker: () => ({ nextNode: () => null }), addEventListener() {} };
  global.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 };
  global.MutationObserver = class { observe() {} };
  delete require.cache[require.resolve('../public/lang-en.js')];
  require('../public/lang-en.js');
  return window.I18N;
}

test('ترجمة النصوص الثابتة والمتغيرة', () => {
  const { t } = loadEngine();
  assert.equal(t('لوحة المتابعة'), 'Dashboard');
  assert.equal(t('  حفظ  '), '  Save  ');
  assert.equal(t('آخر إرسال:'), 'Last sent:');
  // المفرد والجمع
  assert.equal(t('1 يوم'), '1 day');
  assert.equal(t('12 يوم'), '12 days');
  assert.equal(t('منتهية منذ 3 يوم'), 'Expired 3 days ago');
  assert.equal(t('عرض 1–50 من 200 · صفحة 1 من 4'), 'Showing 1–50 of 200 · page 1 of 4');
  // متغير عربي جوه نمط بيتترجم هو كمان
  assert.equal(t('سنوية · 7 أيام'), 'Annual · 7 days');
  assert.equal(t('سطر 4: الاسم مطلوب'), 'Row 4: Name is required');
  // نمط عام زي "{a} يوم" ما يبلعش جملة كاملة
  assert.equal(t('سارية · باقي 91 يوم'), 'Valid · 91 days left');
  assert.equal(t('2,084 منها خلال الأسبوع القادم · 19,922 إقامة منتهية تحتاج تجديدًا'),
    '2,084 of them within the next week · 19,922 expired iqamas need renewal');
});

test('البيانات تفضل زي ما هي والاتجاه يتعدل', () => {
  const { t, missing } = loadEngine();
  assert.equal(t('سالم أحمد'), 'سالم أحمد');
  assert.ok(missing.has('سالم أحمد'));
  assert.equal(t('مصر · فرع جدة · مؤسسة النخبة'), 'Egypt · Jeddah branch · مؤسسة النخبة');
  assert.equal(t('2026-10-01'), '2026-10-01');
  // الأسهم في البيانات بتتقلب، وفي النص الإنجليزي مكتوبة صح
  assert.equal(t('2026-10-01 ← 2026-10-05'), '2026-10-01 → 2026-10-05');
  assert.equal(t('مدة التنبيه: 30 ← 60 يوم'), 'Alert period: 30 → 60 days');
  assert.equal(t('أ، ب'), 'أ, ب');
});

test('كل مفاتيح القاموس صالحة', () => {
  const src = require('fs').readFileSync(require.resolve('../public/lang-en.js'), 'utf8');
  const body = src.slice(src.indexOf('const DICT = {'), src.indexOf('// ---------- المحرك'));
  // كل متغير في الترجمة الإنجليزية لازم يكون موجود في المفتاح العربي
  for (const m of body.matchAll(/^\s*'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)',/gm)) {
    const keyVars = new Set([...m[1].matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
    for (const v of m[2].matchAll(/\{(\w+)(?::[^}]*)?\}/g)) {
      assert.ok(keyVars.has(v[1]), `"${m[1]}" ← {${v[1]}}`);
    }
  }
});
