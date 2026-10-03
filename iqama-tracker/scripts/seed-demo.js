// بيانات تجريبية للعقود، بطاقات السائقين، السيارات، السلف، العهد: npm run seed-demo
const { pool, migrate } = require('../src/db');

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function main() {
  await migrate();
  const { rows: emps } = await pool.query('SELECT id FROM residencies ORDER BY random() LIMIT 60');
  if (emps.length < 20) throw new Error('أضف إقامات أولًا (npm run seed)');
  const emp = () => pick(emps).id;

  const companies = ['شركة المراعي', 'أرامكو السعودية', 'شركة الاتصالات السعودية', 'مجموعة بن لادن', 'شركة النهدي الطبية',
    'شركة سابك', 'بنده للتجزئة', 'شركة الخطوط السعودية للتموين', 'مجموعة الحكير', 'شركة جرير', 'شركة المياه الوطنية', 'هيئة النقل'];
  for (const [i, c] of companies.entries()) {
    await pool.query(
      `INSERT INTO contracts (company_name, contract_number, contract_type, start_date, end_date, value, contact_person, contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c, `C-2026-${String(i + 1).padStart(3, '0')}`, pick(['تشغيل', 'توريد عمالة', 'خدمات', 'نقل']),
        day(-rand(200, 600)), day(rand(-40, 400)), rand(12, 400) * 10000, pick(['أ. خالد', 'أ. فهد', 'أ. سارة', 'أ. نورة']),
        `05${rand(10000000, 99999999)}`],
    );
  }

  for (let i = 0; i < 18; i++) {
    await pool.query(
      `INSERT INTO driver_cards (employee_id, card_number, license_number, issue_date, expiry_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [emp(), `DC-${rand(100000, 999999)}`, `${rand(1000000000, 1999999999)}`, day(-rand(300, 700)), day(rand(-20, 500))],
    );
  }

  const cars = [['تويوتا', 'هايلكس'], ['تويوتا', 'كامري'], ['هيونداي', 'H1'], ['نيسان', 'باترول'], ['إيسوزو', 'NPR'],
    ['ميتسوبيشي', 'كانتر'], ['فورد', 'ترانزيت'], ['شيفروليه', 'تاهو'], ['تويوتا', 'لاندكروزر'], ['هيونداي', 'أكسنت']];
  const letters = ['أ ب ج', 'ر س ص', 'ط ع ق', 'ك ل م', 'ن هـ و', 'ب د ر'];
  for (const [make, model] of cars) {
    const { rows: [car] } = await pool.query(
      `INSERT INTO cars (plate_number, make, model, year, color, value, purchase_date, driver_id, registration_expiry, insurance_expiry, odometer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [`${pick(letters)} ${rand(1000, 9999)}`, make, model, rand(2018, 2025), pick(['أبيض', 'فضي', 'أسود', 'رمادي']),
        rand(45, 320) * 1000, day(-rand(200, 1500)), emp(), day(rand(-10, 360)), day(rand(5, 360)), rand(20, 180) * 1000],
    );
    for (let k = 0; k < rand(2, 5); k++) {
      await pool.query(
        `INSERT INTO car_events (car_id, event_date, event_type, description, cost, odometer, next_service_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin')`,
        [car.id, day(-rand(10, 300)), pick(['صيانة دورية', 'تغيير زيت', 'إصلاح', 'إطارات', 'فحص دوري']),
          pick(['', 'تغيير فلتر الزيت والهواء', 'تبديل الفحمات الأمامية', 'تغيير 4 إطارات', 'فحص شامل']),
          rand(15, 250) * 10, rand(20, 180) * 1000, k === 0 ? day(rand(-5, 90)) : null],
      );
    }
  }

  for (let i = 0; i < 14; i++) {
    const amount = rand(5, 60) * 100;
    const { rows: [adv] } = await pool.query(
      `INSERT INTO advances (employee_id, amount, issue_date, monthly_installment, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [emp(), amount, day(-rand(30, 240)), Math.round(amount / 5), pick(['ظروف عائلية', 'سفر', 'علاج', 'إيجار سكن', ''])],
    );
    const payments = rand(0, 5);
    for (let k = 0; k < payments; k++) {
      await pool.query('INSERT INTO advance_payments (advance_id, amount, paid_date, created_by) VALUES ($1, $2, $3, $4)',
        [adv.id, Math.round(amount / 5), day(-rand(1, 150)), 'admin']);
    }
  }

  const items = [['لابتوب Dell', 'أجهزة', 4200], ['جوال سامسونج', 'أجهزة', 1800], ['مفاتيح المستودع', 'مفاتيح', null],
    ['عدة صيانة كاملة', 'أدوات', 950], ['جهاز لاسلكي', 'أجهزة', 700], ['خوذة وسترة سلامة', 'ملابس ومعدات سلامة', 250],
    ['سلفة نقدية للمصروفات', 'نقدية', 2000], ['طابعة محمولة', 'أجهزة', 1300]];
  for (let i = 0; i < 16; i++) {
    const [name, cat, value] = pick(items);
    await pool.query(
      `INSERT INTO custody (employee_id, item_name, category, serial_number, quantity, value, handed_date, returned_date)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7)`,
      [emp(), name, cat, cat === 'أجهزة' ? `SN${rand(100000, 999999)}` : '', value, day(-rand(10, 400)),
        Math.random() < 0.3 ? day(-rand(1, 9)) : null],
    );
  }
  console.log('تمت إضافة البيانات التجريبية');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
