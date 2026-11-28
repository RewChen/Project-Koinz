// ระบบสมาชิก: สมัคร / ล็อกอิน / กันเดารหัส / ลิงก์ตั้งรหัสใหม่
// หลักการ: ข้อความผิดพลาดไม่บอกว่ามีอีเมลนี้หรือไม่, ไม่เก็บ token ดิบ, audit ไม่มีรหัสผ่าน/token/อีเมลเต็ม
const crypto = require('crypto');
const config = require('../config');
const repo = require('../repo');
const adapters = require('../adapters');
const security = require('../security');
const password = require('./password');
const session = require('./session');

const { sha256 } = session;

const MINUTE = 60 * 1000;
const LOCK = { max: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE };
const RESET_TTL_MS = 30 * MINUTE;
const MAX_INPUT = 1024; // รหัสยาวกว่านี้ไม่ต้อง hash (นโยบายรับแค่ 128)

const MSG = {
  badLogin: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง ตรวจแล้วลองใหม่อีกครั้ง',
  locked: 'ลองผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่ หรือกด "ลืมรหัสผ่าน?"',
  signupFailed: 'สมัครไม่สำเร็จ ถ้าเคยสมัครด้วยอีเมลนี้แล้ว ลองเข้าสู่ระบบหรือกดลืมรหัสผ่าน',
  badEmail: 'กรุณากรอกอีเมลให้ถูกต้อง',
  missing: 'กรุณากรอกอีเมลและรหัสผ่าน',
  terms: 'กรุณายอมรับเงื่อนไขการใช้งานและนโยบายความเป็นส่วนตัวก่อนสมัคร',
  loginRequired: 'กรุณาเข้าสู่ระบบ',
  forgotSent: 'ถ้าอีเมลนี้มีบัญชีกับร้าน เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว ลิงก์ใช้ได้ 30 นาที และใช้ได้ครั้งเดียว',
  resetDisabled: 'ระบบลืมรหัสผ่านยังไม่เปิดใช้งาน ติดต่อร้านทาง LINE เพื่อขอความช่วยเหลือ',
  resetInvalid: 'ลิงก์นี้ใช้ไม่ได้แล้ว ลิงก์หมดอายุ (เกิน 30 นาที) หรือถูกใช้ไปแล้ว ขอลิงก์ใหม่ได้เลย',
  wrongCurrent: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
  wrongPassword: 'รหัสผ่านไม่ถูกต้อง',
  samePassword: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม',
};

class AuthError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const iso = (ms) => new Date(ms).toISOString();

// trim + lowercase แล้วตรวจรูปแบบคร่าว ๆ → อีเมล หรือ null
function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  // กันชั้นที่ 2 (หน้าเว็บ esc() ทุกที่อยู่แล้ว): อีเมลจริงไม่มีอักขระ HTML/quote — เหมือน UID ใน catalog.validateInputs
  if (/[<>"'`\\]/.test(e)) return null;
  return e;
}

// สำหรับ log/audit: nan@example.com → n***@example.com
const { maskEmail } = adapters;

const audit = (action, user, extra = '') =>
  repo.appendAudit({
    at: iso(Date.now()),
    action,
    actor: 'member',
    note: [user ? `user ${user.id}` : '', extra].filter(Boolean).join(' · '),
  });

const lockedError = (until) => {
  const retryAfter = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000));
  return new AuthError(423, MSG.locked, { lockedUntil: until, retryAfter });
};

// อีเมลที่ไม่มีบัญชี: นับ/ล็อกในหน่วยความจำแบบเดียวกับบัญชีจริง เพื่อไม่ให้การล็อกบอกได้ว่ามีอีเมลนี้
const ghosts = new Map(); // sha256(email) -> { count, windowStart, lockedUntil }
setInterval(() => {
  const now = Date.now();
  for (const [k, g] of ghosts) {
    if ((g.lockedUntil || 0) <= now && g.windowStart <= now - LOCK.windowMs) ghosts.delete(k);
  }
}, MINUTE).unref();

function ghostLockedUntil(key, now) {
  const g = ghosts.get(key);
  return g && g.lockedUntil > now ? iso(g.lockedUntil) : null;
}
function ghostFailure(key, now) {
  let g = ghosts.get(key);
  if (!g || g.windowStart <= now - LOCK.windowMs) {
    if (!g && ghosts.size >= 10000) ghosts.delete(ghosts.keys().next().value);
    g = { count: 0, windowStart: now, lockedUntil: 0 };
    ghosts.set(key, g);
  }
  g.count += 1;
  if (g.count >= LOCK.max) {
    g.lockedUntil = now + LOCK.lockMs;
    g.count = 0;
    g.windowStart = 0;
    return iso(g.lockedUntil);
  }
  return null;
}

