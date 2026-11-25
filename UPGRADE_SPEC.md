# งาน: อัปเกรด Koinz ให้มีฟีเจอร์เท่าหรือดีกว่า main เดิมบน GitHub

> ไฟล์นี้เป็น **คำสั่งงานสำหรับ Claude Code** เปิด Claude Code ในโฟลเดอร์ `D:\koinz` แล้วพิมพ์:
> `อ่าน UPGRADE_SPEC.md แล้วทำตามทีละ Phase รัน acceptance check ทุกข้อก่อนไป Phase ถัดไป และหยุดรอผมหลังจบแต่ละ Phase`

## ที่มา

main เดิมใน https://github.com/RewChen/Project-Koinz (สำรองไว้ที่ branch `backup/old-main`) เป็น Next.js + Prisma + BullMQ/Redis
เราจะ**คงสถาปัตยกรรมเบาของเรา** (Express + HTML/JS ล้วน + ไฟล์ JSON, ไม่ต้องมี Redis) แต่ทำฟีเจอร์ให้ครบทุกข้อของ main เดิม และปิดจุดอ่อนของมัน

| ฟีเจอร์ | main เดิม | เวอร์ชันนี้ต้องได้ |
|---|---|---|
| ช่องข้อมูลผู้เล่นตามเกม | ✅ `form_schema` | ✅ `fields` ใน games.json (Phase 1) |
| ตรวจชื่อในเกม | ✅ (mock) | ✅ adapter + ปิดอัตโนมัติถ้าไม่ได้ตั้งค่า ไม่โชว์ชื่อปลอมให้ลูกค้า (Phase 1) |
| กันสั่งซ้ำ (idempotency) | ✅ | ✅ (Phase 1) |
| ออเดอร์หมดอายุเอง | ✅ worker | ✅ ตัวกวาดในเซิร์ฟเวอร์ (Phase 1) |
| Webhook ยืนยันจ่ายมี HMAC | ✅ แต่ทิ้งยอดที่โอนหลังหมดเวลา | ✅ และ**รับยอดที่มาหลังหมดเวลา**ด้วย (Phase 2) |
| เติมอัตโนมัติผ่าน supplier + retry | ✅ BullMQ | ✅ คิวในไฟล์ `data/jobs.json` ทำต่อได้หลังรีสตาร์ท (Phase 2) |
| แจ้งเตือนแอดมิน | ✅ เฉพาะเติมพลาด | ✅ เติมพลาด + ลูกค้าแจ้งโอน + ยอดไม่ตรง (Phase 2) |
| สถานะ real-time | ✅ SSE (query DB ทุก 3 วิ) | ✅ SSE แบบ push ทันทีเมื่อสถานะเปลี่ยน (Phase 2) |
| Deploy GitHub Pages | ✅ | ✅ frontend ขึ้น Pages + API แยก (Phase 4) |
| ความเป็นส่วนตัวของออเดอร์ | ❌ ใครรู้เลขออเดอร์ก็ดูได้ | ✅ ต้องมี token (มีอยู่แล้ว ห้ามถอด) |
| หลังบ้านแอดมิน | ❌ | ✅ มีอยู่แล้ว + เพิ่มสรุปยอด/ค้นหา/ประวัติ (Phase 3) |
| Rate limit / security headers | ❌ | ✅ (Phase 2) |
| Audit log | schema อย่างเดียว | ✅ ใช้งานจริง (Phase 1) |
| เทสอัตโนมัติ | ❌ | ✅ `npm test` (Phase 4) |
| Wallet / สมาชิก | schema อย่างเดียว ใช้งานไม่ได้ | ไม่ทำในรอบนี้ (อยู่ใน Roadmap) |

## กติกา

