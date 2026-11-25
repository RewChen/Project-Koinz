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
  processing: 'กำลังเติมเข้าเกม',
  completed: 'เติมสำเร็จ',
  cancelled: 'ยกเลิกแล้ว',
};

async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
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

// ชื่อร้านจาก .env
api('/api/config')
  .then((c) => {
    document.querySelectorAll('[data-shop]').forEach((el) => (el.textContent = c.shopName));
  })
  .catch(() => {});
