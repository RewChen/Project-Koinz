// ตัวช่วยเทสที่ใช้ร่วมกัน: เปิด server.js เป็น process แยก พร้อมที่เก็บข้อมูลชั่วคราวของตัวเอง
//   npm test                → ไฟล์ JSON ในโฟลเดอร์ชั่วคราว
//   TEST_DATABASE_URL=…     → PostgreSQL: สร้างฐานข้อมูลใหม่ต่อ 1 เซิร์ฟเวอร์ แล้วลบทิ้ง (npm run test:pg)
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
  SESSION_SECRET: '',
  TERMS_VERSION: '',
  SITE_BANNER: '',
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
    if (fn) return pgRepo[fn]();
    // ตารางสมาชิก: คืนแถวดิบ (snake_case) ตามที่เก็บจริง
    if (!['users', 'sessions', 'password_resets', 'saved_players'].includes(name)) throw new Error(`ไม่รู้จัก ${name}`);
    return (await pgRepo.pool.query(`SELECT * FROM ${name}`)).rows;
  }

  // ข้อมูลทั้งหมดที่เก็บไว้เป็นข้อความเดียว (ไว้ค้นว่ามีค่าลับหลุดไปเก็บหรือไม่)
  async function dumpAll() {
    if (!db) {
      return fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'))
        .map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8')).join('\n');
    }
    pgRepo = pgRepo || require('../src/repo/pg').createPgRepo(db.url);
    const tables = (await pgRepo.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    )).rows.map((r) => r.tablename);
    const out = [];
    for (const t of tables) out.push(JSON.stringify((await pgRepo.pool.query(`SELECT * FROM ${t}`)).rows));
    return out.join('\n');
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

  return { base, req, readData, dumpAll, stop, dataDir, log: () => log };
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

module.exports = {
  ROOT, GAMES, ADMIN_PASSWORD, BASE_ENV, PG_ADMIN_URL, sleep, createTestDatabase, startServer, fakeServer, waitFor, mlOrder,
};
