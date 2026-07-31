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
                                   │ 反向代理 /api、/mcp、/sse
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

1. **mcp-knot-web**：Nginx 托管构建后的 Vue 前端，并将 API/MCP/SSE 请求代理到后端。
2. **mcp-knot-api**：Node.js 应用，承载所有业务逻辑和 MCP 服务。
3. **配置文件**：4 个 JSON 文件，见 [配置管理](#配置管理)。

## 端口与服务

| 服务 | 容器名 | 内部端口 | 主机映射端口 | 说明 |
| --- | --- | --- | --- | --- |
| 前端 | `mcp-knot-web` | 80 | **8180** | Nginx |
| 后端 | `mcp-knot-api` | 8181 | **8181** | Node.js |

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

仓库已提供 `docker-compose.yml`，定义了 `mcp-knot-web`（8180）和 `mcp-knot-api`（8181）两个服务。

#### 1. 准备配置文件

```bash
# 在仓库根目录
mkdir -p config
cp backend/config/*.json.example config/
# 重命名为实际配置文件
cd config
for f in *.json.example; do mv "$f" "${f%.example}"; done
cd ..
```

四个必需文件：`mcp_server.json`、`group.json`、`system.json`、`api-tools.json`。

#### 2. 构建并启动

```bash
# 构建镜像（或用 scripts/docker-build.sh）
docker compose build

# 启动
docker compose up -d

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f
```

启动后：

- 前端：<http://localhost:8180>
- 后端 API：<http://localhost:8181>
- 健康检查：<http://localhost:8181/health>

> 仓库内的 `docker-compose.yml` 把宿主机 `./backend/config` 只读挂载到容器内。如果按上一步把配置放在仓库根的 `./config`，请把 compose 里的卷挂载改为 `./config:/app/backend/config:ro`，或设置 `CONFIG_PATH` 指向容器内对应目录。

#### 3. 开发环境

开发模式使用 `docker-compose.dev.yml`（服务名带 `-dev` 后缀，源码热重载）：

```bash
docker compose -f docker-compose.dev.yml up -d
```

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
pm2 start backend/dist/src/index.js --name mcp-knot-api --cwd .

# 方式 B：用 CONFIG_PATH 指定配置目录
CONFIG_PATH=/etc/mcp-knot/config pm2 start backend/dist/src/index.js --name mcp-knot-api

pm2 save
pm2 startup
```

> `--cwd` 决定 `process.cwd()`，进而决定默认配置目录。务必让 `cwd` 与配置目录位置一致，或显式设置 `CONFIG_PATH`。

---

## 配置管理

配置目录下有 4 个 JSON 文件（示例文件后缀为 `.json.example`，**不是** `.json.default`）：

| 文件 | 作用 |
| --- | --- |
| `mcp_server.json` | MCP 服务器定义（stdio/streaming 类型、命令、参数、env、enabled） |
| `group.json` | MCP 服务器分组 |
| `system.json` | 系统配置（端口、CORS、日志、监控、限流等） |
| `api-tools.json` | API 工具配置路径 |

### system.json 示例

端口由 `server.port` 控制（默认 8181）：

```json
{
  "server": {
    "port": 8181,
    "host": "0.0.0.0",
    "cors": {
      "origin": ["https://mcp-knot.example.com"],
      "credentials": true
    }
  },
  "logging": {
    "level": "info",
    "file": "/var/log/mcp-knot/app.log",
    "maxFiles": 10,
    "maxSize": "10m"
  },
  "monitoring": {
    "enabled": true,
    "metricsInterval": 60000,
    "healthCheckInterval": 30000
  },
  "rateLimit": {
    "windowMs": 60000,
    "maxRequests": 100
  }
}
```

### 默认凭据（重要）

开发默认登录凭据为 **admin / admin**。生产部署**必须**立即通过 Web 界面修改密码，否则存在严重安全风险。

---

## 环境变量

### 代码实际识别的变量

| 变量 | 作用 | 说明 |
| --- | --- | --- |
| `CONFIG_PATH` | 配置文件目录 | 覆盖默认的 `<cwd>/config`。**这是唯一被代码识别的配置目录变量** |
| `NODE_ENV` | 运行环境 | 设为 `production` |

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

部署后第一时间登录 Web 界面，把 `admin/admin` 改为强密码（≥12 位，含大小写、数字、特殊字符）。

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

    # MCP 端点（WebSocket 升级）
    location /mcp/ {
        proxy_pass http://mcp_knot_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
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

后端提供 `/health` 端点（端口 8181）：

```bash
curl -f http://localhost:8181/health
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

| 脚本 | 作用 |
| --- | --- |
| `scripts/deploy-production.sh` | 生产环境一键部署（含备份/测试/构建/PM2 重启），支持 `--skip-backup`、`--skip-tests`、`--skip-build`、`--force` |
| `scripts/deploy.sh` | Docker Compose 部署入口，支持 `--dev`、`--config DIR` |
| `scripts/docker-build.sh` | 构建 API/前端镜像，支持 `--tag`、`--push`、`--platform` |
| `scripts/build.sh` | 本地构建（依赖/检查/测试/构建全部包） |
| `scripts/health-check.sh` | 综合健康检查（PM2 进程、HTTP 端点、内存/CPU/磁盘、日志、配置文件），支持 `--verbose`、`--json` |
| `scripts/restore-backup.sh` | 从备份恢复配置，用法 `./scripts/restore-backup.sh <backup_file>` |

示例：

```bash
# 健康检查（JSON 输出便于接入告警）
./scripts/health-check.sh --json

# 恢复配置
./scripts/restore-backup.sh /backup/mcp-knot/config_20260101_020000.tar.gz
```

> 注意：部分脚本（`deploy-production.sh`、`health-check.sh`、`restore-backup.sh`）默认检查 `/etc/mcp-knot/config` 和健康端口 3000，与代码默认值（`<cwd>/config`、端口 8181）不完全一致。使用这些脚本前请根据实际部署路径和端口调整，或在脚本中设置 `CONFIG_PATH`。

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