// ---------- สมัคร ----------
async function signup({ email: rawEmail, password: pw, acceptTerms, marketing } = {}) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthError(400, MSG.badEmail);
  if (acceptTerms !== true) throw new AuthError(400, MSG.terms);
  if (typeof pw !== 'string' || pw.length > MAX_INPUT) throw new AuthError(400, password.MESSAGES.tooLong);
  const problem = password.checkPolicy(pw, email);
  if (problem) throw new AuthError(400, problem);

  const now = iso(Date.now());
  const { user, created } = await repo.createUser({
    id: crypto.randomUUID(),
    email,
    passwordHash: await password.hashPassword(pw), // hash ก่อนเช็คซ้ำ ให้เวลาตอบใกล้กัน
    termsVersion: config.termsVersion,
    termsAcceptedAt: now,
    marketingOptIn: marketing === true,
    failedLogins: 0,
    failedWindowStartedAt: null,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  if (!created) {
    await audit('member_signup_failed', null, `${maskEmail(email)} มีบัญชีอยู่แล้ว`);
    throw new AuthError(409, MSG.signupFailed);
  }
  await audit('member_signup', user, maskEmail(email));
  return user;
}

// ---------- ล็อกอิน ----------
async function login({ email: rawEmail, password: pw } = {}) {
  const email = normalizeEmail(rawEmail);
  if (!email || typeof pw !== 'string' || !pw) throw new AuthError(400, MSG.missing);
  const now = Date.now();
  const user = await repo.findUserByEmail(email);

  if (!user) {
    const key = sha256(email);
    const locked = ghostLockedUntil(key, now);
    if (locked) throw lockedError(locked);
    await password.verifyDummy(pw.slice(0, MAX_INPUT));
    await audit('member_login_failed', null, `${maskEmail(email)} ไม่มีบัญชี`);
    const nowLocked = ghostFailure(key, now);
    if (nowLocked) throw lockedError(nowLocked);
    throw new AuthError(401, MSG.badLogin);
  }

  // ล็อกอยู่ → ไม่ตรวจรหัสเลย (ถึงรหัสถูกก็เข้าไม่ได้จนกว่าจะพ้นเวลา)
  if (user.lockedUntil && Date.parse(user.lockedUntil) > now) throw lockedError(user.lockedUntil);

  const { ok, needsRehash } =
    pw.length > MAX_INPUT ? { ok: await password.verifyDummy(pw.slice(0, MAX_INPUT)), needsRehash: false }
      : await password.verifyPassword(pw, user.passwordHash);
  if (!ok) {
    const r = await repo.recordLoginFailure(user.id, {
      now: iso(now),
      windowStart: iso(now - LOCK.windowMs),
      max: LOCK.max,
      lockUntil: iso(now + LOCK.lockMs),
    });
    await audit('member_login_failed', user, 'รหัสผ่านไม่ถูกต้อง');
    if (r.locked) {
      await audit('member_locked', user, `ล็อกถึง ${r.lockedUntil}`);
      throw lockedError(r.lockedUntil);
    }
    throw new AuthError(401, MSG.badLogin);
  }

  await repo.recordLoginSuccess(user.id, {
    now: iso(now),
    passwordHash: needsRehash ? await password.hashPassword(pw) : null,
  });
  await audit('member_login', user);
  return user;
}

// ---------- ลิงก์ตั้งรหัสผ่านใหม่ ----------
// คืน token ดิบ (ส่งทางอีเมลเท่านั้น) — ฐานข้อมูลเก็บแค่ sha256
async function createPasswordReset(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await repo.createPasswordReset({
    tokenHash: sha256(token),
    userId,
    createdAt: iso(now),
    expiresAt: iso(now + RESET_TTL_MS),
    usedAt: null,
  });
  return token;
}

const thaiTime = (ms) =>
  new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });

