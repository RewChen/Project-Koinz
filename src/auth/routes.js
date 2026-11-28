// API สมาชิก (/api/auth/*, /api/me/*) — ทุก route: ห้าม cache, กัน CSRF, โหลด session จาก cookie
const security = require('../security');
const catalog = require('../catalog');
const session = require('./session');
const members = require('./members');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const HOUR = 60 * 60 * 1000;
const limits = {
  reset: security.rateLimit('reset', 20, HOUR),
  sensitive: security.rateLimit('me-sensitive', 10, HOUR), // เปลี่ยนรหัส / ลบบัญชี (ต้องพิมพ์รหัส)
  claim: security.rateLimit('claim', 20),
};

function sendAuthError(res, e) {
  if (!(e instanceof members.AuthError)) throw e;
  if (e.extra.retryAfter) res.set('Retry-After', String(e.extra.retryAfter));
  return res.status(e.status).json({ error: e.message, ...e.extra });
}

// เรียก fn ถ้า throw AuthError → ตอบ error ให้เอง แล้วคืน undefined
async function attempt(res, fn) {
  try {
    return { value: await fn() };
  } catch (e) {
    sendAuthError(res, e);
    return null;
  }
}

function requireMember(req, res, next) {
  if (!req.member) return res.status(401).json({ error: members.MSG.loginRequired });
  next();
}

function mount(app) {
  app.use(['/api/auth', '/api/me'], security.noStore, security.sameOriginOnly, session.middleware);

  // ---------- สมัคร / เข้า / ออก ----------
  app.post('/api/auth/signup', security.limits.signup, wrap(async (req, res) => {
    const b = req.body || {};
    const r = await attempt(res, () =>
      members.signup({ email: b.email, password: b.password, acceptTerms: b.acceptTerms, marketing: b.marketing }));
    if (!r) return;
    await session.start(req, res, r.value.id);
    res.status(201).json(members.publicUser(r.value));
  }));

  app.post('/api/auth/login', security.limits.memberLogin, wrap(async (req, res) => {
    const b = req.body || {};
    const r = await attempt(res, () => members.login({ email: b.email, password: b.password }));
    if (!r) return;
    await session.start(req, res, r.value.id);
    res.json(members.publicUser(r.value));
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    await session.end(req, res);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout-all', requireMember, wrap(async (req, res) => {
    await members.logoutAll(req.member.user);
    session.clearCookie(res);
    res.json({ ok: true });
  }));

  // ---------- ลืมรหัส / ตั้งรหัสใหม่ ----------
  app.post('/api/auth/forgot', security.limits.forgot, wrap(async (req, res) => {
    const r = await attempt(res, () => members.requestPasswordReset((req.body || {}).email));
    if (!r) return;
    res.json({ ok: true, message: members.MSG.forgotSent }); // เหมือนกันทุก byte ไม่ว่ามีบัญชีหรือไม่
  }));

  app.get('/api/auth/reset/:token', limits.reset, wrap(async (req, res) => {
    const user = await members.findResetUser(req.params.token);
    if (!user) return res.status(404).json({ valid: false, error: members.MSG.resetInvalid });
    res.json({ valid: true, email: user.email });
  }));

  app.post('/api/auth/reset', limits.reset, wrap(async (req, res) => {
    const b = req.body || {};
    const r = await attempt(res, () =>
      members.resetPassword({ token: b.token, password: b.password, logoutOthers: b.logoutOthers }));
    if (!r) return;
    await session.start(req, res, r.value.id); // ล็อกอินให้เลย (session ใหม่)
    res.json(members.publicUser(r.value));
  }));

  // ---------- บัญชีของฉัน ----------
  app.get('/api/me', requireMember, wrap(async (req, res) => {
    const { user } = req.member;
    res.json({ ...members.publicUser(user), sessionCount: await session.countActive(user.id) });
  }));

  app.post('/api/me/password', requireMember, limits.sensitive, wrap(async (req, res) => {
    const b = req.body || {};
    const r = await attempt(res, () =>
      members.changePassword(req.member.user, req.member.session.id, {
        currentPassword: b.currentPassword, newPassword: b.newPassword,
      }));
    if (!r) return;
    res.json({ ok: true });
  }));

  app.post('/api/me/delete', requireMember, limits.sensitive, wrap(async (req, res) => {
    const r = await attempt(res, () => members.deleteAccount(req.member.user, (req.body || {}).password));
    if (!r) return;
    session.clearCookie(res);
    res.json({ ok: true });
  }));

  app.get('/api/me/orders', requireMember, wrap(async (req, res) => {
    res.json(await members.listOrders(req.member.user));
  }));

  app.post('/api/me/orders/claim', requireMember, limits.claim, wrap(async (req, res) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : body && body.orders;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' });
    res.json({ claimed: await members.claimOrders(req.member.user, items) });
  }));

  app.get('/api/me/players', requireMember, wrap(async (req, res) => {
    res.json(await members.listPlayers(req.member.user));
  }));

  app.get('/api/me/players/:gameSlug', requireMember, wrap(async (req, res) => {
    const p = (await members.listPlayers(req.member.user)).find((x) => x.gameSlug === req.params.gameSlug);
    if (!p) return res.status(404).json({ error: 'ยังไม่ได้บันทึก UID ของเกมนี้' });
    res.json(p);
  }));

  app.delete('/api/me/players/:gameSlug', requireMember, wrap(async (req, res) => {
    if (!(await members.deletePlayer(req.member.user, req.params.gameSlug))) {
      return res.status(404).json({ error: 'ยังไม่ได้บันทึก UID ของเกมนี้' });
    }
    res.json({ ok: true });
  }));
}

// POST /api/orders ตอนล็อกอินอยู่: จำ UID ของเกมนั้นไว้ในบัญชี
async function rememberPlayer(req, game, inputs) {
  if (!req.member) return;
  await members.savePlayer(req.member.user.id, game.slug, inputs, catalog.playerLabel(game, inputs));
}

module.exports = { mount, requireMember, rememberPlayer };
