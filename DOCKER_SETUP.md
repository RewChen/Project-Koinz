# งาน: สร้าง Docker Compose Environment สำหรับ Koinz

> ไฟล์นี้เป็น **คำสั่งงานสำหรับ Claude Code** — เปิด Claude Code ในโฟลเดอร์ `D:\koinz` แล้วพิมพ์:
> `อ่าน DOCKER_SETUP.md แล้วทำตามทีละ Phase รัน acceptance check ทุกข้อก่อนไป Phase ถัดไป`

## บริบทโปรเจกต์ (สถานะปัจจุบัน)

- เว็บเติมเกม: Node.js 22 + Express 4, frontend เป็น HTML/CSS/JS ล้วนใน `public/`
- `server.js` = start + `jobs.start()`, route ทั้งหมดอยู่ใน `src/app.js` (`createApp()`)
- ข้อมูลเป็นไฟล์ JSON 4 ไฟล์ใน `data/` (หรือ `KOINZ_DATA_DIR`): `games.json`, `orders.json`, `jobs.json`, `audit.json` — อ่าน/เขียนผ่าน `src/store.js` และใช้งานผ่าน `src/catalog.js`, `src/orders.js`, `src/jobs.js`
- QR PromptPay สร้างใน `src/promptpay.js` (ห้ามแก้ logic นี้ — ทดสอบแล้ว)
- ค่าตั้งค่าอ่านจาก `.env` ผ่าน `src/config.js` ที่เดียว (รายการตัวแปรทั้งหมดดูตาราง "ตัวแปร .env" ใน `README.md`)
- มีอยู่แล้วในแอป (ไม่ต้องทำซ้ำ): rate limit (`src/security.js`), security headers, `TRUST_PROXY`, ไม่ยอม start บน production ถ้ารหัสผ่านแอดมินอ่อน
- `npm test` รันเทส end-to-end ทั้งหมด — ต้องผ่านทุก Phase
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
2. **`.dockerignore`** — `node_modules`, `.env`, `data/orders.json`, `data/jobs.json`, `data/audit.json`, `.git`, `.github`, `test`, `*.md`
3. **`compose.yaml`** (ไฟล์หลัก ใช้ร่วมกัน)
   - service `app`: `env_file: .env`, `restart: unless-stopped`, volume ชื่อ `koinz-data` mount ที่ `/app/data` (หรือตั้ง `KOINZ_DATA_DIR`)
   - ⚠️ `games.json` ต้องถูก seed เข้า volume ตอนรันครั้งแรก (ทำ entrypoint script `docker/entrypoint.sh` ที่ copy `docs/games.v2.json` จาก `/app/seed/games.json` ถ้าใน volume ยังไม่มี) — `orders/jobs/audit.json` ระบบสร้างเอง
   - คิวเติมเกมอยู่ใน `jobs.json` ใน volume เดียวกัน → รีสตาร์ท container แล้วงานค้างทำต่อได้
4. **`compose.override.yaml`** (dev — Compose โหลดอัตโนมัติ)
   - `build.target: dev`, bind mount `./:/app` + anonymous volume `/app/node_modules`
   - `ports: "3000:3000"`
   - ถ้า `node --watch` ไม่จับการแก้ไฟล์บน Windows ให้ตั้ง `CHOKIDAR_USEPOLLING=true` หรือเปลี่ยน script dev เป็น `nodemon --legacy-watch`
5. **`compose.prod.yaml`** — `build.target: prod`, ไม่ bind mount source

