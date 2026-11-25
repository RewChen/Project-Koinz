# งาน: สร้าง Docker Compose Environment สำหรับ Koinz

> ไฟล์นี้เป็น **คำสั่งงานสำหรับ Claude Code** — เปิด Claude Code ในโฟลเดอร์ `D:\koinz` แล้วพิมพ์:
> `อ่าน DOCKER_SETUP.md แล้วทำตามทีละ Phase รัน acceptance check ทุกข้อก่อนไป Phase ถัดไป`

## บริบทโปรเจกต์ (สถานะปัจจุบัน)

- เว็บเติมเกม: Node.js 22 + Express 4, frontend เป็น HTML/CSS/JS ล้วนใน `public/`
- `server.js` = API ทั้งหมด, `src/store.js` = ฐานข้อมูลแบบไฟล์ JSON ใน `data/`
- QR PromptPay สร้างใน `src/promptpay.js` (ห้ามแก้ logic นี้ — ทดสอบแล้ว)
- ค่าตั้งค่าอ่านจาก `.env` ผ่าน `src/env.js` (`PORT`, `SHOP_NAME`, `PROMPTPAY_ID`, `PROMPTPAY_NAME`, `ADMIN_PASSWORD`)
- เครื่องพัฒนาเป็น **Windows + Docker Desktop (WSL2)**

## เป้าหมาย

รันทั้งระบบได้ด้วยคำสั่งเดียว `docker compose up` ทั้งโหมด dev (แก้โค้ดแล้วรีโหลดเอง) และ prod (image เล็ก ปลอดภัย)

## สถาปัตยกรรมเป้าหมาย

```
                 ┌──────────────┐
  browser ──80──▶│ nginx (prod) │──▶ app:3000
                 └──────────────┘
  browser ─3000─▶ app (Node 22) ──5432──▶ db (PostgreSQL 16)
                                              ▲
  browser ─8080─▶ adminer (dev only) ─────────┘
```

| Service | Image | Port (host) | โหมด | หน้าที่ |
|---|---|---|---|---|
| `app` | build จาก `Dockerfile` | 3000 | dev + prod | เว็บ + API |
| `db` | `postgres:16-alpine` | 5432 (dev เท่านั้น) | dev + prod | ฐานข้อมูล |
| `adminer` | `adminer:4` | 8080 | dev | ดู/แก้ข้อมูลใน DB |
| `nginx` | `nginx:1.27-alpine` | 80 | prod | reverse proxy, gzip, cache static |

---

## Phase 1 — Dockerize แอปที่มีอยู่ (ยังใช้ไฟล์ JSON)

สร้างไฟล์:

1. **`Dockerfile`** — multi-stage
   - stage `base`: `node:22-alpine`, `WORKDIR /app`
   - stage `deps`: copy `package*.json` แล้ว `npm ci --omit=dev`
   - stage `dev`: `npm install` (รวม dev deps), `CMD ["npm","run","dev"]`
   - stage `prod`: copy `node_modules` จาก `deps` + source, `ENV NODE_ENV=production`, รันด้วย user `node` (ไม่ใช่ root), `EXPOSE 3000`, `HEALTHCHECK` เรียก `GET /api/config`, `CMD ["node","server.js"]`
2. **`.dockerignore`** — `node_modules`, `.env`, `data/orders.json`, `.git`, `*.md`
3. **`compose.yaml`** (ไฟล์หลัก ใช้ร่วมกัน)
   - service `app`: `env_file: .env`, `restart: unless-stopped`, volume ชื่อ `koinz-data` mount ที่ `/app/data`
   - ⚠️ `data/games.json` ต้องถูก seed เข้า volume ตอนรันครั้งแรก (ทำ entrypoint script `docker/entrypoint.sh` ที่ copy `games.json` จาก `/app/seed/` ถ้าใน volume ยังไม่มี)
4. **`compose.override.yaml`** (dev — Compose โหลดอัตโนมัติ)
   - `build.target: dev`, bind mount `./:/app` + anonymous volume `/app/node_modules`
   - `ports: "3000:3000"`
   - ถ้า `node --watch` ไม่จับการแก้ไฟล์บน Windows ให้ตั้ง `CHOKIDAR_USEPOLLING=true` หรือเปลี่ยน script dev เป็น `nodemon --legacy-watch`
5. **`compose.prod.yaml`** — `build.target: prod`, ไม่ bind mount source

✅ Acceptance check Phase 1
- [ ] `docker compose up --build` → เปิด http://localhost:3000 เห็นรายชื่อเกม 4 เกม
- [ ] แก้ข้อความใน `public/index.html` แล้วรีเฟรชเห็นผลทันที (dev)
- [ ] สร้างออเดอร์ → `docker compose down` → `up` อีกครั้ง → ออเดอร์ยังอยู่ (volume ทำงาน)
- [ ] `docker compose -f compose.yaml -f compose.prod.yaml up --build` ทำงาน และ `docker compose ps` แสดง `healthy`

## Phase 2 — เพิ่ม PostgreSQL แทนไฟล์ JSON

1. เพิ่ม service `db` ใน `compose.yaml`
   - `POSTGRES_DB=koinz`, `POSTGRES_USER=koinz`, `POSTGRES_PASSWORD` จาก `.env`
   - volume `koinz-pg:/var/lib/postgresql/data`
   - `healthcheck: pg_isready -U koinz`
   - `app.depends_on.db.condition: service_healthy`
   - เปิด port `5432` เฉพาะใน `compose.override.yaml`
