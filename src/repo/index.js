// เลือกที่เก็บข้อมูล: ตั้ง DATABASE_URL → PostgreSQL, ไม่ตั้ง → ไฟล์ JSON ใน data/
const config = require('../config');

module.exports = config.databaseUrl ? require('./pg').createPgRepo(config.databaseUrl) : require('./json');
