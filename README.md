# Koinz — เว็บเติมเกมออนไลน์

โปรเจกต์ Next.js สำหรับหน้าร้านภาษาไทย พร้อม Express API, Prisma/PostgreSQL และ BullMQ/Redis สำหรับคำสั่งซื้อและงานเติมเกม

## โครงสร้าง

```text
game-topup-platform/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── server/
│   ├── adapters.ts       # mock ตรวจชื่อ + ตัวเชื่อม supplier
│   ├── index.ts          # Express API, order, payment webhook, tracking
│   ├── queue.ts          # BullMQ queues
│   └── worker.ts         # expiration และ fulfillment workers
├── src/app/
│   ├── game/[slug]/      # ฟอร์มเติมเกมตาม schema
│   ├── order/[id]/       # QR และติดตามสถานะผ่าน SSE
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx          # หน้าร้าน
├── docker-compose.yml
├── .env.example
└── package.json
```

## เริ่มระบบในเครื่อง

1. ติดตั้ง Node.js 20+ แล้วคัดลอก `.env.example` เป็น `.env` และใส่ `PROMPTPAY_ID` กับความลับ webhook ของระบบรับชำระเงินจริง
2. เริ่ม PostgreSQL และ Redis: `docker compose up -d`
3. ติดตั้งแพ็กเกจ: `npm install`
4. สร้าง Prisma client และตาราง: `npm run db:generate` แล้ว `npm run db:migrate`
5. เติมเกมและแพ็กเกจตัวอย่าง: `npm run db:seed`
6. เปิดแต่ละ process ใน terminal แยกกัน: `npm run dev`, `npm run server:dev`, `npm run worker`

เว็บเปิดที่ `http://localhost:3000`; API เปิดที่ `http://localhost:4000`.

## Deploy ไป GitHub Pages

มี GitHub Actions workflow ใน `.github/workflows/deploy.yml` ซึ่ง build เว็บแบบ static และ publish ไปยัง Pages ทุกครั้งที่ push เข้า `main`. Repository นี้จะใช้ base path `/Project-Koinz`; URL ของเว็บคือ `https://rewchen.github.io/Project-Koinz/`. ใน GitHub repository settings ให้ตั้ง Pages source เป็น **GitHub Actions**. ถ้าจะให้สั่งซื้อ/ชำระเงินจริง ให้เพิ่ม repository variable `NEXT_PUBLIC_API_URL` เป็น HTTPS URL ของ backend ที่ deploy แยกต่างหาก และตั้ง CORS ของ backend ให้ยอมรับ origin `https://rewchen.github.io`.

## API หลัก

- `POST /api/orders` สร้างคำสั่งซื้อและล็อกราคา ณ เวลาสั่งซื้อ; รองรับ PromptPay และ Wallet
- `POST /api/webhooks/payment` รับผลการชำระ โดยคำนวณ HMAC-SHA256 จาก raw request body และ header `x-payment-signature`
- `GET /api/orders/:id` อ่านสถานะ/QR; `GET /api/orders/:id/events` ส่งสถานะผ่าน SSE
- `POST /api/player/lookup` เรียกตัวอย่าง nickname lookup

Webhook body: `{"orderNumber":"TP…","paymentReference":"…","amount":159}`. ระบบรับ webhook เฉพาะคำสั่งซื้อที่ยัง PENDING, ยอดตรง และยังไม่หมดอายุ แล้วส่งงานเข้า queue โดยใช้ order ID เป็น BullMQ job ID กันงานซ้ำ

## ก่อนเปิดให้ลูกค้าจ่ายเงินจริง

- `lookupNickname` เป็น mock และต้องแทนด้วย API ที่ได้รับอนุญาตจากเกม/ผู้ให้บริการ
- `fulfillTopup` เป็น adapter โครงร่าง ต้องตั้ง `SUPPLIER_API_URL` และ `SUPPLIER_API_KEY` พร้อมยืนยัน SKU, รูปแบบคำขอและการ retry กับ supplier จริง
- QR ใช้ PromptPay ID จาก env; การยืนยันยอดต้องมาจากผู้ให้บริการชำระเงินที่ลงนาม webhook ตาม secret เดียวกัน
- หน้าแพ็กเกจและ seed เป็นข้อมูลตัวอย่าง ควรยืนยันราคา/สิทธิ์จำหน่ายกับ supplier ก่อนใช้งาน
- GitHub Pages ให้บริการเฉพาะ frontend แบบ static; Express, PostgreSQL และ Redis ต้อง deploy แยกต่างหาก
- ยังไม่ได้ใส่ระบบสมัคร/เข้าสู่ระบบ, หน้าจัดการแอดมิน, และหน้าฝาก Wallet; API และ schema มีส่วนประกอบ wallet/audit ให้ต่อยอด แต่ production ต้องเชื่อม authentication และตรวจสิทธิ์ admin ก่อนเปิด endpoint แก้ไขข้อมูล

## Security notes

อย่าเปิดเผย `PAYMENT_WEBHOOK_SECRET`, `SUPPLIER_API_KEY` หรือรหัสฐานข้อมูลใน frontend. ใน production ควรเพิ่ม rate limit, authentication/session, CSRF policy, logging/monitoring และตรวจสอบ webhook provider ตามเอกสารจริง. อย่าใช้ Playwright กับบัญชีผู้เล่นหรือเก็บรหัสผ่านเกม; ระบบนี้ออกแบบสำหรับ direct top-up ด้วย player identifiers เท่านั้น.
