// ฐานข้อมูลแบบไฟล์ JSON (เหมาะกับช่วงเริ่มต้น — ภายหลังเปลี่ยนเป็น MySQL/PostgreSQL ได้)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function file(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { read, write };
