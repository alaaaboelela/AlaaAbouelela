const path = require('path');
const express = require('express');
const config = require('./config');
const { migrate } = require('./db');
const auth = require('./auth');
const { router: residencies } = require('./residencies');
const { router: modules } = require('./crud');
const alerts = require('./alerts');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '100kb' }));

  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);

  app.use('/api', auth.requireAuth);
  app.get('/api/me', (req, res) => res.json({
    username: req.user.name,
    emailEnabled: alerts.emailEnabled(),
    alertEmails: config.alertEmails,
  }));
  app.use('/api', residencies);
  app.use('/api', modules);

  app.get('/api/alerts', async (req, res) => {
    res.json({ ...(await alerts.collectAlerts()), emailEnabled: alerts.emailEnabled() });
  });
  app.post('/api/alerts/send-email', async (req, res) => {
    try {
      res.json(await alerts.sendAlertEmail());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON غير صالح' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'الملف كبير جدا' });
    console.error(err);
    return res.status(500).json({ error: 'خطأ في الخادم' });
  });

  return app;
}

if (require.main === module) {
  migrate()
    .then(() => {
      createApp().listen(config.port, () => {
        console.log(`نظام الإقامات يعمل على http://localhost:${config.port}`);
        alerts.startScheduler();
      });
    })
    .catch((err) => {
      console.error('تعذر الاتصال بقاعدة البيانات:', err.message);
      process.exit(1);
    });
}

module.exports = { createApp };
