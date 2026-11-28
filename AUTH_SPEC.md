# งาน: ระบบสมาชิก (เข้าสู่ระบบ / สมัครสมาชิก) + ตรวจความปลอดภัย + ทดสอบใน branch แยก

> คำสั่งงานสำหรับ Claude Code — เปิดในโฟลเดอร์ `D:\koinz` แล้วพิมพ์:
> `อ่าน AUTH_SPEC.md แล้วทำตามทีละ Phase เริ่มจาก Phase 0 รัน acceptance check ทุกข้อ และหยุดรอผมหลังจบแต่ละ Phase`
>
> ดีไซน์: https://claude.ai/artifact/RTNnuM7nQQGNFjjWmFVtRi — แถว "Koinz · สมาชิก"
> (สมาชิก · เข้าสู่ระบบ / สมัครสมาชิก / ลืมรหัสผ่าน / ตั้งรหัสผ่านใหม่ / บัญชีของฉัน)

## หลักการ

- **สมาชิกไม่บังคับ** — สั่งซื้อแบบไม่สมัคร (guest) ต้องใช้ได้เหมือนเดิมทุกอย่าง
- สมาชิกได้: ประวัติออเดอร์จากทุกเครื่อง, UID ที่บันทึกไว้ทุกเกม, ดึงออเดอร์ที่เคยสั่งจากเครื่องนี้เข้าบัญชี
- วิธีเข้าสู่ระบบรอบนี้: **อีเมล + รหัสผ่าน** (ปุ่ม LINE ในดีไซน์ = เฟสถัดไป ตอนนี้ซ่อนไว้ด้วย flag `LINE_LOGIN_ENABLED`)
- **ระบบแอดมินแยกจากสมาชิกเด็ดขาด** — session สมาชิกห้ามเข้า `/api/admin/*` ได้
- **ไม่ติดตั้งแพ็กเกจเพิ่ม** ถ้าไม่จำเป็น ใช้ `node:crypto` (scrypt, randomBytes, timingSafeEqual) — ถ้าจำเป็นจริงให้ถามก่อน
- ทำงานใน **branch แยก** และ deploy ขึ้น **Railway staging** ก่อน ห้าม merge เข้า `main` จนกว่าผมสั่ง

---

## Phase 0 — Branch และสภาพแวดล้อมทดสอบ

1. ในเครื่อง:
   ```
   git stash            # ถ้ามีไฟล์ค้าง (เช่น docs/railway.env.example) — ห้าม commit ไฟล์ที่มีรหัสผ่าน
   git switch main && git pull
   git switch -c feature/member-auth
   git push -u origin feature/member-auth
   ```
2. เพิ่ม `.claude/` ลง `.gitignore` (ถ้ายังไม่มี)
3. เขียนคู่มือ `docs/staging.md` ให้ผมทำใน Railway (ผมกดเอง):
   - Project → Environments → **New Environment** ชื่อ `staging` (แบบว่าง ไม่ copy ข้อมูล production)
   - ใน staging: เพิ่ม PostgreSQL ใหม่ชื่อ `Postgres`, เพิ่ม service จาก GitHub repo เดิม แล้วตั้ง **Settings → Source → Branch = `feature/member-auth`**
   - Variables ของ staging: ชุดเดียวกับ `docs/railway.env.example` แต่ใช้ `ADMIN_PASSWORD` คนละตัวกับ production, `PROMPTPAY_ID` ใช้ของจริงได้ (ห้ามโอนจริงตอนทดสอบ), `MAIL_PROVIDER=log`, `MAIL_LOG_LINKS=1`, `SHOP_NAME=Koinz (ทดสอบ)`
   - Generate Domain → ได้ URL staging แยกจากของจริง
   - เตือนว่า staging กินเครดิต Railway เพิ่ม — ทดสอบเสร็จให้ Remove deployment ได้
4. หน้าเว็บ staging ต้องมีแถบบนสุดสีเหลืองอ่อน "เว็บทดสอบ — ห้ามโอนเงินจริง" เมื่อ `SITE_BANNER` ถูกตั้งค่า (ตั้งใน staging เท่านั้น)

