# P7 详细设计：协议兼容层（双向 era 翻译）

- **状态**: Draft（待审阅）
- **日期**: 2026-08-02
- **作者**: yourtion
- **关联**:
  - `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md`（P1-P6 全景；本 spec 修订其第 24 行全景决策"激进入站"）
  - `docs/superpowers/specs/2026-07-25-p1-transport-upgrade-design.md`（P1 已实现激进入站；本 spec 在其之上叠加可选兼容层，不推翻）
  - `docs/superpowers/specs/2026-07-30-p5-subscriptions-mrtr-design.md`（P5 已实现 MRTR，隐式 modern-only；本 spec 为其补齐 legacy 降级路径）

## 目的

把 Hub 从"只服务 modern、出站黑盒"的非对称兼容，重新接管为**显式的、双向的、可配置的协议兼容层**，践行"网关不挑客户端、不挑 upstream"的原则。

本 spec 修订 adoption-overview 第 24 行已确认的全景决策"激进升级，只支持新协议（入站方向）"。**修订理由**：P1 当时决策的依据是"项目 0.0.1，趁早切干净"。随着项目演进到要做"聚合任意 MCP server 的网关"，入站拒绝 legacy 客户端违背了网关的核心价值（让任意端互通）。本 spec 不否定 P1 的实现，而是**在其之上叠加一层可选、默认开启的兼容能力**。

## 背景

### 现状（探索已确认）

Hub 的兼容机制是**非对称**的，全部委托给 SDK 的两个开关：

| 方向 | 当前策略 | 实现 |
|------|---------|------|
| 入站（client → Hub） | 激进升级，拒绝 legacy | `legacy: 'reject'`（`backend/src/api/mcp/mcp-handler-factory.ts:284`、`packages/cli/src/server/cli-mcp-server.ts:164`） |
| 出站（Hub → upstream） | 兼容，auto 协商（黑盒） | `versionNegotiation: 'auto'`（`backend/src/services/server_manager.ts:113`） |

### 现状的内在矛盾（这是本 spec 要解决的核心问题）

1. **入站拒绝 legacy 客户端**：老版 Claude Desktop / Cursor / 旧 SDK 客户端直接连不上，违背网关定位。
2. **出站"兼容"是声称的、未验证**：`backend/src/e2e/mcp-protocol/protocol-compliance.test.ts` 用例 3 是 `it.skip`，从未跑过真正的 legacy upstream。
3. **MRTR 隐式要求 upstream modern**：`backend/src/e2e/fixtures/mrtr-upstream-server.ts:24-38` 注释说明 MRTR（`input_required`）只在 modern era 写回 wire，否则 SDK 跑 `LegacyInputRequiredShim` 会失败。出站策略名义"兼容 legacy"，实际 legacy upstream 触发 MRTR 会失败而非优雅降级。
4. **入站拒绝覆盖面窄**：只测了 `initialize` 和 `tools/list`，`resources/*`、`prompts/*`、`ping`、notification 边界未覆盖。
5. **错误 envelope 两套**：SDK 生成（入站 legacy 拒绝）与仓库自建（`group-router.ts:84-122,152-167`）结构不一，客户端无法统一处理。
6. **策略分散重复**：`legacy: 'reject'` 在 HTTP 与 CLI 两入口各写一遍，无共享开关、运行期不可调。

### 关键事实（核实已确认）

**官方生态已提供本 spec 所需的全部零件，不需要从零造**：

