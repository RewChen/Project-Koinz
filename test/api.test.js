// เทส API แบบ end-to-end: เปิด server.js เป็น process แยก พร้อมโฟลเดอร์ข้อมูลชั่วคราว
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
  LOOKUP_API_URL: '',
  LOOKUP_API_KEY: '',
  LOOKUP_MOCK: '0',
  ADMIN_ALERT_WEBHOOK: '',
  FRONTEND_ORIGIN: '',
  TRUST_PROXY: '',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koinz-test-'));
  fs.copyFileSync(GAMES, path.join(dataDir, 'games.json'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...BASE_ENV, KOINZ_DATA_DIR: dataDir, ...env },
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

  const readData = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8')); } catch { return null; }
  };

  async function stop() {
    if (proc.exitCode === null) {
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
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
    const o = s.readData('orders').find((x) => x.id === r.body.id);
    assert.deepEqual(o.playerInputs, { uid: '123456789', zone: '1234' });
    assert.equal(o.playerLabel, 'User ID 123456789 · Zone ID 1234');
    assert.equal(o.amount, 159);
    assert.equal(o.playerNickname, null);
    assert.ok(Date.parse(o.expiresAt) - Date.parse(o.createdAt) === 15 * 60000);

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
    assert.equal(s.readData('orders').filter((o) => o.idempotencyKey === key).length, 1);
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
    const audit = s.readData('audit').filter((a) => a.orderId === o.id);
    assert.deepEqual(audit.map((a) => [a.to, a.actor]), [
      ['pending_payment', 'customer'],
      ['paid', 'admin'],
      ['completed', 'admin'],
    ]);
    const saved = s.readData('orders').find((x) => x.id === o.id);
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

    const audit = s.readData('audit').filter((a) => a.orderId === id);
    assert.deepEqual(audit.map((a) => [a.to, a.actor]), [
      ['pending_payment', 'customer'],
      ['expired', 'system'],
      ['paid_pending_review', 'customer'],
    ]);
    const saved = s.readData('orders').find((x) => x.id === id);
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
      assert.equal(s.readData('orders').find((o) => o.id === id).playerNickname, r.body.nickname);
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