- **ไม่ติดตั้งแพ็กเกจเพิ่ม** นอกจากที่มีอยู่ (`express`, `qrcode`) ใช้ของในตัว Node 18+ (`fetch`, `crypto`, `events`, `node:test`)
- **ห้ามแก้** `src/promptpay.js`
- ข้อความที่ผู้ใช้เห็นเป็นภาษาไทยทั้งหมด
- ทุกค่าจากผู้ใช้ที่แสดงใน HTML ต้องผ่าน `esc()` หรือ `textContent`
- งานหน้าตา (สี ฟอนต์ เลย์เอาต์) **ไม่ใช่งานของไฟล์นี้** — ทำแค่ให้ฟังก์ชันใหม่ใช้งานได้บนหน้าเดิม แล้วค่อยทำ `DESIGN_SPEC.md` ทีหลัง
- จบแต่ละ Phase: รันเทส → commit → สรุปสั้น ๆ ว่าแก้อะไร

## โครงสร้างไฟล์เป้าหมาย

```
server.js              # เช็คค่าตั้งค่า → listen → jobs.start()
src/
  env.js               # (มีอยู่) โหลด .env
  config.js            # ใหม่: อ่าน env ทั้งหมดที่เดียว
  store.js             # แก้: cache + เช็ค mtime (แก้ games.json ด้วยมือระหว่างรันได้)
  catalog.js           # ใหม่: เกม/แพ็กเกจ/ตรวจ fields
  orders.js            # ใหม่: สถานะ, transition(), audit, event bus
  jobs.js              # ใหม่: คิวเติมเกม + retry + กวาดออเดอร์หมดอายุ
  adapters.js          # ใหม่: ตรวจชื่อ, supplier, แจ้งเตือน
  security.js          # ใหม่: rate limit, headers, CORS
  app.js               # ใหม่: createApp() ทุก route (แยกจาก server.js เพื่อเทส)
  promptpay.js         # ห้ามแก้
test/api.test.js       # ใหม่
docs/games.v2.json     # แคตตาล็อก 6 เกมรูปแบบใหม่ (เตรียมไว้ให้แล้ว)
```

---

## Phase 1 — ข้อมูลเกม, ออเดอร์, หมดอายุ, กันสั่งซ้ำ

### 1.1 รูปแบบ games.json ใหม่
คัดลอก `docs/games.v2.json` ไปทับ `data/games.json` (6 เกมจาก main เดิม: RoV, Mobile Legends, Genshin, Free Fire, VALORANT, Delta Force)

```jsonc
{
  "slug": "mobile-legends", "name": "Mobile Legends", "category": "MOBA",
  "color": "#2F7FD1", "currency": "เพชร", "active": true,
  "initial": "M",                       // ไม่ใส่ = ตัวแรกของ name
  "fields": [                           // ช่องข้อมูลผู้เล่น เรียงตามที่แสดง
    { "name": "uid",  "label": "User ID", "placeholder": "เช่น 123456789", "hint": "…",
      "pattern": "^[0-9]{5,12}$", "patternHint": "ใส่เฉพาะตัวเลข", "inputmode": "numeric" },
    { "name": "zone", "label": "Zone ID", "pattern": "^[0-9]{3,6}$" },
    { "name": "server", "label": "เซิร์ฟเวอร์", "options": ["Asia", "Europe"] }   // options = dropdown
  ],                                    // required ไม่ใส่ = true
  "packages": [
    { "id": "mobile-legends-1", "name": "เพชร 86", "price": 55, "tag": "ขายดี",
      "sku": "MOBILE-LEGENDS-1", "cost": 46.75, "active": true }      // sku, cost = ห้ามส่งให้หน้าร้าน
  ]
}
```
- เลิกใช้ `icon`, `uidHint`, `servers` (ย้ายไปอยู่ใน `fields`)

