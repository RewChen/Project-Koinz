// ฟังก์ชันที่ใช้ร่วมกันทุกหน้า
const $ = (sel, el = document) => el.querySelector(sel);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const baht = (n) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });

const thaiTime = (iso) =>
  new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clockTime = (iso) => new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

// ไอคอนเส้น (inline SVG, ตกแต่งเท่านั้น — ปุ่มที่มีแต่ไอคอนต้องใส่ aria-label เอง)
const ICON = (() => {
  const svg = (size, w, body) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  return {
    user: svg(18, 1.8, '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
    arrow: (s = 22) => svg(s, 2.2, '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
    back: (s = 20) => svg(s, 2, '<path d="M15 6l-6 6 6 6"/>'),
    next: svg(18, 2, '<path d="M9 6l6 6-6 6"/>'),
    clock: (s = 14) => svg(s, 2.2, '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/>'),
    stopwatch: svg(34, 1.8, '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M9 3h6"/>'),
    download: svg(18, 2, '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
    check: (s = 12, w = 3) => svg(s, w, '<path d="M5 12l5 5 9-10"/>'),
    cross: svg(11, 3.2, '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
    search: (s = 16) => svg(s, 1.9, '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
    chevron: svg(14, 2.2, '<path d="M6 9l6 6 6-6"/>'),
    retry: svg(38, 2, '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
    // ตา: shown = true → มีขีดทับ (กดแล้วจะซ่อน)
    eye: (shown) => svg(20, 1.8, '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' + (shown ? '<path d="M4 4l16 16"/>' : '')),
    mail: (s = 36) => svg(s, 1.9, '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
    close: svg(16, 2, '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  };
})();

// แสดงข้อมูลผู้เล่น: ช่องแรกตัวใหญ่ ช่องที่เหลือในวงเล็บ เช่น "123456789 (1234)"
function playerParts(o) {
  const values = Object.values(o.playerInputs || {}).filter(Boolean);
  if (!values.length) return { main: o.playerLabel || o.playerId || '', extra: o.server || '' };
  return { main: values[0], extra: values.slice(1).join(' · ') };
}
const playerText = (o) => {
  const p = playerParts(o);
  return p.extra ? `${p.main} (${p.extra})` : p.main;
};

// จำข้อมูลผู้เล่นล่าสุดของแต่ละเกม: ช่องแรก → koinz_uid_<slug>, ช่องอื่น → koinz_<ชื่อช่อง>_<slug> (เช่น koinz_server_<slug>)
const remember = {
  key: (slug, field, i) => (i === 0 ? `koinz_uid_${slug}` : `koinz_${field.name}_${slug}`),
  get(slug, fields) {
    const out = {};
    try {
      fields.forEach((f, i) => {
        const v = localStorage.getItem(this.key(slug, f, i));
        if (v) out[f.name] = v;
      });
    } catch { /* ไม่มี localStorage */ }
    return out;
  },
  set(slug, fields, inputs) {
    try {
      fields.forEach((f, i) => {
        if (inputs[f.name]) localStorage.setItem(this.key(slug, f, i), inputs[f.name]);
      });
      localStorage.setItem('koinz_last_game', slug);
    } catch { /* ไม่มี localStorage */ }
  },
  lastGame() {
    try { return localStorage.getItem('koinz_last_game') || ''; } catch { return ''; }
  },
};

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
  if (!res.ok) {
    const err = new Error(data.error || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ระบบสมาชิกใช้ cookie (SameSite=Lax) จึงใช้ได้เฉพาะตอนหน้าเว็บกับ API อยู่โดเมนเดียวกัน
// หน้าเว็บบน GitHub Pages (KOINZ_API เป็นโดเมนอื่น) → ลิงก์สมาชิกพาไปหน้าเดียวกันบนเว็บหลักแทน
const memberSite = (() => {
  let remote = '';
  try {
    const base = String(window.KOINZ_API || '').replace(/\/+$/, '');
    if (base && new URL(base, location.href).origin !== location.origin) remote = base;
  } catch { /* KOINZ_API ผิดรูปแบบ */ }
  return { remote, url: (page) => (remote ? `${remote}/${page}` : page) };
})();

// สถานะล็อกอิน → { email } หรือ null (เรียกครั้งเดียวต่อหน้า)
let memberPromise = null;
function memberStatus() {
  if (!memberPromise) {
    memberPromise = memberSite.remote
      ? Promise.resolve(null)
      : api('/api/auth/session').then((r) => r.member || null).catch(() => null);
  }
  return memberPromise;
}

// ?next= ได้เฉพาะ path ภายในเว็บ (ขึ้นต้นด้วย / แต่ไม่ใช่ // หรือ /\) กัน open redirect
function safeNext(raw) {
  const v = String(raw || '');
  if (!/^\/(?![/\\])/.test(v) || /[\u0000-\u001f\\]/.test(v)) return '';
  try {
    const u = new URL(v, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : '';
  } catch {
    return '';
  }
}

// ลิงก์ไปหน้าเข้าสู่ระบบ แล้วกลับมาหน้าปัจจุบัน
const loginHref = (page = 'login.html') =>
  memberSite.remote ? memberSite.url(page) : `${page}?next=${encodeURIComponent(location.pathname + location.search)}`;

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

// ลิงก์ที่มาจากค่าตั้งค่าร้าน: รับเฉพาะ https:// (scheme อื่นทิ้งหมด — กันอีกชั้น แม้เซิร์ฟเวอร์กรองแล้ว)
function httpsOnly(v) {
  try {
    const u = new URL(String(v || ''));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

// ข้อมูลร้าน (/api/config → shop) ลงหน้าเว็บ — ใช้ textContent เท่านั้น
//   data-shop-field="lineId"   → ข้อความ (ค่าว่าง = คงข้อความเดิมใน HTML ไว้ เช่นค่าตั้งต้น)
//   data-shop-href="lineUrl"   → href (เฉพาะ https:// ไม่งั้นเอา href ออก)
//   data-shop-row="facebookUrl" → ซ่อนทั้งแถวถ้าค่าว่าง (หลายค่าคั่นเว้นวรรค = ต้องมีครบทุกค่า)
// ค่าที่คำนวณเพิ่ม: termsMonth = TERMS_VERSION แบบ 2026-11 → "พฤศจิกายน 2026"
function fillShopInfo(shop, root = document) {
  const s = { ...(shop || {}) };
  const m = /^(\d{4})-(\d{2})$/.exec(String(s.termsVersion || ''));
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    s.termsMonth = new Date(Date.UTC(+m[1], +m[2] - 1, 15))
      .toLocaleDateString('th-TH-u-ca-gregory', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const val = (k) => {
    const v = s[k];
    if (/Url$/.test(k)) return httpsOnly(v);
    return v === undefined || v === null ? '' : String(v).trim();
  };
  root.querySelectorAll('[data-shop-row]').forEach((el) => {
    el.hidden = !el.dataset.shopRow.split(/\s+/).filter(Boolean).every((k) => val(k));
  });
  root.querySelectorAll('[data-shop-field]').forEach((el) => {
    const v = val(el.dataset.shopField);
    if (v) el.textContent = v;
  });
  root.querySelectorAll('[data-shop-href]').forEach((el) => {
    const v = val(el.dataset.shopHref);
    if (v) el.href = v;
    else el.removeAttribute('href');
  });
}

// ค่าตั้งค่าร้านจาก .env (หน้าอื่นใช้ shopConfig.then(...) ได้)
const shopConfig = api('/api/config').catch(() => ({}));
shopConfig.then((c) => {
  fillShopInfo(c.shop);
  if (c.shopName) document.querySelectorAll('[data-shop]').forEach((el) => (el.textContent = c.shopName));
  // แถบบนสุดของเว็บทดสอบ (ตั้ง SITE_BANNER เฉพาะ staging) — ใช้ textContent จึงไม่ต้อง esc()
  if (c.siteBanner && !document.querySelector('.site-banner')) {
    const bar = document.createElement('div');
    bar.className = 'site-banner';
    bar.setAttribute('role', 'note');
    bar.textContent = c.siteBanner;
    document.body.prepend(bar);
  }
});
