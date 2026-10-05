// تحميل ملف .env إن وجد
try {
  process.loadEnvFile();
} catch {
  // لا يوجد ملف .env
}

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  port: Number(process.env.PORT) || 3000,
  // بدون DATABASE_URL يعمل بقاعدة بيانات مدمجة في مجلد data/ (لا يحتاج تثبيت PostgreSQL)
  databaseUrl: process.env.DATABASE_URL || 'pglite://data/db',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  // "اليوم" يُحسب بتوقيت السعودية مهما كان توقيت الخادم
  timeZone: process.env.APP_TIMEZONE || 'Asia/Riyadh',
  isProduction,
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },
  alertEmails: (process.env.ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
  alertHour: Number(process.env.ALERT_HOUR ?? 8),
};

if (!config.sessionSecret) {
  if (isProduction) throw new Error('SESSION_SECRET مطلوب في وضع الإنتاج');
  config.sessionSecret = 'dev-only-secret-change-me';
}

module.exports = config;