### 1.2 `src/catalog.js`
- `publicGame(g)` คืนเฉพาะ field ที่หน้าร้านใช้ — **ห้ามมี `sku` และ `cost`**
- `validateInputs(game, raw)` → `{ inputs }` หรือ `{ error }`: trim, ว่าง+required → "กรุณากรอก{label}" (dropdown → "กรุณาเลือก{label}"), ยาวเกิน 64, ไม่อยู่ใน options, ไม่ตรง pattern (ใช้ `patternHint` ถ้ามี), มี `<>"'\`` → error, ตัด key ที่ไม่ได้ประกาศทิ้ง
- `playerLabel(game, inputs)`: 1 ช่อง → ค่าเดียว / หลายช่อง → `"User ID 123 · Zone ID 456"`
- `validateGames(arr)` ใช้ตอนแอดมินบันทึก: slug `^[a-z0-9-]{2,40}$` ไม่ซ้ำ, fields ≥1 (name `^[A-Za-z][A-Za-z0-9_]{0,30}$` ไม่ซ้ำ, มี label, pattern compile ได้), packages ≥1 (id ไม่ซ้ำ**ทั้งร้าน**, price > 0 ทศนิยม ≤2) — คืนข้อความ error ภาษาไทยที่บอกว่าเกม/แพ็กไหนผิด

### 1.3 `src/orders.js`
สถานะทั้งหมด:

| ค่า | ความหมาย |
|---|---|
| `pending_payment` | รอโอน มี QR |
| `paid_pending_review` | ลูกค้ากดแจ้งโอน รอร้านตรวจ |
| `paid` | ยืนยันยอดแล้ว (webhook หรือแอดมิน) |
| `processing` | กำลังเติม |
| `completed` | เติมสำเร็จ |
| `expired` | ไม่จ่ายภายในเวลา |
| `cancelled` | ยกเลิก |
| `refund_needed` | จ่ายแล้วแต่เติมไม่สำเร็จ |
| `refunded` | คืนเงินแล้ว |

- ทุกการเปลี่ยนสถานะต้องผ่าน `transition(id, to, actor, { from?, patch?, note? })` ที่เดียว: เช็คสถานะต้นทางที่อนุญาต, push `history` (`{status, at, by}`), เขียน audit, emit `bus.emit('status', id, to)`
- `actor` = `customer` | `admin` | `webhook` | `system`
- audit เก็บใน `data/audit.json` สูงสุด 5,000 รายการล่าสุด
- `publicView(o)` ตัด `token`, `contact`, `lineId`, `idempotencyKey`, `customerNote`

### 1.4 API ที่เปลี่ยน
**`POST /api/orders`** body ใหม่:
```json
{ "gameSlug": "mobile-legends", "packageId": "mobile-legends-3",
  "playerInputs": { "uid": "123456789", "zone": "1234" },
  "contact": "(ไม่บังคับ)", "idempotencyKey": "uuid จาก crypto.randomUUID()" }
```
- มี `idempotencyKey` ซ้ำกับออเดอร์เดิม → ตอบ `200` พร้อม `{id, token}` เดิม ไม่สร้างใหม่
- `contact` ไม่บังคับ
- ออเดอร์เก็บ: `playerInputs`, `playerLabel`, `playerNickname` (ถ้าตรวจชื่อได้), `amount` (ล็อกราคา ณ ตอนสั่ง), `expiresAt` = ตอนสั่ง + `ORDER_TTL_MINUTES` (ค่าเริ่ม 15), `paymentRef`, `supplierRef`, `lineId`, `updatedAt`
- ตอบ `201 {id, token}`

**`GET /api/orders/:id?t=`** เพิ่ม `serverTime` (ให้ตัวนับถอยหลังไม่เพี้ยนตามนาฬิกาเครื่องลูกค้า) และส่ง `qr` เฉพาะตอน `pending_payment` และยังไม่หมดเวลา

**`POST /api/orders/:id/notify`** รับ `{t, note, lineId}`; แจ้งได้จาก `pending_payment` **และ `expired`** (เผื่อลูกค้าโอนก่อนหมดเวลาแต่กดช้า) → `paid_pending_review`

