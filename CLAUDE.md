# Koinz — บริบทสำหรับ Claude Code

เว็บเติมเกม (Game Top-up) ภาษาไทย: เลือกเกม → กรอก UID → เลือกแพ็กเกจ → จ่าย QR PromptPay → แอดมินตรวจและเติม

## Stack
- Backend: Node.js 22 + Express 4 (`server.js`)
- Frontend: HTML/CSS/JS ล้วน (`public/`) ไม่มี build step
- Data: ไฟล์ JSON ใน `data/` (แผนย้ายไป PostgreSQL ดู `DOCKER_SETUP.md`)

## คำสั่ง
- `npm install` / `npm start` / `npm run dev`
- เว็บ: http://localhost:3000 · หลังบ้าน: http://localhost:3000/admin.html

## กติกา
- ข้อความที่ผู้ใช้เห็นต้องเป็นภาษาไทย, ราคาเป็นบาท (฿)
- ทุกค่าที่มาจากผู้ใช้ต้องผ่าน `esc()` ก่อนใส่ลง HTML (กัน XSS)
- อย่าเปลี่ยนรูปแบบ JSON ของ API โดยไม่แก้ frontend ให้ตรงกัน
- อย่าแก้ `src/promptpay.js` ถ้าไม่จำเป็น (ทดสอบ payload แล้ว)
- อย่า commit `.env`
- ดีไซน์: กำลังย้ายไปโทนใหม่ "พื้นสว่าง + กองเหรียญ voxel" ตาม `DESIGN_SPEC.md` (ข้อมูลในไฟล์นั้นใช้แทนโทนครามเดิม) — ใช้ตัวแปรสีใน `public/css/style.css` ห้าม hardcode สีใหม่

## งานที่กำลังทำ (ทำตามลำดับนี้)
1. `UPGRADE_SPEC.md` — ฟีเจอร์ให้เท่า/ดีกว่า main เดิมบน GitHub (ฟอร์มตามเกม, webhook, เติมอัตโนมัติ, SSE, หลังบ้าน, เทส, GitHub Pages)
2. `DESIGN_SPEC.md` — เปลี่ยนหน้าเว็บเป็นดีไซน์ใหม่ (mockup: https://claude.ai/artifact/RTNnuM7nQQGNFjjWmFVtRi)
3. `DOCKER_SETUP.md` — Docker Compose + PostgreSQL + nginx

## การแบ่งงาน
- โค้ดทั้งหมด: Claude Code ทำตามไฟล์สเปก
- ดีไซน์และสเปก: มาจาก canvas ข้างบน ถ้าหน้าจอไหนไม่มีใน mockup ให้ถามก่อน อย่าคิดดีไซน์ใหม่เอง
- Roadmap อื่นอยู่ท้าย `README.md`
