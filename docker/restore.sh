#!/bin/sh
# กู้ฐานข้อมูลจากไฟล์สำรอง (เขียนทับข้อมูลปัจจุบันทั้งหมด!)
#   sh docker/restore.sh backups/koinz-YYYYMMDD-HHMMSS.sql
set -e
cd "$(dirname "$0")/.."
FILE="$1"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "ใช้: sh docker/restore.sh <ไฟล์ .sql ใน backups/>"; exit 1
fi
echo "หยุดแอปชั่วคราว…"
docker compose stop app
docker compose exec -T db psql -U koinz -d koinz -v ON_ERROR_STOP=1 -q < "$FILE"
docker compose start app
echo "กู้ข้อมูลจาก $FILE แล้ว"