**`POST /api/player/lookup`** `{gameSlug, playerInputs}` → `{nickname, mock}` หรือ 404 ถ้ายังไม่เปิดระบบ

**`GET /api/config`** เพิ่ม `shopLineUrl`, `lookupEnabled`, `autoFulfill`, `orderTtlMinutes`

### 1.5 ตรวจชื่อในเกม (`src/adapters.js` → `lookupNickname`)
- ตั้ง `LOOKUP_API_URL` (+`LOOKUP_API_KEY`) → POST `{game, player}` คาดหวัง `{nickname}`; timeout 8 วิ; 404 → "ไม่พบผู้เล่นนี้ ตรวจข้อมูลอีกครั้ง"
- `LOOKUP_MOCK=1` → ชื่อจำลอง `ผู้เล่นทดสอบ ####` และ `mock: true` (ไว้ทดสอบเท่านั้น)
- ไม่ได้ตั้งทั้งคู่ → ระบบปิด (`lookupEnabled: false`) หน้าร้านต้องซ่อนปุ่มตรวจชื่อ — **ห้ามโชว์ชื่อปลอมให้ลูกค้าจริง** (main เดิมทำแบบนั้น)
- ตอนสร้างออเดอร์ ถ้าเปิดระบบไว้ ให้ลองดึงชื่อเก็บใน `playerNickname` (ล้มเหลวก็สร้างออเดอร์ต่อได้)

### 1.6 ตัวกวาดออเดอร์หมดอายุ
ทุก 2 วินาที: `pending_payment` ที่เลย `expiresAt` → `expired` (actor `system`)

### 1.7 หน้าร้าน (ทำให้ใช้งานได้บนหน้าเดิม ยังไม่ต้องเปลี่ยนดีไซน์)
- `game.html`: สร้างช่องกรอกจาก `fields` (input หรือ select ตาม `options`, ใส่ `inputmode`, แสดง `hint`, ตรวจ `pattern` ฝั่ง client แล้วโชว์ `patternHint`)
- ปุ่ม "ตรวจสอบชื่อในเกม" แสดงเฉพาะตอน `lookupEnabled`
- ส่ง `idempotencyKey` (สร้างครั้งเดียวต่อการกดยืนยัน 1 ครั้ง ถ้ากดซ้ำเพราะเน็ตหลุดให้ใช้ key เดิม)
- ลบช่อง "ช่องทางติดต่อ" ที่บังคับกรอกออก
- `admin.html`: แสดง `playerLabel` และ `playerNickname` แทน `playerId`/`server`

✅ Acceptance Phase 1
- [ ] `GET /api/games/mobile-legends` มี 2 fields และไม่มีคำว่า `sku` หรือ `cost` ใน response
- [ ] สั่ง Mobile Legends ไม่กรอก Zone ID → 400 "กรุณากรอกZone ID"
- [ ] สั่ง VALORANT ด้วย `abc` → 400 พร้อม patternHint
- [ ] ส่ง `POST /api/orders` ด้วย idempotencyKey เดิม 2 ครั้ง → ได้ id เดียวกัน และใน orders.json มีออเดอร์เดียว
- [ ] ตั้ง `ORDER_TTL_MINUTES=0.05` (3 วินาที) แล้วสร้างออเดอร์ → ภายใน 5 วินาทีสถานะเป็น `expired` และไม่มี `qr`
- [ ] ออเดอร์ `expired` ยังกดแจ้งโอนได้ → `paid_pending_review`
- [ ] ไม่ตั้ง LOOKUP → `lookupEnabled: false` และปุ่มตรวจชื่อไม่แสดง / ตั้ง `LOOKUP_MOCK=1` → ปุ่มแสดงและได้ชื่อจำลอง
- [ ] ทุกการเปลี่ยนสถานะมีบันทึกใน `data/audit.json`

---

## Phase 2 — ชำระเงินอัตโนมัติ, เติมอัตโนมัติ, real-time, ความปลอดภัย

