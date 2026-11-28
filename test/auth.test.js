// เทสระบบสมาชิก (AUTH_SPEC.md) — รันได้ทั้งไฟล์ JSON และ PostgreSQL เหมือน api.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ROOT, BASE_ENV, PG_ADMIN_URL, createTestDatabase, startServer } = require('./helpers');
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

