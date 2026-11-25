#!/bin/sh
# สำรองฐานข้อมูล → backups/koinz-YYYYMMDD-HHMMSS.sql
#   sh docker/backup.sh            (รันจากโฟลเดอร์โปรเจกต์ ขณะที่ db ทำงานอยู่)
set -e
cd "$(dirname "$0")/.."
mkdir -p backups
FILE="backups/koinz-$(date +%Y%m%d-%H%M%S).sql"
docker compose exec -T db pg_dump -U koinz -d koinz --clean --if-exists --no-owner --no-privileges > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
echo "สำรองข้อมูลแล้ว: $FILE ($(wc -c < "$FILE" | tr -d " ") bytes)"
