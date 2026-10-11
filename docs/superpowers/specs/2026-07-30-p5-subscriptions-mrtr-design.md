# P5 详细设计：subscriptions/listen + MRTR

- **状态**: 实现完成（分支 `feat/p5-subscriptions-mrtr`，待合并 main；typecheck + unit + e2e 全绿）
- **日期**: 2026-07-30
- **作者**: yourtion
- **关联**:
  - `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md`（总体跟踪，P5 章节）
  - `docs/superpowers/specs/2026-07-28-p6-otel-deprecation-design.md`（P6，AsyncLocalStorage 模式复用）

## 背景与启动决策

P5 原为「主动推迟」状态（观望客户端生态），4 个复查触发条件为：客户端跟进 / 日期复查（2026-10-25）/ 上游 server 需求 / 协议 GA 推动。

**2026-07-30 复查结论**：经核实 npm registry，MCP TypeScript SDK 5 个子包（`server`/`client`/`core`/`hono`/`node`）已于 **2026-07-27 发布 GA 版 2.0.0**（项目当前锁定 `2.0.0-beta.5`）。触发条件「协议 GA 推动 / SDK GA」**已满足**。GA 版提供完整的：

- `subscriptions/listen` 总线（`handler.bus` / `handler.notify`，`client.listen({toolsListChanged, resourceSubscriptions})`）
- MRTR（`InputRequiredResult`、`inputRequired(...)`、`inputRequired.elicit(...)`、`acceptedContent(...)`）
- 无状态友好的 requestState 管理（`createRequestStateCodec({key, ttl})` → `.mint()` / `.verify`，HMAC-SHA256 签名）

故 P5 启动。推迟理由中「客户端生态跟进」属价值兑现问题而非实现阻塞——本轮先把网关侧基础设施做扎实，客户端跟进后即可兑现。

## 范围（brainstorming 已确认）

| 子能力                          | 本轮范围                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **subscriptions/listen**        | 上游工具变更检测（listChanged 订阅 + 60s 轮询兜底，两者结合）→ fan-out 到含该 server 的所有 group → 客户端经 `subscriptions/listen` stream 收 `tools_list_changed` |
| **MRTR（InputRequiredResult）** | Hub 主动管理状态（方案 A）：Hub mint 自己的 requestState 作为 opaque 句柄，内部映射到上游 server + 上游原始 state；重试时 verify 还原并透传 inputResponses         |
| **SDK 升级**                    | beta.5 → 2.0.0 GA，作为 P5 首个 task                                                                                                                               |

### 明确不纳入本轮

- **resources 变更通知**（`resourcesChanged`/`resourceUpdated`）：Hub 当前不透传上游 resources（只有 4 个自注册元数据 resource，内容稳定），无上游 resources 透传场景下价值为零。Detector/Fanout 预留 `resources_changed` 事件枚举扩展点，留空实现。上游 resources 透传是独立大问题，不在 P5。
- **Hub 自注册工具的 MRTR**：4 个元数据 resource 对应工具是只读查询，无 input 需求。
- **多实例 requestState key 共享的完整方案**：标注为已知约束，留 `mrtr.stateKey` 配置项，单实例（当前默认部署）无此问题。

## 架构总览

两条主线完全解耦——subscriptions 不依赖 MRTR，反之亦然，可独立实现/测试/开关。

### 主线一：subscriptions/listen

```
上游 server
├─ listChanged 推送 ──▶ ServerManager (注册 notification handler)
└─ (不推送时) 60s 轮询 ──▶ UpstreamChangeDetector
                                │
                                ▼
                     UpstreamChangeFanout
                     (serverId 变更 → 找出所有含该 server
                      的 group → refreshTools + handler.bus.publish)
                                │
                                ▼
客户端 ◀── subscriptions/listen stream ── McpHttpHandler.bus
           (SDK 内置 listen router，handler.fetch 同端点)
```

### 主线二：MRTR 中转（方案 A）

```
客户端 ──tools/call──▶ Hub handler (group-service)
                          │
                          ▼ executeToolCallWithContext(上游)
上游 server ──▶ 返回 input_required + upstreamRequestState
                          │
                          ▼ MrtrRelayService.relay()
                          │ mint hubRequestState = HMAC({
                          │   serverId, toolName, upstreamState,
                          │   inputRequestShape, step, exp
                          │ })
客户端 ◀── input_required(requestState: hubRequestState) ────

客户端 ──tools/call(inputResponses, requestState:hubState)──▶
                          │
                          ▼ MrtrRelayService.resumeIfNeeded()
                          │ verify(hubState) → 还原映射
                          │ 把 inputResponses 透传上游 callTool
上游 ──▶ 最终结果 或 下一轮 input_required (mint 新 hubState)
```

