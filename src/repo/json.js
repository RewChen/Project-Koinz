// ชั้นข้อมูลแบบไฟล์ JSON (data/*.json) — ใช้เมื่อไม่ได้ตั้ง DATABASE_URL
// ทุกฟังก์ชันเป็น async ให้ interface ตรงกับ ./pg.js แต่ข้างในเป็น synchronous จึงไม่มีงานอื่นแทรกระหว่างอ่าน-เขียน
const store = require('../store');

const AUDIT_MAX = 5000;
const thaiDate = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
const satang = (n) => Math.round(Number(n) * 100);

function appendAuditSync(entries) {
  store.update('audit', [], (list) => {
    list.push(...entries);
    if (list.length > AUDIT_MAX) list.splice(0, list.length - AUDIT_MAX);
  });
}

module.exports = {
  kind: 'json',
  async init() {},
  async close() {},

  // ---------- เกม ----------
  async listGames() {
    return store.read('games', []);
  },
  async replaceGames(games) {
    store.write('games', games);
  },

  // ---------- ออเดอร์ ----------
  // → { order, created } (idempotencyKey ซ้ำ → คืนออเดอร์เดิม created: false)
  async insertOrder(order, auditEntry) {
    const result = store.update('orders', [], (list) => {
      const dup = order.idempotencyKey && list.find((o) => o.idempotencyKey === order.idempotencyKey);
      if (dup) return { order: dup, created: false };
      list.push(order);
      return { order, created: true };
    });
    if (result.created) appendAuditSync([auditEntry]);
    return result;
  },
  async getOrder(id) {
    return store.read('orders', []).find((o) => o.id === id) || null;
  },
  async findOrderByIdempotencyKey(key) {
    return store.read('orders', []).find((o) => o.idempotencyKey === key) || null;
  },
  async findOrderByPaymentRef(ref) {
    return store.read('orders', []).find((o) => o.paymentRef === ref) || null;
  },
  async listAllOrders() {
    return store.read('orders', []);
  },
  async listOrders({ status = '', q = '', limit = 500 } = {}) {
    const all = store.read('orders', []);
    const needle = q.toLowerCase();
    const out = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const o = all[i];
      if (status && o.status !== status) continue;
      if (needle) {
        const hay = [o.id, o.playerLabel, o.playerId, o.playerNickname, o.contact, o.lineId, o.paymentRef, o.supplierRef,
          ...Object.values(o.playerInputs || {})];
        if (!hay.some((v) => v && String(v).toLowerCase().includes(needle))) continue;
      }
      out.push(o);
    }
    return out;
  },
  // apply(orderปัจจุบัน|null) → { patch, history, audit } หรือ throw — ทั้งหมดในจังหวะเดียว
  async transitionOrder(id, apply) {
    let auditEntry;
    const order = store.update('orders', [], (list) => {
      const cur = list.find((o) => o.id === id) || null;
      const { patch, history, audit } = apply(cur ? structuredClone(cur) : null);
      Object.assign(cur, patch);
      cur.history = [...(cur.history || []), history];
      auditEntry = audit;
      return cur;
    });
    appendAuditSync([auditEntry]);
    return order;
  },
  async listExpiredPending(nowMs) {
    return store
      .read('orders', [])
      .filter((o) => o.status === 'pending_payment' && o.expiresAt && Date.parse(o.expiresAt) <= nowMs)
      .map((o) => o.id);
  },
  async stats(statuses) {
    const byStatus = Object.fromEntries(statuses.map((s) => [s, 0]));
    const today = thaiDate(Date.now());
    let revenue = 0;
    for (const o of store.read('orders', [])) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      if (o.status !== 'completed') continue;
      const done = (o.history || []).filter((h) => h.status === 'completed').at(-1);
      if (done && thaiDate(Date.parse(done.at)) === today) revenue += satang(o.amount);
    }
    return { byStatus, revenueToday: revenue / 100 };
  },

  // ---------- audit ----------
  async appendAudit(entry) {
    appendAuditSync([entry]);
  },
  async auditFor(orderId) {
    return store.read('audit', []).filter((a) => a.orderId === orderId);
  },
  async listAudit() {
    return store.read('audit', []);
  },

  // ---------- คิวงาน ----------
  async enqueueJob(job) {
    return store.update('jobs', [], (list) => {
      const active = list.find((j) => j.type === job.type && j.orderId === job.orderId && !j.done);
      if (active) return { job: active, created: false };
      list.push(job);
      return { job, created: true };
    });
  },
  async activeJobFor(orderId) {
    return store.read('jobs', []).find((j) => j.orderId === orderId && !j.done) || null;
  },
  // จองงานที่ถึงเวลา: นับ attempts +1 และเลื่อน runAt ออกไปเป็น "สัญญาเช่า" กันถูกหยิบซ้ำ
  async claimDueJobs(nowMs, leaseMs, limit = 10) {
    return store.update('jobs', [], (list) => {
      const due = list
        .filter((j) => !j.done && Date.parse(j.runAt) <= nowMs)
        .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))
        .slice(0, limit);
      for (const j of due) {
        j.attempts += 1;
        j.runAt = new Date(nowMs + leaseMs).toISOString();
      }
      return structuredClone(due);
    });
  },
  async updateJob(id, patch) {
    return store.update('jobs', [], (list) => {
      const job = list.find((j) => j.id === id);
      if (job) Object.assign(job, patch);
      return job || null;
    });
  },
  async cleanupJobs(cutoffMs) {
    const list = store.read('jobs', []);
    const keep = list.filter((j) => !j.done || Date.parse(j.finishedAt || j.createdAt) > cutoffMs);
    if (keep.length !== list.length) store.write('jobs', keep);
  },
  async listJobs() {
    return store.read('jobs', []);
  },
  async paidOrdersWithoutActiveJob() {
    const active = new Set(store.read('jobs', []).filter((j) => !j.done).map((j) => j.orderId));
    return store.read('orders', []).filter((o) => o.status === 'paid' && !active.has(o.id)).map((o) => o.id);
  },
  // ---------- สมาชิก ----------
  // → { user, created } (อีเมลซ้ำ → created: false, user: null)
  async createUser(user) {
    return store.update('users', [], (list) => {
      if (list.some((u) => u.email === user.email)) return { user: null, created: false };
      list.push(user);
      return { user: structuredClone(user), created: true };
    });
  },
  async findUserByEmail(email) {
    return store.read('users', []).find((u) => u.email === email && !u.deletedAt) || null;
  },
  async getUser(id) {
    return store.read('users', []).find((u) => u.id === id && !u.deletedAt) || null;
  },
  // ล็อกอินผิด: นับในหน้าต่างเวลา ครบ max → ตั้ง lockedUntil แล้วเริ่มนับใหม่ → { locked, lockedUntil }
  async recordLoginFailure(id, { now, windowStart, max, lockUntil }) {
    return store.update('users', [], (list) => {
      const u = list.find((x) => x.id === id && !x.deletedAt);
      if (!u) return { locked: false, lockedUntil: null };
      if (!u.failedWindowStartedAt || Date.parse(u.failedWindowStartedAt) <= Date.parse(windowStart)) {
        u.failedLogins = 1;
        u.failedWindowStartedAt = now;
      } else {
        u.failedLogins += 1;
      }
      let locked = false;
      if (u.failedLogins >= max) {
        u.lockedUntil = lockUntil;
        u.failedLogins = 0;
        u.failedWindowStartedAt = null;
        locked = true;
      }
      u.updatedAt = now;
      return { locked, lockedUntil: u.lockedUntil || null };
    });
  },
  // ล็อกอินสำเร็จ: ล้างตัวนับ (และเปลี่ยน hash ถ้าส่งมา)
  async recordLoginSuccess(id, { now, passwordHash = null }) {
    store.update('users', [], (list) => {
      const u = list.find((x) => x.id === id);
      if (!u) return;
      Object.assign(u, { failedLogins: 0, failedWindowStartedAt: null, lockedUntil: null, updatedAt: now });
      if (passwordHash) u.passwordHash = passwordHash;
    });
  },

  // ---------- session (id = sha256 ของ token) ----------
  async createSession(session) {
    store.update('sessions', [], (list) => {
      list.push(session);
    });
  },
  async getSession(id) {
    return store.read('sessions', []).find((s) => s.id === id) || null;
  },
  async touchSession(id, now) {
    store.update('sessions', [], (list) => {
      const s = list.find((x) => x.id === id);
      if (s) s.lastSeenAt = now;
    });
  },
  async deleteSession(id) {
    store.update('sessions', [], (list) => {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list.splice(i, 1);
    });
  },
  // ลบทุก session ของ user (ยกเว้น exceptId) → จำนวนที่ลบ
  async deleteUserSessions(userId, exceptId = null) {
    return store.update('sessions', [], (list) => {
      const before = list.length;
      const keep = list.filter((s) => s.userId !== userId || s.id === exceptId);
      list.splice(0, list.length, ...keep);
      return before - keep.length;
    });
  },
  async countActiveSessions(userId, { now, idleCutoff }) {
    return store
      .read('sessions', [])
      .filter((s) => s.userId === userId && Date.parse(s.expiresAt) > Date.parse(now) && Date.parse(s.lastSeenAt) > Date.parse(idleCutoff))
      .length;
  },
  async deleteStaleSessions({ now, idleCutoff }) {
    const list = store.read('sessions', []);
    const keep = list.filter((s) => Date.parse(s.expiresAt) > Date.parse(now) && Date.parse(s.lastSeenAt) > Date.parse(idleCutoff));
    if (keep.length !== list.length) store.write('sessions', keep);
  },

  // ---------- ลิงก์ตั้งรหัสผ่านใหม่ (tokenHash = sha256 ของ token) ----------
  async createPasswordReset(reset) {
    store.update('password_resets', [], (list) => {
      list.push(reset);
    });
  },
  async getPasswordReset(tokenHash) {
    return store.read('password_resets', []).find((r) => r.tokenHash === tokenHash) || null;
  },
  async deleteStalePasswordResets(now) {
    const list = store.read('password_resets', []);
    const keep = list.filter((r) => !r.usedAt && Date.parse(r.expiresAt) > Date.parse(now));
    if (keep.length !== list.length) store.write('password_resets', keep);
  },
  // ใช้ลิงก์ครั้งเดียว: ยังไม่ใช้ + ยังไม่หมดอายุ → ตั้ง usedAt แล้วคืนแถว (ไม่งั้น null) ในจังหวะเดียว
  async consumePasswordReset(tokenHash, now) {
    return store.update('password_resets', [], (list) => {
      const r = list.find((x) => x.tokenHash === tokenHash);
      if (!r || r.usedAt || Date.parse(r.expiresAt) <= Date.parse(now)) return null;
      r.usedAt = now;
      return structuredClone(r);
    });
  },
  async deleteUserPasswordResets(userId) {
    store.update('password_resets', [], (list) => {
      const keep = list.filter((r) => r.userId !== userId);
      list.splice(0, list.length, ...keep);
    });
  },
  // เปลี่ยนรหัส (และปลดล็อกบัญชี)
  async updateUserPassword(id, { now, passwordHash }) {
    store.update('users', [], (list) => {
      const u = list.find((x) => x.id === id && !x.deletedAt);
      if (!u) return;
      Object.assign(u, { passwordHash, failedLogins: 0, failedWindowStartedAt: null, lockedUntil: null, updatedAt: now });
    });
  },
  // ลบบัญชี (PDPA): ลบ session/UID/ลิงก์รีเซ็ต, ออเดอร์เก่าไม่ผูกกับ user แล้ว, แถว users เหลือแบบไม่มีข้อมูลส่วนตัว
  async deleteUserAccount(id, now) {
    for (const name of ['sessions', 'saved_players', 'password_resets']) {
      store.update(name, [], (list) => {
        const keep = list.filter((x) => x.userId !== id);
        list.splice(0, list.length, ...keep);
      });
    }
    store.update('orders', [], (list) => {
      for (const o of list) if (o.userId === id) delete o.userId;
    });
    store.update('users', [], (list) => {
      const u = list.find((x) => x.id === id);
      if (!u) return;
      Object.assign(u, {
        email: `deleted-${id}@invalid`, passwordHash: '!', marketingOptIn: false,
        failedLogins: 0, failedWindowStartedAt: null, lockedUntil: null, updatedAt: now, deletedAt: now,
      });
    });
  },

  // ---------- UID ที่สมาชิกบันทึกไว้ (1 แถวต่อเกม) ----------
  async upsertSavedPlayer(p) {
    store.update('saved_players', [], (list) => {
      const cur = list.find((x) => x.userId === p.userId && x.gameSlug === p.gameSlug);
      if (cur) Object.assign(cur, { inputs: p.inputs, label: p.label, updatedAt: p.updatedAt });
      else list.push({ userId: p.userId, gameSlug: p.gameSlug, inputs: p.inputs, label: p.label, updatedAt: p.updatedAt });
    });
  },
  async listSavedPlayers(userId) {
    return store
      .read('saved_players', [])
      .filter((x) => x.userId === userId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  },
  async deleteSavedPlayer(userId, gameSlug) {
    return store.update('saved_players', [], (list) => {
      const i = list.findIndex((x) => x.userId === userId && x.gameSlug === gameSlug);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    });
  },

  // ---------- ออเดอร์ของสมาชิก ----------
  async listOrdersByUser(userId, limit = 50) {
    const all = store.read('orders', []);
    const out = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) if (all[i].userId === userId) out.push(all[i]);
    return out;
  },
  // ผูกออเดอร์กับ user เฉพาะเมื่อยังไม่มีเจ้าของ → true/false
  async claimOrder(id, userId) {
    return store.update('orders', [], (list) => {
      const o = list.find((x) => x.id === id);
      if (!o || o.userId) return false;
      o.userId = userId;
      return true;
    });
  },
};

