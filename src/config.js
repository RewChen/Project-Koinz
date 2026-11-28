// อ่านค่าตั้งค่าทั้งหมดจาก environment ที่เดียว
require('./env');
const path = require('path');

const env = process.env;
const str = (v, d = '') => (v === undefined || v === '' ? d : String(v).trim());
const num = (v, d) => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? d : n;
};
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

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
  shopLineUrl: str(env.SHOP_LINE_URL),

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

// ปัญหาที่ทำให้ไม่ควร start บน production
config.startupProblems = () => {
  const problems = [];
  if (config.isProduction) {
    const weak = ['admin1234', 'change-me-please'];
    if (!config.adminPasswordSet || weak.includes(config.adminPassword) || config.adminPassword.length < 12) {
      problems.push('ADMIN_PASSWORD ต้องตั้งเอง และยาวอย่างน้อย 12 ตัวอักษร (ห้ามใช้ค่าตัวอย่าง)');
    }
  }
  return problems;
};

module.exports = config;
