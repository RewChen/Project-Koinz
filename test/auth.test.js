// เทสระบบสมาชิก (AUTH_SPEC.md) — รันได้ทั้งไฟล์ JSON และ PostgreSQL เหมือน api.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ROOT, BASE_ENV, PG_ADMIN_URL, createTestDatabase, startServer, fakeServer, waitFor, mlOrder } = require('./helpers');
const password = require('../src/auth/password');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GOOD_PW = 'Coins-and-dragons-77';
const BAD_LOGIN = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง ตรวจแล้วลองใหม่อีกครั้ง';
const LOCKED = 'ลองผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่ หรือกด "ลืมรหัสผ่าน?"';
let seq = 0;
const newEmail = () => `member${Date.now().toString(36)}${seq++}@example.com`;

// เบราว์เซอร์จำลอง: เก็บ cookie koinz_sid และส่ง Origin ของเว็บตัวเองทุกครั้ง
function browser(s) {
  const jar = {};
  async function call(method, url, body, headers = {}) {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(s.base + url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { origin: s.base }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || !v) delete jar[k];
      else jar[k] = v;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
    return { status: res.status, headers: res.headers, setCookies, text, body: json };
  }
  return {
    jar,
    get: (url, headers) => call('GET', url, undefined, headers),
    post: (url, body = {}, headers) => call('POST', url, body, headers),
    signup: (email, pw = GOOD_PW, extra = {}) =>
      call('POST', '/api/auth/signup', { email, password: pw, acceptTerms: true, ...extra }),
    login: (email, pw = GOOD_PW) => call('POST', '/api/auth/login', { email, password: pw }),
  };
}