✅ Acceptance check Phase 1
- [ ] `docker compose up --build` → เปิด http://localhost:3000 เห็นรายชื่อเกม 6 เกม
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
3. ติดตั้ง `pg` (node-postgres) — **ไม่ใช้ ORM** เพื่อให้โปรเจกต์เบา (เป็นแพ็กเกจเดียวที่เพิ่มได้)
4. สร้าง `db/migrations/001_init.sql` ให้ตรงกับไฟล์ JSON 4 ไฟล์ปัจจุบัน:
   - **`games`** (จาก `games.json`): `slug PK, name, category, color, currency, initial, active BOOL DEFAULT true, sort INT, fields JSONB NOT NULL` — `fields` เก็บทั้งก้อนเป็น JSONB (ลำดับช่องสำคัญ)
   - **`packages`**: `id PK (ไม่ซ้ำทั้งร้าน), game_slug FK → games ON DELETE CASCADE, name, price NUMERIC(10,2) CHECK (price > 0), tag, sku, cost NUMERIC(10,2), active BOOL DEFAULT true, sort INT`
   - **`orders`** (จาก `orders.json`): `id PK, token, status (CHECK อยู่ใน 9 สถานะ), game_slug, game_name, package_id, package_name, sku, player_inputs JSONB, player_label, player_nickname, contact, line_id, customer_note, amount NUMERIC(10,2), expires_at, paid_at, payment_ref, supplier_ref, idempotency_key, created_at, updated_at TIMESTAMPTZ`
     - `UNIQUE (idempotency_key)` และ `UNIQUE (payment_ref)` (NULL ซ้ำได้) — ให้ฐานข้อมูลกันสั่งซ้ำ/webhook ซ้ำแทนการเช็คในโค้ด
     - index: `status`, `created_at DESC`, partial index `(expires_at) WHERE status = 'pending_payment'` สำหรับตัวกวาดหมดอายุ
   - **`order_history`**: `id BIGSERIAL, order_id FK, status, at, by (customer/admin/webhook/system), note`
   - **`audit`** (จาก `audit.json`): `id BIGSERIAL, at, order_id NULL, action, from_status, to_status, actor, note` + index `(order_id, at)` — ไม่ต้องจำกัด 5,000 แถวแล้ว
   - **`jobs`** (จาก `jobs.json`): `id PK, type, order_id FK, attempts INT, run_at, last_error, done BOOL, result, supplier_ref, created_at, finished_at`
     - partial unique index `(order_id) WHERE type = 'fulfill' AND NOT done` — กันงานเติมซ้ำของออเดอร์เดียวกัน
     - index `(done, run_at)` สำหรับดึงงานที่ถึงเวลา
5. สร้าง `db/migrate.js` — รันไฟล์ใน `db/migrations` ตามลำดับ เก็บประวัติในตาราง `schema_migrations`; เรียกอัตโนมัติตอน container start
6. สร้าง `db/seed.js` — นำเข้า `docs/games.v2.json` ถ้าตาราง `games` ว่าง
7. สร้าง `db/import-json.js` — ย้ายข้อมูลจริงจาก `data/*.json` (games, orders + history, jobs, audit) เข้า PostgreSQL ครั้งเดียว รันซ้ำได้ (`ON CONFLICT DO NOTHING`)
8. เปลี่ยนชั้นข้อมูลเป็น async โดย**คง interface ของโมดูลเดิม** (`catalog`, `orders`, `jobs`) ให้ `src/app.js` แก้น้อยที่สุด:
   - เลือก backend จาก env: มี `DATABASE_URL` → PostgreSQL, ไม่มี → ไฟล์ JSON แบบเดิม (เทสและการรันบน Windows ไม่ต้องมี Docker)
   - `orders.transition()`: `BEGIN` → `SELECT … FOR UPDATE` → เช็ค `ALLOWED` → `UPDATE orders` + `INSERT order_history` + `INSERT audit` → `COMMIT` แล้วค่อย `bus.emit` (emit หลัง commit เท่านั้น)
   - `POST /api/orders`: `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING` แล้วถ้าชนให้ `SELECT` ออเดอร์เดิมตอบ `200`
   - webhook: ใช้ `UNIQUE (payment_ref)` ตัดสินว่าซ้ำ
   - คิวเติมเกม: ดึงงานด้วย `SELECT … WHERE NOT done AND run_at <= now() FOR UPDATE SKIP LOCKED` (รองรับหลาย instance)
   - ตัวกวาดหมดอายุ: `UPDATE … WHERE status = 'pending_payment' AND expires_at <= now() RETURNING id` แล้วเขียน history/audit + emit ทีละรายการ
   - SSE ใช้ `bus` ในหน่วยความจำได้ถ้ามี app instance เดียว — ถ้าจะ scale หลาย instance ให้ใช้ `LISTEN/NOTIFY` ของ PostgreSQL ส่งต่อเข้า `bus`
   - `store.js` cache + mtime ใช้เฉพาะ backend ไฟล์ JSON
   - **API ทุกเส้นต้องตอบ JSON รูปแบบเดิมทุกประการ** — frontend ใน `public/` ห้ามต้องแก้ (`NUMERIC` ต้องแปลงกลับเป็น number, เวลาเป็น ISO string, ชื่อ field เป็น camelCase เหมือนเดิม)