✅ Acceptance Phase 0
- [ ] `git branch --show-current` = `feature/member-auth` และ push ขึ้น GitHub แล้ว
- [ ] `npm test` บน branch ใหม่ผ่านเหมือน main
- [ ] มี `docs/staging.md` ที่ทำตามได้ทีละขั้น

---

## Phase 1 — ฐานข้อมูลและแกนความปลอดภัย

### 1.1 Migration `db/migrations/002_members.sql` (และรองรับใน `src/repo/json.js` ด้วย เพื่อให้เทสเดิมรันได้)
```sql
users            (id UUID PK, email TEXT UNIQUE NOT NULL  -- เก็บแบบ trim + lowercase
                  , password_hash TEXT NOT NULL, terms_version TEXT NOT NULL, terms_accepted_at TIMESTAMPTZ NOT NULL
                  , marketing_opt_in BOOLEAN NOT NULL DEFAULT false
                  , failed_logins INT NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ
                  , created_at, updated_at, deleted_at TIMESTAMPTZ)
sessions         (id TEXT PK -- sha256(token) แบบ hex ห้ามเก็บ token ดิบ
                  , user_id UUID FK ON DELETE CASCADE, created_at, last_seen_at, expires_at
                  , user_agent TEXT, ip_hash TEXT)
password_resets  (token_hash TEXT PK, user_id UUID FK, created_at, expires_at, used_at)
saved_players    (user_id UUID FK, game_slug TEXT, inputs JSONB, label TEXT, updated_at, PRIMARY KEY (user_id, game_slug))
ALTER TABLE orders ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE SET NULL;  + index
```

### 1.2 รหัสผ่าน (`src/auth/password.js`)
- `crypto.scrypt` ค่า N=2^15, r=8, p=1, keylen=64, salt 16 bytes, `maxmem` พอ — เก็บรูปแบบ `scrypt$N$r$p$saltB64$hashB64`
- เทียบด้วย `timingSafeEqual` และถ้าพารามิเตอร์เปลี่ยนในอนาคต ให้ hash ใหม่ตอนล็อกอินสำเร็จ
- normalize ด้วย `NFKC` ก่อน hash
- นโยบาย: ยาว **10–128** ตัว, ไม่อยู่ใน `data/common-passwords.txt` (ใส่รายการรหัสยอดนิยมอย่างน้อย 1,000 คำ ตรวจแบบไม่สนตัวพิมพ์), ไม่มีส่วนหน้า @ ของอีเมล (ถ้ายาว ≥3 ตัว) อยู่ในรหัส — **ไม่บังคับ** ต้องมีตัวใหญ่/สัญลักษณ์ (ตามแนว NIST 800-63B)
- ตรวจกฎเดียวกันทั้ง frontend (แสดงแถบความปลอดภัยตามดีไซน์) และ backend (ตัดสินจริง)

### 1.3 Session (`src/auth/session.js`)
- token = `randomBytes(32)` base64url → cookie `koinz_sid`; DB เก็บ `sha256(token)` เท่านั้น
- Cookie: `HttpOnly; SameSite=Lax; Path=/; Max-Age=30 วัน` และ `Secure` เมื่อ production — **ห้ามเก็บ session ใน localStorage**
- หมดอายุ: 30 วันนับจากล็อกอิน หรือไม่ได้ใช้ 14 วัน (อัปเดต `last_seen_at` ไม่เกินนาทีละครั้ง)
- ล็อกอินสำเร็จ = สร้าง session ใหม่เสมอ (กัน session fixation), ออกจากระบบ = ลบแถว + ล้าง cookie
- `ip_hash` = HMAC-SHA256(ip, `SESSION_SECRET`) — ห้ามเก็บ IP ดิบ; เพิ่ม `SESSION_SECRET` ใน env (≥32 ตัว, production ไม่มี = ไม่ยอม start)

### 1.4 กัน CSRF และคำขอข้ามเว็บ
- ทุก route ที่เปลี่ยนข้อมูลใต้ `/api/auth/*` และ `/api/me/*`: ต้องเป็น `Content-Type: application/json` และ `Origin` ต้องตรงกับโดเมนตัวเองหรืออยู่ใน `FRONTEND_ORIGIN` (ถ้ามี `Sec-Fetch-Site` ต้องเป็น `same-origin`/`same-site`) ไม่ผ่าน → 403
- ถ้าใช้ frontend บน GitHub Pages คนละโดเมน: cookie ต้องเป็น `SameSite=None; Secure` และ CORS `credentials` — **ให้ปิดระบบสมาชิกบน Pages ไปก่อน** (แสดงลิงก์ไปเว็บหลักแทน) เพื่อไม่ต้องลด SameSite