2. เพิ่ม `adminer` ใน `compose.override.yaml` เท่านั้น (port 8080)
3. ติดตั้ง `pg` (node-postgres) — **ไม่ใช้ ORM** เพื่อให้โปรเจกต์เบา
4. สร้าง `db/migrations/001_init.sql`:
   - `games (slug PK, name, icon, color, currency, uid_hint, servers JSONB, active BOOL, sort INT)`
   - `packages (id PK, game_slug FK, name, price NUMERIC(10,2), tag, sort INT)`
   - `orders (id PK, token, game_slug, game_name, package_id, package_name, player_id, server, contact, amount NUMERIC(10,2), status, customer_note, created_at TIMESTAMPTZ)` + index ที่ `status`, `created_at`
   - `order_history (id SERIAL, order_id FK, status, at TIMESTAMPTZ)`
5. สร้าง `db/migrate.js` — รันไฟล์ใน `db/migrations` ตามลำดับ เก็บประวัติในตาราง `schema_migrations`; เรียกอัตโนมัติตอน container start
6. สร้าง `db/seed.js` — นำเข้า `data/games.json` ถ้าตาราง `games` ว่าง
7. เขียน `src/store.js` ใหม่เป็นฟังก์ชัน async (`listGames`, `getGame`, `createOrder`, `getOrder`, `updateOrderStatus`, `listOrders`, `replaceGames`) แล้วแก้ `server.js` ให้เรียกใช้
   - **API ทุกเส้นต้องตอบ JSON รูปแบบเดิมทุกประการ** — frontend ใน `public/` ห้ามต้องแก้
   - การเปลี่ยนสถานะออเดอร์ + insert history ต้องอยู่ใน transaction เดียว
8. เพิ่มตัวแปรใน `.env.example`: `DATABASE_URL=postgres://koinz:${POSTGRES_PASSWORD}@db:5432/koinz`, `POSTGRES_PASSWORD=`

✅ Acceptance check Phase 2
- [ ] `docker compose down -v && docker compose up --build` → ระบบ migrate + seed เองแล้วเปิดเว็บได้
- [ ] สร้างออเดอร์ → แจ้งโอน → แอดมินเปลี่ยนเป็น "เติมสำเร็จ" ได้ครบ flow
- [ ] เห็นข้อมูลใน Adminer ที่ http://localhost:8080
- [ ] แก้ราคาในหลังบ้าน (แท็บ "เกมและราคา") แล้วหน้าร้านแสดงราคาใหม่

## Phase 3 — Production hardening

1. เพิ่ม `nginx` ใน `compose.prod.yaml` + ไฟล์ `docker/nginx.conf`
   - proxy `/` → `app:3000`, gzip, cache `css/js` 7 วัน, ตั้ง header `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`
   - ใน prod ไม่เปิด port 3000 / 5432 ออกนอก (`expose` แทน `ports`)
2. เพิ่ม rate limit ใน Express (`express-rate-limit`): `/api/admin/login` 5 ครั้ง/นาที, `POST /api/orders` 20 ครั้ง/นาที
3. ตั้ง `app.set('trust proxy', 1)` เมื่ออยู่หลัง nginx
4. ให้แอป **ไม่ยอม start** ใน production ถ้า `ADMIN_PASSWORD` ยังเป็นค่า default หรือสั้นกว่า 12 ตัว
5. สคริปต์ backup: `docker/backup.sh` ใช้ `pg_dump` เก็บไฟล์ใน `./backups/` ตั้งชื่อตามวันที่

✅ Acceptance check Phase 3
- [ ] `docker compose -f compose.yaml -f compose.prod.yaml up -d --build` → http://localhost เปิดได้ผ่าน nginx
- [ ] `curl -I http://localhost/css/style.css` เห็น `Cache-Control` และ `Content-Encoding: gzip`
- [ ] ลอง login ผิด 6 ครั้งติด → ได้ 429
- [ ] backup สร้างไฟล์ `.sql` ได้ และ restore กลับได้

## ไฟล์ที่ต้องได้เมื่อเสร็จ

```
koinz/
├── Dockerfile
├── .dockerignore
├── compose.yaml
├── compose.override.yaml
├── compose.prod.yaml
├── docker/
│   ├── entrypoint.sh
│   ├── nginx.conf
│   └── backup.sh
└── db/
    ├── migrate.js
    ├── seed.js
    └── migrations/001_init.sql
```

## คำสั่งที่ใช้บ่อย (อัปเดตลง README.md ด้วยเมื่อเสร็จ)

```bash
docker compose up --build            # dev
docker compose logs -f app           # ดู log
docker compose exec db psql -U koinz # เข้า DB
docker compose down                  # หยุด (ข้อมูลยังอยู่)
docker compose down -v               # หยุด + ลบข้อมูลทั้งหมด ⚠️
docker compose -f compose.yaml -f compose.prod.yaml up -d --build   # prod
```

## กติกาสำหรับ Claude Code

- ทำทีละ Phase ห้ามข้าม ต้องผ่าน acceptance check ก่อนไปต่อ
- ห้าม commit `.env` หรือรหัสผ่านจริงลงไฟล์ใด ๆ
- ห้ามแก้ `src/promptpay.js` และห้ามเปลี่ยนรูปแบบ JSON ของ API
- ข้อความที่ผู้ใช้เห็น (error, UI) ต้องเป็นภาษาไทย
- จบแต่ละ Phase ให้สรุปสั้น ๆ ว่าสร้าง/แก้ไฟล์อะไร และวิธีทดสอบ
