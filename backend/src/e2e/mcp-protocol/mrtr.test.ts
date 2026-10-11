import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
/**
 * P5 MRTR 端到端测试（Task 9，M3 里程碑可交付）
 *
 * 真实 MCP client 验证 MRTR 全链路：
 *   1. 上游工具首次返回 input_required（inputRequired.elicit）
 *   2. Hub 中转：mint Hub 级 requestState（HMAC-SHA256），把 serverId/toolName/
 *      upstreamRequestState/step 印封进 state，返回给客户端
 *   3. 客户端带响应（requestState + inputResponses）重试
 *   4. Hub verify 客户端回传的 state → 还原上游上下文 → 把 inputResponses +
 *      上游原始 state 透传给上游 callTool → 上游返回最终结果
 *
 * 自包含设计（复用 subscriptions.test.ts 的独立 TestServer + stdio 上游 + 真实 client +
 * beforeAll/afterAll 管理 HubService 单例模式）：独立端口（3061），CONFIG_PATH 指向
 * mrtr-upstream-server（stdio 上游），HubService 单例切换。
 *
 * 上游 fixture：backend/src/e2e/fixtures/mrtr-upstream-server.ts（已存在，复用）。
 *
 * ── 客户端 MRTR 重试 API 核实（SDK GA 2.0.0）──────────────────────────────────
 * 客户端 MRTR 有两种模式（见 @modelcontextprotocol/client 的 InputRequiredOptions）：
 *   - autoFulfill（默认 true）：客户端注册 elicitation/create handler 后，SDK 自动
 *     响应 input_required 并重试，client.callTool() 只返回最终 CallToolResult——
 *     中间的 input_required 与 Hub state 不可见，无法断言中转语义。
 *   - 手动模式（autoFulfill:false）：配合 callTool 的 `{ allowInputRequired: true }`
 *     options，client.callTool() 把 input_required 结果直接交给调用方（类型为
 *     CallToolResult | InputRequiredResult 的联合），可观察中间的 resultType /
 *     requestState（即 Hub mint 的 Hub state）。
 *
 * 本 e2e 用手动模式，以断言「Hub 返回的 state 是 Hub mint 的（非上游原始）」这一中转核心。
 *
 * 重试请求怎么带 requestState + inputResponses？
 *   - 它们是 2026-07-28 wire 协议 `tools/call` request params 的**顶层成员**
 *     （与 name/arguments 平级；SDK 内部 LiftedWireMaterial 从 params 顶层 lift 出来，
 *     经 ctx.mcpReq.requestState / .inputResponses 暴露给 handler）。
 *   - SDK 的 CallToolRequestParamsSchema 类型定义不含这两个字段（$loose/passthrough），
 *     但运行时 callTool(params) 接受任意 params 并按字面序列化——Hub 自身的
 *     server_manager.executeToolOnServerWithContext 正是这样调用上游 client.callTool 的
 *     （callParams.inputResponses / callParams.requestState 为顶层成员）。本测试同理。
 *
 * inputResponses.confirm 的形状：对 inputRequired.elicit 请求，响应是 ElicitResult
 *   { action: 'accept', content: { confirm: true } }；上游 acceptedContent<...>('confirm')
 *   读出 accept 态的 content。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHubService,
  setHubService,
  shutdownHubService,
} from '../../services/service-registry.js';
import { getAllConfig, resetConfigInstances } from '../../utils/config.js';
import { TestServer } from '../test-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// mrtr-upstream-server.ts 绝对路径（相对本测试文件的 fixtures 目录）
const UPSTREAM_SCRIPT = join(__dirname, '..', 'fixtures', 'mrtr-upstream-server.ts');

// 专用端口（避开 subscriptions e2e 的 3060、全局 api-e2e 的 3000）
const DEDICATED_PORT = 3061;

// 工具名（Hub 按 `${serverId}_${toolName}` 注册）
const CONFIRM_TOOL = 'mrtr-upstream_confirm_action';
const STATIC_TOOL = 'mrtr-upstream_static_tool';

describe('MRTR（P5 e2e）', () => {
  let server: TestServer | null = null;
  let savedConfigPath: string | undefined;
  let tempDir: string | null = null;

  beforeAll(async () => {
    savedConfigPath = process.env.CONFIG_PATH;

    // shutdown 全局 HubService（globalTestServer 在 3000 跑，HubService 单例需让位）
    const globalHub = await shutdownHubService();
    await globalHub?.shutdown().catch(() => {});

    // 建新临时目录写入 mrtr-upstream 配置
    tempDir = mkdtempSync(join(tmpdir(), `mcp-knot-mrtr-e2e-${process.pid}-`));
    process.env.CONFIG_PATH = tempDir;

    writeFileSync(
      join(tempDir, 'group.json'),
      JSON.stringify(
        {
          default: {
            id: 'default',
            name: '默认组',
            description: 'mrtr e2e',
            servers: ['mrtr-upstream'],
            tools: [],
          },
        },
        null,
        2,
      ),
    );
    // stdio 上游 = node --import tsx 运行 mrtr-upstream-server.ts
    writeFileSync(
      join(tempDir, 'mcp_server.json'),
      JSON.stringify(
        {
          servers: {
            'mrtr-upstream': {
              type: 'stdio',
              command: process.execPath,
              args: ['--import', 'tsx', UPSTREAM_SCRIPT],
              env: {},
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(tempDir, 'api_tools.json'), JSON.stringify({ version: '1.0', tools: [] }));

    resetConfigInstances();

    server = new TestServer(DEDICATED_PORT);
    await server.start();
    // 等上游 stdio server 连接 + 工具发现
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      t.unref?.();
    });
  }, 120000);

  afterAll(async () => {
    try {
      await server?.stop();
    } catch {
      // ignore
    }
    // 关闭本测试的 HubService
    const myHub = await shutdownHubService();
    await myHub?.shutdown().catch(() => {});

    // 恢复原 CONFIG_PATH 并重建原 HubService，注册回单例供同 worker 后续文件复用
    if (savedConfigPath !== undefined) {
      process.env.CONFIG_PATH = savedConfigPath;
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
      // 恢复失败不致测试失败（但可能影响同 worker 后续文件）
      console.warn('[mrtr e2e afterAll] 重建原 HubService 失败:', error);
    }

    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  /**
   * 构造 MRTR 手动模式 client：
   *   - inputRequired.autoFulfill = false（不自动响应 input_required）
   *   - capabilities 声明 tools + elicitation（真实交互 client 形态）
   *   - versionNegotiation: auto（Hub legacy:reject，强制走 2026-07-28 modern）
   */
  async function createMrtrClient(name: string): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }> {
    const mcpUrl = `http://localhost:${DEDICATED_PORT}/default/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    const client = new Client(
      { name, version: '1.0.0' },
      {
        capabilities: { tools: {}, elicitation: {} },
        versionNegotiation: { mode: 'auto' },
        // 关键：禁自动 fulfil，使 input_required 结果交回调用方
        inputRequired: { autoFulfill: false },
      },
    );
    await client.connect(transport);
    return { client, transport };
  }

  it('上游 input_required → Hub 中转 mint hubState → 客户端重试 → 最终结果', async () => {
    const { client, transport } = await createMrtrClient('mrtr-e2e-client');

    try {
      // 0) 先确认上游经 Hub 可见（证明 stdio 上游连接 + 工具发现成功）
      const initialTools = await client.listTools();
      const toolNames = initialTools.tools.map((t) => t.name);
      expect(toolNames).toContain(STATIC_TOOL);
      expect(toolNames).toContain(CONFIRM_TOOL);

      // 1) 首次调用 confirm_action（手动模式 + allowInputRequired）→ 期望 input_required
      //
      // callTool 在 allowInputRequired 下返回联合类型（CallToolResult | InputRequiredResult）。
      // SDK 运行时按 resultType 判别；此处用结构断言而非 TS 类型窄化（SDK 类型是 sealed 联合）。
      const first = await client.callTool(
        { name: CONFIRM_TOOL, arguments: { action: 'deploy' } },
        { allowInputRequired: true },
      );

      const firstResult = first as {
        resultType?: string;
        content?: unknown;
        inputRequests?: unknown;
        requestState?: string;
      };
      expect(firstResult.resultType).toBe('input_required');
      expect(firstResult.content).toBeUndefined();
      // inputRequests 上游按 opaque 透传：应含 confirm 的 elicit 请求
      expect(firstResult.inputRequests).toBeDefined();
      const hubState = firstResult.requestState;
      expect(hubState).toBeDefined();
      expect(typeof hubState).toBe('string');
      expect(hubState!.length).toBeGreaterThan(0);

      // 中转核心断言：hubState 是 Hub mint 的（HubState：serverId/toolName/
      // upstreamRequestState/step/exp），不是上游原始 state（上游 state payload 是
      // { round: 1 }）。requestState wire 形态 = "v1." + b64url(payload) + "." + b64url(mac)，
      // payload 是签名而非加密（见 createRequestStateCodec 文档），可 base64url 解码读 payload
      // 做结构断言。decodeRequestStatePayload 是测试内联 helper（见文件底部）。
      const decoded = decodeRequestStatePayload(hubState!);
      expect(decoded).toBeDefined();
      expect(decoded!.serverId).toBe('mrtr-upstream');
      expect(decoded!.toolName).toBe('confirm_action');
      expect(decoded!.step).toBe(1);
      // upstreamRequestState 是上游自己的 state（opaque 句柄），应为非空字符串
      expect(typeof decoded!.upstreamRequestState).toBe('string');
      expect(decoded!.upstreamRequestState!.length).toBeGreaterThan(0);

      // 2) 带响应重试：顶层 requestState（Hub mint 的，原样回传）+ inputResponses
      //
      // inputResponses.confirm = ElicitResult { action: 'accept', content: { confirm: true } }
      // （对上游 inputRequired.elicit 请求的应答）。requestState/inputResponses 是 2026-07-28
      // wire params 顶层成员（非 _meta），SDK callTool 运行时按字面序列化透传。
      const retryParams = {
        name: CONFIRM_TOOL,
        arguments: { action: 'deploy' },
        requestState: hubState,
        inputResponses: {
          confirm: { action: 'accept' as const, content: { confirm: true } },
        },
      };
      const second = await client.callTool(retryParams);

      // 3) 最终结果：上游 confirm===true → `${action} 已确认并执行成功`
      const secondResult = second as {
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(secondResult.content).toBeDefined();
      expect(Array.isArray(secondResult.content)).toBe(true);
      expect(secondResult.content!.length).toBeGreaterThan(0);
      const text = secondResult.content![0]!.text;
      expect(text).toContain('deploy');
      expect(text).toContain('确认');
      expect(secondResult.isError).toBeFalsy();
    } finally {
      try {
        await client.close();
      } catch {
        // ignore
      }
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
  }, 60000);
});

/**
 * 解码 Hub mint 的 requestState 的 payload 部分（仅用于断言中转语义）。
 *
 * requestState wire 形态 = `"v1." base64url({"p":<payload>,"exp":…,"b":…?}) "." base64url(mac)`
 * （见 createRequestStateCodec 文档：签名而非加密，payload 可读）。Hub mint 的 payload
 * 是 HubState（{ serverId, toolName, upstreamRequestState?, step, exp }）。本 helper 只取
 * 中间段做 base64url 解码再读 `.p`，不验签（验签由 Hub 的 SDK seam 完成）。
 */
function decodeRequestStatePayload(state: string):
  | {
      serverId?: string;
      toolName?: string;
      upstreamRequestState?: string;
      step?: number;
      exp?: number;
    }
  | undefined {
  const parts = state.split('.');
  // 期望 ["v1", <b64url payload>, <b64url mac>]
  if (parts.length < 2 || parts[0] !== 'v1') {
    return undefined;
  }
  // base64url → base64 → JSON
  const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      p?: {
        serverId?: string;
        toolName?: string;
        upstreamRequestState?: string;
        step?: number;
        exp?: number;
      };
    };
    return decoded.p;
  } catch {
    return undefined;
  }
}