### 1.5 กันเดาบัญชีและเดารหัส
- ล็อกอินผิด → ข้อความเดียวเสมอ "อีเมลหรือรหัสผ่านไม่ถูกต้อง ตรวจแล้วลองใหม่อีกครั้ง" (ไม่บอกว่าไม่มีอีเมลนี้)
- ถ้าไม่พบอีเมล ให้ verify กับ hash หลอกด้วย เพื่อให้เวลาตอบใกล้กัน
- บัญชีผิด 5 ครั้งใน 15 นาที → `locked_until` = +15 นาที (แสดงข้อความล็อกตามดีไซน์ และนับถอยหลัง) สำเร็จแล้วรีเซ็ตตัวนับ
- Rate limit ต่อ IP: login 10/นาที, signup 5/ชั่วโมง, forgot 10/ชั่วโมง; ต่ออีเมล: forgot 3/ชั่วโมง + เว้น 60 วินาทีระหว่างส่ง
- สมัครด้วยอีเมลที่มีแล้ว → "สมัครไม่สำเร็จ ถ้าเคยสมัครด้วยอีเมลนี้แล้ว ลองเข้าสู่ระบบหรือกดลืมรหัสผ่าน" (ไม่ยืนยันตรง ๆ ว่ามี)

✅ Acceptance Phase 1 (เขียนเป็นเทสใน `test/auth.test.js`)
- [ ] hash รหัสเดียวกัน 2 ครั้งได้ค่าต่างกัน และ verify ผ่านทั้งคู่
- [ ] ใน DB/ไฟล์ไม่มี token session หรือ token reset แบบดิบ
- [ ] รหัส 9 ตัว / `password1234` / รหัสที่มีชื่ออีเมล → ถูกปฏิเสธพร้อมข้อความไทย
- [ ] ผิด 5 ครั้ง → ครั้งที่ 6 ได้ข้อความล็อก แม้รหัสถูก
- [ ] POST ที่ `Origin` เป็นเว็บอื่น → 403

---

## Phase 2 — API สมาชิก

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | `/api/auth/signup` | `{email, password, acceptTerms: true, marketing}` → สร้าง user + ล็อกอินเลย (ตั้ง cookie) |
| POST | `/api/auth/login` | `{email, password}` |
| POST | `/api/auth/logout` | ลบ session ปัจจุบัน |
| POST | `/api/auth/logout-all` | ลบทุก session ของ user |
| POST | `/api/auth/forgot` | `{email}` → ตอบ 200 ข้อความเดียวกันเสมอ ไม่ว่ามีบัญชีหรือไม่ |
| GET | `/api/auth/reset/:token` | ตรวจว่าลิงก์ยังใช้ได้ไหม (ไม่บอกอีเมลถ้าใช้ไม่ได้) |
| POST | `/api/auth/reset` | `{token, password, logoutOthers}` → ใช้ครั้งเดียว ลบ token อื่นของ user, ล็อกอินให้ |
| POST | `/api/me/password` | `{currentPassword, newPassword}` → ลบ session อื่นทั้งหมด |
| GET | `/api/me` | `{email, createdAt}` หรือ 401 |
| GET | `/api/me/orders` | ออเดอร์ของ user ล่าสุด 50 รายการ (ไม่มี token, contact ของคนอื่น) |
| POST | `/api/me/orders/claim` | `[{id, token}]` จาก localStorage → ผูกเฉพาะออเดอร์ที่ token ถูกและ `user_id` ยังว่าง |
| GET/DELETE | `/api/me/players` `/api/me/players/:gameSlug` | UID ที่บันทึกไว้ |
| POST | `/api/me/delete` | `{password}` → ลบบัญชี (PDPA): ลบ sessions/players/resets, ลบข้อมูลใน users เหลือแถวไว้แบบ anonymize, ออเดอร์เก่าเก็บไว้แต่ `user_id = NULL` |

