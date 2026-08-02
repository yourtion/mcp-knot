# 总体跟踪 Spec：跟进 MCP 2026-07-28 协议演进

- **状态**: Draft（跟踪用）
- **日期**: 2026-07-25
- **作者**: yourtion
- **关联**:
  - `docs/superpowers/specs/2026-07-11-project-audit-report.md`（产品/架构审计）
  - `docs/superpowers/specs/2026-07-25-p1-transport-upgrade-design.md`（P1 详细设计）

## 目的

本 spec 是"全量跟进 MCP 2026-07-28 协议演进"这一迭代的**总体跟踪文档**。它记录：

1. 已确认的全景决策（适用于所有子项目）。
2. P1-P6 六个子项目的范围、依赖、状态。
3. 每个子项目的设计大纲（够启动、够跟踪，但不强求 P1 那种逐节深度——深度设计在轮到具体子项目时通过 brainstorming 产出独立 spec）。

**使用方式**：每个子项目启动时，基于本 spec 的对应章节发起 brainstorming，产出独立 spec，然后回这里更新状态和链接。

## 全景决策（brainstorming 已确认）

| 决策           | 选择                                                                                          | 理由                                                  |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 迭代主线       | 全量跟进 MCP 2026-07-28，分解为 P1-P6 分阶段交付                                              | 一次性做会失控；分解后每个子项目可独立 spec/计划/实现 |
| 总体兼容性策略 | 默认全开（modern + legacy），可配置收窄                                                        | 修订自 P1 的"激进升级"；P7 引入协议兼容层，趁早切干净的同时不丢存量客户端 |
| 出站方向策略   | 保留兼容（`auto` 模式 + 保留 SSE 连接）                                                       | 外部 server 生态参差不齐，网关价值在于能连各种 server |
| OAuth 范围     | 不自建完整 IAM；入站做 Protected Resource，出站接 `AuthenticationStrategy`，Web 登录可接 OIDC | 审计报告建议接 Keycloak/Entra/OIDC，不自造            |
| 社交登录       | 纳入考虑（属 Web UI 范畴，与 MCP 协议解耦）                                                   | 偏用户体验                                            |

## 子项目全景

> 状态分两个维度：**spec 状态**（设计文档是否产出）与**实现进度**（代码是否在动）。两者独立——spec 完成不等于实现完成。

| #      | 子项目                               | spec 状态                 | 实现进度                                                              | 详细 spec                                   |
| ------ | ------------------------------------ | ------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| **P1** | 传输层升级到 2026-07-28 无状态       | ✅ 完成                   | ✅ **实现完成**（已合并 main，commits `6aedf23`/`f802256`/`5303574`） | `2026-07-25-p1-transport-upgrade-design.md` |
| **P2** | 入站 OAuth 2.1（Protected Resource） | ✅ 完成                   | ✅ **实现完成**（已合并 main，merge `768ff09`）                       | `2026-07-26-p2-inbound-oauth-design.md`     |
| P3     | 出站 OAuth（AuthenticationStrategy） | ✅ 完成                   | ✅ **实现完成**（已合并 main，merge `5865277`；e2e 已激活）           | `2026-07-27-p3-outbound-oauth-design.md`    |
| **P4** | `ttlMs`/`cacheScope` 缓存语义        | ✅ 完成                   | ✅ **实现完成**（已合并 main，merge `a03f430`）                       | `2026-07-26-p4-cache-semantics-design.md`   |
| P5     | `subscriptions/listen` + MRTR        | ✅ 完成                   | ✅ **实现完成**（分支 `feat/p5-subscriptions-mrtr`，待合并 main）       | `2026-07-30-p5-subscriptions-mrtr-design.md` |
| **P6** | OTel trace context + 弃用项清理      | ✅ 完成                   | ✅ **实现完成**（已合并 main，merge `6a2f11b`）                       | `2026-07-28-p6-otel-deprecation-design.md`  |
| **P7** | 协议兼容层（双向 era 翻译 + 入站默认全开） | ✅ 完成                   | ✅ **实现完成**（分支 `feat/p7-protocol-compat-layer`，待合并 main）   | `2026-08-02-protocol-compat-layer-design.md` |

