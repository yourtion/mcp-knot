/**
 * P5 subscriptions/listen 端到端测试
 *
 * 验证完整链路：上游工具变更 → hub（Detector/Fanout/refreshTools）→
 * 经 subscriptions/listen stream 推送 notifications/tools/list_changed 给客户端。
 *
 * 自包含设计（不依赖 api-e2e 全局 setup 的 echo server，但与之共享 worker）：
 *   - beforeAll：保存原 CONFIG_PATH；shutdown 全局 HubService（globalTestServer 已在 3000 跑，
 *     但 HubService 是 service-registry 单例）。写入新临时 CONFIG_PATH（default 组 →
 *     dynamic-upstream stdio 上游）。启动专用 TestServer（端口 3060），它复用全局 app + 注册
 *     新 HubService。
 *   - 客户端连 /default/mcp → subscriptions/listen（toolsListChanged）→
 *     通过控制工具 add_dynamic_tool 触发上游工具变更 → 断言收到 list_changed。
 *   - afterAll：停专用 server，恢复原 CONFIG_PATH，重建原 HubService（用原配置）注册回单例，
 *     保证同 worker 后续协议测试文件继续可用全局 3000 server。
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
import { closeMcpClient, createMcpTestClient } from './mcp-test-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dynamic-upstream-server.ts 绝对路径（相对本测试文件）
const UPSTREAM_SCRIPT = join(__dirname, '..', 'fixtures', 'dynamic-upstream-server.ts');

// 专用端口（避开全局 api-e2e 的 3000 与其他 project 端口）
const DEDICATED_PORT = 3060;

describe('subscriptions/listen（P5 e2e）', () => {
  let server: TestServer | null = null;
  let savedConfigPath: string | undefined;
  let tempDir: string | null = null;

  beforeAll(async () => {
    savedConfigPath = process.env.CONFIG_PATH;

    // shutdown 全局 HubService（globalTestServer 在 3000 跑，HubService 单例需让位）
    const globalHub = await shutdownHubService();
    await globalHub?.shutdown().catch(() => {});

    // 建新临时目录写入 dynamic-upstream 配置
    tempDir = mkdtempSync(join(tmpdir(), `mcp-knot-sub-e2e-${process.pid}-`));
    process.env.CONFIG_PATH = tempDir;

    writeFileSync(
      join(tempDir, 'group.json'),
      JSON.stringify(
        {
          default: {
            id: 'default',
            name: '默认组',
            description: 'subscriptions e2e',
            servers: ['dynamic-upstream'],
            tools: [],
          },
        },
        null,
        2,
      ),
    );
    // stdio 上游 = node --import tsx 运行 dynamic-upstream-server.ts
    writeFileSync(
      join(tempDir, 'mcp_server.json'),
      JSON.stringify(
        {
          servers: {
            'dynamic-upstream': {
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
      console.warn('[subscriptions e2e afterAll] 重建原 HubService 失败:', error);
    }

    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('上游工具变更时客户端经 listen 收到 notifications/tools/list_changed', async () => {
    const baseUrl = `http://localhost:${DEDICATED_PORT}`;
    const { client, transport } = await createMcpTestClient('sub-e2e-client', {
      serverPort: DEDICATED_PORT,
      baseUrl,
      group: 'default',
      mcpEndpoint: '/default/mcp',
      timeout: 30000,
      retries: 3,
    });

    try {
      // 先确认上游 static_tool 经 hub 可见（证明 stdio 上游连接 + 工具发现成功）
      const initialTools = await client.listTools();
      const toolNames = initialTools.tools.map((t) => t.name);
      expect(toolNames).toContain('dynamic-upstream_static_tool');

      // 开 subscriptions/listen（toolsListChanged）。
      // GA 客户端有 typed API client.listen(filter)，返回带 close() 的 McpSubscription：
      //   listen(filter: SubscriptionFilter): Promise<McpSubscription>
      // SubscriptionFilter 形状 = { toolsListChanged?, promptsListChanged?,
      //   resourcesListChanged?, resourceSubscriptions? }（即 wire params.notifications
      //   的内层对象，listen 内部包回 { method:'subscriptions/listen',
      //   params:{ notifications: filter } }）。McpSubscription.close() 优雅拆除流
      //   （abort listen request + 发 notifications/cancelled）。
      // listen() 在 server 的 notifications/subscriptions/acknowledged 到达时 resolve。
      // 变更通知仍经既有 setNotificationHandler 注册分发（与 2025-era unsolicited 同路径）。
      let receivedListChanged = false;
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        receivedListChanged = true;
      });

      const subscription = await client.listen({ toolsListChanged: true });

      // 触发上游工具变更：调用控制工具 add_dynamic_tool。
      // hub → 上游 → 上游注册新工具 + sendToolListChanged →
      // hub ServerManager listChanged handler → Detector → Fanout → refreshTools →
      // bus.publish tools_list_changed → listen stream 推给客户端。
      await client.callTool({
        name: 'dynamic-upstream_add_dynamic_tool',
        arguments: { name: 'injected_tool_e2e' },
      });

      // 轮询等待通知（fanout debounce 500ms + 上游/网络延迟），最长 ~8s
      const deadline = Date.now() + 8000;
      while (!receivedListChanged && Date.now() < deadline) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 150);
          t.unref?.();
        });
      }

      expect(receivedListChanged).toBe(true);

      // 优雅拆除 listen 流（abort + notifications/cancelled）；idempotent，失败忽略
      await subscription.close().catch(() => {
        /* 流已被服务端关闭等情况，忽略 */
      });
    } finally {
      await closeMcpClient(client, transport);
    }
  }, 60000);
});