## 新增组件

3 个新组件，各自单一职责、可独立测试。

| 组件                     | 位置                                               | 职责                                                                                                          | 依赖                                                   |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `UpstreamChangeDetector` | `backend/src/services/upstream-change-detector.ts` | 双路检测上游工具变更：订阅 `notifications/tools/list_changed`（实时）+ 60s 快照比对（兜底）。变更时 emit 事件 | `ServerManager`                                        |
| `UpstreamChangeFanout`   | `backend/src/services/upstream-change-fanout.ts`   | 订阅 Detector 事件，把 serverId 变更 fan-out 到所有含该 server 的 group 的 `handler.bus`                      | `GroupMcpService` 注册表、`groupHandlers` Map          |
| `MrtrRelayService`       | `backend/src/services/mrtr-relay-service.ts`       | MRTR 中转：mint/verify Hub 级 requestState，映射 Hub↔上游 state，透传 inputResponses                          | `createRequestStateCodec`（SDK）、`coreServiceManager` |

## 改造点

3 处现有代码：

1. **`server_manager.ts`**：连接上游时声明 capabilities + 注册 `notifications/tools/list_changed` handler；`discoverServerTools` 后建立快照供轮询比对。
2. **`group-service.ts` 的 `registerDynamicTool` handler**：识别上游 `InputRequiredResult`（当前会把无 `content` 的结果错误包成 text——必须修的 bug），委托 `MrtrRelayService`。
3. **`mcp-handler-factory.ts`**：构造 handler 时注入 `requestState.verify`（来自 `MrtrRelayService` 的 codec）；暴露 `handler.bus` 供 Fanout 使用。

## 主线一：subscriptions/listen 详细设计

### 数据流与触发点

```
ServerManager.initialize()  连接每个上游 server
   │
   ├─ new Client({}, { capabilities: {} })   ← 当前：空 capabilities
   │   改为：声明订阅 listChanged 的意图（SDK 自动据此建 listen 通道）
   │
   ├─ client.setNotificationHandler('notifications/tools/list_changed', cb)
   │       cb → UpstreamChangeDetector.onUpstreamNotification(serverId)
   │
   └─ discoverServerTools() 完成后 → Detector.saveSnapshot(serverId, tools)
                                           （供轮询比对）

UpstreamChangeDetector
   ├─ 实时路径：onUpstreamNotification(serverId)
   │     → 拉取最新 tools → 比对快照 → 有变化才 emit('change', {serverId, kind})
   │
   └─ 兜底路径：setInterval(60s)
         for each connected server:
           tools = await client.listTools()
           if (工具集签名变化) emit('change', {serverId, kind:'poll'})

UpstreamChangeFanout  (订阅 Detector 的 'change' 事件)
   ├─ 收到 {serverId, kind}
   │   ├─ 遍历 groupHandlers Map（mcp-handler-factory 缓存）
   │   ├─ 过滤：该 group 的 config.servers 含 serverId？
   │   ├─ 命中 → 该 group 的 GroupMcpService.refreshTools(serverId)
   │   │         （重新 registerDynamicTool，更新内存工具集）
   │   └─ 命中 → handler.bus.publish({ kind: 'tools_list_changed' })
   │             （SDK 把通知推给所有开了 listen stream 的客户端）
   │
   └─ group 未缓存（尚无客户端连接）→ 标记 dirty，下次 createGroupMcpHandler
       时用最新工具集构造（无需 bus.publish，无订阅者）
```

### 关键设计决策

**1. 工具集签名比对（避免误报）**

不逐个比对 tool 对象，算稳定签名：`tools.map(t=>t.name).sort().join('|')` 的哈希。只有**工具名集合变化**才视为变更（工具描述等非结构性变化不触发 fan-out——避免上游频繁改描述导致风暴）。

**2. dirty 标记处理「无订阅者」场景**

Hub 的 `groupHandlers` 是懒构造的——没客户端连过该 group，handler 就不存在。此时上游变更无法 bus.publish（也没必要）。Fanout 只需标记该 group 的工具集 dirty，下次有客户端连时 `createGroupMcpHandler` 自然取最新工具集。避免「为没人听的 group 维护空 handler」。

