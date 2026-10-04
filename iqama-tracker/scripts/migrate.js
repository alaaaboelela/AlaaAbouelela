const { pool, migrate } = require('../src/db');

migrate()
  .then(() => console.log('تم تجهيز قاعدة البيانات'))
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
