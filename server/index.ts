import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import { fulfillmentQueue, expirationQueue } from './queue';
import { lookupNickname } from './adapters';
import generatePayload from 'promptpay-qr';
import QRCode from 'qrcode';

const app = express();
const prisma = new PrismaClient();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

const createOrderSchema = z.object({ gameSlug: z.string().min(1), packageId: z.string().min(1), playerInputs: z.record(z.string().trim().min(1)), paymentMethod: z.enum(['PROMPTPAY', 'WALLET']), userId: z.string().optional(), idempotencyKey: z.string().min(12) });
app.post('/api/orders', async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง', details: parsed.error.flatten() });
  const data = parsed.data;
  const prior = await prisma.order.findUnique({ where: { idempotency_key: data.idempotencyKey } });
  if (prior) return res.status(200).json({ order: prior });
  const game = await prisma.game.findUnique({ where: { slug: data.gameSlug, is_active: true }, include: { packages: { where: { is_active: true } } } });
  const pack = game?.packages.find(p => p.id === data.packageId);
  if (!game || !pack) return res.status(404).json({ error: 'ไม่พบเกมหรือแพ็กเกจนี้' });
  const fields = (game.form_schema as any)?.fields ?? [];
  for (const field of fields) {
    const value = data.playerInputs[field.name];
    if (field.required && !value) return res.status(400).json({ error: `กรุณากรอก${field.label}` });
    if (value && field.pattern && !new RegExp(field.pattern).test(value)) return res.status(400).json({ error: `${field.label} มีรูปแบบไม่ถูกต้อง` });
  }
  let nickname: string | undefined;
  try { nickname = (await lookupNickname(game.slug, data.playerInputs)).nickname; } catch { /* optional lookup */ }
  const number = `TP${Date.now().toString().slice(-9)}${crypto.randomInt(100, 999)}`;
  try {
    const order = await prisma.$transaction(async tx => {
      const created = await tx.order.create({ data: { order_number: number, user_id: data.userId, game_id: game.id, package_id: pack.id, player_inputs: data.playerInputs, player_nickname: nickname, amount: pack.selling_price, payment_method: data.paymentMethod, idempotency_key: data.idempotencyKey, expires_at: data.paymentMethod === 'PROMPTPAY' ? new Date(Date.now() + 15 * 60_000) : null } });
      if (data.paymentMethod === 'WALLET') {
        if (!data.userId) throw new Error('WALLET_REQUIRES_MEMBER');
        const updated = await tx.user.updateMany({ where: { id: data.userId, wallet_balance: { gte: pack.selling_price } }, data: { wallet_balance: { decrement: pack.selling_price } } });
        if (updated.count !== 1) throw new Error('INSUFFICIENT_WALLET');
        const user = await tx.user.findUniqueOrThrow({ where: { id: data.userId } });
        await tx.walletTransaction.create({ data: { user_id: user.id, order_id: created.id, type: 'PURCHASE', amount: pack.selling_price, balance_before: user.wallet_balance.add(pack.selling_price), balance_after: user.wallet_balance } });
        return tx.order.update({ where: { id: created.id }, data: { status: 'PAID' } });
      }
      return created;
    });
    if (order.status === 'PAID') await fulfillmentQueue.add('fulfill', { orderId: order.id }, { jobId: order.id, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 1000 });
    else await expirationQueue.add('expire', { orderId: order.id }, { delay: 15 * 60_000, jobId: `expire:${order.id}` });
    const payment = order.payment_method === 'PROMPTPAY' ? { promptpayId: process.env.PROMPTPAY_ID, amount: order.amount, expiresAt: order.expires_at, qrDataUrl: await QRCode.toDataURL(generatePayload(process.env.PROMPTPAY_ID ?? '', { amount: Number(order.amount) })) } : undefined;
    res.status(201).json({ order, payment });
  } catch (err: any) {
    res.status(err.message === 'INSUFFICIENT_WALLET' ? 400 : 500).json({ error: err.message === 'INSUFFICIENT_WALLET' ? 'ยอดเงินในกระเป๋าไม่เพียงพอ' : 'สร้างคำสั่งซื้อไม่สำเร็จ' });
  }
});

app.post('/api/webhooks/payment', async (req: any, res) => {
  const signature = req.header('x-payment-signature') ?? '';
  const expected = crypto.createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET ?? '').update(req.rawBody).digest('hex');
  const a = Buffer.from(signature); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'ลายเซ็นไม่ถูกต้อง' });
  const body = z.object({ orderNumber: z.string(), paymentReference: z.string(), amount: z.number().positive() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'ข้อมูลการชำระเงินไม่ถูกต้อง' });
  try {
    const updated = await prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { order_number: body.data.orderNumber } });
      if (!order || order.status !== 'PENDING' || Number(order.amount) !== body.data.amount || !order.expires_at || order.expires_at < new Date()) return null;
      return tx.order.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { status: 'PAID', supplier_ref: body.data.paymentReference } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (updated && updated.count === 1) {
      const order = await prisma.order.findUniqueOrThrow({ where: { order_number: body.data.orderNumber } });
      await fulfillmentQueue.add('fulfill', { orderId: order.id }, { jobId: order.id, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 1000 });
    }
    return res.status(200).json({ received: true, duplicate: !updated || updated.count === 0 });
  } catch { return res.status(500).json({ error: 'ประมวลผลการชำระเงินไม่สำเร็จ' }); }
});

app.get('/api/orders/:id', async (req, res) => {
  const order = await prisma.order.findFirst({ where: { OR: [{ id: req.params.id }, { order_number: req.params.id }] }, include: { game: true, package: true } });
  if (!order) return res.status(404).json({ error: 'ไม่พบคำสั่งซื้อ' });
  const payment = order.status === 'PENDING' && order.payment_method === 'PROMPTPAY' ? { qrDataUrl: await QRCode.toDataURL(generatePayload(process.env.PROMPTPAY_ID ?? '', { amount: Number(order.amount) })), expiresAt: order.expires_at } : undefined;
  res.json({ order, payment });
});
app.get('/api/orders/:id/events', async (req, res) => {
  res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-cache'); res.setHeader('connection', 'keep-alive');
  const send = async () => { const order = await prisma.order.findFirst({ where: { OR: [{ id: req.params.id }, { order_number: req.params.id }] }, select: { status: true, order_number: true } }); if (order) res.write(`data: ${JSON.stringify(order)}\n\n`); };
  await send(); const timer = setInterval(send, 3000); req.on('close', () => clearInterval(timer));
});
app.post('/api/player/lookup', async (req, res) => {
  const parsed = z.object({ gameSlug: z.string(), playerInputs: z.record(z.string()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'กรุณาตรวจสอบข้อมูลผู้เล่น' });
  try { res.json(await lookupNickname(parsed.data.gameSlug, parsed.data.playerInputs)); } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.listen(4000, () => console.log('API พร้อมใช้งานที่ http://localhost:4000'));
