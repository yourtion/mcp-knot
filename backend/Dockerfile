FROM node:24-alpine AS base
RUN npm install -g pnpm@10.6.4
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches/ ./patches/
COPY packages/share/package.json ./packages/share/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/core/package.json ./packages/core/
COPY backend/package.json ./backend/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY packages/share ./packages/share
COPY packages/protocol ./packages/protocol
COPY packages/core ./packages/core
COPY backend ./backend
RUN pnpm build:share && pnpm build:protocol && pnpm build:core && pnpm build:api

FROM node:24-alpine AS production
RUN apk add --no-cache git
RUN npm install -g pnpm@10.6.4
WORKDIR /app
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=node:node patches/ ./patches/
COPY --chown=node:node packages/share/package.json ./packages/share/
COPY --chown=node:node packages/protocol/package.json ./packages/protocol/
COPY --chown=node:node packages/core/package.json ./packages/core/
COPY --chown=node:node backend/package.json ./backend/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder --chown=node:node /app/packages/share/dist ./packages/share/dist
COPY --from=builder --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=builder --chown=node:node /app/backend/dist ./backend/dist
RUN mkdir -p /app/config && chown node:node /app/config
ENV CONFIG_PATH=/app/config
USER node
EXPOSE 8181
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8181/api/ping', res => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "backend/dist/index.js"]