### 2.1 Webhook ยืนยันการชำระเงิน `POST /api/webhooks/payment`
- ปิดอยู่ (404) ถ้าไม่ได้ตั้ง `PAYMENT_WEBHOOK_SECRET`
- ต้องเก็บ raw body: `express.json({ verify: (req,_res,buf) => { req.rawBody = buf } })`
- header `x-payment-signature` = HMAC-SHA256(rawBody, secret) แบบ hex → เทียบแบบ timing-safe ผิด → 401
- body `{ "orderId": "KZ…", "amount": 289, "paymentRef": "…" }` (รับ `orderNumber`/`paymentReference` เป็นชื่อสำรองด้วย)
- `paymentRef` ซ้ำกับที่บันทึกไว้ → `200 {received:true, duplicate:true}`
- ยอดไม่ตรง (เทียบเป็นสตางค์) → 409 + แจ้งเตือนแอดมิน
- สถานะ `pending_payment` / `paid_pending_review` / **`expired`** → `paid` (patch `paymentRef`, `paidAt`) — รับยอดที่มาหลังหมดเวลาด้วย เพราะลูกค้าจ่ายเงินจริงแล้ว
- เป็น `paid`/`processing`/`completed` อยู่แล้ว → 200 duplicate
- `cancelled` หรืออื่น ๆ → 409 + แจ้งเตือนแอดมินให้คืนเงิน

### 2.2 คิวเติมเกม (`src/jobs.js` + `fulfillTopup`)
- เปิดเมื่อตั้ง `SUPPLIER_API_URL` และ `SUPPLIER_API_KEY` (ไม่ตั้ง = แอดมินเติมเอง เหมือนตอนนี้)
- เมื่อออเดอร์เปลี่ยนเป็น `paid` (จาก webhook หรือแอดมิน) และเปิด supplier ไว้ → เข้าคิว (ฟัง `bus.on('status')`) กันงานซ้ำด้วย orderId
- คิวเก็บใน `data/jobs.json`: `{id, type:'fulfill', orderId, attempts, runAt, lastError, done, result, createdAt}` — รีสตาร์ทแล้วทำต่อได้
- ทำงาน: `paid` → `processing` → เรียก supplier `POST {SUPPLIER_API_URL}/topups` header `authorization: Bearer KEY`, `idempotency-key: orderId`, body `{sku, player, reference}` timeout 20 วิ → สำเร็จ `completed` + `supplierRef`
- ล้มเหลว: retry ตาม `FULFILL_ATTEMPTS` (ค่าเริ่ม 3) หน่วงแบบ exponential 3, 6, 12 วิ… ครบแล้ว → `refund_needed` + แจ้งเตือนแอดมิน
- ลบงานที่เสร็จแล้วเกิน 7 วัน ทุกชั่วโมง
- **ห้ามตั้งเป็น completed ถ้า supplier ยังไม่ยืนยัน**

### 2.3 แจ้งเตือนแอดมิน `sendAlert(text)`
POST ไปที่ `ADMIN_ALERT_WEBHOOK` ด้วย body `{content: text, text}` (ใช้ได้ทั้ง Discord และ Slack) ห้ามทำให้ request หลักล้มถ้าส่งไม่ได้ ส่งเมื่อ: ลูกค้าแจ้งโอน, ยอดไม่ตรง, ได้เงินของออเดอร์ที่ยกเลิก, เติมไม่สำเร็จครบทุกครั้ง

### 2.4 SSE `GET /api/orders/:id/events?t=`
- ต้องมี token ถูกต้อง
- ส่งสถานะปัจจุบันทันที แล้ว push ทุกครั้งที่ `bus` emit ของออเดอร์นี้ (ไม่ต้อง poll ฐานข้อมูล)
- ping `: ping` ทุก 25 วินาที, header `X-Accel-Buffering: no` (สำหรับ nginx)
- ลบ listener เมื่อ client ปิด
- หน้า `order.html` ใช้ `EventSource` แทน setTimeout poll — ถ้า SSE หลุดให้ fallback เป็น poll ทุก 10 วิ

