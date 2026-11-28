-- Koinz: ระบบสมาชิก (AUTH_SPEC.md Phase 1)
-- ห้ามเก็บ token ดิบ: sessions.id และ password_resets.token_hash เป็น sha256(token) แบบ hex
-- users.id สร้างจากแอป (crypto.randomUUID) จึงไม่ต้องใช้ extension

CREATE TABLE users (
  id                        UUID PRIMARY KEY,
  email                     TEXT NOT NULL UNIQUE,      -- trim + lowercase (บัญชีที่ลบแล้ว = deleted-<id>@invalid)
  password_hash             TEXT NOT NULL,             -- scrypt$N$r$p$saltB64$hashB64
  terms_version             TEXT NOT NULL,
  terms_accepted_at         TIMESTAMPTZ NOT NULL,
  marketing_opt_in          BOOLEAN NOT NULL DEFAULT false,
  failed_logins             INT NOT NULL DEFAULT 0,
  failed_window_started_at  TIMESTAMPTZ,               -- เริ่มนับล็อกอินผิดรอบนี้ (ผิด 5 ครั้งใน 15 นาที → ล็อก)
  locked_until              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,                       -- sha256(token) hex
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  user_agent    TEXT,
  ip_hash       TEXT                                    -- HMAC-SHA256(ip, SESSION_SECRET) ไม่เก็บ IP ดิบ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,                         -- sha256(token) hex
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

CREATE TABLE saved_players (
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_slug   TEXT NOT NULL,
  inputs      JSONB NOT NULL DEFAULT '{}',
  label       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_slug)
);

ALTER TABLE orders ADD COLUMN user_id UUID REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC) WHERE user_id IS NOT NULL;
