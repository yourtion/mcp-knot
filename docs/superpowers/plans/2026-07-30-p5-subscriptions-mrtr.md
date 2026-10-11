# P5: subscriptions/listen + MRTR 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Hub 作为网关聚合多个上游 MCP server 的工具变更通知（`subscriptions/listen`），并支持多轮工具调用（MRTR `InputRequiredResult`）的中转。

**Architecture:** 两条解耦主线。Subscriptions 主线：`ServerManager` 订阅上游 `listChanged` + 60s 轮询兜底 → `UpstreamChangeDetector` emit 变更事件 → `UpstreamChangeFanout` 把变更 fan-out 到含该 server 的所有 group 的 `handler.bus`。MRTR 主线：`MrtrRelayService` 用 SDK `createRequestStateCodec`（HMAC-SHA256）mint Hub 级 requestState 作为 opaque 句柄，内部映射到上游 server + 上游原始 state；透传 handler 识别上游 `InputRequiredResult` 并委托 relay。

**Tech Stack:** TypeScript (ESM), Hono, `@modelcontextprotocol/*` v2 (升级到 2.0.0 GA), vitest, zod

**Spec:** `docs/superpowers/specs/2026-07-30-p5-subscriptions-mrtr-design.md`

## Global Constraints

- **SDK 版本**：Task 0 先升级到 `@modelcontextprotocol/{server,client,core,hono,node}@2.0.0`（GA）。后续 task 在 GA 版上开发。
- **测试框架**：vitest（`globals:true` 但显式 import）。unit 测试命名 `*.unit.test.ts`，放在被测文件同目录。e2e 测试在 `backend/src/e2e/`。
- **ESM import**：相对路径 import 必须带 `.js` 扩展名（如 `./foo.js`）。
- **统一 Logger**：用 `@mcp-core/mcp-hub-share` 的 logger，禁止 `console.*`（生产代码）。
- **测试配置隔离**：e2e 用 `setupTestConfig('open'|'oauth'|'validation')` 写临时配置，端口由 `E2E_PORT` 环境变量隔离。
- **vitest mock 注意**：`vitest.shared.ts` 设 `restoreMocks:true`，每个 test 自行 `vi.fn()` 或在 `beforeEach` 重置。
- **向后兼容**：所有新功能默认配置开关 `enabled: true`，但行为须不破坏无订阅/无 MRTR 的现有客户端。

## File Structure

**新增文件（8 个）：**

- `backend/src/services/upstream-change-detector.ts` — 双路检测上游工具变更（listChanged 订阅 + 轮询），emit 事件
- `backend/src/services/upstream-change-detector.unit.test.ts`
- `backend/src/services/upstream-change-fanout.ts` — serverId 变更 fan-out 到 group 的 handler.bus
- `backend/src/services/upstream-change-fanout.unit.test.ts`
- `backend/src/services/mrtr-relay-service.ts` — MRTR 中转：mint/verify Hub requestState
- `backend/src/services/mrtr-relay-service.unit.test.ts`
- `backend/src/e2e/mcp-protocol/subscriptions.test.ts` — subscriptions/listen e2e
- `backend/src/e2e/mcp-protocol/mrtr.test.ts` — MRTR e2e

**修改文件（9 个）：**

- `backend/package.json` + `packages/core/package.json` + `packages/cli/package.json` — SDK 版本 beta.5 → 2.0.0
- `backend/src/services/server_manager.ts` — 连接时声明 capabilities + 注册 notification handler；新增 `executeToolOnServerWithContext`；快照
- `backend/src/api/mcp/group-service.ts` — handler 识别 `InputRequiredResult`，接入 MRTR；新增 `refreshTools`
- `backend/src/api/mcp/mcp-handler-factory.ts` — 注入 `requestState.verify`；暴露 handler.bus 给 Fanout
- `backend/src/services/backend-core-service-adapter.ts` — 新增 `executeToolCallWithContext`
- `packages/core/src/services/mcp/service-manager.ts` — 接口加 `executeToolCallWithContext`
- `backend/src/e2e/test-server.ts` — 新增 `dynamic_tool_list` + `confirm_action` 测试工具
- `packages/share/src/config/schemas/system.schema.ts` + `group.schema.ts` — subscriptions/mrtr 配置

---

## Task 0: 升级 SDK beta.5 → 2.0.0 GA

**Files:**

- Modify: `backend/package.json`, `packages/core/package.json`, `packages/cli/package.json`

**Interfaces:**

- Produces: 所有 `@modelcontextprotocol/*` 依赖升至 `2.0.0`；P1-P6 现有行为保持不变（typecheck + 全量测试全绿）

- [ ] **Step 1: 改 3 个 package.json 的版本号**

把所有 `"@modelcontextprotocol/server": "2.0.0-beta.5"`（含 client/core/hono/node）改为 `"2.0.0"`。涉及 `backend/package.json`、`packages/core/package.json`、`packages/cli/package.json`。

```bash
# 确认改全
grep -rn '2.0.0-beta.5' backend/package.json packages/core/package.json packages/cli/package.json
# 期望：无输出（全部已改）
```

- [ ] **Step 2: 安装依赖更新 lockfile**

Run: `pnpm install`
Expected: lockfile 更新，无 peer dep 报错

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS（若有类型错误，记录错误信息——这是 GA 引入的 breaking，需评估修复）

- [ ] **Step 4: 全量 unit 测试**

Run: `pnpm test`
Expected: PASS（全绿；P1-P6 测试无回归）

- [ ] **Step 5: codemod 残留检查**

Run: `grep -rn '@mcp-codemod-error' . --exclude-dir=node_modules`
Expected: 仅 docs 命中，无代码新增残留

- [ ] **Step 6: 跑 e2e（至少 api-e2e project）**

Run: `pnpm --filter backend test:e2e` （或按项目实际 e2e 命令）
Expected: PASS

- [ ] **Step 7: 若有 breaking——记录并决策**

若 Step 3-6 任一失败：

1. 在本文件下方记录 breaking 详情（错误信息 + 根因）
2. 暂停，与用户确认是否继续（回滚条件：影响 P1-P6 现有行为）

若全绿：继续。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore(p5): upgrade SDK beta.5 → 2.0.0 GA

P5 前置：notify 总线 / createRequestStateCodec / subscriptions/listen
在 GA 版才稳定。P1-P6 全量回归通过（typecheck + unit + e2e）。"
```

---

## Task 1: UpstreamChangeDetector（上游工具变更检测）

纯逻辑组件，TDD 友好。负责检测上游工具集变化（listChanged 实时 + 轮询兜底），通过回调 emit 变更事件。

**Files:**

- Create: `backend/src/services/upstream-change-detector.ts`
- Test: `backend/src/services/upstream-change-detector.unit.test.ts`

**Interfaces:**

- Produces: `class UpstreamChangeDetector`，方法：
  - `saveSnapshot(serverId: string, tools: { name: string }[]): void` — 保存工具集快照
  - `onUpstreamNotification(serverId: string): void` — 收到 listChanged 时调用，触发比对
  - `startPolling(getTools: (serverId: string) => Promise<{ name: string }[]>, serverIds: string[]): void` — 启动轮询
  - `stop(): void` — 停止轮询（shutdown/test cleanup 用）
  - 构造参数：`{ onChange: (serverId: string) => void; pollIntervalMs: number; pollBackoffMs: number; logger: Logger }`
- Consumes: `Logger` from `@mcp-core/mcp-hub-share`

- [ ] **Step 1: 写签名比对 + 实时路径的失败测试**

```typescript
// backend/src/services/upstream-change-detector.unit.test.ts
import { describe, expect, it, vi } from 'vitest';
import { UpstreamChangeDetector } from './upstream-change-detector.js';

