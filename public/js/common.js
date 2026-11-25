// ฟังก์ชันที่ใช้ร่วมกันทุกหน้า
const $ = (sel, el = document) => el.querySelector(sel);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const baht = (n) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });

const thaiTime = (iso) =>
  new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const STATUS = {
  pending_payment: 'รอชำระเงิน',
  paid_pending_review: 'แจ้งโอนแล้ว รอร้านตรวจสอบ',
  paid: 'ยืนยันยอดแล้ว',
  processing: 'กำลังเติมเข้าเกม',
  completed: 'เติมสำเร็จ',
  expired: 'หมดเวลาชำระเงิน',
  cancelled: 'ยกเลิกแล้ว',
  refund_needed: 'เติมไม่สำเร็จ รอคืนเงิน',
  refunded: 'คืนเงินแล้ว',
};

// รหัสสุ่มสำหรับกันสั่งซ้ำ (randomUUID ใช้ได้เฉพาะ https/localhost จึงมีสำรอง)
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ต่อ path ของ API เข้ากับ KOINZ_API (จาก js/config.js) เผื่อ API อยู่คนละโดเมน
const apiUrl = (path) => String(window.KOINZ_API || '').replace(/\/+$/, '') + path;

async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(apiUrl(url), {
    method,
    // ใส่ Content-Type เฉพาะตอนมี body — GET ข้ามโดเมนจะได้ไม่ต้องมี preflight
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง');
  return data;
}

// เก็บออเดอร์ของลูกค้าไว้ในเครื่อง เพื่อกลับมาดูสถานะได้
const myOrders = {
  list() {
    try { return JSON.parse(localStorage.getItem('koinz_orders') || '[]'); } catch { return []; }
  },
  add(o) {
    try {
      const list = [o, ...this.list().filter((x) => x.id !== o.id)].slice(0, 20);
      localStorage.setItem('koinz_orders', JSON.stringify(list));
    } catch { /* ignore */ }
  },
};

// ค่าตั้งค่าร้านจาก .env (หน้าอื่นใช้ shopConfig.then(...) ได้)
const shopConfig = api('/api/config').catch(() => ({}));
shopConfig.then((c) => {
  if (c.shopName) document.querySelectorAll('[data-shop]').forEach((el) => (el.textContent = c.shopName));
});
