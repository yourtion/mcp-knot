import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
/**
 * MCP 协议合规端到端测试（Task 13）
 *
 * 验证 Hub 在升级到 MCP 2026-07-28（v2）后的 4 个核心协议合规点：
 *   1. server/discover 返回 capabilities（modern 握手真的能跑通）
 *   2. 入站激进升级（legacy: 'reject'）拒绝 2025-era initialize
 *   3. 协议转换 / 桥接（Hub 对外 StreamableHTTP，后端 mock 老 server）
 *      —— 见用例内 TODO：当前基础设施不足，标注 skip
 *   4. 无状态：两个互不相关的请求被独立处理（无 session 粘连）
 *
 * 配置 / 服务器生命周期由 api-e2e 全局 setup（vitest.e2e.setup.ts）统一管理，
 * 本文件只做 console 静默等本地环境准备，不在 afterAll 清理共享状态。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../../app.js';
import {
  createHubService,
  setHubService,
  shutdownCoreServiceManager,
  shutdownHubService,
} from '../../services/service-registry.js';
import { getAllConfig, resetConfigInstances } from '../../utils/config.js';
import { TestServer } from '../test-server.js';
import {
  cleanupTestEnvironment,
  safeJsonParse,
  setupTestEnvironment,
  sleep,
} from '../test-utils.js';
import {
  closeMcpClient,
  createMcpTestClient,
  defaultMcpTestConfig,
  ensureTestServerRunning,
} from './mcp-test-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Task 11 fixture 脚本绝对路径（相对本测试文件的 fixtures 目录）
const LEGACY_UPSTREAM_SCRIPT = join(__dirname, '..', 'fixtures', 'legacy-upstream-server.ts');

// 专用端口（避开全局 api-e2e 的 3000、subscriptions 的 3060、mrtr 的 3061）
const BRIDGE_E2E_PORT = 3062; // 用例 3：出站 era 桥接（Hub → legacy upstream）
const INBOUND_LEGACY_PORT = 3063; // 用例 5：入站 legacy 客户端连默认全开 Hub

describe('MCP 协议合规（2026-07-28 / v2）', () => {
  let restoreConsole: () => void;
  let serverReady = false;

  beforeAll(async () => {
    restoreConsole = setupTestEnvironment();
    serverReady = await ensureTestServerRunning();
    if (serverReady) {
      await sleep(200);
    }
  });

  afterAll(() => {
    cleanupTestEnvironment();
    restoreConsole();
  });

  // ------------------------------------------------------------------
  // 用例 1：server/discover 返回 capabilities
  //
  // modern 客户端用 `versionNegotiation: { mode: 'auto' }` 连接时，SDK 会先
  // 探测 server/discover；成功后连接进入 'modern' era。这里验证：
  //   - 连接成功且 era === 'modern'
  //   - getServerCapabilities() 返回非空对象（至少声明 tools）
  //   - client.discover() 可独立调用并返回 DiscoverResult
  // ------------------------------------------------------------------
  describe('用例 1：server/discover 返回 capabilities', () => {
    it('modern 连接应完成 discover 并暴露 tools capability', async () => {
      if (!serverReady) {
        console.warn('服务器未就绪，跳过');
        return;
      }

      const connection = await createMcpTestClient(
        'compliance-discover-client',
        defaultMcpTestConfig,
      );
      const { client, transport } = connection;

      try {
        // era 必须是 modern（探测到 2026-07-28）
        expect(client.getProtocolEra()).toBe('modern');

        // 协议版本应为 2026-07-28+
        const version = client.getNegotiatedProtocolVersion();
        expect(version).toBeTruthy();
        expect(typeof version).toBe('string');

        // capabilities 必须包含 tools（Hub 至少聚合了工具）
        const caps = client.getServerCapabilities();
        expect(caps).toBeDefined();
        expect(caps).toHaveProperty('tools');

        // 独立调用 discover() 也应成功并返回 capabilities 字段
        const discoverResult = await client.discover();
        expect(discoverResult).toBeDefined();
        expect(discoverResult).toHaveProperty('capabilities');

        console.log(
          `✅ discover 通过：era=${client.getProtocolEra()}, version=${version}, ` +
            `capabilities=${Object.keys(caps!).join(',')}`,
        );
      } finally {
        await closeMcpClient(client, transport);
      }
    }, 30000);
  });

  // ------------------------------------------------------------------
  // 用例 2：入站激进升级拒绝 2025-era initialize
  //
  // group-router 用 createMcpHandler({ legacy: 'reject' }) 构造 handler，
  // 所有不带 v2 _meta envelope 的旧式 initialize 必须被拒绝（4xx）。
  // 用进程内 app.request() 直接打 /:group/mcp，避免客户端 SDK 自动加 envelope。
  // ------------------------------------------------------------------
  describe('用例 2：激进升级拒绝 2025-era initialize', () => {
    it('裸 initialize（无 _meta envelope）应返回 4xx JSON-RPC error', async () => {
      const response = await app.request('/default/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'legacy-probe', version: '1.0.0' },
          },
        }),
      });

      // legacy: 'reject' → 4xx（不是 200，也不是 500）
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);

      const data = await safeJsonParse(response);
      expect(data).toHaveProperty('jsonrpc', '2.0');
      expect(data).toHaveProperty('error');
      expect(data.error).toHaveProperty('code');
      // 不应是 -32603 INTERNAL_ERROR（那表示 handler 异常，而非主动拒绝）
      expect(data.error.code).not.toBe(-32603);

      console.log(
        `✅ 2025-era initialize 被拒绝：status=${response.status}, ` +
          `error.code=${data.error.code}`,
      );
    });

    it('2025-era tools/list 请求（无 envelope）应被拒绝', async () => {
      // legacy: 'reject' 针对的是「需要响应的旧式 JSON-RPC 请求」。
      // notifications/initialized 是通知（无 id、无需响应），服务端按 HTTP
      // 语义返回 202 Accepted 属正常行为，不构成「握手」—— 因此激进的拒绝策略
      // 只作用于 request。这里改用旧式 tools/list（带 id，需要响应）来验证：
      // 它没有 v2 _meta envelope，也没有 mcp-protocol-version 头，应被拒绝。
      const response = await app.request('/default/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      });

      // legacy: 'reject' → 4xx（非 200，非 500）
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);

      const data = await safeJsonParse(response);
      expect(data).toHaveProperty('jsonrpc', '2.0');
      expect(data).toHaveProperty('error');

      console.log(
        `✅ 2025-era tools/list 被拒绝：status=${response.status}, ` +
          `error.code=${data.error.code}`,
      );
    });
  });

  // ------------------------------------------------------------------
  // 用例 3：出站 era 桥接（modern 客户端 → Hub → legacy 2025-era upstream）
  //
  // 目标：Hub 对外暴露 modern StreamableHTTP（2026-07-28），后端接一个确定性
  // legacy-era 上游（Task 11 的 legacy-upstream-server.ts，serveStdio legacy:'serve'
  // → 只跑 2025-era initialize 握手）。验证：
  //   1. Hub 出站 versionNegotiation:{mode:'auto'} 回退到 legacy initialize，
  //      server_manager.connectServer 成功、上游工具被发现并聚合到 default 组。
  //   2. modern 客户端连 Hub /default/mcp，走 server/discover（modern era）。
  //   3. 客户端 tools/list 能看到上游 echo 工具（注册名 `legacy-upstream_echo`）。
  //   4. 客户端 tools/call 该工具，Hub 把 modern 请求桥接到 legacy 上游，
  //      上游回执回显 content[0].text === 入参 message。
  //
  // 自包含子进程拉起骨架（复用 mrtr.test.ts:62-138 权威模板）：mkdtempSync 建临时
  // config 目录 → 写 group.json + mcp_server.json（command: process.execPath，
  // args: ['--import','tsx', LEGACY_UPSTREAM_SCRIPT]）→ CONFIG_PATH + resetConfigInstances
  // → shutdown 全局 HubService → new TestServer(DEDICATED_PORT) → start → sleep(3000)
  // 等上游 stdio 连接 + 工具发现。afterAll 还原 CONFIG_PATH 并重建原 HubService 单例。
  // ------------------------------------------------------------------
  describe('用例 3：出站 era 桥接（StreamableHTTP ↔ legacy backend）', () => {
    // 本 describe 独立管理生命周期：专用端口 + 独立 CONFIG_PATH + HubService 单例切换。
    // 这些字段在 beforeAll 填充，afterAll 清理。
    let bridgeServer: TestServer | null = null;
    let savedConfigPath3: string | undefined;
    let tempDir3: string | null = null;

    beforeAll(async () => {
      savedConfigPath3 = process.env.CONFIG_PATH;

      // shutdown 全局 HubService（api-e2e 全局 setup 在 3000 跑，单例需让位给本测试）。
      // 同时清空 coreServiceManager 单例（service-registry 的模块级缓存）：它包装的是
      // 旧 hub 的 ServerManager，若不清，ensureGroupMcpService → getCoreServiceManager
      // 会复用旧 adapter（指向已关闭的旧 SM），导致 GroupMcpService 看到空连接/空工具，
      // 即使新 hub 的 ServerManager 已正常连上 legacy 上游。新 hub 启动后
      // getCoreServiceManager 会按当前 setHubService 单例重建 adapter。
      const globalHub = await shutdownHubService();
      await globalHub?.shutdown().catch(() => {});
      await shutdownCoreServiceManager();

      tempDir3 = mkdtempSync(join(tmpdir(), `mcp-knot-bridge-e2e-${process.pid}-`));
      process.env.CONFIG_PATH = tempDir3;

      writeFileSync(
        join(tempDir3, 'group.json'),
        JSON.stringify(
          {
            default: {
              id: 'default',
              name: '默认组',
              description: '出站 era 桥接 e2e',
              servers: ['legacy-upstream'],
              tools: [],
            },
          },
          null,
          2,
        ),
      );
      // stdio 上游 = node --import tsx 运行 legacy-upstream-server.ts（确定性 2025-era）
      writeFileSync(
        join(tempDir3, 'mcp_server.json'),
        JSON.stringify(
          {
            servers: {
              'legacy-upstream': {
                type: 'stdio',
                command: process.execPath,
                args: ['--import', 'tsx', LEGACY_UPSTREAM_SCRIPT],
                env: {},
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tempDir3, 'api_tools.json'),
        JSON.stringify({ version: '1.0', tools: [] }),
      );

      resetConfigInstances();

      // 关键：失效 mcp-handler-factory 模块级缓存（groupServices / groupHandlers）。
      // 这些缓存复用旧 hub 的 GroupMcpService（绑定旧 coreServiceManager/旧上游）。
      // 本测试复用同名 default 组，若不清缓存，请求会拿到旧 service（带旧上游工具/空连接），
      // 即使新 hub 已连上 legacy 上游。失效后 createGroupMcpHandler 按 new config 重建。
      const { invalidateAllGroupMcpServices } =
        await import('../../api/mcp/mcp-handler-factory.js');
      await invalidateAllGroupMcpServices();

      bridgeServer = new TestServer(BRIDGE_E2E_PORT);
      await bridgeServer.start();
      // 等上游 stdio server 连接 + 工具发现（server_manager.initialize 并发连上游）
      await sleep(3000);
    }, 120000);

    afterAll(async () => {
      try {
        await bridgeServer?.stop();
      } catch {
        // ignore
      }
      const myHub = await shutdownHubService();
      await myHub?.shutdown().catch(() => {});

      if (savedConfigPath3 !== undefined) {
        process.env.CONFIG_PATH = savedConfigPath3;
      }
      resetConfigInstances();
      // 重建原 HubService 单例，避免污染同 worker 后续文件（与 mrtr e2e afterAll 对称）
      try {
        const origConfig = await getAllConfig();
        const restored = await createHubService({
          servers: origConfig.mcps.servers as never,
          groups: origConfig.groups as never,
          apiToolsConfigPath: origConfig.apiToolsConfigPath,
        });
        await restored.initialize();
        setHubService(restored);
      } catch (error) {
        console.warn('[bridge e2e afterAll] 重建原 HubService 失败:', error);
      }

      if (tempDir3) {
        try {
          rmSync(tempDir3, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it('Hub 能连 legacy upstream 并把 modern 请求桥接到其 echo 工具', async () => {
      // modern 客户端连 Hub：走 server/discover（modern era），暴露 legacy 上游聚合的工具
      const connection = await createMcpTestClient('bridge-e2e-client', {
        serverPort: BRIDGE_E2E_PORT,
        baseUrl: `http://localhost:${BRIDGE_E2E_PORT}`,
        group: 'default',
        mcpEndpoint: '/default/mcp',
        timeout: 30000,
        retries: 3,
      });
      const { client, transport } = connection;

      try {
        // Hub 出站走 modern（discover 成功）
        expect(client.getProtocolEra()).toBe('modern');

        // 上游 echo 工具应被聚合到 default 组（注册名 `${serverId}_${toolName}`）
        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);
        expect(names).toContain('legacy-upstream_echo');

        // modern 客户端 tools/call → Hub 桥接到 legacy 上游 → 回声
        const result = await client.callTool({
          name: 'legacy-upstream_echo',
          arguments: { message: 'hello-from-modern-client' },
        });
        const r = result as {
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
        expect(r.content).toBeDefined();
        expect(Array.isArray(r.content)).toBe(true);
        expect(r.content!.length).toBeGreaterThan(0);
        expect(r.content![0]!.text).toBe('hello-from-modern-client');
        expect(r.isError).toBeFalsy();

        console.log(
          `✅ 出站 era 桥接通过：modern 客户端 → Hub(modern) → legacy upstream，` +
            `echo 回声="${r.content![0]!.text}"`,
        );
      } finally {
        await closeMcpClient(client, transport);
      }
    }, 60000);
  });

  // ------------------------------------------------------------------
  // 用例 4：无状态
  //
  // group-router 用 createMcpHandler 构造的是无状态 handler：每个 POST 请求
  // 独立处理，不依赖前序请求建立的 session。验证方式：
  //   - 连续发两个互不相关的 modern 请求（各带独立 id），都应成功
  //   - 不带 session 头 / 不先 initialize，直接 tools/list 也能工作
  // （v2 modern 路径本就是 per-request，无 session 概念）
  // ------------------------------------------------------------------
  describe('用例 4：无状态（每个请求独立处理）', () => {
    it('两个独立 modern 请求无需共享 session 即可各自成功', async () => {
      if (!serverReady) {
        console.warn('服务器未就绪，跳过');
        return;
      }

      // 用两个独立客户端连接（各自独立 discover + listTools），互不知道对方
      const conn1 = await createMcpTestClient('stateless-client-a', defaultMcpTestConfig);
      const conn2 = await createMcpTestClient('stateless-client-b', defaultMcpTestConfig);

      try {
        const [tools1, tools2] = await Promise.all([
          conn1.client.listTools(),
          conn2.client.listTools(),
        ]);

        // 两次独立请求都应拿到工具列表（至少 1 个）
        expect(tools1.tools).toBeInstanceOf(Array);
        expect(tools1.tools.length).toBeGreaterThan(0);
        expect(tools2.tools).toBeInstanceOf(Array);
        expect(tools2.tools.length).toBeGreaterThan(0);

        // 同一 default 组的工具集应一致（聚合逻辑无状态、可重现）
        const names1 = tools1.tools.map((t) => t.name).toSorted();
        const names2 = tools2.tools.map((t) => t.name).toSorted();
        expect(names1).toEqual(names2);

        console.log(`✅ 无状态验证通过：两次独立请求都拿到 ${names1.length} 个工具`);
      } finally {
        await closeMcpClient(conn1.client, conn1.transport);
        await closeMcpClient(conn2.client, conn2.transport);
      }
    }, 30000);

    it('modern 连接不建立 session（无 mcp-session-id 响应头）', async () => {
      if (!serverReady) {
        console.warn('服务器未就绪，跳过');
        return;
      }

      // 无状态的 modern handler 不应分配 session id：
      // 任何响应都不带 `mcp-session-id` 头，客户端 transport 也不会记录 sessionId。
      const capturedSessionHeaders: string[] = [];
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await origFetch(input, init);
        const sid = response.headers.get('mcp-session-id');
        if (sid) {
          capturedSessionHeaders.push(sid);
        }
        return response;
      }) as typeof fetch;

      try {
        const connection = await createMcpTestClient('stateless-no-session', defaultMcpTestConfig);
        const { client, transport } = connection;
        try {
          await client.listTools();
          // 不应捕获到任何 session id 头
          expect(capturedSessionHeaders).toHaveLength(0);
          // transport 也不应持有 sessionId
          const sid = (transport as unknown as { sessionId?: string }).sessionId;
          expect(sid).toBeUndefined();

          console.log('✅ modern 路径无 session（响应头 + transport 均无 sessionId）');
        } finally {
          await closeMcpClient(client, transport);
        }
      } finally {
        globalThis.fetch = origFetch;
      }
    }, 30000);
  });

  // ------------------------------------------------------------------
  // 用例 5：入站 legacy 客户端能连默认全开（legacy:'stateless'）的 Hub
  //
  // P7 入站策略（Task 9）：默认 CompatibilityOptions（全开）经
  // InboundProtocolAdapter.resolveLegacyMode('http') 解析为 'stateless'。
  // SDK 文档（createMcpHandler options.legacy）明确：'stateless'（默认）下
  // 「每个 legacy 请求由同一 factory 的 fresh 实例经 sessionIdGenerator:undefined
  //  的 streamable HTTP transport 服务」——即 2025-era 裸 initialize 握手会被服务。
  //
  // 验证：legacy 客户端（versionNegotiation:{mode:'legacy'}，纯 2025-era initialize
  // 握手，不发 server/discover）连默认全开 Hub：
  //   1. 连接成功且 era === 'legacy'（裸 initialize 被服务，而非 4xx 拒绝）
  //   2. tools/list 能拿到上游聚合工具
  //   3. tools/call 能调用并拿到回声结果
  //
  // 用专用端口 + 真实 modern upstream fixture，使 default 组有可调用工具。
  // ------------------------------------------------------------------
  describe('用例 5：入站 legacy 客户端能连默认全开（stateless）Hub', () => {
    let inboundServer: TestServer | null = null;
    let savedConfigPath5: string | undefined;
    let tempDir5: string | null = null;

    beforeAll(async () => {
      savedConfigPath5 = process.env.CONFIG_PATH;

      const globalHub = await shutdownHubService();
      await globalHub?.shutdown().catch(() => {});
      // 清空 coreServiceManager 单例，避免它复用旧 hub 的 ServerManager（同用例 3）。
      await shutdownCoreServiceManager();

      tempDir5 = mkdtempSync(join(tmpdir(), `mcp-knot-inbound-legacy-${process.pid}-`));
      process.env.CONFIG_PATH = tempDir5;

      // default 组指向 modern upstream fixture（提供可调用的 echo 工具）。
      // 不写 system.json 的 compatibility 段 → getCompatibilityOptions 回退默认全开 →
      // InboundProtocolAdapter.resolveLegacyMode('http') === 'stateless'。
      writeFileSync(
        join(tempDir5, 'group.json'),
        JSON.stringify(
          {
            default: {
              id: 'default',
              name: '默认组',
              description: '入站 legacy 客户端 e2e',
              servers: ['modern-upstream'],
              tools: [],
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tempDir5, 'mcp_server.json'),
        JSON.stringify(
          {
            servers: {
              'modern-upstream': {
                type: 'stdio',
                command: process.execPath,
                args: [
                  '--import',
                  'tsx',
                  join(__dirname, '..', 'fixtures', 'modern-upstream-server.ts'),
                ],
                env: {},
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tempDir5, 'api_tools.json'),
        JSON.stringify({ version: '1.0', tools: [] }),
      );

      resetConfigInstances();

      // 失效 mcp-handler-factory 缓存（同用例 3）：default 组的 GroupMcpService
      // 必须按 new config 重建，否则复用旧 hub 的 service。
      const { invalidateAllGroupMcpServices } =
        await import('../../api/mcp/mcp-handler-factory.js');
      await invalidateAllGroupMcpServices();

      inboundServer = new TestServer(INBOUND_LEGACY_PORT);
      await inboundServer.start();
      await sleep(3000);
    }, 120000);

    afterAll(async () => {
      try {
        await inboundServer?.stop();
      } catch {
        // ignore
      }
      const myHub = await shutdownHubService();
      await myHub?.shutdown().catch(() => {});

      if (savedConfigPath5 !== undefined) {
        process.env.CONFIG_PATH = savedConfigPath5;
      }
      resetConfigInstances();
      try {
        const origConfig = await getAllConfig();
        const restored = await createHubService({
          servers: origConfig.mcps.servers as never,
          groups: origConfig.groups as never,
          apiToolsConfigPath: origConfig.apiToolsConfigPath,
        });
        await restored.initialize();
        setHubService(restored);
      } catch (error) {
        console.warn('[inbound-legacy e2e afterAll] 重建原 HubService 失败:', error);
      }

      if (tempDir5) {
        try {
          rmSync(tempDir5, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it('legacy 客户端（裸 2025-era initialize）能连默认全开 Hub 并调工具', async () => {
      // legacy 客户端：versionNegotiation:{mode:'legacy'} 强制纯 2025-era initialize
      // 握手（不发 server/discover probe）。SDK 默认 mode 就是 'legacy'，显式写出以
      // 明确测试意图：这是确定性 legacy 客户端，而非 auto 探测的现代客户端。
      const mcpUrl = `http://localhost:${INBOUND_LEGACY_PORT}/default/mcp`;
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
      const client = new Client(
        { name: 'legacy-inbound-client', version: '1.0.0' },
        {
          capabilities: { tools: {} },
          versionNegotiation: { mode: 'legacy' },
        },
      );
      await client.connect(transport);

      try {
        // 核心断言：legacy 握手被服务（stateless 模式），era 落在 'legacy' 而非被拒。
        // 若 SDK stateless 实际拒绝裸 initialize，client.connect 会抛错，到不了这里。
        expect(client.getProtocolEra()).toBe('legacy');

        // tools/list：legacy 路径仍应聚合到上游工具
        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);
        expect(names).toContain('modern-upstream_echo');

        // tools/call：legacy 客户端调用 → Hub 处理 → 上游回声
        const result = await client.callTool({
          name: 'modern-upstream_echo',
          arguments: { message: 'legacy-client-hello' },
        });
        const r = result as {
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
        expect(r.content).toBeDefined();
        expect(Array.isArray(r.content)).toBe(true);
        expect(r.content!.length).toBeGreaterThan(0);
        expect(r.content![0]!.text).toBe('legacy-client-hello');
        expect(r.isError).toBeFalsy();

        console.log(
          `✅ 入站 legacy 客户端通过：era=${client.getProtocolEra()}，` +
            `tools=${names.length}，echo 回声="${r.content![0]!.text}"`,
        );
      } finally {
        await closeMcpClient(client, transport);
      }
    }, 60000);
  });
});
