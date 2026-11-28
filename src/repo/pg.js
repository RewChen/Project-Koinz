// ชั้นข้อมูลแบบ PostgreSQL — ใช้เมื่อตั้ง DATABASE_URL (interface เดียวกับ ./json.js)
// แปลงแถวในฐานข้อมูลกลับเป็นรูปแบบ JSON เดิมทุกประการ (camelCase, เวลาเป็น ISO string, เงินเป็น number)
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { migrate } = require('../../db/migrate');

const SEED_FILE = path.join(__dirname, '..', '..', 'docs', 'games.v2.json');
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const num = (v) => (v == null ? null : Number(v));

// ---------- แปลงแถว → object ----------
const GAME_KEYS = ['slug', 'name', 'category', 'color', 'currency', 'initial', 'active', 'fields'];
const PKG_KEYS = ['id', 'name', 'price', 'tag', 'sku', 'cost', 'active'];

function rowToGame(g, pkgs) {
  const out = { slug: g.slug, name: g.name };
  for (const k of ['category', 'color', 'currency', 'active', 'initial']) if (g[k] != null) out[k] = g[k];
  Object.assign(out, g.extra || {});
  out.fields = g.fields;
  out.packages = pkgs.map((p) => {
    const o = { id: p.id, name: p.name, price: num(p.price) };
    if (p.tag != null) o.tag = p.tag;
    if (p.sku != null) o.sku = p.sku;
    if (p.cost != null) o.cost = num(p.cost);
    if (p.active != null) o.active = p.active;
    return Object.assign(o, p.extra || {});
  });
  return out;
}

function rowToHistory(h) {
  const o = { status: h.status, at: iso(h.at), by: h.by };
  if (h.note != null) o.note = h.note;
  return o;
}

function rowToOrder(r) {
  const o = {
    id: r.id,
    token: r.token,
    status: r.status,
    playerNickname: r.player_nickname,
    contact: r.contact,
    lineId: r.line_id,
    customerNote: r.customer_note,
    paymentRef: r.payment_ref,
    supplierRef: r.supplier_ref,
    idempotencyKey: r.idempotency_key,
    gameSlug: r.game_slug,
    gameName: r.game_name,
    packageId: r.package_id,
    packageName: r.package_name,
    sku: r.sku,
    playerInputs: r.player_inputs || {},
    playerLabel: r.player_label,
    amount: num(r.amount),
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    history: (r.history || []).map(rowToHistory),
  };
  if (r.paid_at) o.paidAt = iso(r.paid_at);
  if (r.user_id) o.userId = r.user_id; // เฉพาะออเดอร์ของสมาชิก (guest ไม่มี key นี้ เหมือนไฟล์ JSON)
  return o;
}

function rowToAudit(a) {
  const o = { at: iso(a.at) };
  if (a.order_id != null) o.orderId = a.order_id;
  o.action = a.action;
  if (a.from_status != null) o.from = a.from_status;
  if (a.to_status != null) o.to = a.to_status;
  o.actor = a.actor;
  if (a.note != null) o.note = a.note;
  return o;
}

function rowToJob(j) {
  const o = {
    id: j.id,
    type: j.type,
    orderId: j.order_id,
    attempts: j.attempts,
    runAt: iso(j.run_at),
    lastError: j.last_error,
    done: j.done,
    result: j.result,
    createdAt: iso(j.created_at),
  };
  if (j.finished_at) o.finishedAt = iso(j.finished_at);
  if (j.supplier_ref != null) o.supplierRef = j.supplier_ref;
  return o;
}

function rowToUser(u) {
  return {
    id: u.id,
    email: u.email,
    passwordHash: u.password_hash,
    termsVersion: u.terms_version,
    termsAcceptedAt: iso(u.terms_accepted_at),
    marketingOptIn: u.marketing_opt_in,
    failedLogins: u.failed_logins,
    failedWindowStartedAt: iso(u.failed_window_started_at),
    lockedUntil: iso(u.locked_until),
    createdAt: iso(u.created_at),
    updatedAt: iso(u.updated_at),
    deletedAt: iso(u.deleted_at),
  };
}

function rowToSession(s) {
  return {
    id: s.id,
    userId: s.user_id,
    createdAt: iso(s.created_at),
    lastSeenAt: iso(s.last_seen_at),
    expiresAt: iso(s.expires_at),
    userAgent: s.user_agent,
    ipHash: s.ip_hash,
  };
}

function rowToReset(r) {
  return {
    tokenHash: r.token_hash,
    userId: r.user_id,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    usedAt: iso(r.used_at),
  };
}

