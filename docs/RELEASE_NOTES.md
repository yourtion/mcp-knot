# MCP Knot Release Notes

## Unreleased — MCP 2026-07-28 协议升级 + 代码债收尾 + 出站 MCP server OAuth

### 新增（P2：入站 OAuth 2.1 Protected Resource）

- **Hub 作为 MCP OAuth 2.1 Protected Resource（RFC9728）**：`/:group/mcp` 端点现在校验 `Authorization: Bearer <token>`，对 MCP 客户端（Claude Desktop 等）做标准授权。
- **内置最小 Authorization Server**：无外部 IdP 时，Hub 内置 AS 通过 `client_credentials` grant 签发 RS256 JWT，开箱即用。
- **对接外部 IdP**（Keycloak/Entra/Auth0/OIDC Provider）：JWT 本地验签（JWKS）+ opaque token introspection（RFC7662）回退。
- **新增 OAuth 端点**：
  - `GET /.well-known/oauth-protected-resource`（RFC9728 Protected Resource Metadata）
  - `GET /.well-known/oauth-authorization-server`（RFC8414 AS Metadata，内置 AS）
  - `POST /api/oauth/token`（`client_credentials` 签发）
  - `GET /api/oauth/jwks`（内置 AS 公钥集合）
- **401 响应带 `WWW-Authenticate` 头**：`Bearer resource_metadata="...", scope="..."`（MCP 规范 MUST），客户端可自动发现授权流程。
- **系统配置新增 `oauth` 块**：见 `packages/share/src/config/schemas/system.schema.ts`，支持 `mode: 'internal' | 'external' | 'both'`。
- **安全加固**：RFC8707 audience 绑定（token `aud` 必须匹配 resource）、RFC9207 `iss` 防护、PKCE S256 声明（为客户端 metadata 验证）。

### ⚠️ Breaking Changes（P2：validationKey 现在强制校验）

- **组级 `validationKey` 在 MCP 端点强制校验**：之前配置了 `validation.enabled = true` 的组，MCP 端点（`/:group/mcp`）实际不校验 validationKey（任何请求放行）。P2 修复后，启用 validation 的组必须在 `Authorization: Bearer <validationKey>` 提供正确 key 才能访问。
  - **迁移**：若你的组启用了 validation 但希望保持开放，将 `validation.enabled` 改为 `false`。
  - 若要使用 validation，确保客户端带上配置的 validationKey。
  - **默认行为不变**：未配置 `oauth` 且组未启用 `validation` 时，MCP 端点保持开放（启动时 warn 提示安全风险）。

### 新增（P4：协议层缓存语义）

- **`tools/list` 协议层 cacheHint**：Hub 在 `tools/list` 响应上下发 `ttlMs: 60000`（1 分钟）与 `cacheScope: 'public'`，提示 MCP 客户端（如 Claude Desktop）缓存工具列表、提升 LLM prompt cache 命中率。默认值可在组配置 `cacheHints.toolsListTtlMs` / `cacheHints.toolsListCacheScope` 按组覆盖。
- **`tools/list` 确定性排序**：工具按"先 serverId 后 toolName"字典序稳定返回（2026-07-28 协议 SHOULD），保证客户端缓存稳定有效。
- **新增 4 个 Hub 元数据 resources**：`group://{groupId}/status`（组运行时状态）、`group://{groupId}/servers`（组服务器列表与连接状态）、`hub://config`（全局配置概要）、`hub://version`（版本信息），每个 resource 带独立的 `ttlMs`/`cacheScope` cacheHint，客户端可通过 `resources/list` / `resources/read` 预读取。

### 新增（P3：出站 REST API OAuth）

- **api-to-mcp 子系统支持 OAuth 认证**：Hub 把外部 REST API 封装为 MCP 工具时，`AuthenticationStrategy` 的 `type: 'oauth'` 从抛错占位变为真实实现。
- **支持的 grant**：`client_credentials`（服务间）+ `refresh_token`（自动续期）。
- **token 缓存 + 并发去重**：内存缓存 token 与过期时间，in-flight Promise 防止并发 stampede。
- **配置**：`api-to-mcp` 工具的 `authentication` 字段扩展为 discriminated union（bearer/apikey/basic/oauth），见 `packages/core/src/api-to-mcp/types/api-config.ts`。

### 新增（P6：OTel trace context + 弃用项清理）