describe('UpstreamChangeDetector', () => {
  describe('工具集签名比对', () => {
    it('工具名集合变化时触发 onChange', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'tool_a' }, { name: 'tool_b' }]);
      // 模拟 listChanged 后重新拉取——工具集变化
      // onUpstreamNotification 内部会调外部 fetch 比对；为隔离，saveSnapshot+手动检测
      detector.saveSnapshot('s1', [{ name: 'tool_a' }, { name: 'tool_c' }]);
      detector.detectChanges('s1');
      expect(onChange).toHaveBeenCalledWith('s1');
    });

    it('仅描述变化（名字集合不变）不触发 onChange', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'tool_a', description: 'old' }]);
      detector.saveSnapshot('s1', [{ name: 'tool_a', description: 'new' }]);
      detector.detectChanges('s1');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('顺序不同但集合相同不触发', () => {
      const onChange = vi.fn();
      const detector = new UpstreamChangeDetector({
        onChange,
        pollIntervalMs: 60_000,
        pollBackoffMs: 300_000,
      });
      detector.saveSnapshot('s1', [{ name: 'b' }, { name: 'a' }]);
      detector.saveSnapshot('s1', [{ name: 'a' }, { name: 'b' }]);
      detector.detectChanges('s1');
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter backend vitest run src/services/upstream-change-detector.unit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 Detector 核心逻辑（签名 + 检测）**

```typescript
// backend/src/services/upstream-change-detector.ts
import type { Logger } from '@mcp-core/mcp-hub-share';

export interface UpstreamChangeDetectorOptions {
  onChange: (serverId: string) => void;
  pollIntervalMs: number;
  pollBackoffMs: number;
  logger?: Logger;
}

/**
 * 工具集签名：排序后 join，仅基于 name 集合。
 * 描述等非结构性变化不触发变更。
 */
function computeSignature(tools: { name: string }[]): string {
  return [...tools.map((t) => t.name)].sort().join('|');
}

export class UpstreamChangeDetector {
  private readonly opts: UpstreamChangeDetectorOptions;
  private readonly snapshots = new Map<string, string>(); // serverId → signature
  private readonly lastPushedAt = new Map<string, number>(); // serverId → 是否曾主动推送
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private getToolsFn: ((serverId: string) => Promise<{ name: string }[]>) | null = null;

  constructor(opts: UpstreamChangeDetectorOptions) {
    this.opts = opts;
  }

  /** 保存工具集快照（discoverServerTools / 比对后更新）*/
  saveSnapshot(serverId: string, tools: { name: string }[]): void {
    this.snapshots.set(serverId, computeSignature(tools));
  }

  /**
   * 检测指定 server 的工具集是否变化（对比已存快照）。
   * 注意：调用方应先用最新 tools 覆盖 saveSnapshot，再调本方法用「旧 vs 新」语义。
   * 此处实现：传入的 tools 与「上次记录的签名」比对，变化则 onChange 并更新签名。
   */
  detectChanges(serverId: string): void {
    // 见 Step 1 测试语义：saveSnapshot 覆盖后 detectChanges 比对前后。
    // 实际实现需区分「基准」与「当前」——见下方修正实现。
  }

  /** 收到上游 listChanged 通知时调用 */
  onUpstreamNotification(serverId: string): void {
    this.lastPushedAt.set(serverId, Date.now());
    // 实时路径：交由外部重新拉取并 saveSnapshot + detectChanges
    this.opts.onChange(serverId);
  }

  async startPolling(
    getTools: (serverId: string) => Promise<{ name: string }[]>,
    serverIds: string[],
  ): Promise<void> {
    this.getToolsFn = getTools;
    this.pollTimer = setInterval(() => void this.pollOnce(serverIds), this.opts.pollIntervalMs);
  }

  private async pollOnce(serverIds: string[]): Promise<void> {
    for (const serverId of serverIds) {
      try {
        // 智能跳过：近期主动推送过的 server 降频
        const lastPush = this.lastPushedAt.get(serverId);
        if (lastPush && Date.now() - lastPush < this.opts.pollBackoffMs) {
          continue;
        }
        if (!this.getToolsFn) continue;
        const tools = await this.getToolsFn(serverId);
        const sig = computeSignature(tools);
        const prev = this.snapshots.get(serverId);
        this.snapshots.set(serverId, sig);
        if (prev !== undefined && prev !== sig) {
          this.opts.onChange(serverId);
        }
      } catch (err) {
        this.opts.logger?.warn('上游工具轮询失败', { serverId, error: String(err) });
      }
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
```

**重要修正**：Step 1 测试的语义是「连续两次 saveSnapshot 后 detectChanges 比对两次的差异」。上述 `detectChanges` 实现需调整以匹配测试。改用「保存基准 + 比对当前」双 Map 模式：

```typescript
// 修正：用 baseline（基准）与 current（最新）两个签名
private readonly baseline = new Map<string, string>();

saveSnapshot(serverId: string, tools: { name: string }[]): void {
  // 每次调用更新 current；首次同时设为 baseline
  const sig = computeSignature(tools);
  if (!this.baseline.has(serverId)) {
    this.baseline.set(serverId, sig);
  }
  this.snapshots.set(serverId, sig);
}

detectChanges(serverId: string): void {
  const base = this.baseline.get(serverId);
  const cur = this.snapshots.get(serverId);
  if (base !== undefined && cur !== undefined && base !== cur) {
    this.baseline.set(serverId, cur); // 推进基准，避免重复触发
    this.opts.onChange(serverId);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/upstream-change-detector.unit.test.ts`
Expected: PASS

- [ ] **Step 5: 写轮询路径测试（用 vi.useFakeTimers）**

追加到测试文件：

```typescript
import { beforeEach, afterEach } from 'vitest';

describe('轮询兜底', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('轮询发现工具变化时触发 onChange', async () => {
    const onChange = vi.fn();
    const detector = new UpstreamChangeDetector({
      onChange,
      pollIntervalMs: 60_000,
      pollBackoffMs: 300_000,
    });
    // 模拟工具源：首次返回 [a]，60s 后返回 [a,b]
    let tools = [{ name: 'a' }];
    const getTools = vi.fn(async () => tools);
    await detector.startPolling(getTools, ['s1']);
    // 首次轮询已建立 baseline
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).not.toHaveBeenCalled(); // 首次无变化
    tools = [{ name: 'a' }, { name: 'b' }];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenCalledWith('s1');
    detector.stop();
  });

  it('曾主动推送的 server 在 pollBackoffMs 内被跳过', async () => {
    const onChange = vi.fn();
    const detector = new UpstreamChangeDetector({
      onChange,
      pollIntervalMs: 60_000,
      pollBackoffMs: 300_000,
    });
    detector.saveSnapshot('s1', [{ name: 'a' }]);
    detector.onUpstreamNotification('s1'); // 标记曾推送
    const getTools = vi.fn(async () => [{ name: 'a' }, { name: 'b' }]);
    await detector.startPolling(getTools, ['s1']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getTools).not.toHaveBeenCalledWith('s1'); // 跳过
    detector.stop();
  });

  it('轮询 listTools 抛错时不影响其他 server', async () => {
    const onChange = vi.fn();
    const detector = new UpstreamChangeDetector({
      onChange,
      pollIntervalMs: 60_000,
      pollBackoffMs: 300_000,
    });
    const getTools = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('disconnected');
      return [{ name: 'a' }];
    });
    await detector.startPolling(getTools, ['bad', 'good']);
    await vi.advanceTimersByTimeAsync(60_000);
    // good 仍被处理（不抛），bad 不崩
    expect(getTools).toHaveBeenCalledWith('good');
    detector.stop();
  });
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/upstream-change-detector.unit.test.ts`
Expected: PASS（3 + 新增 3 = 6 用例全绿）

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/upstream-change-detector.ts backend/src/services/upstream-change-detector.unit.test.ts
git commit -m "feat(p5): UpstreamChangeDetector — 双路检测上游工具变更

签名比对（仅 name 集合）+ listChanged 实时路径 + 60s 轮询兜底。
智能跳过：曾主动推送的 server 在 pollBackoffMs 内降频。"
```

---

## Task 2: ServerManager 改造（声明 capabilities + 注册 notification handler + 快照）

让 ServerManager 在连接上游时注册 `notifications/tools/list_changed` handler，并把工具列表接入 Detector。

**Files:**

- Modify: `backend/src/services/server_manager.ts:96-114`（Client capabilities）, `:231-274`（discoverServerTools）
- Modify: `backend/src/services/server_manager.unit.test.ts`（新增 handler 注册断言）
- Test: 同上

**Interfaces:**

- Consumes: `UpstreamChangeDetector` from Task 1
- Produces: `ServerManager` 构造新增可选参数 `onChangeDetector?`；`discoverServerTools` 成功后调 `detector.saveSnapshot`；连接成功后调 `client.setNotificationHandler('notifications/tools/list_changed', ...)`

- [ ] **Step 1: 写「连接后注册 notification handler」的失败测试**

追加到 `backend/src/services/server_manager.unit.test.ts`：

```typescript
describe('listChanged notification handler（P5）', () => {
  it('连接成功后注册 notifications/tools/list_changed handler', async () => {
    const detector = { saveSnapshot: vi.fn(), onUpstreamNotification: vi.fn() };
    const manager = new ServerManager([], { changeDetector: detector as any });
    // mockClient 已在 beforeEach 配好（connect/listTools 返回成功）
    await manager.initialize();
    expect(mockClient.setNotificationHandler).toHaveBeenCalledWith(
      'notifications/tools/list_changed',
      expect.any(Function),
    );
  });

  it('listChanged 回调触发 detector.onUpstreamNotification', async () => {
    const detector = { saveSnapshot: vi.fn(), onUpstreamNotification: vi.fn() };
    const manager = new ServerManager([], { changeDetector: detector as any });
    await manager.initialize();
    // 取出注册的 handler 并调用
    const handler = mockClient.setNotificationHandler.mock.calls.find(
      (c) => c[0] === 'notifications/tools/list_changed',
    )?.[1];
    await handler?.({ method: 'notifications/tools/list_changed' });
    expect(detector.onUpstreamNotification).toHaveBeenCalled();
  });

  it('discoverServerTools 成功后调 detector.saveSnapshot', async () => {
    const detector = { saveSnapshot: vi.fn(), onUpstreamNotification: vi.fn() };
    mockClient.listTools.mockResolvedValue({ tools: [{ name: 't1' }, { name: 't2' }] });
    const manager = new ServerManager(
      [{ id: 's1', type: 'stdio', command: 'echo', args: [], enabled: true } as any],
      { changeDetector: detector as any },
    );
    await manager.initialize();
    expect(detector.saveSnapshot).toHaveBeenCalledWith('s1', [{ name: 't1' }, { name: 't2' }]);
  });
});
```

注：`new ServerManager([], {...})` 的第二个参数（options）是本 task 新增；现有测试用 `new ServerManager(configs)` 不带 options，保持兼容（options 可选）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter backend vitest run src/services/server_manager.unit.test.ts -t "listChanged"`
Expected: FAIL（ServerManager 不接受 options，或 setNotificationHandler 未被调用）

- [ ] **Step 3: 实现 ServerManager 改造**

在 `server_manager.ts`：

(a) 构造函数新增 options 参数：

```typescript
export interface ServerManagerOptions {
  changeDetector?: {
    saveSnapshot: (serverId: string, tools: { name: string }[]) => void;
    onUpstreamNotification: (serverId: string) => void;
  };
}

export class ServerManager {
  constructor(
    private readonly serverConfigs: ServerConfig[] = [],
    private readonly options: ServerManagerOptions = {},
  ) {}
```

(b) `initializeServer`（约第 96-114 行）创建 Client 后，在 `connectServer` 成功分支注册 handler。找到 `connectServer` 成功后调 `discoverServerTools` 的位置，在其之前加：

```typescript
// P5: 注册上游 listChanged 通知 handler
if (this.options.changeDetector) {
  serverConnection.client.setNotificationHandler('notifications/tools/list_changed', () => {
    this.options.changeDetector!.onUpstreamNotification(serverId);
  });
}
```

(c) `discoverServerTools`（约第 231-274 行）成功赋值 `serverConnection.tools = tools` 后，加快照：

```typescript
// P5: 保存工具集快照供 Detector 比对
this.options.changeDetector?.saveSnapshot(
  serverId,
  tools.map((t) => ({ name: t.name })),
);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/server_manager.unit.test.ts`
Expected: PASS（含新增 3 个 P5 用例 + 现有用例不回归）

- [ ] **Step 5: 确认现有测试无回归**

Run: `pnpm --filter backend vitest run src/services/server_manager.unit.test.ts`
Expected: 全部 PASS（options 可选，旧测试不带 options 不受影响）

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/server_manager.ts backend/src/services/server_manager.unit.test.ts
git commit -m "feat(p5): ServerManager 注册上游 listChanged handler + 工具快照

连接成功后 setNotificationHandler(notifications/tools/list_changed)，
回调触发 Detector.onUpstreamNotification。discoverServerTools 后
saveSnapshot 供轮询比对。构造新增可选 changeDetector 参数。"
```

---

## Task 3: UpstreamChangeFanout（serverId → group fan-out + 防抖）

订阅 Detector 的变更事件，把 serverId 变更 fan-out 到所有含该 server 的 group。

**Files:**

- Create: `backend/src/services/upstream-change-fanout.ts`
- Test: `backend/src/services/upstream-change-fanout.unit.test.ts`

**Interfaces:**

- Produces: `class UpstreamChangeFanout`，方法：
  - `handleServerChange(serverId: string): void` — Detector onChange 调用入口（含防抖）
  - `flush(): Promise<void>` — 等待防抖队列排空（test 用）
  - 构造参数：`{ getGroupsForServer: (serverId: string) => { groupId: string }[]; refreshGroupTools: (groupId: string, serverId: string) => Promise<void>; publishToolListChanged: (groupId: string) => void; debounceMs: number; logger?: Logger }`
- Consumes: Detector 的 onChange 回调指向 `fanout.handleServerChange`

- [ ] **Step 1: 写「serverId → group 映射 + publish」失败测试**

```typescript
// backend/src/services/upstream-change-fanout.unit.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { UpstreamChangeFanout } from './upstream-change-fanout.js';

describe('UpstreamChangeFanout', () => {
  it('serverId 变更 fan-out 到所有含该 server 的 group', async () => {
    const getGroupsForServer = vi.fn(() => [{ groupId: 'g1' }, { groupId: 'g2' }]);
    const refreshGroupTools = vi.fn().mockResolvedValue(undefined);
    const publishToolListChanged = vi.fn();
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools,
      publishToolListChanged,
      debounceMs: 0,
    });
    await fanout.handleServerChange('s1');
    await fanout.flush();
    expect(refreshGroupTools).toHaveBeenCalledWith('g1', 's1');
    expect(refreshGroupTools).toHaveBeenCalledWith('g2', 's1');
    expect(publishToolListChanged).toHaveBeenCalledWith('g1');
    expect(publishToolListChanged).toHaveBeenCalledWith('g2');
  });

  it('无 group 含该 server 时不 publish', async () => {
    const getGroupsForServer = vi.fn(() => []);
    const publishToolListChanged = vi.fn();
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools: vi.fn().mockResolvedValue(undefined),
      publishToolListChanged,
      debounceMs: 0,
    });
    await fanout.handleServerChange('s1');
    await fanout.flush();
    expect(publishToolListChanged).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter backend vitest run src/services/upstream-change-fanout.unit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 Fanout 基本逻辑**

```typescript
// backend/src/services/upstream-change-fanout.ts
import type { Logger } from '@mcp-core/mcp-hub-share';

export interface UpstreamChangeFanoutOptions {
  getGroupsForServer: (serverId: string) => { groupId: string }[];
  refreshGroupTools: (groupId: string, serverId: string) => Promise<void>;
  publishToolListChanged: (groupId: string) => void;
  debounceMs: number;
  logger?: Logger;
}

export class UpstreamChangeFanout {
  private readonly opts: UpstreamChangeFanoutOptions;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>(); // serverId → timer

  constructor(opts: UpstreamChangeFanoutOptions) {
    this.opts = opts;
  }

  handleServerChange(serverId: string): void {
    const existing = this.pending.get(serverId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.fanout(serverId);
      this.pending.delete(serverId);
    }, this.opts.debounceMs);
    this.pending.set(serverId, timer);
  }

  private async fanout(serverId: string): Promise<void> {
    const groups = this.opts.getGroupsForServer(serverId);
    if (groups.length === 0) return;
    await Promise.all(
      groups.map(async (g) => {
        try {
          await this.opts.refreshGroupTools(g.groupId, serverId);
          this.opts.publishToolListChanged(g.groupId);
        } catch (err) {
          this.opts.logger?.warn('fan-out group 失败', { groupId: g.groupId, error: String(err) });
        }
      }),
    );
  }

  async flush(): Promise<void> {
    // test 用：立即触发所有 pending 并等待完成
    for (const [id, timer] of this.pending) {
      clearTimeout(timer);
      this.pending.delete(id);
      await this.fanout(id);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/upstream-change-fanout.unit.test.ts`
Expected: PASS

- [ ] **Step 5: 写防抖测试**

```typescript
describe('防抖', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounceMs 内多次变更合并为一次 fan-out', async () => {
    const getGroupsForServer = vi.fn(() => [{ groupId: 'g1' }]);
    const refreshGroupTools = vi.fn().mockResolvedValue(undefined);
    const fanout = new UpstreamChangeFanout({
      getGroupsForServer,
      refreshGroupTools,
      publishToolListChanged: vi.fn(),
      debounceMs: 500,
    });
    fanout.handleServerChange('s1');
    fanout.handleServerChange('s1');
    fanout.handleServerChange('s1');
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshGroupTools).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/upstream-change-fanout.unit.test.ts`
Expected: PASS（4 用例全绿）

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/upstream-change-fanout.ts backend/src/services/upstream-change-fanout.unit.test.ts
git commit -m "feat(p5): UpstreamChangeFanout — serverId 变更 fan-out 到 group

含同 server 的所有 group 触发 refreshTools + bus.publish。
debounceMs 内多次变更合并。fan-out 异常隔离（一个 group 失败不影响其他）。"
```

---

## Task 4: 接线 + GroupMcpService.refreshTools + subscriptions e2e

把 Detector/Fanout 接入启动流程，给 GroupMcpService 加 `refreshTools`，写 e2e。

**Files:**

- Modify: `backend/src/api/mcp/group-service.ts`（新增 `refreshTools`）
- Modify: `backend/src/services/mcp_hub_service.ts` 或 `service-registry.ts`（接线 Detector+Fanout）
- Modify: `backend/src/api/mcp/mcp-handler-factory.ts`（暴露 publishToolListChanged 给 Fanout）
- Modify: `backend/src/e2e/test-server.ts`（新增 `dynamic_tool_list` 测试工具）
- Create: `backend/src/e2e/mcp-protocol/subscriptions.test.ts`

**Interfaces:**

- Produces:
  - `GroupMcpService.refreshTools(serverId: string): Promise<void>` — 重新注册该 server 的工具
  - `GroupMcpService` 构造或方法暴露 `getMcpServer()` 已有
- Consumes: Task 1 Detector + Task 2 ServerManager + Task 3 Fanout

- [ ] **Step 1: 写 GroupMcpService.refreshTools 的 unit 测试**

追加到 group-service 对应的 unit test（若无，新建 `backend/src/api/mcp/group-service.unit.test.ts`）：

```typescript
describe('GroupMcpService.refreshTools（P5）', () => {
  it('只重新注册指定 server 的工具，不动其他 server', async () => {
    // 构造一个已初始化的 GroupMcpService，含 s1/s2 两个 server 的工具
    // mock coreServiceManager.getServerTools：s1 返回新工具集 [t1,t3]
    // 调 refreshTools('s1')
    // 断言：s1 的工具被重新注册（mcpServer.registerTool 被调用含 s1_t3）
    // 断言：s2 的工具未被触碰（不重复注册 s2_*）
  });
});
```

（实现细节依 GroupMcpService 现有结构；核心是 refreshTools 读取最新 `getServerTools(serverId)`，注销旧工具名、注册新工具名。）

- [ ] **Step 2: 实现 refreshTools**

在 `group-service.ts` 新增方法：

```typescript
/**
 * P5: 重新注册指定 server 的工具（变更 fan-out 时调用）。
 * 只动该 server 的工具，不触碰其他 server。
 */
async refreshTools(serverId: string): Promise<void> {
  // 1. 取该 server 最新工具列表
  const latestTools = await this.coreServiceManager.getServerTools(serverId);
  // 2. 注销该 server 的旧工具（名称前缀 `${serverId}_`）
  //    （McpServer 注销工具 API：视 SDK 提供，若 GA 版有 removeTool/registerTool 覆盖则用）
  // 3. 重新 registerDynamicTool(latestTools)
  // 4. logger.debug 记录
}
```

> 注意：McpServer 的工具注销 API 需在 Task 0 GA 升级后确认。若 GA 版无细粒度注销，回退为「标记 group 工具集 dirty，下次 listTools 时懒重建」——本步在实现时据 SDK 实际能力定。**若 SDK 不支持运行时注销工具，refreshTools 退化为：更新内部工具缓存 + 不主动注销（依赖 invalidateGroupMcpService 的全量重建兜底，但缩小触发面）。** 在 commit message 记录实际采用的策略。

- [ ] **Step 3: 运行 refreshTools 测试**

Run: `pnpm --filter backend vitest run src/api/mcp/group-service.unit.test.ts -t "refreshTools"`
Expected: PASS

- [ ] **Step 4: 接线 Detector + Fanout 到启动流程**

在 `service-registry.ts`（或 `mcp_hub_service.ts`，依现有接线点）：

```typescript
// 初始化时（ServerManager 创建后）
const detector = new UpstreamChangeDetector({
  onChange: (serverId) => fanout.handleServerChange(serverId),
  pollIntervalMs: systemConfig.subscriptions?.pollIntervalMs ?? 60_000,
  pollBackoffMs: systemConfig.subscriptions?.pollBackoffMs ?? 300_000,
  logger,
});
const fanout = new UpstreamChangeFanout({
  getGroupsForServer: (serverId) => /* 从 groupHandlers 配置查含该 server 的 group */,
  refreshGroupTools: (groupId, serverId) => groupServiceMap.get(groupId)?.refreshTools(serverId),
  publishToolListChanged: (groupId) => groupHandlerMap.get(groupId)?.bus?.publish({ kind: 'tools_list_changed' }),
  debounceMs: systemConfig.subscriptions?.fanoutDebounceMs ?? 500,
  logger,
});
// ServerManager 用 { changeDetector: detector }
// 启动轮询：detector.startPolling((id) => serverManager.listTools(id), connectedServerIds)
```

> `getGroupsForServer` / `publishToolListChanged` 需要访问 group 配置 + handler 缓存。这两个数据源在 `mcp-handler-factory.ts`（groupHandlers Map）。需把这两个回调注入或暴露 getter。**接线细节依现有依赖注入结构，本步实现时确认 groupHandlers 的访问方式。**

- [ ] **Step 5: 扩展 test-server：dynamic_tool_list 工具**

在 `backend/src/e2e/test-server.ts` 新增一个可运行时增删工具的上游测试 server（或 mock），用于触发 listChanged。

- [ ] **Step 6: 写 subscriptions e2e**

```typescript
// backend/src/e2e/mcp-protocol/subscriptions.test.ts
import { describe, expect, it } from 'vitest';
import { createMcpTestClient } from './mcp-test-config.js';

describe('subscriptions/listen（P5 e2e）', () => {
  it('上游工具变更时客户端收到 notifications/tools/list_changed', async () => {
    const client = await createMcpTestClient('default');
    // 开 listen stream
    const subscription = await client.listen({ toolsListChanged: true });
    expect(subscription.honoredFilter.toolsListChanged).toBe(true);

    let received = false;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      received = true;
    });

    // 触发上游工具变更（通过 test-server 的 dynamic_tool_list 接口注入新工具）
    await triggerUpstreamToolChange(/* test-server 控制端点 */);

    // 等待通知（带超时）
    await waitFor(() => expect(received).toBe(true), { timeout: 5000 });
  });
});
```

- [ ] **Step 7: 运行 e2e**

Run: `pnpm --filter backend test:e2e`（或对应 api-e2e project）
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(p5): subscriptions/listen 接线 + e2e

GroupMcpService.refreshTools 按需重注册工具。Detector+Fanout 接入启动
流程。test-server 加 dynamic_tool_list。e2e 验证客户端经 listen stream
收到上游 tools_list_changed。

M2 里程碑：subscriptions 主线可交付。"
```

