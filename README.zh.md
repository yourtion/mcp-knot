# MCP Knot

[English](README.md) | 中文版

> _Knot_ —— 纽带、交织点。多个 MCP server 像散落的线，MCP Knot 把它们打成一个结，成为所有工具交汇的轻量枢纽。

**把你的 MCP server 系在一起。**

一个轻量的集中式枢纽服务器，将多个 MCP server 整合为专属的 Streamable HTTP 或 SSE 端点，每个端点针对特定场景——零配置启动，并率先支持 2026-07-28 无状态 MCP 协议。

## 特性

- **多服务器 MCP 集成**: 支持多个 MCP 服务器的集中管理
- **基于组的路由**: 通过组特定端点访问 MCP 服务 (`/:group/mcp`)
- **CLI MCP 服务器**: 独立的命令行 MCP 服务器，用于工具聚合
- **流式端点**: 支持 HTTP 和 SSE 端点
- **工具过滤**: 分组支持工具过滤和筛选功能
- **验证支持**: 分组可以设置独立的验证密钥以确保安全性
- **模块化架构**: 核心逻辑、API 和 CLI 包之间清晰分离

## 架构

MCP Knot 采用模块化 monorepo 架构，包含以下包：

### 核心包

- **`@mcp-core/mcp-knot-core`** - 核心 MCP 服务管理、连接处理和工具执行
- **`@mcp-core/mcp-knot-api`** - Web API 服务器，包含基于组的路由和 HTTP 端点
- **`@mcp-core/mcp-knot-cli`** - 命令行 MCP 服务器，用于独立工具聚合
- **`@mcp-core/mcp-knot-share`** - 跨包共享的类型和工具
- **`@mcp-core/mcp-knot-web`** - Vue.js 前端界面（可选）

### 包结构

```
├── backend/              # API 服务器 (@mcp-core/mcp-knot-api)
├── frontend/             # Vue.js Web 界面
├── packages/
│   ├── core/            # 核心 MCP 逻辑 (@mcp-core/mcp-knot-core)
│   ├── cli/             # CLI 包 (@mcp-core/mcp-knot-cli)
│   └── share/           # 共享类型 (@mcp-core/mcp-knot-share)
└── docs/                # 文档
```

## 安装

### 前置要求

- Node.js 20.19+（推荐 Node 22/24）
- pnpm 包管理器

### 安装依赖

```bash
# 安装所有依赖
pnpm install

# 构建所有包
pnpm build
```

## 快速开始

### 1. API 服务器（Web 界面）

启动 API 服务器以使用基于 Web 的 MCP hub 功能：

```bash
# 开发模式
pnpm dev:api

# 生产构建并启动
pnpm build
cd backend && pnpm start
```

API 服务器将在 `http://localhost:8181` 可用，提供以下端点：

- `/mcp` - 全局 MCP 端点（遗留，用于管理）
- `/:group/mcp` - 组特定的 MCP 端点
- `/api/groups` - 组管理 API

### 2. CLI MCP 服务器

将 CLI 包用作独立的 MCP 服务器：

```bash
# 全局安装 CLI（可选）
npm install -g @mcp-core/mcp-knot-cli

# 或从工作区直接运行
cd packages/cli
pnpm build
node dist/cli.js

# 或使用可执行文件
./bin/mcp-knot.js
```

#### 快速初始化配置

MCP Knot CLI 提供了快速配置初始化功能，帮助您快速开始使用：

```bash
# 查看所有可用的命令
mcp-knot --help

# 初始化默认配置（包含常用服务器示例）
mcp-knot --init

# 初始化所有配置（包含组配置）
mcp-knot --init-all

# 查看所有可用的服务器预设
mcp-knot --list-presets

# 覆盖已存在的配置文件
mcp-knot --init-all --overwrite
```

默认配置包含以下常用 MCP 服务器：