**3. refreshTools 的范围控制**

`GroupMcpService.refreshTools(serverId)` 只重新注册**该 server 的工具**，不动其他 server 的工具注册。避免全量重建（当前 `invalidateGroupMcpService` 是丢掉整个 service 重建，粒度太粗）。

**4. 防抖（debounce）**

单个上游 server 短时间多次 listChanged（如批量增删工具），Fanout 对同一 group 的 `tools_list_changed` 做 ~500ms 防抖，合并成一次通知。

**5. 轮询兜底的「智能跳过」**

若某上游 server 已通过 listChanged 推送证明它支持主动通知，轮询对其降频（如 5min）或不轮询；只有从未推送过的 server 才走 60s 高频轮询。减少无谓开销。

### 错误处理

- 上游 `listChanged` handler 异常：catch + Logger.warn，不影响连接
- 轮询 `listTools()` 失败（上游断连）：跳过本轮，依赖 `HealthMonitorService` 的既有断连处理
- `handler.bus.publish` 异常：catch + Logger.warn，不影响其他 group

## 主线二：MRTR 中转详细设计（方案 A）

### 问题本质

当前透传 handler 有两个必须修的问题：

**问题 1：`InputRequiredResult` 被吞掉**（`group-service.ts:649-661`）

```typescript
// 当前代码：只认 'content' in result
if (result && typeof result === 'object' && 'content' in result) {
  return result as unknown as CallToolResult;
}
// 上游返回 { resultType: 'input_required', inputRequests, requestState }
// 没有 'content' 字段 → 走 else 分支 → 被包成 { content:[{text: JSON.stringify(...)}] }
// MRTR 语义彻底丢失
```

**问题 2：inputResponses/requestState 不透传**

客户端重试请求带着 `ctx.mcpReq.inputResponses` 和 `ctx.mcpReq.requestState()`，但 `executeToolCall(toolName, args, serverId)` 只传 args——重试上下文丢失。

### MrtrRelayService 设计

```
MrtrRelayService
├─ codec = createRequestStateCodec<HubState>({ key, ttl })
│   key: 启动时生成或配置（>=32 bytes，多实例需共享）
│   ttl: 600s（10 分钟，足够人机交互）
│
├─ relay(upstreamResult, ctx): HandlerResult
│   上游返回 input_required → mint HubState → 返回给客户端
│
├─ resumeIfNeeded(ctx): { inputResponses?, upstreamState? }
│   客户端重试 → verify HubState → 还原上游上下文
│
└─ verify: codec.verify   ← 注入 ServerOptions.requestState
```

**HubState（编码进 HMAC token 的 payload）：**

```typescript
{
  serverId: string,               // 哪个上游 server
  toolName: string,               // 原始工具名（去 serverId_ 前缀）
  upstreamRequestState?: string,  // 上游的原始 state（透传用）
  step: number,                   // 轮次（可观测审计字段，见下「安全要点」第 3 条）
  exp: number                     // 过期时间
}
```

### 两种调用路径

**路径 1：初次调用（上游要求 input）**

```
客户端 tools/call(args)
  │
  ▼ group-service handler
  ctx.mcpReq.requestState() → undefined（初次，无 state）
  coreServiceManager.executeToolCallWithContext(name, args, serverId, {})
  │
  ▼ 上游返回
  { resultType:'input_required', inputRequests, requestState: upstreamState }
  │
  ▼ MrtrRelayService.relay()
  hubState = codec.mint({
    serverId, toolName: name,
    upstreamRequestState: upstreamState,
    step: 1, exp: now+600s
  })
  返回客户端: { resultType:'input_required',
              inputRequests,           ← 原样透传
              requestState: hubState }  ← Hub 的 state
```

**路径 2：重试调用（客户端带响应回来）**

```
客户端 tools/call(args, inputResponses, requestState: hubState)
  │
  ▼ group-service handler
  ctx.mcpReq.requestState<HubState>() → 已被 codec.verify 解码
  │   (verify 由 ServerOptions.requestState.verify 在 handler 前执行)
  │
  ▼ MrtrRelayService.resumeIfNeeded(ctx)
  hubState = ctx.mcpReq.requestState()  // 已 verify 通过
  还原: { serverId, toolName, upstreamRequestState }
  │
  ▼ coreServiceManager.executeToolCallWithContext(
      toolName, args, serverId, {
        inputResponses: ctx.mcpReq.inputResponses,  ← 透传给上游
        requestState: hubState.upstreamRequestState ← 上游的 state
      })
  │
  ▼ 上游返回: 最终结果 OR 下一轮 input_required
  │
  ├─ 最终结果 → 正常返回（带 content）
  └─ 下一轮 input_required → relay() mint 新 hubState(step+1)，循环
```

