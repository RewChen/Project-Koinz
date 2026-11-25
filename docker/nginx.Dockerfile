# nginx พร้อม config ของ Koinz ในตัว (prod ไม่ต้อง mount ไฟล์จากเครื่อง)
FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
# (ไม่รัน nginx -t ตอน build เพราะชื่อ host "app" มีเฉพาะตอนรันใน compose)
RUN sed -i 's/\r$//' /etc/nginx/conf.d/default.conf