// ฟิลด์ของออเดอร์ที่แก้ผ่าน transition ได้ → ชื่อคอลัมน์
const ORDER_COLUMNS = {
  status: 'status',
  playerNickname: 'player_nickname',
  contact: 'contact',
  lineId: 'line_id',
  customerNote: 'customer_note',
  paymentRef: 'payment_ref',
  supplierRef: 'supplier_ref',
  expiresAt: 'expires_at',
  paidAt: 'paid_at',
  updatedAt: 'updated_at',
};
const JOB_COLUMNS = {
  attempts: 'attempts',
  runAt: 'run_at',
  lastError: 'last_error',
  done: 'done',
  result: 'result',
  supplierRef: 'supplier_ref',
  finishedAt: 'finished_at',
};

const ORDER_SELECT = `
  SELECT o.*, COALESCE((
    SELECT json_agg(json_build_object('status', h.status, 'at', h.at, 'by', h.by, 'note', h.note) ORDER BY h.id)
    FROM order_history h WHERE h.order_id = o.id
  ), '[]'::json) AS history
  FROM orders o`;

function setClause(patch, columns, startAt) {
  const sets = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = columns[k];
    if (!col) continue; // ไม่รู้จัก → ไม่บันทึก
    values.push(v);
    sets.push(`${col} = $${startAt + values.length - 1}`);
  }
  return { sets, values };
}

