#!/usr/bin/env node
/**
 * Task 11 protocol-compat-layer e2e：确定性 **modern-era** 上游 stdio MCP server。
 *
 * 被 Task 12 的跨 era e2e 用 `process.execPath --import tsx` 拉起作为 stdio 子进程。
 *
 * 设计（参考 mrtr-upstream-server.ts 范式，去掉 MRTR 的纯净 echo server）：
 *   - 注册单一 `echo` 工具：回显 `message` 入参。
 *   - `serveStdio(factory, { legacy: 'reject' })` 强制 modern：
 *     2025-era opening（`initialize` 请求 / 无 claim 消息）会被
 *     `unsupported-protocol-version` 错误回绝，连接保持开放等 modern opening
 *     （`server/discover` probe）。对 Hub（versionNegotiation: auto）的 probe 只能落在
 *     modern era，`_negotiatedProtocolVersion` 被 pin 到 modern revision。
 *
 * ── 为何用 serveStdio 而非裸 McpServer.connect ──────────────────────────
 * 见 mrtr-upstream-server.ts 顶部注释：裸 `new McpServer(...).connect(StdioServerTransport)`
 * 只跑 legacy initialize 握手，从不 setNegotiatedProtocolVersion 到 modern，对任何客户端
 * 都是 2025-era。`serveStdio(..., { legacy: 'reject' })` 才是 modern stdio serving 入口，
 * 处理 `server/discover` probe、按连接 era pin factory 实例。本 fixture 要确定性服务 modern
 * 客户端，故用 `legacy: 'reject'`。
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'modern-upstream-fixture', version: '1.0.0' },
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

// 强制 modern：2025-era opening 被回绝，连接等 modern opening（server/discover probe）。
serveStdio(() => buildServer(), { legacy: 'reject' });
