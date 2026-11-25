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

  // ออเดอร์
  orderTtlMinutes: num(env.ORDER_TTL_MINUTES, 15),
  shopLineUrl: str(env.SHOP_LINE_URL),

  // ตรวจชื่อในเกม
  lookupApiUrl: str(env.LOOKUP_API_URL),
  lookupApiKey: str(env.LOOKUP_API_KEY),
  lookupMock: bool(env.LOOKUP_MOCK),

  // เติมอัตโนมัติผ่าน supplier
  supplierApiUrl: str(env.SUPPLIER_API_URL).replace(/\/+$/, ''),
  supplierApiKey: str(env.SUPPLIER_API_KEY),
};

config.isProduction = config.nodeEnv === 'production';
config.lookupEnabled = !!config.lookupApiUrl || config.lookupMock;
config.autoFulfill = !!(config.supplierApiUrl && config.supplierApiKey);

module.exports = config;
