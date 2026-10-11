FROM node:22-alpine AS base
RUN npm install -g pnpm@10.6.4
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/share/package.json ./packages/share/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY packages/share ./packages/share
COPY packages/protocol ./packages/protocol
COPY packages/core ./packages/core
COPY packages/cli ./packages/cli
RUN pnpm build:share && pnpm build:protocol && pnpm build:core && pnpm build:cli

FROM node:22-alpine AS production
RUN npm install -g pnpm@10.6.4
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/share/package.json ./packages/share/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/share/dist ./packages/share/dist
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY packages/cli/bin ./packages/cli/bin
USER node
ENTRYPOINT ["node", "packages/cli/bin/mcp-knot.js"]
