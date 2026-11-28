# syntax=docker/dockerfile:1
# Koinz — image เดียวมีทุกอย่างที่แอปต้องใช้: โค้ด, node_modules, ข้อมูลเกมตั้งต้น
#   docker compose up --build                                        → dev (stage dev)
#   docker compose -f compose.yaml -f compose.prod.yaml up -d --build → prod (stage prod)

# ---------- base ----------
FROM node:22-alpine AS base
WORKDIR /app
ENV KOINZ_DATA_DIR=/app/data
# entrypoint และ seed อยู่นอก /app เพื่อไม่ให้ bind mount ./:/app ของ dev ทับ
COPY docker/entrypoint.sh /usr/local/bin/koinz-entrypoint
COPY docs/games.v2.json /seed/games.json
# รายการรหัสยอดนิยม: สำรองไว้นอก /app/data เพราะ volume ของโหมดไฟล์ JSON mount ทับได้
COPY data/common-passwords.txt /seed/common-passwords.txt
RUN sed -i 's/\r$//' /usr/local/bin/koinz-entrypoint \
 && chmod +x /usr/local/bin/koinz-entrypoint \
 && mkdir -p /app/data \
 && chown -R node:node /app
ENTRYPOINT ["koinz-entrypoint"]

# ---------- deps (เฉพาะ dependencies ที่ใช้รันจริง) ----------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- dev (รวม dev deps, โค้ดมาจาก bind mount) ----------
FROM base AS dev
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY --chown=node:node . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---------- prod (image เล็ก ไม่ใช่ root) ----------
FROM base AS prod
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/config" > /dev/null || exit 1
CMD ["node", "server.js"]
