# 故障排除与常见问题

> 本文档合并了原 FAQ 与故障排除指南，帮助你诊断和解决 MCP Knot 使用过程中的常见问题。所有示例端口、路径与端点均与当前代码一致。

## 目录

- [快速诊断](#快速诊断)
- [常见问题](#常见问题)
  - [安装与启动](#安装与启动)
  - [认证与登录](#认证与登录)
  - [MCP 服务器连接](#mcp-服务器连接)
  - [工具使用](#工具使用)
  - [组管理](#组管理)
  - [API 到 MCP](#api-到-mcp)
  - [配置文件](#配置文件)
  - [性能](#性能)
  - [Docker 与部署](#docker-与部署)
  - [安全](#安全)
- [错误代码与端点参考](#错误代码与端点参考)
- [获取帮助](#获取帮助)

---

## 快速诊断

### 健康检查

```bash
# 后端健康检查（默认端口 8181）
curl http://localhost:8181/api/ping

# 各组状态
curl http://localhost:8181/api/groups

# 仪表板系统信息（需登录态）
curl http://localhost:8181/api/dashboard/system-info
curl http://localhost:8181/api/dashboard/memory
```

> 注意：系统信息位于 `/api/dashboard/*` 路由组下（`system-info`、`memory`、`stats`、`performance` 等）。**不存在** `/api/system/metrics` 或 `/api/system/info`。

### 查看日志

项目使用统一的 Logger 输出到 **stdout**，没有固定的 `logs/mcp-knot.log` 文件，也没有 `pnpm --filter ... logs` 这类命令。

```bash
# 直接启动时：日志直接打印到终端
pnpm start:api

# Docker 环境
docker-compose logs -f mcp-knot-api

# PM2 托管时
pm2 logs mcp-knot-api --lines 100
```

---

## 常见问题

### 安装与启动

#### 支持哪些 Node.js 版本？

最低 **Node.js 20**（`package.json` 的 `engines.node` 为 `">=20"`，Docker 镜像基于 `node:20-alpine`）。低于 20 会启动失败。

```bash
node --version     # 检查版本
nvm install 20 && nvm use 20   # 用 nvm 升级
```

#### 推荐使用 pnpm 而不是 npm

MCP Knot 是 monorepo，推荐 pnpm：

```bash
npm install -g pnpm
pnpm install
```

#### 安装依赖时出现权限错误

不要使用 `sudo`。配置 npm 全局目录到用户路径：

```bash
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
# 在 ~/.bashrc 或 ~/.zshrc 中加入：export PATH=~/.npm-global/bin:$PATH
source ~/.zshrc
```

#### Windows 上如何运行？

推荐 WSL2 + Ubuntu，按 Linux 步骤安装 Node.js 与 pnpm。原生 Windows 下部分 MCP 服务器可能不兼容。

#### API 服务器无法启动（端口被占用）

**症状**：`Error: listen EADDRINUSE: address already in use :::8181`

```bash
# 检查占用 8181 端口的进程
lsof -i :8181
kill -9 <PID>            # 杀死占用进程
```

要改端口，**不要用 `export PORT=xxxx`**——代码不读取 `process.env.PORT`。请在 `config/system.json` 中设置 `server.port`：

```json
{
  "server": { "port": 8281, "host": "0.0.0.0" }
}
```

前端开发服务器默认 **8180**（与后端 8181 区分，旧文档中的 3000/3001 是错误的）。

#### 依赖包缺失

**症状**：`Cannot find module '@mcp-core/mcp-knot-core'`

```bash
pnpm install
pnpm build
```

#### 前端无法连接到后端

1. 确认后端在运行：`curl http://localhost:8181/api/ping`
2. 检查 `system.json` 中的 CORS 配置
3. 检查前端的 API 代理与反向代理（Nginx 等）配置
4. 确认防火墙未拦截 8181 端口

### 认证与登录

#### 默认登录凭据

- 用户名：`admin`
- 密码：`admin`

> 默认凭据仅适用于开发环境。其来源是 `backend/src/services/auth.ts` 中的硬编码 `defaultSystemConfig`——当 `config/system.json` 为空 `{}`（仓库默认状态）时回退到这套硬编码配置，密码哈希**仅在内存中生成、不落盘**。生产环境必须自定义。

#### 如何更改管理员密码

由于默认走硬编码回退，要自定义密码必须在 `config/system.json` 中写完整的 `users` 块（schema 见 `packages/share/src/config/schemas/system.schema.ts`）。密码字段以明文写入，后端启动时会在内存中生成 bcrypt 哈希，**不会自动写回文件**。

示例 `config/system.json`（节选，实际需补齐 schema 要求的其它字段如 `server`、`auth` 等）：

```json
{
  "server": { "port": 8181, "host": "0.0.0.0" },
  "auth": {
    "jwt": {
      "secret": "请替换为至少 32 字符的强随机字符串",
      "expiresIn": "24h",
      "refreshExpiresIn": "7d",
      "issuer": "mcp-knot"
    },
    "security": {
      "maxLoginAttempts": 5,
      "lockoutDuration": 900000,
      "passwordMinLength": 6,
      "requireStrongPassword": false
    }
  },
  "users": {
    "admin": {
      "id": "admin",
      "username": "admin",
      "password": "your-new-password",
      "role": "admin",
      "groups": ["default"],
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  }
}
```

写完后重启后端使配置生效。

#### 忘记密码

直接编辑 `config/system.json`：删除 `users` 块（让其回退到默认 `admin/admin`），或修改 `users.admin.password` 字段，然后重启服务，用新密码登录。

#### 一直提示"令牌已过期"

1. **系统时间不准确**：JWT 依赖准确时间，校准系统时钟。
2. **JWT 密钥不一致**：确保使用同一份 `system.json`（`auth.jwt.secret`）。
3. **过期时间太短**：在 `system.json` 中调大 `auth.jwt.expiresIn`。

#### 支持多用户吗？

当前默认配置仅含单管理员账户。可在 `system.json` 的 `users` 块中声明多个用户，或借助组（group）级别的验证密钥与反向代理实现访问控制。

### MCP 服务器连接

#### 支持哪些类型的服务器

1. **stdio**：标准输入/输出（最常见）
2. **SSE**：Server-Sent Events
3. **WebSocket**：计划支持

#### 连接失败

1. **手动验证命令**：
   ```bash
   npx -y @modelcontextprotocol/server-filesystem /path/to/dir
   ```
2. **检查环境变量**：所需 API Key 是否配置、格式是否正确。
3. **检查路径权限**：
   ```bash
   ls -la /path/to/server
   chmod +x /path/to/server
   ```
4. **查看后端日志**（见[快速诊断](#快速诊断)）。

#### 连接后立即断开

可能原因：上游服务器进程崩溃、MCP 握手失败、连接超时过短、系统资源不足。用 MCP Inspector 调试，或在 `mcp_server.json` 中调大 `timeout`。

#### 服务器超时

**症状**：`Error: MCP server timeout after 30000ms`

在 `config/mcp_server.json` 中增大该服务器的 `timeout`：

```json
{
  "servers": {
    "slow-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slow"],
      "timeout": 60000
    }
  }
}
```

#### 更新/删除服务器的影响

- 更新配置会断开现有连接并重连。
- 删除服务器会：断开连接、从所有组移除、使其工具不可用、且不可恢复。建议删除前先禁用。

### 工具使用

#### 工具未找到

检查：服务器是否已连接、工具名是否正确（区分大小写）、若在组内调用确认工具在组的允许列表中、必要时重连服务器刷新工具列表。

#### 工具执行超时

在服务器配置中增大 `timeout`，或减少一次处理的数据量，确保上游服务器资源充足。

#### 参数如何填写

参考工具的 `inputSchema`：必填项必须提供、类型需匹配（string/number/boolean 等）、遵循描述中的格式要求。

### 组管理

#### 什么是组

组是服务器的逻辑集合，用于：组织服务器、做工具级访问控制、提供独立 MCP 端点、基于验证密钥控制访问。一个服务器可属于多个组。

#### 组的 MCP 端点

每个组有唯一入口：

```
POST http://your-domain:8181/:groupId/mcp
```

例如：`development` 组 → `http://localhost:8181/development/mcp`

> 这是**唯一**的 MCP 入口（JSON-RPC over HTTP，带 `Mcp-Method` 头）。**不存在** `/mcp/list_tools`、`/:group/mcp/list_tools`、`/mcp/call_tool`、`/:group/mcp/call_tool`，全局 `/mcp` 也已移除。

#### 组路由返回 404

**症状**：访问 `/:groupId/mcp` 得到 404

1. 检查 `config/group.json` 中该组是否存在且 `enabled: true`：
   ```bash
   curl http://localhost:8181/api/groups/<groupId>
   ```
2. 检查组内服务器是否都已连接。
3. 修改后需重启或等待配置热加载。

#### 工具不在允许列表

**症状**：`Tool 'write_file' not allowed in group 'development'`

在组配置中把工具加入允许列表，或用 `["*"]` 放开（生产环境慎用）：

```json
{
  "groups": {
    "development": { "allowedTools": ["read_file", "write_file"] }
  }
}
```

#### 组管理 API 的约定

- 路径参数名为 `:groupId`，例如 `GET /api/groups/:groupId`。
- **更新组用 `PUT`**（不是 `PATCH`）：`PUT /api/groups/:groupId`。
- 删除组：`DELETE /api/groups/:groupId`。

#### 验证密钥如何工作

为组设置验证密钥后，客户端访问该组端点需在请求头携带：

```bash
curl -X POST http://localhost:8181/development/mcp \
  -H "X-Validation-Key: your-key" \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/file.txt"}}}'
```

密钥不匹配时请求被拒绝。

### API 到 MCP

#### 功能说明

将现有 REST API 转换为 MCP 工具，使其可通过 MCP 协议访问。生成的工具会自动加入系统，名称为配置中的 `toolName`。

#### 参数映射

```json
{
  "parameters": {
    "city": {
      "type": "string",
      "required": true,
      "mapping": { "target": "query", "name": "q" }
    }
  }
}
```

支持的 `target`：`query`、`path`、`body`、`header`。

#### 认证方式

支持 Bearer Token、API Key、Basic Auth。在 API 配置的 `auth` 块中声明。

#### 测试失败排查

确认：API URL 可达（curl/Postman 验证）、认证信息正确、参数名与类型匹配、Hub 所在网络可访问外部 API。

### 配置文件

#### 配置目录在哪里？

代码读取 `<cwd>/config/*.json`，具体由 `backend/src/utils/config.ts` 的 `getConfigDir()` 决定：

```ts
process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config');
```

- 从仓库根执行 `pnpm start:api` → 读取 `./config/`（不是 `backend/config/`）。
- 要读取 `backend/config/`，可设 `CONFIG_PATH=backend/config`，或从 `backend/` 目录启动。

#### 有哪些配置文件？

共 4 个：

| 文件              | 作用                     |
| ----------------- | ------------------------ |
| `mcp_server.json` | MCP 服务器定义           |
| `group.json`      | 组配置                   |
| `system.json`     | 系统、认证、用户、监控等 |
| `api-tools.json`  | API 到 MCP 工具配置      |

#### 配置文件未找到

**症状**：`Error: Configuration file not found: mcp_server.json`

确认配置目录下存在该文件；若使用 `CONFIG_PATH`，确认变量指向的目录正确。

#### 配置 JSON 格式错误

```bash
jq . config/mcp_server.json     # 用 jq 校验
```

常见错误：缺少/多余逗号、引号不匹配、括号不匹配。

### 性能

#### 响应慢

- 调低仪表板实时监控频率（`system.json` 的 `monitoring` 块）。
- 关闭不需要的服务器、调优连接池。
- 调高日志级别（减少 IO）。

#### 内存使用过高

```bash
NODE_OPTIONS="--max-old-space-size=4096" pnpm start:api
ps aux | grep mcp-knot            # 观察占用
```

必要时启用 Node.js 堆分析（`--inspect`、`--prof`）排查内存泄漏，或定期重启进程。

#### 提高并发

PM2 集群模式：`pm2 start dist/index.js -i max`；或在 Nginx 层做负载均衡部署多实例。

### Docker 与部署

#### 容器无法启动

```bash
docker logs mcp-knot-api
docker ps -a
docker exec -it mcp-knot-api /bin/sh
```

常见原因：挂载的 `config/` 目录缺失或 JSON 格式错误、端口冲突、Node 版本低于 20。

#### 容器间网络连接问题

容器之间请用服务名而非 `localhost`。例如 compose 服务名为 `mcp-knot-api` 时，容器内访问后端应使用 `http://mcp-knot-api:8181`。

#### 推荐部署方式

1. **传统**：PM2 + Nginx（小型部署）
2. **Docker Compose**：容器化环境
3. **Kubernetes**：大规模、高可用

#### 零停机部署

PM2 集群模式 `pm2 reload mcp-knot-api` 滚动重启；或蓝绿部署、Kubernetes 滚动更新配合 `/api/ping` 存活检查。

#### 自动备份

定期打包 `config/` 目录即可（配置是 MCP Knot 的核心持久化数据）：

```bash
tar -czf config-backup-$(date +%Y%m%d).tar.gz config/
find . -name "config-backup-*.tar.gz" -mtime +30 -delete
```

配合 cron 定时执行。

### 安全

#### 基本最佳实践

1. 更改默认管理员密码（见[认证与登录](#认证与登录)）。
2. 启用 HTTPS、配置防火墙、仅开放必要端口。
3. 定期更新依赖、备份配置、检查日志。
4. 必要时启用 IP 白名单或 VPN。

#### 生成强 JWT 密钥

```bash
openssl rand -base64 64
# 或
node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"
```

写入 `system.json` 的 `auth.jwt.secret`（至少 32 字符）。

#### Nginx IP 白名单

```nginx
location /api/ {
    allow 192.168.1.0/24;
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://mcp_knot_backend;
}
```

#### 防暴力破解

`system.json` 的 `auth.security` 块支持 `maxLoginAttempts` 与 `lockoutDuration`；建议同时开启 `requireStrongPassword` 并设置合理的 `passwordMinLength`。

---

## 错误代码与端点参考

### 常见错误速查

| 错误                                 | 可能原因          | 处理                                                        |
| ------------------------------------ | ----------------- | ----------------------------------------------------------- |
| `EADDRINUSE :::8181`                 | 端口被占用        | `lsof -i :8181` 后清理，或改 `system.json` 的 `server.port` |
| `Cannot find module '@mcp-core/...'` | 依赖未装/未构建   | `pnpm install && pnpm build`                                |
| `Configuration file not found`       | 配置目录/文件缺失 | 检查 `CONFIG_PATH` 与 `config/` 目录                        |
| `MCP server timeout`                 | 上游超时          | 增大 `mcp_server.json` 的 `timeout`                         |
| `Tool 'x' not allowed in group`      | 组工具过滤        | 把工具加入组的 `allowedTools`                               |
| 404 on `/:groupId/mcp`               | 组不存在/未启用   | 检查 `group.json`，确认 `enabled`                           |
| `EACCES: permission denied`          | 文件权限          | `chmod`/`chown`，或调整容器运行用户                         |

### 关键端点

| 方法 | 路径                                   | 说明                                          |
| ---- | -------------------------------------- | --------------------------------------------- |
| GET  | `/api/ping`                            | HTTP 存活检查；服务状态见 `/api/health`       |
| POST | `/:groupId/mcp`                        | 唯一 MCP 入口（JSON-RPC，带 `Mcp-Method` 头） |
| GET  | `/api/groups` / `/api/groups/:groupId` | 组列表 / 组详情                               |
| PUT  | `/api/groups/:groupId`                 | 更新组（注意是 PUT）                          |
| GET  | `/api/dashboard/system-info`           | 系统信息（需登录）                            |
| GET  | `/api/dashboard/memory`                | 内存信息（需登录）                            |

> 已移除/不存在的端点：全局 `/mcp`、`/mcp/list_tools`、`/:group/mcp/list_tools`、`/mcp/call_tool`、`/:group/mcp/call_tool`、`/api/system/metrics`、`/api/system/info`。

---

## 获取帮助

提交 Issue 前请准备：

```bash
uname -a && node --version && pnpm --version
curl -s http://localhost:8181/api/ping
# 配置（脱敏，移除 env 与密码）
jq 'del(.servers[].env, .users)' config/mcp_server.json
```

- GitHub Issues：附带上述诊断信息与最小复现配置。
- 相关文档：[CLI 使用指南](CLI_USAGE.md)、[组路由指南](GROUP_ROUTING.md)、[API 参考](API_REFERENCE.md)、[Web 界面指南](WEB_UI_GUIDE.md)。