- **fetch**: 网页获取和 HTTP 请求
- **time**: 时间和日期功能
- **sequential-thinking**: 序列化思考能力

更多可用服务器预设：

- **filesystem**: 文件系统操作
- **memory**: 持久化记忆存储
- **brave-search**: Brave 搜索引擎
- **github**: GitHub 仓库管理

CLI 服务器通过 stdin/stdout 使用 MCP 协议进行通信，非常适合与 Claude Desktop 等 MCP 客户端集成。

### 3. 前端界面（可选）

启动 Web 界面进行可视化管理：

```bash
# 开发模式
pnpm dev:fe

# 生产构建
pnpm build:fe
```

前端界面将在 `http://localhost:8180`（开发模式）可用，或在生产环境中通过后端服务提供。

#### Web 界面功能

前端提供了全面的基于 Web 的管理界面，包含以下功能：

##### 1. 认证与安全

- **JWT 认证**: 基于令牌的安全登录系统
- **自动令牌刷新**: 无缝会话管理，不中断用户操作
- **路由守卫**: 需要认证的受保护页面
- **持久会话**: 跨浏览器会话记住用户登录状态
- **默认凭据**: 用户名: `admin`, 密码: `admin` (生产环境请修改!)

##### 2. 仪表板与监控

- **系统概览**: 服务器、工具和组的实时统计
- **实时状态更新**: 通过 Server-Sent Events (SSE) 实现实时监控
- **性能指标**: 请求速率、响应时间和错误率
- **活动动态**: 最近的系统活动和事件
- **健康监控**: 系统健康检查和告警

##### 3. 服务器管理

- **服务器列表**: 查看所有已配置的 MCP 服务器及状态指示器
- **添加/编辑服务器**: 可视化的服务器配置表单
- **连接控制**: 连接、断开和测试服务器连接
- **状态监控**: 实时服务器连接状态
- **配置验证**: 保存前测试服务器配置

##### 4. 工具管理

- **工具浏览器**: 浏览所有服务器上的可用 MCP 工具
- **工具搜索与过滤**: 按名称、服务器或组查找工具
- **工具测试**: 交互式工具执行，支持参数输入
- **执行历史**: 查看过去的工具执行和结果
- **工具详情**: 完整的工具文档和模式信息

##### 5. 组管理

- **组配置**: 创建和管理服务器组
- **成员管理**: 将服务器分配到组
- **工具过滤**: 配置每个组可用的工具
- **验证密钥**: 设置和管理组级别的认证
- **组统计**: 使用统计和性能指标

##### 6. API 到 MCP 集成

- **API 配置**: 将 REST API 转换为 MCP 工具
- **参数映射**: API 到 MCP 参数映射的可视化编辑器
- **API 测试**: 部署前测试 API 配置
- **导入/导出**: 跨环境共享 API 配置
- **自动生成**: 从 API 规范自动生成 MCP 工具

##### 7. 调试与开发工具

- **MCP 协议监控**: 查看原始 MCP 协议消息
- **工具调试器**: 使用详细执行日志测试工具
- **性能分析器**: 分析工具性能和瓶颈
- **错误分析**: 智能错误诊断和修复建议
- **消息检查器**: 检查请求/响应负载

##### 8. 配置管理

- **系统设置**: 配置系统级设置
- **配置编辑器**: 带验证的配置编辑
- **备份与恢复**: 创建和恢复配置备份
- **配置历史**: 跟踪配置变更历史
- **验证**: 实时配置验证

#### 认证设置

前端使用基于 JWT 的认证。配置认证：

1. **默认凭据**（开发环境）:
   - 用户名: `admin`
   - 密码: `admin`

