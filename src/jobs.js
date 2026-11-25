// งานเบื้องหลัง: คิวเติมเกมผ่าน supplier (+retry) และกวาดออเดอร์หมดอายุ
// คิวเก็บใน data/jobs.json หรือตาราง jobs จึงทำต่อได้หลังรีสตาร์ท
const crypto = require('crypto');
const config = require('./config');
const repo = require('./repo');
const orders = require('./orders');
const catalog = require('./catalog');
const adapters = require('./adapters');

const SWEEP_MS = 2000;
const TICK_MS = 500;
const LEASE_MS = 60000; // จองงานไว้ 60 วิ (supplier timeout 20 วิ) — ถ้าเซิร์ฟเวอร์ดับ งานจะถูกหยิบใหม่เอง
const CLEANUP_MS = 60 * 60 * 1000;
const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const baht = (n) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });

// เข้าคิวเติมเกม (ถ้ามีงานของออเดอร์นี้ค้างอยู่แล้วจะไม่สร้างซ้ำ) → { job, created }
async function enqueueFulfill(orderId) {
  const result = await repo.enqueueJob({
    id: 'JB' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    type: 'fulfill',
    orderId,
    attempts: 0,
    runAt: nowIso(),
    lastError: null,
    done: false,
    result: null,
    createdAt: nowIso(),
  });
  setImmediate(tick);
  return result;
}

const finish = (job, result, patch = {}) => repo.updateJob(job.id, { done: true, result, finishedAt: nowIso(), ...patch });

// job.attempts ถูกนับเพิ่มแล้วตอนจองงาน (นับก่อนเรียก supplier เผื่อเซิร์ฟเวอร์ดับกลางทาง)
async function runFulfill(job) {
  let order = await orders.find(job.orderId);
  if (!order) return finish(job, 'order_missing');
  try {
    if (order.status === 'paid') {
      order = await orders.transition(order.id, 'processing', 'system', { from: 'paid' });
    }
  } catch (e) {
    if (e instanceof orders.TransitionError) return finish(job, `skipped:${e.message}`);
    throw e;
  }
  if (order.status !== 'processing') return finish(job, `skipped:${order.status}`);

  // sku ณ ตอนสั่ง (ถ้าออเดอร์เก่าไม่มี ใช้จากแคตตาล็อกปัจจุบัน)
  let sku = order.sku;
  if (!sku) {
    const game = await catalog.findGame(order.gameSlug, { includeInactive: true });
    const pkg = game && (game.packages || []).find((p) => p.id === order.packageId);
    sku = pkg && pkg.sku;
  }

  const attempts = job.attempts;
  try {
    if (!sku) throw new Error('แพ็กเกจนี้ไม่มี sku สำหรับ supplier');
    const { supplierRef } = await adapters.fulfillTopup(order, sku);
    await orders.transition(order.id, 'completed', 'system', { from: 'processing', patch: { supplierRef } });
    await finish(job, 'completed', { lastError: null, supplierRef });
  } catch (e) {
    if (e instanceof orders.TransitionError) return finish(job, `skipped:${e.message}`);
    const lastError = String(e.message || e).slice(0, 300);
    if (attempts >= config.fulfillAttempts) {
      try {
        await orders.transition(order.id, 'refund_needed', 'system', { from: 'processing', note: lastError });
      } catch (te) {
        if (!(te instanceof orders.TransitionError)) throw te;
      }
      await finish(job, 'failed', { lastError });
      adapters.sendAlert(
        `❌ เติมไม่สำเร็จครบ ${attempts} ครั้ง ต้องคืนเงิน: ออเดอร์ ${order.id} · ${order.gameName} ${order.packageName} · ${order.playerLabel} · ${baht(order.amount)} · ${lastError}`
      );
    } else {
      const delay = config.fulfillRetryBaseSeconds * 1000 * 2 ** (attempts - 1); // 3, 6, 12 วิ…
      await repo.updateJob(job.id, { lastError, runAt: new Date(Date.now() + delay).toISOString() });
    }
  }
}

let ticking = false;
async function tick() {
  if (!config.autoFulfill || ticking) return;
  ticking = true;
  try {
    const jobs = await repo.claimDueJobs(Date.now(), LEASE_MS);
    // งานคนละออเดอร์รันพร้อมกันได้ (จองแล้ว ไม่ถูกหยิบซ้ำ)
    for (const job of jobs) {
      runFulfill(job)
        .catch((e) => console.error(`งานเติมเกม ${job.id} ผิดพลาด:`, e))
        .finally(() => setImmediate(tick));
    }
  } catch (e) {
    console.error('ดึงคิวงานไม่สำเร็จ:', e.message);
  } finally {
    ticking = false;
  }
}

async function cleanup() {
  try {
    await repo.cleanupJobs(Date.now() - KEEP_DONE_MS);
  } catch (e) {
    console.error('ล้างงานเก่าไม่สำเร็จ:', e.message);
  }
}

let sweeping = false;
async function sweepExpired() {
  if (sweeping) return;
  sweeping = true;
  try {
    await orders.expireDue();
  } catch (e) {
    console.error('กวาดออเดอร์หมดอายุไม่สำเร็จ:', e.message);
  } finally {
    sweeping = false;
  }
}

// ออเดอร์เปลี่ยนเป็น paid → เข้าคิวเติม
function onStatus(id, to) {
  if (to === 'paid' && config.autoFulfill) {
    enqueueFulfill(id).catch((e) => console.error(`เข้าคิวเติม ${id} ไม่สำเร็จ:`, e.message));
  }
}

let timers = [];

async function start() {
  stop();
  orders.bus.on('status', onStatus);
  if (config.autoFulfill) {
    // ออเดอร์ที่จ่ายแล้วแต่ยังไม่มีงานในคิว (เช่น เซิร์ฟเวอร์ดับจังหวะพอดี) → เข้าคิว
    for (const id of await repo.paidOrdersWithoutActiveJob()) await enqueueFulfill(id);
    timers.push(setInterval(tick, TICK_MS));
    setImmediate(tick);
  }
  sweepExpired();
  cleanup();
  timers.push(setInterval(sweepExpired, SWEEP_MS));
  timers.push(setInterval(cleanup, CLEANUP_MS));
}

function stop() {
  orders.bus.off('status', onStatus);
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = {
  start,
  stop,
  enqueueFulfill,
  activeJobFor: (orderId) => repo.activeJobFor(orderId),
  sweepExpired,
  tick,
};