- **OTel trace context 传播（SEP-414）**：Hub 作为网关，从入站请求 `_meta` 提取 `traceparent`/`tracestate`/`baggage`，经 AsyncLocalStorage 传播到出站 `callTool` 注入上游 server，实现分布式追踪。
- **日志统一**：`backend/src` 生产代码 `console.*` 全面收敛到统一 Logger（`@mcp-core/mcp-knot-share`），requestId 链路追踪完整。
- **弃用项清理**：经核实，Roots/Sampling/Logging/Tasks wire vocabulary 等弃用特性项目零实现，无需清理；HTTP+SSE 传输由 P1 处理。

### 重构（代码债收尾）

- **错误体系统一**：`packages/core/api-to-mcp` 子系统的 42 处裸 `throw new Error()` 统一为结构化 `ServiceError`（新增 7000-7499 错误码段 4 个粗粒度码，三表全覆盖）。executor 边界 catch-all 保持不变，结构化错误不逃逸到 MCP 协议层。
- **删除轨道 B 死代码**：`mcp_hub_service.ts`（后改名 `mcp_knot_service.ts`）的 `McpHubError`（后改名 `McpKnotError`）及 4 个子类删除（`GroupNotFoundError` 迁移为 `ServiceError(GROUP_NOT_FOUND)`），3 处 `instanceof McpHubError` 死分支移除。
- **拆分上帝文件**：`backend/src/api/groups/index.ts` 从 1945 行拆为 487 行（仅路由注册）+ 3 个纯函数 service 模块（`group-service` / `tool-access-service` / `validation-key-service`），行为零变化。

### 新增（出站 MCP server OAuth）

- **Hub 连外部 MCP server 动态认证**：SSE/Streamable 类型的 server 连接接入 SDK 原生 `authProvider` 机制，支持 token 动态获取与自动刷新（替代此前只透传静态 `headers` 的方式）。
- **两种机器认证**：
  - `auth.type: 'bearer'`：已有静态 token，每次请求带上（过期则连接失败，需手动更新）。
  - `auth.type: 'oauth'`：`client_credentials` 机器认证，复用 SDK 现成 `ClientCredentialsProvider`（自动发现 token endpoint + 获取 + 401 刷新重试）。
- **secret 安全**：`clientSecret` / token 支持 `${ENV_VAR}` 环境变量引用（推荐）或明文，配置文件不留明文密钥。
- **配置**：`HttpServerConfigSchema` 新增 `auth` 字段（discriminated union），见 `packages/share/src/config/schemas/server.schema.ts`。

### ⚠️ Breaking Changes（P1 传输层）

- **协议升级到 MCP 2026-07-28**：入站方向（Hub 对 MCP 客户端）激进升级，仅支持新协议。旧的 2025-era `initialize` 握手被拒绝（`legacy: 'reject'`），客户端需使用支持 2026-07-28 的 MCP SDK。
- **移除 `/sse` MCP 端点**：MCP 级 SSE 传输已在 2026-07-28 标记为 Deprecated 并移除。请改用 `/:group/mcp` 的 Streamable HTTP 端点。（Dashboard 业务 SSE 不受影响。）
- **移除 legacy `/mcp` 全局端点**：该端点此前已标记 deprecated（Sunset 2026-10-01），现一并移除。请使用 `/:group/mcp` 组路由。
- **Node.js 最低版本要求提升到 20**：MCP SDK v2 要求 Node 20+。Docker 基础镜像已升级到 `node:20-alpine`。
- **SDK 升级到 `@modelcontextprotocol/*` v2**：`@modelcontextprotocol/sdk` 单包拆分为 `core`/`server`/`client`/`node`/`hono` 等独立包。

### 新增

- 采用 `createMcpHandler` 实现无状态传输（`server/discover`、`Mcp-Method`/`Mcp-Name` 头校验、无 `Mcp-Session-Id`）。
- McpServer 按 group 缓存，配置变更时（`reloadCoreServiceManager`）主动失效重建。
- 出站方向（Hub 连外部 MCP server）保留兼容：`versionNegotiation: { mode: 'auto' }`，仍支持连接老式 SSE server（Hub 充当协议转换层）。

## Version 1.0.0 - Web UI Release

发布日期: 2024-01-15

### 🎉 主要功能

#### Web 管理界面

全新的 Vue 3 + TDesign 前端界面，提供完整的可视化管理功能：

- **JWT 认证系统**: 安全的用户登录和会话管理
- **仪表板**: 系统概览、实时监控和性能指标
- **服务器管理**: 可视化的 MCP 服务器配置和连接控制
- **工具管理**: 工具浏览、搜索、测试和执行历史
- **组管理**: 服务器分组、工具过滤和访问控制
- **API 到 MCP**: 将 REST API 转换为 MCP 工具
- **调试工具**: MCP 协议监控、性能分析和错误诊断
- **配置管理**: 系统配置编辑、验证、备份和恢复

