// งานเบื้องหลัง: กวาดออเดอร์หมดอายุ
const orders = require('./orders');

const SWEEP_MS = 2000;

function sweepExpired() {
  try {
    orders.expireDue();
  } catch (e) {
    console.error('กวาดออเดอร์หมดอายุไม่สำเร็จ:', e.message);
  }
}

let timers = [];

function start() {
  stop();
  sweepExpired();
  timers.push(setInterval(sweepExpired, SWEEP_MS));
  return stop;
}

function stop() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = { start, stop, sweepExpired };
