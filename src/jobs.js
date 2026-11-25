// งานเบื้องหลัง: คิวเติมเกมผ่าน supplier (+retry) และกวาดออเดอร์หมดอายุ
// คิวเก็บใน data/jobs.json จึงทำต่อได้หลังรีสตาร์ท
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const orders = require('./orders');
const catalog = require('./catalog');
const adapters = require('./adapters');

const SWEEP_MS = 2000;
const TICK_MS = 500;
const CLEANUP_MS = 60 * 60 * 1000;
const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const baht = (n) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });

const allJobs = () => store.read('jobs', []);

function updateJob(id, patch) {
  return store.update('jobs', [], (list) => {
    const job = list.find((j) => j.id === id);
    if (job) Object.assign(job, patch);
    return job;
  });
}

// เข้าคิวเติมเกม (ถ้ามีงานของออเดอร์นี้ค้างอยู่แล้วจะไม่สร้างซ้ำ) → { job, created }
function enqueueFulfill(orderId) {
  const result = store.update('jobs', [], (list) => {
    const active = list.find((j) => j.type === 'fulfill' && j.orderId === orderId && !j.done);
    if (active) return { job: active, created: false };
    const job = {
      id: 'JB' + crypto.randomBytes(6).toString('hex').toUpperCase(),
      type: 'fulfill',
      orderId,
      attempts: 0,
      runAt: nowIso(),
      lastError: null,
      done: false,
      result: null,
      createdAt: nowIso(),
    };
    list.push(job);
    return { job, created: true };
  });
  setImmediate(tick);
  return result;
}

const finish = (job, result, patch = {}) => updateJob(job.id, { done: true, result, finishedAt: nowIso(), ...patch });

async function runFulfill(job) {
  let order = orders.find(job.orderId);
  if (!order) return finish(job, 'order_missing');
  if (order.status === 'paid') {
    order = orders.transition(order.id, 'processing', 'system', { from: 'paid' });
  }
  if (order.status !== 'processing') return finish(job, `skipped:${order.status}`);

  // sku ณ ตอนสั่ง (ถ้าออเดอร์เก่าไม่มี ใช้จากแคตตาล็อกปัจจุบัน)
  let sku = order.sku;
  if (!sku) {
    const game = catalog.findGame(order.gameSlug, { includeInactive: true });
    const pkg = game && (game.packages || []).find((p) => p.id === order.packageId);
    sku = pkg && pkg.sku;
  }

  const attempts = job.attempts + 1;
  updateJob(job.id, { attempts }); // นับก่อนเรียก เผื่อเซิร์ฟเวอร์ดับกลางทาง
  try {
    if (!sku) throw new Error('แพ็กเกจนี้ไม่มี sku สำหรับ supplier');
    const { supplierRef } = await adapters.fulfillTopup(order, sku);
    orders.transition(order.id, 'completed', 'system', { from: 'processing', patch: { supplierRef } });
    finish(job, 'completed', { lastError: null, supplierRef });
  } catch (e) {
    if (e instanceof orders.TransitionError) return finish(job, `skipped:${e.message}`);
    const lastError = String(e.message || e).slice(0, 300);
    if (attempts >= config.fulfillAttempts) {
      try {
        orders.transition(order.id, 'refund_needed', 'system', { from: 'processing', note: lastError });
      } catch (te) {
        if (!(te instanceof orders.TransitionError)) throw te;
      }
      finish(job, 'failed', { lastError });
      adapters.sendAlert(
        `❌ เติมไม่สำเร็จครบ ${attempts} ครั้ง ต้องคืนเงิน: ออเดอร์ ${order.id} · ${order.gameName} ${order.packageName} · ${order.playerLabel} · ${baht(order.amount)} · ${lastError}`
      );
    } else {
      const delay = config.fulfillRetryBaseSeconds * 1000 * 2 ** (attempts - 1); // 3, 6, 12 วิ…
      updateJob(job.id, { lastError, runAt: new Date(Date.now() + delay).toISOString() });
    }
  }
}

const inFlight = new Set();

function tick() {
  if (!config.autoFulfill) return;
  const now = Date.now();
  for (const job of allJobs()) {
    if (job.done || inFlight.has(job.id) || Date.parse(job.runAt) > now) continue;
    inFlight.add(job.id);
    runFulfill(job)
      .catch((e) => console.error(`งานเติมเกม ${job.id} ผิดพลาด:`, e))
      .finally(() => {
        inFlight.delete(job.id);
        setImmediate(tick); // อาจมีงานถัดไปที่ถึงเวลาแล้ว
      });
  }
}

function cleanup() {
  const cutoff = Date.now() - KEEP_DONE_MS;
  const list = allJobs();
  const keep = list.filter((j) => !j.done || Date.parse(j.finishedAt || j.createdAt) > cutoff);
  if (keep.length !== list.length) store.write('jobs', keep);
}

function sweepExpired() {
  try {
    orders.expireDue();
  } catch (e) {
    console.error('กวาดออเดอร์หมดอายุไม่สำเร็จ:', e.message);
  }
}

// ออเดอร์เปลี่ยนเป็น paid → เข้าคิวเติม
function onStatus(id, to) {
  if (to === 'paid' && config.autoFulfill) enqueueFulfill(id);
}

let timers = [];

function start() {
  stop();
  orders.bus.on('status', onStatus);
  if (config.autoFulfill) {
    // ออเดอร์ที่จ่ายแล้วแต่ยังไม่มีงานในคิว (เช่น เซิร์ฟเวอร์ดับจังหวะพอดี) → เข้าคิว
    const active = new Set(allJobs().filter((j) => !j.done).map((j) => j.orderId));
    orders.all()
      .filter((o) => o.status === 'paid' && !active.has(o.id))
      .forEach((o) => enqueueFulfill(o.id));
    timers.push(setInterval(tick, TICK_MS));
    setImmediate(tick);
  }
  sweepExpired();
  cleanup();
  timers.push(setInterval(sweepExpired, SWEEP_MS));
  timers.push(setInterval(cleanup, CLEANUP_MS));
  return stop;
}

function stop() {
  orders.bus.off('status', onStatus);
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = { start, stop, enqueueFulfill, sweepExpired, tick };
