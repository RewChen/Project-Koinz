// เทส API แบบ end-to-end: เปิด server.js เป็น process แยก พร้อมที่เก็บข้อมูลชั่วคราวของตัวเอง
//   npm test                → ไฟล์ JSON ในโฟลเดอร์ชั่วคราว
//   TEST_DATABASE_URL=…     → PostgreSQL: สร้างฐานข้อมูลใหม่ต่อ 1 เซิร์ฟเวอร์ แล้วลบทิ้ง (npm run test:pg)
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const GAMES = path.join(ROOT, 'docs', 'games.v2.json');
const ADMIN_PASSWORD = 'test-password-1234';

// ค่า env ที่เกี่ยวข้องทั้งหมด ตั้งเป็นค่าว่างไว้ก่อน กันค่าจาก .env ของเครื่องหลุดเข้ามา
const BASE_ENV = {
  PORT: '0',
  NODE_ENV: 'test',
  ADMIN_PASSWORD,
  RATE_LIMIT_OFF: '1',
  ORDER_TTL_MINUTES: '15',
  SHOP_LINE_URL: '',
  PAYMENT_WEBHOOK_SECRET: '',
  SUPPLIER_API_URL: '',
  SUPPLIER_API_KEY: '',
  FULFILL_ATTEMPTS: '',
  FULFILL_RETRY_BASE_SECONDS: '',
  LOOKUP_API_URL: '',
  LOOKUP_API_KEY: '',
  LOOKUP_MOCK: '0',
  ADMIN_ALERT_WEBHOOK: '',
  FRONTEND_ORIGIN: '',
  TRUST_PROXY: '',
  DATABASE_URL: '',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PG_ADMIN_URL = process.env.TEST_DATABASE_URL || '';

// PostgreSQL: สร้างฐานข้อมูลว่างใหม่ → { url, drop }
async function createTestDatabase() {
  const { Client } = require('pg');
  const name = 'koinz_t_' + require('node:crypto').randomBytes(5).toString('hex');
  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(PG_ADMIN_URL);
  url.pathname = '/' + name;
  return {
    url: url.toString(),
    async drop() {
      const c = new Client({ connectionString: PG_ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koinz-test-'));
  fs.copyFileSync(GAMES, path.join(dataDir, 'games.json'));
  const db = PG_ADMIN_URL ? await createTestDatabase() : null;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...BASE_ENV, KOINZ_DATA_DIR: dataDir, ...(db ? { DATABASE_URL: db.url } : {}), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server ไม่ start:\n' + log)), 10000);
    const onData = (d) => {
      log += d;
      const m = log.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => (log += d));
    proc.on('exit', (code) => reject(new Error(`server ปิดตัว (code ${code}):\n${log}`)));
  });

  async function req(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
    return { status: res.status, headers: res.headers, text, body: json };
  }

  // อ่านข้อมูลที่เซิร์ฟเวอร์บันทึก (รูปแบบเดียวกันทั้งไฟล์ JSON และ PostgreSQL)
  let pgRepo = null;
  async function readData(name) {
    if (!db) {
      try { return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8')); } catch { return null; }
    }
    pgRepo = pgRepo || require('../src/repo/pg').createPgRepo(db.url);
    const fn = { orders: 'listAllOrders', jobs: 'listJobs', audit: 'listAudit', games: 'listGames' }[name];
    return pgRepo[fn]();
  }

  async function stop() {
    if (proc.exitCode === null) {
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (pgRepo) await pgRepo.close();
    if (db) await db.drop();
  }

  return { base, req, readData, stop, dataDir };
}

// เปิด Express ปลอม (supplier / lookup / alert) → { url, close }
function fakeServer(setup) {
  const app = express();
  app.use(express.json());
  setup(app);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) })
    );
  });
}