- `POST /api/orders` เมื่อมี session: ใส่ `user_id` และ upsert `saved_players` ของเกมนั้น
- Reset token: `randomBytes(32)`, เก็บ `sha256`, อายุ 30 นาที, ใช้ครั้งเดียว
- ส่งอีเมลผ่าน `src/adapters.js → sendMail({to, subject, text})`:
  - `MAIL_PROVIDER=resend` + `RESEND_API_KEY` + `MAIL_FROM` → ส่งจริงด้วย `fetch` (ไม่ต้องลงแพ็กเกจ)
  - `MAIL_PROVIDER=log` → เขียนลง log เฉพาะเมื่อ `MAIL_LOG_LINKS=1` (ใช้ใน staging) และ**ห้ามเปิดใน production**
  - production ที่ยังไม่ตั้งอีเมล → `/api/config` ส่ง `passwordResetEnabled: false` แล้วหน้าเว็บซ่อน "ลืมรหัสผ่าน?" แสดง "ติดต่อร้านทาง LINE" แทน
- ส่งอีเมลแจ้งเตือนเมื่อ: เปลี่ยนรหัสผ่านสำเร็จ, รีเซ็ตรหัสสำเร็จ
- เขียน audit (ไม่มีรหัสผ่าน/token/อีเมลเต็ม): signup, login สำเร็จ/ล้มเหลว, ล็อกบัญชี, reset, logout-all, ลบบัญชี

✅ Acceptance Phase 2
- [ ] forgot ด้วยอีเมลที่มีและไม่มี → response เหมือนกันทุก byte
- [ ] ใช้ลิงก์ reset ซ้ำครั้งที่ 2 → ใช้ไม่ได้ / เลย 30 นาที → ใช้ไม่ได้
- [ ] reset สำเร็จพร้อม `logoutOthers` → session อื่นใช้ไม่ได้ทันที
- [ ] claim ออเดอร์ด้วย token ผิด หรือออเดอร์ที่ถูกผูกกับคนอื่นแล้ว → ไม่ถูกผูก
- [ ] session สมาชิกเรียก `/api/admin/orders` → 401
- [ ] guest checkout ทุกเทสเดิมยังผ่าน

---

## Phase 3 — หน้าเว็บ (ตาม artboard ทุกจอ)

