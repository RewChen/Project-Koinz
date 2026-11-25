// เชื่อมต่อบริการภายนอก: ตรวจชื่อในเกม
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

module.exports = { AdapterError, lookupEnabled, lookupNickname };
