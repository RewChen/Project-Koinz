// ออเดอร์: สถานะ, การเปลี่ยนสถานะ (transition), audit log และ event bus
const crypto = require('crypto');
const { EventEmitter } = require('events');
const store = require('./store');

const STATUSES = [
  'pending_payment', // รอโอน มี QR
  'paid_pending_review', // ลูกค้ากดแจ้งโอน รอร้านตรวจ
  'paid', // ยืนยันยอดแล้ว (webhook หรือแอดมิน)
  'processing', // กำลังเติม
  'completed', // เติมสำเร็จ
  'expired', // ไม่จ่ายภายในเวลา
  'cancelled', // ยกเลิก
  'refund_needed', // จ่ายแล้วแต่เติมไม่สำเร็จ
  'refunded', // คืนเงินแล้ว
];

// สถานะต้นทาง → สถานะที่ไปต่อได้
const ALLOWED = {
  pending_payment: ['paid_pending_review', 'paid', 'expired', 'cancelled'],
  paid_pending_review: ['paid', 'processing', 'completed', 'cancelled'],
  expired: ['paid_pending_review', 'paid', 'cancelled'],
  paid: ['processing', 'completed', 'refund_needed'],
  processing: ['completed', 'refund_needed', 'paid'],
  refund_needed: ['paid', 'processing', 'completed', 'refunded'],
  completed: ['refund_needed'],
  cancelled: [],
  refunded: [],
};

const ACTORS = ['customer', 'admin', 'webhook', 'system'];
const AUDIT_MAX = 5000;

const bus = new EventEmitter();
bus.setMaxListeners(0); // ลูกค้าหลายคนเปิด SSE พร้อมกันได้

const nowIso = () => new Date().toISOString();
const all = () => store.read('orders', []);
const find = (id) => all().find((o) => o.id === id) || null;
const findByIdempotencyKey = (key) => (key ? all().find((o) => o.idempotencyKey === key) || null : null);

function audit(entry) {
  store.update('audit', [], (list) => {
    list.push({ at: nowIso(), ...entry });
    if (list.length > AUDIT_MAX) list.splice(0, list.length - AUDIT_MAX);
  });
}

const auditFor = (orderId) => store.read('audit', []).filter((a) => a.orderId === orderId);

function newId() {
  return 'KZ' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// สร้างออเดอร์ใหม่ (fields ที่ส่งมาจะถูกรวมกับค่าเริ่มต้น)
function create(fields) {
  const at = nowIso();
  const order = {
    id: newId(),
    token: crypto.randomBytes(16).toString('hex'),
    status: 'pending_payment',
    playerNickname: null,
    contact: '',
    lineId: '',
    customerNote: '',
    paymentRef: null,
    supplierRef: null,
    idempotencyKey: null,
    ...fields,
    createdAt: at,
    updatedAt: at,
    history: [{ status: 'pending_payment', at, by: 'customer' }],
  };
  store.update('orders', [], (list) => list.push(order));
  audit({ orderId: order.id, action: 'create', to: order.status, actor: 'customer' });
  bus.emit('status', order.id, order.status);
  return order;
}

class TransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // not_found | conflict | invalid
  }
}

// จุดเดียวที่เปลี่ยนสถานะออเดอร์ได้ → คืนออเดอร์ที่อัปเดตแล้ว หรือ throw TransitionError
function transition(id, to, actor, { from, patch, note } = {}) {
  if (!STATUSES.includes(to)) throw new TransitionError('invalid', 'สถานะไม่ถูกต้อง');
  if (!ACTORS.includes(actor)) throw new Error(`actor ไม่ถูกต้อง: ${actor}`);

  const orders = all();
  const order = orders.find((o) => o.id === id);
  if (!order) throw new TransitionError('not_found', 'ไม่พบออเดอร์');
  const prev = order.status;
  const fromList = from === undefined ? null : [].concat(from);
  if (fromList && !fromList.includes(prev)) {
    throw new TransitionError('conflict', `ออเดอร์อยู่ในสถานะ "${prev}" แล้ว`);
  }
  if (!(ALLOWED[prev] || []).includes(to)) {
    throw new TransitionError('invalid', `เปลี่ยนสถานะจาก "${prev}" เป็น "${to}" ไม่ได้`);
  }

  const at = nowIso();
  const { id: _i, token: _t, status: _s, history: _h, ...safePatch } = patch || {};
  Object.assign(order, safePatch, { status: to, updatedAt: at });
  const h = { status: to, at, by: actor };
  if (note) h.note = String(note).slice(0, 200);
  order.history = [...(order.history || []), h];
  store.write('orders', orders);

  audit({ orderId: id, action: 'status', from: prev, to, actor, ...(h.note ? { note: h.note } : {}) });
  bus.emit('status', id, to, order);
  return order;
}

// ข้อมูลที่ลูกค้าเห็นได้ (ผ่าน token)
function publicView(o) {
  const { token, contact, lineId, idempotencyKey, customerNote, sku, ...rest } = o;
  return rest;
}

// สำหรับหลังบ้าน
function adminView(o) {
  const { token, ...rest } = o;
  return rest;
}

// pending_payment ที่เลยเวลา → expired
function expireDue(now = Date.now()) {
  const due = all().filter(
    (o) => o.status === 'pending_payment' && o.expiresAt && Date.parse(o.expiresAt) <= now
  );
  let n = 0;
  for (const o of due) {
    try {
      transition(o.id, 'expired', 'system', { from: 'pending_payment' });
      n++;
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e;
    }
  }
  return n;
}

module.exports = {
  STATUSES,
  ALLOWED,
  bus,
  all,
  find,
  findByIdempotencyKey,
  create,
  transition,
  TransitionError,
  publicView,
  adminView,
  audit,
  auditFor,
  expireDue,
};
