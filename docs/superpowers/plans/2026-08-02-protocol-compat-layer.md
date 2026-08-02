# 协议兼容层（P7）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `@mcp-core/mcp-knot-protocol` 包，让 Hub 默认同时服务 modern/legacy 客户端、显式探测并兼容 legacy upstream、统一错误 envelope，业务层零 era 感知。

**Architecture:** 单包内部模块化（model / inbound / outbound / mrtr / errors）。入站用 SDK v2 内置 `legacy:'stateless'`（HTTP）/`'serve'`（stdio）开关替代当前 `'reject'`，经 `InboundProtocolAdapter` 归一化为 `NormalizedRequest`。出站用 `OutboundProtocolAdapter` 探测 upstream era 并把 `NormalizedCall` 翻译为对应 wire 形态。错误经 `UnifiedErrorNormalizer` 归一。配置默认全开、可经环境变量/cli flag 收窄。

**Tech Stack:** TypeScript 5.8 ESM、pnpm 10.6.4 workspace、`@modelcontextprotocol/server@2.0.0` + `/stdio`、`@modelcontextprotocol/client@2.0.0`、zod 4、vitest、Hono。

## Global Constraints

- SDK 版本精确锁 `@modelcontextprotocol/server@2.0.0`、`@modelcontextprotocol/client@2.0.0`、`@modelcontextprotocol/node@2.0.0`（与 `packages/core/package.json:46` 现有声明一致）。
- 新包 `name` 必须以 `@mcp-core/` 开头，否则进不了根 `package.json` 的 `--filter "@mcp-core/*"` build/check/clean。
- ESM：所有包内 import 必须带 `.js` 后缀（NodeNext 要求），即便源文件是 `.ts`。
- `legacy` 选项取值在两端不同：HTTP `createMcpHandler` 用 `'stateless'|'reject'`；stdio `serveStdio` 用 `'serve'|'reject'`。`'reject'` 是共有的 modern-only 语义。
- `requestState` 不是 `ServerOptions` 字段，是 `InputRequiredResult.requestState?: string`，用 `createRequestStateCodec({key, ttlSeconds}).mint()` 生成。
- 配置 schema 单一来源是 `packages/share/src/config/`；core 层只读写校验，不定义 schema。
- 支持矩阵只覆盖 modern(`2026-07-28`) + legacy(`2025-11-25`)；更老的若 SDK 能转就转，不专门适配。
- 默认全开：`inbound.enabled=true / legacyMode='shim'`、`outbound.enabled=true / modernOnly=false / mrtrLegacyDegradation='shim'`、`errors.unified=true`。

---

## File Structure

**新建包 `packages/protocol/`：**

| 文件 | 职责 |
|------|------|
| `packages/protocol/package.json` | 包定义，name `@mcp-core/mcp-knot-protocol`，依赖 server/share |
| `packages/protocol/tsconfig.json` | 独立 ts 配置（照抄 share 模式，无 extends） |
| `packages/protocol/vitest.config.ts` | vitest project 配置（照抄 share） |
| `packages/protocol/src/index.ts` | 对外门面，re-export 公共 API |
| `packages/protocol/src/config.ts` | `CompatibilityOptions` 类型 + zod schema + 默认值 |
| `packages/protocol/src/model/era.ts` | `Era`、`UpstreamEra`、`InboundEra` 类型 |
| `packages/protocol/src/model/normalized.ts` | `NormalizedRequest`/`NormalizedCall`/`NormalizedResult`/`NormalizedMrtrState` |
| `packages/protocol/src/inbound/adapter.ts` | `InboundProtocolAdapter`：据 opts 决定 legacy 模式并归一化入站请求 |
| `packages/protocol/src/inbound/legacy-fallback.ts` | 包装 SDK `legacyStatelessFallback`，返回 LegacyHttpHandler |
| `packages/protocol/src/outbound/adapter.ts` | `OutboundProtocolAdapter`：探测 upstream era 并分发 translator |
| `packages/protocol/src/outbound/modern-translator.ts` | modern upstream：_meta envelope + inputResponses 顶层字段 |
| `packages/protocol/src/outbound/legacy-translator.ts` | legacy upstream：initialize 语义 + MRTR shim 降级 |
| `packages/protocol/src/mrtr/relay.ts` | MRTR 跨 era 中转（从 group-service.ts 迁入的 mint/verify 逻辑） |
| `packages/protocol/src/errors/normalizer.ts` | `UnifiedErrorNormalizer`：三来源错误归一 |

**新建测试 fixture：**

| 文件 | 职责 |
|------|------|
| `backend/src/e2e/fixtures/legacy-upstream-server.ts` | 确定性 legacy（2025-11-25）stdio upstream，照抄 mrtr-upstream-server.ts 骨架 |
| `backend/src/e2e/fixtures/modern-upstream-server.ts` | 确定性 modern stdio upstream（从 mrtr-upstream-server.ts 抽出无 MRTR 的纯 modern 版） |

**修改现有文件：**

| 文件 | 改动 |
|------|------|
| `package.json` | `build:production` 串行链插入 `build:protocol`（share 之后、core 之前） |
| `vitest.config.ts` | projects 数组加入 `./packages/protocol/vitest.config.ts` |
| `packages/share/src/config/schemas/*.ts` | 新增 `CompatibilityConfigSchema`（system config 的一部分） |
| `packages/share/src/config/types/*.ts` | 新增 `CompatibilityConfig` 类型 |
| `packages/core/src/config/config-manager.ts` | 加载/读取 `compatibility` 配置段 |
| `backend/src/api/mcp/mcp-handler-factory.ts:282-289` | `legacy:'reject'` → 经 `InboundProtocolAdapter` 按 opts 决定 |
| `backend/src/config/*` 或入口 | 读环境变量构造 `CompatibilityOptions` |
| `packages/cli/src/server/cli-mcp-server.ts:163-168` | 同上，stdio 走 `'serve'\|'reject'` |
| `packages/cli/src/cli.ts:17-29,29-...` | 加 `--no-legacy-inbound` / `--modern-only-upstream` flag |
| `backend/src/services/server_manager.ts:99-128` | 显式探测记录 `upstreamEra`，挂到 server 元数据 |
| `backend/src/services/server_manager.ts:425-518` | era 假设迁出，`inputResponses`/`requestState` 经 outbound translator |
| `backend/src/api/mcp/group-service.ts:668-720` | MRTR mint/verify 迁入 protocol 包并调用 |
| `backend/src/api/mcp/group-router.ts:84-122,152-167` | 错误经 `UnifiedErrorNormalizer` |
| `backend/src/e2e/mcp-protocol/protocol-compliance.test.ts` | 填上用例 3 `it.skip`，新增 legacy 客户端入站用例 |

---

