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
  // كوكي الدخول يُرسل عبر HTTPS فقط في الإنتاج؛ COOKIE_SECURE=false للتشغيل عبر http قبل ربط دومين
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
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
  // أرقام جوالات المسؤولين اللي يوصلهم التنبيه اليومي (SMS / واتساب)، مفصولة بفاصلة
  alertPhones: (process.env.ALERT_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean),
  sms: {
    // unifonic | taqnyat | twilio | webhook (فارغ = غير مفعّل)
    provider: (process.env.SMS_PROVIDER || '').toLowerCase(),
    sender: process.env.SMS_SENDER || '',
    unifonicAppSid: process.env.UNIFONIC_APP_SID || '',
    taqnyatToken: process.env.TAQNYAT_TOKEN || '',
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    webhookUrl: process.env.SMS_WEBHOOK_URL || '',
  },
  whatsapp: {
    // واتساب للأعمال الرسمي من Meta (WhatsApp Cloud API)
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    // الرسائل اللي بتبدأها الشركة لازم تكون قالب معتمد من Meta؛ القالب فيه متغير واحد {{1}} = نص الملخص
    template: process.env.WHATSAPP_TEMPLATE || '',
    language: process.env.WHATSAPP_LANG || 'ar',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  },
};

if (!config.sessionSecret) {
  if (isProduction) throw new Error('SESSION_SECRET مطلوب في وضع الإنتاج');
  config.sessionSecret = 'dev-only-secret-change-me';
}

module.exports = config;
