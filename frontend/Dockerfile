FROM node:22-alpine AS base
RUN npm install -g pnpm@10.6.4
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/share/package.json ./packages/share/
COPY frontend/package.json ./frontend/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY packages/share ./packages/share
COPY frontend ./frontend
RUN pnpm build:share && pnpm build:fe

FROM nginx:alpine AS production
COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
