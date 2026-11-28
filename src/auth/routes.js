// API สมาชิก (/api/auth/*, /api/me/*) — ทุก route: ห้าม cache, กัน CSRF, โหลด session จาก cookie
const security = require('../security');
const session = require('./session');
const members = require('./members');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sendAuthError(res, e) {
  if (!(e instanceof members.AuthError)) throw e;
  if (e.extra.retryAfter) res.set('Retry-After', String(e.extra.retryAfter));
  return res.status(e.status).json({ error: e.message, ...e.extra });
}

function requireMember(req, res, next) {
  if (!req.member) return res.status(401).json({ error: members.MSG.loginRequired });
  next();
}

function mount(app) {
  app.use(['/api/auth', '/api/me'], security.noStore, security.sameOriginOnly, session.middleware);

  app.post('/api/auth/signup', security.limits.signup, wrap(async (req, res) => {
    const b = req.body || {};
    let user;
    try {
      user = await members.signup({ email: b.email, password: b.password, acceptTerms: b.acceptTerms, marketing: b.marketing });
    } catch (e) {
      return sendAuthError(res, e);
    }
    await session.start(req, res, user.id);
    res.status(201).json(members.publicUser(user));
  }));

  app.post('/api/auth/login', security.limits.memberLogin, wrap(async (req, res) => {
    const b = req.body || {};
    let user;
    try {
      user = await members.login({ email: b.email, password: b.password });
    } catch (e) {
      return sendAuthError(res, e);
    }
    await session.start(req, res, user.id);
    res.json(members.publicUser(user));
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    await session.end(req, res);
    res.json({ ok: true });
  }));

  app.get('/api/me', requireMember, wrap(async (req, res) => {
    const { user } = req.member;
    res.json({ ...members.publicUser(user), sessionCount: await session.countActive(user.id) });
  }));
}

module.exports = { mount, requireMember };
