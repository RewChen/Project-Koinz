const config = require('./src/config');

const problems = config.startupProblems();
if (problems.length) {
  console.error('❌ ไม่สามารถเริ่มเซิร์ฟเวอร์บน production ได้:');
  problems.forEach((p) => console.error('   - ' + p));
  process.exit(1);
}

const { createApp } = require('./src/app');
const jobs = require('./src/jobs');

const app = createApp();
const server = app.listen(config.port, () => {
  const { port } = server.address();
  console.log(`✅ ${config.shopName} พร้อมใช้งานที่ http://localhost:${port}`);
  console.log(`🔐 หลังบ้าน: http://localhost:${port}/admin.html`);
  console.log(
    `⚙️  webhook ชำระเงิน: ${config.webhookEnabled ? 'เปิด' : 'ปิด'} · เติมอัตโนมัติ: ${config.autoFulfill ? 'เปิด' : 'ปิด (แอดมินเติมเอง)'} · ตรวจชื่อ: ${config.lookupEnabled ? (config.lookupMock && !config.lookupApiUrl ? 'จำลอง' : 'เปิด') : 'ปิด'}`
  );
  if (!config.adminPasswordSet) console.log('⚠️  ยังไม่ได้ตั้ง ADMIN_PASSWORD ในไฟล์ .env (ใช้ค่าเริ่มต้น admin1234)');
  jobs.start();
});
