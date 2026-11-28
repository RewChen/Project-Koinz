const config = require('./src/config');

const problems = config.startupProblems();
if (problems.length) {
  console.error('❌ ไม่สามารถเริ่มเซิร์ฟเวอร์บน production ได้:');
  problems.forEach((p) => console.error('   - ' + p));
  process.exit(1);
}

const repo = require('./src/repo');
const { createApp } = require('./src/app');
const jobs = require('./src/jobs');

async function main() {
  // PostgreSQL: migrate + seed เกมตั้งต้นก่อนเปิดรับคำขอ
  await repo.init();

  const app = createApp();
  const server = app.listen(config.port, () => {
    const { port } = server.address();
    console.log(`✅ ${config.shopName} พร้อมใช้งานที่ http://localhost:${port}`);
    console.log(`🔐 หลังบ้าน: http://localhost:${port}/admin.html`);
    console.log(
      `⚙️  ข้อมูล: ${repo.kind === 'pg' ? 'PostgreSQL' : `ไฟล์ JSON (${config.dataDir})`} · webhook ชำระเงิน: ${config.webhookEnabled ? 'เปิด' : 'ปิด'} · เติมอัตโนมัติ: ${config.autoFulfill ? 'เปิด' : 'ปิด (แอดมินเติมเอง)'} · ตรวจชื่อ: ${config.lookupEnabled ? (config.lookupMock && !config.lookupApiUrl ? 'จำลอง' : 'เปิด') : 'ปิด'}`
    );
    if (!config.adminPasswordSet) console.log('⚠️  ยังไม่ได้ตั้ง ADMIN_PASSWORD ในไฟล์ .env (ใช้ค่าเริ่มต้น admin1234)');
    if (!config.sessionSecretSet) console.log('⚠️  ยังไม่ได้ตั้ง SESSION_SECRET (สุ่มใหม่ทุกครั้งที่ start — production ต้องตั้ง)');
    jobs.start().catch((e) => console.error('เริ่มงานเบื้องหลังไม่สำเร็จ:', e));
  });

  // ปิดอย่างสุภาพ (docker stop ส่ง SIGTERM)
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: กำลังปิดเซิร์ฟเวอร์…`);
    jobs.stop();
    server.close();
    server.closeAllConnections?.(); // ตัด SSE ที่เปิดค้าง
    repo.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('❌ เริ่มเซิร์ฟเวอร์ไม่สำเร็จ:', e.message);
  process.exit(1);
});
