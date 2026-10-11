# 组路由功能使用指南

MCP Knot 的组路由功能允许您通过特定的组路径 (`/:group/mcp`) 访问不同组的 MCP 工具，实现更好的工具组织和访问控制。

## 概述

组路由功能提供以下核心能力：

- **组隔离**: 不同组之间的工具访问完全隔离
- **工具过滤**: 每个组可以配置允许的工具列表
- **访问控制**: 支持组级别的验证密钥，以及 OAuth 2.1 Protected Resource
- **灵活配置**: 每个组可以使用不同的 MCP 服务器组合

## 配置

### 组配置文件

组配置默认从 `<cwd>/config/group.json` 读取（即进程当前工作目录下的 `config/group.json`）。可通过设置环境变量 `CONFIG_PATH` 指定其它配置目录，Hub 会从 `$CONFIG_PATH/group.json` 加载。

```json
{
  "groups": {
    "development": {
      "name": "开发工具组",
      "description": "软件开发相关的工具集合",
      "servers": ["filesystem", "git", "npm"],
      "allowedTools": [
        "read_file",
        "write_file",
        "list_directory",
        "git_status",
        "git_commit",
        "npm_install"
      ],
      "validationKey": "dev-secret-key-123",
      "enabled": true
    },
    "research": {
      "name": "研究工具组",
      "description": "信息收集和研究工具",
      "servers": ["brave-search", "wikipedia", "arxiv"],
      "allowedTools": ["search", "lookup", "get_article", "search_papers"],
      "validationKey": "research-secret-key-456",
      "enabled": true
    },
    "admin": {
      "name": "管理工具组",
      "description": "系统管理和监控工具",
      "servers": ["system-monitor", "log-analyzer"],
      "allowedTools": ["*"],
      "validationKey": "admin-secret-key-789",
      "enabled": true,
      "requireAuth": true
    }
  }
}
```

### 配置字段说明

| 字段            | 类型     | 必需 | 说明                                                                                                                                                       |
| --------------- | -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | string   | 是   | 组的显示名称                                                                                                                                               |
| `description`   | string   | 否   | 组的描述信息                                                                                                                                               |
| `servers`       | string[] | 是   | 该组使用的 MCP 服务器列表                                                                                                                                  |
| `allowedTools`  | string[] | 否   | 允许的工具列表，`["*"]` 表示允许所有工具                                                                                                                   |
| `validationKey` | string   | 否   | 组的验证密钥                                                                                                                                               |
| `enabled`       | boolean  | 否   | 是否启用该组（默认 true）                                                                                                                                  |
| `requireAuth`   | boolean  | 否   | 是否需要身份验证（默认 false）                                                                                                                             |
| `cacheHints`    | object   | 否   | 协议层 cacheHint 组级覆盖（P4）。可选字段：`toolsListTtlMs`（number，默认 60000ms）、`toolsListCacheScope`（`'public'` \| `'private'`，默认 `'public'`）。 |

### MCP 服务器配置

确保在 `<cwd>/config/mcp_server.json`（同样可由 `CONFIG_PATH` 覆盖）中配置了组所需的 MCP 服务器：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "env": {}
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git", "/workspace"],
      "env": {}
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key"
      }
    }
  }
}
```

## API 使用

### 基本端点

组路由的 MCP 入口唯一，所有 JSON-RPC 调用都走同一个端点：

```
POST   /:group/mcp             # MCP JSON-RPC 入口（列工具、调工具均通过此端点 + Mcp-Method 头）
GET    /:group/status          # 获取组运行时状态
GET    /:group/tools           # 获取组聚合工具列表（便捷查询，等价于 tools/list）
GET    /api/groups             # 列出所有组
GET    /api/groups/:groupId    # 获取特定组信息
GET    /api/groups/:groupId/health  # 检查组健康状态
```

> 注意：MCP 端点路径参数为 `:group`（组标识），而组管理 REST API（`/api/groups/...`）路径参数为 `:groupId`。

### MCP 协议：列出组的工具

通过 MCP JSON-RPC `tools/list` 调用，需要带 `Mcp-Method` 请求头：

```bash
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

工具按"先 serverId 后 toolName"字典序稳定返回。每个工具名采用 `<serverId>_<toolName>` 命名空间形式；此外 Hub 还会注入内置元工具 `group_status`、`list_group_tools`。

响应示例（JSON-RPC 结果）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "filesystem_read_file",
        "description": "读取文件内容",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "文件路径" }
          },
          "required": ["path"]
        }
      },
      {
        "name": "filesystem_write_file",
        "description": "写入文件内容",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string" },
            "content": { "type": "string" }
          },
          "required": ["path", "content"]
        }
      }
    ]
  }
}
```

如需快速查看聚合工具列表而无需走完整 JSON-RPC，也可直接 `GET /:group/tools`。

### MCP 协议：调用组内工具

通过 MCP JSON-RPC `tools/call`，`Mcp-Method` 头指定为 `tools/call`，`params.name` 使用 `<serverId>_<toolName>` 命名空间形式：

```bash
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "filesystem_read_file",
      "arguments": { "path": "/workspace/README.md" }
    }
  }'
```

响应示例：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "# My Project\n\nThis is a sample README file..." }]
  }
}
```

### 使用验证密钥 / OAuth

- 若组启用了 `validation`，MCP 端点会强制校验 `Authorization: Bearer <validationKey>`，需在请求头中提供正确 key。
- 若系统配置启用了 OAuth（Protected Resource），则需标准的 `Authorization: Bearer <jwt>`。

