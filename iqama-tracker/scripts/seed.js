// بيانات تجريبية لاختبار الأداء: npm run seed -- 100000
const { pool, migrate } = require('../src/db');

const FIRST = ['محمد', 'أحمد', 'علي', 'خالد', 'عمر', 'يوسف', 'إبراهيم', 'حسن', 'سارة', 'فاطمة', 'مريم', 'نور'];
const LAST = ['عبدالله', 'حسين', 'السيد', 'محمود', 'إسماعيل', 'رحمن', 'خان', 'سانتوس', 'كومار', 'نصر'];
const NATIONALITIES = ['مصر', 'الهند', 'باكستان', 'بنجلاديش', 'الفلبين', 'السودان', 'اليمن', 'الأردن', 'نيبال'];
const EMPLOYERS = ['شركة البناء الحديث', 'مؤسسة النخبة', 'شركة الخليج للتجارة', 'مستشفى الشفاء', 'مطاعم السعادة'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function main() {
  const count = Number(process.argv[2]) || 10000;
  await migrate();
  for (let i = 0; i < count; i += 5000) {
    const batch = [];
    for (let j = i; j < Math.min(count, i + 5000); j++) {
      const d = new Date();
      d.setDate(d.getDate() + Math.floor(Math.random() * 760) - 60);
      batch.push({
        name: `${pick(FIRST)} ${pick(LAST)}`,
        iqama: String(2000000000 + Math.floor(Math.random() * 999999999)),
        expiry: d.toISOString().slice(0, 10),
        nationality: pick(NATIONALITIES),
        employer: pick(EMPLOYERS),
      });
    }
    await pool.query(
      `INSERT INTO residencies (name, iqama_number, expiry_date, nationality, employer)
       SELECT name, iqama, expiry, nationality, employer
       FROM jsonb_to_recordset($1::jsonb) AS x(name text, iqama text, expiry date, nationality text, employer text)
       ON CONFLICT (iqama_number) DO NOTHING`,
      [JSON.stringify(batch)],
    );
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM residencies');
  console.log(`عدد الإقامات الآن: ${rows[0].n}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
