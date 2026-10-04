const { pool, migrate, describeDbError } = require('../src/db');

migrate()
  .then(() => console.log('تم تجهيز قاعدة البيانات'))
  .catch((err) => {
    console.error('خطأ:', describeDbError(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
