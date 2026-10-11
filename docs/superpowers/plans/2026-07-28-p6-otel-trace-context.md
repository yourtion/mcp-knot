# P6 OTel Trace Context 传播 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 MCP `2026-07-28` SEP-414 的 OTel trace context 传播——Hub 作为网关，从客户端请求 `_meta` 提取 `traceparent`/`tracestate`/`baggage`，用 `AsyncLocalStorage` 在请求作用域透传，调用上游 MCP server 时注入回 `_meta`。

**Architecture:** 零 OTel SDK 依赖，纯字符串透传。入站提取点在 `group-service.ts` 的工具 handler（从 SDK `extra._meta` 提取，存入 ALS）；出站注入点在 `server_manager.ts` 的 `executeToolOnServer`（从 ALS 读，注入 `client.callTool` 的 `_meta`）。`_meta` 是唯一 MCP 协议载体（SEP-414 transport-agnostic 选择）。

**Tech Stack:** Node.js `async_hooks`（`AsyncLocalStorage`）、vitest、`@modelcontextprotocol/server`（McpServer）、`@modelcontextprotocol/client`（Client）。

**Spec:** `docs/superpowers/specs/2026-07-28-p6-otel-deprecation-design.md`

## Global Constraints

- **零 OTel SDK 依赖**：不引入任何 `@opentelemetry/*` 包；trace context 是纯字符串透传（不解析 traceparent、不验证格式、不生成 spanId、不采样）。
- **`_meta` 为唯一 MCP 协议载体**：出站注入 `client.callTool({ name, arguments, _meta })` 的 `_meta`；入站从 handler 的 `extra._meta` 提取。**不**用 transport 的 `requestInit.headers` 或 `RequestOptions.headers` 注入 trace（那是 auth/SEP-2243 的通道，且对 stdio 无效）。
- **不改方法签名**：context 通过 `AsyncLocalStorage` 隐式透传，`executeToolOnServer` 等方法签名保持不变。
- **条件注入**：ALS 无 context 时 `callTool` **不加** `_meta`（避免给无 trace 请求塞空对象）；现有无 trace 行为零回归。
- **测试 runner**：vitest，`pnpm test`（unit）/ `pnpm test:e2e`（api-e2e project）。测试风格沿用项目现有 `describe/it/expect` + `vi.mock` 模式。
- **提交粒度**：每个 Task 一个 commit，commit message 用 `feat(p6):` / `test(p6):` 前缀。

## File Structure

| 文件                                                         | 责任                                                      | 类型 |
| ------------------------------------------------------------ | --------------------------------------------------------- | ---- |
| `backend/src/middleware/trace-context.ts`                    | `AsyncLocalStorage` store + 提取/注入辅助函数             | 新增 |
| `backend/src/middleware/trace-context.unit.test.ts`          | TraceContextStore 单元测试                                | 新增 |
| `backend/src/services/server_manager.ts`                     | `executeToolOnServer` 出站注入 `_meta`                    | 修改 |
| `backend/src/services/server_manager.unit.test.ts`           | 扩展：断言 callTool 收到 `_meta` / 无 context 不加        | 修改 |
| `backend/src/api/mcp/group-service.ts`                       | 工具 handler 入站提取 + ALS 包裹                          | 修改 |
| `backend/src/api/mcp/trace-context-integration.unit.test.ts` | 集成测试：入站 `_meta` → ALS → 回显（连通入站到读取链路） | 新增 |

---

### Task 1: TraceContextStore（新文件 + 单元测试）

**Files:**

- Create: `backend/src/middleware/trace-context.ts`
- Test: `backend/src/middleware/trace-context.unit.test.ts`

**Interfaces:**

- Produces: `TraceContext`（interface）、`extractFromMeta(meta?)`、`extractFromHeaders(headers)`、`runWithTraceContext(ctx, fn)`、`getCurrentTraceContext()`、`hasTraceContext(ctx)`。后续 Task 2/3 消费这些函数。

- [ ] **Step 1: Write the failing test**

Create `backend/src/middleware/trace-context.unit.test.ts`:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';

import {
  type TraceContext,
  extractFromHeaders,
  extractFromMeta,
  getCurrentTraceContext,
  hasTraceContext,
  runWithTraceContext,
} from './trace-context.js';

