# MCP Knot 部署指南

本指南介绍如何在生产环境中部署 MCP Knot。

## 目录

- [部署架构](#部署架构)
- [端口与服务](#端口与服务)
- [环境要求](#环境要求)
- [部署方式](#部署方式)
  - [方式 1：Docker Compose（推荐）](#方式-1docker-compose推荐)
  - [方式 2：传统部署（PM2）](#方式-2传统部署pm2)
- [配置管理](#配置管理)
- [环境变量](#环境变量)
- [安全加固](#安全加固)
- [反向代理（Nginx）](#反向代理nginx)
- [监控、日志与备份](#监控日志与备份)
- [运维脚本](#运维脚本)
- [故障排除](#故障排除)

---

## 部署架构

MCP Knot 由两个服务组成：

```
┌──────────────┐         ┌──────────────────┐
│  浏览器/客户端 │ ──────▶ │ mcp-knot-web      │  (Nginx + 前端静态文件)
└──────────────┘         │ 端口 8180          │
                          └────────┬─────────┘
                                   │ 反向代理 /api、/:group/mcp
                          ┌────────▼─────────┐
                          │ mcp-knot-api      │  (Node.js 后端)
                          │ 端口 8181          │
                          └────────┬─────────┘
                                   │ 读写
                          ┌────────▼─────────┐
                          │ config/*.json     │  (4 个 JSON 配置文件)
                          └──────────────────┘
```

组件说明：

1. **mcp-knot-web**：Nginx 托管构建后的 Vue 前端，并将 API/MCP 请求代理到后端。
2. **mcp-knot-api**：Node.js 应用，承载所有业务逻辑和 MCP 服务。
3. **配置文件**：4 个 JSON 文件，见 [配置管理](#配置管理)。

## 端口与服务

| 服务 | 容器名         | 内部端口 | 主机映射端口 | 说明    |
| ---- | -------------- | -------- | ------------ | ------- |
| 前端 | `mcp-knot-web` | 80       | **8180**     | Nginx   |
| 后端 | `mcp-knot-api` | 8181     | **8181**     | Node.js |

> **注意**：后端监听端口由 `system.json` 的 `server.port` 控制，默认 `8181`。代码**不读** `PORT` 环境变量，若需改端口请修改 `system.json`，不要用 `PORT=xxx` 启动。

## 环境要求

### 硬件

- 最小：2 核 CPU、2GB 内存、10GB 磁盘
- 推荐：4 核 CPU、4GB 内存、20GB SSD

### 软件

- Node.js 20.x+（传统部署）
- pnpm 8.x+（传统部署）
- Docker 20.10+ 与 Docker Compose v2（容器部署）
- 操作系统：Linux（Ubuntu 20.04+/CentOS 8+）或 macOS

### 网络

- 开放端口：`8180`（前端，或由前置 Nginx 暴露 80/443）、`8181`（后端，建议仅内网）
- 建议使用域名和 SSL 证书

---

## 部署方式

### 方式 1：Docker Compose（推荐）

仓库提供三个 Compose 文件，均保留 API 8181 与 Web 8180 的入口：

| 文件                         | 用途                                           |
| ---------------------------- | ---------------------------------------------- |
| `docker-compose.release.yml` | 从 GHCR 拉取明确指定的发布镜像，不执行本地构建 |
| `docker-compose.yml`         | 从当前源码构建生产镜像                         |
| `docker-compose.dev.yml`     | 从源码运行开发服务与热重载                     |

#### 0. v0.1.1 发布与验证状态

2026-10-12 已发布 `v0.1.1`。当前
[API](https://github.com/yourtion/mcp-knot/pkgs/container/mcp-knot-api) 与
[Web](https://github.com/yourtion/mcp-knot/pkgs/container/mcp-knot-web) 均为 **Public**，
已用没有 registry 登录凭据的客户端实际拉取，部署主机无需 `docker login`。
首次创建其他 GHCR 包仍可能默认私有；若以后改为私有，部署主机需要已有的获准读访问，
具体见 [GHCR 发布配置](RELEASING.md#ghcr-镜像可选)。当前两包没有待处理的可见性设置。

| 检查                      | v0.1.1 实际结果                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main CI / npm / GHCR 发布 | [main CI](https://github.com/yourtion/mcp-knot/actions/runs/38270879718) 8 项成功；[发布 workflow](https://github.com/yourtion/mcp-knot/actions/runs/38270879831) 全部成功 |
| npm 四包                  | share/protocol/core/cli 的 `0.1.1`、`latest` 和内部精确依赖均已核实                                                                                                        |
| API/Web manifest          | `v0.1.1` 与 `latest` 指向相同的各自 digest，均包含 `linux/amd64`、`linux/arm64`                                                                                            |
| amd64 最终 GHCR 镜像运行  | 发布版 Compose 启动、健康、初始化、登录/受保护 API、Web 代理、SPA、配置 API 写入与重启持久化通过                                                                           |
| arm64                     | 构建、推送与 manifest 已验证；环境没有 ARM 运行器，未做应用运行验证                                                                                                        |
| 真实用户上游              | 本次使用隔离占位配置；你的真实 MCP 上游仍需按实际连接与工具调用验证                                                                                                        |

镜像 index digest（可替代版本 tag 固定到不可变内容）：

- API：`sha256:134dd4bdb6d0d345f731849cb1082ae15ef9b4d2a14d83bea2f236e320b653cd`
- Web：`sha256:9fffe255867964736c112c75a79d94fa6aefa34a278a7f09606bb56c8e3883a4`

#### 1. 初始化配置目录

在专用部署目录放置 `docker-compose.release.yml`，可使用仓库中对应 `v0.1.1` 的文件。
部署只需 Docker/Compose，不需要本地安装 Node/pnpm 或构建镜像。

```bash
# 首次创建；已有目录保留原文件，不覆盖用户配置
mkdir -p config
```

在 `config/` 中创建以下配置。所有占位密码、JWT secret 与 URL 均需由维护者填写；
本说明不提供真实凭据。已有配置只做必要修改，不把初始化模板覆盖到现有数据上。

`mcp_server.json`：先保留一个禁用定义，可在无外部进程/网络依赖时启动管理界面。
校验要求至少有一个服务器定义，`servers: {}` 会被拒绝。

```json
{
  "servers": {
    "placeholder": {
      "type": "stdio",
      "command": "node",
      "args": [],
      "env": {},
      "enabled": false
    }
  }
}
```

`group.json`：首次尚未连接真实上游时为空；配置上游后再添加组。

```json
{}
```

`system.json`：使用下方 [完整初始化模板](#systemjson-完整初始化模板)，填写自己的管理员
密码及 JWT secret。自定义对象必须满足整个 `SystemConfigSchema`，不能只写 `server.port`
或只写 `auth.jwt.secret`。临时 `{}` 会启用代码中的 `admin/admin` 与默认 JWT secret，
只适用于本机初始化/隔离测试；对外上线前必须替换。

可选 `api-tools.json`：没有 REST API 工具时，可使用有效的空工具配置。

```json
{
  "version": "1.0.0",
  "tools": []
}
```

API 以 `node` 用户（UID/GID **1000**）运行，Compose 固定 `CONFIG_PATH=/app/config`。
`${MCP_KNOT_CONFIG_DIR:-./config}` 可读写挂载到 `/app/config`，配置编辑、历史与备份均
保存在宿主目录。Linux 上可对这个专用目录执行下列命令；这是部署说明，本次文档更新不执行它们：

```bash
sudo chown -R 1000:1000 ./config
sudo chmod -R u+rwX,go-rwx ./config
```

只读卷会限制首次创建、Web 编辑与备份。默认日志输出到 stdout，用 Compose logs 查看。

#### 2. 首次仅绑定 localhost，拉取固定版本并启动

仓库的 release Compose 默认发布 8180/8181 到所有接口。首次初始化保留原文件，
新增以下 `docker-compose.localhost.yml`，将这两个宿主端口绑定到 `127.0.0.1`：

```yaml
services:
  mcp-knot-api:
    ports: !override
      - '127.0.0.1:8181:8181'
  mcp-knot-web:
    ports: !override
      - '127.0.0.1:8180:80'
```

此合并示例需要 Docker Compose **2.24.4+** 的 `!override`，它会替换原端口列表，
避免普通列表合并把原来的全接口端口一起保留。较旧版本可复制 release Compose 到本地文件，
直接把两个 `ports` 字符串改为上述 localhost 映射；不要同时保留原映射。
参见 [Compose 合并规则](https://docs.docker.com/reference/compose-file/merge/#replace-value)。

专用部署目录的 `.env` 只记录以下非敏感 Compose 参数：

```dotenv
MCP_KNOT_VERSION=v0.1.1
MCP_KNOT_CONFIG_DIR=./config
```

`MCP_KNOT_VERSION` 必填，包含完整 `v` 前缀，不隐式使用 `latest`。
配置目录变量可省略（默认 `./config`），使用自定义路径时确保目录已存在且 UID 1000 可读写。
只有组 `validation.enabled=true` 时才需向 Compose 提供至少 32 字符的
`VALIDATION_KEY_SECRET`；它不替代 `system.json` 的 JWT secret。

```bash
docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml config --quiet
docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml pull
docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml up -d --no-build --wait --wait-timeout 120
docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml ps
curl -f http://127.0.0.1:8180/
curl -f http://127.0.0.1:8180/api/ping
curl -f http://127.0.0.1:8180/api/health
```

两镜像分别是 `ghcr.io/yourtion/mcp-knot-api:v0.1.1` 与
`ghcr.io/yourtion/mcp-knot-web:v0.1.1`。从 `http://127.0.0.1:8180` 登录，完整模板使用你设置的
管理员密码；只有临时空 `system.json` 才使用 `admin/admin`。
API 直连端口是 8181；Web 经内部网络代理到 API。对外访问前完成身份和组访问控制配置，
通过 HTTPS 反向代理提供 Web/MCP 入口，API 8181 保持本机或内网可达。

Dockerfile 健康探针是 API `/api/ping` 和 Web `/`，Web 等待 API `service_healthy`。
根路径 `/health` 不存在。详细 `/api/health` 查看 `data.service.isInitialized` 与上游连接；
没有已连接上游时可能显示 `degraded`，HTTP 存活通过不证明真实上游可用。

##### 配置真实上游与组

准备好你的 MCP 服务后，把禁用占位定义替换为真实定义。例如 `mcp_server.json`：

```json
{
  "servers": {
    "upstream": {
      "type": "streaming",
      "url": "https://mcp.example.com/mcp",
      "headers": {},
      "enabled": true
    }
  }
}
```

对应 `group.json`：

```json
{
  "default": {
    "id": "default",
    "name": "默认组",
    "servers": ["upstream"],
    "tools": [],
    "validation": { "enabled": false }
  }
}
```

此示例仅用于 localhost 上的真实上游连通检查。对外开放前需启用组授权：先提供已有的
`VALIDATION_KEY_SECRET` 并重启 API，再通过 Web 组管理或获准的
`POST /api/groups/default/validation-key` 设置自己的组 key。该接口加密保存 key；
不要把客户端明文 key 直接填进 `group.json` 的 `validation.validationKey`，校验代码
期望此处存储加密值。客户端使用对应的明文 `Authorization: Bearer <组 key>`。
组入口为 `/default/mcp`；Web 管理登录与 MCP 组授权是两套配置。
真实 URL/认证在使用前按上游提供方设置，
示例不会连接任何外部服务。stdio 上游须确保命令和资源路径在 API 容器内存在；
仓库默认示例使用的 `uvx` 未预装，不能把宿主机命令可用当成容器内可用。

##### 重启、持久化与升级

保存配置后保留同一宿主目录，重新启动 API 使启动配置和缓存的身份配置生效：

```bash
docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml restart mcp-knot-api
docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml up -d --no-build --wait --wait-timeout 120
curl -f http://127.0.0.1:8180/api/health
```

可先在 Web/API 编辑一个非敏感配置字段，确认宿主 `config/` 文件已更新，重启后再读取相同
字段。0.1.1 已实际完成配置 API 写入、宿主文件检查及重启后的 API 回读。
不要删除 `config/`；它同时保存配置历史/备份。改权限前确认路径是本项目专用目录。

升级或回滚时，将 `.env` 的 `MCP_KNOT_VERSION` 改成实际已发布的完整 tag，保留原配置及
localhost 覆盖文件，再执行上述 `pull`、`up --no-build --wait` 和健康检查。
两个服务应使用同一版本；需要精确固定内容时分别用上面的 API/Web index digest 替换
各自的 image tag。`scripts/deploy.sh --release` 使用原 release Compose，首次 localhost
初始化请沿用这里带覆盖文件的命令。

#### 3. 从源码构建

```bash
docker compose -f docker-compose.yml up -d --build --wait --wait-timeout 120
# 或 bash scripts/deploy.sh --config ./config
```

本地独立镜像验证（不会发布镜像）：

```bash
bash scripts/docker-build.sh --tag local
bash scripts/docker-smoke.sh ghcr.io/yourtion/mcp-knot-api:local ghcr.io/yourtion/mcp-knot-web:local
```

Smoke 使用临时禁用的本地上游配置、独立 Docker 网络及容器，结束后清理；检查 Dockerfile 探针、
API 初始化、Nginx `/api/` 代理、SPA 路由回退以及 `/app/config` 的写权限。
这不验证你的真实上游连接、生产账号或 GHCR 发布权限。

#### 4. 开发环境

```bash
docker compose -f docker-compose.dev.yml up -d --build
# 或 bash scripts/deploy.sh --dev --config ./config
```

开发 API 首先编译 share/protocol/core，再启动热重载；前端使用已有的 `base` 构建阶段，
API 代理通过 `MCP_KNOT_DEV_API_URL=http://mcp-knot-api-dev:8181` 指向开发 API 容器。
容器内的匿名 node_modules 卷避免宿主依赖覆盖 Alpine 镜像安装的依赖。

### 方式 2：传统部署（PM2）

#### 1. 安装依赖

```bash
# Node.js 20.x、pnpm、PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm pm2
```

#### 2. 克隆、安装、构建

```bash
git clone https://github.com/your-org/mcp-knot.git
cd mcp-knot
pnpm install --frozen-lockfile
pnpm build:production
```

#### 3. 准备配置文件

配置文件读取规则：`getConfigDir()` 返回 `process.env.CONFIG_PATH || <cwd>/config`。因此有两种放法：

- **从仓库根启动**：配置放在 `./config/`
  ```bash
  mkdir -p config
  cp backend/config/*.json.example config/
  (cd config && for f in *.json.example; do mv "$f" "${f%.example}"; done)
  pnpm start:api   # 读 ./config
  ```
- **集中存放**（如 `/etc/mcp-knot/config`）：用 `CONFIG_PATH` 指定
  ```bash
  sudo mkdir -p /etc/mcp-knot/config
  sudo cp backend/config/*.json.example /etc/mcp-knot/config/
  (cd /etc/mcp-knot/config && sudo sh -c 'for f in *.json.example; do mv "$f" "${f%.example}"; done')
  export CONFIG_PATH=/etc/mcp-knot/config
  ```

> 不要直接写 `backend/config/*.json` 作为生产配置路径，除非你确实从 `backend/` 目录启动进程。从仓库根 `pnpm start:api` 时实际读的是 `./config/`。

#### 4. 用 PM2 启动

```bash
# 方式 A：从仓库根启动（读 ./config）
pm2 start backend/dist/index.js --name mcp-knot-api --cwd .

# 方式 B：用 CONFIG_PATH 指定配置目录
CONFIG_PATH=/etc/mcp-knot/config pm2 start backend/dist/index.js --name mcp-knot-api

pm2 save
pm2 startup
```

> `--cwd` 决定 `process.cwd()`，进而决定默认配置目录。务必让 `cwd` 与配置目录位置一致，或显式设置 `CONFIG_PATH`。

---

## 配置管理

配置目录下有 4 个 JSON 文件（示例文件后缀为 `.json.example`，**不是** `.json.default`）：

| 文件              | 作用                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `mcp_server.json` | MCP 服务器定义（stdio/streaming 类型、命令、参数、env、enabled） |
| `group.json`      | MCP 服务器分组                                                   |
| `system.json`     | 系统配置（端口、CORS、日志、监控、限流等）                       |
| `api-tools.json`  | API 工具配置路径                                                 |

### system.json 完整初始化模板

下面的对象包含当前 `SystemConfigSchema` 的全部必需字段。部署前替换两个明显的占位值，
不要把模板 secret/密码或 `admin/admin` 当作上线凭据。容器内端口保持 8181，改宿主端口
只改 Compose 映射；否则还需同步 Nginx 上游与 Dockerfile 探针。

```json
{
  "server": { "port": 8181, "host": "0.0.0.0" },
  "auth": {
    "jwt": {
      "secret": "REPLACE_WITH_A_PRIVATE_SECRET_AT_LEAST_32_CHARACTERS",
      "expiresIn": "24h",
      "refreshExpiresIn": "7d",
      "issuer": "mcp-knot"
    },
    "security": {
      "maxLoginAttempts": 5,
      "lockoutDuration": 900000,
      "passwordMinLength": 12,
      "requireStrongPassword": true
    }
  },
  "users": {
    "admin": {
      "id": "admin",
      "username": "admin",
      "password": "REPLACE_WITH_YOUR_ADMIN_PASSWORD",
      "role": "admin",
      "groups": [],
      "createdAt": "2026-10-12T00:00:00.000Z"
    }
  },
  "ui": {
    "title": "MCP Knot",
    "theme": "light",
    "features": { "apiToMcp": true, "debugging": false, "monitoring": true }
  },
  "monitoring": { "metricsEnabled": true, "logLevel": "info", "retentionDays": 30 }
}
```

`users` 是根字段，不是 `auth.users`。按当前 `AuthService` 实现，`users.admin.password`
读取密码本身，并在内存中计算 bcrypt 哈希；这里不要填写预计算的 bcrypt 哈希。
因此 `system.json` 及历史/备份目录均按含敏感配置处理，只允许部署用户和容器 UID 1000 访问，
不提交到 Git、不写入镜像，也不在日志或排障报告里打印。用户密码与 JWT secret 更改后重启 API。

`server`、`auth`、`users`、`ui`、`monitoring` 均为必需块；`oauth`、`compatibility` 等扩展按
实际需要参照 [完整 schema](../packages/share/src/config/schemas/system.schema.ts)。
默认的 `system.json.example={}` 触发内置默认值，不能代替上线配置。

---

## 环境变量

### 代码实际识别的变量

| 变量          | 作用         | 说明                                                            |
| ------------- | ------------ | --------------------------------------------------------------- |
| `CONFIG_PATH` | 配置文件目录 | 覆盖默认的 `<cwd>/config`。**这是唯一被代码识别的配置目录变量** |
| `NODE_ENV`    | 运行环境     | 设为 `production`                                               |

### 代码**不**识别的变量

以下变量出现在 `.env.production.example` 或旧文档中，但**代码并不读取**，设置它们无效：

- `PORT`、`HOST`：端口由 `system.json` 的 `server.port` 控制；host 由 `server.host` 控制。
- `CONFIG_DIR`、`MCP_SERVER_CONFIG`、`GROUP_CONFIG`、`SYSTEM_CONFIG`：配置目录请用 `CONFIG_PATH`。
- `JWT_SECRET`、`JWT_EXPIRES_IN` 等：JWT 密钥与有效期在 `system.json` 的 `auth` 段配置，不是环境变量。
- `CORS_ORIGIN`、`RATE_LIMIT_*`、`MONITORING_ENABLED` 等：均在 `system.json` 中配置。

> `.env.production.example` 中大部分变量仅作参考占位，实际生效需写入对应 JSON 配置。请以 `system.json` 为准。

---

## 安全加固

### 1. 修改默认密码

对外开放前在完整 `system.json` 中设置自己的管理员强密码（≥12 位，含大小写、数字、特殊字符）
及至少 32 字符的私有 JWT secret，然后重启 API。初次使用默认值时仅绑定 localhost。

### 2. HTTPS

使用 Let's Encrypt：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d mcp-knot.example.com
sudo certbot renew --dry-run
```

### 3. 防火墙

只暴露前端端口（或 80/443），后端 8181 仅内网可达：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 8180/tcp   # 或 80/443
sudo ufw enable
```

### 4. 安全头部

在前置 Nginx 中添加（见下一节示例）：

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

---

## 反向代理（Nginx）

如需用前置 Nginx 统一入口（前端 + API），可参考以下最小配置 `/etc/nginx/sites-available/mcp-knot`：

```nginx
upstream mcp_knot_backend {
    server 127.0.0.1:8181;
}

server {
    listen 443 ssl http2;
    server_name mcp-knot.example.com;

    ssl_certificate     /etc/ssl/certs/mcp-knot.crt;
    ssl_certificate_key /etc/ssl/private/mcp-knot.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 前端静态文件（如自行托管 dist）
    location / {
        root /var/www/mcp-knot/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # API
    location /api/ {
        proxy_pass http://mcp_knot_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 组级 Streamable HTTP MCP；保留原 URI，不使用旧全局 /mcp 或 WebSocket 升级
    location ~ ^/[^/]+/mcp$ {
        proxy_pass http://mcp_knot_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
    }

    # SSE：禁用缓冲
    location /api/events {
        proxy_pass http://mcp_knot_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
    }
}

server {
    listen 80;
    server_name mcp-knot.example.com;
    return 301 https://$server_name$request_uri;
}
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/mcp-knot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 监控、日志与备份

### PM2 监控（传统部署）

```bash
pm2 status
pm2 logs mcp-knot-api
pm2 monit
```

### 健康检查

后端存活检查为 `/api/ping`，详细服务状态为 `/api/health`（端口 8181）：

```bash
curl -f http://localhost:8181/api/ping
```

也可用仓库脚本（见下节）。

### 日志轮转

`/etc/logrotate.d/mcp-knot`：

```
/var/log/mcp-knot/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640
    sharedscripts
    postrotate
        pm2 reloadLogs >/dev/null 2>&1
    endscript
}
```

### 配置备份

定期打包 `config/` 目录：

```bash
tar -czf /backup/mcp-knot/config_$(date +%Y%m%d_%H%M%S).tar.gz \
    "${CONFIG_PATH:-./config}"
# 保留最近 30 天
find /backup/mcp-knot -name "config_*.tar.gz" -mtime +30 -delete
```

加到 crontab：`0 2 * * * /path/to/backup.sh`

---

## 运维脚本

`scripts/` 目录下的脚本（均从仓库根运行）：

| 脚本                           | 作用                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `scripts/deploy-production.sh` | 生产环境一键部署（含备份/测试/构建/PM2 重启），支持 `--skip-backup`、`--skip-tests`、`--skip-build`、`--force` |
| `scripts/deploy.sh`            | Docker Compose 部署入口，支持 `--dev`、`--release vX.Y.Z`、`--config DIR`                                      |
| `scripts/docker-build.sh`      | 构建 GHCR 命名的本地 API/前端镜像，支持 `--tag`、`--platform`；正式发布走 tag CI                               |
| `scripts/build.sh`             | 本地构建（依赖/检查/测试/构建全部包）                                                                          |
| `scripts/health-check.sh`      | 综合健康检查（PM2 进程、HTTP 端点、内存/CPU/磁盘、日志、配置文件），支持 `--verbose`、`--json`                 |
| `scripts/restore-backup.sh`    | 从备份恢复配置，用法 `./scripts/restore-backup.sh <backup_file>`                                               |

示例：

```bash
# 健康检查（JSON 输出便于接入告警）
./scripts/health-check.sh --json

# 恢复配置
./scripts/restore-backup.sh /backup/mcp-knot/config_20260101_020000.tar.gz
```

> 注意：部分脚本（`deploy-production.sh`、`health-check.sh`、`restore-backup.sh`）仍使用 `/etc/mcp-knot/config` 等固定路径。HTTP 探针已统一为默认端口 `8181/api/ping`；自定义 `system.json` 端口或配置目录时，还需按实际部署修改这些脚本的路径和检查地址。

---

## 故障排除

### 服务无法启动

```bash
pm2 logs mcp-knot-api --lines 100   # 传统部署
docker compose logs mcp-knot-api    # Docker 部署
```

常见原因：端口被占用、配置文件 JSON 格式错误、配置目录路径不对。

### 配置目录路径不对

代码读 `process.env.CONFIG_PATH || <cwd>/config`。排查：

```bash
# 确认 cwd 和 CONFIG_PATH
pm2 describe mcp-knot-api | grep -E "cwd|script path"
echo "$CONFIG_PATH"
ls -la "${CONFIG_PATH:-./config}"
```

确保 4 个 JSON 文件都在该目录下。

### 端口被占用

```bash
# 查 8181 占用
ss -lntp | grep 8181
```

改端口请编辑 `system.json` 的 `server.port`，**不要**用 `PORT=xxx`（代码不读）。

### 从备份恢复

```bash
./scripts/restore-backup.sh /backup/mcp-knot/config_latest.tar.gz
```

### 重置为示例配置

```bash
# 注意后缀是 .json.example，不是 .json.default
cp backend/config/*.json.example "${CONFIG_PATH:-./config}/"
(cd "${CONFIG_PATH:-./config}" && for f in *.json.example; do mv "$f" "${f%.example}"; done)
pm2 restart mcp-knot-api
```

---

## 相关文档

- [Web 界面使用指南](WEB_UI_GUIDE.md)
- [API 参考文档](API_REFERENCE.md)
- [故障排除指南](TROUBLESHOOTING.md)
- [开发指南](../README.md)