async function waitFor(fn, ms = 5000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

const mlOrder = (extra = {}) => ({
  gameSlug: 'mobile-legends',
  packageId: 'mobile-legends-3',
  playerInputs: { uid: '123456789', zone: '1234' },
  ...extra,
});

// ---------------------------------------------------------------------------
describe('Phase 1 — แคตตาล็อก ออเดอร์ หมดอายุ กันสั่งซ้ำ', () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  test('GET /api/games/mobile-legends มี 2 fields และไม่มี sku/cost', async () => {
    const r = await s.req('GET', '/api/games/mobile-legends');
    assert.equal(r.status, 200);
    assert.equal(r.body.fields.length, 2);
    assert.ok(!/sku|cost/i.test(r.text), r.text);
    const list = await s.req('GET', '/api/games');
    assert.equal(list.body.length, 6);
    assert.ok(!/sku|cost/i.test(list.text));
    assert.ok(list.body.every((g) => g.initial && g.minPrice > 0));
  });

  test('ไม่กรอก Zone ID → 400 "กรุณากรอกZone ID"', async () => {
    const r = await s.req('POST', '/api/orders', mlOrder({ playerInputs: { uid: '123456789' } }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'กรุณากรอกZone ID');
  });

  test('VALORANT ด้วย abc → 400 พร้อม patternHint', async () => {
    const r = await s.req('POST', '/api/orders', {
      gameSlug: 'valorant', packageId: 'valorant-1', playerInputs: { riotId: 'abc' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'กรอกในรูปแบบ ชื่อ#แท็ก เช่น Koinz#TH1');
  });

  test('dropdown ที่ไม่ได้เลือก / ค่านอกตัวเลือก / อักขระอันตราย', async () => {
    const g = { gameSlug: 'genshin-impact', packageId: 'genshin-impact-1' };
    let r = await s.req('POST', '/api/orders', { ...g, playerInputs: { uid: '812345678' } });
    assert.equal(r.body.error, 'กรุณาเลือกเซิร์ฟเวอร์');
    r = await s.req('POST', '/api/orders', { ...g, playerInputs: { uid: '812345678', server: 'Mars' } });
    assert.equal(r.status, 400);
    r = await s.req('POST', '/api/orders', {
      gameSlug: 'valorant', packageId: 'valorant-1', playerInputs: { riotId: '<b>x</b>#TH1' },
    });
    assert.equal(r.status, 400);
  });

  test('สร้างออเดอร์สำเร็จ เก็บ playerLabel/amount/expiresAt และตัด key แปลกปลอม', async () => {
    const r = await s.req('POST', '/api/orders', mlOrder({ playerInputs: { uid: '123456789', zone: '1234', evil: 'x' } }));
    assert.equal(r.status, 201);
    assert.ok(r.body.id && r.body.token);
    const o = (await s.readData('orders')).find((x) => x.id === r.body.id);
    assert.deepEqual(o.playerInputs, { uid: '123456789', zone: '1234' });
    assert.equal(o.playerLabel, 'User ID 123456789 · Zone ID 1234');
    assert.equal(o.amount, 159);
    assert.equal(o.playerNickname, null);
    assert.ok(Math.abs(Date.parse(o.expiresAt) - Date.parse(o.createdAt) - 15 * 60000) < 1000);

    const view = await s.req('GET', `/api/orders/${r.body.id}?t=${r.body.token}`);
    assert.equal(view.status, 200);
    assert.ok(view.body.qr.startsWith('data:image/png'));
    assert.ok(view.body.serverTime);
    for (const k of ['token', 'contact', 'lineId', 'idempotencyKey', 'customerNote', 'sku']) {
      assert.ok(!(k in view.body), `ไม่ควรมี ${k}`);
    }
    const bad = await s.req('GET', `/api/orders/${r.body.id}?t=wrong`);
    assert.equal(bad.status, 404);
  });

  test('idempotencyKey เดิม 2 ครั้ง → id เดียวกัน และมีออเดอร์เดียว', async () => {
    const key = 'b6a1f1f4-6c51-4f0a-9d8e-1a2b3c4d5e6f';
    const [a, b] = await Promise.all([
      s.req('POST', '/api/orders', mlOrder({ idempotencyKey: key })),
      s.req('POST', '/api/orders', mlOrder({ idempotencyKey: key })),
    ]);
    const c = await s.req('POST', '/api/orders', mlOrder({ idempotencyKey: key }));
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(c.status, 200);
    assert.equal(a.body.id, b.body.id);
    assert.equal(a.body.id, c.body.id);
    assert.equal((await s.readData('orders')).filter((o) => o.idempotencyKey === key).length, 1);
  });

  test('ไม่ตั้ง LOOKUP → lookupEnabled false และ /api/player/lookup ตอบ 404', async () => {
    const c = await s.req('GET', '/api/config');
    assert.equal(c.body.lookupEnabled, false);
    assert.equal(c.body.orderTtlMinutes, 15);
    assert.ok('shopLineUrl' in c.body && 'autoFulfill' in c.body);
    const r = await s.req('POST', '/api/player/lookup', { gameSlug: 'rov', playerInputs: { uid: '1234567' } });
    assert.equal(r.status, 404);
  });

  test('แอดมินเปลี่ยนสถานะผิดลำดับ → 400 และทุกการเปลี่ยนสถานะลง audit', async () => {
    const { token } = (await s.req('POST', '/api/admin/login', { password: ADMIN_PASSWORD })).body;
    const auth = { authorization: `Bearer ${token}` };
    const o = (await s.req('POST', '/api/orders', mlOrder())).body;
    let r = await s.req('POST', `/api/admin/orders/${o.id}/status`, { status: 'refunded' }, auth);
    assert.equal(r.status, 400);
    r = await s.req('POST', `/api/admin/orders/${o.id}/status`, { status: 'paid' }, auth);
    assert.equal(r.status, 200);
    r = await s.req('POST', `/api/admin/orders/${o.id}/status`, { status: 'completed', note: 'เติมแล้ว' }, auth);
    assert.equal(r.status, 200);
    const audit = (await s.readData('audit')).filter((a) => a.orderId === o.id);
    assert.deepEqual(audit.map((a) => [a.to, a.actor]), [
      ['pending_payment', 'customer'],
      ['paid', 'admin'],
      ['completed', 'admin'],
    ]);
    const saved = (await s.readData('orders')).find((x) => x.id === o.id);
    assert.deepEqual(saved.history.map((h) => h.by), ['customer', 'admin', 'admin']);
  });

  test('JSON พัง → 400 ภาษาไทย', async () => {
    const r = await s.req('POST', '/api/orders', '{bad json');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'รูปแบบข้อมูลไม่ถูกต้อง');
  });
});

describe('Phase 1 — ออเดอร์หมดอายุ (ORDER_TTL_MINUTES=0.05)', () => {
  let s;
  before(async () => (s = await startServer({ ORDER_TTL_MINUTES: '0.05' })));
  after(() => s.stop());

  test('ภายใน 5 วินาทีเป็น expired ไม่มี qr แต่ยังแจ้งโอนได้ และลง audit ครบ', async () => {
    const { id, token } = (await s.req('POST', '/api/orders', mlOrder())).body;
    const o = await waitFor(async () => {
      const r = await s.req('GET', `/api/orders/${id}?t=${token}`);
      return r.body.status === 'expired' && r.body;
    }, 5000);
    assert.ok(o, 'ออเดอร์ควรหมดอายุภายใน 5 วินาที');
    assert.ok(!('qr' in o));

    const n = await s.req('POST', `/api/orders/${id}/notify`, { t: token, note: 'โอนแล้ว 18:30', lineId: 'koinzfan' });
    assert.equal(n.status, 200);
    const after = (await s.req('GET', `/api/orders/${id}?t=${token}`)).body;
    assert.equal(after.status, 'paid_pending_review');
    const again = await s.req('POST', `/api/orders/${id}/notify`, { t: token });
    assert.equal(again.status, 400);

    const audit = (await s.readData('audit')).filter((a) => a.orderId === id);
    assert.deepEqual(audit.map((a) => [a.to, a.actor]), [
      ['pending_payment', 'customer'],
      ['expired', 'system'],
      ['paid_pending_review', 'customer'],
    ]);
    const saved = (await s.readData('orders')).find((x) => x.id === id);
    assert.equal(saved.lineId, 'koinzfan');
    assert.equal(saved.customerNote, 'โอนแล้ว 18:30');
  });
});

describe('Phase 1 — ตรวจชื่อในเกม', () => {
  test('LOOKUP_MOCK=1 → lookupEnabled และได้ชื่อจำลอง (เก็บในออเดอร์ด้วย)', async () => {
    const s = await startServer({ LOOKUP_MOCK: '1' });
    try {
      assert.equal((await s.req('GET', '/api/config')).body.lookupEnabled, true);
      const r = await s.req('POST', '/api/player/lookup', { gameSlug: 'mobile-legends', playerInputs: { uid: '123456789', zone: '1234' } });
      assert.equal(r.status, 200);
      assert.match(r.body.nickname, /^ผู้เล่นทดสอบ \d{4}$/);
      assert.equal(r.body.mock, true);
      const bad = await s.req('POST', '/api/player/lookup', { gameSlug: 'mobile-legends', playerInputs: { uid: '1' } });
      assert.equal(bad.status, 400);
      const { id } = (await s.req('POST', '/api/orders', mlOrder())).body;
      assert.equal((await s.readData('orders')).find((o) => o.id === id).playerNickname, r.body.nickname);
    } finally {
      await s.stop();
    }
  });

  test('LOOKUP_API_URL → เรียก API จริง, 404 → ไม่พบผู้เล่น, API ล่มก็ยังสร้างออเดอร์ได้', async () => {
    const calls = [];
    const fake = await fakeServer((app) =>
      app.post('/lookup', (req, res) => {
        calls.push({ body: req.body, auth: req.headers.authorization });
        if (req.body.player.uid === '999999') return res.status(404).json({});
        if (req.body.player.uid === '500500') return res.status(500).json({});
        res.json({ nickname: 'KoinzHero' });
      })
    );
    const s = await startServer({ LOOKUP_API_URL: fake.url + '/lookup', LOOKUP_API_KEY: 'k123' });
    try {
      let r = await s.req('POST', '/api/player/lookup', { gameSlug: 'rov', playerInputs: { uid: '1234567' } });
      assert.deepEqual(r.body, { nickname: 'KoinzHero', mock: false });
      assert.deepEqual(calls[0], { body: { game: 'rov', player: { uid: '1234567' } }, auth: 'Bearer k123' });
      r = await s.req('POST', '/api/player/lookup', { gameSlug: 'rov', playerInputs: { uid: '999999' } });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, 'ไม่พบผู้เล่นนี้ ตรวจข้อมูลอีกครั้ง');
      r = await s.req('POST', '/api/orders', { gameSlug: 'rov', packageId: 'rov-1', playerInputs: { uid: '500500' } });
      assert.equal(r.status, 201);
    } finally {
      await s.stop();
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const SECRET = 'whsec_test_123';
const sign = (raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

async function webhook(s, payload, secret = SECRET) {
  const raw = JSON.stringify(payload);
  return s.req('POST', '/api/webhooks/payment', raw, { 'x-payment-signature': sign(raw, secret) });
}

async function adminAuth(s) {
  const r = await s.req('POST', '/api/admin/login', { password: ADMIN_PASSWORD });
  return { authorization: `Bearer ${r.body.token}` };
}

// ตัวรับแจ้งเตือนปลอม (Discord/Slack)
async function fakeAlerts() {
  const alerts = [];
  const srv = await fakeServer((app) => app.post('/alert', (req, res) => { alerts.push(req.body); res.status(204).end(); }));
  return { alerts, url: srv.url + '/alert', close: srv.close };
}

describe('Phase 2 — webhook ยืนยันการชำระเงิน', () => {
  let s, alert;
  before(async () => {
    alert = await fakeAlerts();
    s = await startServer({ PAYMENT_WEBHOOK_SECRET: SECRET, ORDER_TTL_MINUTES: '0.05', ADMIN_ALERT_WEBHOOK: alert.url });
  });
  after(async () => { await s.stop(); await alert.close(); });

  test('ลายเซ็นผิด → 401 / ถูก → paid / ส่งซ้ำ → duplicate / ยอดผิด → 409 + แจ้งเตือน', async () => {
    const { id, token } = (await s.req('POST', '/api/orders', mlOrder())).body;
    const payload = { orderId: id, amount: 159, paymentRef: 'BANK-0001' };

    let r = await webhook(s, payload, 'wrong-secret');
    assert.equal(r.status, 401);
    r = await s.req('POST', '/api/webhooks/payment', payload, {}); // ไม่มีลายเซ็น
    assert.equal(r.status, 401);

    r = await webhook(s, { orderId: id, amount: 158.99, paymentRef: 'BANK-0000' });
    assert.equal(r.status, 409);
    assert.ok(await waitFor(() => alert.alerts.some((a) => /ยอดโอนไม่ตรง/.test(a.content) && a.text === a.content)));

    r = await webhook(s, payload);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { received: true });
    const o = (await s.req('GET', `/api/orders/${id}?t=${token}`)).body;
    assert.equal(o.status, 'paid');
    assert.equal(o.paymentRef, 'BANK-0001');
    assert.ok(o.paidAt);

    r = await webhook(s, payload);
    assert.deepEqual(r.body, { received: true, duplicate: true });
    // ใช้ชื่อสำรอง orderNumber/paymentReference ได้ และออเดอร์ที่จ่ายแล้วถือว่าซ้ำ
    r = await webhook(s, { orderNumber: id, amount: '159.00', paymentReference: 'BANK-0002' });
    assert.deepEqual(r.body, { received: true, duplicate: true });

    const audit = (await s.readData('audit')).filter((a) => a.orderId === id).map((a) => [a.to, a.actor]);
    assert.deepEqual(audit.at(-1), ['paid', 'webhook']);
  });

  test('ออเดอร์ expired ได้ webhook ยอดถูก → paid', async () => {
    const { id } = (await s.req('POST', '/api/orders', mlOrder())).body;
    assert.ok(await waitFor(async () => (await s.readData('orders')).find((o) => o.id === id).status === 'expired', 6000));
    const r = await webhook(s, { orderId: id, amount: 159, paymentRef: 'BANK-LATE' });
    assert.equal(r.status, 200);
    assert.equal((await s.readData('orders')).find((o) => o.id === id).status, 'paid');
  });

  test('ออเดอร์ที่ยกเลิกแล้วได้เงิน → 409 + แจ้งเตือนให้คืนเงิน', async () => {
    const auth = await adminAuth(s);
    const { id } = (await s.req('POST', '/api/orders', mlOrder())).body;
    await s.req('POST', `/api/admin/orders/${id}/status`, { status: 'cancelled' }, auth);
    const r = await webhook(s, { orderId: id, amount: 159, paymentRef: 'BANK-CXL' });
    assert.equal(r.status, 409);
    assert.ok(await waitFor(() => alert.alerts.some((a) => a.content.includes(id) && /คืนเงิน/.test(a.content))));
  });

  test('ลูกค้าแจ้งโอน → แจ้งเตือนแอดมิน', async () => {
    const { id, token } = (await s.req('POST', '/api/orders', mlOrder())).body;
    await s.req('POST', `/api/orders/${id}/notify`, { t: token, note: 'โอนจาก KBank' });
    assert.ok(await waitFor(() => alert.alerts.some((a) => a.content.includes(id) && /แจ้งโอน/.test(a.content))));
  });

  test('ไม่ตั้ง PAYMENT_WEBHOOK_SECRET → webhook 404', async () => {
    const s2 = await startServer();
    try {
      const r = await s2.req('POST', '/api/webhooks/payment', { orderId: 'x', amount: 1, paymentRef: 'y' });
      assert.equal(r.status, 404);
    } finally {
      await s2.stop();
    }
  });
});

describe('Phase 2 — เติมอัตโนมัติผ่าน supplier', () => {
  test('supplier ตอบ 500 สองครั้งแล้ว 200 → completed และ job attempts 3', async () => {
    const calls = [];
    const sup = await fakeServer((app) =>
      app.post('/topups', (req, res) => {
        calls.push({ body: req.body, auth: req.headers.authorization, key: req.headers['idempotency-key'] });
        if (calls.length < 3) return res.status(500).json({ error: 'ระบบล่ม' });
        res.json({ status: 'success', reference: 'SUP-777' });
      })
    );
    const s = await startServer({
      SUPPLIER_API_URL: sup.url, SUPPLIER_API_KEY: 'sk_test', PAYMENT_WEBHOOK_SECRET: SECRET, FULFILL_RETRY_BASE_SECONDS: '0.2',
    });
    try {
      assert.equal((await s.req('GET', '/api/config')).body.autoFulfill, true);
      const { id } = (await s.req('POST', '/api/orders', mlOrder())).body;
      await webhook(s, { orderId: id, amount: 159, paymentRef: 'BANK-SUP' });
      const done = await waitFor(async () => (await s.readData('orders')).find((o) => o.id === id).status === 'completed', 8000);
      assert.ok(done, 'ออเดอร์ควรจบที่ completed');
      const order = (await s.readData('orders')).find((o) => o.id === id);
      assert.equal(order.supplierRef, 'SUP-777');
      assert.deepEqual(order.history.map((h) => h.status), ['pending_payment', 'paid', 'processing', 'completed']);
      const job = (await s.readData('jobs')).find((j) => j.orderId === id);
      assert.equal(job.attempts, 3);
      assert.equal(job.done, true);
      assert.equal(job.result, 'completed');
      assert.deepEqual(calls[0], {
        body: { sku: 'MOBILE-LEGENDS-3', player: { uid: '123456789', zone: '1234' }, reference: id },
        auth: 'Bearer sk_test',
        key: id,
      });
    } finally {
      await s.stop();
      await sup.close();
    }
  });

  test('supplier ตอบ 500 ตลอด → refund_needed และแจ้งเตือน / แอดมินกดยืนยันยอดก็เข้าคิว', async () => {
    let calls = 0;
    const sup = await fakeServer((app) => app.post('/topups', (req, res) => { calls++; res.status(500).json({}); }));
    const alert = await fakeAlerts();
    const s = await startServer({
      SUPPLIER_API_URL: sup.url, SUPPLIER_API_KEY: 'sk_test', FULFILL_RETRY_BASE_SECONDS: '0.1',
      FULFILL_ATTEMPTS: '3', ADMIN_ALERT_WEBHOOK: alert.url,
    });
    try {
      const auth = await adminAuth(s);
      const { id } = (await s.req('POST', '/api/orders', mlOrder())).body;
      await s.req('POST', `/api/admin/orders/${id}/status`, { status: 'paid' }, auth);
      assert.ok(await waitFor(async () => (await s.readData('orders')).find((o) => o.id === id).status === 'refund_needed', 8000));
      assert.equal(calls, 3);
      const job = (await s.readData('jobs')).find((j) => j.orderId === id);
      assert.equal(job.result, 'failed');
      assert.match(job.lastError, /HTTP 500/);
      assert.ok(await waitFor(() => alert.alerts.some((a) => a.content.includes(id) && /เติมไม่สำเร็จ/.test(a.content))));
    } finally {
      await s.stop();
      await sup.close();
      await alert.close();
    }
  });

  test('supplier ตอบ 200 แต่สถานะ pending → ไม่ตั้ง completed', async () => {
    const sup = await fakeServer((app) => app.post('/topups', (req, res) => res.json({ status: 'pending' })));
    const s = await startServer({
      SUPPLIER_API_URL: sup.url, SUPPLIER_API_KEY: 'sk_test', FULFILL_RETRY_BASE_SECONDS: '0.1', FULFILL_ATTEMPTS: '2',
    });
    try {
      const auth = await adminAuth(s);
      const { id } = (await s.req('POST', '/api/orders', mlOrder())).body;
      await s.req('POST', `/api/admin/orders/${id}/status`, { status: 'paid' }, auth);
      assert.ok(await waitFor(async () => (await s.readData('orders')).find((o) => o.id === id).status === 'refund_needed', 6000));
    } finally {
      await s.stop();
      await sup.close();
    }
  });
});

describe('Phase 2 — SSE real-time', () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  test('ส่งสถานะปัจจุบันทันที และ push เมื่อแอดมินเปลี่ยนสถานะภายใน 1 วินาที', async () => {
    const { id, token } = (await s.req('POST', '/api/orders', mlOrder())).body;
    assert.equal((await s.req('GET', `/api/orders/${id}/events?t=bad`)).status, 404);

    const ac = new AbortController();
    const res = await fetch(`${s.base}/api/orders/${id}/events?t=${token}`, { signal: ac.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const nextStatus = async () => {
      for (;;) {
        const m = buf.match(/event: status\ndata: (.*)\n\n/);
        if (m) { buf = buf.slice(m.index + m[0].length); return JSON.parse(m[1]).status; }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ปิด');
        buf += dec.decode(value, { stream: true });
      }
    };
    try {
      assert.equal(await nextStatus(), 'pending_payment');
      const auth = await adminAuth(s);
      const t0 = Date.now();
      await s.req('POST', `/api/admin/orders/${id}/status`, { status: 'paid' }, auth);
      assert.equal(await nextStatus(), 'paid');
      assert.ok(Date.now() - t0 < 1000, 'ควรได้รับภายใน 1 วินาที');
    } finally {
      ac.abort();
    }
  });
});

describe('Phase 2 — security', () => {
  test('login ผิด 6 ครั้งติด → 429 พร้อม Retry-After', async () => {
    const s = await startServer({ RATE_LIMIT_OFF: '0' });
    try {
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await s.req('POST', '/api/admin/login', { password: 'wrong' })).status);
      assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
      const r = await s.req('POST', '/api/admin/login', { password: 'wrong' });
      assert.equal(r.body.error, 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่');
      assert.ok(Number(r.headers.get('retry-after')) > 0);
    } finally {
      await s.stop();
    }
  });

  test('security headers ครบ ไม่มี x-powered-by และ CORS เฉพาะ FRONTEND_ORIGIN', async () => {
    const s = await startServer({ FRONTEND_ORIGIN: 'https://rewchen.github.io' });
    try {
      for (const url of ['/api/games', '/index.html']) {
        const r = await s.req('GET', url);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(r.headers.get('x-frame-options'), 'DENY');
        assert.equal(r.headers.get('referrer-policy'), 'same-origin');
        assert.ok(r.headers.get('permissions-policy'));
        assert.equal(r.headers.get('x-powered-by'), null);
      }
      let r = await s.req('GET', '/api/games', undefined, { origin: 'https://rewchen.github.io' });
      assert.equal(r.headers.get('access-control-allow-origin'), 'https://rewchen.github.io');
      r = await s.req('GET', '/api/games', undefined, { origin: 'https://evil.example' });
      assert.equal(r.headers.get('access-control-allow-origin'), null);
      r = await s.req('OPTIONS', '/api/orders', undefined, { origin: 'https://rewchen.github.io', 'access-control-request-method': 'POST' });
      assert.equal(r.status, 204);
    } finally {
      await s.stop();
    }
  });

  test('NODE_ENV=production กับรหัสผ่านอ่อน → ไม่ยอม start', async () => {
    for (const pw of ['', 'change-me-please', 'short-pw']) {
      const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT, env: { ...process.env, ...BASE_ENV, NODE_ENV: 'production', ADMIN_PASSWORD: pw }, stdio: 'pipe',
      });
      let err = '';
      proc.stderr.on('data', (d) => (err += d));
      const code = await new Promise((r) => proc.on('exit', r));
      assert.equal(code, 1, `รหัสผ่าน "${pw}" ไม่ควรผ่าน`);
      assert.match(err, /ADMIN_PASSWORD/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Phase 3 — หลังบ้าน', () => {
  let s, sup, auth;
  let supplierFails = false;
  before(async () => {
    sup = await fakeServer((app) =>
      app.post('/topups', (req, res) => (supplierFails ? res.status(500).json({}) : res.json({ status: 'success', reference: 'SUP-' + req.body.reference })))
    );
    s = await startServer({
      SUPPLIER_API_URL: sup.url, SUPPLIER_API_KEY: 'sk_test', FULFILL_RETRY_BASE_SECONDS: '0.1', FULFILL_ATTEMPTS: '2', LOOKUP_MOCK: '1',
    });
    auth = await adminAuth(s);
  });
  after(async () => { await s.stop(); await sup.close(); });

  const statusOf = async (id) => (await s.readData('orders')).find((o) => o.id === id).status;

  test('ต้อง login ทุก API และ logout แล้ว token ใช้ไม่ได้', async () => {
    for (const url of ['/api/admin/stats', '/api/admin/orders', '/api/admin/games']) {
      assert.equal((await s.req('GET', url)).status, 401);
    }
    const temp = await adminAuth(s);
    assert.equal((await s.req('GET', '/api/admin/stats', undefined, temp)).status, 200);
    await s.req('POST', '/api/admin/logout', undefined, temp);
    assert.equal((await s.req('GET', '/api/admin/stats', undefined, temp)).status, 401);
  });

  test('ค้นหาด้วยเลข UID / LINE / เลขออเดอร์ แล้วเจอ และกรองตามสถานะได้', async () => {
    const { id, token } = (await s.req('POST', '/api/orders', mlOrder({ playerInputs: { uid: '777123456', zone: '4321' } }))).body;
    await s.req('POST', `/api/orders/${id}/notify`, { t: token, lineId: 'line_findme' });

    let r = await s.req('GET', '/api/admin/orders?q=777123456', undefined, auth);
    assert.deepEqual(r.body.map((o) => o.id), [id]);
    assert.ok(!('token' in r.body[0]));
    r = await s.req('GET', '/api/admin/orders?q=LINE_FINDME', undefined, auth);
    assert.deepEqual(r.body.map((o) => o.id), [id]);
    r = await s.req('GET', `/api/admin/orders?q=${id.toLowerCase()}`, undefined, auth);
    assert.deepEqual(r.body.map((o) => o.id), [id]);
    r = await s.req('GET', '/api/admin/orders?q=777123456&status=paid_pending_review', undefined, auth);
    assert.equal(r.body.length, 1);
    r = await s.req('GET', '/api/admin/orders?q=777123456&status=completed', undefined, auth);
    assert.equal(r.body.length, 0);
    r = await s.req('GET', '/api/admin/orders?q=ไม่มีแน่นอน', undefined, auth);
    assert.equal(r.body.length, 0);
  });

  test('กด "ยืนยันยอดเข้าแล้ว" ตอนเปิด supplier → autoFulfillQueued และจบ completed เอง', async () => {
    const { id, token } = (await s.req('POST', '/api/orders', mlOrder())).body;
    await s.req('POST', `/api/orders/${id}/notify`, { t: token });
    const r = await s.req('POST', `/api/admin/orders/${id}/status`, { status: 'paid', note: 'เช็คยอดในแอปแล้ว' }, auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.autoFulfillQueued, true);
    assert.ok(await waitFor(async () => (await statusOf(id)) === 'completed', 5000));

    // audit แสดงครบทุกการเปลี่ยนสถานะ พร้อมผู้ทำ
    const audit = (await s.req('GET', `/api/admin/orders/${id}/audit`, undefined, auth)).body;
    assert.deepEqual(audit.map((a) => [a.from || null, a.to, a.actor]), [
      [null, 'pending_payment', 'customer'],
      ['pending_payment', 'paid_pending_review', 'customer'],
      ['paid_pending_review', 'paid', 'admin'],
      ['paid', 'processing', 'system'],
      ['processing', 'completed', 'system'],
    ]);
    assert.equal(audit[2].note, 'เช็คยอดในแอปแล้ว');
    assert.equal((await s.req('GET', '/api/admin/orders/NOPE/audit', undefined, auth)).status, 404);
  });

  test('stats: นับตามสถานะ + ยอดขายวันนี้ + ป้ายโหมด', async () => {
    const st = (await s.req('GET', '/api/admin/stats', undefined, auth)).body;
    const orders = (await s.readData('orders'));
    for (const status of ['pending_payment', 'paid_pending_review', 'completed']) {
      assert.equal(st.byStatus[status], orders.filter((o) => o.status === status).length, status);
    }
    const completed = orders.filter((o) => o.status === 'completed').reduce((a, o) => a + o.amount, 0);
    assert.equal(st.revenueToday, completed);
    assert.ok(st.revenueToday > 0);
    assert.deepEqual([st.autoFulfill, st.webhookEnabled, st.lookupEnabled], [true, false, true]);
  });

  test('เติมไม่สำเร็จ → refund_needed → "เติมใหม่" → completed', async () => {
    supplierFails = true;
    const { id } = (await s.req('POST', '/api/orders', mlOrder())).body;
    await s.req('POST', `/api/admin/orders/${id}/status`, { status: 'paid' }, auth);
    assert.ok(await waitFor(async () => (await statusOf(id)) === 'refund_needed', 5000));

    let r = await s.req('POST', `/api/admin/orders/${id}/retry`, {}, auth);
    supplierFails = false;
    assert.equal(r.status, 200);
    assert.equal(r.body.autoFulfillQueued, true);
    assert.ok(await waitFor(async () => (await statusOf(id)) === 'completed', 5000));
    assert.equal((await s.readData('orders')).find((o) => o.id === id).supplierRef, 'SUP-' + id);

    r = await s.req('POST', `/api/admin/orders/${id}/retry`, {}, auth);
    assert.equal(r.status, 400); // completed แล้ว สั่งเติมใหม่ไม่ได้
  });

  test('บันทึกเกมที่ id แพ็กเกจซ้ำ → error บอกชื่อแพ็กที่ซ้ำ / ถูกต้อง → บันทึก + audit', async () => {
    const games = (await s.req('GET', '/api/admin/games', undefined, auth)).body;
    assert.ok(games[0].packages[0].sku, 'หลังบ้านต้องเห็น sku');
    const dup = structuredClone(games);
    dup[1].packages[0].id = 'rov-2';
    let r = await s.req('PUT', '/api/admin/games', dup, auth);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /เพชร 86/);
    assert.match(r.body.error, /rov-2/);
    assert.match(r.body.error, /Garena RoV/);

    const bad = structuredClone(games);
    bad[2].fields[0].pattern = '[';
    r = await s.req('PUT', '/api/admin/games', bad, auth);
    assert.match(r.body.error, /Genshin Impact/);

    const priced = structuredClone(games);
    priced[0].packages[0].price = 10.555;
    r = await s.req('PUT', '/api/admin/games', priced, auth);
    assert.match(r.body.error, /ทศนิยม/);

    const ok = structuredClone(games);
    ok[0].packages[0].price = 36;
    r = await s.req('PUT', '/api/admin/games', ok, auth);
    assert.equal(r.status, 200);
    assert.equal((await s.req('GET', '/api/games/rov')).body.packages[0].price, 36);
    assert.ok((await s.readData('audit')).some((a) => a.action === 'games_update' && a.actor === 'admin'));
  });
});

// ---------------------------------------------------------------------------
describe('Phase 4 — GitHub Pages และเอกสาร', () => {
  const PUBLIC = path.join(ROOT, 'public');
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));

  test('ไม่มี path แบบ absolute ใน public/ (รันใต้ /Project-Koinz/ ได้)', () => {
    for (const page of pages) {
      const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
      const bad = html.match(/(?:href|src)="\/(?!\/)[^"]*"|location\.href\s*=\s*[`'"]\//g);
      assert.equal(bad, null, `${page}: ${bad}`);
    }
  });

  test('เปิดผ่าน static server ที่ /Project-Koinz/ แล้วโหลด CSS/JS ได้ทุกหน้า', async () => {
    const srv = await fakeServer((app) => app.use('/Project-Koinz', express.static(PUBLIC)));
    try {
      const base = `${srv.url}/Project-Koinz/`;
      const index = await fetch(base);
      assert.equal(index.status, 200);
      for (const page of pages) {
        const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
        const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
          .map((m) => m[1])
          .filter((u) => !/^(https?:|\/\/|#|data:|mailto:|\$\{)/.test(u) && !u.includes('${'));
        assert.ok(refs.includes('css/style.css') && refs.includes('js/config.js') && refs.includes('js/common.js'), page);
        for (const ref of refs) {
          const url = new URL(ref, base + page);
          const r = await fetch(url);
          assert.equal(r.status, 200, `${page} → ${ref}`);
        }
      }
      // config.js ต้องโหลดก่อน common.js
      for (const page of pages) {
        const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
        assert.ok(html.indexOf('js/config.js') < html.indexOf('js/common.js'), page);
      }
    } finally {
      await srv.close();
    }
  });

  test('README อธิบายตัวแปร .env ครบทุกตัวที่โค้ดอ่าน และ .env.example มีครบ', () => {
    const files = ['server.js'];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.js')) files.push(rel);
      }
    };
    walk('src');
    walk('db');
    const code = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const vars = [...new Set([...code.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))];
    assert.ok(vars.length >= 20, `อ่าน env ได้ ${vars.length} ตัว`);
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const v of vars) {
      assert.match(readme, new RegExp('`' + v + '`'), `README ไม่มี ${v}`);
      if (v !== 'KOINZ_DATA_DIR') assert.match(example, new RegExp('^' + v + '=', 'm'), `.env.example ไม่มี ${v}`);
    }
  });
});