// แจ้งเจ้าของบัญชีเมื่อรหัสถูกเปลี่ยน (ไม่รอผล ไม่ให้การส่งอีเมลช้า/ล้มกระทบคำขอ)
function notifyPasswordChanged(user, how) {
  adapters.sendMail({
    to: user.email,
    subject: `รหัสผ่านของคุณถูกเปลี่ยนแล้ว — ${config.shopName}`,
    text: [
      `รหัสผ่านบัญชี ${config.shopName} ของคุณถูก${how}เมื่อ ${thaiTime(Date.now())}`,
      '',
      'ถ้าคุณทำเอง ไม่ต้องทำอะไรต่อ',
      `ถ้าไม่ได้ทำเอง ให้ตั้งรหัสผ่านใหม่ทันทีที่ ${config.publicUrl}/forgot.html และติดต่อร้าน`,
    ].join('\n'),
  });
}

// ลืมรหัส: ตอบเหมือนกันเสมอ — ไม่มีบัญชี / ขอถี่เกิน (ต่ออีเมล 3 ครั้ง/ชม. และเว้น 60 วิ) = ไม่ส่งเงียบ ๆ
async function requestPasswordReset(rawEmail) {
  if (!config.passwordResetEnabled) throw new AuthError(503, MSG.resetDisabled);
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AuthError(400, MSG.badEmail);
  const key = sha256(email);
  const gap = security.hit(`forgot-gap:${key}`, 1, MINUTE);
  const hourly = gap.ok ? security.hit(`forgot-email:${key}`, 3, 60 * MINUTE) : gap;
  if (!gap.ok || !hourly.ok) return;
  const user = await repo.findUserByEmail(email);
  if (!user) return;
  const token = await createPasswordReset(user.id);
  await audit('member_reset_requested', user);
  adapters.sendMail({
    to: user.email,
    subject: `ตั้งรหัสผ่านใหม่ — ${config.shopName}`,
    // token อยู่หลัง # → ไม่ถูกส่งไปกับ request จึงไม่ติดใน access log หรือ Referer
    text: [
      `มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี ${config.shopName} ของคุณ`,
      'กดลิงก์นี้ภายใน 30 นาที (ใช้ได้ครั้งเดียว):',
      `${config.publicUrl}/reset.html#token=${token}`,
      '',
      'ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ',
    ].join('\n'),
  });
}

const tokenShape = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

// ลิงก์ยังใช้ได้ไหม → user หรือ null (ไม่ consume)
async function findResetUser(token) {
  if (!tokenShape(token)) return null;
  const r = await repo.getPasswordReset(sha256(token));
  if (!r || r.usedAt || Date.parse(r.expiresAt) <= Date.now()) return null;
  return repo.getUser(r.userId);
}

// ตั้งรหัสใหม่จากลิงก์: ตรวจนโยบายก่อนใช้ token (รหัสไม่ผ่านแล้วลิงก์ยังใช้ต่อได้) → ใช้ครั้งเดียว → ลบลิงก์อื่น
async function resetPassword({ token, password: pw, logoutOthers }) {
  const user = await findResetUser(token);
  if (!user) throw new AuthError(400, MSG.resetInvalid, { resetInvalid: true });
  if (typeof pw !== 'string' || pw.length > MAX_INPUT) throw new AuthError(400, password.MESSAGES.tooLong);
  const problem = password.checkPolicy(pw, user.email);
  if (problem) throw new AuthError(400, problem);
  const passwordHash = await password.hashPassword(pw);
  const now = iso(Date.now());
  const used = await repo.consumePasswordReset(sha256(token), now);
  if (!used || used.userId !== user.id) throw new AuthError(400, MSG.resetInvalid, { resetInvalid: true });
  await repo.updateUserPassword(user.id, { now, passwordHash });
  await repo.deleteUserPasswordResets(user.id);
  const ended = logoutOthers === false ? 0 : await session.endAllFor(user.id);
  await audit('member_reset', user, `ออกจากระบบอุปกรณ์อื่น ${ended} เครื่อง`);
  notifyPasswordChanged(user, 'ตั้งใหม่ผ่านลิงก์ "ลืมรหัสผ่าน"');
  return user;
}

// ยืนยันรหัสปัจจุบันของคนที่ล็อกอินอยู่ (เปลี่ยนรหัส / ลบบัญชี)
async function confirmPassword(user, pw, message) {
  const fresh = await repo.getUser(user.id);
  if (!fresh || typeof pw !== 'string' || !pw || pw.length > MAX_INPUT) {
    await password.verifyDummy(String(pw || '').slice(0, MAX_INPUT));
    throw new AuthError(400, message);
  }
  const { ok } = await password.verifyPassword(pw, fresh.passwordHash);
  if (!ok) {
    await audit('member_confirm_failed', user);
    throw new AuthError(400, message);
  }
  return fresh;
}

