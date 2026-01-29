FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY trading ./trading

RUN npm ci
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV CLODDS_STATE_DIR=/data
ENV CLODDS_WORKSPACE=/data/workspace

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/trading ./trading

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && pip3 install --no-cache-dir -r /app/trading/requirements.txt \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data /data/workspace \
  && chown -R node:node /data

USER node

EXPOSE 18789

CMD ["node", "dist/index.js"]