2. **生产环境设置**:
   - 在 `system.json` 中配置凭据、JWT 密钥、服务端口（参见
     `backend/config/system.json.example` 与 schema
     `packages/share/src/config/schemas/system.schema.ts`）。
   - 在根字段 `users.admin.password` 设置强密码；当前后端会在内存中计算 bcrypt 哈希，
     此字段不要填写预计算的哈希。限制配置目录访问权限。
   - JWT 密钥与过期时间来自 `system.json` 的 `auth.jwt` 块，**不是**环境变量。

3. **环境变量**:
   ```bash
   # 后端 (.env) — 仅列代码实际识别的变量，完整说明见 .env.production.example
   NODE_ENV=production
   CONFIG_PATH=/path/to/config      # 含 system.json、mcp_server.json、group.json 的目录
   VALIDATION_KEY_SECRET='<已有的至少32字符密钥>'  # 启用组 validation 时必填
   ```

#### 访问 Web 界面

1. **启动后端**:

   ```bash
   pnpm dev:api
   # 后端运行在 http://localhost:8181
   ```

2. **启动前端**（开发模式）:

   ```bash
   pnpm dev:fe
   # 前端运行在 http://localhost:8180
   ```

3. **登录**:
   - 导航到 `http://localhost:8180`
   - 输入凭据（默认: admin/admin）
   - 您将被重定向到仪表板

4. **生产部署**:

   ```bash
   # 构建前端
   pnpm build:fe

   # 前端静态文件将在 frontend/dist 目录，由 Nginx 托管
   ```

   发布镜像使用 `docker-compose.release.yml`，源码构建使用 `docker-compose.yml`。
   两者都是 API（8181）与 Nginx Web（8180）的双容器结构；浏览器访问 8180，
   Web 将 `/api/` 与 `/:group/mcp` 代理到 API。

   ```bash
   # v0.1.1 已发布；先按部署指南准备配置和 localhost 覆盖文件
   export MCP_KNOT_VERSION=v0.1.1
   docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml pull
   docker compose -f docker-compose.release.yml -f docker-compose.localhost.yml up -d --no-build --wait
   curl -f http://localhost:8180/api/ping
   ```

   镜像是 `ghcr.io/yourtion/mcp-knot-api` 与 `ghcr.io/yourtion/mcp-knot-web`。
   版本变量必填，不默认使用 `latest`。请先准备可读写的配置目录（默认 `./config`），
   容器统一挂载到 `/app/config`。API 存活检查为 `/api/ping`，详细服务状态为 `/api/health`。
   当前两镜像为 Public，v0.1.1 匿名拉取与最终 amd64 镜像的 Compose/API/Web、
   重启配置持久化均已通过；arm64 已构建并核对 manifest，未做应用运行验证。
   完整初始化 JSON、UID 1000 权限、本机端口绑定与升级见 [部署指南](docs/DEPLOYMENT.md)。
   对外访问前替换默认 admin/admin 和 JWT secret，并重启 API。

## 配置

### MCP 服务器配置

在 `backend/config/` 目录中创建 `mcp_server.json` 文件：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"],
      "env": {}
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### 组配置

在 `backend/config/group.json` 中配置组：

```json
{
  "groups": {
    "development": {
      "name": "开发工具",
      "description": "软件开发工具",
      "servers": ["filesystem", "git"],
      "allowedTools": ["read_file", "write_file", "git_status"],
      "validationKey": "dev-key-123"
    },
    "research": {
      "name": "研究工具",
      "description": "研究和信息收集工具",
      "servers": ["brave-search", "wikipedia"],
      "allowedTools": ["search", "lookup"],
      "validationKey": "research-key-456"
    }
  }
}
```

## 使用示例

### 基于组的 MCP 访问

通过组特定端点访问工具：

```bash
# 列出开发组的工具
curl http://localhost:8181/development/mcp/list_tools

# 在研究组中调用工具
curl -X POST http://localhost:8181/research/mcp/call_tool \
  -H "Content-Type: application/json" \
  -d '{
    "name": "search",
    "arguments": {
      "query": "MCP 协议文档"
    }
  }'
```