- ไฟล์ใหม่: `public/login.html`, `signup.html`, `forgot.html`, `reset.html`, `account.html` + `public/js/auth.js`
- ดีไซน์ตาม canvas: ช่องกรอกแคปซูลสูง 56px มีป้ายเล็ก, ปุ่มแดงแคปซูล 54px, ปุ่มแสดง/ซ่อนรหัส (44px, `aria-label` เปลี่ยนตามสถานะ), กล่อง error ชมพู `#F8E3E6/#A3202F` ใช้ `role="alert"`
- `autocomplete`: `email`, `current-password` (login), `new-password` (signup/reset)
- หน้าสมัคร: แถบความปลอดภัย 4 ช่อง + รายการกฎ 3 ข้อ อัปเดตตอนพิมพ์, ช่องยอมรับเงื่อนไข (บังคับ), ช่องรับโปรโมชัน (ไม่ติ๊กไว้ก่อน), ปุ่มสมัครกดได้เมื่อครบ
- หน้าลืมรหัส: หลังส่งแสดงจอ "ตรวจอีเมลของคุณ" ข้อความกลาง ๆ + ปุ่มส่งอีกครั้งนับถอยหลัง 60 วิ
- หน้าตั้งรหัสใหม่: 2 สถานะ (ใช้ได้ / ลิงก์หมดอายุ) + ช่อง "ออกจากระบบในอุปกรณ์อื่นทั้งหมด" ติ๊กไว้ก่อน
- หน้าบัญชี: แบนเนอร์ฟ้า "พบ N ออเดอร์ที่สั่งจากเครื่องนี้" (เมื่อ localStorage มีออเดอร์ที่ยังไม่ผูก), ผู้เล่นที่บันทึกไว้ + ปุ่ม "เติม" (พาไปหน้าเกมพร้อมกรอก UID ให้), ออเดอร์ล่าสุด, เมนูเปลี่ยนรหัส / ออกจากระบบทุกอุปกรณ์ / ออกจากระบบ (สีแดง) + ลิงก์เล็ก "ลบบัญชี" ล่างสุด (ยืนยันด้วยรหัสผ่านในหน้าต่าง)
- Header หน้าร้าน: ลิงก์ "เข้าสู่ระบบ" หรือ "บัญชีของฉัน" ตามสถานะ; ตอนล็อกอินแล้วหน้าเกมใช้ UID จาก `saved_players` ก่อน localStorage
- หลังล็อกอิน/สมัคร redirect ไปหน้าที่มาจาก (`?next=`) — อนุญาตเฉพาะ path ภายในที่ขึ้นต้นด้วย `/` และไม่ใช่ `//` (กัน open redirect)
- **บนคอม (≥900px)** — ดู artboard "สมาชิกบนคอม · …" 2 จอ:
  - **เข้าสู่ระบบ / สมัคร / ลืมรหัส / ตั้งรหัสใหม่** (`login.html`, `signup.html`, `forgot.html`, `reset.html` ใช้เลย์เอาต์เดียวกัน): 2 คอลัมน์ `flex-wrap` — ซ้าย `flex: 1 1 420px` กองเหรียญ 300px + หัวข้อ 34px "เติมครั้งต่อไป ไม่ต้องกรอกอะไรใหม่" + รายการสิทธิ์ 3 ข้อ (ติ๊กเขียว) / ขวา การ์ดขาว `flex: 0 1 440px` radius 32 padding 32
  - หน้า login/signup มีแท็บแคปซูลด้านบนการ์ด (พื้น `--paper`, แท็บที่เลือก = พื้น `--ink` ตัวขาว) สลับไปอีกหน้าโดยไม่โหลดใหม่ได้ (ใช้ `history.replaceState` เปลี่ยน URL ให้ตรง) และลิงก์ "สั่งซื้อโดยไม่ต้องสมัครก็ได้" ใต้การ์ด
  - หน้าลืมรหัส / ตรวจอีเมล / ตั้งรหัสใหม่ อยู่ในการ์ดเดียวกัน ไม่มีแท็บ
  - **บัญชีของฉัน** (`account.html`): ซ้าย `flex: 999 1 560px` = แบนเนอร์ claim, ผู้เล่นที่บันทึกไว้เป็น grid 2 คอลัมน์ (ปุ่ม "เติม" + ปุ่ม × ลบ มี `aria-label`), ตารางออเดอร์ (รายการ/ผู้เล่น/ยอด/สถานะ) ในกล่อง `overflow-x: auto` / ขวา `flex: 1 1 300px; max-width: 360px` การ์ด "ความปลอดภัย" (สมาชิกตั้งแต่ · จำนวนอุปกรณ์ที่ใช้งาน, เปลี่ยนรหัสผ่าน, ออกจากระบบทุกอุปกรณ์, ออกจากระบบสีแดง, ลิงก์เล็ก "ลบบัญชี")
- **หน้าต่างยืนยันลบบัญชี** (คอม = dialog กลางจอบนฉากมืด 45%, มือถือ = แผ่นเลื่อนขึ้นจากล่าง เนื้อหาเดียวกัน): หัวข้อ "ลบบัญชี Koinz?", "ลบแล้วกู้คืนไม่ได้", รายการผลกระทบ 3 ข้อ (ลบอีเมล/รหัส/UID ที่บันทึก · ออกจากระบบทุกอุปกรณ์ · ออเดอร์เก่ายังเก็บตามกฎหมายบัญชีแต่ไม่ผูกกับคุณ), ช่อง "ยืนยันด้วยรหัสผ่าน", ปุ่ม "ยกเลิก" (ขาว) + "ลบบัญชีถาวร" (แดงเข้ม `#A3202F`) — ใช้ `<dialog>` หรือ `role="dialog" aria-modal="true"`, โฟกัสอยู่ในหน้าต่าง, กด Esc ปิดได้, ปิดแล้วโฟกัสกลับไปที่ลิงก์ "ลบบัญชี"
- จำนวน "ใช้งานอยู่ N อุปกรณ์" มาจากจำนวน session ที่ยังไม่หมดอายุ → เพิ่ม `sessionCount` ใน `GET /api/me`

