#!/usr/bin/env node
/**
 * Task 11 protocol-compat-layer e2e：确定性 **legacy-era**（2025-era）上游 stdio MCP server。
 *
 * 被 Task 12 的跨 era e2e 用 `process.execPath --import tsx` 拉起作为 stdio 子进程。
 *
 * 设计（参考 mrtr-upstream-server.ts 范式，去掉 MRTR 的纯净 echo server）：
 *   - 注册单一 `echo` 工具：回显 `message` 入参。
 *   - `serveStdio(factory, { legacy: 'serve' })` 服务 legacy 客户端：
 *     2025-era opening（`initialize` 请求）被 pin 到一份 2025-era factory 实例，
 *     按手写 stdio server 的方式直接服务——跑 `initialize` 握手、
 *     `_negotiatedProtocolVersion` 落在 2025-11-25（或客户端声明的 2025-era 版本）。
 *
 * ── serveStdio legacy 取值核实（stdio.d.mts:7-20）──────────────────────
 * `ServeStdioOptions.legacy?: 'serve' | 'reject'`：
 *   - `'serve'`（默认）：connection 被 pin 到一个 2025-era 实例，按手写 stdio server 方式服务。
 *   - `'reject'`：用 unsupported-protocol-version 错误回绝 opening 请求。
 * 故 `'serve'` 确实服务 legacy 客户端，无需 fallback 到裸 `McpServer.connect(StdioServerTransport)`。
 *
 * ── 为何不用裸 McpServer.connect ──────────────────────────────────────
 * 裸连也只跑 legacy initialize、是 2025-era——但与 serveStdio 相比少了 era 决策的明确性
 * （裸连的 era 完全由客户端协商决定）。用 `legacy: 'serve'` 显式声明：无论客户端怎么开，
 * 本 fixture 都按 2025-era 服务，确定性最强。
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'legacy-upstream-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'echo',
    { inputSchema: z.object({ message: z.string() }), description: 'echo back' },
    async (args) => ({
      content: [{ type: 'text' as const, text: args.message }],
    }),
  );

  return server;
}

// 服务 legacy（2025-era）：opening `initialize` 请求被 pin 到一份 2025-era factory 实例。
serveStdio(() => buildServer(), { legacy: 'serve' });