describe('trace-context', () => {
  describe('extractFromMeta', () => {
    it('从 _meta 提取 trace 三件套', () => {
      const meta = {
        traceparent: '00-traceid-spanid-01',
        tracestate: 'vendor=congo',
        baggage: 'key=value',
      };
      expect(extractFromMeta(meta)).toEqual({
        traceparent: '00-traceid-spanid-01',
        tracestate: 'vendor=congo',
        baggage: 'key=value',
      });
    });

    it('缺失字段返回 undefined', () => {
      expect(extractFromMeta({ traceparent: '00-t-s-01' })).toEqual({
        traceparent: '00-t-s-01',
        tracestate: undefined,
        baggage: undefined,
      });
    });

    it('undefined 入参返回空对象', () => {
      expect(extractFromMeta(undefined)).toEqual({
        traceparent: undefined,
        tracestate: undefined,
        baggage: undefined,
      });
    });

    it('非字符串字段忽略', () => {
      expect(extractFromMeta({ traceparent: 123, tracestate: true })).toEqual({
        traceparent: undefined,
        tracestate: undefined,
        baggage: undefined,
      });
    });
  });

  describe('extractFromHeaders', () => {
    it('从 W3C HTTP header 提取', () => {
      const headers = new Headers();
      headers.set('traceparent', '00-traceid-spanid-01');
      headers.set('tracestate', 'vendor=congo');
      headers.set('baggage', 'key=value');
      expect(extractFromHeaders(headers)).toEqual({
        traceparent: '00-traceid-spanid-01',
        tracestate: 'vendor=congo',
        baggage: 'key=value',
      });
    });

    it('header 缺失返回 undefined', () => {
      const headers = new Headers();
      expect(extractFromHeaders(headers)).toEqual({
        traceparent: undefined,
        tracestate: undefined,
        baggage: undefined,
      });
    });
  });

  describe('hasTraceContext', () => {
    it('三字段全空返回 false', () => {
      expect(hasTraceContext({})).toBe(false);
      expect(
        hasTraceContext({
          traceparent: undefined,
          tracestate: undefined,
          baggage: undefined,
        }),
      ).toBe(false);
    });

    it('任一字段非空返回 true', () => {
      expect(hasTraceContext({ traceparent: '00-t-s-01' })).toBe(true);
      expect(hasTraceContext({ tracestate: 'v=c' })).toBe(true);
      expect(hasTraceContext({ baggage: 'k=v' })).toBe(true);
    });
  });

  describe('runWithTraceContext + getCurrentTraceContext', () => {
    it('scope 内可读取注入的 context', async () => {
      const ctx: TraceContext = {
        traceparent: '00-traceid-spanid-01',
        tracestate: 'vendor=congo',
      };
      await runWithTraceContext(ctx, async () => {
        expect(getCurrentTraceContext()).toEqual(ctx);
      });
    });

    it('scope 外 getCurrentTraceContext 返回空对象（不抛错）', async () => {
      // 不在任何 runWithTraceContext scope 内
      expect(getCurrentTraceContext()).toEqual({});
    });

    it('空 context（三字段全空）不阻断 fn 执行', async () => {
      const result = await runWithTraceContext({}, async () => {
        return 'ran';
      });
      expect(result).toBe('ran');
      expect(hasTraceContext(getCurrentTraceContext())).toBe(false);
    });

    it('并发请求 context 互不串扰（scope 隔离）', async () => {
      const ctxA: TraceContext = { traceparent: '00-A-1-01' };
      const ctxB: TraceContext = { traceparent: '00-B-1-01' };

      const run = (ctx: TraceContext, marker: string) =>
        runWithTraceContext(ctx, async () => {
          // 故意让出事件循环，模拟并发交错
          await new Promise((r) => setTimeout(r, 10));
          return `${marker}:${getCurrentTraceContext().traceparent}`;
        });

      const [a, b] = await Promise.all([run(ctxA, 'A'), run(ctxB, 'B')]);
      expect(a).toBe('A:00-A-1-01');
      expect(b).toBe('B:00-B-1-01');
    });

    it('嵌套 scope 内层覆盖外层', async () => {
      const outer: TraceContext = { traceparent: '00-OUTER-1-01' };
      const inner: TraceContext = { traceparent: '00-INNER-1-01' };
      await runWithTraceContext(outer, async () => {
        expect(getCurrentTraceContext().traceparent).toBe('00-OUTER-1-01');
        await runWithTraceContext(inner, async () => {
          expect(getCurrentTraceContext().traceparent).toBe('00-INNER-1-01');
        });
        expect(getCurrentTraceContext().traceparent).toBe('00-OUTER-1-01');
      });
    });
  });

  it('AsyncLocalStorage 已被 Node 全局支持（环境健康检查）', () => {
    expect(AsyncLocalStorage).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test trace-context.unit.test`
Expected: FAIL with "Failed to resolve import `./trace-context.js`"（文件尚不存在）。

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/middleware/trace-context.ts`:

```typescript
/**
 * OTel trace context 请求作用域透传（P6 / SEP-414）
 *
 * Hub 作为网关，从 MCP 客户端请求的 _meta 提取 W3C trace context
 * （traceparent/tracestate/baggage），用 AsyncLocalStorage 在请求异步链内透传，
 * 调用上游 server 时注入回 _meta。纯字符串透传：不解析、不采样、不生成 span。
 *
 * _meta 是 SEP-414 的唯一 MCP 协议载体（transport-agnostic：stdio 无 HTTP header，
 * _meta 是所有 transport 共有的扩展点）。
 *
 * 零 OTel SDK 依赖。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** W3C Trace Context 三件套（纯字符串透传，不解析） */
export interface TraceContext {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

const traceContextStore = new AsyncLocalStorage<TraceContext>();

/**
 * 从 MCP 请求 _meta 提取 trace context（SEP-414 官方载体）。
 * 非字符串字段忽略，缺失字段返回 undefined。
 */
export function extractFromMeta(meta?: Record<string, unknown>): TraceContext {
  if (!meta) {
    return { traceparent: undefined, tracestate: undefined, baggage: undefined };
  }
  return {
    traceparent: typeof meta.traceparent === 'string' ? meta.traceparent : undefined,
    tracestate: typeof meta.tracestate === 'string' ? meta.tracestate : undefined,
    baggage: typeof meta.baggage === 'string' ? meta.baggage : undefined,
  };
}

/**
 * 从 W3C HTTP header 提取 trace context（兼容非 MCP 标准客户端）。
 */
export function extractFromHeaders(headers: Headers): TraceContext {
  return {
    traceparent: headers.get('traceparent') ?? undefined,
    tracestate: headers.get('tracestate') ?? undefined,
    baggage: headers.get('baggage') ?? undefined,
  };
}

/**
 * 判断 context 是否含有效字段（决定是否注入）。
 */
export function hasTraceContext(ctx: TraceContext): boolean {
  return Boolean(ctx.traceparent || ctx.tracestate || ctx.baggage);
}

/**
 * 在请求作用域内运行 fn，注入 context 到 AsyncLocalStorage。
 *
 * 三字段全空时仍正常执行 fn（以空对象进 scope），不阻断流程。
 */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return traceContextStore.run(hasTraceContext(ctx) ? ctx : {}, fn);
}

/**
 * 出站读取当前请求作用域的 context（无 scope 则返回空对象，不抛错）。
 */
export function getCurrentTraceContext(): TraceContext {
  return traceContextStore.getStore() ?? {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test trace-context.unit.test`
Expected: PASS（全部用例，含并发隔离、嵌套 scope）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/trace-context.ts backend/src/middleware/trace-context.unit.test.ts
git commit -m "feat(p6): add TraceContextStore for OTel trace context propagation"
```

---

### Task 2: 出站注入（server_manager + 单元测试扩展）

**Files:**

- Modify: `backend/src/services/server_manager.ts`（`executeToolOnServer` 的 `callTool` 调用，约 L302-310）
- Test: `backend/src/services/server_manager.unit.test.ts`（扩展 `executeToolOnServer` describe 块）

**Interfaces:**

- Consumes: `getCurrentTraceContext()`、`hasTraceContext(ctx)`（来自 Task 1）。
- Produces: `executeToolOnServer` 现在会在 ALS 有 context 时给 `client.callTool` 传 `_meta`。

**关键约束**：现有测试 `should execute tool successfully`（L208）断言 `callTool` 被调用时参数为 `{ name, arguments }`（无 `_meta`）。该测试在 ALS 无 scope 时运行——改动后无 context 不加 `_meta`，**此断言仍应通过**（零回归）。

- [ ] **Step 1: Write the failing test**

在 `backend/src/services/server_manager.unit.test.ts` 的 `describe('executeToolOnServer', ...)` 块内（L192-240 之间），追加三个用例。先在文件顶部加 import：

```typescript
import { runWithTraceContext, type TraceContext } from '../middleware/trace-context.js';
```

在 `describe('executeToolOnServer', () => { ... })` 内追加：

```typescript
it('ALS 有 context 时 callTool 收到 _meta（trace 三件套注入）', async () => {
  const mockResult = { content: [{ type: 'text', text: 'Success' }] };
  mockClient.callTool.mockResolvedValue(mockResult);
  const ctx: TraceContext = {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
    tracestate: 'congo=t61rcWkgMzE',
    baggage: 'userId=am9',
  };

  const result = await runWithTraceContext(ctx, () =>
    serverManager.executeToolOnServer('test-server-1', 'test-tool', { arg1: 'value1' }),
  );

  expect(result).toEqual(mockResult);
  expect(mockClient.callTool).toHaveBeenCalledWith({
    name: 'test-tool',
    arguments: { arg1: 'value1' },
    _meta: {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      tracestate: 'congo=t61rcWkgMzE',
      baggage: 'userId=am9',
    },
  });
});

it('ALS context 部分字段缺失时 _meta 只含存在的字段', async () => {
  mockClient.callTool.mockResolvedValue({ content: [] });
  const ctx: TraceContext = { traceparent: '00-trace-span-01' };

  await runWithTraceContext(ctx, () =>
    serverManager.executeToolOnServer('test-server-1', 'test-tool', {}),
  );

  expect(mockClient.callTool).toHaveBeenCalledWith({
    name: 'test-tool',
    arguments: {},
    _meta: { traceparent: '00-trace-span-01' },
  });
});

it('ALS 无 context 时 callTool 不含 _meta（零回归）', async () => {
  mockClient.callTool.mockResolvedValue({ content: [] });
  // 不在 runWithTraceContext scope 内
  await serverManager.executeToolOnServer('test-server-1', 'test-tool', { a: 1 });

  expect(mockClient.callTool).toHaveBeenCalledWith({
    name: 'test-tool',
    arguments: { a: 1 },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test server_manager.unit.test`
Expected: 前两个新用例 FAIL（`callTool` 被调用时参数无 `_meta`）；第三个用例 PASS（零回归验证，改动前就成立）。

- [ ] **Step 3: Write minimal implementation**

在 `backend/src/services/server_manager.ts` 顶部加 import（L10 `import { logger }` 之后）：

```typescript
import { getCurrentTraceContext, hasTraceContext } from '../middleware/trace-context.js';
```

修改 `executeToolOnServer` 内的 `callTool` 调用（当前约 L307-310）。**原代码**：

```typescript
const response = await server.client.callTool({
  name: toolName,
  arguments: args,
});
```

**改为**：

```typescript
const callParams: {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: Record<string, string>;
} = {
  name: toolName,
  arguments: args,
};
// P6/SEP-414：从当前请求作用域（ALS）读取 trace context，注入到上游 callTool 的 _meta。
// 无 context 时不加 _meta，保持无 trace 请求的零回归。
const traceCtx = getCurrentTraceContext();
if (hasTraceContext(traceCtx)) {
  callParams._meta = Object.fromEntries(
    Object.entries(traceCtx).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}
const response = await server.client.callTool(callParams);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test server_manager.unit.test`
Expected: PASS（三个新用例 + 原有 `executeToolOnServer` 用例全绿，含 L208 的 `should execute tool successfully` 零回归）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/server_manager.ts backend/src/services/server_manager.unit.test.ts
git commit -m "feat(p6): inject trace context _meta into upstream callTool"
```

---

### Task 3: 入站提取（group-service 工具 handler）

**Files:**

- Modify: `backend/src/api/mcp/group-service.ts`（`registerGroupDynamicTools` 内的 `registerTool` handler，约 L620-667）

**Interfaces:**

- Consumes: `extractFromMeta(meta?)`、`runWithTraceContext(ctx, fn)`（来自 Task 1）。
- Produces: 动态工具 handler 现在从 SDK `extra._meta` 提取 trace context 并在 ALS scope 内执行后续逻辑，使 Task 2 的出站注入能读到 context。

**关键约束**：

- MCP SDK v2 的 `registerTool(name, { inputSchema }, handler)` 的 handler 签名是 `(args, extra) => result`，`extra` 含 `_meta`、`requestId` 等。用 optional chaining `extra?._meta` 防御 SDK 版本差异。
- 入站提取**只在动态工具 handler 做**（`tools/call` 是触发上游调用的主链路）。`group_status`/`list_group_tools` 内置工具不调上游 server，不包裹。
- **不改 handler 的返回值类型或业务逻辑**——只是把原有逻辑包进 `runWithTraceContext`。

- [ ] **Step 1: 确认当前 handler 签名与改动点**

读 `backend/src/api/mcp/group-service.ts` L620-667，确认现有 handler 是 `async (args) => { ... }`，内部调用 `this.coreServiceManager.executeToolCall(tool.name, args, tool.serverId)`。改动 = handler 加第二参 `extra`，整体包进 `runWithTraceContext`。

- [ ] **Step 2: Modify implementation**

在 `backend/src/api/mcp/group-service.ts` 顶部 import 区加（L7 `McpServer` import 之后）：

```typescript
import { extractFromMeta, runWithTraceContext } from '../../middleware/trace-context.js';
```

修改 `registerGroupDynamicTools` 内的 `registerTool` 调用（约 L622）。**原代码**（handler 起始）：

```typescript
      this.mcpServer.registerTool(toolName, { inputSchema: z.object(zodSchema) }, async (args) => {
        try {
          logger.debug('执行组动态工具', {
            groupId: this.groupId,
            toolName: tool.name,
            serverId: tool.serverId,
            args,
          });

          const result = await this.coreServiceManager.executeToolCall(
            tool.name,
            args,
            tool.serverId,
          );
```

**改为**（handler 加 `extra` 参，整段 try/catch 包进 `runWithTraceContext`）：

```typescript
      this.mcpServer.registerTool(
        toolName,
        { inputSchema: z.object(zodSchema) },
        async (args, extra) => {
          // P6/SEP-414：从请求 _meta 提取 trace context，注入 AsyncLocalStorage，
          // 使下游 server_manager.executeToolOnServer 的出站 callTool 能读到并注入上游 _meta。
          const traceCtx = extractFromMeta(extra?._meta);
          return runWithTraceContext(traceCtx, async () => {
            try {
              logger.debug('执行组动态工具', {
                groupId: this.groupId,
                toolName: tool.name,
                serverId: tool.serverId,
                args,
              });

              const result = await this.coreServiceManager.executeToolCall(
                tool.name,
                args,
                tool.serverId,
              );
```

然后整个原有 handler 主体（从 `try {` 到 handler 闭合的 `});`）整体右移一层（多缩进 2 空格），并在末尾把 handler 的闭合改为：

**原 handler 结尾**（约 L667）：

```typescript
          return {
            content: [
              {
                type: 'text' as const,
                text: `工具执行失败: ${(error as Error).message}`,
              },
            ],
          };
        }
      });
```

**改为**（多一层 `runWithTraceContext` 的闭合）：

```typescript
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `工具执行失败: ${(error as Error).message}`,
                  },
                ],
              };
            }
          });
        },
      );
```

> 注意：因为整段 try/catch 右移一层，`return` 语句和闭合括号都要相应调整缩进。改动后用 `pnpm typecheck` 验证语法/类型。

- [ ] **Step 3: typecheck 验证改动无语法错误**

Run: `pnpm --filter backend typecheck`（或仓库根 `pnpm typecheck`）
Expected: PASS（无 TS 错误）。

- [ ] **Step 4: Run existing group-service tests to verify no regression**

Run: `pnpm --filter backend test group-service`
Expected: PASS（现有用例全绿——改动只是包一层 ALS，业务逻辑不变）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/mcp/group-service.ts
git commit -m "feat(p6): extract trace context from inbound _meta in tool handlers"
```

---

### Task 4: 集成测试（入站 \_meta → ALS → 回显，连通主链路）

**Files:**

- Test: `backend/src/api/mcp/trace-context-integration.unit.test.ts`（新增）

**Interfaces:**

- Consumes: `runWithTraceContext`、`getCurrentTraceContext`（Task 1）；验证 Task 3 的入站提取逻辑（在隔离的单元层面模拟 handler 行为）。

**测试策略说明**：真正的 e2e（真实 MCP 客户端带 `_meta` → Hub → 真实上游 server 断言 `_meta`）受限于当前 e2e fixture：`default` 组上游是 `echo` stdio server（不暴露工具，`callTool` 不可达）。因此用**集成单元测试**验证入站提取→ALS→出站读取这条链路在进程内连通：模拟一个"回显工具"（handler 读 `getCurrentTraceContext()` 并返回），验证 SDK `extra._meta` 经 `extractFromMeta` + `runWithTraceContext` 后能在 handler 内被 `getCurrentTraceContext` 读到。出站 `callTool._meta` 注入由 Task 2 单元测试覆盖。

- [ ] **Step 1: Write the failing test**

Create `backend/src/api/mcp/trace-context-integration.unit.test.ts`:

```typescript
/**
 * P6 trace context 集成测试
 *
 * 验证入站提取 → ALS 透传 → 出站读取 这条链路在进程内连通：
 * 模拟 SDK 工具 handler（从 extra._meta 提取 + runWithTraceContext 包裹），
 * 在 handler 内用 getCurrentTraceContext 读取，断言与传入 _meta 一致。
 *
 * 这是 group-service.ts 工具 handler 改动（Task 3）+ server_manager 出站注入（Task 2）
 * 之间 ALS 链路的连通性验证。真正的端到端（真实上游断言 _meta）受 e2e fixture
 * 限制（default 组上游是 echo stdio，不暴露工具），由 Task 2 的 callTool._meta 注入
 * 单元测试 + 本集成测试共同覆盖。
 */
import { describe, expect, it } from 'vitest';

import {
  getCurrentTraceContext,
  runWithTraceContext,
  extractFromMeta,
  hasTraceContext,
  type TraceContext,
} from '../middleware/trace-context.js';

/**
 * 模拟 group-service.ts 动态工具 handler 的结构：
 * (args, extra) => runWithTraceContext(extractFromMeta(extra._meta), () => { ... })
 * handler 内模拟"出站读取"——即 server_manager.executeToolOnServer 会做的事。
 */
async function simulateToolHandler(
  args: Record<string, unknown>,
  extra: { _meta?: Record<string, unknown> },
): Promise<{ echoedTrace: TraceContext; receivedArgs: Record<string, unknown> }> {
  const traceCtx = extractFromMeta(extra?._meta);
  return runWithTraceContext(traceCtx, async () => {
    // 模拟 handler 内调用 executeToolCall → executeToolOnServer，
    // 后者会 getCurrentTraceContext() 读 context。这里直接读并回显。
    const echoedTrace = getCurrentTraceContext();
    return { echoedTrace, receivedArgs: args };
  });
}

describe('P6 trace context 集成：入站 _meta → ALS → 出站读取', () => {
  it('客户端带完整 _meta 时，handler 内能读到完整 trace 三件套', async () => {
    const clientMeta = {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      tracestate: 'congo=t61rcWkgMzE',
      baggage: 'userId=am9',
    };

    const { echoedTrace, receivedArgs } = await simulateToolHandler(
      { q: 'hello' },
      {
        _meta: clientMeta,
      },
    );

    expect(receivedArgs).toEqual({ q: 'hello' });
    expect(echoedTrace).toEqual(clientMeta);
    expect(hasTraceContext(echoedTrace)).toBe(true);
  });

  it('客户端只带 traceparent 时，handler 内读到部分 context', async () => {
    const { echoedTrace } = await simulateToolHandler(
      {},
      {
        _meta: { traceparent: '00-trace-span-01' },
      },
    );
    expect(echoedTrace.traceparent).toBe('00-trace-span-01');
    expect(echoedTrace.tracestate).toBeUndefined();
    expect(echoedTrace.baggage).toBeUndefined();
  });

  it('客户端不带 _meta 时，handler 内 context 为空（不阻断，hasTraceContext=false）', async () => {
    const { echoedTrace } = await simulateToolHandler({}, {});
    expect(echoedTrace).toEqual({
      traceparent: undefined,
      tracestate: undefined,
      baggage: undefined,
    });
    expect(hasTraceContext(echoedTrace)).toBe(false);
  });

  it('客户端 extra 无 _meta 字段时（防御 SDK 版本差异），不抛错', async () => {
    const { echoedTrace } = await simulateToolHandler({}, {});
    expect(hasTraceContext(echoedTrace)).toBe(false);
  });

  it('并发工具调用 _meta 互不串扰', async () => {
    const run = (tp: string) => simulateToolHandler({ id: tp }, { _meta: { traceparent: tp } });

    const [a, b, c] = await Promise.all([run('00-A-1-01'), run('00-B-1-01'), run('00-C-1-01')]);

    expect(a.echoedTrace.traceparent).toBe('00-A-1-01');
    expect(b.echoedTrace.traceparent).toBe('00-B-1-01');
    expect(c.echoedTrace.traceparent).toBe('00-C-1-01');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm --filter backend test trace-context-integration.unit.test`
Expected: PASS。（此测试依赖 Task 1 已实现，验证 Task 3 将采用的 handler 模式正确。若 Task 1 已合并，应直接通过。）

- [ ] **Step 3: Commit**

```bash
git add backend/src/api/mcp/trace-context-integration.unit.test.ts
git commit -m "test(p6): integration test for inbound _meta → ALS → outbound read"
```

---

### Task 5: 全量验证 + 回填总体 spec

**Files:**

- 无代码改动；验证 + 文档更新。

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: PASS（backend + 所有 packages）。

- [ ] **Step 2: 全量单元测试**

Run: `pnpm test`
Expected: PASS（含 Task 1-4 新增/扩展测试，且原有测试零回归）。记录测试总数。

- [ ] **Step 3: 全量 e2e（若有 e2e 环境则验证零回归）**

Run: `pnpm test:e2e`
Expected: PASS（P6 不改 e2e fixture，现有 e2e 零回归）。若 e2e 环境未起，记录跳过原因。

- [ ] **Step 4: 弃用项/日志核实 grep 复核**

Run（预期全部零或仅 test 残留，确认 P6 无需清理）：

```bash
grep -rn "includeContext" backend/src packages/core/src --include="*.ts" | grep -v node_modules | grep -v "\.test\.ts"
grep -rn "roots/list\|sampling/createMessage\|elicitation/create" backend/src packages/core/src --include="*.ts" | grep -v node_modules | grep -v "\.test\.ts"
grep -rn "tasks/list\|CreateTaskResult\|TaskStatus" backend/src packages/core/src --include="*.ts" | grep -v node_modules | grep -v "\.test\.ts"
grep -rn "console\." backend/src --include="*.ts" | grep -v node_modules | grep -v "\.test\.ts" | grep -v "/test/" | grep -v "/e2e/" | grep -v "/integration/" | grep -v "test-app.ts"
```

Expected: 前三条 0 命中（或仅无关变量名）；第四条 0 命中（backend 生产 console.\* 已干净）。

- [ ] **Step 5: 回填总体跟踪 spec**

修改 `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md`：

1. **子项目全景表**（§子项目全景，P6 行）：spec 状态 `⏳ 待 brainstorming` → `✅ 完成`；实现进度 `⬜ 未开始` → `✅ 实现完成`；详细 spec 列填 `2026-07-28-p6-otel-deprecation-design.md`。

2. **各子项目实现进度表**（§各子项目实现进度，P6 行）：填分支与关键 commit、进度描述（如"✅ 实现完成（typecheck + N tests 全绿，含 P6 trace context 单元+集成测试）"）。

3. **跨子项目共享待办**（§跨子项目共享待办，console._ 行）：状态列改为 `✅ 已核实：backend/src 生产 console._ = 0，原描述滞后；CLI/share 的 console.\* 是合理 stdout/logger 实现`；归属/何时做列标 `—`。

- [ ] **Step 6: Commit spec 回填**

```bash
git add docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md
git commit -m "docs(p6): backfill adoption-overview — P6 complete, console.* already clean"
```

---

### Task 6: BackendCoreServiceAdapter（core 接口 → 真实 ServerManager 适配器）

> **背景（spec §10）**：原 Task 1-5 完成后，最终 review 发现 P6 入站点（group-service）与出站点（ServerManager）分属两套不连通的工具执行体系——group-service 走 core 的 mock `McpServiceManager`，ServerManager 是 backend 真实实现。Task 6/7 用注入式适配器连通两者，让 trace 链路（与 MCP 端点真实工具调用）同时生效。

**Files:**

- Create: `backend/src/services/backend-core-service-adapter.ts`
- Test: `backend/src/services/backend-core-service-adapter.unit.test.ts`
- Modify: `backend/src/services/mcp_hub_service.ts`（L72 `private serverManager` → 暴露 getter）

**Interfaces:**

- Consumes: `McpServiceManagerInterface`（core 契约，`@mcp-core/mcp-hub-core`）；backend `ServerManager`（`getAllServers`/`getServerTools`/`executeToolOnServer`/`getServerStatus`/`initialize`/`shutdown`）。
- Produces: `BackendCoreServiceAdapter implements McpServiceManagerInterface`，供 Task 7 注入到 `initCoreServiceManager`。

**关键约束**：

- 适配器 `executeToolCall` 运行时**直接透传** backend `ServerManager.executeToolOnServer` 的 MCP 原生结果（带 `content`/`isError`），不转成 core `ToolResult` 的 `{success, data}`——因为 `group-service` handler 用 `'content' in result` 判定返回格式。类型上声明返回 core `ToolResult`（其 `data: unknown` 兼容），但实际返回 MCP 结果。
- `getAllTools` 聚合所有 server 的工具（遍历 `getAllServers` 调 `getServerTools`），返回 `ToolInfo[]`（backend `Tool` 字段是 `ToolInfo` 超集，结构兼容）。
- 适配器委托的 `ServerManager.executeToolOnServer` 已含 P6 Task 2 的 trace `_meta` 注入（读 ALS），故 trace 链路自动打通。

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/backend-core-service-adapter.unit.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { BackendCoreServiceAdapter } from './backend-core-service-adapter.js';

import type { McpServiceManagerInterface } from '@mcp-core/mcp-hub-core';
import type { ServerManager } from './server_manager.js';
import type { ServerConnection, ServerStatus, Tool } from '../types/mcp-hub.js';

// 构造一个 mock ServerManager，仅 stub 适配器用到的方法
function makeMockServerManager(overrides: Partial<ServerManager> = {}): ServerManager {
  return {
    getAllServers: vi.fn(),
    getServerTools: vi.fn(),
    executeToolOnServer: vi.fn(),
    getServerStatus: vi.fn(),
    initialize: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
  } as unknown as ServerManager;
}

describe('BackendCoreServiceAdapter', () => {
  it('实现 McpServiceManagerInterface（类型契约）', () => {
    const adapter = new BackendCoreServiceAdapter(makeMockServerManager());
    // 适配器必须可赋值给 McpServiceManagerInterface（编译期保证）
    const _asInterface: McpServiceManagerInterface = adapter;
    expect(_asInterface).toBe(adapter);
  });

  it('executeToolCall 委托 ServerManager.executeToolOnServer 并透传 MCP 原生结果（带 content）', async () => {
    const mcpResult = { content: [{ type: 'text', text: 'real result' }] };
    const sm = makeMockServerManager({
      executeToolOnServer: vi.fn().mockResolvedValue(mcpResult),
    });
    const adapter = new BackendCoreServiceAdapter(sm);

    const result = await adapter.executeToolCall('my-tool', { q: 'x' }, 'srv-1');

    expect(sm.executeToolOnServer).toHaveBeenCalledWith('srv-1', 'my-tool', { q: 'x' });
    // 关键：透传 MCP 原生结果（含 content），不转成 {success, data}
    expect(result).toEqual(mcpResult);
    expect((result as { content?: unknown }).content).toBeDefined();
  });

  it('executeToolCall 无 serverId 时抛错（适配器不猜 server）', async () => {
    const adapter = new BackendCoreServiceAdapter(makeMockServerManager());
    await expect(adapter.executeToolCall('tool', {})).rejects.toThrow(/serverId/i);
  });

  it('getAllTools 聚合所有 server 的工具（结构兼容 ToolInfo）', async () => {
    const toolsA: Tool[] = [{ name: 'a_tool', inputSchema: {}, serverId: 'srv-a' }];
    const toolsB: Tool[] = [{ name: 'b_tool', inputSchema: {}, serverId: 'srv-b' }];
    const sm = makeMockServerManager({
      getAllServers: vi.fn().mockReturnValue(
        new Map<string, ServerConnection>([
          ['srv-a', { id: 'srv-a', status: 'connected' as ServerStatus } as ServerConnection],
          ['srv-b', { id: 'srv-b', status: 'connected' as ServerStatus } as ServerConnection],
        ]),
      ),
      getServerTools: vi
        .fn()
        .mockImplementation((serverId: string) =>
          serverId === 'srv-a' ? Promise.resolve(toolsA) : Promise.resolve(toolsB),
        ),
    });
    const adapter = new BackendCoreServiceAdapter(sm);

    const all = await adapter.getAllTools();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name).sort()).toEqual(['a_tool', 'b_tool']);
    // 每个工具带 serverId（group-service 按此过滤组内工具）
    expect(all.every((t) => t.serverId)).toBe(true);
  });

  it('getServerTools 委托 ServerManager.getServerTools', async () => {
    const sm = makeMockServerManager({
      getServerTools: vi.fn().mockResolvedValue([{ name: 't', inputSchema: {}, serverId: 's' }]),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    const tools = await adapter.getServerTools('s');
    expect(sm.getServerTools).toHaveBeenCalledWith('s');
    expect(tools).toHaveLength(1);
  });

  it('getServerConnections 委托 getAllServers', () => {
    const conns = new Map([['s', { id: 's' } as ServerConnection]]);
    const sm = makeMockServerManager({ getAllServers: vi.fn().mockReturnValue(conns) });
    const adapter = new BackendCoreServiceAdapter(sm);
    expect(adapter.getServerConnections()).toBe(conns);
    expect(sm.getAllServers).toHaveBeenCalled();
  });

  it('getServiceStatus 返回含 serverCount 与 connected 数', () => {
    const sm = makeMockServerManager({
      getAllServers: vi.fn().mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: 'connected' as ServerStatus } as ServerConnection],
          ['s2', { id: 's2', status: 'disconnected' as ServerStatus } as ServerConnection],
        ]),
      ),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    const status = adapter.getServiceStatus();
    expect(status.serverCount).toBe(2);
    expect(status.connectedServers).toBe(1);
  });

  it('isToolAvailable 检查 server 的 tools 是否含该工具', async () => {
    const sm = makeMockServerManager({
      getServerTools: vi
        .fn()
        .mockResolvedValue([{ name: 'find-me', inputSchema: {}, serverId: 's' }]),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    expect(await adapter.isToolAvailable('find-me', 's')).toBe(true);
    expect(await adapter.isToolAvailable('missing', 's')).toBe(false);
  });

  it('initializeFromConfig / shutdown / registerServer 委托 ServerManager', async () => {
    const sm = makeMockServerManager({
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    await adapter.initializeFromConfig({ servers: {} } as never);
    await adapter.registerServer('s', { type: 'stdio', command: 'x' } as never);
    await adapter.shutdown();
    expect(sm.initialize).toHaveBeenCalled();
    expect(sm.shutdown).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mcp-core/mcp-hub-api test backend-core-service-adapter`
Expected: FAIL（`BackendCoreServiceAdapter` 未定义）。

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/services/backend-core-service-adapter.ts`:

```typescript
/**
 * BackendCoreServiceAdapter（P6 架构修正，spec §10.3）
 *
 * 让 group-service（依赖 core 的 McpServiceManagerInterface 抽象接口）拿到真实的
 * backend ServerManager 实现，而非 core 包的 mock McpServiceManager。
 *
 * core 当壳（抽象接口），backend 当引擎（真实连接 + client.callTool）。
 * 委托的 ServerManager.executeToolOnServer 已含 P6 Task 2 的 trace _meta 注入，
 * 故 trace 链路（group-service handler → 适配器 → ServerManager）自动打通。
 *
 * 注入点：service-registry.ts 的 initCoreServiceManager（Task 7）。
 */
import type { McpServiceManagerInterface } from '@mcp-core/mcp-hub-core';
import type {
  ServerConnection,
  ServerStatus as BackendServerStatus,
  Tool,
} from '../types/mcp-hub.js';
import type { ServerManager } from './server_manager.js';
import type { ServerConfig, McpServerConfig } from '@mcp-core/mcp-hub-share';
import type { ServiceStatus, ToolInfo, ToolResult } from '@mcp-core/mcp-hub-core';

export class BackendCoreServiceAdapter implements McpServiceManagerInterface {
  constructor(private readonly serverManager: ServerManager) {}

  async initializeFromConfig(_config: McpServerConfig): Promise<void> {
    // ServerManager 在 McpHubService 构造时已按配置初始化，此处委托 ensure initialized。
    await this.serverManager.initialize();
  }

  async registerServer(serverId: string, _config: ServerConfig): Promise<void> {
    // 配置驱动的注册由 McpHubService 管理；适配器保留接口契约，no-op。
    // （group-service 不调用此方法；保留仅为满足接口完整性。）
  }

  async getAllTools(): Promise<ToolInfo[]> {
    const servers = this.serverManager.getAllServers();
    const perServer = await Promise.all(
      Array.from(servers.keys()).map((id) => this.serverManager.getServerTools(id)),
    );
    // backend Tool 是 ToolInfo 的结构超集（name/description/serverId/inputSchema），
    // 直接扁平化返回，结构兼容。
    return perServer.flat() as unknown as ToolInfo[];
  }

  async getServerTools(serverId: string): Promise<ToolInfo[]> {
    return (await this.serverManager.getServerTools(serverId)) as unknown as ToolInfo[];
  }

  async executeToolCall(toolName: string, args: unknown, serverId?: string): Promise<ToolResult> {
    if (!serverId) {
      throw new Error(
        `BackendCoreServiceAdapter.executeToolCall 需要 serverId（工具 ${toolName} 未绑定 server）`,
      );
    }
    // 直接透传 MCP 原生结果（带 content/isError），供 group-service handler 的
    // 'content' in result 判定使用。类型上 ToolResult.data: unknown 兼容。
    const mcpResult = await this.serverManager.executeToolOnServer(
      serverId,
      toolName,
      args as Record<string, unknown>,
    );
    return mcpResult as unknown as ToolResult;
  }

  getServiceStatus(): ServiceStatus {
    const servers = this.serverManager.getAllServers();
    const values = Array.from(servers.values());
    const connected = values.filter((s) => s.status === ('connected' as BackendServerStatus));
    return {
      initialized: connected.length > 0,
      serverCount: values.length,
      connectedServers: connected.length,
      // 兼容 core ServiceStatus 的其他可选字段由消费者防御性读取
    } as ServiceStatus;
  }

  getServerConnections(): Map<string, ServerConnection> {
    return this.serverManager.getAllServers();
  }

  async isToolAvailable(toolName: string, serverId?: string): Promise<boolean> {
    const ids = serverId ? [serverId] : Array.from(this.serverManager.getAllServers().keys());
    for (const id of ids) {
      const tools = await this.serverManager.getServerTools(id);
      if (tools.some((t) => t.name === toolName)) return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    await this.serverManager.shutdown();
  }
}
```

修改 `backend/src/services/mcp_hub_service.ts`：把 `private serverManager: ServerManager;`（L72）改为暴露 getter。**原代码**：

```typescript
  private serverManager: ServerManager;
```

**改为**：

```typescript
  private serverManager: ServerManager;

  /**
   * 暴露 ServerManager 供 BackendCoreServiceAdapter 委托（P6 架构修正，spec §10.3）。
   * 适配器让 group-service（经 McpServiceManagerInterface）拿到真实连接/调用。
   */
  getServerManager(): ServerManager {
    return this.serverManager;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mcp-core/mcp-hub-api test backend-core-service-adapter`
Expected: PASS（全部用例）。

- [ ] **Step 5: typecheck 验证（适配器实现 core 接口的类型正确性）**

Run（在 backend 目录）：`pnpm exec tsc --noEmit`
Expected: PASS（无类型错误）。

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/backend-core-service-adapter.ts backend/src/services/backend-core-service-adapter.unit.test.ts backend/src/services/mcp_hub_service.ts
git commit -m "feat(p6): add BackendCoreServiceAdapter to bridge core interface to real ServerManager"
```

---

### Task 7: 接线注入点 + 端到端验证

**Files:**

- Modify: `backend/src/services/service-registry.ts`（`initCoreServiceManager` L92-106）

**Interfaces:**

- Consumes: `BackendCoreServiceAdapter`（Task 6）、`getHubService`（已存在）。
- Produces: `getCoreServiceManager()` 返回注入真实 ServerManager 的适配器，使 group-service / groups API 拿到真实数据，P6 trace 链路端到端打通。

**关键约束**：

- 只改 `initCoreServiceManager`：把 `new McpServiceManager()` 换成 `new BackendCoreServiceAdapter(hubService.getServerManager())`。
- `hubService` 来自 `getHubService()`（已初始化，其 ServerManager 已连上游）。若 hubService 尚未初始化，需先 `getHubService()`（其内部会惰性初始化）。
- 保持 `getCoreServiceManager()` 的签名与返回类型不变（消费者零改动）。返回类型仍是 `McpServiceManager`——这里需调整为返回适配器（实现同一接口）。**注意类型**：`coreServiceManager` 单例变量当前类型是 `McpServiceManager`，改为 `McpServiceManagerInterface` 或 `BackendCoreServiceAdapter`。

- [ ] **Step 1: Modify the injection point**

在 `backend/src/services/service-registry.ts`：

1. 顶部加 import：

```typescript
import { BackendCoreServiceAdapter } from './backend-core-service-adapter.js';
```

2. 把单例变量类型从 `McpServiceManager` 改为接口类型（保持消费端类型兼容）。**原**：

```typescript
let coreServiceManager: McpServiceManager | null = null;
```

**改为**：

```typescript
let coreServiceManager: McpServiceManagerInterface | null = null;
```

（需补 import `McpServiceManagerInterface`，且更新各函数返回类型为 `McpServiceManagerInterface`。）

3. 改 `initCoreServiceManager`。**原代码**（L92-106）：

```typescript
export async function initCoreServiceManager(): Promise<McpServiceManager> {
  if (coreServiceManager) {
    return coreServiceManager;
  }

  const config = await getAllConfig();
  coreServiceManager = new McpServiceManager();
  const coreConfig = toMcpServerConfig({
    mcps: asMutable<McpConfig>(config.mcps as DeepReadonly<McpConfig>),
    groups: asMutable<GroupConfig>(config.groups as DeepReadonly<GroupConfig>),
  });
  await coreServiceManager.initializeFromConfig(coreConfig);

  logger.info('McpServiceManager 初始化成功');
  return coreServiceManager;
}
```

**改为**：

```typescript
export async function initCoreServiceManager(): Promise<McpServiceManagerInterface> {
  if (coreServiceManager) {
    return coreServiceManager;
  }

  // P6 架构修正（spec §10.3）：注入 backend 真实 ServerManager（经 McpHubService），
  // 替代 core 包的 mock McpServiceManager。使 group-service / groups API 拿到真实
  // 连接状态与工具调用，并打通 P6 trace context 链路。
  const hubService = getHubService();
  coreServiceManager = new BackendCoreServiceAdapter(hubService.getServerManager());

  logger.info('CoreServiceManager 已注入真实 ServerManager（BackendCoreServiceAdapter）');
  return coreServiceManager;
}
```

4. 同步更新 `getCoreServiceManager`/`reloadCoreServiceManager`/`shutdownCoreServiceManager` 的返回类型为 `McpServiceManagerInterface`。

- [ ] **Step 2: typecheck 验证接线类型正确**

Run（在 backend 目录）：`pnpm exec tsc --noEmit`
Expected: PASS。若有类型错误（如某处仍期望 `McpServiceManager` 具体类），按错误提示修正（消费者应依赖接口而非具体类）。

- [ ] **Step 3: Run full unit test suite（验证 groups API + group-service 零回归/改善）**

Run: `pnpm --filter @mcp-core/mcp-hub-api test`
Expected: PASS（现有 542+ 测试全绿；适配器新增测试通过）。注意：原本依赖 core mock 行为的测试若失败，需核实是"测试在验证 mock 行为"（应改为验证真实行为）还是真回归。

- [ ] **Step 4: 端到端 trace 传播验证（手工或新增集成断言）**

验证 P6 trace 链路端到端连通（此时 group-service → 适配器 → ServerManager 已连）：

- 确认 `group-service` handler 调 `coreServiceManager.executeToolCall` 时，实际走到 backend `ServerManager.executeToolOnServer`（而非 core mock）。
- 可新增一个集成断言：在 ALS scope 内调 `adapter.executeToolCall`，mock `ServerManager.executeToolOnServer` 断言收到的 `_meta`（复用 Task 2 的 server_manager 注入测试逻辑）。

若新增集成测试，Run: `pnpm --filter @mcp-core/mcp-hub-api test`，Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/service-registry.ts
git commit -m "feat(p6): inject BackendCoreServiceAdapter into initCoreServiceManager — real tools for MCP endpoint"
```

---

## Self-Review（计划自审，执行者无需操作）

**Spec 覆盖**：

- §1.3 范围内 4 项：入站提取（Task 3）、ALS 透传（Task 1）、出站注入（Task 2）、HTTP header 兼容（spec 标可选 stretch，**本计划不实现**——spec §3.6 已注明可选，核心 `_meta` 路径独立可用，符合 MVP）。✅
- §4 弃用项清理：无代码工作，Task 5 Step 4 grep 复核 + spec §4 已文档化结论。✅
- §5 日志统一：无代码工作，Task 5 Step 4 grep 复核 + spec §5 已文档化。✅
- §6 测试矩阵：TraceContextStore 单元（Task 1）、server_manager 注入单元（Task 2）、集成测试（Task 4）。e2e 因 fixture 限制转为集成测试，spec §6.2 的 e2e 断言意图由 Task 4 的进程内回显覆盖（说明已记录于 Task 4 测试策略说明）。✅
- **§10 架构修正（实现期追加）**：BackendCoreServiceAdapter（Task 6）+ 注入点接线（Task 7）连通 group-service → 真实 ServerManager，让 P6 trace 链路（Task 2 出站 + Task 3 入站）端到端生效，同时修复 MCP 端点返回 mock 数据的预存 bug。✅

**Placeholder 扫描**：无 TBD/TODO；所有步骤含真实代码。✅

**类型一致性**：`TraceContext`（interface）、`extractFromMeta`/`extractFromHeaders`/`runWithTraceContext`/`getCurrentTraceContext`/`hasTraceContext` 在 Task 1-4 间签名一致。✅

**HTTP header 兼容组件**：spec §3.6 标为可选 stretch，本计划不实现（避免范围蔓延；`extractFromHeaders` 已在 Task 1 实现，未来启用时只需加 `group-router` 中间件）。已在 Task 5 之外的说明中记录此决定。
