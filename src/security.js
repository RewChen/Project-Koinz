// ความปลอดภัย: rate limit ต่อ IP, security headers, CORS
const config = require('./config');

const buckets = new Map(); // `${name}:${ip}` -> { count, reset }

// ล้าง bucket ที่หมดอายุทุกนาที กันหน่วยความจำโต
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60000).unref();

// นับครั้งต่อ key → { ok, retryAfter (วินาที) } — ใช้ได้ทั้งต่อ IP และต่ออีเมล
function hit(key, max, windowMs = 60000) {
  if (config.rateLimitOff) return { ok: true, retryAfter: 0 };
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return { ok: b.count <= max, retryAfter: Math.ceil((b.reset - now) / 1000) };
}

const TOO_MANY = 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่';

function rateLimit(name, max, windowMs = 60000) {
  return (req, res, next) => {
    const r = hit(`${name}:${req.ip}`, max, windowMs);
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: TOO_MANY });
    }
    next();
  };
}

const HOUR = 60 * 60 * 1000;
const limits = {
  login: rateLimit('login', 5),
  createOrder: rateLimit('order', 20),
  lookup: rateLimit('lookup', 30),
  notify: rateLimit('notify', 10),
  // สมาชิก (ต่อ IP)
  memberLogin: rateLimit('member-login', 10),
  signup: rateLimit('signup', 5, HOUR),
  forgot: rateLimit('forgot', 10, HOUR),
};

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  });
  next();
}

// อนุญาตเฉพาะ origin ใน FRONTEND_ORIGIN (เช่น GitHub Pages)
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && config.frontendOrigins.includes(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
    });
    res.vary('Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
}

// กัน CSRF สำหรับ route ที่เปลี่ยนข้อมูลของสมาชิก (/api/auth/*, /api/me/*):
// ต้องเป็น JSON และ Origin ต้องเป็นโดเมนตัวเองหรืออยู่ใน FRONTEND_ORIGIN, Sec-Fetch-Site (ถ้ามี) ต้องไม่ใช่ cross-site
// (session cookie เป็น SameSite=Lax อยู่แล้ว ชั้นนี้กันซ้ำอีกรอบ)
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const BLOCKED = 'คำขอนี้ไม่ได้มาจากหน้าเว็บของร้าน กรุณาเปิดหน้าเว็บใหม่แล้วลองอีกครั้ง';

function sameOriginOnly(req, res, next) {
  if (SAFE_METHODS.includes(req.method)) return next();
  const deny = () => res.status(403).json({ error: BLOCKED });
  if (!req.is('application/json')) return deny();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'same-site') return deny();
  const origin = req.get('origin');
  if (!origin || origin === 'null') return deny();
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return deny();
  }
  if (host !== req.get('host') && !config.frontendOrigins.includes(origin.replace(/\/+$/, ''))) return deny();
  next();
}

// ข้อมูลสมาชิกห้ามถูก cache ที่ใดเลย
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

module.exports = { hit, TOO_MANY, rateLimit, limits, securityHeaders, cors, sameOriginOnly, noStore };
