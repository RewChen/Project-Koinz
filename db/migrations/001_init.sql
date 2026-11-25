-- Koinz: โครงสร้างตั้งต้น (ตรงกับ data/games.json, orders.json, jobs.json, audit.json)

-- ---------- เกมและแพ็กเกจ ----------
CREATE TABLE games (
  slug      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  category  TEXT,
  color     TEXT,
  currency  TEXT,
  initial   TEXT,
  active    BOOLEAN,                          -- NULL = ไม่ได้ระบุ (ถือว่าเปิด)
  sort      INT NOT NULL DEFAULT 0,
  fields    JSONB NOT NULL,                   -- ช่องข้อมูลผู้เล่น เก็บทั้งก้อนเพื่อคงลำดับ
  extra     JSONB NOT NULL DEFAULT '{}'       -- key อื่น ๆ ที่แอดมินใส่ไว้ (คงไว้ให้แก้กลับได้ครบ)
);

CREATE TABLE packages (
  id         TEXT PRIMARY KEY,                -- ไม่ซ้ำทั้งร้าน
  game_slug  TEXT NOT NULL REFERENCES games (slug) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price      NUMERIC(10, 2) NOT NULL CHECK (price > 0),
  tag        TEXT,
  sku        TEXT,
  cost       NUMERIC(10, 2),
  active     BOOLEAN,
  sort       INT NOT NULL DEFAULT 0,
  extra      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX packages_game_idx ON packages (game_slug, sort);

-- ---------- ออเดอร์ ----------
CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  token            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN (
                     'pending_payment', 'paid_pending_review', 'paid', 'processing', 'completed',
                     'expired', 'cancelled', 'refund_needed', 'refunded')),
  game_slug        TEXT NOT NULL,             -- ไม่ผูก FK: แก้/ลบเกมแล้วออเดอร์เก่ายังอยู่
  game_name        TEXT NOT NULL,
  package_id       TEXT NOT NULL,
  package_name     TEXT NOT NULL,
  sku              TEXT,
  player_inputs    JSONB NOT NULL DEFAULT '{}',
  player_label     TEXT NOT NULL DEFAULT '',
  player_nickname  TEXT,
  contact          TEXT NOT NULL DEFAULT '',
  line_id          TEXT NOT NULL DEFAULT '',
  customer_note    TEXT NOT NULL DEFAULT '',
  amount           NUMERIC(10, 2) NOT NULL,   -- ราคา ณ ตอนสั่ง
  expires_at       TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  payment_ref      TEXT UNIQUE,               -- กัน webhook ซ้ำ
  supplier_ref     TEXT,
  idempotency_key  TEXT UNIQUE,               -- กันสั่งซ้ำ
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_created_idx ON orders (created_at DESC);
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'pending_payment';

CREATE TABLE order_history (
  id        BIGSERIAL PRIMARY KEY,
  order_id  TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  status    TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  by        TEXT NOT NULL,                    -- customer | admin | webhook | system
  note      TEXT
);
CREATE INDEX order_history_order_idx ON order_history (order_id, id);

-- ---------- audit log ----------
CREATE TABLE audit (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL,
  order_id     TEXT,                          -- NULL = ไม่เกี่ยวกับออเดอร์ (เช่น แก้เกม)
  action       TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  actor        TEXT NOT NULL,
  note         TEXT
);
CREATE INDEX audit_order_idx ON audit (order_id, id);

-- ---------- คิวงาน (เติมเกมผ่าน supplier) ----------
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  order_id      TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  attempts      INT NOT NULL DEFAULT 0,
  run_at        TIMESTAMPTZ NOT NULL,
  last_error    TEXT,
  done          BOOLEAN NOT NULL DEFAULT false,
  result        TEXT,
  supplier_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ
);
-- ออเดอร์หนึ่งมีงานเติมที่ยังไม่จบได้แค่งานเดียว
CREATE UNIQUE INDEX jobs_one_active_fulfill ON jobs (order_id) WHERE type = 'fulfill' AND NOT done;
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE NOT done;
