# MCP Knot API 参考

本文档提供 MCP Knot API 的完整参考。所有端点均以代码实际挂载为准（`backend/src/app.ts`）。

## 基础信息

- **基础 URL**: `http://localhost:8181`
- **内容类型**: `application/json`（OAuth token 端点除外，使用 `application/x-www-form-urlencoded`）
- **字符编码**: UTF-8

## 路由总览

| 前缀 | 说明 | 认证 |
| --- | --- | --- |
| `/api/auth` | 认证（登录/登出/刷新/当前用户） | 部分需要 |
| `/api/config` | 系统配置管理（查询/更新/验证/历史/备份/恢复） | JWT |
| `/api/dashboard` | 仪表板（统计、系统信息、内存、日志、SSE 等） | JWT |
| `/api/debug` | 调试（MCP 协议消息、工具测试、性能/错误分析） | 无 |
| `/api/servers` | MCP 服务器 CRUD 与连接控制 | JWT |
| `/api/tools` | 工具查询与执行（基础） | JWT |
| `/api/tools-admin` | 工具管理（历史/监控/健康/性能/错误/统计） | JWT |
| `/api/groups` | 组管理（路径参数统一为 `:groupId`） | JWT |
| `/api/performance` | 全局性能监控 | 无 |
| `/api/api-to-mcp` | API 转 MCP 配置管理 | JWT |
| `/api/oauth` | 内置 OAuth AS（`/token`、`/jwks`） | 无 |
| `/.well-known/*` | OAuth Protected Resource / AS metadata | 无 |
| `/:group/mcp` | **组级 MCP JSON-RPC 入口（唯一）** | OAuth RS |
| `/:group/status`、`/:group/tools` | 组状态/工具（REST） | 组校验 |

> 说明：2026-07-28 协议升级后，全局 `/mcp` 端点已移除。所有 MCP 调用统一走组路由 `/:group/mcp`。

## 认证

MCP Knot 支持两种认证方式：

1. **JWT 认证**（Web UI 与管理 API）：`Authorization: Bearer <access-token>`
2. **验证密钥认证**（组级工具访问控制）：`X-Validation-Key: <key>`

MCP 端点（`/:group/mcp`）走 OAuth Resource Server 校验，详见 `/.well-known/oauth-protected-resource`。

## 认证 API

### 登录

```http
POST /api/auth/login
```

**请求体**:

```json
{ "username": "admin", "password": "password123" }
```

**响应**:

```json
{
  "success": true,
  "data": {
    "user": { "id": "admin", "username": "admin", "role": "admin" },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  },
  "timestamp": "2026-07-31T10:30:00Z"
}
```

### 刷新令牌

```http
POST /api/auth/refresh
```

**请求体**: `{ "refreshToken": "eyJ..." }`

**响应**: `{ "success": true, "data": { "accessToken": "...", "refreshToken": "..." } }`

### 登出

```http
POST /api/auth/logout
Authorization: Bearer <access-token>
```

### 获取当前用户

```http
GET /api/auth/me
Authorization: Bearer <access-token>
```

**响应**: 返回 `data.user`（含 `id`、`username`、`role`、`groups`、`createdAt`、`lastLogin`）。

## MCP 端点（JSON-RPC）

MCP 协议通过 `POST /:group/mcp` 暴露。这是唯一的 MCP 入口，**不存在** `/mcp/list_tools`、`/mcp/call_tool`、`/:group/mcp/list_tools` 等子路径端点。

请求通过 JSON-RPC 2.0 body 携带方法与参数，配合 `Mcp-Method` 头（方便代理/中间件路由）。

### 列出工具

```bash
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 调用工具

工具名使用命名空间 `<serverId>_<toolName>`。另有内置元工具 `group_status`、`list_group_tools`。

```bash
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{"name":"filesystem_read_file","arguments":{"path":"/workspace/README.md"}}
  }'
```

**响应**（JSON-RPC 结果）:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "# My Project\n\n..." }
    ],
    "isError": false
  }
}
```

### 组状态与工具（REST）

非 JSON-RPC 的便捷 REST 端点：

- `GET /:group/status` — 组状态信息
- `GET /:group/tools` — 组可用工具列表

路径参数为 `group`（组标识符），组不存在时返回 JSON-RPC 错误体（`code: -32602`，HTTP 404）。

## 组管理 API