#### 后端 API 增强

- **认证 API**: 登录、登出、令牌刷新和用户管理
- **服务器管理 API**: 完整的 CRUD 操作和连接控制
- **工具管理 API**: 工具查询、执行和监控
- **组管理 API**: 组配置和成员管理
- **配置管理 API**: 配置查询、更新、验证和备份
- **仪表板 API**: 系统统计和实时事件推送
- **调试 API**: MCP 消息监控和性能分析

#### 实时功能

- **SSE 事件流**: 服务器状态、工具执行和系统告警的实时推送
- **自动刷新**: 仪表板和监控数据的自动更新
- **实时日志**: 系统日志的实时流式传输

### 📚 文档

新增完整的文档体系：

- **Web 界面使用指南**: 详细的功能说明和操作步骤
- **部署指南**: 生产环境部署的完整说明
- **开发指南**: 开发环境搭建和贡献指南
- **常见问题解答**: 常见问题和解决方案
- **API 参考**: 完整的 API 端点文档

### 🔧 部署工具

新增生产环境部署脚本：

- **deploy-production.sh**: 自动化部署脚本
- **restore-backup.sh**: 配置备份恢复脚本
- **health-check.sh**: 系统健康检查脚本
- **.env.production.example**: 生产环境配置模板

### 🎨 用户体验

- **响应式设计**: 适配桌面和移动设备
- **主题支持**: 亮色和暗色主题切换
- **国际化**: 中英文界面支持
- **无障碍**: 符合 WCAG 2.1 标准

### 🔒 安全性

- **JWT 认证**: 基于令牌的安全认证
- **密码加密**: bcrypt 密码哈希
- **HTTPS 支持**: SSL/TLS 加密通信
- **CORS 配置**: 跨域请求控制
- **速率限制**: API 请求频率限制
- **输入验证**: 严格的参数验证

### ⚡ 性能优化

- **代码分割**: 按需加载减少初始加载时间
- **缓存策略**: 多层缓存提高响应速度
- **连接池**: 优化 MCP 服务器连接管理
- **压缩**: Gzip 压缩减少传输大小
- **懒加载**: 组件和路由的懒加载

### 🧪 测试

- **单元测试**: 覆盖率 > 80%
- **集成测试**: API 端点和服务集成测试
- **E2E 测试**: 完整的用户流程测试
- **性能测试**: 负载和压力测试

### 📦 依赖更新

#### 前端

- Vue 3.5.17
- TDesign Vue Next 1.16.1
- Pinia 3.0.3
- Vue Router 4.5.1
- Axios 1.6.7

#### 后端

- Hono 4.12.32
- @modelcontextprotocol/\* v2（core/server/client/node/hono 等独立包，由原 `@modelcontextprotocol/sdk` 单包拆分而来）
- jsonwebtoken 9.0.2
- bcryptjs 3.0.2

### 🐛 Bug 修复

- 修复了 MCP 服务器连接稳定性问题
- 修复了工具执行超时处理
- 修复了配置文件验证逻辑
- 修复了内存泄漏问题
- 修复了并发请求处理

### 🔄 Breaking Changes

- 配置文件格式更新，需要迁移旧配置
- API 端点路径调整，详见 API 参考文档
- 环境变量命名规范化

### 📝 迁移指南

从旧版本升级：

1. **备份配置**:

   ```bash
   cp -r backend/config backend/config.backup
   ```

2. **更新代码**:

   ```bash
   git pull origin main
   pnpm install
   ```

3. **迁移配置**:
   - 参考 `.env.production.example` 更新环境变量
   - 更新配置文件格式（如需要）

4. **构建和部署**:
   ```bash
   pnpm build:production
   ./scripts/deploy-production.sh
   ```

### 🎯 下一步计划

- [ ] 多用户和权限管理
- [ ] WebSocket 支持
- [ ] 更多 MCP 服务器类型支持
- [ ] 插件系统
- [ ] 移动应用
- [ ] 集群部署支持

### 🙏 致谢

感谢所有贡献者和用户的支持！

### 📞 支持

如有问题或建议：

- GitHub Issues: https://github.com/your-org/mcp-knot/issues
- 文档: https://github.com/your-org/mcp-knot/tree/main/docs
- 邮件: support@example.com

---

## Version 0.0.1 - Initial Release

发布日期: 2024-01-01

### 功能

- 基础 MCP Knot 功能
- CLI 工具
- 组路由支持
- 基础 API 端点

---
