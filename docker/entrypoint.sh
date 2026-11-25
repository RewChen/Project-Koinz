#!/bin/sh
# เตรียมโฟลเดอร์ข้อมูลก่อนรันแอป แล้วส่งต่อให้คำสั่งหลัก (CMD)
set -e

DATA_DIR="${KOINZ_DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

# ครั้งแรกที่ volume ยังว่าง → ใส่แคตตาล็อกเกมตั้งต้น (orders/jobs/audit ระบบสร้างเอง)
if [ ! -f "$DATA_DIR/games.json" ]; then
  cp /seed/games.json "$DATA_DIR/games.json"
  echo "koinz: seed games.json ลง $DATA_DIR"
fi

exec "$@"
