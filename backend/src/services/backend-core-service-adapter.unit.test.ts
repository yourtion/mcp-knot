import { describe, expect, it, vi } from 'vitest';

import {
  runWithTraceContext,
  getCurrentTraceContext,
  type TraceContext,
} from '../middleware/trace-context.js';
import { BackendCoreServiceAdapter } from './backend-core-service-adapter.js';

import type { ServerConnection, ServerStatus, Tool } from '../types/mcp-knot.js';
import type { ServerManager } from './server_manager.js';
import type { McpServiceManagerInterface } from '@mcp-core/mcp-knot-core';

// 构造一个 mock ServerManager，仅 stub 适配器用到的方法
function makeMockServerManager(overrides: Partial<ServerManager> = {}): ServerManager {
  return {
    getAllServers: vi.fn(),
    getServerTools: vi.fn(),
    executeToolOnServer: vi.fn(),
    executeToolOnServerWithContext: vi.fn(),
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
    expect(all.map((t) => t.name).toSorted()).toEqual(['a_tool', 'b_tool']);
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

  it('getServiceStatus 只统计 connected（2 连接 + 1 断开 + 1 其他状态）', () => {
    const sm = makeMockServerManager({
      getAllServers: vi.fn().mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: 'connected' as ServerStatus } as ServerConnection],
          ['s2', { id: 's2', status: 'connected' as ServerStatus } as ServerConnection],
          ['s3', { id: 's3', status: 'disconnected' as ServerStatus } as ServerConnection],
          ['s4', { id: 's4', status: 'connecting' as ServerStatus } as ServerConnection],
        ]),
      ),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    const status = adapter.getServiceStatus();
    expect(status.serverCount).toBe(4);
    expect(status.connectedServers).toBe(2);
    expect(status.activeConnections).toBe(2);
    expect(status.initialized).toBe(true);
  });

  it('getServiceStatus 全部断开时 initialized 为 false', () => {
    const sm = makeMockServerManager({
      getAllServers: vi
        .fn()
        .mockReturnValue(
          new Map([
            ['s1', { id: 's1', status: 'disconnected' as ServerStatus } as ServerConnection],
          ]),
        ),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    const status = adapter.getServiceStatus();
    expect(status.initialized).toBe(false);
    expect(status.activeConnections).toBe(0);
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

  it('isToolAvailable 目标工具与其他工具混存时仍命中（some 语义）', async () => {
    const sm = makeMockServerManager({
      getServerTools: vi.fn().mockResolvedValue([
        { name: 'other-tool', inputSchema: {}, serverId: 's' },
        { name: 'find-me', inputSchema: {}, serverId: 's' },
      ]),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    // 多工具中只要存在即可用（every 语义会错判为 false）
    expect(await adapter.isToolAvailable('find-me', 's')).toBe(true);
  });

  it('initializeFromConfig / registerServer 委托 ServerManager；shutdown 为 no-op（不关闭借用的 ServerManager）', async () => {
    const sm = makeMockServerManager({
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    const adapter = new BackendCoreServiceAdapter(sm);
    await adapter.initializeFromConfig({ servers: {} } as never);
    await adapter.registerServer('s', { type: 'stdio', command: 'x' } as never);
    await adapter.shutdown();
    expect(sm.initialize).toHaveBeenCalled();
    // 适配器不拥有 ServerManager（hubService 才拥有），shutdown 必须为 no-op，
    // 否则 reloadCoreServiceManager（groups API 增删改）会断开全部真实上游连接。
    expect(sm.shutdown).not.toHaveBeenCalled();
  });

  // P6 端到端 trace 传播断言（Task 7 Step 4）：
  // 验证 group-service handler 的 trace context（Task 3 入站提取后写入 ALS）
  // 经适配器 → ServerManager.executeToolOnServer 时仍存活（ALS 上下文未断链）。
  // ServerManager 自身的 _meta 注入已在 server_manager.unit.test.ts（Task 2）验证，
  // 这里只断言"适配器不脱离 ALS scope"——即在 executeToolCall 执行期间，
  // getCurrentTraceContext() 仍能读到 handler 注入的 context。
  it('executeToolCall 在 ALS trace scope 内执行（trace context 不被适配器断链）', async () => {
    const ctx: TraceContext = {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
      tracestate: 'congo=t61rcWkgMzE',
      baggage: 'userId=am9',
    };
    let observed: TraceContext | undefined;
    const sm = makeMockServerManager({
      executeToolOnServer: vi.fn().mockImplementation(async () => {
        // 模拟 ServerManager 在执行 callTool 前读取 ALS（Task 2 出站注入点）
        observed = getCurrentTraceContext();
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    });
    const adapter = new BackendCoreServiceAdapter(sm);

    await runWithTraceContext(ctx, () => adapter.executeToolCall('tool', { x: 1 }, 'srv'));

    expect(observed).toEqual(ctx);
    expect(sm.executeToolOnServer).toHaveBeenCalledWith('srv', 'tool', { x: 1 });
  });

  // P5 Task 6：带重试上下文的工具调用路径（MRTR 多轮中转）。
  describe('executeToolCallWithContext（P5）', () => {
    it('把 retryContext 透传给 serverManager.executeToolOnServerWithContext', async () => {
      const mockServerManager = makeMockServerManager();
      mockServerManager.executeToolOnServerWithContext = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
      });
      const adapter = new BackendCoreServiceAdapter(mockServerManager as any);
      const retryContext = {
        inputResponses: { confirm: true },
        requestState: 'hub-state',
      };
      await adapter.executeToolCallWithContext('tool_a', { x: 1 }, 's1', retryContext);
      expect(mockServerManager.executeToolOnServerWithContext).toHaveBeenCalledWith(
        's1',
        'tool_a',
        { x: 1 },
        retryContext,
      );
    });

    it('无 serverId 时抛错（与 executeToolCall 一致，适配器不猜 server）', async () => {
      const adapter = new BackendCoreServiceAdapter(makeMockServerManager());
      await expect(
        adapter.executeToolCallWithContext('tool', {}, '', { requestState: 's' }),
      ).rejects.toThrow(/serverId/i);
    });

    it('透传上游 MCP 原生结果（含 content）', async () => {
      const mcpResult = { content: [{ type: 'text', text: 'upstream retry result' }] };
      const sm = makeMockServerManager({
        executeToolOnServerWithContext: vi.fn().mockResolvedValue(mcpResult),
      });
      const adapter = new BackendCoreServiceAdapter(sm);

      const result = await adapter.executeToolCallWithContext('my-tool', { q: 'x' }, 'srv-1', {
        requestState: 'opaque',
      });

      expect(sm.executeToolOnServerWithContext).toHaveBeenCalledWith(
        'srv-1',
        'my-tool',
        { q: 'x' },
        {
          requestState: 'opaque',
        },
      );
      expect(result).toEqual(mcpResult);
    });
  });
});
