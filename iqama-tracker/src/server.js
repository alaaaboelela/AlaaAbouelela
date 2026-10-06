const path = require('path');
const express = require('express');
const config = require('./config');
const { migrate, describeDbError } = require('./db');
const auth = require('./auth');
const { router: residencies } = require('./residencies');
const { router: modules } = require('./crud');
const alerts = require('./alerts');
const { router: users } = require('./users');
const { can, permissionsFor, ROLES } = require('./permissions');

// القسم المطلوب لكل مسار (null = متاح لأي مستخدم مسجّل)
function sectionFor(req) {
  const p = req.path;
  const m = p.match(/^\/m\/([a-z_]+)/);
  if (m) return m[1];
  if (/^\/(residencies|stats|employees|alerts)(\/|$)/.test(p)) return p.startsWith('/alerts/send-email') ? 'settings' : 'residencies';
  if (p === '/settings' && req.method !== 'GET') return 'settings';
  if (p === '/documents') return String(req.query.entity || 'unknown');
  return null;
}

// الفرع الحالي: المستخدم المربوط بفرع مقيّد به دائمًا، والباقي يختار من الواجهة (X-Branch أو ?branch=)
function scopeBranch(req, res, next) {
  if (req.user.branchId) {
    req.branch = req.user.branchId;
    req.branchLocked = true;
  } else {
    const v = String(req.get('X-Branch') || req.query.branch || '');
    req.branch = /^\d{1,18}$/.test(v) ? v : null;
    req.branchLocked = false;
  }
  next();
}

function authorize(req, res, next) {
  const section = sectionFor(req);
  if (!section) return next();
  const mode = req.method === 'GET' ? 'read' : 'write';
  return can(req.user, section, mode) ? next() : res.status(403).json({ error: 'ليس لديك صلاحية لهذا الإجراء' });
}

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
  app.use('/api', scopeBranch);
  app.use('/api', authorize);
  app.get('/api/me', (req, res) => res.json({
    id: String(req.user.id),
    username: req.user.name,
    fullName: req.user.fullName,
    role: req.user.role,
    roleLabel: ROLES[req.user.role]?.label || req.user.role,
    permissions: permissionsFor(req.user.role),
    branch: req.user.branchId ? { id: req.user.branchId, name: req.user.branchName } : null,
    emailEnabled: alerts.emailEnabled(),
    alertEmails: config.alertEmails,
  }));
  app.use('/api', users);
  app.use('/api', residencies);
  app.use('/api', modules);

  app.get('/api/alerts', async (req, res) => {
    res.json({ ...(await alerts.collectAlerts(req.branch)), emailEnabled: alerts.emailEnabled() });
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
      console.error('تعذر الاتصال بقاعدة البيانات:', describeDbError(err));
      process.exit(1);
    });
}

module.exports = { createApp };