---

## Task 5: MrtrRelayService（mint/verify/resume 纯逻辑）

MRTR 中转核心，纯逻辑 TDD。用 SDK `createRequestStateCodec` mint Hub 级 requestState。

**Files:**

- Create: `backend/src/services/mrtr-relay-service.ts`
- Test: `backend/src/services/mrtr-relay-service.unit.test.ts`

**Interfaces:**

- Consumes: `createRequestStateCodec` from `@modelcontextprotocol/server`
- Produces: `class MrtrRelayService`，方法：
  - `get verify(): (state: string, ctx: unknown) => Promise<HubState>` — 注入 `ServerOptions.requestState.verify`（注意：SDK 签名是 `(state, ctx) => Promise<T>`，verify 是 async 且需 ctx 参数）
  - `relay(serverId: string, toolName: string, upstreamResult: { inputRequests?: unknown; requestState?: string }, step: number): Promise<{ resultType: 'input_required'; inputRequests?: unknown; requestState: string }>` — 上游 input_required → mint Hub state
  - `resume(currentState: HubState | undefined): { isResume: boolean; serverId?: string; toolName?: string; upstreamRequestState?: string; step?: number }` — 读回 Hub state 还原上下文
  - 构造参数：`{ key: Uint8Array; ttlSeconds: number }`
