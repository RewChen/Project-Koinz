# Koinz — เว็บเติมเกม

เว็บเติมเกมแบบครบวงจร: ลูกค้าเลือกเกม → กรอกข้อมูลผู้เล่น (ช่องตามแต่ละเกม) → เลือกแพ็กเกจ → สแกนจ่าย QR PromptPay → ระบบยืนยันยอด (webhook หรือแอดมิน) → เติมเข้าเกม (อัตโนมัติผ่าน supplier หรือแอดมินเติมเอง)

- เบา: Express + HTML/JS ล้วน + ไฟล์ JSON ไม่ต้องมี Redis/ฐานข้อมูล
- ออเดอร์หมดอายุเอง, กันสั่งซ้ำ (idempotency), สถานะ real-time ผ่าน SSE
- Webhook ยืนยันการชำระเงินแบบ HMAC (รับยอดที่โอนมาหลังหมดเวลาด้วย)
- คิวเติมเกมอัตโนมัติพร้อม retry ทำต่อได้หลังรีสตาร์ท
- หลังบ้าน: สรุปยอด ค้นหา ปุ่มลัด และ audit log ทุกการเปลี่ยนสถานะ
- Rate limit, security headers, ลิงก์ออเดอร์ต้องมี token

## เริ่มใช้งาน (Windows)

