// ฐานข้อมูลแบบไฟล์ JSON (เหมาะกับช่วงเริ่มต้น — ภายหลังเปลี่ยนเป็น PostgreSQL ได้)
// มี cache ในหน่วยความจำ และเช็ค mtime ทุกครั้งที่อ่าน จึงแก้ไฟล์ด้วยมือระหว่างเซิร์ฟเวอร์รันได้
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./config');

const cache = new Map(); // name -> { mtimeMs, size, data }

function file(name) {
  return path.join(dataDir, `${name}.json`);
}

function load(name, fallback) {
  let stat;
  try {
    stat = fs.statSync(file(name));
  } catch {
    cache.delete(name);
    return fallback;
  }
  const hit = cache.get(name);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  try {
    const data = JSON.parse(fs.readFileSync(file(name), 'utf8'));
    cache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    return data;
  } catch (e) {
    console.error(`อ่านไฟล์ data/${name}.json ไม่ได้:`, e.message);
    return hit ? hit.data : fallback;
  }
}

// คืนสำเนาเสมอ ผู้เรียกแก้ไขได้โดยไม่กระทบ cache
function read(name, fallback) {
  const data = load(name, undefined);
  return data === undefined ? fallback : structuredClone(data);
}

function write(name, data) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // Windows: ถ้ามีโปรแกรมอื่นเปิดไฟล์ค้างอยู่ rename จะไม่ผ่าน → เขียนทับตรง ๆ แทน
    fs.rmSync(tmp, { force: true });
    if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
    fs.writeFileSync(target, json, 'utf8');
  }
  const stat = fs.statSync(target);
  cache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, data: structuredClone(data) });
}

// อ่าน → แก้ → เขียน ในจังหวะเดียว (synchronous จึงไม่มีงานอื่นแทรก)
function update(name, fallback, fn) {
  const data = read(name, fallback);
  const result = fn(data);
  write(name, data);
  return result;
}

module.exports = { read, write, update };