- `HubState` 类型：`{ serverId: string; toolName: string; upstreamRequestState?: string; step: number; exp: number }`

> **已核实（beta.5 类型定义 `index.d.mts:373-391`）**：`RequestStateCodec` 签名为：
>
> - `mint(payload: T, ctx?: ServerContext): Promise<string>` — Promise，正确 await
> - `verify(state: string, ctx: ServerContext): Promise<T>` — **Promise 且 ctx 必填**
>
> 注意 `verify` 是 `Promise<T>` 且第二个参数 `ctx` 必填。注入 `ServerOptions.requestState.verify` 时直接传 `codec.verify`（SDK 会传入 ctx）。测试中手动调 verify 时需传 mock ctx（`relay.verify(state, {} as any)`）。

- [ ] **Step 1: 写 relay + resume round-trip 失败测试**

```typescript
// backend/src/services/mrtr-relay-service.unit.test.ts
import { describe, expect, it } from 'vitest';
import { MrtrRelayService } from './mrtr-relay-service.js';

function makeKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}
const MOCK_CTX = {} as any; // verify 第二参数 ctx（生产由 SDK 传入）

describe('MrtrRelayService', () => {
  describe('relay + resume round-trip', () => {
    it('relay mint 的 state 可被 resume 还原', async () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const result = await relay.relay(
        's1',
        'tool_a',
        {
          inputRequests: { confirm: { type: 'elicitation', message: 'sure?' } },
          requestState: 'upstream-opaque-state',
        },
        1,
      );
      expect(result.resultType).toBe('input_required');
      expect(result.requestState).toBeTypeOf('string');
      expect(result.inputRequests).toBeDefined();

      // verify 还原（async，需 await + ctx）
      const hubState = await relay.verify(result.requestState!, MOCK_CTX);
      expect(hubState.serverId).toBe('s1');
      expect(hubState.toolName).toBe('tool_a');
      expect(hubState.upstreamRequestState).toBe('upstream-opaque-state');
      expect(hubState.step).toBe(1);

      // resume 语义
      const r = relay.resume(hubState);
      expect(r.isResume).toBe(true);
      expect(r.serverId).toBe('s1');
      expect(r.upstreamRequestState).toBe('upstream-opaque-state');
    });

    it('resume(undefined) 表示初次调用（非重试）', () => {
      const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
      const r = relay.resume(undefined);
      expect(r.isResume).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter backend vitest run src/services/mrtr-relay-service.unit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 MrtrRelayService**

```typescript
// backend/src/services/mrtr-relay-service.ts
import { createRequestStateCodec, inputRequired } from '@modelcontextprotocol/server';

