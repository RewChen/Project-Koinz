// createApp(): สร้าง Express app พร้อมทุก route (แยกจาก server.js เพื่อให้เทสได้)
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');
const store = require('./store');
const catalog = require('./catalog');
const orders = require('./orders');
const adapters = require('./adapters');
const { promptPayPayload } = require('./promptpay');

const fail = (res, code, error) => res.status(code).json({ error });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const text = (v, max) => String(v ?? '').trim().slice(0, max);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sendTransitionError(res, e) {
  if (!(e instanceof orders.TransitionError)) throw e;
  const code = { not_found: 404, conflict: 409 }[e.code] || 400;
  return fail(res, code, e.message);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- public API ----------
  app.get('/api/config', (req, res) => {
    res.json({
      shopName: config.shopName,
      promptPayName: config.promptPayName,
      shopLineUrl: config.shopLineUrl,
      lookupEnabled: adapters.lookupEnabled(),
      autoFulfill: config.autoFulfill,
      orderTtlMinutes: config.orderTtlMinutes,
    });
  });

  app.get('/api/games', (req, res) => {
    res.json(catalog.getGames().filter((g) => g.active !== false).map(catalog.publicSummary));
  });

  app.get('/api/games/:slug', (req, res) => {
    const game = catalog.findGame(req.params.slug);
    if (!game) return fail(res, 404, 'ไม่พบเกมนี้');
    res.json(catalog.publicGame(game));
  });

  app.post('/api/player/lookup', wrap(async (req, res) => {
    const { gameSlug, playerInputs } = req.body || {};
    const game = catalog.findGame(gameSlug);
    if (!game) return fail(res, 400, 'ไม่พบเกมที่เลือก');
    const { inputs, error } = catalog.validateInputs(game, playerInputs);
    if (error) return fail(res, 400, error);
    if (!adapters.lookupEnabled()) return fail(res, 404, 'ระบบตรวจชื่อในเกมยังไม่เปิดใช้งาน');
    try {
      res.json(await adapters.lookupNickname(game, inputs));
    } catch (e) {
      if (!(e instanceof adapters.AdapterError)) throw e;
      fail(res, e.status, e.message);
    }
  }));

  app.post('/api/orders', wrap(async (req, res) => {
    const body = req.body || {};
    const key = body.idempotencyKey;
    const hasKey = key !== undefined && key !== null && key !== '';
    if (hasKey && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))) {
      return fail(res, 400, 'รหัสคำสั่งซื้อ (idempotencyKey) ไม่ถูกต้อง');
    }
    const replay = () => {
      const o = hasKey && orders.findByIdempotencyKey(key);
      return o ? res.status(200).json({ id: o.id, token: o.token }) : null;
    };
    if (replay()) return;

    const game = catalog.findGame(body.gameSlug);
    if (!game) return fail(res, 400, 'ไม่พบเกมที่เลือก');
    const pkg = catalog.findPackage(game, body.packageId);
    if (!pkg) return fail(res, 400, 'กรุณาเลือกแพ็กเกจ');
    const { inputs, error } = catalog.validateInputs(game, body.playerInputs);
    if (error) return fail(res, 400, error);

    // ลองดึงชื่อในเกม (ล้มเหลวก็สร้างออเดอร์ต่อได้)
    let playerNickname = null;
    if (adapters.lookupEnabled()) {
      try {
        playerNickname = (await adapters.lookupNickname(game, inputs)).nickname;
      } catch { /* ไม่เป็นไร */ }
    }
    // ระหว่างรอตรวจชื่อ อาจมีคำขอซ้ำที่สร้างออเดอร์ไปแล้ว
    if (replay()) return;

    const order = orders.create({
      gameSlug: game.slug,
      gameName: game.name,
      packageId: pkg.id,
      packageName: pkg.name,
      sku: pkg.sku || null,
      playerInputs: inputs,
      playerLabel: catalog.playerLabel(game, inputs),
      playerNickname,
      contact: text(body.contact, 100),
      amount: pkg.price,
      expiresAt: new Date(Date.now() + config.orderTtlMinutes * 60000).toISOString(),
      idempotencyKey: hasKey ? key : null,
    });
    res.status(201).json({ id: order.id, token: order.token });
  }));

  function findOrderForCustomer(req, res) {
    const token = req.query.t || (req.body && req.body.t);
    const order = orders.find(req.params.id);
    if (!order || !token || !safeEqual(order.token, token)) {
      fail(res, 404, 'ไม่พบออเดอร์ หรือลิงก์ไม่ถูกต้อง');
      return null;
    }
    return order;
  }

  app.get('/api/orders/:id', wrap(async (req, res) => {
    const order = findOrderForCustomer(req, res);
    if (!order) return;
    const data = orders.publicView(order);
    data.serverTime = new Date().toISOString();
    const open = !order.expiresAt || Date.parse(order.expiresAt) > Date.now();
    if (order.status === 'pending_payment' && open) {
      const payload = promptPayPayload(config.promptPayId, order.amount);
      data.qr = await QRCode.toDataURL(payload, { margin: 1, width: 320 });
      data.promptPayName = config.promptPayName;
    }
    res.json(data);
  }));

  app.post('/api/orders/:id/notify', (req, res) => {
    const order = findOrderForCustomer(req, res);
    if (!order) return;
    try {
      orders.transition(order.id, 'paid_pending_review', 'customer', {
        from: ['pending_payment', 'expired'],
        patch: { customerNote: text(req.body.note, 200), lineId: text(req.body.lineId, 60) },
      });
    } catch (e) {
      if (e instanceof orders.TransitionError && e.code !== 'not_found') {
        return fail(res, 400, 'ออเดอร์นี้แจ้งชำระไปแล้ว หรือไม่อยู่ในสถานะที่แจ้งโอนได้');
      }
      return sendTransitionError(res, e);
    }
    res.json({ ok: true });
  });

  // ---------- admin API ----------
  const sessions = new Map(); // token -> expires
  const SESSION_MS = 8 * 60 * 60 * 1000;

  app.post('/api/admin/login', (req, res) => {
    if (!safeEqual((req.body && req.body.password) || '', config.adminPassword)) {
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
    res.json(orders.all().reverse().map(orders.adminView));
  });

  app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
    const { status, note } = req.body || {};
    try {
      orders.transition(req.params.id, status, 'admin', { note: text(note, 200) });
    } catch (e) {
      return sendTransitionError(res, e);
    }
    res.json({ ok: true });
  });

  app.get('/api/admin/games', requireAdmin, (req, res) => res.json(catalog.getGames()));

  app.put('/api/admin/games', requireAdmin, (req, res) => {
    const error = catalog.validateGames(req.body);
    if (error) return fail(res, 400, error);
    store.write('games', req.body);
    orders.audit({ action: 'games_update', actor: 'admin', note: `${req.body.length} เกม` });
    res.json({ ok: true });
  });

  // ---------- error handler ----------
  app.use('/api', (req, res) => fail(res, 404, 'ไม่พบ API นี้'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'รูปแบบข้อมูลไม่ถูกต้อง');
    if (err.type === 'entity.too.large') return fail(res, 413, 'ข้อมูลมีขนาดใหญ่เกินไป');
    console.error(err);
    fail(res, 500, 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง');
  });

  return app;
}

module.exports = { createApp };
