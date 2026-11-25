const config = require('./src/config');
const { createApp } = require('./src/app');
const jobs = require('./src/jobs');

const app = createApp();
const server = app.listen(config.port, () => {
  const { port } = server.address();
  console.log(`✅ ${config.shopName} พร้อมใช้งานที่ http://localhost:${port}`);
  console.log(`🔐 หลังบ้าน: http://localhost:${port}/admin.html`);
  if (!config.adminPasswordSet) console.log('⚠️  ยังไม่ได้ตั้ง ADMIN_PASSWORD ในไฟล์ .env (ใช้ค่าเริ่มต้น admin1234)');
  jobs.start();
});