function createPgRepo(connectionString) {
  const pool = new Pool({ connectionString, max: 10 });
  pool.on('error', (e) => console.error('PostgreSQL connection error:', e.message));

  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  const insertAudit = (db, a) =>
    db.query(
      'INSERT INTO audit (at, order_id, action, from_status, to_status, actor, note) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [a.at || new Date().toISOString(), a.orderId ?? null, a.action, a.from ?? null, a.to ?? null, a.actor, a.note ?? null]
    );
  const insertHistory = (db, orderId, h) =>
    db.query('INSERT INTO order_history (order_id, status, at, by, note) VALUES ($1, $2, $3, $4, $5)', [
      orderId, h.status, h.at, h.by, h.note ?? null,
    ]);
  const getOrderWith = async (db, where, params) => {
    const r = await db.query(`${ORDER_SELECT} WHERE ${where} LIMIT 1`, params);
    return r.rows[0] ? rowToOrder(r.rows[0]) : null;
  };

  async function replaceGamesWith(db, games) {
    await db.query('DELETE FROM packages');
    await db.query('DELETE FROM games');
    for (const [gi, g] of games.entries()) {
      const extra = Object.fromEntries(Object.entries(g).filter(([k]) => !GAME_KEYS.includes(k) && k !== 'packages'));
      await db.query(
        `INSERT INTO games (slug, name, category, color, currency, initial, active, sort, fields, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [g.slug, g.name, g.category ?? null, g.color ?? null, g.currency ?? null, g.initial ?? null, g.active ?? null, gi,
          JSON.stringify(g.fields || []), JSON.stringify(extra)]
      );
      for (const [pi, p] of (g.packages || []).entries()) {
        const pExtra = Object.fromEntries(Object.entries(p).filter(([k]) => !PKG_KEYS.includes(k)));
        await db.query(
          `INSERT INTO packages (id, game_slug, name, price, tag, sku, cost, active, sort, extra)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [p.id, g.slug, p.name, p.price, p.tag ?? null, p.sku ?? null, p.cost ?? null, p.active ?? null, pi, JSON.stringify(pExtra)]
        );
      }
    }
  }

  return {
    kind: 'pg',
    pool,

    // migrate + ใส่เกมตั้งต้นถ้ายังไม่มี
    async init({ log = console.log } = {}) {
      await migrate(pool, log);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM games');
      if (rows[0].n === 0) {
        const games = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
        await tx((c) => replaceGamesWith(c, games));
        log(`seed: ใส่เกมตั้งต้น ${games.length} เกม`);
      }
    },
    async close() {
      await pool.end();
    },

    // ---------- เกม ----------
    async listGames() {
      const games = (await pool.query('SELECT * FROM games ORDER BY sort, slug')).rows;
      const pkgs = (await pool.query('SELECT * FROM packages ORDER BY game_slug, sort, id')).rows;
      return games.map((g) => rowToGame(g, pkgs.filter((p) => p.game_slug === g.slug)));
    },
    async replaceGames(games) {
      await tx((c) => replaceGamesWith(c, games));
    },

    // ---------- ออเดอร์ ----------
    async insertOrder(order, auditEntry) {
      return tx(async (c) => {
        const r = await c.query(
          `INSERT INTO orders (id, token, status, game_slug, game_name, package_id, package_name, sku, player_inputs,
             player_label, player_nickname, contact, line_id, customer_note, amount, expires_at, paid_at, payment_ref,
             supplier_ref, idempotency_key, created_at, updated_at, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [order.id, order.token, order.status, order.gameSlug, order.gameName, order.packageId, order.packageName,
            order.sku ?? null, JSON.stringify(order.playerInputs || {}), order.playerLabel || '', order.playerNickname ?? null,
            order.contact || '', order.lineId || '', order.customerNote || '', order.amount, order.expiresAt ?? null,
            order.paidAt ?? null, order.paymentRef ?? null, order.supplierRef ?? null, order.idempotencyKey ?? null,
            order.createdAt, order.updatedAt, order.userId ?? null]
        );
        if (!r.rows.length) {
          return { order: await getOrderWith(c, 'o.idempotency_key = $1', [order.idempotencyKey]), created: false };
        }
        for (const h of order.history || []) await insertHistory(c, order.id, h);
        if (auditEntry) await insertAudit(c, auditEntry);
        return { order: await getOrderWith(c, 'o.id = $1', [order.id]), created: true };
      });
    },
    getOrder: (id) => getOrderWith(pool, 'o.id = $1', [id]),
    findOrderByIdempotencyKey: (key) => getOrderWith(pool, 'o.idempotency_key = $1', [key]),
    findOrderByPaymentRef: (ref) => getOrderWith(pool, 'o.payment_ref = $1', [ref]),
    async listAllOrders() {
      return (await pool.query(`${ORDER_SELECT} ORDER BY o.created_at, o.id`)).rows.map(rowToOrder);
    },
    async listOrders({ status = '', q = '', limit = 500 } = {}) {
      const where = [];
      const params = [];
      if (status) {
        params.push(status);
        where.push(`o.status = $${params.length}`);
      }
      if (q) {
        params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
        const p = `$${params.length}`;
        where.push(`(o.id ILIKE ${p} OR o.player_label ILIKE ${p} OR o.player_nickname ILIKE ${p} OR o.contact ILIKE ${p}
          OR o.line_id ILIKE ${p} OR o.payment_ref ILIKE ${p} OR o.supplier_ref ILIKE ${p}
          OR EXISTS (SELECT 1 FROM jsonb_each_text(o.player_inputs) e WHERE e.value ILIKE ${p}))`);
      }
      params.push(limit);
      const sql = `${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length}`;
      return (await pool.query(sql, params)).rows.map(rowToOrder);
    },
    async transitionOrder(id, apply) {
      return tx(async (c) => {
        const locked = await c.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);
        const cur = locked.rows.length ? await getOrderWith(c, 'o.id = $1', [id]) : null;
        const { patch, history, audit } = apply(cur);
        const { sets, values } = setClause(patch, ORDER_COLUMNS, 2);
        if (sets.length) await c.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, [id, ...values]);
        await insertHistory(c, id, history);
        await insertAudit(c, audit);
        return getOrderWith(c, 'o.id = $1', [id]);
      });
    },
    async listExpiredPending(nowMs) {
      const r = await pool.query(
        "SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at <= $1 ORDER BY expires_at",
        [new Date(nowMs).toISOString()]
      );
      return r.rows.map((x) => x.id);
    },
    async stats(statuses) {
      const byStatus = Object.fromEntries(statuses.map((s) => [s, 0]));
      for (const r of (await pool.query('SELECT status, count(*)::int AS n FROM orders GROUP BY status')).rows) {
        byStatus[r.status] = r.n;
      }
      const rev = await pool.query(`
        SELECT COALESCE(sum(o.amount), 0) AS total FROM orders o
        WHERE o.status = 'completed'
          AND ((SELECT max(h.at) FROM order_history h WHERE h.order_id = o.id AND h.status = 'completed')
                AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date`);
      return { byStatus, revenueToday: Number(rev.rows[0].total) };
    },

    // ---------- audit ----------
    async appendAudit(entry) {
      await insertAudit(pool, entry);
    },
    async auditFor(orderId) {
      return (await pool.query('SELECT * FROM audit WHERE order_id = $1 ORDER BY id', [orderId])).rows.map(rowToAudit);
    },
    async listAudit() {
      return (await pool.query('SELECT * FROM audit ORDER BY id')).rows.map(rowToAudit);
    },

    // ---------- คิวงาน ----------
    async enqueueJob(job) {
      const r = await pool.query(
        `INSERT INTO jobs (id, type, order_id, attempts, run_at, last_error, done, result, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (order_id) WHERE type = 'fulfill' AND NOT done DO NOTHING
         RETURNING *`,
        [job.id, job.type, job.orderId, job.attempts, job.runAt, job.lastError, job.done, job.result, job.createdAt]
      );
      if (r.rows.length) return { job: rowToJob(r.rows[0]), created: true };
      const active = await pool.query('SELECT * FROM jobs WHERE order_id = $1 AND type = $2 AND NOT done LIMIT 1', [
        job.orderId, job.type,
      ]);
      return { job: active.rows[0] ? rowToJob(active.rows[0]) : null, created: false };
    },
    async activeJobFor(orderId) {
      const r = await pool.query('SELECT * FROM jobs WHERE order_id = $1 AND NOT done LIMIT 1', [orderId]);
      return r.rows[0] ? rowToJob(r.rows[0]) : null;
    },
    // จองงานแบบ SKIP LOCKED รองรับหลาย instance
    async claimDueJobs(nowMs, leaseMs, limit = 10) {
      const r = await pool.query(
        `UPDATE jobs SET attempts = attempts + 1, run_at = $2
         WHERE id IN (
           SELECT id FROM jobs WHERE NOT done AND run_at <= $1 ORDER BY run_at LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [new Date(nowMs).toISOString(), new Date(nowMs + leaseMs).toISOString(), limit]
      );
      return r.rows.map(rowToJob);
    },
    async updateJob(id, patch) {
      const { sets, values } = setClause(patch, JOB_COLUMNS, 2);
      if (!sets.length) return null;
      const r = await pool.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...values]);
      return r.rows[0] ? rowToJob(r.rows[0]) : null;
    },
    async cleanupJobs(cutoffMs) {
      await pool.query('DELETE FROM jobs WHERE done AND COALESCE(finished_at, created_at) < $1', [
        new Date(cutoffMs).toISOString(),
      ]);
    },
    async listJobs() {
      return (await pool.query('SELECT * FROM jobs ORDER BY created_at, id')).rows.map(rowToJob);
    },
    async paidOrdersWithoutActiveJob() {
      const r = await pool.query(`
        SELECT o.id FROM orders o
        WHERE o.status = 'paid'
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.order_id = o.id AND NOT j.done)`);
      return r.rows.map((x) => x.id);
    },

    // ---------- สมาชิก ----------
    async createUser(u) {
      const r = await pool.query(
        `INSERT INTO users (id, email, password_hash, terms_version, terms_accepted_at, marketing_opt_in, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (email) DO NOTHING
         RETURNING *`,
        [u.id, u.email, u.passwordHash, u.termsVersion, u.termsAcceptedAt, !!u.marketingOptIn, u.createdAt, u.updatedAt]
      );
      return r.rows.length ? { user: rowToUser(r.rows[0]), created: true } : { user: null, created: false };
    },
    async findUserByEmail(email) {
      const r = await pool.query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
      return r.rows[0] ? rowToUser(r.rows[0]) : null;
    },
    async getUser(id) {
      const r = await pool.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
      return r.rows[0] ? rowToUser(r.rows[0]) : null;
    },
    async recordLoginFailure(id, { now, windowStart, max, lockUntil }) {
      return tx(async (c) => {
        const r = await c.query(
          `UPDATE users SET
             failed_logins = CASE WHEN failed_window_started_at IS NULL OR failed_window_started_at <= $2::timestamptz
                                  THEN 1 ELSE failed_logins + 1 END,
             failed_window_started_at = CASE WHEN failed_window_started_at IS NULL OR failed_window_started_at <= $2::timestamptz
                                             THEN $1::timestamptz ELSE failed_window_started_at END,
             updated_at = $1::timestamptz
           WHERE id = $3 AND deleted_at IS NULL
           RETURNING failed_logins, locked_until`,
          [now, windowStart, id]
        );
        if (!r.rows.length) return { locked: false, lockedUntil: null };
        if (r.rows[0].failed_logins < max) return { locked: false, lockedUntil: iso(r.rows[0].locked_until) };
        await c.query(
          'UPDATE users SET locked_until = $2, failed_logins = 0, failed_window_started_at = NULL WHERE id = $1',
          [id, lockUntil]
        );
        return { locked: true, lockedUntil: iso(lockUntil) };
      });
    },
    async recordLoginSuccess(id, { now, passwordHash = null }) {
      await pool.query(
        `UPDATE users SET failed_logins = 0, failed_window_started_at = NULL, locked_until = NULL, updated_at = $2,
           password_hash = COALESCE($3, password_hash)
         WHERE id = $1`,
        [id, now, passwordHash]
      );
    },

    // ---------- session (id = sha256 ของ token) ----------
    async createSession(s) {
      await pool.query(
        `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.id, s.userId, s.createdAt, s.lastSeenAt, s.expiresAt, s.userAgent ?? null, s.ipHash ?? null]
      );
    },
    async getSession(id) {
      const r = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
      return r.rows[0] ? rowToSession(r.rows[0]) : null;
    },
    async touchSession(id, now) {
      await pool.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [id, now]);
    },
    async deleteSession(id) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
    },
    async deleteUserSessions(userId, exceptId = null) {
      const r = await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2', [userId, exceptId]);
      return r.rowCount;
    },
    async countActiveSessions(userId, { now, idleCutoff }) {
      const r = await pool.query(
        'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > $2 AND last_seen_at > $3',
        [userId, now, idleCutoff]
      );
      return r.rows[0].n;
    },
    async deleteStaleSessions({ now, idleCutoff }) {
      await pool.query('DELETE FROM sessions WHERE expires_at <= $1 OR last_seen_at <= $2', [now, idleCutoff]);
    },

    // ---------- ลิงก์ตั้งรหัสผ่านใหม่ (token_hash = sha256 ของ token) ----------
    async createPasswordReset(r) {
      await pool.query(
        'INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        [r.tokenHash, r.userId, r.createdAt, r.expiresAt]
      );
    },
    async getPasswordReset(tokenHash) {
      const r = await pool.query('SELECT * FROM password_resets WHERE token_hash = $1', [tokenHash]);
      return r.rows[0] ? rowToReset(r.rows[0]) : null;
    },
    async deleteStalePasswordResets(now) {
      await pool.query('DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at <= $1', [now]);
    },
    async consumePasswordReset(tokenHash, now) {
      const r = await pool.query(
        `UPDATE password_resets SET used_at = $2
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
         RETURNING *`,
        [tokenHash, now]
      );
      return r.rows[0] ? rowToReset(r.rows[0]) : null;
    },
    async deleteUserPasswordResets(userId) {
      await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
    },
    async updateUserPassword(id, { now, passwordHash }) {
      await pool.query(
        `UPDATE users SET password_hash = $2, failed_logins = 0, failed_window_started_at = NULL, locked_until = NULL,
           updated_at = $3
         WHERE id = $1 AND deleted_at IS NULL`,
        [id, passwordHash, now]
      );
    },
    async deleteUserAccount(id, now) {
      await tx(async (c) => {
        await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        await c.query('DELETE FROM saved_players WHERE user_id = $1', [id]);
        await c.query('DELETE FROM password_resets WHERE user_id = $1', [id]);
        await c.query('UPDATE orders SET user_id = NULL WHERE user_id = $1', [id]);
        await c.query(
          `UPDATE users SET email = $2, password_hash = '!', marketing_opt_in = false, failed_logins = 0,
             failed_window_started_at = NULL, locked_until = NULL, updated_at = $3, deleted_at = $3
           WHERE id = $1`,
          [id, `deleted-${id}@invalid`, now]
        );
      });
    },

    // ---------- UID ที่สมาชิกบันทึกไว้ (1 แถวต่อเกม) ----------
    async upsertSavedPlayer(p) {
      await pool.query(
        `INSERT INTO saved_players (user_id, game_slug, inputs, label, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, game_slug) DO UPDATE SET inputs = EXCLUDED.inputs, label = EXCLUDED.label,
           updated_at = EXCLUDED.updated_at`,
        [p.userId, p.gameSlug, JSON.stringify(p.inputs || {}), p.label || '', p.updatedAt]
      );
    },
    async listSavedPlayers(userId) {
      const r = await pool.query('SELECT * FROM saved_players WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
      return r.rows.map((x) => ({
        userId: x.user_id, gameSlug: x.game_slug, inputs: x.inputs || {}, label: x.label, updatedAt: iso(x.updated_at),
      }));
    },
    async deleteSavedPlayer(userId, gameSlug) {
      const r = await pool.query('DELETE FROM saved_players WHERE user_id = $1 AND game_slug = $2', [userId, gameSlug]);
      return r.rowCount > 0;
    },

    // ---------- ออเดอร์ของสมาชิก ----------
    async listOrdersByUser(userId, limit = 50) {
      const r = await pool.query(
        `${ORDER_SELECT} WHERE o.user_id = $1 ORDER BY o.created_at DESC, o.id DESC LIMIT $2`,
        [userId, limit]
      );
      return r.rows.map(rowToOrder);
    },
    async claimOrder(id, userId) {
      const r = await pool.query('UPDATE orders SET user_id = $2 WHERE id = $1 AND user_id IS NULL', [id, userId]);
      return r.rowCount > 0;
    },
  };
}

module.exports = { createPgRepo };