### 必须的接口扩展

`executeToolCall` 升级为 `executeToolCallWithContext`，把重试上下文传给上游：

```typescript
// backend-core-service-adapter.ts 新增
async executeToolCallWithContext(
  toolName: string,
  args: unknown,
  serverId: string,
  retryContext: { inputResponses?: unknown; requestState?: string }
): Promise<ToolResult | InputRequiredResult>
```

对应 `server_manager.ts` 的 `executeToolOnServer` 也要透传 `_meta.requestState` + 在 callTool params 里带 inputResponses（SDK v2 callTool 支持）。

### 安全要点

1. **verify hook 必须配**：不配则 SDK 默认不校验 requestState 完整性，客户端可伪造 state 重放。`MrtrRelayService.codec.verify` 注入 `ServerOptions.requestState.verify`。
2. **key 管理**：单实例启动时生成随机 key 即可；多实例部署需共享 key（配置项 `mrtr.stateKey`）——否则 A 实例 mint 的 state 在 B 实例 verify 失败。这是多实例的已知约束，单例（当前默认部署）无此问题。
3. **step 仅作可观测审计字段，非 Hub 层安全防御**：`HubState.step` 用于日志/追踪区分 MRTR 轮次（每轮 mint 新 state 时递增），便于排障定位「现在第几轮」。Hub 层**无状态**（每个请求独立处理，无会话存储），无法独立知道「现在该第几轮」，因此无法做会话级 step 单调性校验。真正的防重放/防乱序由**上游 requestState codec 的 TTL + HMAC 绑定**负责：每个 Hub state 自带 `exp`，过期 token 回传时被 codec 拒绝；HMAC 绑定使篡改 step/serverId 的 token 验签失败。客户端拿「上一轮」的旧 Hub state 重试时，codec.verify 仍能成功还原（token 未过期且签名有效），Hub 据此还原上游上下文并透传——是否构成「乱序」由上游 server 自行判定（上游有自己的 requestState codec 与轮次语义），Hub 不阻断。这是无状态网关的固有约束。

## SDK 升级（P5 首个 task）

### 升级范围

5 个子包全部从 `2.0.0-beta.5` → `2.0.0`：

```
@modelcontextprotocol/server
@modelcontextprotocol/client
@modelcontextprotocol/core
@modelcontextprotocol/hono
@modelcontextprotocol/node
```

涉及 3 个 `package.json`：`backend/`、`packages/core/`、`packages/cli/`。

### 验证策略（风险驱动）

beta.5（2026-07-21）→ GA（2026-07-27）间隔仅 6 天，主要是 bug fix + API 稳定化，预期 breaking change 极少。但不能假设——用既有测试体系做验证：

| 验证层       | 命令                        | 关注点                                          |
| ------------ | --------------------------- | ----------------------------------------------- |
| typecheck    | `pnpm typecheck`            | 类型 API 变更（最可能 breaking 点）             |
| unit tests   | `pnpm test`                 | 行为回归                                        |
| e2e tests    | e2e suite                   | P1-P6 已建的协议层测试（传输/OAuth/缓存/trace） |
| codemod 标记 | `grep '@mcp-codemod-error'` | 确认无新增迁移残留                              |

### 升级流程

1. 改 3 个 package.json 的版本号
2. `pnpm install`（更新 lockfile）
3. `pnpm typecheck` → 有类型错误则修（预期 0 或极少）
4. `pnpm test` → 全绿
5. 跑 e2e → 全绿
6. 若有 breaking：遵循 P1 既定模式——用 SDK codemod 输出而非手钉，记录在 spec

### 回滚条件

若 GA 版引入 P5 之外的意外 breaking（如传输层行为变化影响已合并的 P1-P6），则：暂停在 beta.5，在 spec 记录 breaking 详情，与用户确认是否继续。这步不与 P5 功能耦合——即使 P5 功能尚未实现，SDK 升级本身也应让现有 P1-P6 全绿，可独立提交。

## 配置

