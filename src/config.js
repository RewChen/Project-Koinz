// อ่านค่าตั้งค่าทั้งหมดจาก environment ที่เดียว
require('./env');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const str = (v, d = '') => (v === undefined || v === '' ? d : String(v).trim());
const num = (v, d) => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? d : n;
};
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
// ตัวเลขที่ต้องมากกว่า 0 (ค่าผิด/ติดลบ → ค่าเริ่มต้น)
const pos = (v, d) => {
  const n = num(v, d);
  return n > 0 ? n : d;
};
// ลิงก์ที่หน้าเว็บแสดงให้ลูกค้ากด: รับเฉพาะ https:// (ไม่มี user:pass) — ค่าอื่น (javascript:, http:, ข้อความ) = ไม่แสดง
const httpsUrl = (v) => {
  try {
    const u = new URL(str(v));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
};

const DEFAULT_ADMIN_PASSWORD = 'admin1234';

const config = {
  port: num(env.PORT, 3000),
  nodeEnv: str(env.NODE_ENV, 'development'),
  shopName: str(env.SHOP_NAME, 'Koinz'),
  promptPayId: str(env.PROMPTPAY_ID, '0812345678'),
  promptPayName: str(env.PROMPTPAY_NAME, 'ร้าน Koinz'),
  adminPassword: str(env.ADMIN_PASSWORD, DEFAULT_ADMIN_PASSWORD),
  adminPasswordSet: !!str(env.ADMIN_PASSWORD),
  dataDir: path.resolve(str(env.KOINZ_DATA_DIR, path.join(__dirname, '..', 'data'))),
  // ตั้ง = ใช้ PostgreSQL แทนไฟล์ JSON (เช่น postgres://koinz:รหัส@db:5432/koinz)
  databaseUrl: str(env.DATABASE_URL),

  // ออเดอร์
  orderTtlMinutes: num(env.ORDER_TTL_MINUTES, 15),
  shopLineUrl: httpsUrl(env.SHOP_LINE_URL),

  // ข้อมูลร้าน (หน้าเกี่ยวกับร้าน / นโยบายคืนเงิน) — เป็นข้อมูลเปิดเผย ส่งออกใน /api/config ใต้ key shop
  shopLineId: str(env.SHOP_LINE_ID).slice(0, 60),
  shopFacebookUrl: httpsUrl(env.SHOP_FACEBOOK_URL),
  shopFacebookName: str(env.SHOP_FACEBOOK_NAME).slice(0, 100),
  shopHours: str(env.SHOP_HOURS).slice(0, 100),
  shopLegalName: str(env.SHOP_LEGAL_NAME).slice(0, 150),
  shopDbdId: str(env.SHOP_DBD_ID).slice(0, 40),
  fulfillTargetMinutes: pos(env.FULFILL_TARGET_MINUTES, 15),
  refundHours: pos(env.REFUND_HOURS, 24),
  stuckOrderHours: pos(env.STUCK_ORDER_HOURS, 1),

  // ตรวจชื่อในเกม
  lookupApiUrl: str(env.LOOKUP_API_URL),
  lookupApiKey: str(env.LOOKUP_API_KEY),
  lookupMock: bool(env.LOOKUP_MOCK),

  // ยืนยันการชำระเงินอัตโนมัติ
  paymentWebhookSecret: str(env.PAYMENT_WEBHOOK_SECRET),

  // เติมอัตโนมัติผ่าน supplier
  supplierApiUrl: str(env.SUPPLIER_API_URL).replace(/\/+$/, ''),
  supplierApiKey: str(env.SUPPLIER_API_KEY),
  fulfillAttempts: Math.max(1, Math.floor(num(env.FULFILL_ATTEMPTS, 3))),
  fulfillRetryBaseSeconds: Math.max(0, num(env.FULFILL_RETRY_BASE_SECONDS, 3)),

  // แจ้งเตือนแอดมิน (Discord / Slack webhook)
  adminAlertWebhook: str(env.ADMIN_ALERT_WEBHOOK),

  // ความปลอดภัย / deploy
  frontendOrigins: str(env.FRONTEND_ORIGIN)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  trustProxy: parseTrustProxy(str(env.TRUST_PROXY)),
  rateLimitOff: bool(env.RATE_LIMIT_OFF),
  // ข้อความแถบเหลืองบนสุดของทุกหน้า (ใช้ใน staging) เว้นว่าง = ไม่แสดง
  siteBanner: str(env.SITE_BANNER).slice(0, 200),

  // ระบบสมาชิก
  // ใช้ทำ HMAC ของ IP ใน session — production ต้องตั้ง ≥32 ตัว, เครื่อง dev ไม่ตั้ง = สุ่มใหม่ทุกครั้งที่ start
  sessionSecret: str(env.SESSION_SECRET),
  termsVersion: str(env.TERMS_VERSION, '2026-11').slice(0, 40),
  lineLoginEnabled: bool(env.LINE_LOGIN_ENABLED), // เฟสถัดไป — ตอนนี้แค่ซ่อน/แสดงปุ่ม

  // อีเมล (ลืมรหัสผ่าน / แจ้งเตือนเปลี่ยนรหัส): resend | log | ว่าง = ปิด
  mailProvider: str(env.MAIL_PROVIDER).toLowerCase(),
  resendApiKey: str(env.RESEND_API_KEY),
  resendApiUrl: str(env.RESEND_API_URL, 'https://api.resend.com').replace(/\/+$/, ''),
  mailFrom: str(env.MAIL_FROM),
  mailLogLinks: bool(env.MAIL_LOG_LINKS),
  // URL หน้าเว็บที่ใช้ในลิงก์ทางอีเมล — ไม่ใช้ Host header เพราะคนนอกปลอมได้
  // ไม่ตั้ง → ใช้โดเมนที่ Railway ให้ (RAILWAY_PUBLIC_DOMAIN) / เครื่อง dev ใช้ http://localhost:<PORT>
  publicUrl: str(env.PUBLIC_URL).replace(/\/+$/, ''),
  railwayPublicDomain: str(env.RAILWAY_PUBLIC_DOMAIN),
};

// TRUST_PROXY: ว่าง = ไม่ตั้ง, ตัวเลข = จำนวน proxy, true/false, หรือค่าอื่นของ Express เช่น loopback
function parseTrustProxy(v) {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

config.isProduction = config.nodeEnv === 'production';
config.lookupEnabled = !!config.lookupApiUrl || config.lookupMock;
config.autoFulfill = !!(config.supplierApiUrl && config.supplierApiKey);
config.webhookEnabled = !!config.paymentWebhookSecret;
config.sessionSecretSet = !!config.sessionSecret;
if (!config.sessionSecret) config.sessionSecret = crypto.randomBytes(32).toString('base64url');
if (!config.publicUrl && config.railwayPublicDomain) config.publicUrl = `https://${config.railwayPublicDomain}`;
if (!config.publicUrl && !config.isProduction) config.publicUrl = `http://localhost:${config.port || 3000}`;
// staging = production ที่ตั้ง SITE_BANNER ไว้ (เป็นที่เดียวที่ยอมให้เขียนลิงก์รีเซ็ตลง log)
config.isStaging = config.isProduction && !!config.siteBanner;
config.mailReady =
  (config.mailProvider === 'resend' && !!(config.resendApiKey && config.mailFrom)) ||
  (config.mailProvider === 'log' && config.mailLogLinks);
// หน้าเว็บโชว์ "ลืมรหัสผ่าน?" เฉพาะเมื่อส่งลิงก์ถึงลูกค้าได้จริง
config.passwordResetEnabled = config.mailReady && !!config.publicUrl;

// ปัญหาที่ทำให้ไม่ควร start บน production
config.startupProblems = () => {
  const problems = [];
  if (config.isProduction) {
    const weak = ['admin1234', 'change-me-please'];
    if (!config.adminPasswordSet || weak.includes(config.adminPassword) || config.adminPassword.length < 12) {
      problems.push('ADMIN_PASSWORD ต้องตั้งเอง และยาวอย่างน้อย 12 ตัวอักษร (ห้ามใช้ค่าตัวอย่าง)');
    }
    if (!config.sessionSecretSet || config.sessionSecret.length < 32) {
      problems.push('SESSION_SECRET ต้องตั้งเอง และยาวอย่างน้อย 32 ตัวอักษร (สุ่มด้วย node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))")');
    }
    if (config.mailLogLinks && !config.siteBanner) {
      problems.push('MAIL_LOG_LINKS=1 ใช้ได้เฉพาะเว็บทดสอบ (ต้องตั้ง SITE_BANNER ด้วย) — เว็บจริงห้ามเขียนลิงก์รีเซ็ตรหัสลง log');
    }
  }
  if (config.mailProvider && !['resend', 'log'].includes(config.mailProvider)) {
    problems.push(`MAIL_PROVIDER ต้องเป็น resend, log หรือเว้นว่าง (ตอนนี้: ${config.mailProvider})`);
  }
  if (config.mailProvider === 'resend' && !(config.resendApiKey && config.mailFrom)) {
    problems.push('MAIL_PROVIDER=resend ต้องตั้ง RESEND_API_KEY และ MAIL_FROM ด้วย');
  }
  return problems;
};

module.exports = config;
