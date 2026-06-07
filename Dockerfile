FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .

RUN pnpm build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8787 \
  SQLITE_DB_PATH=/data/tgbot-files.sqlite \
  SQLITE_MIGRATIONS_DIR=/app/backend/migrations \
  ASSETS_DIR=/app/frontend/dist

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data

RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

RUN pnpm install --frozen-lockfile --prod --filter backend

COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/migrations ./backend/migrations
COPY --from=build /app/frontend/dist ./frontend/dist

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "backend/dist/server/server.mjs"]