- **TCK 存在**：[`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) v0.1.16，`server` 模式支持 `--spec-version 2025-11-25 / 2026-07-28` 分别校验 + `--suite backcompat`。验收门槛"官方合规对拍"有现成工具。
- **SDK v2 已导出 era 翻译原语**（`@modelcontextprotocol/server@2.0.0`）：
  - `classifyInboundRequest()` / `isLegacyRequest` — 官方 era 探测器
  - `legacyStatelessFallback()` — 内置 legacy-side shim
  - `parseJSONRPCMessage` / `serializeMessage` / `deserializeMessage` — codec
  - `RequestMetaEnvelope` + `*_META_KEY` 常量（`PROTOCOL_VERSION_META_KEY` 等）— envelope
  - `inputRequired()` / `inputResponse` / `requestState.verify` — MRTR
- **官方组装蓝图**：`examples/legacy-routing/`（同端口 `isLegacyRequest` 分流）、`examples/gateway/`（`connect({prior})` 零往返）、`examples/dual-era/`、`examples/mrtr/`。

## 范围（brainstorming 已确认）

### 目标

1. 新增 package `@mcp-core/mcp-knot-protocol`，作为 Hub 的协议适配层，把 era 差异全部收口于此包内。
2. 入站方向默认**同时服务 modern 和 legacy 客户端**（默认全开，可配置收窄）。
3. 出站方向**显式探测并记录 upstreamEra**，供 adapter 决策；保留 SDK `auto` 协商行为。
4. MRTR 跨 era：modern upstream 的 `input_required` 能转译给 legacy 客户端；legacy upstream 触发 MRTR 时走 shim 降级而非失败。
5. 错误 envelope 统一：SDK 生成、Hub 自建、upstream 返错三来源归一到同一结构。
6. 业务层（`group-service`、`server_manager`）**零 era 感知**——只面对归一化内部模型。
7. 验收：接入官方 conformance TCK，双 era 对拍；填上 `protocol-compliance.test.ts` 用例 3 的 `it.skip`。

### 明确支持矩阵

- **modern**：`2026-07-28`（`server/discover` 握手、`_meta` envelope、MRTR 原生）
- **legacy**：`2025-11-25`（最后一个 legacy era，`initialize` 握手、无 envelope）
- 更老的（`2025-03-26`、`2024-11-05`）：若上游 SDK 能转就转，不专门适配。

### MVP 必做

- 握手/协商双向翻译（initialize ↔ server/discover）
- MRTR 双向翻译（含 legacy 降级）
- 错误码统一
- 主要 method 翻译：`tools/list`、`tools/call`

### P2（不阻断 MVP）

- `resources/*`、`prompts/*` 翻译
- `ping` 语义、notification 边界（`notifications/initialized` 等）

### 非目标

- **完全自建协议层、不依赖 SDK**：已核实 SDK 已导出全部所需原语，自己重写无收益只有跟踪负担，且与"官方 TCK 对拍"验收门槛哲学冲突。
- **覆盖所有历史 protocolVersion**：只明确 modern + 2025-11-25。
- **推翻 P1/P5 已实现部分**：本 spec 是叠加可选兼容层，不重写。

## 关键决策（brainstorming 已确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| 动机 | 原则性：网关就该全兼容 | 让任意端互通是网关核心价值 |
| 实现深度 | 显式接管协议层（用 SDK v2 原语组装） | 既有控制力，又与官方生态对齐，TCK 可验 |
| 支持矩阵 | modern + 2025-11-25 | 覆盖今天主流，避免无限回溯 |
| 验收 | 官方 conformance TCK 双 era 对拍 | 最严格门槛，压制"自测通过但语义漂移"风险 |
| 包结构 | 新增单包 + 内部目录模块化 | 只有 backend+cli 两个消费者，拆多包是 YAGNI；归一化模型留包内避免循环依赖 |
| 归一化模型 | `NormalizedRequest`/`NormalizedCall` 留包内 | 业务层零 era 感知，是"不挑端"原则的技术体现 |
| 配置开关 | `CompatibilityOptions`，默认全开、可配置 | 不同部署场景诉求不同；支持渐进迁移、灰度、收窄攻击面 |
| 与 P1 关系 | 叠加可选兼容层，修订全景决策 | 不推翻 P1 实现，`reject` 退化为可配置项之一 |

## 架构总览

### 包依赖图

```
                    packages/share  (通用类型)
                          ▲
              ┌───────────┴───────────┐
              │                       │
   @mcp-core/mcp-knot-protocol  ◄─── (新)
       (依赖 @modelcontextprotocol/server v2 + share)
              ▲
              │
   ┌──────────┴──────────┐
   │                     │
 core(业务聚合)         cli(stdio server)
   ▲                     ▲
   │                     │
 backend(api server)    (外部)
```

新包 `@mcp-core/mcp-knot-protocol`：
- **依赖**：`@modelcontextprotocol/server@2.0.0`、`@mcp-core/mcp-knot-share`（workspace）
- **被依赖**：`@mcp-core/mcp-knot-core`、`@mcp-core/mcp-knot-cli`
- 两入口（backend 经 core、cli 直接）共用同一套兼容能力，消除现有 `legacy:'reject'` 的重复。

### 包内结构（内部目录模块化）

```
packages/protocol/
├── src/
│   ├── index.ts              # 对外门面：createProtocolAdapter() + 类型导出
│   ├── config.ts             # CompatibilityOptions 定义
│   ├── model/
│   │   ├── normalized.ts     # NormalizedRequest / NormalizedCall / NormalizedResult
│   │   └── era.ts            # Era 探测结果、UpstreamEra 类型
│   ├── inbound/
│   │   ├── adapter.ts        # InboundProtocolAdapter：classifyInboundRequest + 分流
│   │   └── legacy-fallback.ts# 包装 legacyStatelessFallback
│   ├── outbound/
│   │   ├── adapter.ts        # OutboundProtocolAdapter：探测 + 翻译分发
│   │   ├── modern-translator.ts   # _meta envelope + inputResponses
│   │   └── legacy-translator.ts   # initialize 语义 + MRTR shim 降级
│   ├── mrtr/
│   │   └── relay.ts          # MRTR 跨 era 中转（从 group-service.ts:668 迁入）
│   └── errors/
│       └── normalizer.ts     # UnifiedErrorNormalizer（统一 envelope）
└── package.json              # name: @mcp-core/mcp-knot-protocol
```

### 数据流（以 legacy 客户端 → modern upstream 的 tools/call 为例）

```
client(legacy)
  │ initialize { protocolVersion: "2025-11-25" }
  ▼
InboundProtocolAdapter
  │ classifyInboundRequest() → InboundLegacyRoute
  │ legacyStatelessFallback(factory) 服务握手
  │ 归一化 → NormalizedRequest { method:'tools/call', params, era:'legacy' }
  ▼
GroupMcpService.executeToolCallWithContext   ← 业务层零 era 感知
  ▼
OutboundProtocolAdapter
  │ 读 upstreamEra（modern）
  │ NormalizedCall → modern-translator → callTool(inputResponses) 带 _meta envelope
  ▼
upstream(modern) → 返回 InputRequiredResult
  ▼
OutboundProtocolAdapter → NormalizedResult { kind:'input_required', ... }
  ▼
（若出错）UnifiedErrorNormalizer 介入
  ▼
InboundProtocolAdapter
  │ era:'legacy' → InputRequiredResult 走 shim 翻译成 legacy 可懂的形态
  ▼
client(legacy) 收到符合其 era 的响应
```

## 配置开关

```ts
// packages/protocol/src/config.ts
export interface CompatibilityOptions {
  inbound: {
    enabled: boolean;                         // 默认 true（网关不挑客户端）
    legacyMode: 'reject' | 'shim';            // 默认 'shim'。'reject'=P1 行为；'shim'=用 legacyStatelessFallback 服务 legacy 客户端
  };
  outbound: {
    enabled: boolean;                         // 默认 true（能连任意 upstream）
    modernOnly: boolean;                      // 默认 false。true=强制只连 modern（安全敏感场景降级开关）
    mrtrLegacyDegradation: 'shim' | 'reject'; // 默认 'shim'。legacy upstream 触发 MRTR 时的处理
  };
  errors: { unified: boolean };               // 默认 true（统一错误 envelope）
}
```

**`legacyMode` 两选项语义**：
- `'reject'`：保留 P1 行为，legacy 客户端被拒（向后兼容退路）。
- `'shim'`：用 SDK 的 `legacyStatelessFallback` 服务 legacy 客户端（默认）。

**配置来源**：
- `backend`：从环境变量 / config 文件读（沿 `backend/src/config/*` 现有模式）。
- `cli`：从启动 flag 读（`--no-legacy-inbound` / `--modern-only-upstream` 等）。

**默认全开**体现"网关就该全兼容"原则；可配置项支持生产部署按需收窄（如只信任 modern upstream 的安全敏感场景）。

## 现有代码迁移点

| 现状文件:行 | 改动 |
|---|---|
| `backend/src/api/mcp/mcp-handler-factory.ts:284` `legacy:'reject'` | 改为 `createProtocolAdapter(opts)` 编排分流；`reject` 退化为 `legacyMode:'reject'` 配置项 |
| `packages/cli/src/server/cli-mcp-server.ts:164` `legacy:'reject'` | 同上，复用同一包（消除重复） |
| `backend/src/services/server_manager.ts:113` `versionNegotiation:'auto'` | 保留 SDK 行为，但**显式探测记录 upstreamEra**，供 adapter 决策 |
| `backend/src/services/server_manager.ts:425-518` callTool | era 假设迁移到 outbound adapter；`inputResponses`/`requestState` 由 translator 处理 |
| `backend/src/api/mcp/group-service.ts:668-720` MRTR mint/verify | 迁入 `packages/protocol/src/mrtr/relay.ts` |
| `backend/src/api/mcp/group-router.ts:84-122,152-167` 两套错误 | 统一经 `UnifiedErrorNormalizer` |
| `backend/src/e2e/mcp-protocol/protocol-compliance.test.ts` 用例 3 `it.skip` | 填上：真实 legacy upstream fixture + 跨 era 端到端 |

## 新增组件

### 1. `NormalizedRequest` / `NormalizedCall` / `NormalizedResult`（model/normalized.ts）

业务层与 adapter 之间的契约。era 字段只在此层出现，业务层不读。

```ts
interface NormalizedRequest {
  method: string;            // 'tools/call' 等
  params: unknown;           // 已解包，无 envelope
  meta: NormalizedMeta;      // clientInfo / capabilities / trace 上下文
  era: 'modern' | 'legacy';  // 入站探测结果
}

interface NormalizedCall {
  toolName: string;
  arguments: unknown;
  mrtr?: NormalizedMrtrState; // requestState + inputResponses（若有）
}

interface NormalizedResult {
  kind: 'success' | 'input_required' | 'error';
  // success: 工具结果
  // input_required: InputRequests（era 无关表示）
  // error: 已归一化的错误
}
```

### 2. `InboundProtocolAdapter`（inbound/adapter.ts）

入口：接收原始 HTTP/stdio 请求，用 `classifyInboundRequest` 分流，legacy 走 `legacyStatelessFallback`，输出 `NormalizedRequest`。

### 3. `OutboundProtocolAdapter`（outbound/adapter.ts）

入口：接收 `NormalizedCall` + `upstreamEra`，分发到 modern/legacy translator，输出 wire 形态的 upstream 调用，并把 upstream 响应归一化为 `NormalizedResult`。

### 4. `UnifiedErrorNormalizer`（errors/normalizer.ts）

三个错误来源（SDK 拒绝、Hub 自建、upstream 返错）归一到统一结构。具体结构在实现计划阶段对照 SDK 错误码表确定。

## 验收

### 官方 conformance TCK 对拍（CI 矩阵）

- `--spec-version 2026-07-28`（modern 客户端连 Hub）
- `--spec-version 2025-11-25`（legacy 客户端连 Hub）
- `--suite backcompat`
- `--expected-failures` YAML baseline 化已知差异

### 出站 e2e（填上 it.skip）

- fixture 拉起 legacy/modern 两种 upstream
- 跨 era 组合（4 种）跑 `tools/list`、`tools/call`、MRTR

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 归一化模型设计不当导致二次重构 | MVP 先覆盖 tools/*，模型字段最小化；P2 扩展时再补 |
| `legacyStatelessFallback` 的 shim 行为与 modern 客户端看到的 server 行为有细微差异（capabilities 表面、session 语义） | TCK 双 era 对拍会捕获；差异点在文档中显式标注 |
| SDK v2 仍是 alpha/刚 GA，API 可能变 | 锁定 `2.0.0` 精确版本；adapter 层隔离 SDK，升级只改 translator |
| MRTR legacy shim 语义漂移（`LegacyInputRequiredShim` 是 SDK 内部非标准概念） | 复用 SDK 的 shim 而非自复刻；TCK 对拍验证 |
| 迁移期间 P1/P5 已实现部分行为变化 | 兼容层默认开启但 `reject` 配置项保留 P1 行为；分阶段灰度 |

## 开放问题（实现计划阶段细化）

1. CLI flag 命名规范（沿用现有 cli 的 flag 风格）。
2. conformance TCK 的 CI 集成方式（npm script 形态、baseline 文件位置）。

> 注：`NormalizedMeta` 的字段集、统一错误结构的精确形态在实现计划阶段对照 SDK v2 类型定义确定，本设计阶段不预先写死，避免与 SDK 实际导出脱节。