// ---------------------------------------------------------------------------
describe('Auth Phase 1 — รหัสผ่าน (scrypt + นโยบาย)', () => {
  test('hash รหัสเดียวกัน 2 ครั้งได้ค่าต่างกัน และ verify ผ่านทั้งคู่ / รหัสผิดไม่ผ่าน', async () => {
    const a = await password.hashPassword(GOOD_PW);
    const b = await password.hashPassword(GOOD_PW);
    assert.notEqual(a, b);
    assert.match(a, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(Buffer.from(a.split('$')[4], 'base64').length, 16);
    assert.equal(Buffer.from(a.split('$')[5], 'base64').length, 64);
    assert.deepEqual(await password.verifyPassword(GOOD_PW, a), { ok: true, needsRehash: false });
    assert.deepEqual(await password.verifyPassword(GOOD_PW, b), { ok: true, needsRehash: false });
    assert.equal((await password.verifyPassword(GOOD_PW + 'x', a)).ok, false);
    assert.equal((await password.verifyPassword(GOOD_PW, 'ไม่ใช่ hash')).ok, false);
  });

  test('normalize NFKC ก่อน hash: ตัวเต็มความกว้างกับตัวปกติ = รหัสเดียวกัน', async () => {
    const h = await password.hashPassword('ＫＯＩＮＺ-secret-77');
    assert.equal((await password.verifyPassword('KOINZ-secret-77', h)).ok, true);
  });

  test('พารามิเตอร์เก่า → ผ่านแต่ needsRehash', async () => {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(GOOD_PW, salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const old = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    assert.deepEqual(await password.verifyPassword(GOOD_PW, old), { ok: true, needsRehash: true });
  });

  test('นโยบาย: 9 ตัว / password1234 / มีชื่ออีเมล / ยาวเกิน 128 → ข้อความไทย, ไม่บังคับตัวใหญ่หรือสัญลักษณ์', () => {
    assert.equal(password.checkPolicy('abcdefgh9', 'a@b.co'), 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัว');
    assert.equal(password.checkPolicy('password1234', 'a@b.co'), 'รหัสผ่านนี้คนใช้กันบ่อย เดาง่าย ลองตั้งรหัสอื่น');
    assert.equal(password.checkPolicy('PassWord1234', 'a@b.co'), 'รหัสผ่านนี้คนใช้กันบ่อย เดาง่าย ลองตั้งรหัสอื่น');
    assert.equal(password.checkPolicy('xxNanthida-2026', 'nanthida@example.com'), 'รหัสผ่านต้องไม่มีชื่ออีเมลอยู่ในรหัส');
    assert.equal(password.checkPolicy('x'.repeat(129), 'a@b.co'), 'รหัสผ่านยาวได้ไม่เกิน 128 ตัว');
    // ส่วนหน้า @ สั้นกว่า 3 ตัว ไม่นับ
    assert.equal(password.checkPolicy('ab-long-enough-pw', 'ab@example.com'), null);
    // ตัวพิมพ์เล็กล้วน ยาวพอ ไม่ใช่รหัสยอดนิยม → ผ่าน (ตามแนว NIST)
    assert.equal(password.checkPolicy('ตั้งรหัสภาษาไทยก็ได้นะ', 'a@b.co'), null);
    assert.equal(password.checkPolicy('purple coffee river', 'a@b.co'), null);
  });

  test('data/common-passwords.txt มีอย่างน้อย 1,000 คำ (ใน Docker ใช้สำเนา /seed ได้)', () => {
    assert.match(password.commonList.file, /common-passwords\.txt$/);
    assert.ok(password.commonList.size >= 1000, `มี ${password.commonList.size} คำ`);
    assert.ok(password.isCommon('QWERTYUIOP'));
    // ไฟล์ใน repo ต้องมีครบด้วย (Dockerfile copy ไป /seed จากไฟล์นี้)
    const repoFile = path.join(ROOT, 'data', 'common-passwords.txt');
    if (fs.existsSync(repoFile)) {
      const words = fs.readFileSync(repoFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
      assert.ok(words.length >= 1000, `ไฟล์ใน repo มี ${words.length} คำ`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Auth Phase 1 — สมัคร / ล็อกอิน / session', () => {
  let s;
  before(async () => (s = await startServer()));
  after(() => s.stop());

  test('สมัครสำเร็จ → 201 + cookie HttpOnly/SameSite=Lax/Path=/ 30 วัน (ไม่ Secure นอก production) → /api/me', async () => {
    const b = browser(s);
    const email = newEmail();
    const r = await b.signup(`  ${email.toUpperCase()} `, GOOD_PW, { marketing: true });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.email, email); // trim + lowercase
    assert.deepEqual(Object.keys(r.body).sort(), ['createdAt', 'email']);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const c = r.setCookies.find((x) => x.startsWith('koinz_sid='));
    assert.ok(c, 'ต้องตั้ง cookie koinz_sid');
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Path=\//);
    assert.match(c, /Max-Age=2592000/);
    assert.doesNotMatch(c, /Secure/);

    const me = await b.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.email, email);
    assert.equal(me.body.sessionCount, 1);
    assert.equal(me.headers.get('cache-control'), 'no-store');

    const users = await s.readData('users');
    const u = users.find((x) => x.email === email);
    assert.equal(u.terms_version ?? u.termsVersion, '2026-11');
    assert.equal(u.marketing_opt_in ?? u.marketingOptIn, true);
    assert.ok(u.terms_accepted_at ?? u.termsAcceptedAt);
  });

  test('ไม่มี session → /api/me 401 / cookie ปลอม → 401 และล้าง cookie', async () => {
    const b = browser(s);
    assert.equal((await b.get('/api/me')).status, 401);
    b.jar.koinz_sid = crypto.randomBytes(32).toString('base64url');
    const r = await b.get('/api/me');
    assert.equal(r.status, 401);
    assert.ok(r.setCookies.some((c) => /^koinz_sid=;/.test(c) && /Max-Age=0/.test(c)));
  });

  test('รหัสไม่ผ่านนโยบาย / ไม่ยอมรับเงื่อนไข / อีเมลผิดรูปแบบ → 400 ข้อความไทย', async () => {
    const b = browser(s);
    const cases = [
      [{ email: newEmail(), password: 'abcdefgh9', acceptTerms: true }, 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัว'],
      [{ email: newEmail(), password: 'password1234', acceptTerms: true }, 'รหัสผ่านนี้คนใช้กันบ่อย เดาง่าย ลองตั้งรหัสอื่น'],
      [{ email: 'somchai@example.com', password: 'Somchai-2026-pw', acceptTerms: true }, 'รหัสผ่านต้องไม่มีชื่ออีเมลอยู่ในรหัส'],
      [{ email: newEmail(), password: GOOD_PW }, 'กรุณายอมรับเงื่อนไขการใช้งานและนโยบายความเป็นส่วนตัวก่อนสมัคร'],
      [{ email: newEmail(), password: GOOD_PW, acceptTerms: 'true' }, 'กรุณายอมรับเงื่อนไขการใช้งานและนโยบายความเป็นส่วนตัวก่อนสมัคร'],
      [{ email: 'not-an-email', password: GOOD_PW, acceptTerms: true }, 'กรุณากรอกอีเมลให้ถูกต้อง'],
    ];
    for (const [body, msg] of cases) {
      const r = await b.post('/api/auth/signup', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, msg);
      assert.equal(r.setCookies.length, 0);
    }
  });

  test('สมัครซ้ำ → ข้อความกลาง ๆ ไม่ยืนยันว่ามีบัญชี และไม่ได้ session', async () => {
    const email = newEmail();
    assert.equal((await browser(s).signup(email)).status, 201);
    const r = await browser(s).signup(email.toUpperCase(), 'another-good-pass-42');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'สมัครไม่สำเร็จ ถ้าเคยสมัครด้วยอีเมลนี้แล้ว ลองเข้าสู่ระบบหรือกดลืมรหัสผ่าน');
    assert.equal(r.setCookies.length, 0);
  });

  test('ล็อกอินผิด: อีเมลไม่มี กับ รหัสผิด → response เหมือนกันทุก byte', async () => {
    const email = newEmail();
    await browser(s).signup(email);
    const wrongPw = await browser(s).login(email, 'wrong-password-1');
    const noUser = await browser(s).login(newEmail(), 'wrong-password-1');
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPw.text, noUser.text);
    assert.equal(wrongPw.body.error, BAD_LOGIN);
  });

  test('ล็อกอินใหม่ = session ใหม่เสมอ (กัน fixation), ออกจากระบบ = ลบแถว + ล้าง cookie', async () => {
    const email = newEmail();
    const b = browser(s);
    await b.signup(email);
    const first = b.jar.koinz_sid;
    assert.equal((await b.login(email)).status, 200);
    const second = b.jar.koinz_sid;
    assert.notEqual(first, second);
    // token เดิมของเบราว์เซอร์นี้ใช้ไม่ได้แล้ว
    const old = browser(s);
    old.jar.koinz_sid = first;
    assert.equal((await old.get('/api/me')).status, 401);
    assert.equal((await b.get('/api/me')).body.sessionCount, 1);

    const out = await b.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.ok(out.setCookies.some((c) => /^koinz_sid=;/.test(c) && /Max-Age=0/.test(c)));
    const again = browser(s);
    again.jar.koinz_sid = second;
    assert.equal((await again.get('/api/me')).status, 401);
    const sessions = await s.readData('sessions');
    assert.ok(!sessions.some((x) => x.id === sha256(second)));
  });

  test('ใน DB/ไฟล์ไม่มี token session แบบดิบ — เก็บแค่ sha256 และ ip_hash ไม่ใช่ IP', async () => {
    const email = newEmail();
    const a = browser(s);
    const b = browser(s);
    await a.signup(email);
    await b.login(email);
    const tokens = [a.jar.koinz_sid, b.jar.koinz_sid];
    assert.equal((await a.get('/api/me')).body.sessionCount, 2);
    const dump = await s.dumpAll();
    const sessions = await s.readData('sessions');
    for (const t of tokens) {
      assert.match(t, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!dump.includes(t), 'พบ token ดิบในที่เก็บข้อมูล');
      const row = sessions.find((x) => x.id === sha256(t));
      assert.ok(row, 'ต้องเก็บ sha256(token)');
      assert.match(row.ip_hash ?? row.ipHash, /^[0-9a-f]{64}$/);
    }
    assert.ok(!dump.includes(GOOD_PW), 'พบรหัสผ่านดิบในที่เก็บข้อมูล');
  });

  test('ผิด 5 ครั้ง → ล็อก 15 นาที: ครั้งที่ 6 ได้ข้อความล็อก แม้รหัสถูก (มี retryAfter ให้นับถอยหลัง)', async () => {
    const email = newEmail();
    await browser(s).signup(email);
    const b = browser(s);
    for (let i = 1; i <= 4; i++) {
      const r = await b.login(email, `wrong-password-${i}`);
      assert.equal(r.status, 401, `ครั้งที่ ${i}`);
      assert.equal(r.body.error, BAD_LOGIN);
    }
    const fifth = await b.login(email, 'wrong-password-5');
    assert.equal(fifth.status, 423);
    assert.equal(fifth.body.error, LOCKED);
    const sixth = await b.login(email, GOOD_PW);
    assert.equal(sixth.status, 423);
    assert.equal(sixth.body.error, LOCKED);
    assert.ok(sixth.body.retryAfter > 14 * 60 && sixth.body.retryAfter <= 15 * 60, `retryAfter ${sixth.body.retryAfter}`);
    assert.ok(Date.parse(sixth.body.lockedUntil) > Date.now() + 14 * 60000);
    assert.equal(sixth.headers.get('retry-after'), String(sixth.body.retryAfter));
    assert.equal(sixth.setCookies.length, 0);
    assert.equal((await b.get('/api/me')).status, 401);

    const audit = (await s.readData('audit')).filter((a) => a.actor === 'member');
    assert.ok(audit.some((a) => a.action === 'member_locked'));
    assert.ok(!JSON.stringify(audit).includes(email), 'audit ห้ามมีอีเมลเต็ม');
  });

  test('อีเมลที่ไม่มีบัญชีก็ถูกล็อกแบบเดียวกัน (การล็อกไม่บอกว่ามีอีเมลนี้)', async () => {
    const email = newEmail();
    const b = browser(s);
    for (let i = 1; i <= 4; i++) assert.equal((await b.login(email, `wrong-password-${i}`)).status, 401);
    assert.equal((await b.login(email, 'wrong-password-5')).status, 423);
    const r = await b.login(email, GOOD_PW);
    assert.equal(r.status, 423);
    assert.equal(r.body.error, LOCKED);
  });

  test('ล็อกอินสำเร็จรีเซ็ตตัวนับ: ผิด 4 → ถูก → ผิดอีก 4 ยังไม่ล็อก', async () => {
    const email = newEmail();
    await browser(s).signup(email);
    const b = browser(s);
    for (let i = 0; i < 4; i++) await b.login(email, 'wrong-password-x');
    assert.equal((await b.login(email)).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await b.login(email, 'wrong-password-y')).status, 401);
  });

  test('session สมาชิกเข้า /api/admin/* ไม่ได้', async () => {
    const b = browser(s);
    await b.signup(newEmail());
    assert.equal((await b.get('/api/admin/orders')).status, 401);
    assert.equal((await b.get('/api/admin/stats')).status, 401);
  });
});

// ---------------------------------------------------------------------------
describe('Auth Phase 1 — กัน CSRF / คำขอข้ามเว็บ', () => {
  let s;
  before(async () => (s = await startServer({ FRONTEND_ORIGIN: 'https://rewchen.github.io' })));
  after(() => s.stop());

  const send = (url, headers, body = '{"email":"x@example.com","password":"whatever-pass"}') =>
    fetch(s.base + url, { method: 'POST', headers, body }).then(async (r) => ({ status: r.status, body: await r.json() }));

  test('POST ที่ Origin เป็นเว็บอื่น / ไม่มี Origin / Origin null → 403', async () => {
    for (const url of ['/api/auth/login', '/api/auth/signup', '/api/auth/logout']) {
      for (const origin of ['https://evil.example', null, 'null', 'http://127.0.0.1.evil.example']) {
        const r = await send(url, { 'content-type': 'application/json', ...(origin ? { origin } : {}) });
        assert.equal(r.status, 403, `${url} origin=${origin}`);
        assert.match(r.body.error, /ไม่ได้มาจากหน้าเว็บของร้าน/);
      }
    }
  });

  test('ไม่ใช่ application/json (เช่น form ข้ามเว็บ) → 403', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await send('/api/auth/login', { 'content-type': type, origin: s.base });
      assert.equal(r.status, 403, type);
    }
  });

  test('Sec-Fetch-Site: cross-site → 403 แม้ Origin ถูก / same-origin, same-site ผ่าน', async () => {
    const h = { 'content-type': 'application/json', origin: s.base };
    assert.equal((await send('/api/auth/login', { ...h, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await send('/api/auth/login', { ...h, 'sec-fetch-site': 'same-origin' })).status, 401);
    assert.equal((await send('/api/auth/login', { ...h, 'sec-fetch-site': 'same-site' })).status, 401);
  });

  test('โดเมนตัวเอง และ FRONTEND_ORIGIN ผ่านชั้นนี้ (ได้ 401 จากการล็อกอินผิดแทน)', async () => {
    for (const origin of [s.base, 'https://rewchen.github.io']) {
      const r = await send('/api/auth/login', { 'content-type': 'application/json', origin });
      assert.equal(r.status, 401, origin);
    }
  });

  test('GET ไม่ต้องมี Origin (ไม่เปลี่ยนข้อมูล)', async () => {
    assert.equal((await fetch(s.base + '/api/me')).status, 401);
  });

  test('route เดิมของร้าน (สั่งซื้อแบบ guest) ไม่โดนชั้นนี้', async () => {
    const r = await fetch(s.base + '/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameSlug: 'mobile-legends', packageId: 'mobile-legends-3', playerInputs: { uid: '123456789', zone: '1234' } }),
    });
    assert.equal(r.status, 201);
  });
});

// ---------------------------------------------------------------------------
describe('Auth Phase 1 — production ต้องมี SESSION_SECRET และ cookie เป็น Secure', () => {
  const run = (env) =>
    spawnSync(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ...BASE_ENV, NODE_ENV: 'production', ADMIN_PASSWORD: 'a-strong-admin-pass-99', ...env },
      encoding: 'utf8',
      timeout: 10000,
    });

  test('ไม่ตั้ง / สั้นกว่า 32 ตัว → ไม่ยอม start', () => {
    for (const secret of ['', 'short-secret']) {
      const r = run({ SESSION_SECRET: secret });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /SESSION_SECRET/);
    }
  });

  test('ตั้งครบ → cookie มี Secure', async () => {
    const s = await startServer({
      NODE_ENV: 'production', ADMIN_PASSWORD: 'a-strong-admin-pass-99', SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
    });
    try {
      const r = await browser(s).signup(newEmail());
      assert.equal(r.status, 201);
      assert.match(r.setCookies.find((c) => c.startsWith('koinz_sid=')), /; Secure/);
    } finally {
      await s.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// ลิงก์ตั้งรหัสใหม่ (route อยู่ใน Phase 2) — เทสชั้นข้อมูลในโปรเซสนี้: เก็บแค่ sha256, token ดิบไม่ถูกเก็บ
describe('Auth Phase 1 — token ตั้งรหัสใหม่ไม่ถูกเก็บแบบดิบ', () => {
  let dir;
  let db;
  let repo;
  let members;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koinz-auth-'));
    db = PG_ADMIN_URL ? await createTestDatabase() : null;
    Object.assign(process.env, { ...BASE_ENV, KOINZ_DATA_DIR: dir, DATABASE_URL: db ? db.url : '' });
    repo = require('../src/repo');
    members = require('../src/auth/members');
    await repo.init({ log: () => {} });
  });
  after(async () => {
    await repo.close();
    if (db) await db.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('createPasswordReset → คืน token ดิบ 1 ครั้ง, เก็บ sha256 + หมดอายุ 30 นาที', async () => {
    const user = await members.signup({ email: newEmail(), password: GOOD_PW, acceptTerms: true });
    const token = await members.createPasswordReset(user.id);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const stored = await repo.getPasswordReset(sha256(token));
    assert.ok(stored);
    assert.equal(stored.userId, user.id);
    assert.equal(stored.usedAt, null);
    const ttl = Date.parse(stored.expiresAt) - Date.parse(stored.createdAt);
    assert.equal(ttl, 30 * 60 * 1000);
    assert.equal(await repo.getPasswordReset(token), null);

    let dump;
    if (db) {
      const rows = (await repo.pool.query('SELECT * FROM password_resets')).rows;
      dump = JSON.stringify(rows);
    } else {
      dump = fs.readFileSync(path.join(dir, 'password_resets.json'), 'utf8');
    }
    assert.ok(!dump.includes(token), 'พบ token ดิบ');
    assert.ok(dump.includes(sha256(token)));
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — API สมาชิก (อีเมลแบบ log: ลิงก์ตั้งรหัสใหม่อยู่ใน log ของเซิร์ฟเวอร์)
const MAIL_ENV = { MAIL_PROVIDER: 'log', MAIL_LOG_LINKS: '1', PUBLIC_URL: 'https://koinz.test' };
const FORGOT_SENT = 'ถ้าอีเมลนี้มีบัญชีกับร้าน เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว ลิงก์ใช้ได้ 30 นาที และใช้ได้ครั้งเดียว';
const resetTokens = (s) =>
  [...s.log().matchAll(/https:\/\/koinz\.test\/reset\.html#token=([A-Za-z0-9_-]{43})/g)].map((m) => m[1]);
async function nextResetToken(s, before) {
  const t = await waitFor(() => (resetTokens(s).length > before ? resetTokens(s).at(-1) : null), 3000, 20);
  assert.ok(t, 'ไม่พบลิงก์ตั้งรหัสใหม่ใน log');
  return t;
}
async function member(s, email = newEmail(), pw = GOOD_PW) {
  const b = browser(s);
  const r = await b.signup(email, pw);
  assert.equal(r.status, 201, r.text);
  b.email = email;
  return b;
}
const del = (s, url, b, origin = s.base) =>
  fetch(s.base + url, { method: 'DELETE', headers: { origin, cookie: `koinz_sid=${b.jar.koinz_sid}` } });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Auth Phase 2 — ลืมรหัส / ตั้งรหัสใหม่', () => {
  let s;
  before(async () => (s = await startServer(MAIL_ENV)));
  after(() => s.stop());

  test('/api/config บอกว่าเปิดลืมรหัสผ่าน และปิดปุ่ม LINE', async () => {
    const c = (await s.req('GET', '/api/config')).body;
    assert.equal(c.passwordResetEnabled, true);
    assert.equal(c.lineLoginEnabled, false);
  });

  test('forgot ด้วยอีเมลที่มีและไม่มี → response เหมือนกันทุก byte (มีบัญชีเท่านั้นที่ได้อีเมล)', async () => {
    const a = await member(s);
    const n = resetTokens(s).length;
    const has = await browser(s).post('/api/auth/forgot', { email: a.email });
    const none = await browser(s).post('/api/auth/forgot', { email: newEmail() });
    assert.equal(has.status, 200);
    assert.equal(none.status, 200);
    assert.equal(has.text, none.text);
    assert.equal(has.headers.get('content-length'), none.headers.get('content-length'));
    assert.equal(has.body.message, FORGOT_SENT);
    await nextResetToken(s, n);
    await pause(200);
    assert.equal(resetTokens(s).length, n + 1, 'อีเมลที่ไม่มีบัญชีต้องไม่ได้ลิงก์');
  });

  test('ลิงก์ใช้ได้ → GET บอกอีเมล / ใช้ครั้งที่ 2 ไม่ได้ และ GET ไม่บอกอีเมล', async () => {
    const a = await member(s);
    const n = resetTokens(s).length;
    await browser(s).post('/api/auth/forgot', { email: a.email });
    const token = await nextResetToken(s, n);

    const check = await browser(s).get(`/api/auth/reset/${token}`);
    assert.equal(check.status, 200);
    assert.deepEqual(check.body, { valid: true, email: a.email });

    // รหัสใหม่ไม่ผ่านนโยบาย → ลิงก์ยังไม่ถูกใช้
    const weak = await browser(s).post('/api/auth/reset', { token, password: 'password1234' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error, 'รหัสผ่านนี้คนใช้กันบ่อย เดาง่าย ลองตั้งรหัสอื่น');

    const b = browser(s);
    const ok = await b.post('/api/auth/reset', { token, password: 'brand-new-secret-41', logoutOthers: true });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.email, a.email);
    assert.equal((await b.get('/api/me')).status, 200, 'ตั้งรหัสใหม่แล้วต้องล็อกอินให้');

    const again = await browser(s).post('/api/auth/reset', { token, password: 'another-new-secret-42' });
    assert.equal(again.status, 400);
    assert.equal(again.body.resetInvalid, true);
    const gone = await browser(s).get(`/api/auth/reset/${token}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.valid, false);
    assert.ok(!gone.text.includes(a.email));

    assert.equal((await browser(s).login(a.email, GOOD_PW)).status, 401);
    assert.equal((await browser(s).login(a.email, 'brand-new-secret-41')).status, 200);
    assert.ok(await waitFor(() => /รหัสผ่านของคุณถูกเปลี่ยนแล้ว/.test(s.log()), 3000, 20), 'ต้องมีอีเมลแจ้งเปลี่ยนรหัส');
  });

  test('ลิงก์เลย 30 นาที → ใช้ไม่ได้', async () => {
    const a = await member(s);
    const n = resetTokens(s).length;
    await browser(s).post('/api/auth/forgot', { email: a.email });
    const token = await nextResetToken(s, n);
    const past = new Date(Date.now() - 1000).toISOString();
    await s.mutate('password_resets', {
      json: (list) => list.forEach((r) => { if (r.tokenHash === sha256(token)) r.expiresAt = past; }),
      sql: 'UPDATE password_resets SET expires_at = $2 WHERE token_hash = $1',
      params: [sha256(token), past],
    });
    assert.equal((await browser(s).get(`/api/auth/reset/${token}`)).status, 404);
    const r = await browser(s).post('/api/auth/reset', { token, password: 'brand-new-secret-43' });
    assert.equal(r.status, 400);
    assert.equal(r.body.resetInvalid, true);
    assert.equal((await browser(s).login(a.email)).status, 200, 'รหัสเดิมยังใช้ได้');
  });

  test('reset สำเร็จพร้อม logoutOthers → session อื่นใช้ไม่ได้ทันที / ลิงก์อื่นของ user ถูกลบ', async () => {
    const a = await member(s);
    const other = browser(s);
    await other.login(a.email);
    assert.equal((await other.get('/api/me')).status, 200);
    const n = resetTokens(s).length;
    await browser(s).post('/api/auth/forgot', { email: a.email });
    const first = await nextResetToken(s, n);
    await browser(s).post('/api/auth/forgot', { email: a.email }); // เทสปิด rate limit จึงขอซ้ำได้ทันที
    const second = await nextResetToken(s, n + 1);
    assert.notEqual(first, second);

    const r = await browser(s).post('/api/auth/reset', { token: second, password: 'brand-new-secret-44', logoutOthers: true });
    assert.equal(r.status, 200);
    assert.equal((await other.get('/api/me')).status, 401);
    assert.equal((await a.get('/api/me')).status, 401);
    assert.equal((await browser(s).get(`/api/auth/reset/${first}`)).status, 404, 'ลิงก์อื่นต้องใช้ไม่ได้แล้ว');
  });

  test('reset แบบ logoutOthers: false → เครื่องอื่นยังอยู่', async () => {
    const a = await member(s);
    const n = resetTokens(s).length;
    await browser(s).post('/api/auth/forgot', { email: a.email });
    const token = await nextResetToken(s, n);
    const r = await browser(s).post('/api/auth/reset', { token, password: 'brand-new-secret-45', logoutOthers: false });
    assert.equal(r.status, 200);
    assert.equal((await a.get('/api/me')).status, 200);
  });

  test('reset ปลดล็อกบัญชีที่โดนล็อก', async () => {
    const a = await member(s);
    for (let i = 0; i < 5; i++) await browser(s).login(a.email, `wrong-password-${i}`);
    assert.equal((await browser(s).login(a.email)).status, 423);
    const n = resetTokens(s).length;
    await browser(s).post('/api/auth/forgot', { email: a.email });
    const token = await nextResetToken(s, n);
    assert.equal((await browser(s).post('/api/auth/reset', { token, password: 'brand-new-secret-46' })).status, 200);
    assert.equal((await browser(s).login(a.email, 'brand-new-secret-46')).status, 200);
  });

  test('audit ไม่มีรหัสผ่าน / token / อีเมลเต็ม และ log ไม่มีรหัสผ่าน อีเมลใน log ปิดบางส่วน', async () => {
    const audit = (await s.readData('audit')).filter((x) => x.actor === 'member');
    const text = JSON.stringify(audit);
    assert.ok(audit.some((x) => x.action === 'member_reset'));
    assert.ok(audit.some((x) => x.action === 'member_reset_requested'));
    assert.doesNotMatch(text.replace(/\*\*\*@example\.com/g, ''), /@example\.com/, 'audit มีอีเมลเต็ม');
    for (const t of resetTokens(s)) assert.ok(!text.includes(t));
    assert.ok(!s.log().includes(GOOD_PW) && !s.log().includes('brand-new-secret'));
    assert.match(s.log(), /\[mail:log\] ถึง m\*\*\*@example\.com/);
    assert.doesNotMatch(s.log(), /member[a-z0-9]+@example\.com/);
  });
});

describe('Auth Phase 2 — บัญชีของฉัน', () => {
  let s;
  before(async () => (s = await startServer(MAIL_ENV)));
  after(() => s.stop());

  test('เปลี่ยนรหัส: รหัสเดิมผิด → 400 / สำเร็จ → session อื่นหลุด เครื่องนี้ยังอยู่ + อีเมลแจ้ง', async () => {
    const a = await member(s);
    const other = browser(s);
    await other.login(a.email);
    assert.equal((await a.get('/api/me')).body.sessionCount, 2);

    const wrong = await a.post('/api/me/password', { currentPassword: 'not-my-password', newPassword: 'brand-new-secret-51' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    const weak = await a.post('/api/me/password', { currentPassword: GOOD_PW, newPassword: 'short' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error, 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัว');
    const same = await a.post('/api/me/password', { currentPassword: GOOD_PW, newPassword: GOOD_PW });
    assert.equal(same.status, 400);
    assert.equal(same.body.error, 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');

    const ok = await a.post('/api/me/password', { currentPassword: GOOD_PW, newPassword: 'brand-new-secret-51' });
    assert.equal(ok.status, 200, ok.text);
    const me = await a.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.sessionCount, 1);
    assert.equal((await other.get('/api/me')).status, 401);
    assert.equal((await browser(s).login(a.email, 'brand-new-secret-51')).status, 200);
    assert.ok(await waitFor(() => /รหัสผ่านของคุณถูกเปลี่ยนแล้ว/.test(s.log()), 3000, 20));
  });

  test('ออกจากระบบทุกอุปกรณ์ → ทุก session (รวมเครื่องนี้) ใช้ไม่ได้', async () => {
    const a = await member(s);
    const other = browser(s);
    await other.login(a.email);
    const r = await a.post('/api/auth/logout-all');
    assert.equal(r.status, 200);
    assert.equal((await a.get('/api/me')).status, 401);
    assert.equal((await other.get('/api/me')).status, 401);
    assert.equal((await browser(s).post('/api/auth/logout-all')).status, 401);
  });

  test('สั่งออเดอร์ตอนล็อกอิน → ผูกกับบัญชี + บันทึก UID / guest ไม่ผูก', async () => {
    const a = await member(s);
    const r = await a.post('/api/orders', mlOrder());
    assert.equal(r.status, 201, r.text);
    const guest = await browser(s).post('/api/orders', mlOrder({ playerInputs: { uid: '555555555', zone: '5555' } }));
    assert.equal(guest.status, 201);

    const orders = await a.get('/api/me/orders');
    assert.equal(orders.status, 200);
    assert.deepEqual(orders.body.map((o) => o.id), [r.body.id]);
    const o = orders.body[0];
    for (const k of ['token', 'contact', 'lineId', 'customerNote', 'userId', 'idempotencyKey', 'sku']) {
      assert.ok(!(k in o), `ไม่ควรมี ${k}`);
    }
    assert.equal(o.playerLabel, 'User ID 123456789 · Zone ID 1234');

    const all = await s.readData('orders');
    assert.ok(all.find((x) => x.id === r.body.id).userId);
    assert.ok(!all.find((x) => x.id === guest.body.id).userId);
    // หน้าออเดอร์แบบ token ไม่เปิดเผย userId
    const pub = await browser(s).get(`/api/orders/${r.body.id}?t=${r.body.token}`);
    assert.equal(pub.status, 200);
    assert.ok(!('userId' in pub.body));

    const players = await a.get('/api/me/players');
    assert.deepEqual(players.body.map((p) => [p.gameSlug, p.inputs, p.label]), [
      ['mobile-legends', { uid: '123456789', zone: '1234' }, 'User ID 123456789 · Zone ID 1234'],
    ]);
    // สั่งเกมเดิมด้วย UID ใหม่ → แทนที่ของเดิม (1 แถวต่อเกม)
    await a.post('/api/orders', mlOrder({ playerInputs: { uid: '987654321', zone: '4321' } }));
    const one = await a.get('/api/me/players/mobile-legends');
    assert.deepEqual(one.body.inputs, { uid: '987654321', zone: '4321' });
    assert.equal((await a.get('/api/me/players')).body.length, 1);

    assert.equal((await del(s, '/api/me/players/mobile-legends', a, 'https://evil.example')).status, 403);
    assert.equal((await del(s, '/api/me/players/mobile-legends', a)).status, 200);
    assert.equal((await a.get('/api/me/players')).body.length, 0);
    assert.equal((await a.get('/api/me/players/mobile-legends')).status, 404);
    assert.equal((await del(s, '/api/me/players/mobile-legends', a)).status, 404);
  });

  test('claim: token ถูก → ผูก / token ผิด หรือมีเจ้าของแล้ว → ไม่ผูก', async () => {
    const guest = browser(s);
    const o1 = (await guest.post('/api/orders', mlOrder())).body;
    const o2 = (await guest.post('/api/orders', mlOrder())).body;
    const o3 = (await guest.post('/api/orders', mlOrder())).body;
    const a = await member(s);
    const b = await member(s);

    assert.equal((await browser(s).post('/api/me/orders/claim', [{ id: o1.id, token: o1.token }])).status, 401);
    const first = await a.post('/api/me/orders/claim', [
      { id: o1.id, token: o1.token },
      { id: o2.id, token: 'f'.repeat(32) },
      { id: 'KZNOTEXIST', token: o1.token },
      { nonsense: true },
    ]);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body.claimed, [o1.id]);
    // B มี token ถูกของ o1 แต่ o1 เป็นของ A แล้ว → ไม่ผูก, o3 ยังว่าง → ผูก
    const second = await b.post('/api/me/orders/claim', [{ id: o1.id, token: o1.token }, { id: o3.id, token: o3.token }]);
    assert.deepEqual(second.body.claimed, [o3.id]);
    assert.deepEqual((await a.get('/api/me/orders')).body.map((o) => o.id), [o1.id]);
    assert.deepEqual((await b.get('/api/me/orders')).body.map((o) => o.id), [o3.id]);
    const all = await s.readData('orders');
    assert.ok(!all.find((x) => x.id === o2.id).userId);
    assert.deepEqual((await a.post('/api/me/orders/claim', [{ id: o1.id, token: o1.token }])).body.claimed, []);
    assert.equal((await a.post('/api/me/orders/claim', { orders: 'x' })).status, 400);
    assert.ok((await s.readData('audit')).some((x) => x.action === 'member_claim' && x.orderId === o1.id));
  });

  test('IDOR: /api/me/* เห็นเฉพาะของตัวเอง', async () => {
    const a = await member(s);
    const b = await member(s);
    await a.post('/api/orders', mlOrder());
    assert.equal((await b.get('/api/me/orders')).body.length, 0);
    assert.equal((await b.get('/api/me/players')).body.length, 0);
    assert.equal((await b.get('/api/me/players/mobile-legends')).status, 404);
    assert.equal((await del(s, '/api/me/players/mobile-legends', b)).status, 404);
    assert.equal((await a.get('/api/me/players')).body.length, 1, 'ของ A ต้องไม่ถูก B ลบ');
    assert.equal((await b.get('/api/me')).body.email, b.email);
  });

  test('ลบบัญชี: รหัสผิด → 400 / สำเร็จ → ล้าง session/UID/ลิงก์, ออเดอร์เหลือแต่ไม่ผูก, users เหลือแบบไม่มีข้อมูล', async () => {
    const a = await member(s);
    const other = browser(s);
    await other.login(a.email);
    const order = (await a.post('/api/orders', mlOrder())).body;
    await browser(s).post('/api/auth/forgot', { email: a.email });

    const wrong = await a.post('/api/me/delete', { password: 'not-my-password' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'รหัสผ่านไม่ถูกต้อง');
    assert.equal((await a.get('/api/me')).status, 200);

    const id = (await s.readData('users')).find((u) => u.email === a.email).id;
    const ok = await a.post('/api/me/delete', { password: GOOD_PW });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.setCookies.some((c) => /^koinz_sid=;/.test(c)));
    assert.equal((await a.get('/api/me')).status, 401);
    assert.equal((await other.get('/api/me')).status, 401);
    const login = await browser(s).login(a.email);
    assert.equal(login.status, 401);
    assert.equal(login.body.error, BAD_LOGIN);

    const u = (await s.readData('users')).find((x) => x.id === id);
    assert.equal(u.email, `deleted-${id}@invalid`);
    assert.ok(u.deleted_at ?? u.deletedAt);
    assert.ok(!JSON.stringify(u).includes('scrypt$'));
    const uid = (x) => x.user_id ?? x.userId;
    assert.ok(!((await s.readData('sessions')) || []).some((x) => uid(x) === id));
    assert.ok(!((await s.readData('saved_players')) || []).some((x) => uid(x) === id));
    assert.ok(!((await s.readData('password_resets')) || []).some((x) => uid(x) === id));
    const kept = (await s.readData('orders')).find((x) => x.id === order.id);
    assert.ok(kept, 'ออเดอร์ต้องยังอยู่');
    assert.ok(!kept.userId);
    assert.equal((await browser(s).signup(a.email)).status, 201, 'สมัครใหม่ด้วยอีเมลเดิมได้');
    assert.ok((await s.readData('audit')).some((x) => x.action === 'member_deleted'));
  });

  test('session สมาชิกเรียก /api/admin/orders → 401 (ระบบแอดมินแยกจากสมาชิก)', async () => {
    const a = await member(s);
    assert.equal((await a.get('/api/admin/orders')).status, 401);
    assert.equal((await a.get('/api/admin/orders', { authorization: `Bearer ${a.jar.koinz_sid}` })).status, 401);
  });

  test('ต้องล็อกอินก่อน: /api/me/* ไม่มี session → 401', async () => {
    const b = browser(s);
    for (const [m, url] of [['GET', '/api/me/orders'], ['GET', '/api/me/players'], ['POST', '/api/me/password'], ['POST', '/api/me/delete']]) {
      const r = m === 'GET' ? await b.get(url) : await b.post(url, {});
      assert.equal(r.status, 401, url);
    }
  });
});

describe('Auth Phase 2 — ปิดอีเมล / จำกัดต่ออีเมล / Resend / production', () => {
  test('ไม่ตั้ง MAIL_PROVIDER → passwordResetEnabled false และ forgot ตอบ 503 ให้ติดต่อร้าน', async () => {
    const s = await startServer();
    try {
      assert.equal((await s.req('GET', '/api/config')).body.passwordResetEnabled, false);
      const r = await browser(s).post('/api/auth/forgot', { email: newEmail() });
      assert.equal(r.status, 503);
      assert.match(r.body.error, /ติดต่อร้านทาง LINE/);
    } finally {
      await s.stop();
    }
  });

  test('ต่ออีเมล: ขอซ้ำภายใน 60 วินาที → ไม่ส่งอีเมลรอบ 2 แต่ตอบเหมือนเดิม', async () => {
    const s = await startServer({ ...MAIL_ENV, RATE_LIMIT_OFF: '0' });
    try {
      const a = await member(s);
      const first = await browser(s).post('/api/auth/forgot', { email: a.email });
      const second = await browser(s).post('/api/auth/forgot', { email: a.email.toUpperCase() });
      assert.equal(first.status, 200);
      assert.equal(first.text, second.text);
      await nextResetToken(s, 0);
      await pause(300);
      assert.equal(resetTokens(s).length, 1);
    } finally {
      await s.stop();
    }
  });

  test('MAIL_PROVIDER=resend → POST /emails พร้อม Bearer key; log ไม่มี key/อีเมลเต็ม', async () => {
    const sent = [];
    const resend = await fakeServer((app) => app.post('/emails', (req, res) => {
      sent.push({ auth: req.headers.authorization, body: req.body });
      res.json({ id: 'email_1' });
    }));
    const key = 're_test_' + crypto.randomBytes(8).toString('hex');
    const s = await startServer({
      MAIL_PROVIDER: 'resend', RESEND_API_KEY: key, RESEND_API_URL: resend.url,
      MAIL_FROM: 'Koinz <no-reply@koinz.test>', PUBLIC_URL: 'https://koinz.test',
    });
    try {
      assert.equal((await s.req('GET', '/api/config')).body.passwordResetEnabled, true);
      const a = await member(s);
      assert.equal((await browser(s).post('/api/auth/forgot', { email: a.email })).status, 200);
      assert.ok(await waitFor(() => sent.length === 1, 3000, 20));
      assert.equal(sent[0].auth, `Bearer ${key}`);
      assert.deepEqual(sent[0].body.to, [a.email]);
      assert.equal(sent[0].body.from, 'Koinz <no-reply@koinz.test>');
      assert.match(sent[0].body.text, /https:\/\/koinz\.test\/reset\.html#token=[A-Za-z0-9_-]{43}/);
      assert.ok(!s.log().includes(key));
      assert.ok(!s.log().includes(a.email));
    } finally {
      await s.stop();
      await resend.close();
    }
  });

  test('production: MAIL_LOG_LINKS=1 ไม่มี SITE_BANNER → ไม่ยอม start / มี SITE_BANNER (staging) → ใช้โดเมน Railway ในลิงก์', async () => {
    const secret = crypto.randomBytes(32).toString('base64url');
    const prod = { NODE_ENV: 'production', ADMIN_PASSWORD: 'a-strong-admin-pass-99', SESSION_SECRET: secret };
    const run = (env) => spawnSync(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: { ...process.env, ...BASE_ENV, ...prod, ...env }, encoding: 'utf8', timeout: 10000,
    });
    const leak = run({ MAIL_PROVIDER: 'log', MAIL_LOG_LINKS: '1' });
    assert.equal(leak.status, 1);
    assert.match(leak.stderr, /MAIL_LOG_LINKS/);
    const noKey = run({ MAIL_PROVIDER: 'resend' });
    assert.equal(noKey.status, 1);
    assert.match(noKey.stderr, /RESEND_API_KEY/);
    const typo = run({ MAIL_PROVIDER: 'smtp' });
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /MAIL_PROVIDER/);

    const s = await startServer({
      ...prod, MAIL_PROVIDER: 'log', MAIL_LOG_LINKS: '1', SITE_BANNER: 'เว็บทดสอบ — ห้ามโอนเงินจริง',
      RAILWAY_PUBLIC_DOMAIN: 'koinz-staging.up.railway.app',
    });
    try {
      assert.equal((await s.req('GET', '/api/config')).body.passwordResetEnabled, true);
      const a = await member(s);
      await browser(s).post('/api/auth/forgot', { email: a.email });
      assert.ok(await waitFor(() => /https:\/\/koinz-staging\.up\.railway\.app\/reset\.html#token=/.test(s.log()), 3000, 20));
    } finally {
      await s.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('Auth Phase 3 — API ที่หน้าเว็บสมาชิกใช้', () => {
  let s;
  before(async () => (s = await startServer(MAIL_ENV)));
  after(() => s.stop());

  test('GET /api/auth/session: ไม่ล็อกอิน → member null (200) / ล็อกอิน → อีเมล + no-store', async () => {
    const anon = await browser(s).get('/api/auth/session');
    assert.equal(anon.status, 200);
    assert.deepEqual(anon.body, { member: null });
    const a = await member(s);
    const me = await a.get('/api/auth/session');
    assert.deepEqual(me.body, { member: { email: a.email } });
    assert.equal(me.headers.get('cache-control'), 'no-store');
  });

  test('เจ้าของออเดอร์เปิดหน้าออเดอร์ได้ด้วย session (ไม่มี token) / คนอื่นและ guest ไม่ได้', async () => {
    const a = await member(s);
    const o = (await a.post('/api/orders', mlOrder())).body;
    const mine = await a.get(`/api/orders/${o.id}`);
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.body.id, o.id);
    assert.ok(mine.body.qr, 'ยังรอจ่าย ต้องมี QR');
    assert.ok(!('token' in mine.body) && !('userId' in mine.body));
    assert.equal(mine.headers.get('cache-control'), 'no-store');

    const other = await member(s);
    assert.equal((await other.get(`/api/orders/${o.id}`)).status, 404);
    assert.equal((await browser(s).get(`/api/orders/${o.id}`)).status, 404);
    // token ผิด + session เจ้าของ → ยังไม่ได้ (token ที่ส่งมาต้องถูก)
    assert.equal((await a.get(`/api/orders/${o.id}?t=wrong`)).status, 404);
    // ออเดอร์ guest เปิดด้วย session ใครก็ไม่ได้
    const g = (await browser(s).post('/api/orders', mlOrder())).body;
    assert.equal((await a.get(`/api/orders/${g.id}`)).status, 404);
    assert.equal((await a.get(`/api/orders/${g.id}?t=${g.token}`)).status, 200);
  });

  test('SSE ของเจ้าของออเดอร์ใช้ session ได้ / คนอื่น 404', async () => {
    const a = await member(s);
    const o = (await a.post('/api/orders', mlOrder())).body;
    const ctrl = new AbortController();
    const res = await fetch(`${s.base}/api/orders/${o.id}/events`, {
      headers: { cookie: `koinz_sid=${a.jar.koinz_sid}` }, signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    let text = '';
    while (!/event: status/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"status":"pending_payment"/);
    ctrl.abort();
    const other = await member(s);
    const r = await fetch(`${s.base}/api/orders/${o.id}/events`, { headers: { cookie: `koinz_sid=${other.jar.koinz_sid}` } });
    assert.equal(r.status, 404);
    await r.text();
  });

  test('แจ้งโอนด้วย session: ต้องมาจากหน้าเว็บร้าน (Origin) / แบบ token ใช้ได้เหมือนเดิม', async () => {
    const a = await member(s);
    const o = (await a.post('/api/orders', mlOrder())).body;
    const sid = `koinz_sid=${a.jar.koinz_sid}`;
    const cross = await fetch(`${s.base}/api/orders/${o.id}/notify`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sid, origin: 'https://evil.example' }, body: '{}',
    });
    assert.equal(cross.status, 403);
    const noOrigin = await fetch(`${s.base}/api/orders/${o.id}/notify`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: '{}',
    });
    assert.equal(noOrigin.status, 403);
    const ok = await a.post(`/api/orders/${o.id}/notify`, { t: null });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await a.get(`/api/orders/${o.id}`)).body.status, 'paid_pending_review');

    // guest แจ้งโอนด้วย token โดยไม่มี Origin ได้เหมือนเดิม
    const g = (await s.req('POST', '/api/orders', mlOrder())).body;
    assert.equal((await s.req('POST', `/api/orders/${g.id}/notify`, { t: g.token })).status, 200);
  });

  test('POST /api/auth/reset/verify (token อยู่ใน body ไม่อยู่ใน URL): ใช้ได้ → อีเมล / ผิด → 404', async () => {
    const a = await member(s);
    const n = resetTokens(s).length;
    await browser(s).post('/api/auth/forgot', { email: a.email });
    const token = await nextResetToken(s, n);
    const ok = await browser(s).post('/api/auth/reset/verify', { token });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { valid: true, email: a.email });
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    for (const bad of ['x'.repeat(43), '', 123, null]) {
      const r = await browser(s).post('/api/auth/reset/verify', { token: bad });
      assert.equal(r.status, 404);
      assert.equal(r.body.valid, false);
    }
    // ตรวจแล้วลิงก์ยังใช้ตั้งรหัสได้ (ตรวจไม่ใช่การใช้ลิงก์)
    assert.equal((await browser(s).post('/api/auth/reset', { token, password: 'brand-new-secret-41' })).status, 200);
    assert.equal((await browser(s).post('/api/auth/reset/verify', { token })).status, 404);
  });

  test('GET /api/password-policy → นโยบายเดียวกับเซิร์ฟเวอร์ + รายการรหัสยอดนิยม (cache ได้)', async () => {
    const r = await s.req('GET', '/api/password-policy');
    assert.equal(r.status, 200);
    assert.equal(r.body.minLength, password.MIN_LENGTH);
    assert.equal(r.body.maxLength, password.MAX_LENGTH);
    assert.equal(r.body.common.length, password.commonList.size);
    assert.ok(r.body.common.includes('password1234') || r.body.common.includes('password'));
    assert.match(r.headers.get('cache-control'), /max-age=86400/);
  });

  test('หน้าสมาชิกทุกหน้าเปิดได้และโหลดสคริปต์จากไฟล์ (ไม่ใช้ inline script)', async () => {
    for (const page of ['login', 'signup', 'forgot', 'reset', 'account']) {
      const r = await s.req('GET', `/${page}.html`);
      assert.equal(r.status, 200, page);
      assert.match(r.text, /<html lang="th">/);
      assert.match(r.text, new RegExp(`data-page="${page}"`));
      assert.ok(!/<script>/.test(r.text), `${page}.html มี inline script`);
      assert.match(r.text, /js\/common\.js/);
    }
  });
});

describe('Auth Phase 3 — ?next= กัน open redirect (safeNext ใน common.js)', () => {
  const vm = require('node:vm');
  const ctx = vm.createContext({
    window: {}, URL, URLSearchParams, console,
    location: { origin: 'https://shop.example', href: 'https://shop.example/login.html', pathname: '/login.html', search: '' },
    fetch: () => Promise.reject(new Error('offline')),
    localStorage: { getItem: () => null, setItem() {} },
    document: { querySelectorAll: () => [], querySelector: () => null },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'common.js'), 'utf8'), ctx);
  const safeNext = (v) => vm.runInContext(`safeNext(${JSON.stringify(v)})`, ctx);

  test('path ภายในเว็บ → ใช้ได้', () => {
    assert.equal(safeNext('/'), '/');
    assert.equal(safeNext('/?game=mobile-legends'), '/?game=mobile-legends');
    assert.equal(safeNext('/order.html?id=K1&t=abc#x'), '/order.html?id=K1&t=abc#x');
    assert.equal(safeNext('/account.html'), '/account.html');
  });

  test('URL เว็บอื่น / // / \\ / javascript: / ตัวควบคุม → ค่าว่าง (หน้าเว็บไปหน้าบัญชีแทน)', () => {
    for (const bad of [
      'https://evil.example', 'http://evil.example/account.html', '//evil.example', '///evil.example',
      '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)', 'account.html', '/\tevil', '/\n/evil.example',
      ' /account.html', '', null, undefined,
    ]) {
      assert.equal(safeNext(bad), '', `ต้องไม่ยอม: ${JSON.stringify(bad)}`);
    }
  });
});
