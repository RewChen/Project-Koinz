// Session สมาชิก: token สุ่มอยู่ใน cookie koinz_sid (HttpOnly) — ฐานข้อมูลเก็บแค่ sha256(token)
// แยกจาก session แอดมินเด็ดขาด (แอดมินใช้ Authorization: Bearer และเก็บในหน่วยความจำของ app.js)
const crypto = require('crypto');
const config = require('../config');
const repo = require('../repo');

const COOKIE = 'koinz_sid';
const DAY = 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * DAY; // นับจากล็อกอิน
const IDLE_MS = 14 * DAY; // ไม่ได้ใช้เกินนี้ = หมดอายุ
const TOUCH_MS = 60 * 1000; // อัปเดต last_seen_at ไม่เกินนาทีละครั้ง

const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ipHash = (ip) => crypto.createHmac('sha256', config.sessionSecret).update(String(ip || '')).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    ...(config.isProduction ? ['Secure'] : []),
  ].join('; ');
}
const setCookie = (res, token) => res.append('Set-Cookie', cookie(token, Math.floor(ABSOLUTE_MS / 1000)));
const clearCookie = (res) => res.append('Set-Cookie', cookie('', 0));

function readToken(req) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

// สร้าง session ใหม่เสมอ (กัน session fixation) แล้วตั้ง cookie — ลบ session เดิมของเบราว์เซอร์นี้ด้วยถ้ามี
async function start(req, res, userId) {
  const old = readToken(req);
  if (old) await repo.deleteSession(sha256(old));
  const token = newToken();
  const now = Date.now();
  await repo.createSession({
    id: sha256(token),
    userId,
    createdAt: iso(now),
    lastSeenAt: iso(now),
    expiresAt: iso(now + ABSOLUTE_MS),
    userAgent: String(req.get('user-agent') || '').slice(0, 200),
    ipHash: ipHash(req.ip),
  });
  setCookie(res, token);
  return token;
}

const isLive = (s, now) => Date.parse(s.expiresAt) > now && Date.parse(s.lastSeenAt) > now - IDLE_MS;

// middleware: ตั้ง req.member = { user, session } หรือ null (cookie เสีย/หมดอายุ → ลบทิ้ง)
async function load(req, res) {
  req.member = null;
  const token = readToken(req);
  if (!token) {
    if (parseCookies(req.headers.cookie)[COOKIE]) clearCookie(res);
    return null;
  }
  const id = sha256(token);
  const session = await repo.getSession(id);
  const now = Date.now();
  if (!session || !isLive(session, now)) {
    if (session) await repo.deleteSession(id);
    clearCookie(res);
    return null;
  }
  const user = await repo.getUser(session.userId);
  if (!user) {
    await repo.deleteSession(id);
    clearCookie(res);
    return null;
  }
  if (now - Date.parse(session.lastSeenAt) >= TOUCH_MS) {
    session.lastSeenAt = iso(now);
    await repo.touchSession(id, session.lastSeenAt);
  }
  req.member = { user, session };
  return req.member;
}

const middleware = (req, res, next) => load(req, res).then(() => next(), next);

async function end(req, res) {
  const token = readToken(req);
  if (token) await repo.deleteSession(sha256(token));
  clearCookie(res);
}

const timeWindow = (now = Date.now()) => ({ now: iso(now), idleCutoff: iso(now - IDLE_MS) });

module.exports = {
  COOKIE,
  ABSOLUTE_MS,
  IDLE_MS,
  sha256,
  newToken,
  ipHash,
  parseCookies,
  start,
  load,
  middleware,
  end,
  clearCookie,
  countActive: (userId) => repo.countActiveSessions(userId, timeWindow()),
  endAllFor: (userId, exceptSessionId = null) => repo.deleteUserSessions(userId, exceptSessionId),
  cleanup: () => repo.deleteStaleSessions(timeWindow()),
};
