# QuantSignal US-stock-perp Auto-Trader — Render / any Docker host
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# build tools only used if the better-sqlite3 prebuilt binary is unavailable
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY data/reference ./data/reference
COPY docs ./docs
COPY config.json ./config.json
# Mount a persistent volume here (Render persistent disk at /var/data)
ENV DATA_DIR=/var/data
RUN mkdir -p /var/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
