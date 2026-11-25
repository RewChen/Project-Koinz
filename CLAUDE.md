# Koinz — บริบทสำหรับ Claude Code

เว็บเติมเกม (Game Top-up) ภาษาไทย: เลือกเกม → กรอก UID → เลือกแพ็กเกจ → จ่าย QR PromptPay → แอดมินตรวจและเติม

## Stack
- Backend: Node.js 22 + Express 4 — ไม่ติดตั้งแพ็กเกจเพิ่มนอกจาก `express`, `qrcode` (ใช้ `fetch`, `crypto`, `events`, `node:test` ในตัว)
- Frontend: HTML/CSS/JS ล้วน (`public/`) ไม่มี build step, ทุก path เป็นแบบ relative (ขึ้น GitHub Pages ได้)
- Data: ไฟล์ JSON ใน `data/` หรือ `KOINZ_DATA_DIR` (แผนย้ายไป PostgreSQL ดู `DOCKER_SETUP.md`)

## โครงสร้าง
```
server.js            เช็คค่าตั้งค่า → listen → jobs.start()
src/config.js        อ่าน env ทั้งหมดที่เดียว (ตัวแปรใหม่ต้องเพิ่มใน .env.example + README ด้วย — มีเทสเช็ค)
src/store.js         read/write/update ไฟล์ JSON (cache + mtime, atomic write)
src/catalog.js       เกม/แพ็กเกจ, publicGame() ตัด sku/cost, validateInputs(), validateGames()
src/orders.js        สถานะ + ALLOWED, transition() = จุดเดียวที่เปลี่ยนสถานะ (history + audit + bus.emit)
src/jobs.js          คิวเติมเกม data/jobs.json + retry, กวาดออเดอร์หมดอายุทุก 2 วิ
src/adapters.js      lookupNickname, fulfillTopup, sendAlert
src/security.js      rate limit, security headers, CORS
src/app.js           createApp(): ทุก route
public/js/config.js  window.KOINZ_API (ค่าว่าง = โดเมนเดียวกัน) · common.js มี api(), apiUrl(), esc(), STATUS
test/api.test.js     เทส end-to-end (spawn server.js + โฟลเดอร์ข้อมูลชั่วคราว + Express ปลอมสำหรับ supplier/lookup/alert)
.github/workflows/deploy.yml   deploy public/ ขึ้น Pages (ไม่รวม admin.html)
```

## คำสั่ง
- `npm install` / `npm start` / `npm run dev` / `npm test`
- เว็บ: http://localhost:3000 · หลังบ้าน: http://localhost:3000/admin.html

## กติกา
- ข้อความที่ผู้ใช้เห็นต้องเป็นภาษาไทย, ราคาเป็นบาท (฿)
- ทุกค่าที่มาจากผู้ใช้ต้องผ่าน `esc()` ก่อนใส่ลง HTML (กัน XSS)
- อย่าเปลี่ยนรูปแบบ JSON ของ API โดยไม่แก้ frontend ให้ตรงกัน
- อย่าแก้ `src/promptpay.js` ถ้าไม่จำเป็น (ทดสอบ payload แล้ว)
- เปลี่ยนสถานะออเดอร์ผ่าน `orders.transition()` เท่านั้น ห้ามแก้ `status` ตรง ๆ
- ห้ามตั้งออเดอร์เป็น `completed` ถ้า supplier ยังไม่ยืนยัน และห้ามโชว์ชื่อในเกมปลอมให้ลูกค้าจริง
- path ใน `public/` ต้องเป็น relative, เรียก API ผ่าน `api()` / `apiUrl()` เท่านั้น
- แก้โค้ดแล้วรัน `npm test` ให้ผ่านก่อน commit
- อย่า commit `.env`
- ดีไซน์: กำลังย้ายไปโทนใหม่ "พื้นสว่าง + กองเหรียญ voxel" ตาม `DESIGN_SPEC.md` (ข้อมูลในไฟล์นั้นใช้แทนโทนครามเดิม) — ใช้ตัวแปรสีใน `public/css/style.css` ห้าม hardcode สีใหม่

## งานที่กำลังทำ (ทำตามลำดับนี้)
1. ~~`UPGRADE_SPEC.md`~~ — เสร็จแล้ว (branch `feature/upgrade`)
2. `DESIGN_SPEC.md` — เปลี่ยนหน้าเว็บเป็นดีไซน์ใหม่ (mockup: https://claude.ai/artifact/RTNnuM7nQQGNFjjWmFVtRi)
3. `DOCKER_SETUP.md` — Docker Compose + PostgreSQL + nginx

## การแบ่งงาน
- โค้ดทั้งหมด: Claude Code ทำตามไฟล์สเปก
- ดีไซน์และสเปก: มาจาก canvas ข้างบน ถ้าหน้าจอไหนไม่มีใน mockup ให้ถามก่อน อย่าคิดดีไซน์ใหม่เอง
- Roadmap อื่นอยู่ท้าย `README.md`
