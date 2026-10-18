// استعادة نسخة احتياطية نزلت من الإعدادات (تمسح البيانات الحالية):
//   npm run restore -- <ملف النسخة.zip> [--yes] [--no-files]
// أوقفي البرنامج قبلها (sudo systemctl stop iqama) وشغّليه بعدها.
const fs = require('fs');
const readline = require('readline/promises');
const { pool, migrate, describeDbError } = require('../src/db');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file || !fs.existsSync(file)) {
    console.error('الاستخدام: npm run restore -- <ملف النسخة.zip> [--yes] [--no-files]');
    process.exitCode = 1;
    return;
  }
  const { restoreBackup } = require('../src/backup');
  const audit = require('../src/audit');

  if (!args.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('الاستعادة هتمسح كل البيانات الحالية وتحط مكانها بيانات النسخة. اكتبي "نعم" للمتابعة: ');
    rl.close();
    if (!['نعم', 'yes', 'y'].includes(answer.trim().toLowerCase())) {
      console.log('تم الإلغاء');
      return;
    }
  }

  await migrate();
  const result = await restoreBackup(fs.readFileSync(file), { files: !args.includes('--no-files') });
  const rows = Object.values(result.tables).reduce((a, b) => a + b, 0);
  console.log(`تمت الاستعادة من نسخة ${result.manifest.createdAt}`);
  for (const [t, n] of Object.entries(result.tables)) console.log(`  ${t}: ${n}`);
  console.log(`  الملفات: ${result.files}`);
  audit.log({ auditUser: 'سكربت الاستعادة' }, 'restore', 'backup', '',
    `استعادة نسخة ${result.manifest.createdAt.slice(0, 10)} (${rows} سجل، ${result.files} ملف)`);
  await new Promise((r) => setTimeout(r, 300)); // انتظار حفظ سجل العمليات
}

main()
  .catch((err) => {
    console.error('خطأ:', describeDbError(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
