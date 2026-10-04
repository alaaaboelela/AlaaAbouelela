// إنشاء مستخدم أو تغيير كلمة مروره:
//   npm run create-user -- <اسم المستخدم> <كلمة المرور>
const { pool, migrate } = require('../src/db');
const { hashPassword } = require('../src/auth');

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password || password.length < 8) {
    console.error('الاستخدام: npm run create-user -- <اسم المستخدم> <كلمة مرور 8 أحرف على الأقل>');
    process.exitCode = 1;
    return;
  }
  await migrate();
  await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [username, hashPassword(password)],
  );
  console.log(`تم حفظ المستخدم: ${username}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
