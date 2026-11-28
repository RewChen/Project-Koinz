// ระบบสมาชิก: สมัคร / ล็อกอิน / กันเดารหัส / ลิงก์ตั้งรหัสใหม่
// หลักการ: ข้อความผิดพลาดไม่บอกว่ามีอีเมลนี้หรือไม่, ไม่เก็บ token ดิบ, audit ไม่มีรหัสผ่าน/token/อีเมลเต็ม
const crypto = require('crypto');
const config = require('../config');
const repo = require('../repo');
const password = require('./password');
const { sha256 } = require('./session');

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
  return e;
}

// สำหรับ log/audit: nan@example.com → n***@example.com
function maskEmail(e) {
  const [local = '', domain = ''] = String(e || '').split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

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
  publicUser,
  cleanup: () => repo.deleteStalePasswordResets(iso(Date.now())),
};
