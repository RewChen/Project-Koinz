// รีสตาร์ท server.js เมื่อโค้ดเปลี่ยน — ใช้ใน container dev แทน `node --watch`
// เพราะ bind mount จากไดรฟ์ Windows ไม่ส่ง event การแก้ไฟล์ (inotify) เข้า container จึงต้องเช็คด้วยการ poll
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WATCH_DIRS = ['src', 'db'];
const WATCH_FILES = ['server.js', 'package.json'];
const INTERVAL = 1000;

let child = null;
let restarting = false;

function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (!restarting && signal !== 'SIGTERM') console.log(`[dev-watch] server ปิดตัว (code ${code}) — แก้ไฟล์แล้วจะรันใหม่ให้`);
  });
}

function restart(file) {
  if (restarting) return;
  restarting = true;
  console.log(`[dev-watch] ${path.relative(ROOT, file)} เปลี่ยน → รีสตาร์ท`);
  const go = () => {
    restarting = false;
    start();
  };
  if (child && child.exitCode === null) {
    child.once('exit', go);
    child.kill('SIGTERM');
  } else go();
}

function listFiles() {
  const files = WATCH_FILES.map((f) => path.join(ROOT, f));
  for (const dir of WATCH_DIRS) {
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|json|sql)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(ROOT, dir));
  }
  return files;
}

// ตรวจ mtime ทุกวินาที (รวมไฟล์ที่เพิ่มใหม่)
let mtimes = new Map(listFiles().map((f) => [f, mtimeOf(f)]));
function mtimeOf(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}
setInterval(() => {
  const next = new Map(listFiles().map((f) => [f, mtimeOf(f)]));
  for (const [f, m] of next) {
    if (mtimes.get(f) !== m) {
      mtimes = next;
      return restart(f);
    }
  }
  mtimes = next;
}, INTERVAL);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (child && child.exitCode === null) child.kill(sig);
    process.exit(0);
  });
}

start();
