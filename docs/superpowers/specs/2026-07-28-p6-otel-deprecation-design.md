# P6 详细设计：OTel trace context 传播 + 弃用项清理

- **状态**: Draft（待实现）
- **日期**: 2026-07-28
- **作者**: yourtion
- **关联**:
  - `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md`（总体跟踪，P6 章节）
  - P1 `2026-07-25-p1-transport-upgrade-design.md`（传输层升级，本子项目落点的上游）
  - [SEP-414 OTel trace context propagation](https://modelcontextprotocol.io/seps/414-request-meta)

## 1. 目的与范围

### 1.1 目的

实现 MCP `2026-07-28` 的 OTel trace context 传播（SEP-414），使 Hub 作为网关从客户端请求提取 trace context 并传播到上游 server 调用（分布式追踪）。同时记录弃用项清理的核实结论。

### 1.2 核实结论：原 spec 描述修正

总体跟踪 spec 的 P6 章节描述了三块工作（OTel、弃用项清理、日志统一）。经代码核实，**实际范围显著缩小**：

| 块                     | 原 spec 描述              | 核实结论                                                                                                               | P6 是否有工作               |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **OTel trace context** | 零接入                    | 确认零接入（`package.json` 无 `@opentelemetry/*`）                                                                     | ✅ **P6 核心，全部工作量**  |
| **弃用项清理**         | 需清理若干弃用特性        | 全部零实现，已干净（见 §4）                                                                                            | ❌ 无代码工作，仅文档化结论 |
| **日志统一**           | 25+ 处 `console.*` 正在修 | 项目已有完整统一 Logger（`@mcp-core/mcp-hub-share` 的 `UnifiedLogger`），`backend/src` 生产代码 `console.*` = **0 处** | ❌ 无工作，原描述滞后       |

> **修正**：总体跟踪 spec §跨子项目共享待办中"console.\* 绕过统一 Logger（25+ 处）归属 P6"一项，核实为已完成，应在 P6 收尾时回填为 ✅。

**因此 P6 实质上 = OTel trace context 传播**。本文档围绕此展开，弃用项与日志以核实结论文档化收尾。

### 1.3 范围内

1. **入站提取**：从 MCP 客户端请求的 `_meta`（SEP-414 官方载体）提取 `traceparent`/`tracestate`/`baggage`。
2. **请求作用域透传**：用 `AsyncLocalStorage` 在请求异步链内透传 context。
3. **出站注入**：Hub 调用上游 MCP server 时（`server_manager.executeToolOnServer` → `client.callTool`），将 context 注入请求 `_meta`。
4. **入站 HTTP header 兼容**（次要）：兼容从 W3C HTTP header 携带 context 的非 MCP 标准客户端。

### 1.4 范围外

| 事项                                  | 是否 P6              | 理由                                                                      |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| OTel SDK 接入 + exporter 导出（OTLP） | ❌ 范围外            | 决策为仅做 context 传播，不接完整 SDK（见 §2.3）                          |
| api-to-mcp REST API 出站 trace 注入   | ❌ 范围外（stretch） | P3 刚动过 `api-to-mcp` 子系统，本轮聚焦 MCP server 出站主链路             |
| `RedisCacheManager` 实现              | ❌ 范围外            | 跨子项目共享待办，独立基建，不属 P6 核心（见总体 spec §跨子项目共享待办） |
| Trace 采样 / Span 生成 / 指标         | ❌ 范围外            | Hub 仅传播 context，不生产 trace                                          |
| 弃用项的代码清理                      | ❌ 无需              | 全部零实现，已干净（见 §4）                                               |

## 2. 核心设计决策

### 2.1 决策 1：`_meta` 为唯一 MCP 协议载体（严格 SEP-414）

SEP-414 明确规定 trace context 通过 JSON-RPC `params._meta` 携带，键为 `traceparent`/`tracestate`/`baggage`，遵循 W3C Trace Context 与 W3C Baggage 格式。**这是 transport-agnostic 的选择**——stdio transport 没有 HTTP header，`_meta` 是所有 transport 共有的扩展点。

| 方向                          | 载体    | 落点                                                          |
| ----------------------------- | ------- | ------------------------------------------------------------- |
| 入站（client → Hub）          | `_meta` | McpServer tool handler 的 `extra._meta`                       |
| 出站（Hub → upstream server） | `_meta` | `client.callTool({ name, arguments, _meta })` 的 `_meta` 参数 |

> **不使用 transport 的 `requestInit.headers` 或 `RequestOptions.headers`**：那些是连接级 auth/protocol-version 和 SEP-2243 `Mcp-Param-*` 的通道，且对 stdio transport 无效。研究确认 TS SDK `Client.callTool`/`listTools`/`listResources` 均支持 per-request `_meta`，原样进入出站 JSON-RPC `params._meta`。

### 2.2 决策 2：AsyncLocalStorage 透传（对现有代码侵入最小）

context 从入站提取点透传到出站注入点，采用 Node `AsyncLocalStorage`（方案 A）。

| 备选方案                 | 评估                                                                                               | 结论                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------- |
| **A. AsyncLocalStorage** | 不改 `executeToolCall`/`executeToolOnServer` 签名；Hono/fetch 请求异步链天然在 scope 内；Node 标准 | ✅ **采用**                |
| B. 显式参数传递          | 需改 `GroupMcpService`/`server_manager` 多个核心方法签名；SDK tool handler 边界会打断参数透传      | ❌ 侵入大、不可行          |
| C. 仅入站提取 + 日志关联 | 不传播到上游，trace 在 Hub 断裂                                                                    | ❌ 不满足 SEP-414 传播职责 |

**ALS scope 安全保证**：`store.run(ctx, fn)` 保证 context 只在该请求的异步链内可见。Hub 处理一次工具调用的链路（`handler.fetch` → tool handler → `executeToolCall` → `executeToolOnServer` → `callTool`）是连续的 `await` 链，不脱离 ALS scope。

### 2.3 决策 3：零 OTel SDK 依赖（仅字符串透传）

不引入 `@opentelemetry/api` 或 `@opentelemetry/core`，自行实现 W3C trace context 的**纯字符串透传**：

- Hub 是 trace context 的**传播者**，不是 trace 生产者——不解析 `traceparent`、不验证格式、不重新生成 `spanId`、不采样。
- 只把客户端带来的 `{ traceparent, tracestate, baggage }` 原值在 ALS 内搬运，出站时原样注入。
- 降低出错面、零外部依赖、零运行时开销。

> 与完整 OTel SDK 方案的对比：SDK 方案会引入 propagator/sampler/resource/exporter 的配置复杂度和运行时开销，对 0.0.1 阶段的网关过重；且 TS SDK 尚未内置自动 `_meta.traceparent` 注入（typescript-sdk#2196 跟踪中），即便接 SDK 也需手动注入，收益有限。

### 2.4 决策 4：出站聚焦 MCP server 主链路

| 出站路径                                                | 是否 P6    | 理由                            |
| ------------------------------------------------------- | ---------- | ------------------------------- |
| Hub → 外部 MCP server（`server_manager.callTool`）      | ✅ MVP     | 网关主链路，trace 价值最高      |
| Hub → 外部 REST API（`api-to-mcp` 的 `http-client.ts`） | ❌ stretch | P3 刚动过该子系统，本轮避免回归 |

## 3. 架构与组件设计

### 3.1 数据流

```
MCP 客户端
  │  POST /:group/mcp   JSON-RPC tools/call
  │  params._meta = { traceparent, tracestate, baggage }   ← 客户端注入（SEP-414）
  ▼
┌─────────────────── Hub 入站（backend/src/api/mcp）──────────────────┐
│ group-router.ts (Hono POST /:group/mcp)                              │
│   └─ mcp-handler-factory.createGroupMcpHandler                       │
│       └─ handler.fetch(c.req.raw) → createMcpHandler factory         │
│           └─ GroupMcpService.getMcpServer()                          │
│               └─ McpServer.registerTool handler (args, extra)        │
│                   ★ 入站提取：extractFromMeta(extra._meta)           │
│                   ★ ALS 注入：runWithTraceContext(ctx, () => ...)    │
│                   └─ coreServiceManager.executeToolCall(...)         │
└──────────────────────────────────────────────────────────────────────┘
  │  ALS 作用域内（同一 await 异步链，不脱离 scope）
  ▼
┌─────────────────── Hub 出站（backend/src/services）─────────────────┐
│ server_manager.executeToolOnServer(serverId, toolName, args)        │
│   ★ 出站读取：getCurrentTraceContext()                              │
│   ★ 条件注入：hasTraceContext(ctx) 时加 _meta                       │
│   └─ server.client.callTool({                                        │
│         name, arguments,                                             │
│         _meta: { traceparent, tracestate, baggage }                  │
│       })                                                             │
└──────────────────────────────────────────────────────────────────────┘
  │
  ▼
外部 MCP server（收到带 _meta 的 JSON-RPC，延续同一 trace）
```

### 3.2 组件清单

必做 3 项（1 个新文件 + 2 个修改点），外加 1 项可选 stretch：

| 组件                  | 位置                                                              | 职责                                        | 改动类型 | 必做？         |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------- | -------- | -------------- |
| `TraceContextStore`   | `backend/src/middleware/trace-context.ts`（**新文件**）           | AsyncLocalStorage store + 提取/注入辅助     | 新增     | ✅ 必做        |
| 入站提取点            | `backend/src/api/mcp/group-service.ts`（工具 handler）            | 从 `extra._meta` 提取，ALS 包裹             | 修改     | ✅ 必做        |
| 出站注入点            | `backend/src/services/server_manager.ts`（`executeToolOnServer`） | 从 ALS 读取，注入 `callTool._meta`          | 修改     | ✅ 必做        |
| 入站 HTTP header 兼容 | `backend/src/api/mcp/group-router.ts`（中间件）                   | 从 W3C header 提取存 ALS，兼容非 MCP 客户端 | 修改     | ⏸ 可选 stretch |

### 3.3 组件 1：`TraceContextStore`（新文件）

**文件**：`backend/src/middleware/trace-context.ts`

**依赖**：仅 Node 内置 `async_hooks`，零外部依赖。

**接口**：

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

/** W3C Trace Context 三件套（纯字符串透传，不解析） */
export interface TraceContext {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

/** 从 MCP 请求 _meta 提取（SEP-414 官方载体） */
export function extractFromMeta(meta?: Record<string, unknown>): TraceContext;

/** 从 W3C HTTP header 提取（兼容非 MCP 标准客户端） */
export function extractFromHeaders(headers: Headers): TraceContext;

/** 在请求作用域内运行，注入 context 到 ALS */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T>;

/** 出站读取当前请求作用域的 context（无则返回空对象） */
export function getCurrentTraceContext(): TraceContext;

/** 判断是否有有效 context（决定是否注入） */
export function hasTraceContext(ctx: TraceContext): boolean;
```

**行为约定**：

- `extractFromMeta` / `extractFromHeaders`：只取字符串类型字段，非字符串忽略；任一字段缺失返回 `undefined`。
- `runWithTraceContext`：若 `ctx` 三字段全空，则以 `{}` 进入 scope（不阻断流程）；否则以 `ctx` 进入。
- `getCurrentTraceContext`：scope 外调用返回 `{}`（不抛错，出站注入判断为 false）。
- `hasTraceContext`：三字段任一非空即 true。

### 3.4 组件 2：入站提取点（`group-service.ts`）

**改动位置**：`backend/src/api/mcp/group-service.ts` 的动态工具 `registerTool` handler（当前 L622 附近）。

**改法**：handler 取第二参 `extra`，从 `extra._meta` 提取，用 `runWithTraceContext` 包裹原有逻辑。

```typescript
// 伪代码：改动示意
this.mcpServer.registerTool(toolName, { inputSchema: z.object(zodSchema) }, async (args, extra) => {
  const traceCtx = extractFromMeta(extra?._meta);
  return runWithTraceContext(traceCtx, async () => {
    // ── 原有 handler 逻辑保持不变 ──
    const result = await this.coreServiceManager.executeToolCall(tool.name, args, tool.serverId);
    // ...（返回格式转换逻辑不变）
  });
});
```

**说明**：

- 入站提取**只在工具 handler 做**：`tools/call` 是触发上游调用的主链路；`tools/list`/`resources/list` 等列表请求不触发上游 server 调用，无需 trace。
- `group_status`、`list_group_tools` 这两个内置工具（L280/L307）不调用上游 server，**无需包裹** trace context（包裹了也无害，但非必要，保持最小改动）。
- 防御性：`extra?._meta` 用 optional chaining，兼容 SDK 版本差异。

### 3.5 组件 3：出站注入点（`server_manager.ts`）

**改动位置**：`backend/src/services/server_manager.ts` 的 `executeToolOnServer`（当前 L307 的 `callTool` 调用）。

**改法**：`callTool` 前从 ALS 读取 context，条件注入 `_meta`。**不改 `executeToolOnServer` 方法签名**。

```typescript
// 伪代码：改动示意
const traceCtx = getCurrentTraceContext();
const callParams: {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: Record<string, string>;
} = {
  name: toolName,
  arguments: args,
};
if (hasTraceContext(traceCtx)) {
  callParams._meta = Object.fromEntries(
    Object.entries(traceCtx).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}
const response = await server.client.callTool(callParams);
```

**说明**：

- 条件注入：无 context 时**不加** `_meta`，避免给无 trace 的请求塞空对象。
- 所有 transport 通用：SSE/streaming/stdio 的 `callTool` 都走同一 JSON-RPC `_meta`，无需区分 transport。
- `listTools` 等出站调用（L224）当前**不注入**：工具发现是连接初始化时一次性调用，不在客户端请求的 trace 上下文内（发生在 `initialize` 阶段，早于任何客户端 `tools/call`）。MVP 不处理。

### 3.6 组件 4（可选）：入站 HTTP header 兼容（`group-router.ts`）

**目的**：兼容从 W3C HTTP header（`traceparent`/`tracestate`/`baggage`）携带 context 的客户端（标准 OTel-instrumented HTTP 客户端，非 MCP `_meta` 方式）。

**做法**：在 `group-router.ts` 的 POST 路由加一个中间件，从 `c.req.raw.headers` 提取 context 存入 ALS。工具 handler 内的 `extractFromMeta` 若 `_meta` 无 context，可回退读取 ALS 中已存的 header context。

> **优先级处理**：若 HTTP header 和 `_meta` 同时存在，以 `_meta` 为准（SEP-414 是 MCP 官方载体）。实现上：header 中间件先写入 ALS 外层，工具 handler 再用 `_meta`（若有）覆盖写入内层 ALS scope。

**此组件为可选 stretch**：若时间紧张可先不做，仅依赖 `_meta`（MCP 客户端按 SEP-414 应走 `_meta`）。HTTP header 兼容主要服务于"客户端是通用 OTel HTTP 库而非 MCP SDK"的场景。

## 4. 弃用项清理核实结论（文档化，无代码改动）

对照 MCP `2026-07-28` Deprecation，逐项核实项目现状，全部已干净，**P6 无需任何代码清理**。记录结论避免后续重复评估。

| 弃用项                                                           | 协议状态               | 核实方法                                                               | 结论                                                                                                        |
| ---------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `includeContext` 的 `"thisServer"`/`"allServers"` 取值           | Deprecated（SEP-2596） | `grep -rn "includeContext" backend/src packages/core/src`（排除 test） | ✅ 零使用（命中的 `allServers` 均为无关局部变量名），无需清理                                               |
| Roots / Sampling / Logging 特性                                  | Deprecated（SEP-2577） | `grep -rn "roots/list\|sampling/createMessage\|elicitation/create"`    | ✅ 零实现，直接不采用                                                                                       |
| Tasks wire vocab（`tasks/list`/`TaskStatus`/`CreateTaskResult`） | 移入扩展（SEP-2663）   | `grep -rn "tasks/list\|CreateTaskResult\|TaskStatus"`                  | ✅ 零实现                                                                                                   |
| HTTP+SSE 传输（`/sse` 端点）                                     | Deprecated（SEP-2596） | `grep -rn "'/sse'\|\"/sse\"" backend/src`                              | ✅ 生产代码已删（P1 处理）；仅 `test-app.ts:323` 残留（测试用途，保留）                                     |
| `ping` / `logging/setLevel` / `notifications/roots/list_changed` | 协议已移除（SEP-2575） | `grep -rn "logging/setLevel\|notifications/roots/list_changed"`        | ✅ 无残留（`sse_event_manager.ts:461` 的 `type:'ping'` 是 Dashboard 业务 SSE 心跳，与 MCP `ping` RPC 无关） |
| DCR（RFC7591）                                                   | Deprecated（PR#2858）  | P2 已采用 Client ID Metadata Documents                                 | ✅ 已规避                                                                                                   |

## 5. 日志统一核实结论（文档化，无代码改动）

**核实**：项目已有完整统一 Logger 系统——`packages/share/src/logger.ts` 提供 `UnifiedLogger`，`backend/src/utils/logger.ts` 和 `packages/core/src/utils/logger.ts` 均基于其实现并全量接入。

| 位置                                                 | `console.*` 数量              | 性质                                                | 处理                                           |
| ---------------------------------------------------- | ----------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `backend/src`（生产代码，排除 test/e2e/integration） | **0**                         | —                                                   | ✅ 已干净                                      |
| `packages/core/src`（排除 test-utils/mock）          | 1（`mock-api-server.ts:184`） | mock 测试服务器                                     | 保留（测试用）                                 |
| `packages/cli/src`                                   | 55                            | CLI 工具 stdout 输出（`--version`/`--help`/banner） | 保留（CLI 合理走 stdout，不应走结构化 logger） |
| `packages/share/src`                                 | 14                            | logger 实现本身（`ConsoleWriter`）+ CLI banner 方法 | 保留（logger 底层实现）                        |

**结论**：P6 日志统一**无工作可做**。原总体 spec 描述"25+ 处 console.\* 正在修"为滞后信息。

## 6. 测试策略

### 6.1 测试矩阵

| 层   | 文件                                          | 覆盖点                                                                                                                                                                                     | 类型 |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 单元 | `trace-context.unit.test.ts`（新）            | `extractFromMeta`/`extractFromHeaders` 字符串提取；`runWithTraceContext` scope 隔离（并发请求不串）；`getCurrentTraceContext` scope 外返回 `{}`；`hasTraceContext` 判断；空 context 不阻断 | 新增 |
| 单元 | `server_manager.unit.test.ts`（扩展）         | ALS 有 context 时 `callTool` 收到 `_meta` 且三件套正确；无 context 时 `callTool` 无 `_meta`；`_meta` 不含 `undefined` 值                                                                   | 扩展 |
| e2e  | `trace-context-propagation.e2e.test.ts`（新） | 客户端带 `_meta.traceparent` → Hub → mock 上游 server 断言收到的 `params._meta.traceparent` 与发送一致（未丢失/未篡改）；无 context 时上游不收 `_meta`                                     | 新增 |

### 6.2 关键 e2e 断言

e2e 仿照 P3/P4 的 mock 上游 server 模式：

1. 客户端发 `tools/call`，`params._meta.traceparent = "00-<traceId>-<spanId>-01"`。
2. Hub 路由到该组，触发对 mock 上游 server 的 `callTool`。
3. mock 上游 server 记录收到的请求 `params._meta`。
4. 断言：`recordedMeta.traceparent === "00-<traceId>-<spanId>-01"`，且 `tracestate`/`baggage`（若有）一致。

这证明 trace context 穿过 Hub 完整传播、未被篡改。

### 6.3 DoD（完成定义）

| DoD 项                             | 验证方法                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| `TraceContextStore` 单元测试全绿   | `pnpm test trace-context`                                   |
| `server_manager` 出站注入测试全绿  | `pnpm test server_manager`                                  |
| trace 传播 e2e 通过                | `pnpm test:e2e trace-context`（或对应 e2e 命令）            |
| typecheck 通过                     | `pnpm typecheck`                                            |
| 全量测试无回归                     | `pnpm test` 全绿                                            |
| 弃用项/日志核实结论已回填总体 spec | 总体 spec §跨子项目共享待办 console.\* 项标 ✅，P6 状态更新 |

## 7. 风险与缓解

| 风险                                                          | 缓解                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ALS 跨异步边界丢失（如脱离 scope 的 `setTimeout`/回调）       | Hub 工具调用链是连续 `await`（`handler.fetch` → `callTool`），不脱离 scope；`server_manager` 的 `callTool` 是直接 await。单测验证 scope 隔离 |
| SDK `extra._meta` 接口在 beta 版本变更                        | 提取用 optional chaining 防御（`extra?._meta`）；SDK GA 时复查                                                                               |
| 注入的 `_meta` 与 SDK 自动生成的 `_meta`（progressToken）冲突 | 手写 `_meta` 只含 trace 三件套，不碰 progressToken；SDK 合并 `_meta` 而非覆盖，无冲突                                                        |
| 入站 `_meta` 与 HTTP header 双源冲突                          | 以 `_meta` 为准（SEP-414 官方载体）；header 仅作 fallback                                                                                    |
| stretch（HTTP header 兼容）增加复杂度                         | 标为可选，时间紧可先不做；`_meta` 路径独立可用                                                                                               |

## 8. 实现顺序建议

1. **TraceContextStore**（新文件 + 单元测试）—— 纯函数，无依赖，TDD 友好。
2. **出站注入点**（`server_manager.ts` + 单元测试扩展）—— 改动小，可独立验证注入逻辑。
3. **入站提取点**（`group-service.ts` 工具 handler）—— 连通入站到出站。
4. **e2e**（trace 传播端到端）—— 验证完整链路。
5. **（可选）HTTP header 兼容中间件**。
6. **回填总体 spec**（弃用项/日志核实结论、P6 状态、console.\* 待办项标 ✅）。

## 9. 现有挂载点（实现参考）

| 文件                                                                | 行   | 现状                                                           | P6 改动                                           |
| ------------------------------------------------------------------- | ---- | -------------------------------------------------------------- | ------------------------------------------------- |
| `backend/src/api/mcp/group-service.ts`                              | ~622 | `registerTool(toolName, {inputSchema}, async (args) => {...})` | handler 加 `extra` 参，包裹 `runWithTraceContext` |
| `backend/src/services/server_manager.ts`                            | ~307 | `server.client.callTool({ name, arguments })`                  | 条件注入 `_meta`                                  |
| `backend/src/api/mcp/mcp-handler-factory.ts`                        | —    | handler 工厂，无需感知 trace                                   | 无改动（ALS 透传透明）                            |
| `backend/src/api/mcp/group-router.ts`                               | 138  | POST 路由                                                      | （可选）加 header 提取中间件                      |
| `packages/core/src/utils/logger.ts` / `backend/src/utils/logger.ts` | —    | 统一 Logger 已就绪                                             | 无改动                                            |

## 10. 架构修正：连通 group-service → 真实上游调用（实现期发现）

> **本节是 P6 实现期（Task 1-5 完成后、最终 review 时）发现并确认的架构修正。** 原 §3 的数据流假设 `group-service.ts` 工具 handler → `coreServiceManager.executeToolCall` → 真实上游 server 调用是一条连通链路。核实发现**该假设不成立**——链路中途断在 core 包的 mock 占位实现上。本节记录发现、影响、修复方案。

### 10.1 发现：两套并行且不连通的工具执行体系

项目存在两套工具执行体系，P6 的入站点与出站点分属两套：

| 体系                               | 组成                                                                                | 服务路径                                                          | 连接/执行                                                                                         | 是否真实            |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| **体系 A：backend McpHubService**  | `McpHubService` → `ToolManager` → backend `ServerManager`（真实 `client.callTool`） | REST `/api/tools`（`getHubService()`）                            | 真实 stdio/SSE/streaming transport + 真实 `callTool`/`listTools`                                  | ✅ 真实             |
| **体系 B：core McpServiceManager** | `getCoreServiceManager()` = `new McpServiceManager()`（core 包类）                  | `group-service.ts` 工具 handler（`/:group/mcp` 端点）+ groups API | `simulateServerConnection`（假连接）+ `mockTools`（假工具）+ mock `executeToolOnServer`（假结果） | ❌ **全 mock 占位** |

**核实证据**：

- `getCoreServiceManager()`（`backend/src/services/service-registry.ts:92-106`）返回 `new McpServiceManager()`（core 包类），不经 backend `ServerManager`。
- core `McpServiceManager.executeToolOnServer`（`packages/core/src/services/mcp/service-manager.ts:579`）注释"暂时返回模拟结果"，返回 `ToolResult { success, data: { message: "工具 X 在服务器 Y 上执行成功" } }`，无 `content` 字段，不调真实 `client.callTool`。
- core `McpServiceManager.initializeServer`（L506）同样 mock（`simulateServerConnection`，注释"暂时模拟连接成功"）。
- backend `ServerManager`（P6 Task 2 的出站注入点）由 `McpHubService` 持有（`mcp_hub_service.ts:92`），不经 `group-service`。

### 10.2 影响（P6 与预存 bug）

1. **P6 trace 传播对 MCP 端点无效**：`group-service` handler（P6 Task 3 入站点）把 trace 写入 ALS，但调用链到 core mock `executeToolOnServer` 就返回假数据，**不经过** backend `ServerManager`（P6 Task 2 出站注入点）。trace 写入后无人读取。
2. **MCP 端点工具调用返回 mock 假数据（预存 bug，非 P6 引入）**：`/:group/mcp` 的 `tools/call` 经 core mock 返回假 `ToolResult`，handler 检查 `'content' in result` 不成立，走 fallback `JSON.stringify` 成文本返回客户端。即 MCP 端点的工具调用当前返回的是假的占位文本，不是真实上游 server 结果。

### 10.3 修复方案：注入式适配器（core 当壳，backend 当引擎）

让 `group-service` 继续依赖 core 的 `McpServiceManagerInterface`（抽象接口，不变），但在注入点（`initCoreServiceManager`）注入一个 **backend 适配器**（实现 `McpServiceManagerInterface`），内部委托给真实的 backend `McpHubService`/`ServerManager`。core 的 mock `McpServiceManager` 类不再用于注入（保留为 core 包内部，避免破坏其他潜在依赖）。

**设计要点**：

- **单一注入点**：只改 `initCoreServiceManager`（`service-registry.ts:92`），把 `new McpServiceManager()` 换成 `new BackendCoreServiceAdapter(hubService)`。`getCoreServiceManager()` 的所有消费者（group-service、groups API）自动拿到真实数据。
- **适配器实现 `McpServiceManagerInterface` 的 9 个方法**，委托给 `McpHubService`/`ServerManager`：
  - `executeToolCall(toolName, args, serverId)` → 委托 backend `ServerManager.executeToolOnServer`（P6 Task 2 已注入 trace `_meta`），返回 MCP 原生结果（带 `content`）。
  - `getAllTools`/`getServerTools`/`getServerConnections`/`getServiceStatus`/`isToolAvailable`/`registerServer`/`initializeFromConfig`/`shutdown` → 委托 `McpHubService`/`ServerManager` 对应方法。
- **结果格式**：适配器 `executeToolCall` 类型上返回 core `ToolResult`，但运行时**直接透传** backend `ServerManager` 的 MCP 原生 `CallToolResult`（带 `content`）——因为 `group-service` handler 用 `'content' in result` 判定，需要 `content`。`ToolResult` 的 `data` 字段是 `unknown`，可装 MCP 原生结果，类型兼容。
- **trace 链路打通**：修复后，`group-service` handler → 适配器 → backend `ServerManager.executeToolOnServer`（读 ALS 注入 `_meta`）连成一条链，P6 Task 2/3 同时生效。

### 10.4 为什么不直接让 group-service 改用 McpHubService

考虑过更简单的"group-service 直接调 `getHubService().callTool`"，但否决：

- `group-service` 现依赖 `McpServiceManagerInterface`（core 抽象接口），直接换成 `McpHubService`（具体类）会降低抽象、增加耦合，且 groups API 也用 `getCoreServiceManager()`（只读状态），需要一致的真实数据源。
- 注入式适配器保持 `McpServiceManagerInterface` 契约不变，所有消费者零改动（除注入点），是更小、更一致的改动。

### 10.5 范围界定

本修正属于 P6（trace 传播依赖真实调用链），同时修复预存的 MCP 端点 mock 数据 bug。**不**包含：core `McpServiceManager` 类的删除/重构（保留，避免扩大爆破面）；groups API 行为变更（它们只读状态，适配器提供真实状态即改善而非破坏）。

---

## 11. 参考资料

- [SEP-414 OTel trace context propagation（Final）](https://modelcontextprotocol.io/seps/414-request-meta)
- [MCP 2026-07-28 Changelog](https://modelcontextprotocol.io/specification/draft/changelog)（Minor change #2: trace context；Deprecated #1-4）
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [W3C Baggage](https://www.w3.org/TR/baggage/)
- [typescript-sdk#2196 — SEP-414 TS SDK 实现跟踪](https://github.com/modelcontextprotocol/typescript-sdk/issues/2196)
- [OTel semantic conventions for MCP](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/mcp.md)
