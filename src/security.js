// ความปลอดภัย: rate limit ต่อ IP, security headers, CORS
const config = require('./config');

const buckets = new Map(); // `${name}:${ip}` -> { count, reset }

// ล้าง bucket ที่หมดอายุทุกนาที กันหน่วยความจำโต
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60000).unref();

function rateLimit(name, max, windowMs = 60000) {
  return (req, res, next) => {
    if (config.rateLimitOff) return next();
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่' });
    }
    next();
  };
}

const limits = {
  login: rateLimit('login', 5),
  register: rateLimit('register', 5),
  createOrder: rateLimit('order', 20),
  lookup: rateLimit('lookup', 30),
  notify: rateLimit('notify', 10),
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

module.exports = { rateLimit, limits, securityHeaders, cors };