### CLI MCP 服务器集成

在您的 MCP 客户端（如 Claude Desktop）中配置 CLI 服务器：

```json
{
  "mcpServers": {
    "mcp-knot": {
      "command": "/path/to/mcp-knot/packages/cli/bin/mcp-knot.js",
      "args": ["--config", "/path/to/mcp_server.json"]
    }
  }
}
```

## 开发

### 可用脚本

```bash
# 开发
pnpm dev:api          # 以开发模式启动 API 服务器
pnpm dev:fe           # 以开发模式启动前端

# 构建
pnpm build            # 构建所有包
pnpm check            # 运行代码检查和格式化

# 测试
pnpm test             # 运行所有测试
pnpm test:coverage    # 运行带覆盖率的测试
pnpm test:e2e         # 运行端到端测试

# 工具
pnpm inspector        # 启动 MCP 检查器进行调试
```

### 包开发

每个包都可以独立开发：

```bash
# 核心包
cd packages/core
pnpm dev              # 监视模式编译
pnpm test:watch       # 监视模式测试

# CLI 包
cd packages/cli
pnpm dev              # 监视模式编译
pnpm test:e2e         # 端到端测试

# API 包
cd backend
pnpm dev              # 开发服务器
pnpm test:mcp         # MCP 协议测试
```

## 文档

### 用户指南

- [Web 界面使用指南](docs/WEB_UI_GUIDE.md) - 完整的 Web 界面使用指南
- [CLI 使用指南](docs/CLI_USAGE.md) - 详细的 CLI 使用和配置
- [故障排除与常见问题](docs/TROUBLESHOOTING.md) - 常见问题和故障排除

### 技术文档

- [API 参考](docs/API_REFERENCE.md) - 完整的 API 文档
- [组路由指南](docs/GROUP_ROUTING.md) - 基于组的路由文档

### 开发与部署

- [开发指南](docs/DEVELOPMENT.md) - 开发环境搭建和贡献指南
- [发布流程](#发布流程) - 统一版本与 tag 发布
- [部署指南](docs/DEPLOYMENT.md) - 生产环境部署说明
- [故障排除](docs/TROUBLESHOOTING.md) - 常见问题和解决方案

### 发布流程

四个公开包 share、protocol、core、cli 使用统一稳定版本。功能合入并通过 main CI 后，
在干净、已同步的 `main` 执行：

```bash
pnpm run release:prepare patch  # 也支持 minor、major 或明确的 X.Y.Z
# 审核仅修改版本的提交与本地 vX.Y.Z tag
pnpm run release:push
```

prepare 完整验证后只提交四个版本文件，再创建本地 tag；push 原子推送 main 和该 tag。
`publish.yml` 由 tag 触发，校验版本、构建检查 tarball、按依赖顺序通过 npm OIDC 发布，
全部成功后创建一个 GitHub Release。重试时跳过已发布的准确版本。
可选 GHCR API/Web 镜像发布通过仓库变量 `DOCKER_PUBLISH=true` 开启，使用 Actions
自带 `GITHUB_TOKEN` 与镜像 job 的 `packages: write`，发布 amd64/arm64 的 `latest`
与完整版本 tag。首次创建新 GHCR 包默认私有，由维护者决定可见性；当前 API/Web
已确认 Public 且 v0.1.1 匿名拉取通过，详见 [GHCR 配置与实际验证结果](docs/RELEASING.md#ghcr-镜像可选)。

`pnpm run release:validate` 执行完整验证；`pnpm run release:dry-run` 只构建与检查产物。
两者都不会发包。认证、首次发包及失败重试见[发布配置指南](docs/RELEASING.md)。

## 贡献

1. Fork 仓库
2. 创建功能分支
3. 进行更改并添加测试
4. 运行 `pnpm check` 确保代码质量
5. 提交 Pull Request

## 许可证

ISC 许可证 - 详见 LICENSE 文件。
