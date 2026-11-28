// createApp(): สร้าง Express app พร้อมทุก route (แยกจาก server.js เพื่อให้เทสได้)
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');
const catalog = require('./catalog');
const orders = require('./orders');
const adapters = require('./adapters');
const security = require('./security');
const jobs = require('./jobs');
const { promptPayPayload } = require('./promptpay');

const fail = (res, code, error) => res.status(code).json({ error });
const baht = (n) => '฿' + Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const satang = (n) => Math.round(Number(n) * 100);
const orderLine = (o) => `${o.id} · ${o.gameName} ${o.packageName} · ${o.playerLabel || o.playerId || ''} · ${baht(o.amount)}`;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const isUniqueViolation = (e) => e && e.code === '23505'; // PostgreSQL unique_violation

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
  app.disable('x-powered-by');
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.use(security.securityHeaders);
  app.use('/api', security.cors);
  // เก็บ raw body ไว้ตรวจลายเซ็น webhook
  app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
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
      siteBanner: config.siteBanner,
    });
  });

  app.get('/api/games', wrap(async (req, res) => {
    res.json((await catalog.getGames()).filter((g) => g.active !== false).map(catalog.publicSummary));
  }));

  app.get('/api/games/:slug', wrap(async (req, res) => {
    const game = await catalog.findGame(req.params.slug);
    if (!game) return fail(res, 404, 'ไม่พบเกมนี้');
    res.json(catalog.publicGame(game));
  }));

  app.post('/api/player/lookup', security.limits.lookup, wrap(async (req, res) => {
    const { gameSlug, playerInputs } = req.body || {};
    const game = await catalog.findGame(gameSlug);
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

  app.post('/api/orders', security.limits.createOrder, wrap(async (req, res) => {
    const body = req.body || {};
    const key = body.idempotencyKey;
    const hasKey = key !== undefined && key !== null && key !== '';
    if (hasKey && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))) {
      return fail(res, 400, 'รหัสคำสั่งซื้อ (idempotencyKey) ไม่ถูกต้อง');
    }
    const existing = hasKey && (await orders.findByIdempotencyKey(key));
    if (existing) return res.status(200).json({ id: existing.id, token: existing.token });

    const game = await catalog.findGame(body.gameSlug);
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

    // ที่เก็บข้อมูลกันสั่งซ้ำให้ในจังหวะเดียว (ถ้ามีคำขอซ้ำแทรกเข้ามา จะได้ออเดอร์เดิม)
    const { order, created } = await orders.create({
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
    res.status(created ? 201 : 200).json({ id: order.id, token: order.token });
  }));

  async function findOrderForCustomer(req, res) {
    const token = req.query.t || (req.body && req.body.t);
    const order = await orders.find(req.params.id);
    if (!order || !token || !safeEqual(order.token, token)) {
      fail(res, 404, 'ไม่พบออเดอร์ หรือลิงก์ไม่ถูกต้อง');
      return null;
    }
    return order;
  }

  app.get('/api/orders/:id', wrap(async (req, res) => {
    const order = await findOrderForCustomer(req, res);
    if (!order) return;
    const data = orders.publicView(order);
    data.serverTime = new Date().toISOString();
    const open = !order.expiresAt || Date.parse(order.expiresAt) > Date.now();
    // QR หมดเวลาแล้ว (รวมช่วงไม่กี่วินาทีก่อนตัวกวาดเปลี่ยนสถานะเป็น expired)
    data.expired = order.status === 'expired' || (order.status === 'pending_payment' && !open);
    if (order.status === 'pending_payment' && open) {
      const payload = promptPayPayload(config.promptPayId, order.amount);
      data.qr = await QRCode.toDataURL(payload, { margin: 1, width: 320 });
      data.promptPayName = config.promptPayName;
    }
    res.json(data);
  }));

  // SSE: push สถานะทันทีที่เปลี่ยน (ไม่ poll ฐานข้อมูล)
  app.get('/api/orders/:id/events', wrap(async (req, res) => {
    const order = await findOrderForCustomer(req, res);
    if (!order) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (status, updatedAt) => res.write(`event: status\ndata: ${JSON.stringify({ status, updatedAt })}\n\n`);
    res.write('retry: 5000\n\n');
    send(order.status, order.updatedAt);
    const onStatus = (id, to, o) => {
      if (id === order.id) send(to, o && o.updatedAt);
    };
    orders.bus.on('status', onStatus);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      orders.bus.off('status', onStatus);
    });
  }));

  app.post('/api/orders/:id/notify', security.limits.notify, wrap(async (req, res) => {
    const order = await findOrderForCustomer(req, res);
    if (!order) return;
    try {
      await orders.transition(order.id, 'paid_pending_review', 'customer', {
        from: ['pending_payment', 'expired'],
        patch: { customerNote: text(req.body.note, 200), lineId: text(req.body.lineId, 50) },
      });
    } catch (e) {
      if (e instanceof orders.TransitionError && e.code !== 'not_found') {
        return fail(res, 400, 'ออเดอร์นี้แจ้งชำระไปแล้ว หรือไม่อยู่ในสถานะที่แจ้งโอนได้');
      }
      return sendTransitionError(res, e);
    }
    const note = text(req.body.note, 200);
    adapters.sendAlert(
      `💸 ลูกค้าแจ้งโอน${order.status === 'expired' ? ' (หลังหมดเวลา)' : ''} รอตรวจยอด: ${orderLine(order)}${note ? ` · หมายเหตุ: ${note}` : ''}`
    );
    res.json({ ok: true });
  }));

  // ---------- webhook ยืนยันการชำระเงิน ----------
  app.post('/api/webhooks/payment', wrap(async (req, res) => {
    if (!config.webhookEnabled) return fail(res, 404, 'ไม่พบ API นี้');
    const sig = String(req.get('x-payment-signature') || '').trim().replace(/^sha256=/i, '').toLowerCase();
    const expected = crypto.createHmac('sha256', config.paymentWebhookSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(sig) || !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
      return fail(res, 401, 'ลายเซ็นไม่ถูกต้อง');
    }

    const b = req.body || {};
    const orderId = String(b.orderId ?? b.orderNumber ?? '').trim();
    const paymentRef = String(b.paymentRef ?? b.paymentReference ?? '').trim().slice(0, 100);
    const amount = Number(b.amount);
    if (!orderId || !paymentRef || !Number.isFinite(amount)) {
      return fail(res, 400, 'ต้องมี orderId, amount และ paymentRef');
    }

    const duplicate = () => res.json({ received: true, duplicate: true });
    if (await orders.findByPaymentRef(paymentRef)) return duplicate();
    const order = await orders.find(orderId);
    if (!order) return fail(res, 404, 'ไม่พบออเดอร์');

    if (satang(amount) !== satang(order.amount)) {
      adapters.sendAlert(`⚠️ ยอดโอนไม่ตรง: ${orderLine(order)} แต่ได้รับ ${baht(amount)} (ref ${paymentRef})`);
      return fail(res, 409, 'ยอดเงินไม่ตรงกับออเดอร์');
    }
    if (['paid', 'processing', 'completed'].includes(order.status)) return duplicate();
    if (!['pending_payment', 'paid_pending_review', 'expired'].includes(order.status)) {
      adapters.sendAlert(`🚨 ได้รับเงินของออเดอร์สถานะ "${order.status}" ต้องคืนเงินลูกค้า: ${orderLine(order)} (ref ${paymentRef})`);
      return fail(res, 409, `ออเดอร์อยู่ในสถานะ ${order.status} รับชำระไม่ได้`);
    }
    try {
      await orders.transition(order.id, 'paid', 'webhook', {
        from: ['pending_payment', 'paid_pending_review', 'expired'],
        patch: { paymentRef, paidAt: new Date().toISOString() },
      });
    } catch (e) {
      // ส่งซ้ำพร้อมกัน: อีกคำขอจ่ายไปก่อน / paymentRef ชน unique index
      if ((e instanceof orders.TransitionError && e.code === 'conflict') || isUniqueViolation(e)) return duplicate();
      throw e;
    }
    res.json({ received: true });
  }));

  // ---------- admin API ----------
  const sessions = new Map(); // token -> expires
  const SESSION_MS = 8 * 60 * 60 * 1000;

  app.post('/api/admin/login', security.limits.login, (req, res) => {
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

  app.post('/api/admin/logout', (req, res) => {
    sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
    res.json({ ok: true });
  });

  app.get('/api/admin/stats', requireAdmin, wrap(async (req, res) => {
    const { byStatus, revenueToday } = await orders.stats();
    res.json({
      byStatus,
      revenueToday,
      autoFulfill: config.autoFulfill,
      webhookEnabled: config.webhookEnabled,
      lookupEnabled: config.lookupEnabled,
    });
  }));

  app.get('/api/admin/orders', requireAdmin, wrap(async (req, res) => {
    const list = await orders.list({ status: text(req.query.status, 40), q: text(req.query.q, 100), limit: 500 });
    res.json(list.map(orders.adminView));
  }));

  app.get('/api/admin/orders/:id/audit', requireAdmin, wrap(async (req, res) => {
    if (!(await orders.find(req.params.id))) return fail(res, 404, 'ไม่พบออเดอร์');
    res.json(await orders.auditFor(req.params.id));
  }));

  app.post('/api/admin/orders/:id/status', requireAdmin, wrap(async (req, res) => {
    const { status, note } = req.body || {};
    try {
      const patch = status === 'paid' ? { paidAt: new Date().toISOString() } : undefined;
      await orders.transition(req.params.id, status, 'admin', { note: text(note, 200), patch });
    } catch (e) {
      return sendTransitionError(res, e);
    }
    // เข้าคิวที่นี่ด้วยเพื่อตอบได้แน่นอน (คิวกันงานซ้ำกับตัวฟัง event อยู่แล้ว)
    let queued = false;
    if (status === 'paid' && config.autoFulfill) queued = !!(await jobs.enqueueFulfill(req.params.id)).job;
    res.json({ ok: true, autoFulfillQueued: queued || !!(await jobs.activeJobFor(req.params.id)) });
  }));

  // สั่งเติมใหม่ผ่าน supplier
  app.post('/api/admin/orders/:id/retry', requireAdmin, wrap(async (req, res) => {
    if (!config.autoFulfill) return fail(res, 400, 'ยังไม่ได้เปิดระบบเติมอัตโนมัติ (SUPPLIER_API_URL / SUPPLIER_API_KEY)');
    const order = await orders.find(req.params.id);
    if (!order) return fail(res, 404, 'ไม่พบออเดอร์');
    if (!['paid', 'processing', 'refund_needed'].includes(order.status)) {
      return fail(res, 400, 'สั่งเติมใหม่ได้เฉพาะออเดอร์ที่ยืนยันยอดแล้ว กำลังเติม หรือรอคืนเงิน');
    }
    try {
      if (order.status === 'refund_needed') {
        await orders.transition(order.id, 'paid', 'admin', {
          from: 'refund_needed', note: text(req.body && req.body.note, 200) || 'สั่งเติมใหม่',
        });
      }
    } catch (e) {
      return sendTransitionError(res, e);
    }
    const { job } = await jobs.enqueueFulfill(order.id);
    await orders.audit({ orderId: order.id, action: 'retry', actor: 'admin', note: `งาน ${job.id}` });
    res.json({ ok: true, autoFulfillQueued: true, jobId: job.id });
  }));

  app.get('/api/admin/games', requireAdmin, wrap(async (req, res) => res.json(await catalog.getGames())));

  app.put('/api/admin/games', requireAdmin, wrap(async (req, res) => {
    const error = catalog.validateGames(req.body);
    if (error) return fail(res, 400, error);
    await catalog.saveGames(req.body);
    await orders.audit({ action: 'games_update', actor: 'admin', note: `${req.body.length} เกม` });
    res.json({ ok: true });
  }));

  // ---------- error handler ----------
  app.use('/api', (req, res) => fail(res, 404, 'ไม่พบ API นี้'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'รูปแบบข้อมูลไม่ถูกต้อง');
    if (err.type === 'entity.too.large') return fail(res, 413, 'ข้อมูลมีขนาดใหญ่เกินไป');
    console.error(err);
    if (res.headersSent) return res.end();
    fail(res, 500, 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง');
  });

  return app;
}

module.exports = { createApp };
