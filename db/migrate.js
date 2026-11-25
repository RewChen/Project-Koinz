// รันไฟล์ใน db/migrations ตามลำดับชื่อ บันทึกที่รันแล้วใน schema_migrations
// แอปเรียกเองตอน start (ถ้าตั้ง DATABASE_URL) หรือรันมือ: npm run db:migrate
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 7270011; // กันหลาย instance migrate พร้อมกัน

async function migrate(pool, log = console.log) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`migrate: ${file} ✓`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migrate ${file} ไม่สำเร็จ: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const config = require('../src/config');
  const { Pool } = require('pg');
  if (!config.databaseUrl) {
    console.error('ยังไม่ได้ตั้ง DATABASE_URL');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: config.databaseUrl });
  migrate(pool)
    .then(() => console.log('migrate เสร็จแล้ว'))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