```bash
# 使用 validationKey 访问需要验证的组
curl -X POST http://localhost:8181/admin/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -H "Authorization: Bearer admin-secret-key-789" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": { "name": "system-monitor_status", "arguments": {} }
  }'
```

## 组管理 API

### 列出所有组

```bash
curl http://localhost:8181/api/groups

# 响应
{
  "groups": [
    {
      "id": "development",
      "name": "开发工具组",
      "description": "软件开发相关的工具集合",
      "enabled": true,
      "toolCount": 6,
      "serverCount": 3
    },
    {
      "id": "research",
      "name": "研究工具组",
      "description": "信息收集和研究工具",
      "enabled": true,
      "toolCount": 4,
      "serverCount": 3
    }
  ]
}
```

### 获取组详细信息

```bash
curl http://localhost:8181/api/groups/development

# 响应
{
  "id": "development",
  "name": "开发工具组",
  "description": "软件开发相关的工具集合",
  "servers": ["filesystem", "git", "npm"],
  "allowedTools": ["read_file", "write_file", "list_directory"],
  "enabled": true,
  "requireAuth": false
}
```

### 检查组健康状态

```bash
curl http://localhost:8181/api/groups/development/health

# 响应
{
  "group": "development",
  "status": "healthy",
  "servers": {
    "filesystem": { "status": "connected", "responseTime": 45 },
    "git":        { "status": "connected", "responseTime": 32 },
    "npm":        { "status": "error",     "error": "Connection timeout" }
  },
  "overallHealth": "degraded"
}
```

## 错误处理

### 组不存在

```bash
curl -X POST http://localhost:8181/nonexistent/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 响应 (404)
{
  "error": "GROUP_NOT_FOUND",
  "message": "组 'nonexistent' 不存在",
  "code": 404
}
```

### 工具不在允许列表中

```json
{
  "error": "TOOL_NOT_ALLOWED",
  "message": "工具 'system_reboot' 不在组 'development' 的允许列表中",
  "code": 403,
  "allowedTools": ["read_file", "write_file", "list_directory"]
}
```

### 验证密钥错误

```json
{
  "error": "INVALID_VALIDATION_KEY",
  "message": "无效的验证密钥",
  "code": 401
}
```

### 服务器连接失败

```json
{
  "error": "SERVICE_UNAVAILABLE",
  "message": "组 'development' 的服务器连接失败",
  "code": 503,
  "details": {
    "failedServers": ["git"],
    "availableServers": ["filesystem"]
  }
}
```

## 高级功能

### 动态工具过滤

可在运行时通过组管理 API 更新组的工具配置：

```bash
# 更新组的允许工具列表（注意：组管理 API 路径参数为 :groupId，方法为 PUT）
curl -X PUT http://localhost:8181/api/groups/development \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: admin-secret" \
  -d '{
    "allowedTools": ["read_file", "write_file", "git_status"]
  }'
```

### 组级别的参数验证

为组配置自定义参数验证规则：

```json
{
  "groups": {
    "development": {
      "name": "开发工具组",
      "servers": ["filesystem"],
      "parameterValidation": {
        "read_file": {
          "path": {
            "pattern": "^/workspace/.*",
            "message": "只能访问 /workspace 目录下的文件"
          }
        }
      }
    }
  }
}
```

## 最佳实践

### 组设计原则

1. **按功能分组**: 根据工具的功能和用途创建组
2. **最小权限**: 只授予组必需的工具访问权限
3. **清晰命名**: 使用描述性的组名和描述
4. **文档化**: 为每个组提供详细的使用文档

### 安全考虑

1. **验证密钥 / OAuth**: 为敏感组设置强验证密钥或启用 OAuth 2.1 Protected Resource
2. **工具过滤**: 严格控制每个组可访问的工具
3. **参数验证**: 对工具参数进行严格验证
4. **访问日志**: 记录所有组访问和工具调用

### 性能优化

1. **连接复用**: 多个组共享底层 MCP 服务器连接
2. **缓存策略**: 利用 `tools/list` 的协议层 cacheHint 提升客户端缓存命中率
3. **监控告警**: 监控组性能和可用性（`GET /:group/status`）

### 故障处理

1. **优雅降级**: 部分服务器失败时继续提供可用工具
2. **故障隔离**: 一个组的故障不影响其他组
3. **健康检查**: 通过 `/api/groups/:groupId/health` 快速定位故障服务器

## 示例场景

### 开发团队使用场景

```bash
# 开发组 - 列出可用工具
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 开发组 - 读取源码文件
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params": {"name": "filesystem_read_file", "arguments": {"path": "/src/main.ts"}}
  }'

# 部署组 - 部署到预发环境（需要 validationKey）
curl -X POST http://localhost:8181/deployment/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -H "Authorization: Bearer deploy-key" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params": {"name": "ci_deploy", "arguments": {"environment": "staging"}}
  }'
```

### 研究团队使用场景

```bash
# 文献研究组 - 检索论文
curl -X POST http://localhost:8181/research/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -d '{
    "jsonrpc":"2.0","id":4,"method":"tools/call",
    "params": {"name": "arxiv_search_papers", "arguments": {"query": "machine learning"}}
  }'
```

## 参考资料

- [MCP Knot API 参考](API_REFERENCE.md)
- [故障排除指南](TROUBLESHOOTING.md)