### 2.5 Security (`src/security.js`)
- Rate limit ในหน่วยความจำต่อ IP: login 5/นาที, สร้างออเดอร์ 20/นาที, ตรวจชื่อ 30/นาที, แจ้งโอน 10/นาที → 429 + `Retry-After` + "ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่" (`RATE_LIMIT_OFF=1` ปิดได้ตอนเทส)
- Headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`, ปิด `x-powered-by`
- CORS เฉพาะ origin ใน `FRONTEND_ORIGIN` (คั่นด้วย `,`) สำหรับ frontend ที่อยู่คนละโดเมน (GitHub Pages)
- `TRUST_PROXY` → `app.set('trust proxy', …)` เมื่ออยู่หลัง nginx
- `NODE_ENV=production` + `ADMIN_PASSWORD` เป็นค่าเริ่มต้นหรือสั้นกว่า 12 ตัว → ไม่ยอม start
- error handler กลาง: JSON พัง → 400 "รูปแบบข้อมูลไม่ถูกต้อง", อื่น ๆ → 500 ข้อความไทย (ไม่หลุด stack trace)

### 2.6 `.env.example` เพิ่ม
```
ORDER_TTL_MINUTES=15
SHOP_LINE_URL=
PAYMENT_WEBHOOK_SECRET=
SUPPLIER_API_URL=
SUPPLIER_API_KEY=
FULFILL_ATTEMPTS=3
LOOKUP_API_URL=
LOOKUP_API_KEY=
LOOKUP_MOCK=0
ADMIN_ALERT_WEBHOOK=
FRONTEND_ORIGIN=
TRUST_PROXY=
```
พร้อมคอมเมนต์ภาษาไทยอธิบายทุกตัว

✅ Acceptance Phase 2
- [ ] webhook ลายเซ็นผิด → 401 / ถูก → ออเดอร์เป็น `paid` / ส่งซ้ำ → `duplicate: true` / ยอดผิด → 409
- [ ] ออเดอร์ `expired` ได้ webhook ยอดถูก → `paid`
- [ ] รัน supplier ปลอมด้วย Express ใน test ที่ตอบ 500 สองครั้งแล้ว 200 → ออเดอร์จบที่ `completed` และ job มี `attempts: 3`
- [ ] supplier ตอบ 500 ตลอด → `refund_needed` และ alert ถูกเรียก
- [ ] เปิด `order.html` ค้างไว้ แล้วแอดมินเปลี่ยนสถานะ → หน้าเปลี่ยนภายใน 1 วินาที
- [ ] login ผิด 6 ครั้งติด → 429
- [ ] response มี security headers ครบ และไม่มี `x-powered-by`

---

## Phase 3 — หลังบ้าน

เพิ่ม API (ต้อง login ทั้งหมด):
- `GET /api/admin/stats` → `{byStatus, revenueToday (completed วันนี้ ตามเวลาไทย), autoFulfill, webhookEnabled, lookupEnabled}`
- `GET /api/admin/orders?status=&q=` → ค้นจาก เลขออเดอร์ / ข้อมูลผู้เล่น / contact / LINE / paymentRef, สูงสุด 500 รายการ
- `GET /api/admin/orders/:id/audit`
- `POST /api/admin/orders/:id/status` รับ `note` เพิ่ม และตอบ `autoFulfillQueued`
- `POST /api/admin/orders/:id/retry` → สั่งเติมใหม่ (เฉพาะ `paid`/`processing`/`refund_needed` และเปิด supplier)
- `POST /api/admin/logout`
- `PUT /api/admin/games` ใช้ `validateGames` + เขียน audit

หน้า `admin.html`:
- แถบสรุปด้านบน: จำนวนรอตรวจ (`paid_pending_review`), กำลังเติม, ต้องคืนเงิน, ยอดขายวันนี้, ป้ายบอกโหมด (webhook / supplier / ตรวจชื่อ เปิดหรือปิด)
- ช่องค้นหา + ตัวกรองสถานะ (ค่าเริ่ม = รอตรวจ)
- ปุ่มลัดตามสถานะ: รอตรวจ → "ยืนยันยอดเข้าแล้ว" (`paid`) / "ยกเลิก", refund_needed → "เติมใหม่" / "คืนเงินแล้ว"
- คลิกออเดอร์ → แผงรายละเอียด: ข้อมูลผู้เล่นทุกช่อง, ชื่อในเกม, LINE, หมายเหตุลูกค้า, paymentRef, supplierRef และ audit log
- รีเฟรชรายการอัตโนมัติทุก 15 วินาที
- แท็บเกมและราคา: แสดง error จาก `validateGames` ตรงตัว

✅ Acceptance Phase 3
- [ ] ค้นหาด้วยเลข UID แล้วเจอออเดอร์
- [ ] กด "ยืนยันยอดเข้าแล้ว" ตอนเปิด supplier ปลอม → ออเดอร์ไปจบ `completed` เอง
- [ ] audit แสดงครบทุกการเปลี่ยนสถานะ พร้อมผู้ทำ
- [ ] บันทึกเกมที่ id แพ็กเกจซ้ำ → เห็น error ที่บอกชื่อแพ็กที่ซ้ำ

---

## Phase 4 — เทส, GitHub Pages, เอกสาร

### 4.1 เทส `test/api.test.js` (ใช้ `node:test` + `fetch`)
- ตั้ง `KOINZ_DATA_DIR` เป็นโฟลเดอร์ชั่วคราว (copy `docs/games.v2.json` เข้าไป), `RATE_LIMIT_OFF=1`, port สุ่ม
- ครอบคลุม acceptance ทุกข้อของ Phase 1–3 ที่ทดสอบผ่าน API ได้ รวมถึง supplier ปลอมและ alert webhook ปลอม (Express ใน test)
- `package.json`: `"test": "node --test test/"`

### 4.2 GitHub Pages
- ทุก path ใน `public/` ต้องเป็นแบบ relative (`css/style.css`, `game.html?…`) เพื่อให้รันใต้ `/Project-Koinz/` ได้
- `public/js/config.js`: `window.KOINZ_API = ''` (ค่าว่าง = API อยู่โดเมนเดียวกัน) และ `api()` ใน `common.js` ต่อ URL ด้วยค่านี้
- `.github/workflows/deploy.yml`: เมื่อ push `main` → copy `public/` → เขียน `config.js` ใหม่จาก repository variable `KOINZ_API_URL` → `actions/upload-pages-artifact` + `actions/deploy-pages`
- ไม่ต้อง deploy `admin.html` ขึ้น Pages (ลบออกจาก artifact) ให้แอดมินใช้ผ่านโดเมนของ API

### 4.3 เอกสาร
- `README.md`: ตารางสถานะใหม่, API ทั้งหมด, ตัวแปร .env ทุกตัว, ตัวอย่างคำสั่งยิง webhook ด้วย curl + openssl, วิธี deploy (Pages + API แยก)
- `CLAUDE.md`: อัปเดตโครงสร้างไฟล์
- `DOCKER_SETUP.md`: Phase 2 (PostgreSQL) ให้ย้าย `orders`, `jobs`, `audit`, `games` ตามโครงสร้างใหม่

✅ Acceptance Phase 4
- [ ] `npm test` ผ่านทั้งหมด
- [ ] เปิด `public/index.html` ผ่าน static server ที่ path `/Project-Koinz/` แล้วโหลด CSS/JS ได้
- [ ] README อธิบายตัวแปร .env ครบทุกตัวที่โค้ดอ่าน