1. ติดตั้ง [Node.js](https://nodejs.org) เวอร์ชัน 18 ขึ้นไป (แนะนำ 22)
2. เปิด PowerShell แล้วรัน
   ```
   cd D:\koinz
   npm install
   copy .env.example .env
   ```
3. แก้ไฟล์ `.env` : ใส่เบอร์ PromptPay ของร้าน และ **เปลี่ยน ADMIN_PASSWORD**
4. รันเว็บ
   ```
   npm start
   ```
5. เปิด http://localhost:3000 (หน้าร้าน) และ http://localhost:3000/admin.html (หลังบ้าน)

| คำสั่ง | ใช้ทำอะไร |
|---|---|
| `npm start` | รันเซิร์ฟเวอร์ (เก็บข้อมูลเป็นไฟล์ JSON ใน `data/`) |
| `npm run dev` | รันแบบรีสตาร์ทเองเมื่อแก้โค้ด |
| `npm test` | รันเทส API ทั้งหมดกับไฟล์ JSON (`node:test` ไม่ต้องติดตั้งเพิ่ม) |
| `npm run test:pg` | รันเทสชุดเดียวกันกับ PostgreSQL ใน Docker |
| `npm run db:migrate` / `npm run db:import` | migrate ฐานข้อมูล / ย้ายข้อมูลจาก `data/*.json` เข้า PostgreSQL |

## รันด้วย Docker (แนะนำสำหรับใช้งานจริง)

ทุกอย่างอยู่ใน container — เครื่องมีแค่ [Docker Desktop](https://www.docker.com/products/docker-desktop/) ก็พอ ไม่ต้องลง Node หรือ PostgreSQL

```
copy .env.example .env      # แล้วตั้ง ADMIN_PASSWORD และ POSTGRES_PASSWORD (A-Z a-z 0-9 - _ เท่านั้น)
```

| โหมด | คำสั่ง | เปิดที่ |
|---|---|---|
| dev (แก้โค้ดแล้วเห็นผลทันที) | `docker compose up --build` | เว็บ http://localhost:3000 · Adminer http://localhost:8080 · PostgreSQL `localhost:5432` |
| prod (nginx + image เล็ก ไม่ใช่ root) | `docker compose -f compose.yaml -f compose.prod.yaml up -d --build` | http://localhost (เปิดออกนอกแค่ port 80) |

```
┌─ prod ────────────────────────────────────────────────────────────┐
│ browser ─80─▶ nginx (gzip, cache css/js, SSE) ─▶ app:3000 ─▶ db:5432 │
└───────────────────────────────────────────────────────────────────┘
```

- เริ่มครั้งแรก แอปจะ migrate ฐานข้อมูลและใส่เกมตั้งต้น 6 เกมให้เอง ข้อมูลอยู่ใน volume `koinz-pg` (ลบ container แล้วข้อมูลยังอยู่)
- prod บังคับ `NODE_ENV=production` (รหัสผ่านแอดมินอ่อน → ไม่ยอมเริ่ม) และ `TRUST_PROXY=1` (rate limit เห็น IP จริงหลัง nginx)
- มีข้อมูลเก่าเป็นไฟล์ JSON? วางไว้ใน `data/` แล้วรัน `docker compose run --rm app node db/import-json.js` (รันซ้ำได้ ไม่ซ้ำ)

| คำสั่งที่ใช้บ่อย | |
|---|---|
| `docker compose logs -f app` | ดู log |
| `docker compose exec db psql -U koinz` | เข้า PostgreSQL |
| `sh docker/backup.sh` | สำรองฐานข้อมูล → `backups/koinz-วันที่.sql` |
| `sh docker/restore.sh backups/ไฟล์.sql` | กู้ฐานข้อมูล (เขียนทับทั้งหมด หยุดแอปชั่วคราวให้เอง) |
| `docker compose down` | หยุด (ข้อมูลยังอยู่) |
| `docker compose down -v` | หยุด + **ลบข้อมูลทั้งหมด** ⚠️ |

> ใช้ Git Bash บน Windows: ถ้าคำสั่งมี path ใน container (เช่น `/app/data`) ให้ตั้ง `MSYS_NO_PATHCONV=1` ก่อน ไม่งั้น Git Bash จะแปลง path เป็นแบบ Windows

## โครงสร้างโปรเจกต์

```
koinz/
├── server.js              # เช็คค่าตั้งค่า → listen → เริ่มงานเบื้องหลัง
├── src/
│   ├── env.js             # โหลด .env
│   ├── config.js          # อ่านตัวแปร env ทั้งหมดที่เดียว
│   ├── repo/              # ที่เก็บข้อมูล: index.js เลือก pg.js (มี DATABASE_URL) หรือ json.js
│   ├── store.js           # อ่าน/เขียนไฟล์ JSON (cache + เช็ค mtime, เขียนแบบ atomic) ให้ repo/json.js
│   ├── catalog.js         # เกม/แพ็กเกจ, ตรวจข้อมูลผู้เล่นตาม fields, ตรวจแคตตาล็อกก่อนบันทึก
│   ├── orders.js          # สถานะออเดอร์, transition(), audit log, event bus
│   ├── jobs.js            # คิวเติมเกม + retry, กวาดออเดอร์หมดอายุ
│   ├── adapters.js        # ตรวจชื่อในเกม, supplier, แจ้งเตือนแอดมิน
│   ├── security.js        # rate limit, security headers, CORS, กัน CSRF (sameOriginOnly)
│   ├── auth/              # ระบบสมาชิก: password.js (scrypt + นโยบาย), session.js (cookie koinz_sid), members.js, routes.js
│   ├── app.js             # createApp(): ทุก route
│   └── promptpay.js       # สร้าง payload QR PromptPay (ห้ามแก้)
├── data/                  # (หรือโฟลเดอร์ใน KOINZ_DATA_DIR)
│   ├── games.json         # เกม ช่องข้อมูลผู้เล่น แพ็กเกจ ราคา
│   ├── orders.json        # ออเดอร์ (สร้างอัตโนมัติ)
│   ├── jobs.json          # คิวเติมเกม (สร้างอัตโนมัติ)
│   ├── audit.json         # ประวัติการเปลี่ยนแปลง 5,000 รายการล่าสุด (สร้างอัตโนมัติ)
│   ├── users.json / sessions.json / password_resets.json / saved_players.json   # สมาชิก (สร้างอัตโนมัติ)
│   └── common-passwords.txt   # รหัสยอดนิยมที่ห้ามใช้ (ใน git)
├── docs/games.v2.json     # แคตตาล็อกตัวอย่าง 6 เกม
├── public/                # Frontend (ขึ้น GitHub Pages ได้ ทุก path เป็นแบบ relative)
│   ├── index.html         # หน้าแรก + เติมเกม (?game=<slug>): ชิปเกม, กองเหรียญ, แพ็กเกจ, ช่องผู้เล่นจาก fields, ออเดอร์ของฉัน
│   ├── game.html          # redirect เก่า: game.html?slug=x → ./?game=x
│   ├── order.html         # สแกนจ่าย / QR หมดอายุ / สถานะ (SSE) / เติมไม่สำเร็จ-คืนเงิน
│   ├── login.html / signup.html   # เข้าสู่ระบบ / สมัครสมาชิก (คอม: แท็บสลับกันได้) · ?next=/path กลับหน้าเดิม
│   ├── forgot.html        # ลืมรหัสผ่าน → "ตรวจอีเมลของคุณ" + ส่งซ้ำได้ทุก 60 วิ
│   ├── reset.html         # ตั้งรหัสใหม่จากลิงก์อีเมล (#token=…) / ?mode=change = เปลี่ยนรหัสผ่าน
│   ├── account.html       # บัญชีของฉัน: ผูกออเดอร์ในเครื่อง, UID ที่บันทึก, ออเดอร์, ความปลอดภัย, ลบบัญชี
│   ├── admin.html         # หลังบ้าน (ไม่ขึ้น Pages)
│   ├── css/style.css      # design tokens (:root) + ทุก component · breakpoint เดียว 900px
│   └── js/
│       ├── config.js      # URL ของ API (ค่าว่าง = โดเมนเดียวกัน)
│       ├── common.js      # api(), esc(), ไอคอน SVG, remember (จำ UID ต่อเกม), myOrders, memberStatus(), safeNext()
│       ├── auth.js        # หน้า login / signup / forgot / reset
│       ├── account.js     # หน้า account
│       └── pile.js        # renderPile(): กองเหรียญ voxel แบบ SVG + animation ตอนเปลี่ยนแพ็กเกจ
├── db/
│   ├── migrations/001_init.sql   # ตาราง games, packages, orders, order_history, audit, jobs
│   ├── migrations/002_members.sql   # users, sessions, password_resets, saved_players, orders.user_id
│   ├── migrate.js         # รัน migration (แอปเรียกเองตอนเริ่ม)
│   └── import-json.js     # ย้าย data/*.json → PostgreSQL
├── docker/
│   ├── entrypoint.sh      # seed games.json ครั้งแรก (โหมดไฟล์ JSON)
│   ├── dev-watch.js       # รีสตาร์ทเมื่อแก้โค้ด (bind mount จาก Windows ไม่ส่ง event ไฟล์)
│   ├── nginx.conf / nginx.Dockerfile
│   ├── backup.sh / restore.sh
├── Dockerfile             # multi-stage: dev / prod
├── compose.yaml           # app + db (ใช้ร่วม)
├── compose.override.yaml  # dev: bind mount, port 3000/5432, Adminer
├── compose.prod.yaml      # prod: nginx port 80, NODE_ENV=production, TRUST_PROXY=1
├── test/                  # helpers.js (เปิด server ทดสอบ) · api.test.js · auth.test.js (ไฟล์ JSON หรือ PostgreSQL)
└── .github/workflows/deploy.yml   # deploy หน้าร้านขึ้น GitHub Pages
```

## ขั้นตอนของออเดอร์

```
pending_payment ─แจ้งโอน─▶ paid_pending_review ─ยืนยันยอด─▶ paid ─▶ processing ─▶ completed
    │ หมดเวลา                  ▲                           ▲             │
    ▼                          │ แจ้งโอนช้า                │ webhook     │ เติมไม่สำเร็จครบทุกครั้ง
 expired ──────────────────────┴───────────────────────────┘             ▼
                                                        paid ◀─เติมใหม่─ refund_needed ─▶ refunded
```

| สถานะ | ข้อความที่ลูกค้าเห็น | ความหมาย | ใครเปลี่ยน |
|---|---|---|---|
| `pending_payment` | รอชำระเงิน | สร้างออเดอร์แล้ว แสดง QR และนับถอยหลัง | ระบบ (ตอนสั่ง) |
| `paid_pending_review` | แจ้งโอนแล้ว รอร้านตรวจสอบ | ลูกค้ากด "ฉันโอนเงินแล้ว" (กดได้แม้หมดเวลาแล้ว) | ลูกค้า |
| `paid` | ยืนยันยอดแล้ว | ยืนยันว่าเงินเข้าแล้ว — ถ้าเปิด supplier จะเข้าคิวเติมทันที | webhook / แอดมิน |
| `processing` | กำลังเติมเข้าเกม | กำลังเรียก supplier | ระบบ (หรือแอดมิน) |
| `completed` | เติมสำเร็จ | supplier ยืนยันแล้ว หรือแอดมินเติมเอง | ระบบ / แอดมิน |
| `expired` | หมดเวลาชำระเงิน | ไม่จ่ายภายใน `ORDER_TTL_MINUTES` (QR หายไป) | ระบบ (ตรวจทุก 2 วินาที) |
| `cancelled` | ยกเลิกแล้ว | ยกเลิกออเดอร์ | แอดมิน |
| `refund_needed` | เติมไม่สำเร็จ รอคืนเงิน | จ่ายแล้วแต่เติมไม่สำเร็จครบ `FULFILL_ATTEMPTS` ครั้ง | ระบบ / แอดมิน |
| `refunded` | คืนเงินแล้ว | คืนเงินลูกค้าเรียบร้อย | แอดมิน |

ทุกการเปลี่ยนสถานะผ่าน `transition()` ใน `src/orders.js` ที่เดียว: เช็คสถานะต้นทางที่อนุญาต, บันทึก `history` และ `data/audit.json` พร้อมผู้ทำ (`customer` / `admin` / `webhook` / `system`) และ push ไปยังหน้าออเดอร์ผ่าน SSE

## ตัวแปร .env

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|
| `PORT` | `3000` | พอร์ตของเว็บ |
| `NODE_ENV` | `development` | ตั้ง `production` ตอนใช้จริง — เซิร์ฟเวอร์จะไม่ยอมเริ่มถ้า `ADMIN_PASSWORD` อ่อนเกินไป |
| `SHOP_NAME` | `Koinz` | ชื่อร้านที่แสดงบนเว็บและในข้อความแจ้งเตือน |
| `PROMPTPAY_ID` | `0812345678` | เบอร์โทร 10 หลัก หรือเลขบัตรประชาชน 13 หลักที่ผูก PromptPay |
| `PROMPTPAY_NAME` | `ร้าน Koinz` | ชื่อบัญชีที่ลูกค้าเห็นตอนโอน |
| `ADMIN_PASSWORD` | `admin1234` | รหัสผ่านหลังบ้าน (production ต้องตั้งเอง ยาว ≥ 12 ตัว และไม่ใช่ค่าตัวอย่าง) |
| `KOINZ_DATA_DIR` | `./data` | โฟลเดอร์เก็บไฟล์ JSON (เทสใช้โฟลเดอร์ชั่วคราว) |
| `DATABASE_URL` | – | ตั้ง = ใช้ PostgreSQL แทนไฟล์ JSON (migrate + ใส่เกมตั้งต้นเองตอนเริ่ม) — ใน Docker Compose ตั้งให้อัตโนมัติ |
| `POSTGRES_PASSWORD` | – | รหัสผ่าน PostgreSQL สำหรับ Docker Compose (จำเป็นเมื่อใช้ Docker) |
| `TEST_DATABASE_URL` | – | ใช้กับ `npm run test:pg` เท่านั้น: เทสจะสร้าง/ลบฐานข้อมูลชั่วคราวผ่าน connection นี้ |
| `ORDER_TTL_MINUTES` | `15` | เวลาให้ลูกค้าโอน (นาที, ใส่ทศนิยมได้) |
| `SHOP_LINE_URL` | – | ลิงก์ LINE ร้าน แสดงในหน้าออเดอร์ |
| `PAYMENT_WEBHOOK_SECRET` | – | รหัสลับตรวจลายเซ็น webhook ชำระเงิน — เว้นว่าง = ปิด webhook (404) |
| `SUPPLIER_API_URL` | – | URL ของ supplier เติมเกม (ต้องตั้งคู่กับ KEY ถึงจะเปิดเติมอัตโนมัติ) |
| `SUPPLIER_API_KEY` | – | API key ของ supplier (ส่งเป็น `Authorization: Bearer`) |
| `FULFILL_ATTEMPTS` | `3` | จำนวนครั้งที่ลองเติมก่อนเปลี่ยนเป็น `refund_needed` |
| `FULFILL_RETRY_BASE_SECONDS` | `3` | เวลารอก่อนลองใหม่ครั้งแรก ครั้งต่อไปเป็น 2 เท่า (3, 6, 12…) |
| `LOOKUP_API_URL` | – | API ตรวจชื่อในเกม — เว้นว่าง (และไม่เปิด mock) = ซ่อนปุ่มตรวจชื่อ |
| `LOOKUP_API_KEY` | – | API key ของระบบตรวจชื่อ (ส่งเป็น `Authorization: Bearer`) |
| `LOOKUP_MOCK` | `0` | `1` = ชื่อจำลอง "ผู้เล่นทดสอบ ####" สำหรับทดสอบเท่านั้น ห้ามเปิดบนร้านจริง |
| `ADMIN_ALERT_WEBHOOK` | – | Webhook ของ Discord หรือ Slack สำหรับแจ้งเตือนแอดมิน (ไม่ตั้ง = พิมพ์ลง log) |
| `FRONTEND_ORIGIN` | – | โดเมนหน้าร้านที่อยู่คนละที่กับ API (CORS) คั่นหลายอันด้วย `,` เช่น `https://rewchen.github.io` |
| `TRUST_PROXY` | – | ตั้งเมื่ออยู่หลัง nginx/proxy เช่น `1` หรือ `loopback` (ให้ rate limit เห็น IP จริง) |
| `RATE_LIMIT_OFF` | `0` | `1` = ปิด rate limit (ใช้ตอนเทสเท่านั้น) |
| `SESSION_SECRET` | – (สุ่มทุกครั้งที่ start) | ใช้ทำ HMAC ของ IP ใน session สมาชิก — production ต้องตั้งเอง ยาว ≥ 32 ตัว ไม่งั้นไม่ยอมเริ่ม |
| `TERMS_VERSION` | `2026-11` | เวอร์ชันเงื่อนไขการใช้งานที่บันทึกตอนสมาชิกสมัคร (เปลี่ยนเมื่อแก้เงื่อนไข) |
| `LINE_LOGIN_ENABLED` | `0` | `1` = แสดงปุ่มเข้าสู่ระบบด้วย LINE (เฟสถัดไป) |
| `MAIL_PROVIDER` | – | `resend` = ส่งอีเมลจริง · `log` = เขียนลง log (ทดสอบ) · ว่าง = ปิด "ลืมรหัสผ่าน?" (`/api/config` ส่ง `passwordResetEnabled: false`) |
| `RESEND_API_KEY` | – | API key ของ Resend (ใช้คู่กับ `MAIL_PROVIDER=resend` และ `MAIL_FROM`) |
| `MAIL_FROM` | – | ผู้ส่งอีเมล เช่น `Koinz <no-reply@โดเมนร้าน>` (โดเมนต้องยืนยันใน Resend แล้ว) |
| `MAIL_LOG_LINKS` | `0` | `1` = เขียนเนื้ออีเมล (มีลิงก์รีเซ็ต) ลง log — production ต้องตั้ง `SITE_BANNER` ด้วย (= staging) ไม่งั้นไม่ยอมเริ่ม |
| `RESEND_API_URL` | `https://api.resend.com` | ที่อยู่ API ของ Resend (เปลี่ยนเฉพาะตอนเทส) |
| `PUBLIC_URL` | โดเมน Railway / `http://localhost:<PORT>` | URL หน้าเว็บที่ใช้ในลิงก์ทางอีเมล (ไม่ใช้ Host header เพราะปลอมได้) — ตั้งเมื่อใช้โดเมนของร้านเอง |
| `RAILWAY_PUBLIC_DOMAIN` | – | Railway ใส่ให้เอง ใช้เป็นค่าเริ่มต้นของ `PUBLIC_URL` |
| `SITE_BANNER` | – | ข้อความแถบเหลืองบนสุดของทุกหน้า เช่น `เว็บทดสอบ — ห้ามโอนเงินจริง` (ตั้งใน staging เท่านั้น ดู [`docs/staging.md`](docs/staging.md)) |

## API

### หน้าร้าน

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| GET | `/api/config` | `{shopName, promptPayName, shopLineUrl, lookupEnabled, autoFulfill, orderTtlMinutes, siteBanner, passwordResetEnabled, lineLoginEnabled}` |
| GET | `/api/games` | รายชื่อเกม (`slug, name, category, color, currency, initial, minPrice`) |
| GET | `/api/games/:slug` | เกม + `fields` + `packages` (ไม่มี `sku`/`cost`) |
| POST | `/api/player/lookup` | `{gameSlug, playerInputs}` → `{nickname, mock}` · 404 ถ้ายังไม่เปิดระบบหรือไม่พบผู้เล่น · 30 ครั้ง/นาที |
| POST | `/api/orders` | `{gameSlug, packageId, playerInputs, contact?, idempotencyKey?}` → `201 {id, token}` (key ซ้ำ → `200` ออเดอร์เดิม) · 20 ครั้ง/นาที · ล็อกอินอยู่ = ผูกกับบัญชี + จำ UID |
| GET | `/api/orders/:id?t=token` | ออเดอร์ + `serverTime` + `qr` (เฉพาะตอนรอโอนและยังไม่หมดเวลา) · ไม่มี `t` = ใช้ session ของสมาชิกที่เป็นเจ้าของออเดอร์แทน (หน้าบัญชี) |
| GET | `/api/orders/:id/events?t=token` | SSE: `event: status` ทุกครั้งที่สถานะเปลี่ยน, `: ping` ทุก 25 วินาที · ไม่มี `t` = session เจ้าของ |
| POST | `/api/orders/:id/notify` | `{t, note?, lineId?}` ลูกค้าแจ้งโอน (จาก `pending_payment` หรือ `expired`) · 10 ครั้ง/นาที · ไม่มี `t` = session เจ้าของ และต้องมี `Origin` ของเว็บเอง |

### สมาชิก (cookie `koinz_sid`)

ทุก POST ต้องเป็น `Content-Type: application/json` และ `Origin` เป็นโดเมนเว็บเอง (หรืออยู่ใน `FRONTEND_ORIGIN`) ไม่งั้น `403` · ทุก response มี `Cache-Control: no-store`

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| POST | `/api/auth/signup` | `{email, password, acceptTerms: true, marketing?}` → `201 {email, createdAt}` + ล็อกอินให้เลย · อีเมลซ้ำ → `409` ข้อความกลาง ๆ · 5 ครั้ง/ชั่วโมง |
| POST | `/api/auth/login` | `{email, password}` → `{email, createdAt}` · ผิด → `401` ข้อความเดียวเสมอ · ผิด 5 ครั้งใน 15 นาที → `423 {error, lockedUntil, retryAfter}` 15 นาที · 10 ครั้ง/นาที |
| GET | `/api/auth/session` | `{member: {email}}` หรือ `{member: null}` (ตอบ 200 เสมอ — หน้าเว็บใช้เช็คว่าล็อกอินอยู่ไหม) |
| POST | `/api/auth/logout` | ลบ session ปัจจุบัน + ล้าง cookie |
| GET | `/api/me` | `{email, createdAt, sessionCount}` หรือ `401` |
| POST | `/api/auth/logout-all` | ออกจากระบบทุกอุปกรณ์ (รวมเครื่องนี้) |
| POST | `/api/auth/forgot` | `{email}` → `200` ข้อความเดียวกันเสมอไม่ว่ามีบัญชีหรือไม่ · ต่ออีเมล 3 ครั้ง/ชม. เว้น 60 วิ (เกิน = ไม่ส่งเงียบ ๆ) · ต่อ IP 10 ครั้ง/ชม. · ปิดอีเมลอยู่ → `503` |
| GET | `/api/auth/reset/:token` | `{valid: true, email}` หรือ `404 {valid: false}` (ไม่บอกอีเมล) |
| POST | `/api/auth/reset/verify` | `{token}` → ผลเหมือนบรรทัดบน แต่ token อยู่ใน body ไม่ติด access log (หน้า reset.html ใช้ตัวนี้) |
| GET | `/api/password-policy` | `{minLength, maxLength, common: [...]}` ให้หน้าสมัคร/ตั้งรหัสตรวจขณะพิมพ์ (ข้อมูลสาธารณะ cache 1 วัน ไม่มี no-store) |
| POST | `/api/auth/reset` | `{token, password, logoutOthers}` → ใช้ได้ครั้งเดียว, ลบลิงก์อื่นของบัญชี, ปลดล็อก, ล็อกอินให้ · `logoutOthers` ไม่ใช่ `false` = ออกจากระบบเครื่องอื่นทั้งหมด |
| POST | `/api/me/password` | `{currentPassword, newPassword}` → ออกจากระบบเครื่องอื่นทั้งหมด + อีเมลแจ้ง |
| GET | `/api/me/orders` | ออเดอร์ของฉัน 50 รายการล่าสุด (ไม่มี `token`, `contact`, `lineId`) |
| POST | `/api/me/orders/claim` | `[{id, token}]` (จาก localStorage) → `{claimed: [id]}` ผูกเฉพาะที่ token ถูกและยังไม่มีเจ้าของ |
| GET | `/api/me/players` · `/api/me/players/:gameSlug` | UID ที่บันทึกไว้ `{gameSlug, inputs, label, updatedAt}` (1 รายการต่อเกม อัปเดตทุกครั้งที่สั่งตอนล็อกอิน) |
| DELETE | `/api/me/players/:gameSlug` | ลบ UID ที่บันทึกของเกมนั้น |
| POST | `/api/me/delete` | `{password}` → ลบบัญชี (PDPA): ลบ session/UID/ลิงก์รีเซ็ต, users เหลือแถวแบบไม่มีข้อมูลส่วนตัว, ออเดอร์เก่าเก็บไว้แต่ไม่ผูก |

### Webhook

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| POST | `/api/webhooks/payment` | ยืนยันการชำระเงิน (เปิดเมื่อตั้ง `PAYMENT_WEBHOOK_SECRET`) |

### หลังบ้าน (ต้องส่ง `Authorization: Bearer <token>` จาก login)

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| POST | `/api/admin/login` | `{password}` → `{token}` (อายุ 8 ชั่วโมง) · 5 ครั้ง/นาที |
| POST | `/api/admin/logout` | ยกเลิก token |
| GET | `/api/admin/stats` | `{byStatus, revenueToday, autoFulfill, webhookEnabled, lookupEnabled}` (ยอดขายวันนี้ตามเวลาไทย) |
| GET | `/api/admin/orders?status=&q=` | ค้นจากเลขออเดอร์ / ข้อมูลผู้เล่น / contact / LINE / paymentRef (สูงสุด 500 รายการ ใหม่สุดก่อน) |
| GET | `/api/admin/orders/:id/audit` | ประวัติทุกการเปลี่ยนสถานะ พร้อมผู้ทำ |
| POST | `/api/admin/orders/:id/status` | `{status, note?}` → `{ok, autoFulfillQueued}` |
| POST | `/api/admin/orders/:id/retry` | สั่งเติมใหม่ผ่าน supplier (เฉพาะ `paid` / `processing` / `refund_needed`) |
| GET / PUT | `/api/admin/games` | ดู/แก้แคตตาล็อกทั้งร้าน (ตรวจด้วย `validateGames` ก่อนบันทึก) |

Error ทุกเส้นตอบเป็น `{ "error": "ข้อความภาษาไทย" }` · ทำรายการถี่เกิน → `429` พร้อม `Retry-After`

## Webhook ยืนยันการชำระเงิน

ผู้ให้บริการรับชำระ (หรือสคริปต์ตรวจสลิปของร้าน) ส่ง `POST /api/webhooks/payment`

- Body: `{"orderId": "KZ…", "amount": 159, "paymentRef": "เลขอ้างอิงธุรกรรม"}` (รับ `orderNumber` / `paymentReference` แทนได้)
- Header `x-payment-signature`: HMAC-SHA256 ของ **body ที่ส่งจริงทุกไบต์** ด้วย `PAYMENT_WEBHOOK_SECRET` แบบ hex

| กรณี | ผล |
|---|---|
| ลายเซ็นผิด / ไม่มี | `401` |
| `paymentRef` เคยบันทึกแล้ว หรือออเดอร์จ่ายแล้ว | `200 {"received": true, "duplicate": true}` |
| ยอดไม่ตรง (เทียบเป็นสตางค์) | `409` + แจ้งเตือนแอดมิน |
| ออเดอร์ `pending_payment` / `paid_pending_review` / `expired` | `200 {"received": true}` → `paid` (รับยอดที่มาหลังหมดเวลาด้วย เพราะลูกค้าจ่ายจริงแล้ว) |
| ออเดอร์ `cancelled` หรือสถานะอื่น | `409` + แจ้งเตือนแอดมินให้คืนเงิน |

ทดสอบยิงเองด้วย curl + openssl (Git Bash / Linux / macOS):

```bash
SECRET='ค่าเดียวกับ PAYMENT_WEBHOOK_SECRET'
BODY='{"orderId":"KZXXXXXXXX","amount":159,"paymentRef":"BANK-0001"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST http://localhost:3000/api/webhooks/payment \
  -H 'Content-Type: application/json' \
  -H "x-payment-signature: $SIG" \
  -d "$BODY"
```

## เติมเกมอัตโนมัติ (supplier)

เปิดเมื่อตั้งทั้ง `SUPPLIER_API_URL` และ `SUPPLIER_API_KEY` — ไม่ตั้ง = แอดมินเติมเองแล้วกด "เติมสำเร็จ" ในหลังบ้าน

เมื่อออเดอร์เป็น `paid` ระบบจะเข้าคิว (`data/jobs.json`) แล้วเรียก

```
POST {SUPPLIER_API_URL}/topups
Authorization: Bearer {SUPPLIER_API_KEY}
Idempotency-Key: {orderId}
{"sku": "MOBILE-LEGENDS-3", "player": {"uid": "123456789", "zone": "1234"}, "reference": "{orderId}"}
```

- ถือว่าสำเร็จเมื่อตอบ 2xx และ `status` ไม่มี หรือเป็น `success` / `succeeded` / `completed` / `ok` → `completed` และเก็บ `reference` (หรือ `id`) เป็น `supplierRef`
- ไม่สำเร็จ (HTTP error, timeout 20 วินาที, `status: pending` ฯลฯ) → ลองใหม่ตาม `FULFILL_ATTEMPTS` หน่วงแบบทวีคูณ → ครบแล้วเป็น `refund_needed` + แจ้งเตือนแอดมิน
- **ไม่มีทางเป็น `completed` ถ้า supplier ยังไม่ยืนยัน** ส่ง `Idempotency-Key` เดิมทุกครั้งเพื่อกันเติมซ้ำ
- เซิร์ฟเวอร์ดับกลางคัน → เปิดใหม่แล้วทำงานที่ค้างต่อ
- งานที่เสร็จเกิน 7 วันถูกลบทุกชั่วโมง

## ตรวจชื่อในเกม

- `LOOKUP_API_URL`: ระบบ POST `{"game": "<slug>", "player": {…}}` (timeout 8 วินาที) คาดหวัง `{"nickname": "…"}` · ตอบ 404 = "ไม่พบผู้เล่นนี้"
- `LOOKUP_MOCK=1`: ชื่อจำลองสำหรับทดสอบ
- ไม่ตั้งทั้งคู่: ซ่อนปุ่ม "ตรวจสอบชื่อในเกม" — **ระบบไม่โชว์ชื่อปลอมให้ลูกค้าจริง**
- ตอนสร้างออเดอร์ระบบจะลองดึงชื่อเก็บใน `playerNickname` ให้แอดมินเห็น (ดึงไม่ได้ก็สั่งต่อได้)

## แจ้งเตือนแอดมิน

ตั้ง `ADMIN_ALERT_WEBHOOK` เป็น Webhook URL ของ Discord หรือ Slack (ส่ง `{content, text}`) ระบบแจ้งเมื่อ: ลูกค้าแจ้งโอน, ยอดโอนไม่ตรง, ได้เงินของออเดอร์ที่ยกเลิกแล้ว, เติมไม่สำเร็จครบทุกครั้ง — ส่งไม่ได้ก็ไม่กระทบการทำงานหลัก

## รูปแบบ games.json

```jsonc
{
  "slug": "mobile-legends", "name": "Mobile Legends", "category": "MOBA",
  "color": "#2F7FD1", "currency": "เพชร", "active": true,
  "initial": "M",                          // ไม่ใส่ = ตัวแรกของชื่อ
  "fields": [                              // ช่องข้อมูลผู้เล่น เรียงตามที่แสดง (required ไม่ใส่ = true)
    { "name": "uid", "label": "User ID", "placeholder": "เช่น 123456789", "hint": "…",
      "pattern": "^[0-9]{5,12}$", "patternHint": "ใส่เฉพาะตัวเลข", "inputmode": "numeric" },
    { "name": "server", "label": "เซิร์ฟเวอร์", "options": ["Asia", "Europe"] }   // options = dropdown
  ],
  "packages": [
    { "id": "mobile-legends-1", "name": "เพชร 86", "price": 55, "tag": "ขายดี",
      "sku": "MOBILE-LEGENDS-1", "cost": 46.75, "active": true }   // sku, cost ไม่ส่งให้หน้าร้าน
  ]
}
```

แก้ได้ทั้งในหลังบ้าน (แท็บ "เกมและราคา") หรือแก้ไฟล์ตรง ๆ ระหว่างเซิร์ฟเวอร์รัน (ระบบเช็ค mtime) — กติกา: slug `a-z0-9-` 2–40 ตัวไม่ซ้ำ, ต้องมี fields และ packages อย่างน้อย 1, id แพ็กเกจห้ามซ้ำทั้งร้าน, ราคา > 0 ทศนิยมไม่เกิน 2 ตำแหน่ง

## Deploy บน Railway (แนะนำ: ทั้งเว็บอยู่โดเมนเดียว)

Railway build จาก `Dockerfile` ตาม `railway.json` (ได้ stage `prod` ซึ่งเป็น stage สุดท้าย) และรันหน้าร้าน + API + หลังบ้านใน service เดียว — ไม่ต้องตั้ง CORS และไม่ต้องใช้ GitHub Pages

1. **สร้าง project:** https://railway.com → New Project → Deploy from GitHub repo → เลือก `RewChen/Project-Koinz` (branch `main`)
2. **เพิ่มฐานข้อมูล:** ใน project กด **+ New → Database → PostgreSQL** ให้ชื่อ service เป็น `Postgres` (ตรงกับ `${{Postgres.DATABASE_URL}}` ในข้อถัดไป ถ้าตั้งชื่ออื่นให้แก้ตาม)
3. **ตั้งตัวแปร:** service ของแอป → **Variables → Raw Editor** → วางเนื้อหาจาก [`docs/railway.env.example`](docs/railway.env.example) แล้วแก้ค่าที่มี `<...>` (อย่างน้อย `ADMIN_PASSWORD`, `PROMPTPAY_ID`, `PROMPTPAY_NAME`) — ไม่ต้องตั้ง `PORT` Railway ใส่ให้เอง
4. **ทำโดเมน:** service ของแอป → **Settings → Networking → Generate Domain** (หรือ Custom Domain แล้วตั้ง CNAME ที่ผู้ให้บริการโดเมน) — HTTPS ได้อัตโนมัติ
5. **ตรวจ:** แท็บ Deployments → Deploy Logs ต้องเห็น `migrate: 001_init.sql ✓`, `seed: ใส่เกมตั้งต้น 6 เกม` และ `ข้อมูล: PostgreSQL` แล้วเปิด `https://<โดเมน>/` และ `https://<โดเมน>/admin.html`

หลังจากนี้ push `main` ทีไร Railway deploy ใหม่ให้เอง (เฉพาะเมื่อไฟล์ใน `watchPatterns` เปลี่ยน) ระหว่าง deploy จะรอ healthcheck `/api/config` ผ่านก่อนสลับไปใช้ตัวใหม่

ข้อควรรู้:
- **ใช้ 1 instance** (`numReplicas: 1`) และห้ามเปิด Serverless/sleep — session แอดมินกับ rate limit อยู่ในหน่วยความจำ และตัวกวาดออเดอร์หมดอายุ/คิวเติมเกมต้องรันตลอด
- **webhook ชำระเงิน** ให้ผู้ให้บริการยิงมาที่ `https://<โดเมน>/api/webhooks/payment`
- **backup:** เปิด Backups ใน service Postgres ของ Railway หรือสำรองเองด้วย `pg_dump "$DATABASE_PUBLIC_URL" > koinz.sql` (เปิด TCP Proxy ของ Postgres เพื่อให้มี `DATABASE_PUBLIC_URL`)
- **GitHub Pages:** ถ้าใช้ Railway เป็นหน้าร้านแล้ว ปิด Pages ได้ (Settings → Pages) หรือถ้าจะใช้ต่อ ให้ตั้ง repository variable `KOINZ_API_URL=https://<โดเมน Railway>` และตั้ง `FRONTEND_ORIGIN=https://rewchen.github.io` ใน Railway

## Deploy: หน้าร้านบน GitHub Pages + API แยก

หน้าร้าน (`public/`) เป็นไฟล์ static ทุก path เป็นแบบ relative จึงรันใต้ `https://<user>.github.io/Project-Koinz/` ได้ ส่วน API ต้องรันบนเซิร์ฟเวอร์ที่มี Node (VPS, Railway, Render ฯลฯ)

1. **ขึ้น API** บนเซิร์ฟเวอร์ แล้วตั้งใน `.env`
   ```
   NODE_ENV=production
   ADMIN_PASSWORD=<ยาวอย่างน้อย 12 ตัว>
   FRONTEND_ORIGIN=https://<user>.github.io
   TRUST_PROXY=1            # ถ้าอยู่หลัง nginx
   ```
   ต้องเป็น HTTPS (หน้า Pages เป็น https จะเรียก API ที่เป็น http ไม่ได้) ถ้าใช้ nginx ให้ปิด buffering ของ SSE — แอปส่ง header `X-Accel-Buffering: no` ให้แล้ว
2. **ตั้งค่า GitHub repo**
   - Settings → Pages → Source: **GitHub Actions**
   - Settings → Secrets and variables → Actions → **Variables** → เพิ่ม `KOINZ_API_URL` = `https://api.ร้านของคุณ.com` (ไม่มี `/` ท้าย)
3. **push `main`** → workflow `.github/workflows/deploy.yml` จะ copy `public/` เขียน `js/config.js` ใหม่ให้ชี้ไปที่ API แล้ว deploy (ไม่รวม `admin.html`)
4. แอดมินเข้าหลังบ้านผ่านโดเมนของ API: `https://api.ร้านของคุณ.com/admin.html`

ถ้าไม่ใช้ Pages ก็รันทั้งหมดบนเซิร์ฟเวอร์เดียวได้ตามปกติ (`js/config.js` ค่าว่าง = API อยู่โดเมนเดียวกัน) — วิธีที่ง่ายที่สุดคือ Docker โหมด prod ด้านบน แล้วทำ HTTPS ด้านหน้า (เช่น Cloudflare หรือ Caddy) ถ้ามี proxy เพิ่มอีกชั้นให้เพิ่ม `TRUST_PROXY` ตามจำนวนชั้น

## หมายเหตุสำคัญ

- เกมใน `data/games.json` เป็น **ตัวอย่าง** ให้แก้เป็นเกมที่ร้านคุณได้รับสิทธิ์ขายจริง
- อย่าใช้โลโก้/ชื่อเกมในลักษณะที่ทำให้ลูกค้าเข้าใจว่าเป็นเว็บทางการของผู้ให้บริการเกม
- ลิงก์ออเดอร์มี token ลับ ใครไม่มีลิงก์ดูออเดอร์ไม่ได้ — อย่าแชร์ลิงก์ออเดอร์ในที่สาธารณะ

## ขั้นต่อไป (Roadmap)

- [ ] ระบบสมาชิก + กระเป๋าเงิน (เติมเครดิตเก็บไว้)
- [ ] ลูกค้าอัปโหลดสลิป + ตรวจสลิปอัตโนมัติ (ส่งผลเข้า webhook ชำระเงินที่มีอยู่)
- [ ] เชื่อม payment gateway จริง (เช่น Omise / 2C2P / GB Prime Pay) เข้ากับ `/api/webhooks/payment`
- [x] ย้ายฐานข้อมูลไป PostgreSQL + Docker Compose + nginx (`DOCKER_SETUP.md`)
- [ ] แจ้งเตือนผ่าน LINE Notify / LINE OA
- [x] เชื่อม API ผู้ให้บริการเติมเกม เพื่อเติมอัตโนมัติ
- [x] Webhook ยืนยันการชำระเงินแบบ HMAC
- [x] แจ้งเตือนแอดมินผ่าน Discord / Slack
- [x] Rate limit + security headers
