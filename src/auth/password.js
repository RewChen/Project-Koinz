// รหัสผ่านสมาชิก: scrypt + นโยบายตามแนว NIST 800-63B (ยาว 10–128, ไม่ใช่รหัสยอดนิยม, ไม่มีชื่ออีเมล)
// รูปแบบที่เก็บ: scrypt$N$r$p$saltB64$hashB64
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;
const MAX_N = 2 ** 17; // กันค่าที่เก็บไว้ผิดปกติจนกินหน่วยความจำ (≤ 128·N·r = 256 MB)
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

const MESSAGES = {
  tooShort: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_LENGTH} ตัว`,
  tooLong: `รหัสผ่านยาวได้ไม่เกิน ${MAX_LENGTH} ตัว`,
  common: 'รหัสผ่านนี้คนใช้กันบ่อย เดาง่าย ลองตั้งรหัสอื่น',
  hasEmail: 'รหัสผ่านต้องไม่มีชื่ออีเมลอยู่ในรหัส',
};

// ---------- รายการรหัสยอดนิยม ----------
// Docker mount volume ทับ /app/data ได้ จึงมีสำเนาใน /seed ด้วย (ดู Dockerfile)
const LIST_FILES = [
  path.join(__dirname, '..', '..', 'data', 'common-passwords.txt'),
  '/seed/common-passwords.txt',
];
function loadCommon() {
  for (const f of LIST_FILES) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const set = new Set();
    for (const line of text.split(/\r?\n/)) {
      const w = line.trim();
      if (w && !w.startsWith('#')) set.add(w.normalize('NFKC').toLowerCase());
    }
    if (set.size >= 1000) return { set, file: f };
  }
  throw new Error('ไม่พบ data/common-passwords.txt (ต้องมีรหัสยอดนิยมอย่างน้อย 1,000 คำ)');
}
const { set: COMMON, file: COMMON_FILE } = loadCommon();

const normalize = (pw) => String(pw ?? '').normalize('NFKC');
const length = (s) => [...s].length; // นับเป็นตัวอักษร (code point) ไม่ใช่ UTF-16

// ตรวจนโยบาย → ข้อความไทย หรือ null ถ้าผ่าน (frontend ใช้กฎเดียวกันแสดงแถบความปลอดภัย)
function checkPolicy(password, email = '') {
  const pw = normalize(password);
  const n = length(pw);
  if (n < MIN_LENGTH) return MESSAGES.tooShort;
  if (n > MAX_LENGTH) return MESSAGES.tooLong;
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return MESSAGES.common;
  const local = String(email).trim().toLowerCase().split('@')[0].normalize('NFKC');
  if (length(local) >= 3 && lower.includes(local)) return MESSAGES.hasEmail;
  return null;
}

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    // ต้องการหน่วยความจำ ≈ 128·N·r ไบต์ (N=2^15, r=8 → 32 MB) เผื่อไว้ 2 เท่า
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(normalize(password), salt, PARAMS);
  const { N, r, p } = PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parse(stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
  if (!m) return null;
  const [N, r, p] = [m[1], m[2], m[3]].map(Number);
  const salt = Buffer.from(m[4], 'base64');
  const hash = Buffer.from(m[5], 'base64');
  const powerOfTwo = N > 1 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N > MAX_N || r < 1 || r > 16 || p < 1 || p > 16 || hash.length < 16 || salt.length < 8) return null;
  return { N, r, p, salt, hash };
}

// → { ok, needsRehash } — needsRehash = ผ่านแล้วแต่พารามิเตอร์เก่า ให้ hash ใหม่ตอนล็อกอินสำเร็จ
async function verifyPassword(password, stored) {
  const parsed = parse(stored);
  if (!parsed) {
    await verifyDummy(password);
    return { ok: false, needsRehash: false };
  }
  const { N, r, p, salt, hash } = parsed;
  const key = await scrypt(normalize(password), salt, { N, r, p, keylen: hash.length });
  const ok = crypto.timingSafeEqual(key, hash);
  const needsRehash = ok && (N !== PARAMS.N || r !== PARAMS.r || p !== PARAMS.p || hash.length !== PARAMS.keylen);
  return { ok, needsRehash };
}

// ไม่พบบัญชี: ทำ scrypt กับ hash หลอกให้ใช้เวลาใกล้กับกรณีที่มีบัญชี (กันเดาอีเมลจากเวลาตอบ)
let dummy;
async function verifyDummy(password) {
  dummy = dummy || hashPassword(crypto.randomBytes(18).toString('base64'));
  const { salt, hash } = parse(await dummy);
  const key = await scrypt(normalize(password), salt, PARAMS);
  crypto.timingSafeEqual(key, hash);
  return false;
}

module.exports = {
  PARAMS,
  MIN_LENGTH,
  MAX_LENGTH,
  MESSAGES,
  checkPolicy,
  hashPassword,
  verifyPassword,
  verifyDummy,
  isCommon: (pw) => COMMON.has(normalize(pw).toLowerCase()),
  commonList: { file: COMMON_FILE, size: COMMON.size },
};