路径参数统一为 `:groupId`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/groups` | 列出所有组 |
| POST | `/api/groups` | 创建组 |
| GET | `/api/groups/:groupId` | 组详情 |
| PUT | `/api/groups/:groupId` | 更新组（注意是 PUT，非 PATCH） |
| DELETE | `/api/groups/:groupId` | 删除组 |
| GET | `/api/groups/:groupId/health` | 组健康检查 |
| GET | `/api/groups/:groupId/tools` | 组已配置工具 |
| GET | `/api/groups/:groupId/available-tools` | 组可用工具（含过滤） |
| GET | `/api/groups/:groupId/servers` | 组的服务器列表 |
| POST | `/api/groups/:groupId/tools` | 配置组工具过滤 |
| POST | `/api/groups/:groupId/validate-tool-access` | 验证工具访问权限 |
| POST/GET/DELETE | `/api/groups/:groupId/validation-key` | 设置/查询/删除验证密钥 |
| POST | `/api/groups/:groupId/validate-key` | 验证密钥有效性 |
| POST | `/api/groups/:groupId/generate-validation-key` | 生成新验证密钥 |

> **不存在** `/api/groups/:groupId/stats`、`/api/groups/:groupId/logs`。组级统计/日志请用 `/api/performance`、`/api/dashboard/logs` 或 `/api/tools-admin/*`。

### 列出所有组

```http
GET /api/groups
```

**响应**:

```json
{
  "groups": [
    {
      "id": "development",
      "name": "开发工具组",
      "description": "软件开发相关工具",
      "enabled": true,
      "toolCount": 6,
      "serverCount": 3,
      "requireAuth": false
    }
  ],
  "total": 1
}
```

### 组详情

```http
GET /api/groups/:groupId
```

**响应**（含 `id`、`name`、`description`、`servers`、`allowedTools`、`enabled`、`requireAuth`、`stats`）。

### 创建/更新组

```http
POST /api/groups
PUT  /api/groups/:groupId
```

**请求体**（创建）:

```json
{
  "id": "research",
  "name": "研究工具组",
  "description": "信息收集和研究工具",
  "servers": ["search-server"],
  "tools": ["search"]
}
```

### 组健康检查

```http
GET /api/groups/:groupId/health
```

**响应**: 各服务器的连接状态、响应时间、整体健康度、可用/总工具数。

### 验证密钥管理

```http
POST   /api/groups/:groupId/validation-key       # 设置
GET    /api/groups/:groupId/validation-key       # 查询状态
DELETE /api/groups/:groupId/validation-key       # 删除
POST   /api/groups/:groupId/generate-validation-key  # 生成新密钥
POST   /api/groups/:groupId/validate-key         # 验证密钥
```

## 服务器管理 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/servers` | 服务器列表 |
| POST | `/api/servers` | 创建服务器 |
| PUT | `/api/servers/:id` | 更新服务器 |
| DELETE | `/api/servers/:id` | 删除服务器 |
| POST | `/api/servers/:id/connect` | 连接服务器 |
| POST | `/api/servers/:id/disconnect` | 断开服务器 |
| POST | `/api/servers/test` | 测试配置有效性 |

### 列表响应示例

```json
{
  "success": true,
  "data": {
    "servers": [
      {
        "id": "filesystem",
        "name": "文件系统服务器",
        "type": "stdio",
        "status": "connected",
        "config": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
        },
        "tools": ["read_file", "write_file", "list_directory"],
        "lastConnected": "2026-07-31T10:30:00Z"
      }
    ]
  },
  "timestamp": "2026-07-31T10:30:00Z"
}
```

### 创建服务器

```json
{
  "id": "git-server",
  "name": "Git 服务器",
  "type": "stdio",
  "config": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-git"],
    "env": {}
  }
}
```

### 测试服务器配置

```http
POST /api/servers/test
```

```json
{
  "config": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
  }
}
```

**响应**: `{ "data": { "valid": true, "tools": [...], "testDuration": 1234 } }`

## 工具管理 API

### 基础（`/api/tools`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tools` | 工具列表（`serverId`、`groupId` 可选过滤） |
| GET | `/api/tools/:toolName` | 工具详情 |
| POST | `/api/tools/:toolName/execute` | 执行工具 |

### 高级（`/api/tools-admin`）

提供工具监控、性能分析、健康检查等管理功能，均基于内存中的执行历史。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tools-admin/history` | 执行历史（`limit`/`offset`/`toolName`/`serverId`/`groupId`） |
| GET | `/api/tools-admin/monitoring` | 工具状态监控（按服务器分组） |
| GET | `/api/tools-admin/health` | 工具健康检查（含错误率、最近错误） |
| GET | `/api/tools-admin/performance` | 性能分析（`timeRange`：`1h`/`6h`/`24h`/`7d`，含 p50/p95/p99） |
| GET | `/api/tools-admin/errors` | 错误日志与汇总（Top 20 错误） |
| GET | `/api/tools-admin/stats` | 执行统计（Top 10 工具） |

### 执行工具

```http
POST /api/tools/:toolName/execute
```

```json
{
  "serverId": "filesystem",
  "arguments": { "path": "/workspace/README.md" }
}
```

**响应**: `data.result.content[]`、`data.executionTime`。

## 配置管理 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 获取配置（`category`：`system`/`servers`/`groups`/`auth`） |
| PUT | `/api/config` | 更新配置 |
| POST | `/api/config/validate` | 验证配置 |
| GET | `/api/config/history` | 配置变更历史（`limit`） |
| POST | `/api/config/backup` | 创建备份 |
| POST | `/api/config/restore` | 从备份恢复 |

### 更新配置

```http
PUT /api/config
```

```json
{ "category": "system", "config": { "logging": { "level": "debug" } } }
```

### 备份/恢复

```json
// POST /api/config/backup
{ "description": "部署前备份" }
// 响应: data.backup { id, timestamp, description, path }

// POST /api/config/restore
{ "backupId": "backup_123" }
```

## 仪表板 API（`/api/dashboard`）

主要端点（均需 JWT）：

| 路径 | 说明 |
| --- | --- |
| `/api/dashboard/stats` | 系统概览统计 |
| `/api/dashboard/health`、`/health-detailed` | 系统健康 |
| `/api/dashboard/logs`（GET/DELETE） | 系统日志（`limit`/`level`/`since`） |
| `/api/dashboard/activities` | 最近活动 |
| `/api/dashboard/performance` | 性能概览 |
| `/api/dashboard/system-info` | **系统信息**（版本、平台、运行时、特性、限制） |
| `/api/dashboard/memory`、`/memory/trend`、`/memory/snapshot`、`/memory/gc` | 内存监控与管理 |
| `/api/dashboard/resources` | 资源使用 |
| `/api/dashboard/events`、`/sse-stats` | 事件与 SSE 统计 |
| `/api/dashboard/test-alert`、`/test-tool-execution`、`/test-server-status`、`/add-log` | 测试/注入端点 |

> 旧文档的 `/api/system/info`、`/api/system/metrics` **不存在**，实际为 `/api/dashboard/system-info` 等。

### 系统信息

```http
GET /api/dashboard/system-info
```

**响应**:

```json
{
  "version": "1.0.0",
  "nodeVersion": "20.0.0",
  "platform": "darwin",
  "architecture": "arm64",
  "uptime": 86400,
  "environment": "production",
  "features": { "groupRouting": true, "cliSupport": true, "metricsCollection": true },
  "limits": { "maxConnections": 100, "requestTimeout": 30000, "maxRequestSize": "10MB" }
}
```

### 内存

```http
GET /api/dashboard/memory       # 当前内存
GET /api/dashboard/memory/trend # 内存趋势
POST /api/dashboard/memory/gc   # 触发 GC
POST /api/dashboard/memory/snapshot  # 保存快照
```

## 调试 API（`/api/debug`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/debug/mcp-messages` | MCP 协议消息（`limit`/`serverId`/`type`） |
| POST | `/api/debug/tool-test` | 测试工具执行 |
| GET | `/api/debug/performance-stats` | 性能统计 |
| GET | `/api/debug/error-analysis` | 错误模式分析 |

### 测试工具执行

```http
POST /api/debug/tool-test
```

```json
{
  "toolName": "get_current_time",
  "serverId": "time-mcp",
  "groupId": "default",
  "arguments": { "format": "ISO" }
}
```

**响应**: `data.result.content[]`、`data.executionTime`。

## 性能监控 API（`/api/performance`）

全局性能指标（由性能中间件采集）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/performance/stats` | 统计（`timeWindow`） |
| GET | `/api/performance/stats/by-endpoint` | 按端点分组统计 |
| GET | `/api/performance/slow-requests` | 慢请求（`threshold`，默认 1000ms） |
| GET | `/api/performance/recent-errors` | 最近错误（`limit`，默认 10） |
| GET | `/api/performance/metrics` | 所有指标 |
| DELETE | `/api/performance/metrics` | 清除指标 |
| GET | `/api/performance/report` | 综合报告（聚合上述） |

## API 转 MCP（`/api/api-to-mcp`）

将外部 HTTP API 配置为 MCP 工具。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/api-to-mcp/configs` | 配置列表 |
| POST | `/api/api-to-mcp/configs` | 创建配置 |
| GET | `/api/api-to-mcp/configs/:id` | 配置详情 |
| PUT | `/api/api-to-mcp/configs/:id` | 更新配置 |
| DELETE | `/api/api-to-mcp/configs/:id` | 删除配置 |
| POST | `/api/api-to-mcp/configs/:id/test` | 测试配置（触发出站调用） |

## OAuth（`/api/oauth` 与 `/.well-known/*`）

内置授权服务器（AS）与资源服务器（RS）元数据。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/oauth/token` | Token 端点（`grant_type=client_credentials`，form 编码） |
| GET | `/api/oauth/jwks` | JWK Set 公钥（RFC7517） |
| GET | `/.well-known/oauth-protected-resource` | Protected Resource metadata（RFC9728） |
| GET | `/.well-known/oauth-authorization-server` | AS metadata（RFC8414） |
| GET | `/.well-known/oauth-protected-resource/:group/mcp` | 组级 RS metadata |

### 获取 Token

```bash
curl -X POST http://localhost:8181/api/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=CLIENT_ID&client_secret=SECRET&scope=tools&resource=development"
```

## 系统健康检查

```http
GET /health
```

**响应**: `status`、`timestamp`、`version`、`uptime`、各服务健康度、基础指标。

## 错误响应

所有 API 出错时返回标准格式：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "人类可读的错误信息",
    "details": ["具体错误详情"]
  },
  "requestId": "req_123456789"
}
```

> JSON-RPC 端点（`/:group/mcp`）的错误使用 JSON-RPC 错误体：`{ "jsonrpc": "2.0", "error": { "code": -32602, ... }, "id": null }`。

### 常见错误代码

| 错误代码 | HTTP | 描述 |
| --- | --- | --- |
| `AUTH_LOGIN_FAILED` | 401 | 登录失败 |
| `AUTH_INVALID_CREDENTIALS` | 401 | 用户名或密码错误 |
| `AUTH_MISSING_TOKEN` / `AUTH_INVALID_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | 令牌相关 |
| `AUTH_ACCOUNT_LOCKED` | 423 | 账户被锁定 |
| `GROUP_NOT_FOUND` | 404 | 指定的组不存在 |
| `TOOL_NOT_FOUND` | 404 | 指定的工具不存在 |
| `TOOL_NOT_ALLOWED` | 403 | 工具不在组的允许列表中 |
| `INVALID_VALIDATION_KEY` | 401 | 验证密钥无效或缺失 |
| `INVALID_ARGUMENTS` | 400 | 工具参数无效 |
| `SERVER_ERROR` | 500 | MCP 服务器内部错误 |
| `SERVICE_UNAVAILABLE` | 503 | 服务不可用 |
| `TIMEOUT` | 408 | 请求超时 |
| `RATE_LIMIT_EXCEEDED` | 429 | 请求频率超限 |

## 速率限制

- 全局：每分钟 1000 请求
- 组：每组每分钟 100 请求
- 工具调用：每工具每分钟 50 次

响应头：`X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`。

## 分页

支持分页的端点使用 `limit`（默认 50，最大 1000）与 `offset`（默认 0）。响应中包含 `pagination: { total, limit, offset, hasMore }`。

## 示例用法

### MCP 工具调用

```bash
# 列出工具
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 调用工具（命名空间 <serverId>_<toolName>）
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"filesystem_read_file","arguments":{"path":"/workspace/README.md"}}}'
```

### 管理与监控

```bash
# 系统健康
curl http://localhost:8181/health

# 系统信息
curl http://localhost:8181/api/dashboard/system-info

# 性能报告
curl http://localhost:8181/api/performance/report

# 组健康检查
curl http://localhost:8181/api/groups/development/health
```

## 相关文档

- [CLI 使用指南](CLI_USAGE.md)
- [组路由指南](GROUP_ROUTING.md)
- [故障排除指南](TROUBLESHOOTING.md)
- [Web UI 指南](WEB_UI_GUIDE.md)
- [部署指南](DEPLOYMENT.md)