// เปลี่ยนรหัส: ต้องรู้รหัสเดิม → ลบ session อื่นทั้งหมด (เหลือเครื่องนี้)
async function changePassword(user, sessionId, { currentPassword, newPassword }) {
  await confirmPassword(user, currentPassword, MSG.wrongCurrent);
  if (typeof newPassword !== 'string' || newPassword.length > MAX_INPUT) throw new AuthError(400, password.MESSAGES.tooLong);
  const problem = password.checkPolicy(newPassword, user.email);
  if (problem) throw new AuthError(400, problem);
  if (password.normalizeForCompare(newPassword) === password.normalizeForCompare(currentPassword)) {
    throw new AuthError(400, MSG.samePassword);
  }
  await repo.updateUserPassword(user.id, { now: iso(Date.now()), passwordHash: await password.hashPassword(newPassword) });
  await repo.deleteUserPasswordResets(user.id);
  const ended = await session.endAllFor(user.id, sessionId);
  await audit('member_password_changed', user, `ออกจากระบบอุปกรณ์อื่น ${ended} เครื่อง`);
  notifyPasswordChanged(user, 'เปลี่ยน');
}

async function logoutAll(user) {
  const ended = await session.endAllFor(user.id);
  await audit('member_logout_all', user, `${ended} เครื่อง`);
}

// ลบบัญชี (PDPA) — ต้องยืนยันด้วยรหัสผ่าน
async function deleteAccount(user, pw) {
  await confirmPassword(user, pw, MSG.wrongPassword);
  await repo.deleteUserAccount(user.id, iso(Date.now()));
  await audit('member_deleted', user);
}

// ---------- ออเดอร์ / UID ของสมาชิก ----------
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

// ออเดอร์ที่สั่งจากเครื่องนี้ก่อนล็อกอิน [{id, token}] → ผูกเฉพาะที่ token ถูกและยังไม่มีเจ้าของ
async function claimOrders(user, items) {
  const list = Array.isArray(items) ? items.slice(0, 50) : [];
  const claimed = [];
  for (const it of list) {
    if (!it || typeof it.id !== 'string' || typeof it.token !== 'string' || it.id.length > 40 || it.token.length > 100) continue;
    const order = await repo.getOrder(it.id);
    if (!order || order.userId || !safeEqual(order.token, it.token)) continue;
    if (await repo.claimOrder(order.id, user.id)) {
      claimed.push(order.id);
      await repo.appendAudit({ at: iso(Date.now()), orderId: order.id, action: 'member_claim', actor: 'member', note: `user ${user.id}` });
    }
  }
  return claimed;
}

// ออเดอร์ของสมาชิก: ไม่มี token / contact / LINE / หมายเหตุ
const memberOrderView = (o) => ({
  id: o.id,
  status: o.status,
  gameSlug: o.gameSlug,
  gameName: o.gameName,
  packageId: o.packageId,
  packageName: o.packageName,
  playerInputs: o.playerInputs,
  playerLabel: o.playerLabel,
  playerNickname: o.playerNickname,
  amount: o.amount,
  expiresAt: o.expiresAt,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

const savePlayer = (userId, gameSlug, inputs, label) =>
  repo.upsertSavedPlayer({ userId, gameSlug, inputs, label, updatedAt: iso(Date.now()) });

const playerView = (p) => ({ gameSlug: p.gameSlug, inputs: p.inputs, label: p.label, updatedAt: p.updatedAt });

// ข้อมูลที่ส่งให้หน้าเว็บ
const publicUser = (u) => ({ email: u.email, createdAt: u.createdAt });

module.exports = {
  LOCK,
  RESET_TTL_MS,
  MSG,
  AuthError,
  normalizeEmail,
  maskEmail,
  signup,
  login,
  createPasswordReset,
  requestPasswordReset,
  findResetUser,
  resetPassword,
  changePassword,
  logoutAll,
  deleteAccount,
  claimOrders,
  memberOrderView,
  savePlayer,
  playerView,
  listOrders: async (user) => (await repo.listOrdersByUser(user.id, 50)).map(memberOrderView),
  listPlayers: async (user) => (await repo.listSavedPlayers(user.id)).map(playerView),
  deletePlayer: (user, gameSlug) => repo.deleteSavedPlayer(user.id, gameSlug),
  publicUser,
  cleanup: () => repo.deleteStalePasswordResets(iso(Date.now())),
};