**推荐主线顺序**：P1 → P4 → P2 → P3 → P6 → P5 → P7

> **2026-07-25 协议特性审查结论**：对照 2026-07-28 完整特性集，P1-P6 覆盖了协议主干（传输无状态化、Authorization、缓存语义、可观测性、弃用清理）。有 2 个新特性经评估**显式不纳入本轮范围**（见 [§未采纳/待评估协议特性](#未采纳待评估协议特性)）：MCP Apps（server-rendered UI）与 `x-mcp-header`/`Mcp-Param-` 透传（需确认 SDK 是否自动处理）。其余特性层面的覆盖补充已并入对应子项目（P3/P4/P6）。

### 依赖关系

```
P1（传输层）────────┬──→ P2（入站 OAuth）
                   ├──→ P4（缓存语义，弱依赖：结果字段）
                   ├──→ P5（subscriptions/listen，强依赖）
                   ├──→ P6（OTel/弃用清理，无依赖可穿插）
                   └──→ P7（协议兼容层，叠加于 P1 之上：修订入站策略）

P3（出站 OAuth）──── 无依赖，可独立做
```

- P1 是地基，解锁 P2/P4/P5。
- P3 与 P1 解耦（改的是 `api-to-mcp` 子系统，不碰传输层），可独立做。
- P6 无依赖，任何时候可穿插。
- P7 叠加于 P1 之上（不推翻）：P1 的激进入站策略由 P7 修订为"默认全开可配置"，并新增双向 era 翻译、归一化模型与统一错误。

---

## P2: 入站 OAuth 2.1（Protected Resource）

- **状态**: 待 brainstorming
- **复杂度**: 高
- **依赖**: 弱依赖 P1（token 校验走无状态，复用 P1 的无状态传输）
- **价值**: ⭐⭐⭐ 安全达标，审计报告"必须"项

### 范围

让 Hub 作为 MCP **OAuth 2.1 Protected Resource**（RFC9728），对 MCP 客户端（Claude Desktop 等）做授权。对齐 MCP `2025-11-25` Authorization 规范 + `2026-07-28` 加固。

### 设计大纲

**需实现的端点/能力**（基于 MCP Authorization 规范）：

1. **Protected Resource Metadata**（RFC9728）：
   - `/.well-known/oauth-protected-resource`（或按组路径 `/.well-known/oauth-protected-resource/:group/mcp`）。
   - 401 响应带 `WWW-Authenticate: Bearer resource_metadata="...", scope="..."`。

2. **Token 校验中间件**（入站）：
   - 校验 `Authorization: Bearer <token>`。
   - 验证 audience（RFC8707 `resource` 参数绑定，防止 token 跨服务误用）。
   - 无状态校验（JWT 验签，不依赖服务端 session）—— 与 P1 的无状态方向一致。
   - 挂在 Hono 中间件链，保护 `/:group/mcp` 端点。

3. **Authorization Server 对接**（不自建完整 AS）：
   - Hub 作为 Resource Server，对接外部 AS（Keycloak/Entra/Auth0/OIDC Provider）。
   - 支持 RFC8414 Authorization Server Metadata 发现。
   - **可选**：Hub 内置一个最小 AS（仅 client_credentials + 本地用户库），给无外部 IdP 的小团队用。需 brainstorming 决定是否做。

4. **Client ID Metadata Documents 支持**（draft-ietf-oauth-client-id-metadata-document-00）：
   - AS 侧拉取客户端 metadata URL，**防 SSRF**（限制内网地址、超时、缓存）。
   - 2026-07-28 已弃用 DCR（RFC7591）为备选，优先用 Client ID Metadata Documents。

5. **PKCE 强制**（S256）+ `iss` 参数校验（RFC9207，防 mix-up）。

### 关键决策点（待 brainstorming）

- 内置最小 AS vs 纯对接外部 IdP？
- token 存储用 JWT（无状态）还是 opaque + introspection？
- 是否保留现有组级 `validationKey`（AES 共享密钥）作为 OAuth 之外的轻量 API key 方案？
- 顺带修复 `simple-auth.ts` 假认证（任何非空 token 放行）和 `message-audit-service.ts` 用户归因硬编码 `'admin'`。

### 现有挂载点

- `backend/src/middleware/auth.ts`：当前 JWT 校验中间件（Web UI 登录用），需新增独立的 MCP OAuth 中间件。
- `backend/src/api/groups/crypto.ts` + `key-policy.ts`：现有组级 `validationKey`，决策保留或演进。

---

## P3: 出站 OAuth（AuthenticationStrategy）

- **状态**: 待 brainstorming
- **复杂度**: 中
- **依赖**: 无（改 `api-to-mcp` 子系统，不碰传输层）
- **价值**: ⭐⭐ 扩展 REST API 工具的接入面

### 范围

让 Hub 作为**客户端**调用外部 OAuth 保护的 REST API（如 GitHub API、Google API）时，自动获取/刷新 token。把当前 `AuthenticationStrategy` 里 `type: 'oauth'` 的**抛错占位**改成真实实现。

### 范围边界（P3）

P3 聚焦 `api-to-mcp` 子系统（Hub 把外部 REST API 封装成 MCP 工具）。有一个相邻但**不属于 P3** 的问题需明确边界，避免范围蔓延：

| 问题                                                          | 是否属 P3             | 说明                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-to-mcp` 调外部 REST API 的 OAuth                         | ✅ 是                 | P3 核心，改 `AuthenticationStrategy`                                                                                                                                                                                                                                                         |
| Hub 连外部 **MCP server** 时的出站认证（`server_manager.ts`） | ✅ 已完成（2026-07-30，独立立项） | ✅ **已完成**：`server_manager.ts` 的 SSE/Streamable 连接接入 SDK 原生 `authProvider`（bearer 静态 token + oauth `ClientCredentialsProvider`），动态获取/刷新 token。详见 `2026-07-30-outbound-mcp-server-oauth-design.md` |

### 设计大纲

1. **扩展 `AuthConfig` 类型**（`packages/core/src/api-to-mcp/types/api-config.ts:56-62`）：
   - `type` enum 加 `'oauth'`。
   - 新增字段：`clientId`、`clientSecret`、`tokenUrl`、`authUrl`、`redirectUri`、`scope`、`grantType`。

2. **实现 `OAuthStrategy implements AuthenticationStrategy`**（`packages/core/src/api-to-mcp/services/authentication.ts`）：
   - `applyAuth`：附 token 到请求；token 过期时自动用 refresh_token 刷新。
   - `validateConfig`：校验 OAuth 配置完整性。
   - 在 `AuthenticationManager` 构造时注册（当前 L182-184 注册了 bearer/apikey/basic，加 oauth）。

3. **Token 存储**：
   - 内存缓存 token + 过期时间（复用现有 `CacheManager`？或独立轻量存储）。
   - 多实例部署需共享 → 接 `RedisCacheManager`（当前是 no-op，需先实现，或 P3 范围内只做单实例）。

4. **支持的 grant types**（brainstorming 决定范围）：
   - `client_credentials`（服务间，最常用，MVP）。
   - `authorization_code`（需用户交互，复杂）。
   - `refresh_token`（token 刷新）。

### 关键决策点（待 brainstorming）

- MVP 只做 `client_credentials` + `refresh_token`，还是连 `authorization_code`？
- token 存储用现有 `CacheManager` 还是独立？
- 是否依赖 P6 的 OTel 给 token 刷新加追踪？

### 现有挂载点

- `AuthenticationStrategy` 接口（`authentication.ts:16-25`）+ `AuthenticationManager`（L192 `registerStrategy`）。
- `oauth` 抛错占位（`authentication.ts:217`，测试 `authentication.unit.test.ts:499,533`）。

---

## P4: `ttlMs`/`cacheScope` 缓存语义

- **状态**: 待 brainstorming
- **复杂度**: 中
- **依赖**: 弱依赖 P1（落点：P1 升级到 SDK v2 后，`registerResource`/`ServerOptions.cacheHints` 等 cache 相关 API 才可用；传输层本身不阻塞 P4）
- **价值**: ⭐⭐⭐ 网关天然差异化

### 范围

采纳 MCP `2026-07-28` 的 `CacheableResult`（SEP-2549），在 `tools/list`、`resources/list`、`resources/read` 等结果的 `ttlMs`/`cacheScope` 字段上提供有意义的缓存提示，并利用 Hub 作为网关的位置优势做**响应缓存层**。

### 重要区分：两层缓存

项目已有缓存，但那是**工具调用结果缓存**（API→MCP 工具调外部 REST API 的响应）。P4 是**协议级缓存语义**（MCP `list`/`read` 结果给客户端的缓存提示）。两者不同层面：

| 层面                   | 位置                                                     | 用途                                                                 |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| 已有：工具调用结果缓存 | `packages/core/src/api-to-mcp/services/cache-manager.ts` | Hub 调外部 REST API 后缓存响应，减少外部调用                         |
| P4：协议级缓存语义     | MCP 响应的 `ttlMs`/`cacheScope` 字段                     | 告诉 MCP 客户端（如 Claude Desktop）这份 `tools/list` 结果可缓存多久 |

P4 **不是替换**已有缓存，而是**新增协议层缓存提示**，并探索两者协同（如协议层 `ttlMs` 可参考工具层缓存的剩余有效期）。

### 设计大纲

1. **设置 `cacheHints`**（v2 SDK 方式）：
   - `ServerOptions.cacheHints`：全局默认。
   - `registerResource` 的 `cacheHint`：按资源配置。
   - `tools/list` 结果：根据工具集稳定性给合理 `ttlMs`（工具集稳定时可给较长 ttl，提升客户端 prompt cache 命中率）。

2. **网关差异化**：
   - Hub 聚合多个 server，`tools/list` 的 `ttlMs` 可取**所有上游 server 工具列表的最小稳定性**。
   - 配置驱动的 `cacheScope`（public/private）。

3. **`tools/list` 确定性排序**（2026-07-28 新增 SHOULD）：
   - 协议要求 server 以**确定性顺序**返回 tools，使客户端能稳定缓存 `tools/list` 结果、提升 LLM prompt cache 命中率。
   - 现状：项目零实现（grep `sort.*tool` 无命中）。
   - P4 范围内需给 `tools/list` 加稳定排序键（如按 `name` 字典序，或配置指定的稳定顺序）；**与 `ttlMs` 强相关**——只有顺序稳定，客户端缓存才有意义。

4. **与现有 `CacheManager` 协同**：
   - 工具调用结果缓存的剩余 ttl 可作为协议层 `ttlMs` 的输入。

### 关键决策点（待 brainstorming）

- `tools/list` 的 `ttlMs` 默认值？（工具集通常稳定，可较长；但配置变更时需失效）
- 是否实现 `RedisCacheManager`（当前 no-op）以支持多实例缓存共享？
- `cacheScope` 默认 public 还是 private？

### 现有挂载点

- `CacheManager` 接口（`cache-manager.ts`：`get/set(ttl)/getStats/setStrategy`），`MemoryCacheManager` 可用。
- `RedisCacheManager`（L338-377）是 no-op 占位，多实例场景需先实现。

---

## P5: `subscriptions/listen` + MRTR

- **状态**: **实现完成**（分支 `feat/p5-subscriptions-mrtr`，待合并 main；详细设计见 [`2026-07-30-p5-subscriptions-mrtr-design.md`](./2026-07-30-p5-subscriptions-mrtr-design.md)）
- **复杂度**: 中高
- **依赖**: 强依赖 P1
- **价值**: ⭐（客户端侧支持还弱，网关先做基础设施兑现）

> 历史背景：P5 原为「主动推迟」状态（观望客户端生态），4 个复查触发条件为：客户端跟进 / 日期复查（2026-10-25）/ 上游 server 需求 / 协议 GA 推动。**2026-07-30 复查结论**：MCP TypeScript SDK 已于 2026-07-27 发布 GA 版 2.0.0（项目此前锁定 beta.5），「协议 GA 推动 / SDK GA」触发条件已满足，故启动 P5。本轮先把网关侧基础设施做扎实，客户端跟进后即可兑现。完整启动决策与范围见详细设计 spec。

### 交付内容（DoD）

- **subscriptions/listen**：上游工具变更检测（listChanged 订阅 + 60s 轮询兜底，两者结合）→ fan-out 到含该 server 的所有 group → 客户端经 `subscriptions/listen` stream 收 `notifications/tools_list_changed`（e2e 验证）。
- **MRTR（InputRequiredResult）**：Hub mint 自己的 requestState（HMAC-SHA256）作 opaque 句柄，内部映射到上游 server + 上游原始 state；重试时 verify 还原并透传 inputResponses（e2e 验证）。
- **SDK 升级**：beta.5 → 2.0.0 GA。
- **配置集成**：`system.json` 新增 `subscriptions`（pollIntervalMs/pollBackoffMs/fanoutDebounceMs/enabled）与 `mrtr`（stateTtlSeconds/stateKey/enabled）字段，整块 optional + 默认值，向后兼容。
- **回归**：typecheck（share/core/backend/cli/frontend）+ 603 backend unit + 152 share unit + 33 api-e2e + 16 oauth/validation/outbound e2e 全绿。

### 推迟理由（已作废，保留供历史参考）

`subscriptions/listen` 和 MRTR（Multi Round-Trip Requests）是 `2026-07-28` 的新能力，但：

### 复查触发条件（P5）

满足以下任一条件即重新评估是否启动 P5：

| 触发条件             | 说明                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **客户端跟进**       | Claude Desktop / Cursor 等主流客户端的 changelog 出现对 `subscriptions/listen` 或 MRTR（`InputRequiredResult`）的支持声明 |
| **日期复查**         | 距上次评估满 1 个季度（下次复查：2026-10-25）                                                                             |
| **上游 server 需求** | Hub 接入的外部 MCP server 普遍开始声明 `listChanged` 或发起 server-side 请求，网关不转发会成为功能缺口                    |
| **协议 GA 推动**     | 2026-07-28 协议从 RC 转正式，客户端实现率明显提升                                                                         |

复查时关注：各客户端版本对两项能力的支持矩阵、SDK v2 GA 后 `subscriptions` 总线 API 是否稳定。

### 范围（未来启动时）

1. **`subscriptions/listen`**：
   - 用 `createMcpHandler` 返回的 `.notify.{toolsChanged, promptsChanged, resourcesChanged, resourceUpdated(uri)}` 总线。
   - 替代旧的 `resources/subscribe`/`resources/unsubscribe` + HTTP GET 端点。
   - Hub 聚合多个上游 server 的变更通知，转发给客户端。

2. **MRTR（`InputRequiredResult`）**：
   - 工具 handler 返回 `inputRequired(...)`。
   - 需要 `ServerOptions.requestState.verify` codec 管理 server-minted 状态句柄。
   - 替代旧的 `elicitation/create`、`sampling/createMessage`、`roots/list` 等服务端发起请求。

### 关键决策点（未来 brainstorming）

- 网关如何聚合多个上游 server 的 listChanged 通知？
- MRTR 的 `requestState` 在无状态网关里怎么管理（不能存内存 session）？

### 现状

- **subscriptions/listen**：已实现上游工具变更检测 + fan-out + `subscriptions/listen` 总线接线（e2e 验证客户端经 listen 收 `notifications/tools_list_changed`）。
- **MRTR**：已实现 Hub 级 requestState 中转（mint/verify/resume），handler 识别 `InputRequiredResult` 并透传上游 inputResponses（e2e 验证上游 input_required 全链路中转）。
- 两条主线均受 `system.json` 的 `subscriptions.enabled` / `mrtr.enabled` 开关控制，默认启用。

---

## P6: OTel trace context + 弃用项清理

- **状态**: 待 brainstorming
- **复杂度**: 低
- **依赖**: 无（可穿插）
- **价值**: ⭐ 可观测性 + 代码债清理

### 范围

1. **OTel trace context 传播**（SEP-414）：
   - `_meta` 里 `traceparent`/`tracestate`/`baggage` 的读写约定。
   - Hub 作为网关，从客户端请求提取 trace context，传播到上游 server 调用（分布式追踪）。

2. **弃用项清理**（2026-07-28 Deprecation）：
   - **Roots/Sampling/Logging**：项目当前零实现（已验证 grep 无命中），**直接不采用**，无需清理。
   - **Tasks wire vocabulary**（`Task`/`TaskStatus`/`CreateTaskResult`/`tasks/list` 等，2026-07-28 标 `@deprecated`）：项目当前零实现（已验证 grep `tasks/capability`/`CreateTaskResult`/`TaskStatus` 等均无命中），**直接不采用**，无需清理。
   - **HTTP+SSE 传输**：P1 已处理（删除 `/sse` 端点）。
   - **`includeContext` 的 `thisServer`/`allServers`**：检查是否使用，未用则忽略。
   - **DCR（RFC7591）**：P2 入站 OAuth 时优先用 Client ID Metadata Documents，不采用 DCR。

3. **日志统一**（顺带）：
   - 审计报告指出 25+ 处生产代码绕过统一 Logger 走 `console.*`（当前分支正在修）。
   - 弃用 Logging 特性后，日志统一走 stderr + OTel。

### 关键决策点（待 brainstorming）

- OTel 接入到什么程度？只做 trace context 传播，还是接完整 OTel SDK 导出？
- 是否在本子项目实现 `RedisCacheManager`（支撑 P3/P4 多实例）？

### 现状

- OTel：零接入。
- Roots/Sampling/Logging：零实现（干净）。

---

## 跟踪机制

- 每个子项目完成后，回本 spec 更新"实现进度"列和"详细 spec"链接。
- 主线顺序（P1 → P4 → P2 → P3 → P6 → P5 → P7）是推荐，可根据实际情况调整。
- P5 已实现完成（分支 `feat/p5-subscriptions-mrtr`，待合并 main）。原推迟理由与复查触发条件见上文「推迟理由（已作废）」/「复查触发条件」。
- P7 已实现完成（分支 `feat/p7-protocol-compat-layer`，待合并 main）。P7 叠加于 P1 之上：把 P1 的"激进入站"修订为"默认全开可配置"，并新增协议兼容层（双向 era 翻译、归一化模型、统一错误）。详见 [`2026-08-02-protocol-compat-layer-design.md`](./2026-08-02-protocol-compat-layer-design.md)。

## 实现进度跟踪

> 本节是跨子项目的进度锚点，**只记录可客观验证的状态**（grep 命中数、测试结果、已合并的 commit），不记主观判断。每个子项目启动时更新对应行。

### P1 DoD 锚点（来自 `2026-07-25-p1-transport-upgrade-design.md` §6）

| DoD 项                      | 验证命令                                                            | 最近核实       | 状态                                                                     |
| --------------------------- | ------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| v1 包完全移除               | `grep -rn '@modelcontextprotocol/sdk' . --exclude-dir=node_modules` | 2026-07-25     | 🟡 残留 1 处（`backend/src/types/mcp-content.ts:8` 注释引用，非 import） |
| codemod 标记零命中          | `grep -rn '@mcp-codemod-error' . --exclude-dir=node_modules`        | 2026-07-25     | ✅ 0 命中（命中的 7 处均在 docs，非代码）                                |
| typecheck 通过              | `pnpm typecheck`                                                    | 待 P1 收尾时跑 | ⬜ 待核实                                                                |
| 测试全绿                    | `pnpm test`                                                         | 待 P1 收尾时跑 | ⬜ 待核实                                                                |
| 4 个新增 e2e 用例           | 见 P1 spec §5.3                                                     | —              | ⬜ 待核实                                                                |
| Node 18 失败 / Node 20 正常 | engines 已设 `>=20`                                                 | 2026-07-25     | 🟡 engines 已改，运行时验证待核实                                        |

### 各子项目实现进度

| 子项目 | 分支                           | 关键 commit                                                                                                                                              | 进度                                                                                                                        |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P1     | 已合并 main                    | `f802256` 用 createMcpHandler 重写 group-router；`6aedf23` SDK v2 codemod                                                                                | ✅ **实现完成**（已合并 main）                                                                                              |
| P4     | 已合并 main（merge `a03f430`） | `2b75c39` 注册 4 个 Hub 元数据 resources；`660e45b` tools/list 确定性排序；`8018afc` McpServer 构造接入 cacheHints                                       | ✅ **实现完成**（typecheck + 1683 tests 全绿，含 5 个 P4 e2e）                                                              |
| P2     | 已合并 main（merge `768ff09`） | `0ffb6b8` 主线接入 + internal 模式 token 验签；`f6a82c4` OAuth 端点；`8d966f3` Resource Server 编排                                                      | ✅ **实现完成**（typecheck + 1750 tests 全绿，含 5 个 P2 e2e）                                                              |
| P3     | 已合并 main（merge `5865277`） | `ff482e3` OAuthStrategy 实现（client_credentials + refresh + cache）；`f98d7c5` AuthenticationManager 注册；`5194ed2` e2e 骨架；`6de3416` e2e 全链路激活 | ✅ **实现完成**（typecheck + 1783 tests 全绿；e2e 已激活，经 `/api/api-to-mcp/configs/:id/test` 触发，fixture schema 已修） |
| P6     | 已合并 main（merge `6a2f11b`） | `75c2b4e` TraceContextStore；`3cbb207` 出站 callTool 注入 \_meta；`c94d68c` 入站 handler 提取（mcpReq.\_meta）；`a7d125b` 集成测试                       | ✅ **实现完成**（typecheck + 542 unit tests 全绿，含 22 个 P6 新测试；弃用项/日志已核实干净）                               |
| P5     | `feat/p5-subscriptions-mrtr`（待合并 main） | `a3ccb26` SDK beta.5→2.0.0 GA 升级；`cf20273`/`1b41a45` UpstreamChangeDetector + listChanged handler；`09098fd`/`8274335` Fanout + subscriptions/listen 接线 + e2e；`1c332d8` MrtrRelayService；`8724ab3`/`13fde56` 重试上下文透传 + handler 中转；`6953ab4` factory 注入 verify；`be6eeb5` MRTR e2e；Task 10 配置集成 + 文档 | ✅ **实现完成**（分支待合并；typecheck + 603 unit/152 share/33+16 e2e 全绿，含 2 个 P5 e2e：subscriptions + MRTR） |
| P7     | `feat/p7-protocol-compat-layer`（待合并 main） | `def2240` 包脚手架；`d1a81a0` CompatibilityOptions；`633c5d6` 归一化模型；`e80a900` UnifiedErrorNormalizer；`e3c4b96` InboundProtocolAdapter；`5487179` OutboundProtocolAdapter；`fbfc5df` HubMrtrCodec；`033fd71` SystemConfig 接入；`8bcff1d` backend 入站 legacy shim + 出站 era 探测；`7c31257` CLI flag；`3e36b48` fixture；`499d9cd` 跨 era 桥接 + legacy 入站 e2e；`7f94cf0`/`a73b0ac` conformance TCK 接入 | ✅ **实现完成**（分支待合并；typecheck + 全量测试全绿，含跨 era 桥接 + legacy 入站 e2e + conformance TCK 自包含） |

## 跨子项目共享待办

> 以下事项被多个子项目反复引用，为避免重复认领或遗漏，集中在此登记归属。每项标明"归谁、何时做、现状"。移交给归属子项目后，对应子项目 spec 需 mirror 一份。

| 事项                                                                                          | 归属                      | 何时做                                                                       | 现状                                                                                                                                                                                                                              | 涉及子项目                                         |
| --------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `RedisCacheManager`（当前 no-op，`cache-manager.ts:338-377`）                                 | P6（候选）或独立基建      | P3 多实例前必须实现                                                          | 🟡 no-op 占位；**P4 评估确认协议层 cacheHint 不依赖 Redis**；**P2 的 introspection/JWKS 内存缓存 MVP 不依赖 Redis，多实例部署需 P6 实现后接入**                                                                                   | P2（OAuth 缓存）、P3（token 存储）、P6（候选归属） |
| ~~`simple-auth.ts` 假认证（任何非空 token 放行）~~                                            | ~~P2~~                    | —                                                                            | ✅ **已核实：当前代码不存在该文件**（spec 描述滞后，可能 P1 时清理），无需处理                                                                                                                                                    | —                                                  |
| ~~`message-audit-service.ts` 用户归因硬编码 `'admin'`~~                                       | ~~P2~~                    | —                                                                            | ✅ **已核实：当前 `message-audit-service.ts` 无 'admin' 硬编码**，message 结构无 user 字段，描述过时                                                                                                                              | —                                                  |
| 组级 validationKey 在 MCP 端点未强制（`group-router.ts` 只校验组存在）                        | ✅ P2 已修复              | P2 一并修复                                                                  | ✅ **P2 已通过 `mcp-auth` 中间件强制**（启用了 validation 的组现在必须带正确 key）                                                                                                                                                | P2                                                 |
| ~~`console.*` 绕过统一 Logger（25+ 处）~~                                                     | ~~P6~~                    | —                                                                            | ✅ **P6 已核实：`backend/src` 生产代码 console.\* = 0 处**（统一 Logger `@mcp-core/mcp-hub-share` 已全量接入）；`packages/cli` 的 console.\* 是 CLI stdout（合理），`packages/share` 是 logger 实现本身。原描述"25+ 处正在修"滞后 | —                                                  |
| ~~出站连 MCP server 的 token 获取/刷新（原只透传静态 `headers`，`server_manager.ts`）~~ | ✅ **已完成**（2026-07-30） | 已立项并完成 | ✅ **已完成**：`server_manager.ts` 的 SSE/Streamable 连接接入 SDK 原生 `authProvider`（bearer 静态 token + oauth `ClientCredentialsProvider`），动态获取/刷新 token。详见 `2026-07-30-outbound-mcp-server-oauth-design.md`（commits `f9c5a46`..`cf16b1a`） | — |

## 未采纳/待评估协议特性

> 对照 2026-07-28 完整特性集，以下特性经评估**显式不纳入本轮迭代范围**。记录决策理由，避免后续重复评估；状态变化时回这里更新。

| 特性                                                                            | 协议状态                | 决策          | 理由                                                                                                                 | 复查条件                                                             |
| ------------------------------------------------------------------------------- | ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **MCP Apps**（server-rendered UI，通过 `extensions` capability 协商）           | 2026-07-28 新增扩展机制 | 🚫 不纳入本轮 | Hub 定位是协议网关/聚合层，不渲染 UI；Apps 属于 server 端能力，非网关职责                                            | 若未来 Hub 需托管 server-rendered UI，或客户端生态普遍支持后重新评估 |
| **`x-mcp-header` / `Mcp-Param-` 透传**（SEP-2243，工具参数→自定义 HTTP header） | 2026-07-28 新增         | ⏸ 待确认      | 需核实 `@modelcontextprotocol/hono` 的 `createMcpHandler` 是否已自动处理 header 校验与透传；若自动处理则无需额外工作 | P1 收尾时验证 SDK 行为，结论回填此处                                 |

## 风险与缓解（全局）

| 风险                                     | 缓解                                                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK v2 还在 beta，可能有 breaking change | 跟踪 GA；版本用 codemod 输出而非手钉。**复查节点**：每次启动新子项目前查 `@modelcontextprotocol/sdk` releases；GA 发布后在 changeset 里把 `2.0.0-beta.5` 升正式版（当前锁版本，下次复查默认 2026-08-25） |
| 子项目间隐性依赖未识别                   | 每个子项目 brainstorming 时复查与本 spec 的依赖声明 + [跨子项目共享待办](#跨子项目共享待办) 表                                                                                                           |
| 协议演进导致与主流客户端不兼容           | ~~P1 激进入站~~ **已由 P7 修订**：入站默认全开（modern + legacy），可配置收窄；P1 验证 Claude Desktop 等对新协议的支持情况，必要时再调整 CompatibilityOptions                                                                                                                                          |
| 范围蔓延（子项目越做越大）               | 每个子项目独立 spec，严格按 spec 范围控制；相邻问题归入 [跨子项目共享待办](#跨子项目共享待办) 而非塞进当前子项目                                                                                         |
| 出站保留 SSE 连接成为长期维护负担        | **退出条件**：当 Hub 接入的外部 MCP server 普遍只支持 Streamable HTTP（可统计配置中 SSE 型 server 占比），且主流 SDK 客户端弃用 `SSEClientTransport` 时，移除出站 SSE 支持。未达条件前保留               |

## 参考资料

- [MCP 2026-07-28 Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP Draft Changelog](https://modelcontextprotocol.io/specification/draft/changelog)
- [MCP 2025-11-25 Authorization Spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [SDK v1→v2 Migration Guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [Adopting 2026-07-28 Guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [WorkOS: MCP 2026 spec agent authentication](https://workos.com/blog/mcp-2026-spec-agent-authentication)
