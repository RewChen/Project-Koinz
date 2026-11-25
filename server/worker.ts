import 'dotenv/config';
import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { connection } from './queue';
import { fulfillTopup } from './adapters';

const prisma = new PrismaClient();
new Worker('order-expiration', async job => {
  await prisma.order.updateMany({ where: { id: job.data.orderId, status: 'PENDING', expires_at: { lte: new Date() } }, data: { status: 'EXPIRED' } });
}, { connection });

new Worker('topup-fulfillment', async job => {
  const order = await prisma.order.findUnique({ where: { id: job.data.orderId }, include: { package: true } });
  if (!order || ['COMPLETED', 'REFUNDED', 'FAILED'].includes(order.status)) return;
  await prisma.order.update({ where: { id: order.id }, data: { status: 'PROCESSING' } });
  try {
    const result = await fulfillTopup({ supplierSku: order.package.supplier_sku, playerInputs: order.player_inputs, orderNumber: order.order_number });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED', supplier_ref: result.reference ?? order.supplier_ref } });
  } catch (error) {
    if (job.attemptsMade < 2) throw error;
    await prisma.$transaction(async tx => {
      await tx.order.update({ where: { id: order.id }, data: { status: order.user_id ? 'FAILED' : 'REFUND_NEEDED' } });
      if (!order.user_id) return;
      const user = await tx.user.findUniqueOrThrow({ where: { id: order.user_id } });
      const after = user.wallet_balance.add(order.amount);
      await tx.user.update({ where: { id: user.id }, data: { wallet_balance: after } });
      await tx.walletTransaction.create({ data: { user_id: user.id, order_id: order.id, type: 'REFUND', amount: order.amount, balance_before: user.wallet_balance, balance_after: after } });
    });
    if (process.env.ADMIN_ALERT_WEBHOOK) await fetch(process.env.ADMIN_ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `เติมเกมไม่สำเร็จ ${order.order_number}: ${String(error)}` }) }).catch(() => undefined);
  }
}, { connection, concurrency: 10 });

console.log('Workers พร้อมทำงาน');