```typescript
// 新增配置（config 默认值，向后兼容）
subscriptions: {
  enabled: true,           // 总开关
  pollIntervalMs: 60_000,  // 兜底轮询间隔
  pollBackoffMs: 300_000,  // 已证明支持推送的 server 降频间隔
  fanoutDebounceMs: 500,   // fan-out 防抖
},
mrtr: {
  enabled: true,           // 总开关
  stateTtlSeconds: 600,    // requestState 有效期
  stateKey: undefined,     // HMAC key（undefined 则启动时随机生成；多实例需显式配置）
}
```

## 测试策略

### 测试分层（遵循项目既有体系）

| 层              | 目标                   | 工具                     | P5 新增                           |
| --------------- | ---------------------- | ------------------------ | --------------------------------- |
| **Unit**        | 单组件逻辑，无外部依赖 | vitest                   | 3 个新组件 + 改造点的纯逻辑       |
| **Integration** | 组件协作，mock 边界    | vitest                   | subscriptions 全链路、MRTR 多轮   |
| **E2E**         | 真实协议交互           | vitest e2e + test-server | 客户端视角验证 subscriptions/MRTR |

### Unit 测试（每个新组件独立可测）

**`UpstreamChangeDetector`**

- 工具集签名比对：增/删工具触发，改描述不触发
- 快照保存与比对逻辑
- listChanged 回调 → emit 事件
- 轮询路径：模拟 `listTools()` 返回不同结果 → emit
- 智能跳过：已推送 server 降频
- 异常隔离：handler 抛错不影响其他 server

**`UpstreamChangeFanout`**

- serverId → group 映射（多 group 含同一 server）
- bus.publish 调用验证
- dirty 标记：无 handler 的 group 不 publish
- 防抖：500ms 内多次变更合并一次
- 过滤：group.config.servers 不含 serverId 不触发

**`MrtrRelayService`**

- `relay()`：input_required → mint hubState，字段完整
- `relay()`：非 input_required（正常结果）原样返回
- `resumeIfNeeded()`：verify 通过 → 还原 serverId/toolName/upstreamState
- `resumeIfNeeded()`：无 state（初次调用）→ 返回空
- `verify`：篡改 state → 拒绝；过期 state → 拒绝
- step 审计：多轮 mint 的 state 各自 verify 还原正确轮次号与 upstreamRequestState（step 为可观测字段，见「安全要点」第 3 条；非 Hub 层安全防御）
- codec round-trip：mint → verify → 还原一致

### Integration 测试（组件协作）

**Subscriptions 全链路：**

- mock 上游 server（用项目的 test-server 设施）发 `tools/list_changed`
- 验证：Detector 收到 → Fanout 找到 group → handler.bus.publish 被调用
- 轮询兜底：mock 不推送的上游，手动推进定时器 → 验证 fan-out

**MRTR 多轮中转：**

- mock 上游首次返回 input_required
- 验证：Hub mint hubState → 客户端（测试模拟）带 hubState + inputResponses 重试 → Hub verify → 透传上游 → 上游返回最终结果
- 多轮：上游连续 2 次 input_required → 验证 step 递增、state 更新

### E2E 测试（真实协议交互）

**`subscriptions/listen` e2e：**

- 用真实 MCP client 连 Hub，开 `client.listen({ toolsListChanged: true })`
- 触发上游工具变更（通过 test-server 注入）
- 断言客户端收到 `notifications/tools/list_changed`
- 验证后续 `listTools()` 返回新工具集

**MRTR e2e：**

- 用真实 MCP client 调一个返回 input_required 的工具（test-server 提供该工具）
- 断言收到 `InputRequiredResult` 带 hubState
- 用 inputResponses 重试，断言最终结果正确

### test-server 扩展

项目的 `backend/src/e2e/test-server.ts` 需新增两个测试工具：

1. `dynamic_tool_list`：可运行时增删工具，触发 listChanged
2. `confirm_action`：首次返回 input_required，确认后返回结果——演示 MRTR

### DoD 锚点（测试矩阵）

| DoD 项                 | 验证方式                                    |
| ---------------------- | ------------------------------------------- |
| SDK GA 升级无回归      | typecheck + 全量 unit + 全量 e2e 全绿       |
| subscriptions 实时路径 | e2e：上游 listChanged → 客户端收到通知      |
| subscriptions 轮询兜底 | integration：定时器推进 → fan-out           |
| MRTR 单轮中转          | e2e：input_required → 重试 → 结果           |
| MRTR 多轮中转          | integration：连续 input_required，step 递增 |
| requestState 安全      | unit：篡改/过期 state 被 verify 拒绝        |
| 配置开关生效           | unit：enabled=false → 无 fan-out、无轮询    |
| 向后兼容               | 现有 e2e（P1-P6）全绿，无订阅客户端不受影响 |

