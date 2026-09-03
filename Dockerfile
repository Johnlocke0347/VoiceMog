# All persistent state (players, battles, avatars) now lives in an
# external Postgres database — see DATABASE_URL in .env.example. That
# means this container itself is fully stateless: no volume to mount, no
# native module to compile (unlike the earlier better-sqlite3 version,
# `pg` is pure JS), and it's safe to kill and restart at any time.
FROM node:20-slim

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./
COPY public/ ../public/

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
