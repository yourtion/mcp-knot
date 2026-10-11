/**
 * P5 subscriptions e2e：可运行时增删工具的上游测试 MCP server。
 *
 * 被 hub 作为 stdio 子进程拉起（见 subscriptions.test.ts 的配置注入）。
 * 设计：
 *   - 初始注册 1 个静态工具 `static_tool`，保证连接后 tools/list 非空。
 *   - 注册控制工具 `add_dynamic_tool`：调用后向内部工具集追加一个新工具，
 *     并立即 sendToolListChanged() 推送 notifications/tools/list_changed。
 *   - hub 收到 listChanged → ServerManager changeDetector → fanout → refreshTools，
 *     客户端经 subscriptions/listen 收到 notifications/tools/list_changed。
 *
 * 控制工具模式避免额外的带外控制信道（stdio 已被 MCP 占用）。
 * 用 McpServer + StdioServerTransport 直连（stdio 单连接），声明 tools.listChanged 能力。
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

interface DynTool {
  name: string;
  description: string;
}

const dynamicTools: DynTool[] = [];
let dynamicCounter = 0;

const server = new McpServer(
  { name: 'dynamic-upstream', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

// 静态工具
server.registerTool(
  'static_tool',
  { inputSchema: z.object({}), description: '静态测试工具' },
  async () => ({
    content: [{ type: 'text' as const, text: 'static_tool ok' }],
  }),
);

// 控制工具：追加一个动态工具并推送 listChanged
server.registerTool(
  'add_dynamic_tool',
  {
    inputSchema: z.object({ name: z.string().optional() }),
    description: '控制工具：运行时新增一个工具并推送 tools/list_changed',
  },
  async (args) => {
    dynamicCounter += 1;
    const name = args?.name ?? `dynamic_tool_${dynamicCounter}`;
    dynamicTools.push({ name, description: `运行时注入的动态工具 #${dynamicCounter}` });
    // 注册新工具到 server（使其在下次 tools/list 可见）
    server.registerTool(
      name,
      {
        inputSchema: z.object({}),
        description: dynamicTools[dynamicTools.length - 1]!.description,
      },
      async () => ({
        content: [{ type: 'text' as const, text: `${name} ok` }],
      }),
    );
    // 推送 listChanged 通知客户端重新拉取工具列表
    server.sendToolListChanged();
    return {
      content: [{ type: 'text' as const, text: `added ${name}` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