## Task 1: 新建 protocol 包脚手架

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/vitest.config.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/README.md`
- Modify: `package.json`（build:production 串行链）
- Modify: `vitest.config.ts`（projects 数组）

**Interfaces:**
- Consumes: `@modelcontextprotocol/server@2.0.0`、`@mcp-core/mcp-knot-share`（workspace:*）
- Produces: 一个可 build、可被 `@mcp-core/*` filter 命中、空 index 但能 import 的包

- [ ] **Step 1: 写 package.json（照抄 packages/share/package.json 结构）**

`packages/protocol/package.json`:
```json
{
  "name": "@mcp-core/mcp-knot-protocol",
  "version": "0.0.1",
  "description": "MCP Knot 协议兼容层：双向 era 翻译、归一化模型、统一错误",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md"],
  "publishConfig": { "access": "public" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc",
    "check": "oxlint --fix src/ && oxfmt src/",
    "test": "vitest --run",
    "test:watch": "vitest",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@mcp-core/mcp-knot-share": "workspace:*",
    "@modelcontextprotocol/server": "2.0.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^20.11.17",
    "typescript": "^5.8.3"
  },
  "packageManager": "pnpm@10.6.4"
}
```

- [ ] **Step 2: 写 tsconfig.json（照抄 packages/share/tsconfig.json，types 加 vitest）**

`packages/protocol/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "coverage", "**/*.test.ts", "**/*.spec.ts"]
}
```

- [ ] **Step 3: 写 vitest.config.ts（照抄 packages/share/vitest.config.ts）**

先读 `packages/share/vitest.config.ts` 复制其结构，把 project name 改为 `protocol`。如果 share 用的是引用 `vitest.shared.ts` 的模式，照搬。

`packages/protocol/vitest.config.ts`:
```ts
import { defineProject } from '../share/vitest.config.js'; // 视 share 实际导出而定
// 若 share 无导出，则直接内联 vitest.shared.ts 的配置
```

> 实施注：执行此 step 前先 `cat packages/share/vitest.config.ts` 确认它的实际写法（是 defineProject 还是 merge 共享 config），照抄。若 share 没有可复用导出，就把 `vitest.shared.ts` 的 `globals/environment/pool` 配置直接内联进本文件，并把 `test.name` 设为 `'protocol'`。

- [ ] **Step 4: 写空 index.ts + README**

`packages/protocol/src/index.ts`:
```ts
// 协议兼容层公共 API（后续 task 填充）
export {};
```

`packages/protocol/README.md`:
```markdown
# @mcp-core/mcp-knot-protocol

MCP Knot 协议兼容层。详见 `docs/superpowers/specs/2026-08-02-protocol-compat-layer-design.md`。
```

- [ ] **Step 5: 改根 package.json 的 build:production 串行链**

读 `package.json`，找到 `build:production` 脚本（当前是 `...share... && ...core... && ...api... && ...cli... && ...fe`），在 `build:share` 之后、`build:core` 之前插入 `build:protocol`。

同时在根 `package.json` 的 scripts 里加：
```json
"build:protocol": "pnpm --filter @mcp-core/mcp-knot-protocol build"
```

- [ ] **Step 6: 改根 vitest.config.ts 加入新 project**

读 `vitest.config.ts`，在 projects 数组里、share 之后加入：
```ts
'./packages/protocol/vitest.config.ts',
```

- [ ] **Step 7: pnpm install 让 workspace 识别新包**

Run: `pnpm install`
Expected: 新包被链接，无报错。

- [ ] **Step 8: 验证 build + check 命中新包**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol build && pnpm --filter @mcp-core/mcp-knot-protocol check`
Expected: build 产出 `dist/index.js` + `dist/index.d.ts`；check 通过（空 src 也应过 lint）。

- [ ] **Step 9: 验证根命令命中**

Run: `pnpm build`（应包含 protocol）和 `pnpm check`
Expected: 全部包含 protocol，无失败。

- [ ] **Step 10: Commit**

```bash
git add packages/protocol package.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(protocol): 新增 @mcp-core/mcp-knot-protocol 包脚手架"
```

---

## Task 2: CompatibilityOptions 配置模型

**Files:**
- Create: `packages/protocol/src/config.ts`
- Test: `packages/protocol/src/config.test.ts`
- Modify: `packages/protocol/src/index.ts`（导出配置类型）

**Interfaces:**
- Consumes: `zod`
- Produces: `CompatibilityOptions`（类型）、`CompatibilityOptionsSchema`（zod）、`defaultCompatibilityOptions`（默认值常量）

- [ ] **Step 1: 写失败测试**

`packages/protocol/src/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CompatibilityOptionsSchema, defaultCompatibilityOptions } from './config.js';

describe('CompatibilityOptions', () => {
  it('默认全开', () => {
    expect(defaultCompatibilityOptions).toEqual({
      inbound: { enabled: true, legacyMode: 'shim' },
      outbound: { enabled: true, modernOnly: false, mrtrLegacyDegradation: 'shim' },
      errors: { unified: true },
    });
  });

  it('空对象解析为默认值', () => {
    expect(CompatibilityOptionsSchema.parse({})).toEqual(defaultCompatibilityOptions);
  });

  it('legacyMode 只接受 reject | shim', () => {
    expect(() => CompatibilityOptionsSchema.parse({ inbound: { legacyMode: 'bridge' } })).toThrow();
  });

  it('mrtrLegacyDegradation 只接受 shim | reject', () => {
    expect(() => CompatibilityOptionsSchema.parse({ outbound: { mrtrLegacyDegradation: 'force' } })).toThrow();
  });

  it('部分覆盖保留其余默认', () => {
    const r = CompatibilityOptionsSchema.parse({ outbound: { modernOnly: true } });
    expect(r.outbound.modernOnly).toBe(true);
    expect(r.inbound.enabled).toBe(true); // 未覆盖的保留默认
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: FAIL（`./config.js` 不存在）

- [ ] **Step 3: 写实现**

`packages/protocol/src/config.ts`:
```ts
import { z } from 'zod';

export const InboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  legacyMode: z.enum(['reject', 'shim']).default('shim'),
});

export const OutboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  modernOnly: z.boolean().default(false),
  mrtrLegacyDegradation: z.enum(['shim', 'reject']).default('shim'),
});

export const ErrorOptionsSchema = z.object({
  unified: z.boolean().default(true),
});

export const CompatibilityOptionsSchema = z.object({
  inbound: InboundOptionsSchema.default({}),
  outbound: OutboundOptionsSchema.default({}),
  errors: ErrorOptionsSchema.default({}),
});

export type CompatibilityOptions = z.infer<typeof CompatibilityOptionsSchema>;

export const defaultCompatibilityOptions: CompatibilityOptions = CompatibilityOptionsSchema.parse({});
```

- [ ] **Step 4: 更新 index.ts 导出**

`packages/protocol/src/index.ts`:
```ts
export { CompatibilityOptionsSchema, defaultCompatibilityOptions } from './config.js';
export type { CompatibilityOptions } from './config.js';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: PASS

- [ ] **Step 6: typecheck + check**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol build && pnpm --filter @mcp-core/mcp-knot-protocol check`
Expected: 通过

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): CompatibilityOptions 配置模型与默认值"
```

---

## Task 3: 归一化数据模型

**Files:**
- Create: `packages/protocol/src/model/era.ts`
- Create: `packages/protocol/src/model/normalized.ts`
- Test: `packages/protocol/src/model/normalized.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/server`（`JSONRPCRequest`/`InputRequiredResult`/`ProtocolEra` 类型）
- Produces: `Era`、`InboundEra`、`UpstreamEra`、`NormalizedRequest`、`NormalizedCall`、`NormalizedResult`、`NormalizedMrtrState`、`NormalizedError`

- [ ] **Step 1: 写 era.ts**

`packages/protocol/src/model/era.ts`:
```ts
// era 是 Hub 内部的统一抽象，与 SDK 的 ProtocolEra 对齐但独立定义，
// 避免 protocol 包消费者直接依赖 SDK 内部类型。
export type Era = 'modern' | 'legacy';

// 入站探测到的客户端 era
export type InboundEra = Era;

// 出站探测到的 upstream era
export type UpstreamEra = Era;

// 未探测到时的临时态
export type UpstreamEraProbe = UpstreamEra | 'unknown';
```

- [ ] **Step 2: 写失败测试（normalized 形态与构造器）**

`packages/protocol/src/model/normalized.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeInboundRequest, normalizeCall, okResult, inputRequiredResult, errorResult } from './normalized.js';

describe('normalized model', () => {
  it('normalizeInboundRequest 提取 method/params/meta/era', () => {
    const r = normalizeInboundRequest({
      method: 'tools/call',
      params: { name: 'foo', arguments: { x: 1 } },
      meta: { clientInfo: { name: 'c', version: '1' } },
      era: 'modern',
    });
    expect(r.method).toBe('tools/call');
    expect(r.era).toBe('modern');
    expect((r.params as { name: string }).name).toBe('foo');
  });

  it('okResult 包含 content', () => {
    const r = okResult([{ type: 'text', text: 'hi' }]);
    expect(r.kind).toBe('success');
  });

  it('inputRequiredResult 携带 inputRequests', () => {
    const r = inputRequiredResult({ key: {} });
    expect(r.kind).toBe('input_required');
    expect(r.mrtr).toBeDefined();
  });

  it('errorResult 携带归一化错误', () => {
    const r = errorResult({ code: -32603, message: 'boom' });
    expect(r.kind).toBe('error');
    expect(r.error.code).toBe(-32603);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: FAIL

- [ ] **Step 4: 写实现 normalized.ts**

`packages/protocol/src/model/normalized.ts`:
```ts
import type { Era } from './era.js';

// 归一化后的入站请求：业务层只认这个，不感知 era 之外的 wire 差异
export interface NormalizedRequest {
  method: string;
  params: unknown;
  meta: NormalizedMeta;
  era: Era;
}

export interface NormalizedMeta {
  clientInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  traceparent?: string;
  baggage?: string;
}

export interface NormalizedCall {
  toolName: string;
  arguments: unknown;
  mrtr?: NormalizedMrtrState;
}

export interface NormalizedMrtrState {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

export type NormalizedResult =
  | ({ kind: 'success' } & NormalizedSuccess)
  | ({ kind: 'input_required' } & NormalizedInputRequired)
  | ({ kind: 'error' } & NormalizedErrorResult);

export interface NormalizedSuccess {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface NormalizedInputRequired {
  inputRequests: Record<string, unknown>;
  mrtr: NormalizedMrtrState;
}

export interface NormalizedError {
  code: number;
  message: string;
  data?: unknown;
}

export interface NormalizedErrorResult {
  error: NormalizedError;
}

// —— 构造器（方便 translator 组装，业务层只读） ——

export function normalizeInboundRequest(input: {
  method: string;
  params: unknown;
  meta: NormalizedMeta;
  era: Era;
}): NormalizedRequest {
  return { ...input };
}

export function normalizeCall(input: { toolName: string; arguments: unknown; mrtr?: NormalizedMrtrState }): NormalizedCall {
  return { ...input };
}

export function okResult(content: NormalizedSuccess['content'], isError = false): NormalizedResult {
  return { kind: 'success', content, isError };
}

export function inputRequiredResult(
  inputRequests: Record<string, unknown>,
  mrtr: NormalizedMrtrState,
): NormalizedResult {
  return { kind: 'input_required', inputRequests, mrtr };
}

export function errorResult(error: NormalizedError): NormalizedResult {
  return { kind: 'error', error };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: PASS

- [ ] **Step 6: 更新 index.ts 导出模型**

`packages/protocol/src/index.ts` 追加：
```ts
export type { Era, InboundEra, UpstreamEra, UpstreamEraProbe } from './model/era.js';
export type {
  NormalizedRequest, NormalizedMeta, NormalizedCall, NormalizedMrtrState,
  NormalizedResult, NormalizedSuccess, NormalizedInputRequired, NormalizedError, NormalizedErrorResult,
} from './model/normalized.js';
export {
  normalizeInboundRequest, normalizeCall, okResult, inputRequiredResult, errorResult,
} from './model/normalized.js';
```

- [ ] **Step 7: typecheck + check + Commit**

```bash
pnpm --filter @mcp-core/mcp-knot-protocol build && pnpm --filter @mcp-core/mcp-knot-protocol check
git add packages/protocol/src/model packages/protocol/src/index.ts
git commit -m "feat(protocol): 归一化数据模型 NormalizedRequest/Call/Result"
```

---

## Task 4: 统一错误归一化器

**Files:**
- Create: `packages/protocol/src/errors/normalizer.ts`
- Test: `packages/protocol/src/errors/normalizer.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: `NormalizedError`（来自 Task 3）
- Produces: `UnifiedErrorNormalizer`（类）、`normalizeError`（函数）、`toJsonRpcError`（转 JSON-RPC error object）

- [ ] **Step 1: 写失败测试**

`packages/protocol/src/errors/normalizer.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeError, toJsonRpcError } from './normalizer.js';

describe('UnifiedErrorNormalizer', () => {
  it('SDK 风格错误（含 code/message/data）原样归一', () => {
    const e = normalizeError({ code: -32601, message: 'method not found', data: { method: 'foo' } });
    expect(e.code).toBe(-32601);
    expect(e.data).toEqual({ method: 'foo' });
  });

  it('裸 Error 转为 -32603 internal error', () => {
    const e = normalizeError(new Error('boom'));
    expect(e.code).toBe(-32603);
    expect(e.message).toBe('boom');
  });

  it('未知对象兜底 -32603', () => {
    const e = normalizeError('whatever');
    expect(e.code).toBe(-32603);
  });

  it('toJsonRpcError 输出标准 JSON-RPC error object', () => {
    const obj = toJsonRpcError({ code: -32602, message: 'bad params' });
    expect(obj).toEqual({ code: -32602, message: 'bad params' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: FAIL

- [ ] **Step 3: 写实现**

`packages/protocol/src/errors/normalizer.ts`:
```ts
import type { NormalizedError } from '../model/normalized.js';

const INTERNAL_ERROR: NormalizedError = { code: -32603, message: 'Internal error' };

type ErrorInput =
  | NormalizedError
  | Error
  | { code?: number; message?: string; data?: unknown }
  | unknown;

export function normalizeError(input: ErrorInput): NormalizedError {
  // 已是规范形态
  if (typeof input === 'object' && input !== null && 'code' in input && 'message' in input) {
    const code = typeof input.code === 'number' ? input.code : -32603;
    const message = typeof input.message === 'string' ? input.message : INTERNAL_ERROR.message;
    const data = 'data' in input ? input.data : undefined;
    return data !== undefined ? { code, message, data } : { code, message };
  }
  // Error 实例
  if (input instanceof Error) {
    return { code: -32603, message: input.message || INTERNAL_ERROR.message };
  }
  // 兜底
  return { ...INTERNAL_ERROR };
}

export function toJsonRpcError(input: ErrorInput): { code: number; message: string; data?: unknown } {
  const e = normalizeError(input);
  return e.data !== undefined ? { code: e.code, message: e.message, data: e.data } : { code: e.code, message: e.message };
}

export class UnifiedErrorNormalizer {
  normalize(input: ErrorInput): NormalizedError {
    return normalizeError(input);
  }
  toJsonRpc(input: ErrorInput): { code: number; message: string; data?: unknown } {
    return toJsonRpcError(input);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: PASS

- [ ] **Step 5: 更新 index.ts 导出**

追加：
```ts
export { normalizeError, toJsonRpcError, UnifiedErrorNormalizer } from './errors/normalizer.js';
```

- [ ] **Step 6: typecheck + check + Commit**

```bash
pnpm --filter @mcp-core/mcp-knot-protocol build && pnpm --filter @mcp-core/mcp-knot-protocol check
git add packages/protocol/src/errors packages/protocol/src/index.ts
git commit -m "feat(protocol): UnifiedErrorNormalizer 统一错误归一"
```

---

## Task 5: InboundProtocolAdapter（入站归一化）

**Files:**
- Create: `packages/protocol/src/inbound/legacy-fallback.ts`
- Create: `packages/protocol/src/inbound/adapter.ts`
- Test: `packages/protocol/src/inbound/adapter.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/server`（`classifyInboundRequest`、`isLegacyRequest`、`legacyStatelessFallback`、`McpServerFactory`、`LegacyHttpHandler`）；Task 2 `CompatibilityOptions`；Task 3 `NormalizedRequest`
- Produces: `InboundProtocolAdapter`（类）、`resolveInboundLegacyMode`（据 opts 映射到 SDK `legacy` 值的纯函数）

**关键事实**：HTTP `createMcpHandler` 的 `legacy` 取 `'stateless'|'reject'`；stdio `serveStdio` 的 `legacy` 取 `'serve'|'reject'`。adapter 不直接调用这些 SDK 入口，而是提供"据 CompatibilityOptions 算出 SDK 应该传什么 legacy 值"的纯函数 + 把入站请求归一化为 `NormalizedRequest` 的能力。实际的 SDK 入口调用仍在 backend/cli（Task 9、Task 10）。

- [ ] **Step 1: 写失败测试**

`packages/protocol/src/inbound/adapter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { resolveInboundLegacyMode } from './adapter.js';
import { defaultCompatibilityOptions } from '../config.js';

describe('InboundProtocolAdapter', () => {
  it('默认 shim → HTTP "stateless"', () => {
    expect(resolveInboundLegacyMode(defaultCompatibilityOptions, 'http')).toBe('stateless');
  });

  it('默认 shim → stdio "serve"', () => {
    expect(resolveInboundLegacyMode(defaultCompatibilityOptions, 'stdio')).toBe('serve');
  });

  it('enabled=false 或 legacyMode=reject → "reject"', () => {
    expect(resolveInboundLegacyMode({ ...defaultCompatibilityOptions, inbound: { enabled: false, legacyMode: 'shim' } }, 'http')).toBe('reject');
    expect(resolveInboundLegacyMode({ ...defaultCompatibilityOptions, inbound: { enabled: true, legacyMode: 'reject' } }, 'stdio')).toBe('reject');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: FAIL

- [ ] **Step 3: 写 legacy-fallback.ts（薄包装 SDK）**

`packages/protocol/src/inbound/legacy-fallback.ts`:
```ts
import { legacyStatelessFallback, type McpServerFactory, type LegacyHttpHandler } from '@modelcontextprotocol/server';

// 包装 SDK 的 legacyStatelessFallback，未来如需自定义 onerror/日志在此收口
export function createLegacyFallback(factory: McpServerFactory, onError?: (e: Error) => void): LegacyHttpHandler {
  return legacyStatelessFallback(factory, onError);
}

export type { McpServerFactory, LegacyHttpHandler };
```

> 实施注：`McpServerFactory` 和 `LegacyHttpHandler` 的精确类型见 `node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/.../dist/createMcpHandler-CLhGwQTn.d.mts:3808`。如果类型名 import 报错，先 `grep -r "export.*LegacyHttpHandler\|export.*McpServerFactory" node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/.../dist/index.d.mts` 确认是否从主入口导出；若未导出则在本文件内 `import type` 失败，改为从 SDK 内部路径或推断类型（用 `ReturnType<typeof legacyStatelessFallback>` 替代 `LegacyHttpHandler`）。

- [ ] **Step 4: 写 adapter.ts**

`packages/protocol/src/inbound/adapter.ts`:
```ts
import type { CompatibilityOptions } from '../config.js';
import type { NormalizedRequest, NormalizedMeta } from '../model/normalized.js';
import { normalizeInboundRequest } from '../model/normalized.js';
import type { InboundEra } from '../model/era.js';

export type TransportKind = 'http' | 'stdio';

// 据 CompatibilityOptions 算出该传给 SDK 的 legacy 值
// HTTP: 'stateless' | 'reject'；stdio: 'serve' | 'reject'
export function resolveInboundLegacyMode(opts: CompatibilityOptions, kind: TransportKind): 'stateless' | 'serve' | 'reject' {
  if (!opts.inbound.enabled || opts.inbound.legacyMode === 'reject') return 'reject';
  return kind === 'http' ? 'stateless' : 'serve';
}

// 把 SDK 已 classify 的请求归一化为 NormalizedRequest
// 入参 era 由调用方据 SDK classifyInboundRequest 结果判定（modern/legacy）
export function toNormalizedRequest(input: {
  method: string;
  params: unknown;
  meta: NormalizedMeta;
  era: InboundEra;
}): NormalizedRequest {
  return normalizeInboundRequest(input);
}

// adapter 类（封装 opts，便于 backend/cli 持有）
export class InboundProtocolAdapter {
  constructor(private readonly opts: CompatibilityOptions) {}

  resolveLegacyMode(kind: TransportKind): 'stateless' | 'serve' | 'reject' {
    return resolveInboundLegacyMode(this.opts, kind);
  }

  normalize(input: { method: string; params: unknown; meta: NormalizedMeta; era: InboundEra }): NormalizedRequest {
    return toNormalizedRequest(input);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: PASS

- [ ] **Step 6: 更新 index.ts 导出**

追加：
```ts
export { InboundProtocolAdapter, resolveInboundLegacyMode, toNormalizedRequest } from './inbound/adapter.js';
export type { TransportKind } from './inbound/adapter.js';
export { createLegacyFallback } from './inbound/legacy-fallback.js';
```

- [ ] **Step 7: typecheck + check + Commit**

```bash
pnpm --filter @mcp-core/mcp-knot-protocol build && pnpm --filter @mcp-core/mcp-knot-protocol check
git add packages/protocol/src/inbound packages/protocol/src/index.ts
git commit -m "feat(protocol): InboundProtocolAdapter 入站归一化与 legacy 模式解析"
```

---

## Task 6: OutboundProtocolAdapter（出站翻译）

**Files:**
- Create: `packages/protocol/src/outbound/modern-translator.ts`
- Create: `packages/protocol/src/outbound/legacy-translator.ts`
- Create: `packages/protocol/src/outbound/adapter.ts`
- Test: `packages/protocol/src/outbound/adapter.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: Task 3 `NormalizedCall`/`NormalizedResult`；Task 2 `CompatibilityOptions`
- Produces: `OutboundProtocolAdapter`（类）、`translateCallForUpstream`（纯函数：据 era 输出 wire 形态的 callTool 参数）、`translateUpstreamResult`（纯函数：把 upstream 返回归一化为 NormalizedResult）

- [ ] **Step 1: 写失败测试**

`packages/protocol/src/outbound/adapter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { translateCallForUpstream, translateUpstreamResult } from './adapter.js';
import { normalizeCall } from '../model/normalized.js';

describe('OutboundProtocolAdapter', () => {
  const call = normalizeCall({ toolName: 'foo', arguments: { x: 1 } });

  it('modern upstream：inputResponses/requestState 作为顶层字段', () => {
    const wire = translateCallForUpstream(call, 'modern');
    expect(wire.name).toBe('foo');
    expect(wire.arguments).toEqual({ x: 1 });
    // 无 mrtr 时不带 inputResponses/requestState
    expect('inputResponses' in wire).toBe(false);
  });

  it('modern upstream 带 mrtr：顶层 inputResponses + requestState', () => {
    const callMrtr = normalizeCall({
      toolName: 'foo', arguments: { x: 1 },
      mrtr: { requestState: 'rs-token', inputResponses: { k: 'v' } },
    });
    const wire = translateCallForUpstream(callMrtr, 'modern');
    expect(wire.requestState).toBe('rs-token');
    expect(wire.inputResponses).toEqual({ k: 'v' });
  });

  it('legacy upstream：丢弃 _meta envelope 风格字段，保留 name/arguments', () => {
    const wire = translateCallForUpstream(call, 'legacy');
    expect(wire.name).toBe('foo');
    expect('inputResponses' in wire).toBe(false);
  });

  it('upstream 成功结果归一为 success', () => {
    const r = translateUpstreamResult({ content: [{ type: 'text', text: 'ok' }] }, 'modern');
    expect(r.kind).toBe('success');
  });

  it('upstream input_required 归一为 input_required', () => {
    const r = translateUpstreamResult({
      resultType: 'input_required',
      inputRequests: { key: {} },
      requestState: 'rs',
    }, 'modern');
    expect(r.kind).toBe('input_required');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: FAIL

- [ ] **Step 3: 写 modern-translator.ts**

`packages/protocol/src/outbound/modern-translator.ts`:
```ts
import type { NormalizedCall, NormalizedResult } from '../model/normalized.js';
import { okResult, inputRequiredResult } from '../model/normalized.js';

// modern upstream 的 wire callTool 参数：inputResponses/requestState 是顶层成员（非 _meta）
export interface ModernWireCall {
  name: string;
  arguments: unknown;
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

export function translateCallForModern(call: NormalizedCall): ModernWireCall {
  const wire: ModernWireCall = { name: call.toolName, arguments: call.arguments };
  if (call.mrtr?.requestState) wire.requestState = call.mrtr.requestState;
  if (call.mrtr?.inputResponses) wire.inputResponses = call.mrtr.inputResponses;
  return wire;
}

// modern upstream 返回值归一化。raw 是 SDK callTool 的返回（ReadResult-like）
export function translateModernResult(raw: {
  content?: unknown;
  isError?: boolean;
  resultType?: string;
  inputRequests?: Record<string, unknown>;
  requestState?: string;
}): NormalizedResult {
  if (raw.resultType === 'input_required') {
    return inputRequiredResult(raw.inputRequests ?? {}, { requestState: raw.requestState });
  }
  return okResult((raw.content as NormalizedResult extends { kind: 'success' } ? never : Array<{ type: string; text?: string }>) ?? [], raw.isError ?? false);
}
```

> 实施注：`okResult` 的 content 类型参数在实现时若 ts 报错，把传入的 `raw.content` 用 `as Array<{ type: string; text?: string; data?: string; mimeType?: string }>` 断言即可。重点是测试覆盖行为。

- [ ] **Step 4: 写 legacy-translator.ts**

`packages/protocol/src/outbound/legacy-translator.ts`:
```ts
import type { NormalizedCall, NormalizedResult } from '../model/normalized.js';
import { okResult, errorResult } from '../model/normalized.js';
import type { NormalizedError } from '../model/normalized.js';

// legacy upstream 的 wire callTool 参数：只有 name/arguments
// _meta envelope / inputResponses / requestState 在 legacy era 不存在
export interface LegacyWireCall {
  name: string;
  arguments: unknown;
}

export function translateCallForLegacy(call: NormalizedCall): LegacyWireCall {
  return { name: call.toolName, arguments: call.arguments };
}

// legacy upstream 不支持 input_required（协议层无此字段）
// 若业务层确实需要 MRTR 而 upstream 是 legacy，应在 adapter 层据 mrtrLegacyDegradation 决策
// 这里只把普通成功结果归一；input_required 场景由 adapter 调用方处理（返回 errorResult）
export function translateLegacyResult(raw: { content?: unknown; isError?: boolean }): NormalizedResult {
  return okResult((raw.content as Array<{ type: string; text?: string }>) ?? [], raw.isError ?? false);
}

// 当 legacy upstream 被要求做 MRTR 但不支持时，构造归一化错误
export function legacyMrtrUnsupportedError(): NormalizedResult {
  const err: NormalizedError = {
    code: -32601,
    message: 'upstream is legacy-era and does not support input_required (MRTR)',
  };
  return errorResult(err);
}
```

- [ ] **Step 5: 写 adapter.ts（统一分发）**

`packages/protocol/src/outbound/adapter.ts`:
```ts
import type { CompatibilityOptions } from '../config.js';
import type { NormalizedCall, NormalizedResult } from '../model/normalized.js';
import type { UpstreamEra } from '../model/era.js';
import { translateCallForModern, translateModernResult, type ModernWireCall } from './modern-translator.js';
import { translateCallForLegacy, translateLegacyResult, legacyMrtrUnsupportedError, type LegacyWireCall } from './legacy-translator.js';

// 统一出口：据 era 输出 wire 形态
export type WireCall = ModernWireCall | LegacyWireCall;

export function translateCallForUpstream(call: NormalizedCall, era: UpstreamEra): WireCall {
  return era === 'modern' ? translateCallForModern(call) : translateCallForLegacy(call);
}

export function translateUpstreamResult(raw: unknown, era: UpstreamEra): NormalizedResult {
  if (era === 'modern') {
    return translateModernResult(raw as Parameters<typeof translateModernResult>[0]);
  }
  return translateLegacyResult(raw as Parameters<typeof translateLegacyResult>[0]);
}

// adapter 类：封装 opts + era，决策 MRTR 在 legacy upstream 的降级
export class OutboundProtocolAdapter {
  constructor(private readonly opts: CompatibilityOptions) {}

  // 若 modernOnly=true，强制视 upstream 为 modern（只允许连 modern）
  effectiveEra(probed: UpstreamEra): UpstreamEra {
    if (this.opts.outbound.modernOnly) return 'modern';
    return probed;
  }

  // legacy upstream 触发 MRTR 时的处理
  handleLegacyMrtr(): NormalizedResult {
    return this.opts.outbound.mrtrLegacyDegradation === 'reject' ? legacyMrtrUnsupportedError() : legacyMrtrUnsupportedError();
    // 注：shim 与 reject 当前都返回错误（legacy 协议层无 input_required）。
    // 真正的 shim 翻译（走 sampling/elicitation）作为 P2，MVP 阶段统一为不支持错误。
  }

  translateCall(call: NormalizedCall, era: UpstreamEra): WireCall {
    return translateCallForUpstream(call, this.effectiveEra(era));
  }

  translateResult(raw: unknown, era: UpstreamEra): NormalizedResult {
    return translateUpstreamResult(raw, this.effectiveEra(era));
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: PASS

- [ ] **Step 7: 更新 index.ts 导出**

追加：
```ts
export { OutboundProtocolAdapter, translateCallForUpstream, translateUpstreamResult } from './outbound/adapter.js';
export type { WireCall, ModernWireCall, LegacyWireCall } from './outbound/adapter.js';
export { translateCallForModern, translateModernResult } from './outbound/modern-translator.js';
export { translateCallForLegacy, translateLegacyResult, legacyMrtrUnsupportedError } from './outbound/legacy-translator.js';
```

- [ ] **Step 8: typecheck + check + Commit**

```bash
pnpm --filter @mcp-core/mcp-knot-protocol build && pnpm --filter @mcp-core/mcp-knot-protocol check
git add packages/protocol/src/outbound packages/protocol/src/index.ts
git commit -m "feat(protocol): OutboundProtocolAdapter 出站 era 翻译"
```

---

## Task 7: MRTR 跨 era 中转（迁移现有逻辑）

**Files:**
- Create: `packages/protocol/src/mrtr/relay.ts`
- Test: `packages/protocol/src/mrtr/relay.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: Task 3 `NormalizedMrtrState`；SDK `createRequestStateCodec`（来自 `@modelcontextprotocol/server`）
- Produces: `HubMrtrCodec`（类，封装 requestState mint/verify）、`HubState` 类型

**背景**：现有 MRTR mint/verify 逻辑在 `backend/src/api/mcp/group-service.ts:668-720`，用 HMAC 保护 `HubState = { serverId, toolName, upstreamRequestState, step }`。本 task 把它迁入 protocol 包，使 backend 与 cli 共用，并为跨 era 降级留扩展点。

- [ ] **Step 1: 读现有实现作为迁移依据**

读 `backend/src/api/mcp/group-service.ts:668-720` 和相关 import，记录：
- `HubState` 的精确字段
- 现有用什么 codec（`createRequestStateCodec`？自建 HMAC？key/ttl 从哪来）
- mint/verify 的签名

```bash
sed -n '660,730p' backend/src/api/mcp/group-service.ts
grep -n "requestState\|HubState\|createRequestStateCodec\|mint\|verify" backend/src/api/mcp/group-service.ts backend/src/services/server_manager.ts
```

- [ ] **Step 2: 写失败测试**

`packages/protocol/src/mrtr/relay.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HubMrtrCodec } from './relay.js';

describe('HubMrtrCodec', () => {
  it('mint 出的 requestState 能被 verify 还原', () => {
    const codec = new HubMrtrCodec({ key: 'test-key-32-bytes-long-enough!!!!', ttlSeconds: 300 });
    const state = { serverId: 's1', toolName: 'foo', upstreamRequestState: 'up-rs', step: 1 };
    const token = codec.mint(state);
    expect(typeof token).toBe('string');
    const restored = codec.verify(token);
    expect(restored).toEqual(state);
  });

  it('篡改的 token verify 失败返回 undefined', () => {
    const codec = new HubMrtrCodec({ key: 'test-key-32-bytes-long-enough!!!!', ttlSeconds: 300 });
    const token = codec.mint({ serverId: 's1', toolName: 'foo', upstreamRequestState: '', step: 0 });
    expect(codec.verify(token + 'tampered')).toBeUndefined();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: FAIL

- [ ] **Step 4: 写实现（迁移 + 复用 SDK codec）**

`packages/protocol/src/mrtr/relay.ts`:
```ts
import { createRequestStateCodec } from '@modelcontextprotocol/server';

// Hub 级 MRTR 状态：把 upstream 的 opaque requestState 包在 Hub 自己的句柄里
export interface HubState {
  serverId: string;
  toolName: string;
  upstreamRequestState: string;
  step: number;
}

export interface HubMrtrCodecOptions {
  key: string;
  ttlSeconds: number;
}

export class HubMrtrCodec {
  private readonly codec: ReturnType<typeof createRequestStateCodec<HubState>>;

  constructor(opts: HubMrtrCodecOptions) {
    this.codec = createRequestStateCodec<HubState>({ key: opts.key, ttlSeconds: opts.ttlSeconds });
  }

  mint(state: HubState): string {
    return this.codec.mint(state);
  }

  verify(token: string | undefined): HubState | undefined {
    if (!token) return undefined;
    try {
      return this.codec.verify(token) as HubState | undefined;
    } catch {
      return undefined;
    }
  }
}
```

> 实施注：执行此 step 前必须先 `grep -n "createRequestStateCodec" node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/.../dist/*.d.mts` 确认它的精确签名和返回类型（是否带 `.mint`/`.verify` 方法、泛型参数名）。若 SDK 的 codec 形态与上面假设不符，照 SDK 实际 API 调整本文件，但保持 `HubMrtrCodec.mint/verify` 对外签名不变（这是 backend 迁移依赖的契约）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: PASS

- [ ] **Step 6: 更新 index.ts 导出**

追加：
```ts
export { HubMrtrCodec } from './mrtr/relay.js';
export type { HubState, HubMrtrCodecOptions } from './mrtr/relay.js';
```

- [ ] **Step 7: typecheck + check + Commit**

```bash
pnpm --filter @mcp-core/mcp-knot-protocol build && pnpm --filter @mcp-core/mcp-knot-protocol check
git add packages/protocol/src/mrtr packages/protocol/src/index.ts
git commit -m "feat(protocol): HubMrtrCodec 迁移 MRTR requestState mint/verify"
```

---

## Task 8: 配置加载（share schema + core ConfigManager + 环境变量）

**Files:**
- Modify: `packages/share/src/config/schemas/*.ts`（新增 CompatibilityConfigSchema）
- Modify: `packages/share/src/config/types/*.ts`（新增 CompatibilityConfig 类型）
- Modify: `packages/share/src/config/index.ts`（导出）
- Modify: `packages/core/src/config/config-manager.ts`（读取 compatibility 段）
- Test: `packages/core/src/config/config-manager.test.ts`（若已有则追加用例）

**Interfaces:**
- Consumes: Task 2 `CompatibilityOptionsSchema`
- Produces: `SystemConfig.compatibility: CompatibilityConfig`，经 ConfigManager 加载

> 实施注：本 task 涉及 share/core 两个既有包。先读 `packages/share/src/config/schemas/` 和 `types/` 目录确认现有命名和组织（比如 system schema 放在哪个文件），照同样模式新增。compatibility 段作为 `SystemConfig` 的可选子段，默认值由 schema `.default({})` + Task 2 的嵌套 default 保证。

- [ ] **Step 1: 探查现有 share config 结构**

```bash
ls packages/share/src/config/schemas/ packages/share/src/config/types/
grep -rn "SystemConfigSchema\|SystemConfig" packages/share/src/config/
```

- [ ] **Step 2: 在 share 加 schema + 类型**

在 `packages/share/src/config/schemas/` 下找 system schema 所在文件，追加 `compatibility` 字段，引用 protocol 包的 schema：

```ts
// 在 SystemConfigSchema 的 z.object 内追加：
compatibility: CompatibilityOptionsSchema.optional().default({}),
```

但这会让 share 反向依赖 protocol 包（share → protocol），而 protocol 依赖 share（protocol → share），形成**循环依赖**。

**解决方案**：不在 share 里直接引用 protocol 的 schema，而是把 `CompatibilityOptionsSchema` 的定义**复制**到 share（或下沉到 share）。考虑到 schema 是配置的单一来源，正确做法是**把 `CompatibilityOptionsSchema` 定义在 share**，protocol 包从 share import。

修订：
- 把 Task 2 的 `config.ts` 改为从 `@mcp-core/mcp-knot-share/config` import schema，protocol 包不再自己定义 schema。
- 在 `packages/share/src/config/schemas/compatibility.ts` 定义 schema。

- [ ] **Step 3: 写 share 侧 schema**

`packages/share/src/config/schemas/compatibility.ts`:
```ts
import { z } from 'zod';

export const InboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  legacyMode: z.enum(['reject', 'shim']).default('shim'),
});

export const OutboundOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  modernOnly: z.boolean().default(false),
  mrtrLegacyDegradation: z.enum(['shim', 'reject']).default('shim'),
});

export const ErrorOptionsSchema = z.object({
  unified: z.boolean().default(true),
});

export const CompatibilityOptionsSchema = z.object({
  inbound: InboundOptionsSchema.default({}),
  outbound: OutboundOptionsSchema.default({}),
  errors: ErrorOptionsSchema.default({}),
});

export type CompatibilityOptions = z.infer<typeof CompatibilityOptionsSchema>;
```

- [ ] **Step 4: 把 protocol 的 config.ts 改为 re-export**

`packages/protocol/src/config.ts`:
```ts
// schema 单一来源在 share；protocol 包 re-export 以便消费者从本包引入
export { CompatibilityOptionsSchema } from '@mcp-core/mcp-knot-share/config';
export type { CompatibilityOptions } from '@mcp-core/mcp-knot-share/config';

import { CompatibilityOptionsSchema } from '@mcp-core/mcp-knot-share/config';
export const defaultCompatibilityOptions: CompatibilityOptions = CompatibilityOptionsSchema.parse({});
```

- [ ] **Step 5: 把 compatibility 接入 SystemConfigSchema**

在 system schema 所在文件追加字段（先 grep 定位精确位置）：
```ts
compatibility: CompatibilityOptionsSchema.default({}),
```
并 import。

- [ ] **Step 6: 更新 share config 导出**

`packages/share/src/config/index.ts` 追加：
```ts
export * from './schemas/compatibility.js';
```

- [ ] **Step 7: 重新跑 protocol 包测试确认仍通过**

Run: `pnpm --filter @mcp-core/mcp-knot-protocol test`
Expected: Task 2 的测试仍 PASS（因为 schema 行为不变，只是定义位置变了）

- [ ] **Step 8: 在 core ConfigManager 暴露 compatibility 读取**

`packages/core/src/config/config-manager.ts` 的 `AllConfig.system` 类型现已含 `compatibility`（经 schema 推断）。加便捷 getter：
```ts
getCompatibility(): CompatibilityOptions {
  return this.allConfig.system.compatibility ?? CompatibilityOptionsSchema.parse({});
}
```

- [ ] **Step 9: typecheck + test**

Run: `pnpm --filter @mcp-core/mcp-knot-core build && pnpm --filter @mcp-core/mcp-knot-core test`
Expected: 通过

- [ ] **Step 10: Commit**

```bash
git add packages/share/src/config packages/protocol/src/config.ts packages/core/src/config
git commit -m "feat(config): CompatibilityOptions 接入 SystemConfig，schema 单一来源在 share"
```

---

## Task 9: backend 接入入站兼容 + 出站 era 探测

**Files:**
- Modify: `backend/src/api/mcp/mcp-handler-factory.ts:282-289`（legacy 开关改用 adapter）
- Modify: `backend/src/services/server_manager.ts:99-128`（探测记录 upstreamEra）
- Modify: `backend/src/services/server_manager.ts:425-518`（callTool 经 outbound adapter）
- Modify: `backend/src/api/mcp/group-service.ts:651-754`（MRTR 经 HubMrtrCodec）
- Modify: `backend/src/api/mcp/group-router.ts:84-122,152-167`（错误经 normalizer）
- Modify: `backend/package.json`（加 `@mcp-core/mcp-knot-protocol` 依赖）
- Test: `backend/src/api/mcp/mcp-handler-factory.test.ts`（追加，若不存在则新建）

**Interfaces:**
- Consumes: Task 5 `InboundProtocolAdapter`、Task 6 `OutboundProtocolAdapter`、Task 7 `HubMrtrCodec`、Task 4 `UnifiedErrorNormalizer`；Task 8 ConfigManager 的 `getCompatibility()`
- Produces: backend 入口经 adapter 驱动，legacy 客户端可连

- [ ] **Step 1: backend 加 protocol 包依赖**

读 `backend/package.json`，在 dependencies 加：
```json
"@mcp-core/mcp-knot-protocol": "workspace:*"
```
然后 `pnpm install`。

- [ ] **Step 2: 改 mcp-handler-factory.ts**

读 `backend/src/api/mcp/mcp-handler-factory.ts:260-289`。当前：
```ts
return createMcpHandler(factory, { legacy: 'reject' });
```
改为读 CompatibilityOptions 并经 adapter 解析：
```ts
import { InboundProtocolAdapter } from '@mcp-core/mcp-knot-protocol';
// ...获取 compatibility opts（从 ConfigManager 或环境变量，见 Step 3）
const inboundAdapter = new InboundProtocolAdapter(opts);
const legacyMode = inboundAdapter.resolveLegacyMode('http');
return createMcpHandler(factory, { legacy: legacyMode });
```

- [ ] **Step 3: 在 backend 入口构造 CompatibilityOptions**

读 `backend/src/config/` 或 app 入口（`backend/src/app.ts`），找到 ConfigManager 实例化的地方。加：
```ts
const compatibility = configManager.getCompatibility();
// 透传到 mcp-handler-factory 的闭包或依赖注入
```
若 backend 暂无 ConfigManager 单例可注入，从环境变量读（fallback）：
```ts
function readCompatFromEnv() {
  return CompatibilityOptionsSchema.parse({
    inbound: { enabled: process.env.MCP_INBOUND_LEGACY !== 'reject', legacyMode: process.env.MCP_INBOUND_LEGACY_MODE ?? 'shim' },
    outbound: { modernOnly: process.env.MCP_OUTBOUND_MODERN_ONLY === 'true' },
  });
}
```

- [ ] **Step 4: 改 server_manager.ts 出站 era 探测**

读 `backend/src/services/server_manager.ts:99-128, 141-258`。在 client 连接后，显式探测 era 并记录到 server 元数据：
```ts
import { OutboundProtocolAdapter } from '@mcp-core/mcp-knot-protocol';
// connectServer 内，client.connect 成功后：
const probedEra: UpstreamEra = await detectUpstreamEra(client); // 见下
serverMeta.era = probedEra;
```
`detectUpstreamEra` 实现：用 client 的 `getNegotiatedProtocolVersion()`（若 SDK 暴露）判断，2026-07-28 → modern，否则 legacy。先 grep 确认 SDK client 是否暴露此方法：
```bash
grep -n "getNegotiatedProtocolVersion\|getProtocolEra" node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/.../dist/*.d.ts
```

- [ ] **Step 5: 改 callTool 经 outbound adapter**

读 `server_manager.ts:425-518`。把 `inputResponses`/`requestState` 的直接处理改为经 `OutboundProtocolAdapter.translateCall` / `translateResult`：
```ts
const wire = outboundAdapter.translateCall(normalizedCall, serverMeta.era);
const raw = await client.callTool(wire, { allowInputRequired: true });
const result = outboundAdapter.translateResult(raw, serverMeta.era);
```

- [ ] **Step 6: 改 group-service.ts MRTR 经 HubMrtrCodec**

读 `group-service.ts:668-720`。把现有 mint/verify 替换为 `HubMrtrCodec`：
```ts
import { HubMrtrCodec } from '@mcp-core/mcp-knot-protocol';
const codec = new HubMrtrCodec({ key: process.env.MRTR_KEY ?? '...', ttlSeconds: 300 });
// mint：const token = codec.mint({ serverId, toolName, upstreamRequestState, step });
// verify：const state = codec.verify(inputRequestState);
```
保留现有错误码语义（verify 失败 -32602）。

- [ ] **Step 7: 改 group-router.ts 错误经 normalizer**

读 `group-router.ts:84-122, 152-167`。把自建 JSON-RPC error 包替换为 `UnifiedErrorNormalizer.toJsonRpc()`：
```ts
import { UnifiedErrorNormalizer } from '@mcp-core/mcp-knot-protocol';
const normalizer = new UnifiedErrorNormalizer();
const errBody = normalizer.toJsonRpc(originalError);
```

- [ ] **Step 8: 写测试验证 legacy 客户端可连（集成层）**

`backend/src/api/mcp/mcp-handler-factory.test.ts` 追加：
```ts
it('compatibility 默认全开时 legacyMode=http stateless', () => {
  const adapter = new InboundProtocolAdapter(defaultCompatibilityOptions);
  expect(adapter.resolveLegacyMode('http')).toBe('stateless');
});
```

- [ ] **Step 9: 运行 backend 全量测试**

Run: `pnpm --filter @mcp-core/mcp-knot-api test`
Expected: 现有测试不回归

- [ ] **Step 10: Commit**

```bash
git add backend/src backend/package.json pnpm-lock.yaml
git commit -m "feat(backend): 接入协议兼容层——入站 legacy shim + 出站 era 探测 + MRTR codec + 统一错误"
```

---

## Task 10: cli 接入入站兼容 + 启动 flag

**Files:**
- Modify: `packages/cli/src/server/cli-mcp-server.ts:163-168`
- Modify: `packages/cli/src/cli.ts:17-29`（CliOptions 加字段）
- Modify: `packages/cli/src/cli.ts:29-...`（parseArgs 加分支）
- Modify: `packages/cli/package.json`（加 protocol 依赖）
- Test: `packages/cli/src/cli.test.ts`（追加 flag 解析用例）

**Interfaces:**
- Consumes: Task 5 `InboundProtocolAdapter`；Task 8 `CompatibilityOptionsSchema`

- [ ] **Step 1: cli 加 protocol 包依赖**

读 `packages/cli/package.json`，dependencies 加 `@mcp-core/mcp-knot-protocol: workspace:*`，`pnpm install`。

- [ ] **Step 2: 改 cli-mcp-server.ts**

读 `packages/cli/src/server/cli-mcp-server.ts:163-168`。当前 `serveStdio(factory, { legacy: 'reject' })`，改为：
```ts
import { InboundProtocolAdapter } from '@mcp-core/mcp-knot-protocol';
const adapter = new InboundProtocolAdapter(opts);
serveStdio(factory, { legacy: adapter.resolveLegacyMode('stdio') });
```

- [ ] **Step 3: CliOptions 加字段**

读 `packages/cli/src/cli.ts:17-29`，加：
```ts
interface CliOptions {
  // ...现有字段
  noLegacyInbound?: boolean;
  modernOnlyUpstream?: boolean;
}
```

- [ ] **Step 4: parseArgs 加分支**

读 `packages/cli/src/cli.ts` 的 `parseArgs` 函数，在 switch 内加：
```ts
case '--no-legacy-inbound': opts.noLegacyInbound = true; break;
case '--modern-only-upstream': opts.modernOnlyUpstream = true; break;
```

- [ ] **Step 5: 把 flag 映射到 CompatibilityOptions**

在 cli 启动 server 前：
```ts
const compat = CompatibilityOptionsSchema.parse({
  inbound: { enabled: !cliOpts.noLegacyInbound },
  outbound: { modernOnly: cliOpts.modernOnlyUpstream ?? false },
});
```
传给 cli-mcp-server。

- [ ] **Step 6: 写 flag 解析测试**

`packages/cli/src/cli.test.ts` 追加：
```ts
it('解析 --no-legacy-inbound', () => {
  const opts = parseArgs(['--no-legacy-inbound']);
  expect(opts.noLegacyInbound).toBe(true);
});
it('解析 --modern-only-upstream', () => {
  const opts = parseArgs(['--modern-only-upstream']);
  expect(opts.modernOnlyUpstream).toBe(true);
});
```

- [ ] **Step 7: 运行 cli 测试**

Run: `pnpm --filter @mcp-core/mcp-knot-cli test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): 接入协议兼容层 + --no-legacy-inbound/--modern-only-upstream flag"
```

---

## Task 11: legacy/modern upstream e2e fixture

**Files:**
- Create: `backend/src/e2e/fixtures/legacy-upstream-server.ts`
- Create: `backend/src/e2e/fixtures/modern-upstream-server.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/server/stdio`（`serveStdio`）
- Produces: 两个确定性 era 的 stdio upstream 进程脚本，供 e2e 用 `process.execPath --import tsx` 拉起

**模板依据**：`backend/src/e2e/fixtures/mrtr-upstream-server.ts`（完整可读的 stdio upstream 范式）

- [ ] **Step 1: 读模板**

完整读 `backend/src/e2e/fixtures/mrtr-upstream-server.ts`，理解：
- `serveStdio(factory, { legacy: 'reject' })` 入口
- `server.registerTool` 注册方式
- MRTR 的 `inputRequired`/`acceptedContent` 用法

- [ ] **Step 2: 写 modern-upstream-server.ts（无 MRTR 的纯 modern）**

`backend/src/e2e/fixtures/modern-upstream-server.ts`:
```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'modern-upstream-fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    { inputSchema: z.object({ message: z.string() }), description: 'echo back' },
    async (args) => ({ content: [{ type: 'text', text: args.message }] }),
  );
  return server;
}

serveStdio(() => buildServer(), { legacy: 'reject' }); // 强制 modern
```

- [ ] **Step 3: 写 legacy-upstream-server.ts（确定性 legacy）**

`backend/src/e2e/fixtures/legacy-upstream-server.ts`:
```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'legacy-upstream-fixture', version: '1.0.0' });
  server.registerTool(
    'echo',
    { inputSchema: z.object({ message: z.string() }), description: 'echo back' },
    async (args) => ({ content: [{ type: 'text', text: args.message }] }),
  );
  return server;
}

// legacy: 'serve' 让 SDK 走 initialize 握手（2025-11-25 era）
serveStdio(() => buildServer(), { legacy: 'serve' });
```

> 实施注：执行前先 `grep -n "legacy" node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/.../dist/stdio.d.mts` 确认 `serveStdio` 的 `legacy` 取值确实是 `'serve' | 'reject'`，且 `'serve'` 会服务 legacy 客户端。若 SDK 行为与预期不符，改用裸 `McpServer.connect(new StdioServerTransport())`（参考 `dynamic-upstream-server.ts`，据探索其默认被当 2025-era）。

- [ ] **Step 4: 手动冒烟验证两个脚本能起**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node --import tsx backend/src/e2e/fixtures/legacy-upstream-server.ts
```
Expected: 返回合法 JSON-RPC initialize 响应（legacy upstream 应答 initialize）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/e2e/fixtures/legacy-upstream-server.ts backend/src/e2e/fixtures/modern-upstream-server.ts
git commit -m "test(fixture): 新增确定性 legacy/modern upstream e2e fixture"
```

---

## Task 12: 跨 era e2e（填上 protocol-compliance.test.ts 用例 3 + 新增入站 legacy 用例）

**Files:**
- Modify: `backend/src/e2e/mcp-protocol/protocol-compliance.test.ts`（去 skip，填实现 + 加用例）

**Interfaces:**
- Consumes: Task 11 的 fixture；`backend/src/e2e/mcp-protocol/mrtr.test.ts:62-138` 的子进程拉起骨架

- [ ] **Step 1: 读现有 skip 用例 + mrtr.test.ts 骨架**

```bash
sed -n '180,200p' backend/src/e2e/mcp-protocol/protocol-compliance.test.ts
sed -n '60,140p' backend/src/e2e/mcp-protocol/mrtr.test.ts
```

- [ ] **Step 2: 填上用例 3（出站 era 桥接）**

把 `it.skip(...)` 改为 `it(...)`，照 mrtr.test.ts 的子进程拉起模式：
```ts
it('Hub 能连 legacy upstream 并调用其工具', async () => {
  // 1. mkdtempSync 建临时 config 目录
  // 2. 写 group.json + mcp_server.json（command: process.execPath, args: ['--import','tsx', LEGACY_UPSTREAM_SCRIPT]）
  // 3. process.env.CONFIG_PATH = tempDir; resetConfigInstances()
  // 4. new TestServer(DEDICATED_PORT); await server.start(); await sleep(3000)
  // 5. createMcpTestClient 连 Hub 的 /<group>/mcp
  // 6. client.callTool({ name: 'echo', arguments: { message: 'hi' } })
  // 7. 断言返回 content[0].text === 'hi'
  // afterAll: 还原 CONFIG_PATH，重建 hub service
});
```

- [ ] **Step 3: 新增入站 legacy 客户端用例**

```ts
it('legacy 客户端能连默认全开的 Hub', async () => {
  // 用裸 initialize 握手（protocolVersion 2025-11-25）连 Hub
  // 断言不再被 reject（返回合法 initialize 响应，非 4xx）
  // 断言能 tools/list、tools/call
});
```

- [ ] **Step 4: 运行 e2e**

Run: `pnpm test:e2e`
Expected: 新用例 PASS，现有用例不回归

- [ ] **Step 5: 若失败，按 systematic-debugging 排查**

常见坑：端口冲突（确认用 DEDICATED_PORT 避开 3000/3060/3061）、CONFIG_PATH 未还原污染其他用例、tsx import 路径。

- [ ] **Step 6: Commit**

```bash
git add backend/src/e2e/mcp-protocol/protocol-compliance.test.ts
git commit -m "test(e2e): 填上跨 era 桥接用例 + legacy 客户端入站用例"
```

---

## Task 13: 接入官方 conformance TCK

**Files:**
- Create: `scripts/conformance/run.sh`（或 npm script）
- Create: `scripts/conformance/expected-failures.yaml`
- Modify: `package.json`（加 `test:conformance` script）

**Interfaces:**
- Consumes: `@modelcontextprotocol/conformance`（npx 拉取，不加为依赖）

- [ ] **Step 1: 读官方集成文档**

WebFetch `https://github.com/modelcontextprotocol/conformance/blob/main/SDK_INTEGRATION.md`，确认 `server` 模式的精确 CLI 用法（怎么指定被测 server 的启动命令、端口、spec-version、suite、expected-failures 文件路径）。

- [ ] **Step 2: 写 run.sh**

`scripts/conformance/run.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
# 先把 backend 起在固定端口（或用 conformance 框架自带的 server 拉起机制）
# 然后跑两个 spec-version
for SPEC in 2025-11-25 2026-07-28; do
  npx @modelcontextprotocol/conformance@0.1.16 server \
    --spec-version "$SPEC" \
    --suite backcompat \
    --expected-failures scripts/conformance/expected-failures.yaml \
    -- <hub 启动命令/端点配置>
done
```

> 实施注：`<hub 启动命令/端点配置>` 的精确形态依赖 conformance 框架要求，Step 1 的文档读取结果决定。可能是 `--command "node dist/main.js"` + `--port 3000` 之类。

- [ ] **Step 3: 写 expected-failures.yaml（初始空 baseline）**

```yaml
# 已知失败基线，CI 只抓回归
# 初始为空，首次跑完根据实际失败填充
```

- [ ] **Step 4: 加 npm script**

根 `package.json` scripts 加：
```json
"test:conformance": "bash scripts/conformance/run.sh"
```

- [ ] **Step 5: 首次跑，填充 baseline**

Run: `pnpm test:conformance`
Expected: 首次会列出所有失败/通过；把已知失败（非回归）填入 yaml。

- [ ] **Step 6: 二次跑确认稳定**

Run: `pnpm test:conformance`
Expected: 只剩 baseline 内的失败，无新增。

- [ ] **Step 7: Commit**

```bash
git add scripts/conformance package.json
git commit -m "test(conformance): 接入官方 MCP conformance TCK 双 era 对拍"
```

---

## Task 14: 文档与 adoption-overview 更新

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md`（全景决策表修订 + 加 P7 链接）
- Modify: `README.md`（若有兼容性说明段落）

- [ ] **Step 1: 修订 adoption-overview 全景决策**

读 `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md:22-26`，把"激进升级，只支持新协议（入站方向）"改为：

```
| 入站方向策略 | 默认全开（modern + legacy），可配置收窄 | 修订自 P1 的"激进升级"；P7 引入协议兼容层 |
```

并在子项目表加 P7 行，链接到 `2026-08-02-protocol-compat-layer-design.md`。

- [ ] **Step 2: 更新 README 兼容性说明**

读 `README.md`，若有协议版本/兼容性段落（如 `:373-397` 的版本协商示例），补充说明 Hub 现在默认同时服务 modern/legacy 客户端。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md README.md
git commit -m "docs: 更新全景决策与 README，记录 P7 协议兼容层"
```