9. เทส: `npm test` ต้องผ่านทั้งแบบไฟล์ JSON และแบบ `DATABASE_URL` (เพิ่ม `npm run test:pg` ที่ชี้ไปฐานข้อมูลทดสอบใน compose)
10. เพิ่มตัวแปรใน `.env.example` + ตาราง "ตัวแปร .env" ใน README (มีเทสเช็คว่าครบ): `DATABASE_URL=postgres://koinz:${POSTGRES_PASSWORD}@db:5432/koinz`, `POSTGRES_PASSWORD=`

✅ Acceptance check Phase 2
- [ ] `docker compose down -v && docker compose up --build` → ระบบ migrate + seed เองแล้วเปิดเว็บได้ เห็น 6 เกม
- [ ] สร้างออเดอร์ → แจ้งโอน → แอดมินกด "ยืนยันยอดเข้าแล้ว" → "เติมสำเร็จ" ได้ครบ flow และ audit แสดงครบ
- [ ] ยิง `POST /api/orders` ด้วย idempotencyKey เดิมพร้อมกัน 2 ครั้ง → ใน `orders` มีแถวเดียว
- [ ] รีสตาร์ท container ระหว่างงานเติมกำลัง retry → งานทำต่อจนจบ
- [ ] `db/import-json.js` ย้ายข้อมูลจาก `data/*.json` แล้วจำนวนออเดอร์/audit ตรงกัน
- [ ] เห็นข้อมูลใน Adminer ที่ http://localhost:8080
- [ ] แก้ราคาในหลังบ้าน (แท็บ "เกมและราคา") แล้วหน้าร้านแสดงราคาใหม่

## Phase 3 — Production hardening

1. เพิ่ม `nginx` ใน `compose.prod.yaml` + ไฟล์ `docker/nginx.conf`
   - proxy `/` → `app:3000`, gzip, cache `css/js` 7 วัน — security headers แอปตั้งให้แล้ว อย่าตั้งซ้ำใน nginx (จะได้ header ซ้ำ)
   - `location ~ ^/api/orders/[^/]+/events$` (SSE): `proxy_buffering off; proxy_cache off; proxy_read_timeout 1h; proxy_http_version 1.1; proxy_set_header Connection "";`
   - ส่ง `X-Forwarded-For` / `X-Forwarded-Proto` และอย่าแก้ body ของ `/api/webhooks/payment` (ลายเซ็น HMAC คิดจาก raw body)
   - ใน prod ไม่เปิด port 3000 / 5432 ออกนอก (`expose` แทน `ports`)
2. ~~rate limit~~ — มีแล้วใน `src/security.js` (login 5, สร้างออเดอร์ 20, ตรวจชื่อ 30, แจ้งโอน 10 ครั้ง/นาที) ไม่ต้องติดตั้ง `express-rate-limit`
3. ตั้ง `TRUST_PROXY=1` ใน `.env` ของ prod (แอปอ่านค่านี้แล้ว `app.set('trust proxy', …)` ให้เอง) ไม่งั้น rate limit จะเห็นทุกคนเป็น IP ของ nginx
4. ~~ไม่ยอม start ถ้ารหัสผ่านอ่อน~~ — มีแล้ว (ตั้ง `NODE_ENV=production` ใน image prod)
5. สคริปต์ backup: `docker/backup.sh` ใช้ `pg_dump` เก็บไฟล์ใน `./backups/` ตั้งชื่อตามวันที่

✅ Acceptance check Phase 3
- [ ] `docker compose -f compose.yaml -f compose.prod.yaml up -d --build` → http://localhost เปิดได้ผ่าน nginx
- [ ] `curl -I http://localhost/css/style.css` เห็น `Cache-Control` และ `Content-Encoding: gzip`
- [ ] ลอง login ผิด 6 ครั้งติด → ได้ 429 (และ IP คนอื่นยัง login ได้ = `TRUST_PROXY` ทำงาน)
- [ ] เปิดหน้าออเดอร์ผ่าน http://localhost แล้วแอดมินเปลี่ยนสถานะ → หน้าเปลี่ยนภายใน 1 วินาที (SSE ผ่าน nginx ไม่ติด buffer)
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
    ├── import-json.js
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
