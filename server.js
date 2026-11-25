require('./src/env');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const store = require('./src/store');
const { promptPayPayload } = require('./src/promptpay');

const PORT = Number(process.env.PORT) || 3000;
const SHOP_NAME = process.env.SHOP_NAME || 'Koinz';
const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '0812345678';
const PROMPTPAY_NAME = process.env.PROMPTPAY_NAME || 'ร้าน Koinz';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

const STATUSES = ['pending_payment', 'paid_pending_review', 'processing', 'completed', 'cancelled'];

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const getGames = () => store.read('games', []);
const getOrders = () => store.read('orders', []);
const saveOrders = (orders) => store.write('orders', orders);
const now = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ error });

function publicOrder(o) {
  const { token, contact, ...rest } = o;
  return rest;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- public API ----------
app.get('/api/config', (req, res) => {
  res.json({ shopName: SHOP_NAME, promptPayName: PROMPTPAY_NAME });
});

app.get('/api/games', (req, res) => {
  const games = getGames()
    .filter((g) => g.active !== false)
    .map(({ packages, ...g }) => ({
      ...g,
      minPrice: Math.min(...packages.map((p) => p.price)),
    }));
  res.json(games);
});

app.get('/api/games/:slug', (req, res) => {
  const game = getGames().find((g) => g.slug === req.params.slug && g.active !== false);
  if (!game) return fail(res, 404, 'ไม่พบเกมนี้');
  res.json(game);
});

app.post('/api/orders', (req, res) => {
  const { gameSlug, packageId, playerId, server, contact } = req.body || {};
  const game = getGames().find((g) => g.slug === gameSlug && g.active !== false);
  if (!game) return fail(res, 400, 'ไม่พบเกมที่เลือก');
  const pkg = game.packages.find((p) => p.id === packageId);
  if (!pkg) return fail(res, 400, 'กรุณาเลือกแพ็กเกจ');

  const pid = String(playerId || '').trim();
  if (!/^[A-Za-z0-9_\-#.]{3,40}$/.test(pid)) {
    return fail(res, 400, 'UID ต้องเป็นตัวอักษรหรือตัวเลข 3–40 ตัว');
  }
  if (game.servers && game.servers.length && !game.servers.includes(server)) {
    return fail(res, 400, 'กรุณาเลือกเซิร์ฟเวอร์');
  }
  const contactStr = String(contact || '').trim().slice(0, 100);
  if (!contactStr) return fail(res, 400, 'กรุณากรอกเบอร์โทรหรือ LINE ID เพื่อให้ร้านติดต่อกลับ');

  const order = {
    id: 'KZ' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
    token: crypto.randomBytes(16).toString('hex'),
    gameSlug: game.slug,
    gameName: game.name,
    packageId: pkg.id,
    packageName: pkg.name,
    playerId: pid,
    server: server || null,
    contact: contactStr,
    amount: pkg.price,
    status: 'pending_payment',
    customerNote: '',
    createdAt: now(),
    history: [{ status: 'pending_payment', at: now() }],
  };
  const orders = getOrders();
  orders.push(order);
  saveOrders(orders);
  res.status(201).json({ id: order.id, token: order.token });
});

function findOrderForCustomer(req, res) {
  const token = req.query.t || (req.body && req.body.t);
  const order = getOrders().find((o) => o.id === req.params.id);
  if (!order || !token || !safeEqual(order.token, token)) {
    fail(res, 404, 'ไม่พบออเดอร์ หรือลิงก์ไม่ถูกต้อง');
    return null;
  }
  return order;
}

app.get('/api/orders/:id', async (req, res) => {
  const order = findOrderForCustomer(req, res);
  if (!order) return;
  const data = publicOrder(order);
  if (order.status === 'pending_payment') {
    const payload = promptPayPayload(PROMPTPAY_ID, order.amount);
    data.qr = await QRCode.toDataURL(payload, { margin: 1, width: 320 });
    data.promptPayName = PROMPTPAY_NAME;
  }
  res.json(data);
});

app.post('/api/orders/:id/notify', (req, res) => {
  const orders = getOrders();
  const found = findOrderForCustomer(req, res);
  if (!found) return;
  const order = orders.find((o) => o.id === found.id);
  if (order.status !== 'pending_payment') return fail(res, 400, 'ออเดอร์นี้แจ้งชำระไปแล้ว');
  order.status = 'paid_pending_review';
  order.customerNote = String(req.body.note || '').trim().slice(0, 200);
  order.history.push({ status: order.status, at: now() });
  saveOrders(orders);
  res.json({ ok: true });
});

// ---------- admin API ----------
const sessions = new Map(); // token -> expires
const SESSION_MS = 8 * 60 * 60 * 1000;

app.post('/api/admin/login', (req, res) => {
  if (!safeEqual((req.body && req.body.password) || '', ADMIN_PASSWORD)) {
    return fail(res, 401, 'รหัสผ่านไม่ถูกต้อง');
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    sessions.delete(token);
    return fail(res, 401, 'กรุณาเข้าสู่ระบบใหม่');
  }
  next();
}

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = getOrders().slice().reverse().map(({ token, ...o }) => o);
  res.json(orders);
});

app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return fail(res, 400, 'สถานะไม่ถูกต้อง');
  const orders = getOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return fail(res, 404, 'ไม่พบออเดอร์');
  order.status = status;
  order.history.push({ status, at: now() });
  saveOrders(orders);
  res.json({ ok: true });
});

app.get('/api/admin/games', requireAdmin, (req, res) => res.json(getGames()));

app.put('/api/admin/games', requireAdmin, (req, res) => {
  const games = req.body;
  const valid =
    Array.isArray(games) &&
    games.every(
      (g) =>
        g && typeof g.slug === 'string' && /^[a-z0-9-]+$/.test(g.slug) &&
        typeof g.name === 'string' && Array.isArray(g.packages) && g.packages.length > 0 &&
        g.packages.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Number(p.price) > 0)
    );
  if (!valid) return fail(res, 400, 'ข้อมูลเกมไม่ถูกต้อง: ทุกเกมต้องมี slug, name และ packages (id, name, price)');
  store.write('games', games);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ ${SHOP_NAME} พร้อมใช้งานที่ http://localhost:${PORT}`);
  console.log(`🔐 หลังบ้าน: http://localhost:${PORT}/admin.html`);
  if (!process.env.ADMIN_PASSWORD) console.log('⚠️  ยังไม่ได้ตั้ง ADMIN_PASSWORD ในไฟล์ .env (ใช้ค่าเริ่มต้น admin1234)');
});