export interface HubState {
  serverId: string;
  toolName: string;
  upstreamRequestState?: string;
  step: number;
  exp: number;
}

export interface MrtrRelayServiceOptions {
  key: Uint8Array;
  ttlSeconds: number;
}

export interface RelayInput {
  inputRequests?: unknown;
  requestState?: string; // 上游的原始 state
}

export interface ResumeContext {
  isResume: boolean;
  serverId?: string;
  toolName?: string;
  upstreamRequestState?: string;
  step?: number;
}

export class MrtrRelayService {
  private readonly codec;

  constructor(opts: MrtrRelayServiceOptions) {
    this.codec = createRequestStateCodec<HubState>({
      key: opts.key,
      ttlSeconds: opts.ttlSeconds,
    });
  }

  /** 注入 ServerOptions.requestState.verify（async，SDK 传入 ctx）*/
  get verify(): (state: string, ctx: unknown) => Promise<HubState> {
    return this.codec.verify;
  }

  /** 上游返回 input_required → mint Hub state 返回给客户端 */
  async relay(
    serverId: string,
    toolName: string,
    upstream: RelayInput,
    step: number,
  ): Promise<{ resultType: 'input_required'; inputRequests?: unknown; requestState: string }> {
    const payload: HubState = {
      serverId,
      toolName,
      upstreamRequestState: upstream.requestState,
      step,
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const requestState = await this.codec.mint(payload);
    return {
      resultType: 'input_required',
      inputRequests: upstream.inputRequests,
      requestState,
    };
  }

  /** 读回已 verify 的 Hub state，还原上游上下文 */
  resume(currentState: HubState | undefined): ResumeContext {
    if (!currentState) {
      return { isResume: false };
    }
    return {
      isResume: true,
      serverId: currentState.serverId,
      toolName: currentState.toolName,
      upstreamRequestState: currentState.upstreamRequestState,
      step: currentState.step,
    };
  }
}
```

> 注意：`codec.mint(payload)` 的签名在 GA 版可能是 `mint(payload, ctx?)` 或同步返回。Step 3 实现时据 Task 0 升级后的 GA 版实际签名调整（`await` 兼容 Promise/同步返回值）。`inputRequired` import 暂留备用（本 task 用对象字面量构造 result，Task 7 接入 handler 时可能改用 `inputRequired(...)` builder）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/mrtr-relay-service.unit.test.ts`
Expected: PASS

- [ ] **Step 5: 写安全测试（篡改/过期拒绝）**

注意：`verify` 是 async，用 `await expect(...).rejects.toThrow()` 而非同步 `expect(() => ...).toThrow()`。

```typescript
describe('安全性', () => {
  it('篡改的 state 被 verify 拒绝（抛错）', async () => {
    const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
    const result = await relay.relay('s1', 't', {}, 1);
    const tampered = result.requestState!.slice(0, -4) + 'AAAA';
    await expect(relay.verify(tampered, MOCK_CTX)).rejects.toThrow();
  });

  it('过期 state 被 verify 拒绝', async () => {
    const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 1 });
    const result = await relay.relay('s1', 't', {}, 1);
    await new Promise((r) => setTimeout(r, 1200));
    await expect(relay.verify(result.requestState!, MOCK_CTX)).rejects.toThrow();
  });

  it('不同 key mint 的 state 在本实例 verify 失败', async () => {
    const k1 = makeKey();
    const k2 = makeKey();
    const r1 = new MrtrRelayService({ key: k1, ttlSeconds: 600 });
    const r2 = new MrtrRelayService({ key: k2, ttlSeconds: 600 });
    const result = await r1.relay('s1', 't', {}, 1);
    await expect(r2.verify(result.requestState!, MOCK_CTX)).rejects.toThrow();
  });
});

describe('step 审计字段（非 Hub 层安全防御）', () => {
  // step 是可观测审计字段（日志/追踪区分轮次），Hub 无状态无法独立做 step 单调性校验。
  // 真正防重放/防乱序由 codec TTL + HMAC 绑定负责（见上方「安全性」describe）。
  it('relay 多轮 step 递增', async () => {
    const relay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
    const r1 = await relay.relay('s1', 't', { requestState: 'up1' }, 1);
    const s1 = await relay.verify(r1.requestState!, MOCK_CTX);
    expect(s1.step).toBe(1);
    const r2 = await relay.relay('s1', 't', { requestState: 'up2' }, 2);
    const s2 = await relay.verify(r2.requestState!, MOCK_CTX);
    expect(s2.step).toBe(2);
  });
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/mrtr-relay-service.unit.test.ts`
Expected: PASS（round-trip 2 + 安全 3 + step 1 = 6 用例全绿）

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/mrtr-relay-service.ts backend/src/services/mrtr-relay-service.unit.test.ts
git commit -m "feat(p5): MrtrRelayService — Hub 级 requestState mint/verify

用 createRequestStateCodec（HMAC-SHA256）mint HubState 作为 opaque 句柄，
内部映射 serverId/toolName/upstreamRequestState/step/exp。verify 注入
ServerOptions.requestState.verify。含篡改/过期/key 隔离/step 审计字段测试。"
```

---

## Task 6: executeToolCallWithContext + ServerManager 透传

扩展 core 接口 + adapter + server_manager，支持把重试上下文（inputResponses + requestState）透传给上游 callTool。

**Files:**

- Modify: `packages/core/src/services/mcp/service-manager.ts:81-127`（接口加方法）
- Modify: `backend/src/services/backend-core-service-adapter.ts:46-66`（实现）
- Modify: `backend/src/services/server_manager.ts`（新增 `executeToolOnServerWithContext`）
- Modify: `backend/src/services/backend-core-service-adapter.unit.test.ts`
- Modify: `backend/src/services/server_manager.unit.test.ts`

**Interfaces:**

- Produces:
  - `McpServiceManagerInterface.executeToolCallWithContext(toolName: string, args: unknown, serverId: string, retryContext: { inputResponses?: Record<string, unknown>; requestState?: string }): Promise<ToolResult | InputRequiredResult>`
  - `ServerManager.executeToolOnServerWithContext(serverId: string, toolName: string, args: Record<string, unknown>, retryContext: { inputResponses?: Record<string, unknown>; requestState?: string }): Promise<unknown>`

- [ ] **Step 1: 写 adapter.executeToolCallWithContext 失败测试**

追加到 `backend-core-service-adapter.unit.test.ts`：

```typescript
describe('executeToolCallWithContext（P5）', () => {
  it('把 retryContext 透传给 serverManager.executeToolOnServerWithContext', async () => {
    const mockServerManager = makeMockServerManager();
    mockServerManager.executeToolOnServerWithContext = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
    });
    const adapter = new BackendCoreServiceAdapter(mockServerManager as any);
    const retryContext = { inputResponses: { confirm: true }, requestState: 'hub-state' };
    await adapter.executeToolCallWithContext('tool_a', { x: 1 }, 's1', retryContext);
    expect(mockServerManager.executeToolOnServerWithContext).toHaveBeenCalledWith(
      's1',
      'tool_a',
      { x: 1 },
      retryContext,
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter backend vitest run src/services/backend-core-service-adapter.unit.test.ts -t "executeToolCallWithContext"`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 加接口方法**

在 `packages/core/src/services/mcp/service-manager.ts` 的 `McpServiceManagerInterface`（约第 105 行 `executeToolCall` 后）：

```typescript
executeToolCallWithContext(
  toolName: string,
  args: unknown,
  serverId: string,
  retryContext: { inputResponses?: Record<string, unknown>; requestState?: string },
): Promise<ToolResult | InputRequiredResult>;
```

（`InputRequiredResult` 类型从 `@modelcontextprotocol/server` import 到 core 包，或定义一个结构兼容的本地 type 避免核心包依赖 SDK——优先本地 type：`{ resultType: 'input_required'; inputRequests?: unknown; requestState?: string }`）

- [ ] **Step 4: 实现 adapter 方法**

在 `backend-core-service-adapter.ts`（约第 66 行后）：

```typescript
async executeToolCallWithContext(
  toolName: string,
  args: unknown,
  serverId: string,
  retryContext: { inputResponses?: Record<string, unknown>; requestState?: string },
): Promise<ToolResult | InputRequiredResult> {
  if (!serverId) {
    throw new Error(`executeToolCallWithContext 需要 serverId（工具 ${toolName} 未绑定 server）`);
  }
  const result = await this.serverManager.executeToolOnServerWithContext(
    serverId,
    toolName,
    args as Record<string, unknown>,
    retryContext,
  );
  return result as ToolResult | InputRequiredResult;
}
```

- [ ] **Step 5: 实现 server_manager.executeToolOnServerWithContext**

在 `server_manager.ts`，复用现有 `executeToolOnServer`（约第 276-363 行）结构，新增一个带 retryContext 的版本。关键是上游 `client.callTool` 调用时把 `inputResponses` 和 `requestState` 放进 `_meta`：

```typescript
async executeToolOnServerWithContext(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  retryContext: { inputResponses?: Record<string, unknown>; requestState?: string },
): Promise<unknown> {
  // 复用 executeToolOnServer 的连接查找 + trace context 注入逻辑
  // 区别：callTool 的 _meta 额外带上 retryContext.requestState
  //       且 callTool params 带上 inputResponses（SDK v2 支持）
  const connection = this.servers.get(serverId);
  if (!connection) throw new Error(`Server ${serverId} 未连接`);
  const traceCtx = getTraceContext(); // P6 的 ALS
  const result = await connection.client.callTool(
    { name: toolName, arguments: args },
    undefined,
    {
      _meta: {
        ...(traceCtx?.traceparent ? { traceparent: traceCtx.traceparent } : {}),
        ...(retryContext.requestState ? { requestState: retryContext.requestState } : {}),
      },
      // inputResponses 走 callTool 的 resetStateResponses / 参数（依 SDK v2 实际字段）
    },
  );
  return result;
}
```

> **注意（已由 Task 6 实现核实）**：SDK v2 GA `callTool(params, options?)` 是 2 参数（无 resultSchema）。`inputResponses`/`requestState` 是 **callTool params 的顶层成员**（与 `name`/`arguments`/`_meta` 平级），**不是** `options._meta`。证据：SDK 编译产物 `src-D_zzAWoS.mjs:2975` 的 `retryParamsShape = { inputResponses, requestState }` 被 spread 进 `callToolParamsShape` 顶层，`RETRY_PARAMS_KEYS` 注释明确「顶层 params 成员，仅 client-initiated 请求保留」。trace 三件套（traceparent/tracestate/baggage）仍走 `params._meta`，与重试字段共存。**Task 7/9 实现时遵循此真实签名，不要放 \_meta。**

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter backend vitest run src/services/backend-core-service-adapter.unit.test.ts src/services/server_manager.unit.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/services/mcp/service-manager.ts backend/src/services/backend-core-service-adapter.ts backend/src/services/server_manager.ts backend/src/services/backend-core-service-adapter.unit.test.ts backend/src/services/server_manager.unit.test.ts
git commit -m "feat(p5): executeToolCallWithContext — 重试上下文透传上游

core 接口 + adapter + server_manager 新增带 retryContext 的工具调用路径，
把 inputResponses + requestState 透传给上游 callTool 的 _meta/params。"
```

---

## Task 7: group-service handler 改造（修 InputRequiredResult 吞没 bug + 接入 MRTR）

修复当前 handler 把 `InputRequiredResult`（无 content 字段）错误包成 text 的 bug，接入 MrtrRelayService。

**Files:**

- Modify: `backend/src/api/mcp/group-service.ts:358-430`（registerDynamicTool handler）
- Modify: `backend/src/api/mcp/group-service.ts`（构造注入 MrtrRelayService）
- Test: 新增或追加 integration 测试

**Interfaces:**

- Consumes: `MrtrRelayService` from Task 5, `executeToolCallWithContext` from Task 6
- Produces: handler 正确返回 `CallToolResult | InputRequiredResult`

- [ ] **Step 1: 写「InputRequiredResult 不再被吞」的回归测试**

```typescript
// 在 group-service 集成测试中
describe('MRTR handler（P5）', () => {
  it('上游返回 input_required 时正确透传 InputRequiredResult', async () => {
    // mock coreServiceManager.executeToolCallWithContext 返回
    //   { resultType: 'input_required', inputRequests: {...}, requestState: 'up-state' }
    // 调 handler
    // 断言返回 resultType === 'input_required'，且 requestState 是 Hub mint 的（≠ 'up-state'）
  });

  it('上游正常结果（带 content）仍正常返回', async () => {
    // mock executeToolCallWithContext 返回 { content: [...] }
    // 断言返回 CallToolResult（带 content）
  });

  it('重试请求：ctx.mcpReq.requestState 还原上游上下文并透传', async () => {
    // 模拟 ctx.mcpReq.requestState() 返回已 verify 的 HubState
    // 断言 executeToolCallWithContext 收到 inputResponses + upstreamRequestState
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: 对应测试命令
Expected: FAIL（当前 handler 会把 input_required 包成 text）

- [ ] **Step 3: 改造 handler**

在 `group-service.ts` 的 `registerDynamicTool` handler（约第 375-430 行），替换现有的结果处理逻辑：

```typescript
async (args, extra) => {
  const traceCtx = extractFromMeta(extra?.mcpReq?._meta);
  return runWithTraceContext(traceCtx, async () => {
    // P5: 判断是否重试
    const hubState = extra?.mcpReq?.requestState<HubState>();
    const resume = this.mrtrRelay?.resume(hubState);

    const retryContext = resume.isResume
      ? {
          inputResponses: extra?.mcpReq?.inputResponses,
          requestState: resume.upstreamRequestState,
        }
      : {};

    const result = await this.coreServiceManager.executeToolCallWithContext(
      tool.name,
      args,
      tool.serverId,
      retryContext,
    );

    // P5: 识别上游 InputRequiredResult（修原 bug：不再无脑包 text）
    const isInputRequired =
      result &&
      typeof result === 'object' &&
      (result as { resultType?: string }).resultType === 'input_required';

    if (isInputRequired && this.mrtrRelay) {
      const upstream = result as {
        inputRequests?: unknown;
        requestState?: string;
      };
      const step = resume.isResume ? (resume.step ?? 0) + 1 : 1;
      return this.mrtrRelay.relay(tool.serverId, tool.name, upstream, step);
    }

    // 正常结果：带 content 直传，否则包 text（保留原逻辑给非标准返回）
    if (result && typeof result === 'object' && 'content' in result) {
      return result as unknown as CallToolResult;
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  });
};
```

构造函数注入 `mrtrRelay?: MrtrRelayService`（可选——未启用 MRTR 时为 undefined，handler 走原逻辑）。

- [ ] **Step 4: 运行测试确认通过**

Run: 对应测试命令
Expected: PASS（3 个 MRTR handler 测试 + 现有工具调用测试不回归）

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/mcp/group-service.ts
git commit -m "fix(p5): handler 识别 InputRequiredResult + 接入 MRTR 中转

修复原 bug：上游返回 input_required（无 content）被错误包成 text。
现在识别 resultType==='input_required'，委托 MrtrRelayService mint Hub state。
重试请求经 ctx.mcpReq.requestState 还原上游上下文并透传 inputResponses。"
```

---

## Task 8: mcp-handler-factory 注入 requestState.verify + 接线 MRTR

把 MrtrRelayService 的 verify 注入 createMcpHandler 的 ServerOptions，并在工厂创建时实例化 relay。

**Files:**

- Modify: `backend/src/api/mcp/mcp-handler-factory.ts:113-145`（ServerOptions）
- Test: 追加 unit/integration 测试

**Interfaces:**

- Consumes: `MrtrRelayService` from Task 5
- Produces: handler 构造时注入 `requestState.verify`；GroupMcpService 拿到 relay 实例

- [ ] **Step 1: 写「verify hook 生效」测试**

```typescript
describe('requestState.verify 注入（P5）', () => {
  it('createMcpHandler options 含 requestState.verify', () => {
    // mock createMcpHandler，调 createGroupMcpHandler
    // 断言 createMcpHandler 被调用时 options.requestState.verify 是函数
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: 对应测试
Expected: FAIL（options 无 requestState）

- [ ] **Step 3: 注入 verify**

在 `mcp-handler-factory.ts` 的 `createGroupMcpHandler`，创建 MrtrRelayService 实例（key 从 config/环境变量），传给 GroupMcpService。

> **重要（Task 8 实现核实修正）**：`requestState.verify` 必须注入 **`McpServer` 构造函数的 ServerOptions**，**不是** `createMcpHandler` 的 options。`CreateMcpHandlerOptions` 没有 `requestState` 字段（SDK `createMcpHandler-CLhGwQTn.d.mts:3829` + `dist/index.mjs:1205` 只解构 legacy/onerror/responseMode）。verify 由 `McpServer` 构造函数读取（`dist/mcp-DXXb3Vv3.mjs:725`）。注入错位置 verify 不生效。实际做法：在 `GroupMcpService.buildMcpServer()` 的 `new McpServer(info, {...})` 构造 options 里展开 `...(this.mrtrRelay && { requestState: { verify: this.mrtrRelay.verify } })`。

```typescript
const mrtrRelay = new MrtrRelayService({
  key: resolveMrtrKey(), // 启动时生成或读 config
  ttlSeconds: systemConfig.mrtr?.stateTtlSeconds ?? 600,
});
const groupService = new GroupMcpService(groupId, coreServiceManager, mrtrRelay);
// verify 注入在 GroupMcpService.buildMcpServer() 的 new McpServer 构造里（见上方说明）
```

- [ ] **Step 4: 运行测试确认通过**

Run: 对应测试
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/mcp/mcp-handler-factory.ts
git commit -m "feat(p5): 注入 requestState.verify 到 createMcpHandler

GroupMcpService 构造注入 MrtrRelayService；handler options 加
requestState.verify 做 Hub state 验签。"
```

---

## Task 9: MRTR e2e

真实 MCP client 验证 MRTR 全链路。

**Files:**

- Modify: `backend/src/e2e/test-server.ts`（新增 `confirm_action` 工具）
- Create: `backend/src/e2e/mcp-protocol/mrtr.test.ts`

- [ ] **Step 1: 扩展 test-server：confirm_action 工具**

新增一个上游工具：首次调用返回 `input_required`（elicit 确认），确认后返回结果。

- [ ] **Step 2: 写 MRTR e2e**

```typescript
// backend/src/e2e/mcp-protocol/mrtr.test.ts
import { describe, expect, it } from 'vitest';
import { createMcpTestClient } from './mcp-test-config.js';

describe('MRTR（P5 e2e）', () => {
  it('上游 input_required → Hub 中转 → 客户端重试 → 最终结果', async () => {
    const client = await createMcpTestClient('default');
    // 首次调用 confirm_action
    const first = await client.callTool({ name: 'upstream_confirm_action', arguments: {} });
    expect((first as { resultType?: string }).resultType).toBe('input_required');
    const hubState = (first as { requestState?: string }).requestState;
    expect(hubState).toBeDefined();

    // 用 inputResponses 重试
    const second = await client.callTool(
      {
        name: 'upstream_confirm_action',
        arguments: {},
        // 重试参数：requestState + inputResponses（依 SDK v2 client.callTool 实际字段）
      },
      undefined,
      {
        /* requestState: hubState, inputResponses: {...} */
      },
    );

    // 断言最终结果
    expect((second as { content?: unknown }).content).toBeDefined();
  });
});
```

> **注意**：SDK v2 `client.callTool` 如何在重试时传 `requestState` + `inputResponses` 需在实现时确认字段。可能需要客户端开 `elicitation` capability 并提供 handler。本 e2e 的客户端构造在实现时据 GA 版 API 调整。

- [ ] **Step 3: 运行 e2e**

Run: `pnpm --filter backend test:e2e`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(p5): MRTR e2e — 上游 input_required 全链路中转验证

test-server 加 confirm_action 工具。e2e 验证：首次 input_required →
Hub mint hubState → 客户端重试 → verify → 透传 → 最终结果。

M3 里程碑：MRTR 主线可交付。"
```

---

## Task 10: 配置集成 + adoption-overview 更新 + 收尾

**Files:**

- Modify: `packages/share/src/config/schemas/system.schema.ts`（subscriptions/mrtr 配置）
- Modify: `packages/share/src/config/schemas/group.schema.ts`（组级开关，可选）
- Modify: `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md`（P5 状态）
- Modify: `docs/superpowers/specs/2026-07-30-p5-subscriptions-mrtr-design.md`（实现完成标记）

- [ ] **Step 1: 加配置 schema**

在 `system.schema.ts` 加：

```typescript
subscriptions: {
  type: 'object',
  optional: true,
  properties: {
    enabled: { type: 'boolean', default: true },
    pollIntervalMs: { type: 'number', default: 60_000 },
    pollBackoffMs: { type: 'number', default: 300_000 },
    fanoutDebounceMs: { type: 'number', default: 500 },
  },
},
mrtr: {
  type: 'object',
  optional: true,
  properties: {
    enabled: { type: 'boolean', default: true },
    stateTtlSeconds: { type: 'number', default: 600 },
    stateKey: { type: 'string', optional: true }, // undefined 则启动时随机生成
  },
},
```

同步 `packages/share/src/config/types/index.ts` 类型推导。

- [ ] **Step 2: 写配置 schema 测试**

```typescript
// 对应 schema unit test
it('subscriptions/mrtr 配置有默认值', () => {
  const parsed = systemSchema.parse({});
  expect(parsed.subscriptions?.enabled).toBe(true);
  expect(parsed.mrtr?.stateTtlSeconds).toBe(600);
});
```

Run: `pnpm --filter @mcp-core/mcp-hub-share test`
Expected: PASS

- [ ] **Step 3: 全量回归**

Run: `pnpm typecheck && pnpm test`
Expected: PASS（全绿）

- [ ] **Step 4: 更新 adoption-overview 文档**

把 P5 行从「推迟」改为「实现完成」，补 merge commit、详细 spec 链接、DoD 核实。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(p5): 配置集成 + adoption-overview 更新（M4 收尾）

subscriptions/mrtr 配置 schema + 默认值。P5 状态改为实现完成。

P5 全量回归通过：typecheck + unit + e2e 全绿。
subscriptions/listen + MRTR 中转两条主线交付。"
```

---

## Self-Review 结论

**1. Spec 覆盖：**

- SDK 升级 → Task 0 ✓
- subscriptions 实时路径（listChanged）→ Task 1+2 ✓
- subscriptions 轮询兜底 → Task 1 ✓
- subscriptions fan-out + 防抖 → Task 3 ✓
- subscriptions 接线 + e2e → Task 4 ✓
- MRTR mint/verify/resume → Task 5 ✓
- MRTR 重试上下文透传 → Task 6 ✓
- MRTR handler 改造（修 bug）→ Task 7 ✓
- MRTR verify 注入 → Task 8 ✓
- MRTR e2e → Task 9 ✓
- 配置 + 文档 → Task 10 ✓

**2. 类型一致性：**

- `HubState` 全文统一（serverId/toolName/upstreamRequestState/step/exp）✓
- `executeToolCallWithContext` 签名全文一致 ✓
- `refreshTools(serverId)` 一致 ✓
- `MrtrRelayService.relay/resume/verify` 一致 ✓

**3. 已标注的实现时待确认点（非 placeholder，是依赖 GA 版实际 API 的核实点）：**

- Task 4 Step 2：McpServer 运行时工具注销 API（若 GA 无则退化策略已写明）
- Task 5 Step 3：✅ **已核实**（beta.5 `index.d.mts:373-391`）：`mint(payload, ctx?): Promise<string>`，`verify(state, ctx): Promise<T>`（async + ctx 必填）。计划已据此修正签名与测试。
- Task 6 Step 5：`client.callTool` 传 inputResponses/requestState 的字段名（GA 升级后核实）
- Task 9 Step 2：client 重试传参方式 + elicitation capability（GA 升级后核实）

Task 5 的核心签名已从已安装的类型定义核实清楚。剩余 Task 6/9 的 `callTool` 字段名需 GA 升级后从 `@modelcontextprotocol/client` 类型定义核实（升级后 grep `callTool` 签名即可），已在对应 task 注明核实要求，不阻塞计划执行。
