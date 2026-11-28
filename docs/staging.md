# Railway staging — คู่มือตั้งเว็บทดสอบ

เว็บทดสอบแยกจากของจริง ไว้ลองระบบสมาชิก (branch `feature/member-auth`) ก่อน merge เข้า `main`
staging มีฐานข้อมูลของตัวเอง ไม่แตะข้อมูลลูกค้าจริง และมีแถบเหลืองบนสุด "เว็บทดสอบ — ห้ามโอนเงินจริง"

> ⚠️ staging กินเครดิต Railway เพิ่ม (มี service + Postgres อีกชุด) — ทดสอบเสร็จให้ลบตามหัวข้อ "ปิด staging" ท้ายไฟล์

## ก่อนเริ่ม

- branch `feature/member-auth` ต้องอยู่บน GitHub แล้ว (`git push -u origin feature/member-auth`)
- ต้องมี project Koinz บน Railway ที่ใช้กับเว็บจริงอยู่แล้ว (ตาม README หัวข้อ "Deploy บน Railway")

## 1. สร้าง environment `staging`

1. เปิด https://railway.com → เข้า project ของ Koinz
2. มุมซ้ายบนจะเห็นชื่อ environment (ปกติคือ `production`) → กดแล้วเลือก **+ New Environment**
3. ตั้งชื่อ `staging` แล้วเลือก **Empty Environment** (แบบว่าง) — **อย่าเลือก Duplicate** เพราะจะ copy ตัวแปร/ข้อมูลของ production มาด้วย
4. ตรวจว่ามุมซ้ายบนตอนนี้เป็น `staging` ก่อนทำขั้นต่อไปทุกครั้ง (ถ้าอยู่ `production` จะไปแก้เว็บจริง)

## 2. เพิ่มฐานข้อมูล

1. ใน environment `staging` กด **+ Create** (หรือ **+ New**) → **Database → Add PostgreSQL**
2. ตั้งชื่อ service เป็น `Postgres` (ต้องตรงกับ `${{Postgres.DATABASE_URL}}` ในข้อ 4)

## 3. เพิ่ม service ของแอป

1. กด **+ Create → GitHub Repo** → เลือก `RewChen/Project-Koinz`
2. เข้า service ที่เพิ่งสร้าง → **Settings → Source → Branch** เปลี่ยนเป็น **`feature/member-auth`**
   (Railway จะ build จาก `Dockerfile` ตาม `railway.json` เหมือน production)
3. ถ้ามันเริ่ม deploy ไปก่อนตั้งตัวแปร แล้วล้ม ไม่เป็นไร — ตั้งตัวแปรข้อ 4 เสร็จจะ deploy ใหม่เอง

## 4. ตั้งตัวแปร

service ของแอป (ใน `staging`) → **Variables → Raw Editor** → วางชุดข้างล่าง แล้วแก้ค่าที่มี `<...>` → **Update Variables**

```
NODE_ENV=production
ADMIN_PASSWORD=<รหัสหลังบ้านของ staging — ยาว ≥12 ตัว และห้ามซ้ำกับ production>
DATABASE_URL=${{Postgres.DATABASE_URL}}
TRUST_PROXY=1

SHOP_NAME=Koinz (ทดสอบ)
PROMPTPAY_ID=<ใช้เบอร์/เลขบัตรจริงได้ แต่ห้ามโอนเงินจริงตอนทดสอบ>
PROMPTPAY_NAME=<ชื่อบัญชี>
SHOP_LINE_URL=
ORDER_TTL_MINUTES=15

PAYMENT_WEBHOOK_SECRET=
SUPPLIER_API_URL=
SUPPLIER_API_KEY=
FULFILL_ATTEMPTS=3
FULFILL_RETRY_BASE_SECONDS=3
LOOKUP_API_URL=
LOOKUP_API_KEY=
LOOKUP_MOCK=0
ADMIN_ALERT_WEBHOOK=
FRONTEND_ORIGIN=

# เฉพาะ staging
SITE_BANNER=เว็บทดสอบ — ห้ามโอนเงินจริง
MAIL_PROVIDER=log
MAIL_LOG_LINKS=1
SESSION_SECRET=<สุ่มยาว ≥32 ตัว ห้ามซ้ำกับ production>
TERMS_VERSION=2026-11
LINE_LOGIN_ENABLED=0
```

หมายเหตุ:
- ชุดนี้คือ `docs/railway.env.example` + ตัวแปรของ staging — **ห้าม copy ค่าจาก production มาวาง** โดยเฉพาะ `ADMIN_PASSWORD` และ `SESSION_SECRET`
- สุ่ม `SESSION_SECRET` ได้ด้วยคำสั่งนี้ในเครื่อง: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- `MAIL_PROVIDER=log` + `MAIL_LOG_LINKS=1` = ไม่ส่งอีเมลจริง แต่เขียนลิงก์ตั้งรหัสใหม่ลง Deploy Logs ให้ก๊อปไปเปิดเอง — **ใช้ใน staging เท่านั้น ห้ามตั้งใน production**
- ตัวแปร `SESSION_SECRET`, `MAIL_*`, `TERMS_VERSION`, `LINE_LOGIN_ENABLED` ใช้กับระบบสมาชิก (Phase 1–2) ใส่ไว้ก่อนได้เลย ระหว่างนี้แอปจะไม่สนใจ
- **ห้ามโอนเงินจริง** แม้ QR จะเป็นของบัญชีจริง — ทดสอบด้วยปุ่ม "แจ้งโอน" และให้แอดมิน staging กดยืนยันยอดเองแทน

## 5. ทำโดเมน

1. service ของแอป → **Settings → Networking → Generate Domain**
2. จะได้ URL แบบ `https://<ชื่อ>-staging.up.railway.app` แยกจากเว็บจริง — จดไว้ใช้ใน `docs/staging-test.md`

## 6. ตรวจว่าใช้ได้

1. แท็บ **Deployments → Deploy Logs** ต้องเห็น
   - `migrate: 001_init.sql ✓` (หลัง Phase 1 จะมี `migrate: 002_members.sql ✓` เพิ่ม)
   - `seed: ใส่เกมตั้งต้น 6 เกม`
   - `ข้อมูล: PostgreSQL`
2. เปิด `https://<โดเมน staging>/` → ต้องเห็นแถบเหลืองบนสุด **"เว็บทดสอบ — ห้ามโอนเงินจริง"** และชื่อร้าน "Koinz (ทดสอบ)"
3. เปิด `https://<โดเมน staging>/admin.html` → เข้าด้วย `ADMIN_PASSWORD` ของ staging ได้ (ของ production ต้องเข้าไม่ได้)
4. เปิดเว็บจริง (production) → ต้อง**ไม่มี**แถบเหลือง

ตั้งเสร็จแล้ว ทุกครั้งที่ push `feature/member-auth` Railway จะ deploy staging ให้เอง (production ยังดึงจาก `main` เหมือนเดิม)

## ปิด staging (หลังทดสอบเสร็จ)

- หยุดชั่วคราว: service ของแอปใน `staging` → แท็บ Deployments → deployment ล่าสุด → **⋮ → Remove** (Postgres ยังอยู่ ข้อมูลทดสอบไม่หาย แต่ยังกินเครดิตเล็กน้อย)
- ลบทิ้งทั้งหมด: **Project Settings → Environments → staging → Delete Environment** (ลบทั้ง service และฐานข้อมูลของ staging — production ไม่โดน)
