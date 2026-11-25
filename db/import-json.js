// ย้ายข้อมูลจากไฟล์ JSON (data/*.json) เข้า PostgreSQL — รันซ้ำได้ ข้อมูลที่มีแล้วจะข้าม
//   node db/import-json.js [โฟลเดอร์ข้อมูล]     (ค่าเริ่มต้น KOINZ_DATA_DIR หรือ ./data)
//   ใน Docker: docker compose run --rm app node db/import-json.js
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { createPgRepo } = require('../src/repo/pg');
const { migrate } = require('./migrate');

const readJson = (dir, name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
};

async function importJson(dir, pgUrl, log = console.log) {
  const repo = createPgRepo(pgUrl);
  const { pool } = repo;
  const n = { games: 0, orders: 0, history: 0, jobs: 0, audit: 0, skippedOrders: 0 };
  try {
    await migrate(pool, log);

    // เกม: นำเข้าเฉพาะเมื่อฐานข้อมูลยังไม่มีเกม (ไม่ทับที่แอดมินแก้ไว้)
    const games = readJson(dir, 'games');
    const { rows } = await pool.query('SELECT count(*)::int AS c FROM games');
    if (games && rows[0].c === 0) {
      await repo.replaceGames(games);
      n.games = games.length;
    }

    for (const o of readJson(dir, 'orders') || []) {
      // ออเดอร์รุ่นเก่า (ก่อนมี playerInputs) ใช้ playerId/server แทน
      const inputs = o.playerInputs || Object.fromEntries(
        [['uid', o.playerId], ['server', o.server]].filter(([, v]) => v)
      );
      const label = o.playerLabel || [o.playerId, o.server].filter(Boolean).join(' · ');
      const r = await pool.query(
        `INSERT INTO orders (id, token, status, game_slug, game_name, package_id, package_name, sku, player_inputs,
           player_label, player_nickname, contact, line_id, customer_note, amount, expires_at, paid_at, payment_ref,
           supplier_ref, idempotency_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         ON CONFLICT DO NOTHING RETURNING id`,
        [o.id, o.token, o.status, o.gameSlug, o.gameName, o.packageId, o.packageName, o.sku ?? null, JSON.stringify(inputs),
          label, o.playerNickname ?? null, o.contact || '', o.lineId || '', o.customerNote || '', o.amount,
          o.expiresAt ?? null, o.paidAt ?? null, o.paymentRef ?? null, o.supplierRef ?? null, o.idempotencyKey ?? null,
          o.createdAt, o.updatedAt || o.createdAt]
      );
      if (!r.rows.length) {
        n.skippedOrders++;
        continue;
      }
      n.orders++;
      for (const h of o.history || []) {
        await pool.query('INSERT INTO order_history (order_id, status, at, by, note) VALUES ($1, $2, $3, $4, $5)', [
          o.id, h.status, h.at, h.by || 'system', h.note ?? null,
        ]);
        n.history++;
      }
    }

    const orderIds = new Set((await pool.query('SELECT id FROM orders')).rows.map((r) => r.id));
    for (const j of readJson(dir, 'jobs') || []) {
      if (!orderIds.has(j.orderId)) continue;
      const r = await pool.query(
        `INSERT INTO jobs (id, type, order_id, attempts, run_at, last_error, done, result, supplier_ref, created_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING RETURNING id`,
        [j.id, j.type, j.orderId, j.attempts || 0, j.runAt, j.lastError ?? null, !!j.done, j.result ?? null,
          j.supplierRef ?? null, j.createdAt, j.finishedAt ?? null]
      );
      n.jobs += r.rows.length;
    }

    for (const a of readJson(dir, 'audit') || []) {
      const r = await pool.query(
        `INSERT INTO audit (at, order_id, action, from_status, to_status, actor, note)
         SELECT $1, $2, $3, $4, $5, $6, $7
         WHERE NOT EXISTS (
           SELECT 1 FROM audit WHERE at = $1 AND order_id IS NOT DISTINCT FROM $2 AND action = $3
             AND to_status IS NOT DISTINCT FROM $5 AND actor = $6)
         RETURNING id`,
        [a.at, a.orderId ?? null, a.action, a.from ?? null, a.to ?? null, a.actor, a.note ?? null]
      );
      n.audit += r.rows.length;
    }
    return n;
  } finally {
    await repo.close();
  }
}

module.exports = { importJson };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || config.dataDir);
  if (!config.databaseUrl) {
    console.error('ยังไม่ได้ตั้ง DATABASE_URL');
    process.exit(1);
  }
  importJson(dir, config.databaseUrl)
    .then((n) =>
      console.log(
        `นำเข้าจาก ${dir}: เกม ${n.games}, ออเดอร์ ${n.orders} (ข้ามที่มีแล้ว ${n.skippedOrders}), ประวัติ ${n.history}, งาน ${n.jobs}, audit ${n.audit}`
      )
    )
    .catch((e) => {
      console.error('นำเข้าไม่สำเร็จ:', e.message);
      process.exitCode = 1;
    });
}
