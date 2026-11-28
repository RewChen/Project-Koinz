// เชื่อมต่อบริการภายนอก: ตรวจชื่อในเกม, supplier เติมเกม, แจ้งเตือนแอดมิน
const crypto = require('crypto');
const config = require('./config');

class AdapterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const lookupEnabled = () => config.lookupEnabled;

// ตรวจชื่อในเกม → { nickname, mock } หรือ throw AdapterError
async function lookupNickname(game, inputs) {
  if (config.lookupApiUrl) {
    let res;
    try {
      res = await fetch(config.lookupApiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.lookupApiKey ? { authorization: `Bearer ${config.lookupApiKey}` } : {}),
        },
        body: JSON.stringify({ game: game.slug, player: inputs }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new AdapterError(502, 'ตรวจชื่อในเกมไม่ได้ในขณะนี้ ลองใหม่ภายหลัง');
    }
    if (res.status === 404) throw new AdapterError(404, 'ไม่พบผู้เล่นนี้ ตรวจข้อมูลอีกครั้ง');
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || typeof data.nickname !== 'string' || !data.nickname.trim()) {
      throw new AdapterError(502, 'ตรวจชื่อในเกมไม่ได้ในขณะนี้ ลองใหม่ภายหลัง');
    }
    return { nickname: data.nickname.trim().slice(0, 64), mock: false };
  }

  if (config.lookupMock) {
    // ชื่อจำลองสำหรับทดสอบเท่านั้น — ได้เลขเดิมทุกครั้งสำหรับข้อมูลชุดเดิม
    const hash = crypto.createHash('sha256').update(game.slug + JSON.stringify(inputs)).digest();
    const n = String(hash.readUInt32BE(0) % 10000).padStart(4, '0');
    return { nickname: `ผู้เล่นทดสอบ ${n}`, mock: true };
  }

  throw new AdapterError(404, 'ระบบตรวจชื่อในเกมยังไม่เปิดใช้งาน');
}

// สั่งเติมผ่าน supplier → { supplierRef } หรือ throw Error (ข้อความเก็บใน job.lastError)
// ถือว่าสำเร็จเฉพาะเมื่อ supplier ตอบ 2xx และไม่ได้บอกว่ายังรอ/ล้มเหลว
async function fulfillTopup(order, sku) {
  let res;
  try {
    res = await fetch(`${config.supplierApiUrl}/topups`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.supplierApiKey}`,
        'idempotency-key': order.id,
      },
      body: JSON.stringify({ sku, player: order.playerInputs, reference: order.id }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`เชื่อมต่อ supplier ไม่ได้: ${e.name === 'TimeoutError' ? 'หมดเวลา 20 วินาที' : e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`supplier ตอบ HTTP ${res.status}${data && data.error ? `: ${data.error}` : ''}`);
  const status = String((data && data.status) || 'success').toLowerCase();
  if (!['success', 'succeeded', 'completed', 'ok'].includes(status)) {
    throw new Error(`supplier ยังไม่ยืนยันการเติม (status: ${status})`);
  }
  const ref = data.reference || data.supplierRef || data.id || data.transactionId || null;
  return { supplierRef: ref === null ? null : String(ref).slice(0, 100) };
}

// แจ้งเตือนแอดมิน (Discord ใช้ content, Slack ใช้ text) — ไม่ throw เด็ดขาด
async function sendAlert(text) {
  const message = `[${config.shopName}] ${text}`;
  if (!config.adminAlertWebhook) {
    console.log('🔔', message);
    return false;
  }
  try {
    const res = await fetch(config.adminAlertWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message, text: message }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`ส่งแจ้งเตือนไม่สำเร็จ: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error('ส่งแจ้งเตือนไม่สำเร็จ:', e.message);
    return false;
  }
}

// อีเมลถึงสมาชิก → true เมื่อส่งได้ (ไม่ throw เด็ดขาด)
//   MAIL_PROVIDER=resend → ส่งจริงผ่าน Resend API ด้วย fetch
//   MAIL_PROVIDER=log    → เขียนลง log: เนื้อหา (ที่มีลิงก์รีเซ็ต) เฉพาะเมื่อ MAIL_LOG_LINKS=1 — ใช้ใน staging เท่านั้น
// log ทุกบรรทัดใช้อีเมลแบบปิดบางส่วน (n***@example.com) ไม่พิมพ์ API key
const maskEmail = (e) => {
  const [local = '', domain = ''] = String(e || '').split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

async function sendMail({ to, subject, text }) {
  const who = maskEmail(to);
  if (config.mailProvider === 'log') {
    if (config.mailLogLinks) console.log(`📧 [mail:log] ถึง ${who} · ${subject}\n${text}\n📧 [mail:log] จบ`);
    else console.log(`📧 [mail:log] ถึง ${who} · ${subject} (ไม่แสดงเนื้อหา — ตั้ง MAIL_LOG_LINKS=1 เฉพาะ staging)`);
    return config.mailLogLinks;
  }
  if (config.mailProvider !== 'resend' || !config.resendApiKey || !config.mailFrom) {
    console.log(`📧 ยังไม่ได้ตั้งค่าอีเมล — ไม่ได้ส่ง "${subject}" ถึง ${who}`);
    return false;
  }
  try {
    const res = await fetch(`${config.resendApiUrl}/emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.resendApiKey}` },
      body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`ส่งอีเมลถึง ${who} ไม่สำเร็จ: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`ส่งอีเมลถึง ${who} ไม่สำเร็จ: ${e.name === 'TimeoutError' ? 'หมดเวลา 10 วินาที' : e.message}`);
    return false;
  }
}

module.exports = { AdapterError, lookupEnabled, lookupNickname, fulfillTopup, sendAlert, sendMail, maskEmail };