✅ Acceptance Phase 3
- [ ] ทำครบ flow ด้วยคีย์บอร์ดอย่างเดียว และ screen reader อ่าน error ได้
- [ ] ที่ 390px ไม่มีอะไรล้นจอ
- [ ] `?next=https://evil.example` → ไปหน้าบัญชีแทน

---

## Phase 4 — ตรวจความปลอดภัย (ทำก่อนขอ merge)

1. **Content-Security-Policy** — ย้าย `<script>` แบบ inline ทุกหน้าไปเป็นไฟล์ แล้วตั้ง:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
   และ `Strict-Transport-Security: max-age=15552000` เมื่อ production
2. `Cache-Control: no-store` ทุก response ของ `/api/auth/*` และ `/api/me/*`
3. ตรวจว่า log ไม่มีรหัสผ่าน, token, cookie, `DATABASE_URL`, อีเมลเต็ม (mask เป็น `n***@example.com`)
4. `npm audit --omit=dev` — ต้องไม่มี high/critical
5. ค้นหาความลับที่หลุดใน repo: `git log -p | grep -iE "password=|api_key=|secret="` ต้องไม่เจอค่าจริง (ค่าตัวอย่างเช่น `<...>` ได้)
6. ทุก SQL ใช้ parameter (`$1`) ห้ามต่อ string
7. เขียนรายงาน `docs/security-review.md`: ตาราง "ข้อ / วิธีทดสอบ / ผล / หลักฐาน (ชื่อเทส)" ครอบคลุม — hashing, session, CSRF, enumeration, brute force, reset token, open redirect, XSS (input ใน UID/อีเมลแสดงผลผ่าน `esc()`), CSP, IDOR (`/api/me/*` เห็นเฉพาะของตัวเอง), admin แยกจากสมาชิก, PDPA (consent, ลบบัญชี), ความลับใน log/repo — และรายการ**ความเสี่ยงที่เหลือ**ที่ยังไม่ได้แก้

✅ Acceptance Phase 4
- [ ] `npm test` ผ่านทั้งหมด (เทสเดิม + `auth.test.js`)
- [ ] เปิดทุกหน้าใน staging แล้ว console ไม่มี CSP error
- [ ] `docs/security-review.md` ไม่มีข้อที่ผลเป็น "ไม่ผ่าน"

## Phase 5 — ทดสอบบน staging แล้วรอผมอนุมัติ

1. push `feature/member-auth` → Railway staging deploy เอง → ตรวจ Deploy Logs มี `migrate: 002_members.sql ✓`
2. ทำ checklist บน URL staging แล้วจดผลลง `docs/staging-test.md`: สมัคร → ออกจากระบบ → เข้าใหม่ → ลืมรหัส (เอาลิงก์จาก log) → ตั้งใหม่ → สั่งออเดอร์แบบสมาชิก (ไม่โอนเงิน) → UID ถูกบันทึก → สั่งแบบ guest ในอีกเบราว์เซอร์แล้ว claim → ลบบัญชี
3. เปิด **Pull Request** `feature/member-auth → main` บน GitHub พร้อมสรุปและลิงก์รายงาน — **ห้าม merge เอง** รอผมอนุมัติ
4. ก่อน merge: ตั้ง `SESSION_SECRET` (และ mail ถ้าพร้อม) ใน Railway **production** ก่อน ไม่งั้นเว็บจริงจะไม่ยอม start

## ตัวแปรใหม่ (เพิ่มใน `.env.example` และ `docs/railway.env.example` พร้อมคำอธิบายไทย)
```
SESSION_SECRET=          # สุ่มยาว ≥32 ตัว (production บังคับ)
MAIL_PROVIDER=           # resend | log | (ว่าง = ปิดลืมรหัสผ่าน)
RESEND_API_KEY=
MAIL_FROM=               # เช่น Koinz <no-reply@โดเมนร้าน>
MAIL_LOG_LINKS=0         # 1 = เขียนลิงก์รีเซ็ตลง log (staging เท่านั้น)
TERMS_VERSION=2026-11    # เปลี่ยนเมื่อแก้เงื่อนไข
LINE_LOGIN_ENABLED=0     # เฟสถัดไป
SITE_BANNER=             # ข้อความแถบบนสุด (ใช้ใน staging)
```