## 实现顺序

```
Task 0: SDK 升级 beta.5 → 2.0.0 GA
   │   独立可提交，不碰 P5 功能
   │   验证: typecheck + 全量测试全绿
   ▼
Task 1: UpstreamChangeDetector（subscriptions 实时+轮询检测）
   │   纯逻辑组件，TDD 友好
   │   验证: unit 全绿
   ▼
Task 2: ServerManager 改造（注册 notification handler + 快照）
   │   依赖 Task 1 的 Detector
   │   验证: unit（handler 注册）+ integration（上游推送 → Detector emit）
   ▼
Task 3: UpstreamChangeFanout（serverId → group fan-out + 防抖）
   │   依赖 Task 2（变更事件源）
   │   验证: unit（映射/防抖/dirty）+ integration（Detector → Fanout → bus）
   ▼
Task 4: subscriptions/listen e2e（真实客户端验证）
   │   依赖 Task 1-3 + test-server 扩展
   │   验证: e2e 全绿
   ║  ← subscriptions 主线可交付里程碑（M2）
   ║
Task 5: MrtrRelayService（mint/verify/resume 纯逻辑）
   │   独立于 subscriptions，纯逻辑 TDD
   │   验证: unit 全绿（含安全测试）
   ▼
Task 6: executeToolCallWithContext + ServerManager 透传改造
   │   依赖 Task 5 的类型
   │   验证: unit（透传 inputResponses/requestState）
   ▼
Task 7: group-service handler 改造（修 InputRequiredResult 吞没 bug + 接入 MRTR）
   │   依赖 Task 5 + Task 6
   │   验证: integration（多轮中转）+ 修 bug 的回归测试
   ▼
Task 8: mcp-handler-factory 注入 requestState.verify
   │   依赖 Task 5 的 codec.verify
   │   验证: integration（verify hook 生效）
   ▼
Task 9: MRTR e2e（真实客户端验证）
   │   依赖 Task 5-8 + test-server 扩展
   │   验证: e2e 全绿
   ║  ← MRTR 主线可交付里程碑（M3）
   ║
Task 10: 配置集成 + adoption-overview 文档更新 + 收尾
       验证: 全量 typecheck + unit + e2e 全绿
```

### 里程碑结构

- **M1（Task 0）**：SDK GA 升级——独立价值，P1-P6 在 GA 版全绿
- **M2（Task 1-4）**：subscriptions/listen 可交付——客户端能收上游工具变更通知
- **M3（Task 5-9）**：MRTR 可交付——上游 input_required 能正确中转
- **M4（Task 10）**：收尾——配置、文档、全量回归

两条主线在 Task 4 后解耦：subscriptions 可先于 MRTR 交付，降低风险。

## 已知约束与风险

| 约束/风险                             | 说明                                                                               | 缓解                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 多实例 requestState key               | Hub 多实例部署时，A 实例 mint 的 state 在 B 实例 verify 失败                       | 留 `mrtr.stateKey` 配置项；单实例默认部署无此问题；多实例需运维显式配                                                                |
| handler 复用同一 McpServer 的既有偏离 | `mcp-handler-factory.ts:115-123` 注释标注 factory 复用同一 McpServer 偏离 SDK 契约 | P5 功能（bus/notify、requestState）在当前模式下可工作；若 GA 版对此收紧，P1 follow-up 抽 `buildServer(groupId)` 每次返回新实例需提前 |
| 轮询开销                              | 60s 轮询对所有不推送的上游 server 调 listTools                                     | 智能跳过（已推送 server 降频）；配置可调间隔/关闭                                                                                    |
| 客户端生态尚未跟进                    | subscriptions/listen/MRTR 的客户端支持率未知                                       | 本轮做网关侧基础设施，客户端跟进后即可兑现；e2e 用真实 MCP client 验证协议正确性                                                     |

## 参考资料

- [MCP subscriptions/listen](https://modelcontextprotocol.io/docs/2026-07-28/sdk/clients/subscriptions)
- [MCP Input Required (MRTR)](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md)
- [MCP Server Notifications](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md)
- [createRequestStateCodec API](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/input-required.md)
