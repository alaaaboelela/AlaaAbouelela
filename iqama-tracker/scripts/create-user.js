// إنشاء مستخدم أو تغيير كلمة مروره:
//   npm run create-user -- <اسم المستخدم> <كلمة المرور>
const { pool, migrate, describeDbError } = require('../src/db');
const { hashPassword } = require('../src/auth');

async function main() {
  const [username, password, role = 'admin'] = process.argv.slice(2);
  const { ROLES } = require('../src/permissions');
  if (!username || !password || password.length < 8 || !ROLES[role]) {
    console.error(`الاستخدام: npm run create-user -- <اسم المستخدم> <كلمة مرور 8 أحرف على الأقل> [${Object.keys(ROLES).join('|')}]`);
    process.exitCode = 1;
    return;
  }
  await migrate();
  await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true`,
    [username, hashPassword(password), role],
  );
  console.log(`تم حفظ المستخدم: ${username}`);
}

main()
  .catch((err) => {
    console.error('خطأ:', describeDbError(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
