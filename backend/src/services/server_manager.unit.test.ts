import { defaultCompatibilityOptions } from '@mcp-core/mcp-knot-protocol';
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithTraceContext, type TraceContext } from '../middleware/trace-context.js';
import { ServerStatus } from '../types/mcp-knot.js';
import { logger } from '../utils/logger.js';
import { ServerManager } from './server_manager.js';

import type { ServerConfig } from '@mcp-core/mcp-knot-share';

// Mock the MCP SDK
// 使用一个工厂函数来创建 mock Client，支持 vitest 4.x 的 new 调用
let _mockClientInstance: Record<string, ReturnType<typeof vi.fn>> | null = null;

vi.mock('@modelcontextprotocol/client', () => {
  return {
    Client: vi.fn(function (this: Record<string, unknown>) {
      Object.assign(this, _mockClientInstance);
    }),
    SSEClientTransport: vi.fn(function (this: Record<string, unknown>) {}),
    StreamableHTTPClientTransport: vi.fn(function (this: Record<string, unknown>) {}),
    // createServerAuthProvider 的 oauth 分支会 new ClientCredentialsProvider；
    // mock 成空构造避免真实 OAuth 流程（断言只关心 transport 收到 authProvider 对象）。
    ClientCredentialsProvider: vi.fn(function (this: Record<string, unknown>, opts: unknown) {
      this.opts = opts;
    }),
  };
});
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function (this: Record<string, unknown>) {}),
}));
vi.mock('../utils/logger.js');

const MockClient = vi.mocked(Client);
const MockStreamableTransport = vi.mocked(StreamableHTTPClientTransport);
const MockSseTransport = vi.mocked(SSEClientTransport);
const MockStdioTransport = vi.mocked(StdioClientTransport);

describe('ServerManager', () => {
  let serverManager: ServerManager;
  let mockServerConfigs: Record<string, ServerConfig>;
  let mockClient: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock client
    mockClient = {
      connect: vi.fn(),
      close: vi.fn(),
      listTools: vi.fn(),
      callTool: vi.fn(),
      setNotificationHandler: vi.fn(),
    };

    // 设置全局 mockClient 实例，供 vi.mock 工厂中的构造函数使用
    _mockClientInstance = mockClient;

    // Setup test server configurations
    mockServerConfigs = {
      'test-server-1': {
        type: 'stdio',
        command: 'node',
        args: ['test-server.js'],
        enabled: true,
        env: { TEST_VAR: 'test-value' },
      },
      'test-server-2': {
        type: 'stdio',
        command: 'python',
        args: ['test-server.py'],
        enabled: true,
      },
      'disabled-server': {
        type: 'stdio',
        command: 'node',
        args: ['disabled.js'],
        enabled: false,
      },
    };

    serverManager = new ServerManager(mockServerConfigs);
  });

  afterEach(async () => {
    // 等待所有异步操作完成
    await new Promise((resolve) => setTimeout(resolve, 5));

    try {
      await serverManager.shutdown();
      // 等待所有子进程和连接真正关闭
      await new Promise((resolve) => setTimeout(resolve, 5));
    } catch (_error) {
      // Ignore shutdown errors in tests
    }

    // 清除 mocks
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('modernOnly rejects a negotiated legacy upstream and closes its client', async () => {
    mockClient.getProtocolEra = vi.fn().mockReturnValue('legacy');
    serverManager = new ServerManager(
      { one: mockServerConfigs['test-server-1']! },
      {
        compatibility: {
          ...defaultCompatibilityOptions,
          outbound: { ...defaultCompatibilityOptions.outbound, modernOnly: true },
        },
      },
    );
    await serverManager.initialize();
    expect(serverManager.getServerStatus('one')).toBe(ServerStatus.ERROR);
    expect(mockClient.close).toHaveBeenCalledOnce();
    expect(mockClient.listTools).not.toHaveBeenCalled();
    expect(MockClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      }),
    );
  });

  describe('constructor', () => {
    it('should handle empty configuration', () => {
      const emptyManager = new ServerManager({});
      expect(emptyManager.getAllServers().size).toBe(0);
    });
  });

  describe('上游 era 探测（P7 probeUpstreamEra）', () => {
    async function initSingleServer() {
      const manager = new ServerManager({
        one: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      return manager;
    }

    it('getProtocolEra 返回 modern 时记录 era=modern 并记 connected 日志', async () => {
      mockClient.getProtocolEra = vi.fn().mockReturnValue('modern');
      const manager = await initSingleServer();

      const server = manager.getAllServers().get('one');
      expect(server?.status).toBe(ServerStatus.CONNECTED);
      expect(server?.era).toBe('modern');
      expect(vi.mocked(logger.logServerConnection)).toHaveBeenCalledWith('one', 'connected');
      await manager.shutdown();
    });

    it('getProtocolEra 返回 legacy 时（默认兼容）记录 era=legacy 且连接成功', async () => {
      mockClient.getProtocolEra = vi.fn().mockReturnValue('legacy');
      const manager = await initSingleServer();

      const server = manager.getAllServers().get('one');
      expect(server?.status).toBe(ServerStatus.CONNECTED);
      expect(server?.era).toBe('legacy');
      expect(mockClient.listTools).toHaveBeenCalled();
      await manager.shutdown();
    });

    it('getProtocolEra 返回 undefined 时按 modern 假设并记 warn 日志', async () => {
      mockClient.getProtocolEra = vi.fn().mockReturnValue(undefined);
      const manager = await initSingleServer();

      const server = manager.getAllServers().get('one');
      expect(server?.era).toBe('modern');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        '上游 era 探测返回 undefined，按 modern 假设处理（P7 MVP 占位）',
        { serverId: 'one' },
      );
      await manager.shutdown();
    });

    it('getProtocolEra 抛错时 fail-open 为 modern 并记 warn 日志', async () => {
      mockClient.getProtocolEra = vi.fn().mockImplementation(() => {
        throw new Error('era probe crashed');
      });
      const manager = await initSingleServer();

      const server = manager.getAllServers().get('one');
      expect(server?.status).toBe(ServerStatus.CONNECTED);
      expect(server?.era).toBe('modern');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('探测上游 era 失败，按 modern 假设处理', {
        serverId: 'one',
        error: 'era probe crashed',
      });
      await manager.shutdown();
    });
  });

  describe('versionNegotiation 模式（兼容配置）', () => {
    it('outbound.enabled=false 时固定 pin 到 modern 协议', async () => {
      const manager = new ServerManager(
        { one: { type: 'stdio', command: 'node', args: [], enabled: true } },
        {
          compatibility: {
            ...defaultCompatibilityOptions,
            outbound: { ...defaultCompatibilityOptions.outbound, enabled: false },
          },
        },
      );
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();

      expect(MockClient).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          versionNegotiation: { mode: { pin: '2026-07-28' } },
        }),
      );
      await manager.shutdown();
    });

    it('默认兼容配置时 versionNegotiation 使用 auto 模式', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await serverManager.initialize();

      expect(MockClient).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          versionNegotiation: { mode: 'auto' },
        }),
      );
    });
  });

  describe('initialize', () => {
    it('should initialize enabled servers successfully', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      expect(servers.size).toBe(2); // Only enabled servers
      expect(servers.has('test-server-1')).toBe(true);
      expect(servers.has('test-server-2')).toBe(true);
      expect(servers.has('disabled-server')).toBe(false);
    });

    it('should skip disabled servers', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      expect(servers.has('disabled-server')).toBe(false);
    });

    it('should handle server connection failures gracefully', async () => {
      mockClient.connect
        .mockResolvedValueOnce(undefined) // First server succeeds
        .mockRejectedValueOnce(new Error('Connection failed')); // Second server fails

      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      expect(servers.size).toBe(2);

      const server1 = servers.get('test-server-1');
      const server2 = servers.get('test-server-2');

      expect(server1?.status).toBe(ServerStatus.CONNECTED);
      expect(server2?.status).toBe(ServerStatus.ERROR);
      expect(server2?.lastError?.message).toBe('Connection failed');
    });

    it('初始化完成日志精确记录 totalServers 与 connectedServers', async () => {
      mockClient.connect
        .mockResolvedValueOnce(undefined) // First server succeeds
        .mockRejectedValueOnce(new Error('Connection failed')); // Second server fails

      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'ServerManager initialization completed',
        {
          totalServers: 3,
          connectedServers: 1,
        },
      );
    });

    it('should discover tools after successful connection', async () => {
      const mockTools = [
        { name: 'tool1', description: 'Test tool 1', inputSchema: {} },
        { name: 'tool2', description: 'Test tool 2', inputSchema: {} },
      ];

      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: mockTools });

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');

      expect(server?.tools).toHaveLength(2);
      expect(server?.tools[0].name).toBe('tool1');
      expect(server?.tools[0].serverId).toBe('test-server-1');
    });

    it('should handle tool discovery failures', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockRejectedValue(new Error('Tool discovery failed'));

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');

      expect(server?.status).toBe(ServerStatus.CONNECTED);
      expect(server?.tools).toHaveLength(0);
    });
  });

  describe('getServerStatus', () => {
    it('should return correct server status', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      expect(serverManager.getServerStatus('test-server-1')).toBe(ServerStatus.CONNECTED);
      expect(serverManager.getServerStatus('non-existent')).toBe(ServerStatus.DISCONNECTED);
    });
  });

  describe('executeToolOnServer', () => {
    beforeEach(async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await serverManager.initialize();
    });

    it('should execute tool successfully', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Success' }] };
      mockClient.callTool.mockResolvedValue(mockResult);

      const result = await serverManager.executeToolOnServer('test-server-1', 'test-tool', {
        arg1: 'value1',
      });

      expect(result).toEqual(mockResult);
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: 'test-tool',
        arguments: { arg1: 'value1' },
      });
    });

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

    it('should throw error for non-existent server', async () => {
      await expect(serverManager.executeToolOnServer('non-existent', 'tool', {})).rejects.toThrow(
        'Server non-existent not found',
      );
    });

    it('should throw error for disconnected server', async () => {
      // Manually set server status to disconnected
      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');
      if (server) {
        server.status = ServerStatus.DISCONNECTED;
      }

      await expect(serverManager.executeToolOnServer('test-server-1', 'tool', {})).rejects.toThrow(
        'Server test-server-1 is not connected',
      );
    });

    it('should handle tool execution failures', async () => {
      mockClient.callTool.mockRejectedValue(new Error('Tool execution failed'));

      await expect(
        serverManager.executeToolOnServer('test-server-1', 'test-tool', {}),
      ).rejects.toThrow('Tool execution failed');
    });
  });

  describe('executeToolOnServerWithContext (P5 MRTR)', () => {
    beforeEach(async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await serverManager.initialize();
    });

    it('把 retryContext 透传给 callTool params 顶层（inputResponses + requestState）', async () => {
      const mockResult = { content: [{ type: 'text', text: 'resumed' }] };
      mockClient.callTool.mockResolvedValue(mockResult);

      const result = await serverManager.executeToolOnServerWithContext(
        'test-server-1',
        'test-tool',
        { arg1: 'value1' },
        { inputResponses: { confirm: true }, requestState: 'upstream-opaque-state' },
      );

      expect(result).toEqual(mockResult);
      // 关键：重试字段是 callTool params 的顶层成员（与 name/arguments 平级），
      // 而非 _meta。第二参 options 携带 P5 MRTR 的 allowInputRequired（让上游
      // input_required 交回 Hub 中转，而非被 auto-fulfil 吞掉）。
      expect(mockClient.callTool).toHaveBeenCalledWith(
        {
          name: 'test-tool',
          arguments: { arg1: 'value1' },
          inputResponses: { confirm: true },
          requestState: 'upstream-opaque-state',
        },
        { allowInputRequired: true },
      );
    });

    it('仅传 requestState（无 inputResponses）时 params 只含 requestState', async () => {
      mockClient.callTool.mockResolvedValue({ content: [] });

      await serverManager.executeToolOnServerWithContext(
        'test-server-1',
        'test-tool',
        {},
        { requestState: 'opaque' },
      );

      expect(mockClient.callTool).toHaveBeenCalledWith(
        {
          name: 'test-tool',
          arguments: {},
          requestState: 'opaque',
        },
        { allowInputRequired: true },
      );
    });

    it('ALS 有 trace context 时 _meta 与重试字段共存（_meta 不吃掉 requestState）', async () => {
      mockClient.callTool.mockResolvedValue({ content: [] });
      const ctx: TraceContext = {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
        tracestate: 'congo=t61rcWkgMzE',
        baggage: 'userId=am9',
      };

      await runWithTraceContext(ctx, () =>
        serverManager.executeToolOnServerWithContext(
          'test-server-1',
          'test-tool',
          { arg1: 'value1' },
          { inputResponses: { confirm: true }, requestState: 'opaque' },
        ),
      );

      expect(mockClient.callTool).toHaveBeenCalledWith(
        {
          name: 'test-tool',
          arguments: { arg1: 'value1' },
          inputResponses: { confirm: true },
          requestState: 'opaque',
          _meta: {
            traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01',
            tracestate: 'congo=t61rcWkgMzE',
            baggage: 'userId=am9',
          },
        },
        { allowInputRequired: true },
      );
    });

    it('ALS 无 trace context 且无重试字段时，params 与 executeToolOnServer 一致', async () => {
      mockClient.callTool.mockResolvedValue({ content: [] });

      await serverManager.executeToolOnServerWithContext(
        'test-server-1',
        'test-tool',
        { a: 1 },
        {},
      );

      expect(mockClient.callTool).toHaveBeenCalledWith(
        {
          name: 'test-tool',
          arguments: { a: 1 },
        },
        { allowInputRequired: true },
      );
    });

    it('仅传 inputResponses（无 requestState）时 params 只含 inputResponses', async () => {
      mockClient.callTool.mockResolvedValue({ content: [] });

      await serverManager.executeToolOnServerWithContext(
        'test-server-1',
        'test-tool',
        { a: 1 },
        { inputResponses: { confirm: true } },
      );

      expect(mockClient.callTool).toHaveBeenCalledWith(
        {
          name: 'test-tool',
          arguments: { a: 1 },
          inputResponses: { confirm: true },
        },
        { allowInputRequired: true },
      );
    });

    it('messageTracker 请求对象按需携带重试上下文字段', async () => {
      const tracker = vi.fn();
      serverManager.setMessageTracker(tracker);
      mockClient.callTool.mockResolvedValue({ content: [] });

      await serverManager.executeToolOnServerWithContext(
        'test-server-1',
        'test-tool',
        {},
        { inputResponses: { confirm: true } },
      );

      expect(tracker).toHaveBeenNthCalledWith(1, 'test-server-1', 'request', 'callTool', {
        name: 'test-tool',
        arguments: {},
        inputResponses: { confirm: true },
      });
    });

    it('legacy era 上游剥离 MRTR 重试字段（仅透传 name/arguments）', async () => {
      mockClient.getProtocolEra = vi.fn().mockReturnValue('legacy');
      const manager = new ServerManager({
        legacy1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      expect(manager.getAllServers().get('legacy1')?.era).toBe('legacy');

      mockClient.callTool.mockResolvedValue({ content: [] });
      await manager.executeToolOnServerWithContext(
        'legacy1',
        'test-tool',
        { a: 1 },
        { inputResponses: { confirm: true }, requestState: 'opaque' },
      );

      expect(mockClient.callTool).toHaveBeenCalledWith(
        {
          name: 'test-tool',
          arguments: { a: 1 },
        },
        { allowInputRequired: true },
      );
      await manager.shutdown();
    });

    it('should throw error for non-existent server', async () => {
      await expect(
        serverManager.executeToolOnServerWithContext(
          'non-existent',
          'tool',
          {},
          { requestState: 's' },
        ),
      ).rejects.toThrow('Server non-existent not found');
    });

    it('should throw error for disconnected server', async () => {
      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');
      if (server) {
        server.status = ServerStatus.DISCONNECTED;
      }

      await expect(
        serverManager.executeToolOnServerWithContext(
          'test-server-1',
          'tool',
          {},
          { requestState: 's' },
        ),
      ).rejects.toThrow('Server test-server-1 is not connected');
    });

    it('should propagate upstream callTool failures', async () => {
      mockClient.callTool.mockRejectedValue(new Error('Upstream tool failed'));

      await expect(
        serverManager.executeToolOnServerWithContext(
          'test-server-1',
          'test-tool',
          {},
          { requestState: 's' },
        ),
      ).rejects.toThrow('Upstream tool failed');
    });
  });

  describe('getServerTools', () => {
    beforeEach(async () => {
      const mockTools = [{ name: 'tool1', description: 'Test tool 1', inputSchema: {} }];

      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: mockTools });
      await serverManager.initialize();
    });

    it('should return tools for connected server', async () => {
      const tools = await serverManager.getServerTools('test-server-1');

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('tool1');
      expect(tools[0].serverId).toBe('test-server-1');
    });

    it('should throw error for non-existent server', async () => {
      await expect(serverManager.getServerTools('non-existent')).rejects.toThrow(
        'Server non-existent not found',
      );
    });

    it('should return empty array for disconnected server', async () => {
      // Manually set server status to disconnected
      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');
      if (server) {
        server.status = ServerStatus.DISCONNECTED;
      }

      const tools = await serverManager.getServerTools('test-server-1');
      expect(tools).toHaveLength(0);
    });
  });

  describe('stdio transport 构造参数', () => {
    it('transport 收到 command、args 与合并后的 env（process.env + config.env）', async () => {
      process.env.MCP_UNIT_TEST_ENV = 'from-process';
      try {
        const manager = new ServerManager({
          s1: {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            enabled: true,
            env: { TEST_VAR: 'test-value' },
          },
        });
        mockClient.connect.mockResolvedValue(undefined);
        mockClient.listTools.mockResolvedValue({ tools: [] });

        await manager.initialize();

        expect(MockStdioTransport).toHaveBeenCalledTimes(1);
        const [ctorArg] = MockStdioTransport.mock.calls[0];
        expect(ctorArg?.command).toBe('node');
        expect(ctorArg?.args).toEqual(['server.js']);
        expect(ctorArg?.env).toMatchObject({
          TEST_VAR: 'test-value',
          MCP_UNIT_TEST_ENV: 'from-process',
        });
        await manager.shutdown();
      } finally {
        delete process.env.MCP_UNIT_TEST_ENV;
      }
    });

    it('config 未提供 args 时 transport 收到空数组', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'echo', enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      const [ctorArg] = MockStdioTransport.mock.calls[0];
      expect(ctorArg?.args).toEqual([]);
      await manager.shutdown();
    });
  });

  describe('messageTracker 消息追踪', () => {
    it('工具发现成功时按序记录 request 与 response（含 executionTime/toolCount）', async () => {
      const tracker = vi.fn();
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      manager.setMessageTracker(tracker);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({
        tools: [{ name: 't1', description: 'd', inputSchema: {} }],
      });

      await manager.initialize();

      expect(tracker).toHaveBeenNthCalledWith(1, 's1', 'request', 'listTools', {});
      expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'listTools', {
        tools: [{ name: 't1', description: 'd', inputSchema: {} }],
        executionTime: expect.any(Number),
        toolCount: 1,
      });
      await manager.shutdown();
    });

    it('工具发现的耗时精确为 listTools 的执行时间', async () => {
      vi.useFakeTimers();
      const tracker = vi.fn();
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      manager.setMessageTracker(tracker);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockImplementation(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        return { tools: [] };
      });

      const initPromise = manager.initialize();
      await vi.advanceTimersByTimeAsync(100);
      await initPromise;

      expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'listTools', {
        tools: [],
        executionTime: 100,
        toolCount: 0,
      });
      vi.useRealTimers();
      await manager.shutdown();
    });

    it('工具发现失败时记录 isError 的 response', async () => {
      const tracker = vi.fn();
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      manager.setMessageTracker(tracker);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockRejectedValue(new Error('discovery boom'));

      await manager.initialize();

      expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'listTools', {
        error: 'discovery boom',
        isError: true,
      });
      await manager.shutdown();
    });

    it('executeToolOnServer 成功时记录 callTool 的 request 与 response', async () => {
      const tracker = vi.fn();
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      manager.setMessageTracker(tracker);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      tracker.mockClear();

      const mockResult = { content: [{ type: 'text', text: 'ok' }] };
      mockClient.callTool.mockResolvedValue(mockResult);
      await manager.executeToolOnServer('s1', 't1', { a: 1 });

      expect(tracker).toHaveBeenNthCalledWith(1, 's1', 'request', 'callTool', {
        name: 't1',
        arguments: { a: 1 },
      });
      expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'callTool', {
        ...mockResult,
        executionTime: expect.any(Number),
      });
      await manager.shutdown();
    });

    it('executeToolOnServer 失败时记录 isError 的 response 并向上抛错', async () => {
      const tracker = vi.fn();
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      manager.setMessageTracker(tracker);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      tracker.mockClear();

      mockClient.callTool.mockRejectedValue(new Error('call boom'));
      await expect(manager.executeToolOnServer('s1', 't1', {})).rejects.toThrow('call boom');

      expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'callTool', {
        error: 'call boom',
        isError: true,
      });
      await manager.shutdown();
    });
  });

  describe('refetchServerTools（P5 变更检测）', () => {
    it('server 不存在时返回空数组', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await serverManager.initialize();

      await expect(serverManager.refetchServerTools('non-existent')).resolves.toEqual([]);
    });

    it('server 非连接状态时返回空数组', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await serverManager.initialize();

      const server = serverManager.getAllServers().get('test-server-1');
      if (server) {
        server.status = ServerStatus.DISCONNECTED;
      }

      await expect(serverManager.refetchServerTools('test-server-1')).resolves.toEqual([]);
      expect(mockClient.listTools).toHaveBeenCalledTimes(2); // 仅 initialize 时发现一次/每 server
    });

    it('重新拉取后更新缓存、返回最新工具并推进快照', async () => {
      const detector = { saveSnapshot: vi.fn(), onUpstreamNotification: vi.fn() };
      const manager = new ServerManager(
        { s1: { type: 'stdio', command: 'node', args: [], enabled: true } },
        { changeDetector: detector },
      );
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools
        .mockResolvedValueOnce({ tools: [{ name: 't1', inputSchema: {} }] })
        .mockResolvedValueOnce({
          tools: [
            { name: 't1', description: 'd1', inputSchema: {} },
            { name: 't2', description: 'd2', inputSchema: {} },
          ],
        });
      await manager.initialize();

      const tools = await manager.refetchServerTools('s1');

      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ name: 't1', serverId: 's1' });
      expect(manager.getAllServers().get('s1')?.tools).toHaveLength(2);
      expect(detector.saveSnapshot).toHaveBeenLastCalledWith('s1', [
        { name: 't1' },
        { name: 't2' },
      ]);
      await manager.shutdown();
    });

    it('重新拉取失败时保留旧缓存并返回旧工具', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools
        .mockResolvedValueOnce({ tools: [{ name: 'old-tool', inputSchema: {} }] })
        .mockRejectedValueOnce(new Error('refetch boom'));
      await manager.initialize();

      const tools = await manager.refetchServerTools('s1');

      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('old-tool');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'refetchServerTools 失败（保留旧缓存）',
        expect.objectContaining({ serverId: 's1', error: 'refetch boom' }),
      );
      await manager.shutdown();
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await serverManager.initialize();
    });

    it('should close all connected servers', async () => {
      mockClient.close.mockResolvedValue(undefined);

      await serverManager.shutdown();

      expect(mockClient.close).toHaveBeenCalledTimes(2); // Two enabled servers
      expect(serverManager.getAllServers().size).toBe(0);
    });

    it('should handle server close failures gracefully', async () => {
      mockClient.close.mockRejectedValue(new Error('Close failed'));

      // Should not throw
      await expect(serverManager.shutdown()).resolves.not.toThrow();
      expect(serverManager.getAllServers().size).toBe(0);
    });

    it('非 timeout 的关闭失败不触发强制 kill', async () => {
      const kill = vi.fn();
      (mockClient as Record<string, unknown>).transport = { process: { kill, pid: 111 } };
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockRejectedValue(new Error('Close failed'));

      await manager.shutdown();

      expect(kill).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error during server shutdown',
        expect.any(Error),
        expect.objectContaining({ serverId: 's1' }),
      );
    });

    it('关闭超时（5s）时强制 SIGKILL 子进程并记录日志', async () => {
      vi.useFakeTimers();
      const kill = vi.fn();
      (mockClient as Record<string, unknown>).transport = { process: { kill, pid: 4242 } };
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockReturnValue(new Promise(() => {}));

      try {
        const shutdownPromise = manager.shutdown();
        await vi.advanceTimersByTimeAsync(5000);
        await shutdownPromise;

        expect(kill).toHaveBeenCalledWith('SIGKILL');
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('已强制杀死服务器进程', {
          serverId: 's1',
          pid: 4242,
        });
      } finally {
        // 清除 pending 的 close 返回值，避免 afterEach 的 shutdown 真实等待超时
        mockClient.close.mockReset();
        vi.useRealTimers();
      }
    });

    it('错误消息含 timeout 字样时也触发强制 kill', async () => {
      const kill = vi.fn();
      (mockClient as Record<string, unknown>).transport = { process: { kill, pid: 222 } };
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockRejectedValue(new Error('close timeout exceeded'));

      await manager.shutdown();

      expect(kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('关闭超时但无法访问子进程时记录无法终止警告', async () => {
      const kill = vi.fn();
      (mockClient as Record<string, unknown>).transport = {}; // 无 process
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockRejectedValue(new Error('close timeout exceeded'));

      await manager.shutdown();

      expect(kill).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('无法访问服务器进程，可能已经终止', {
        serverId: 's1',
      });
    });

    it('强制 kill 本身抛错时记录强制终止失败日志', async () => {
      (mockClient as Record<string, unknown>).transport = {
        process: {
          kill: vi.fn(() => {
            throw new Error('kill rejected');
          }),
          pid: 333,
        },
      };
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockRejectedValue(new Error('close timeout exceeded'));

      await manager.shutdown();

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        '强制终止进程失败',
        expect.any(Error),
        expect.objectContaining({ serverId: 's1' }),
      );
    });

    it('仅关闭处于连接状态的 server', async () => {
      mockClient.connect
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Connection failed'));
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await serverManager.initialize(); // server1 connected, server2 error

      mockClient.close.mockResolvedValue(undefined);
      await serverManager.shutdown();

      // 只有 CONNECTED 的 test-server-1 被 close，ERROR 的 test-server-2 跳过
      expect(mockClient.close).toHaveBeenCalledTimes(1);
    });

    it('should handle shutdown when no servers are initialized', async () => {
      const emptyManager = new ServerManager({});
      await expect(emptyManager.shutdown()).resolves.not.toThrow();
    });
  });

  describe('server lifecycle and health monitoring', () => {
    it('should track connection timestamps', async () => {
      const beforeConnect = new Date();

      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');

      expect(server?.lastConnected).toBeInstanceOf(Date);
      expect(server?.lastConnected?.getTime()).toBeGreaterThanOrEqual(beforeConnect.getTime());
    });

    it('should reset reconnect attempts on successful connection', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');

      expect(server?.reconnectAttempts).toBe(0);
    });

    it('should handle environment variables in server configuration', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      // Verify that the client was created (environment variables are passed to transport)
      expect(MockClient).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'mcp-knot-test-server-1',
          version: '1.0.0',
        }),
        expect.objectContaining({
          // P5 MRTR：上游客户端声明交互能力（中转承诺），autoFulfill:false 让
          // input_required 透传回 Hub 中转而非被就地 fulfil。详见 server_manager.ts。
          capabilities: { elicitation: {}, sampling: {}, roots: {} },
          inputRequired: { autoFulfill: false },
        }),
      );
    });
  });

  describe('SSE server connections', () => {
    it('should connect to SSE server successfully', async () => {
      const sseConfig: Record<string, ServerConfig> = {
        'sse-server': {
          type: 'sse',
          url: 'http://localhost:8080/sse',
          headers: { Authorization: 'Bearer test-token' },
          enabled: true,
        },
      };

      const sseManager = new ServerManager(sseConfig);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await sseManager.initialize();

      const servers = sseManager.getAllServers();
      const server = servers.get('sse-server');

      expect(server?.status).toBe(ServerStatus.CONNECTED);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);

      // transport 收到 URL 与 headers（config.headers 展开）
      expect(MockSseTransport).toHaveBeenCalledTimes(1);
      const [sseUrl, sseOptions] = MockSseTransport.mock.calls[0];
      expect(sseUrl).toBeInstanceOf(URL);
      expect((sseUrl as URL).href).toBe('http://localhost:8080/sse');
      expect(sseOptions?.requestInit).toMatchObject({
        headers: { Authorization: 'Bearer test-token' },
      });

      await sseManager.shutdown();
    });

    it('should handle SSE server connection failure', async () => {
      const sseConfig: Record<string, ServerConfig> = {
        'sse-fail': {
          type: 'sse',
          url: 'http://localhost:9999/sse',
          enabled: true,
        },
      };

      const sseManager = new ServerManager(sseConfig);
      mockClient.connect.mockRejectedValue(new Error('SSE connection refused'));

      await sseManager.initialize();

      const servers = sseManager.getAllServers();
      const server = servers.get('sse-fail');

      expect(server?.status).toBe(ServerStatus.ERROR);
      expect(server?.lastError?.message).toBe('SSE connection refused');

      await sseManager.shutdown();
    });

    it('should discover tools from SSE server', async () => {
      const sseConfig: Record<string, ServerConfig> = {
        'sse-tools': {
          type: 'sse',
          url: 'http://localhost:8080/sse',
          enabled: true,
        },
      };

      const mockTools = [{ name: 'sse-tool', description: 'SSE tool', inputSchema: {} }];

      const sseManager = new ServerManager(sseConfig);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: mockTools });

      await sseManager.initialize();

      const servers = sseManager.getAllServers();
      const server = servers.get('sse-tools');

      expect(server?.tools).toHaveLength(1);
      expect(server?.tools[0].name).toBe('sse-tool');
      expect(server?.tools[0].serverId).toBe('sse-tools');

      await sseManager.shutdown();
    });
  });

  describe('Streaming (Streamable HTTP) server connections', () => {
    it('should connect to streaming server successfully', async () => {
      const streamingConfig: Record<string, ServerConfig> = {
        'streaming-server': {
          type: 'streaming',
          url: 'https://mcp.example.com/mcp',
          headers: { 'X-API-Key': 'test-key' },
          enabled: true,
        },
      };

      const streamingManager = new ServerManager(streamingConfig);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await streamingManager.initialize();

      const servers = streamingManager.getAllServers();
      const server = servers.get('streaming-server');

      expect(server?.status).toBe(ServerStatus.CONNECTED);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);

      // transport 收到 URL 与 headers（config.headers 展开）
      expect(MockStreamableTransport).toHaveBeenCalledTimes(1);
      const [streamUrl, streamOptions] = MockStreamableTransport.mock.calls[0];
      expect(streamUrl).toBeInstanceOf(URL);
      expect((streamUrl as URL).href).toBe('https://mcp.example.com/mcp');
      expect(streamOptions?.requestInit).toMatchObject({
        headers: { 'X-API-Key': 'test-key' },
      });

      await streamingManager.shutdown();
    });

    it('should handle streaming server connection failure', async () => {
      const streamingConfig: Record<string, ServerConfig> = {
        'streaming-fail': {
          type: 'streaming',
          url: 'https://mcp.example.com/mcp',
          enabled: true,
        },
      };

      const streamingManager = new ServerManager(streamingConfig);
      mockClient.connect.mockRejectedValue(new Error('Streaming connection failed'));

      await streamingManager.initialize();

      const servers = streamingManager.getAllServers();
      const server = servers.get('streaming-fail');

      expect(server?.status).toBe(ServerStatus.ERROR);
      expect(server?.lastError?.message).toBe('Streaming connection failed');

      await streamingManager.shutdown();
    });

    it('should discover tools from streaming server', async () => {
      const streamingConfig: Record<string, ServerConfig> = {
        context7: {
          type: 'streaming',
          url: 'https://mcp.context7.com/mcp',
          enabled: true,
        },
      };

      const mockTools = [
        {
          name: 'resolve-library-id',
          description: 'Resolve library ID',
          inputSchema: {},
        },
        {
          name: 'get-library-docs',
          description: 'Get library docs',
          inputSchema: {},
        },
      ];

      const streamingManager = new ServerManager(streamingConfig);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: mockTools });

      await streamingManager.initialize();

      const servers = streamingManager.getAllServers();
      const server = servers.get('context7');

      expect(server?.tools).toHaveLength(2);
      expect(server?.tools[0].name).toBe('resolve-library-id');
      expect(server?.tools[1].name).toBe('get-library-docs');

      await streamingManager.shutdown();
    });

    it('should execute tools on streaming server', async () => {
      const streamingConfig: Record<string, ServerConfig> = {
        'streaming-server': {
          type: 'streaming',
          url: 'https://mcp.example.com/mcp',
          enabled: true,
        },
      };

      const streamingManager = new ServerManager(streamingConfig);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await streamingManager.initialize();

      const mockResult = { content: [{ type: 'text', text: 'docs result' }] };
      mockClient.callTool.mockResolvedValue(mockResult);

      const result = await streamingManager.executeToolOnServer(
        'streaming-server',
        'get-library-docs',
        { query: 'react' },
      );

      expect(result).toEqual(mockResult);
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: 'get-library-docs',
        arguments: { query: 'react' },
      });

      await streamingManager.shutdown();
    });
  });

  describe('SSE/Streamable 连接的 authProvider', () => {
    afterEach(() => {
      delete process.env.TEST_OAUTH_SECRET;
    });

    it('带 oauth auth 的 streaming server：transport 收到 authProvider（非 undefined）', async () => {
      process.env.TEST_OAUTH_SECRET = 'secret-val';
      const config: Record<string, ServerConfig> = {
        'auth-server': {
          type: 'streaming',
          url: 'https://example.com/mcp',
          enabled: true,
          auth: {
            type: 'oauth',
            clientId: 'cid',
            clientSecret: '${TEST_OAUTH_SECRET}',
          },
        },
      };

      const manager = new ServerManager(config);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      expect(MockStreamableTransport).toHaveBeenCalledTimes(1);
      const [, options] = MockStreamableTransport.mock.calls[0];
      expect(options).toBeDefined();
      // authProvider 为真实 createServerAuthProvider 构造的对象（oauth 分支 = mock 的 ClientCredentialsProvider 实例）
      expect(options?.authProvider).toBeDefined();
      expect(options?.authProvider).not.toBeUndefined();

      await manager.shutdown();
    });

    it('无 auth 的 streaming server：transport 的 authProvider 为 undefined（回归）', async () => {
      const config: Record<string, ServerConfig> = {
        plain: {
          type: 'streaming',
          url: 'https://example.com/mcp',
          enabled: true,
        },
      };

      const manager = new ServerManager(config);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      expect(MockStreamableTransport).toHaveBeenCalledTimes(1);
      const [, options] = MockStreamableTransport.mock.calls[0];
      // 无 auth 时 authProvider=undefined，行为与改动前一致
      expect(options?.authProvider).toBeUndefined();

      await manager.shutdown();
    });
  });

  describe('mixed server types', () => {
    it('should initialize stdio, SSE, and streaming servers together', async () => {
      const mixedConfig: Record<string, ServerConfig> = {
        'stdio-server': {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          enabled: true,
        },
        'sse-server': {
          type: 'sse',
          url: 'http://localhost:8080/sse',
          enabled: true,
        },
        'streaming-server': {
          type: 'streaming',
          url: 'https://mcp.example.com/mcp',
          enabled: true,
        },
      };

      const mixedManager = new ServerManager(mixedConfig);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await mixedManager.initialize();

      const servers = mixedManager.getAllServers();
      expect(servers.size).toBe(3);

      for (const [, server] of servers) {
        expect(server.status).toBe(ServerStatus.CONNECTED);
      }

      await mixedManager.shutdown();
    });
  });

  describe('error handling and resilience', () => {
    it('should handle invalid server type', async () => {
      const invalidConfig = {
        'invalid-server': {
          type: 'invalid' as unknown as string,
          command: 'node',
          args: ['test.js'],
          enabled: true,
        },
      };

      const invalidManager = new ServerManager(invalidConfig);
      await invalidManager.initialize();

      const servers = invalidManager.getAllServers();
      const server = servers.get('invalid-server');

      expect(server?.status).toBe(ServerStatus.ERROR);
      expect(server?.lastError?.message).toContain('Unsupported server type');
    });

    it('should continue initialization even if some servers fail', async () => {
      mockClient.connect
        .mockRejectedValueOnce(new Error('Server 1 failed'))
        .mockResolvedValueOnce(undefined);

      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      expect(servers.size).toBe(2);

      const server1 = servers.get('test-server-1');
      const server2 = servers.get('test-server-2');

      expect(server1?.status).toBe(ServerStatus.ERROR);
      expect(server2?.status).toBe(ServerStatus.CONNECTED);
    });

    it('should handle transport creation failures', async () => {
      // 直接在 serverManager 内部模拟 transport 创建失败
      // 通过 mock connect 方法来模拟底层连接失败
      mockClient.connect.mockRejectedValueOnce(new Error('Transport creation failed'));

      await serverManager.initialize();

      const servers = serverManager.getAllServers();
      const server = servers.get('test-server-1');

      expect(server?.status).toBe(ServerStatus.ERROR);
      expect(server?.lastError?.message).toBe('Transport creation failed');
    });
  });

  describe('listChanged notification handler（P5）', () => {
    it('连接成功后注册 notifications/tools/list_changed handler', async () => {
      const detector = { saveSnapshot: vi.fn(), onUpstreamNotification: vi.fn() };
      const manager = new ServerManager(
        { s1: { type: 'stdio', command: 'echo', args: [], enabled: true } as any },
        { changeDetector: detector as any },
      );
      // mockClient 已在 beforeEach 配好（connect/listTools 返回成功）
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      expect(mockClient.setNotificationHandler).toHaveBeenCalledWith(
        'notifications/tools/list_changed',
        expect.any(Function),
      );
      await manager.shutdown();
    });

    it('listChanged 回调触发 detector.onUpstreamNotification', async () => {
      const detector = { saveSnapshot: vi.fn(), onUpstreamNotification: vi.fn() };
      const manager = new ServerManager(
        { s1: { type: 'stdio', command: 'echo', args: [], enabled: true } as any },
        { changeDetector: detector as any },
      );
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      // 取出注册的 handler 并调用
      const handler = mockClient.setNotificationHandler.mock.calls.find(
        (c) => c[0] === 'notifications/tools/list_changed',
      )?.[1];
      await handler?.({ method: 'notifications/tools/list_changed' });
      expect(detector.onUpstreamNotification).toHaveBeenCalledWith('s1');
      await manager.shutdown();
    });

    it('discoverServerTools 成功后调 detector.saveSnapshot', async () => {
      const detector = { saveSnapshot: vi.fn(), onUpstreamNotification: vi.fn() };
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [{ name: 't1' }, { name: 't2' }] });
      const manager = new ServerManager(
        { s1: { type: 'stdio', command: 'echo', args: [], enabled: true } as any },
        { changeDetector: detector as any },
      );
      await manager.initialize();
      expect(detector.saveSnapshot).toHaveBeenCalledWith('s1', [{ name: 't1' }, { name: 't2' }]);
      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // 变异测试第二轮补强：针对存活/无覆盖变异体的精确断言
  // ---------------------------------------------------------------------------
  describe('变异测试第二轮：日志与状态精确断言', () => {
    it('initialize 全连通时日志精确记录 serverCount/totalServers/connectedServers/跳过项', async () => {
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await serverManager.initialize();

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Initializing ServerManager', {
        serverCount: 3,
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'ServerManager initialization completed',
        {
          totalServers: 3,
          connectedServers: 2,
        },
      );
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Skipping disabled server', {
        serverId: 'disabled-server',
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Initializing server', {
        serverId: 'test-server-1',
        type: 'stdio',
      });
    });

    it('连接失败时记录初始化失败与 failed 连接日志，tools 保持初始空数组', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockRejectedValue(new Error('connect boom'));
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      const server = manager.getAllServers().get('s1');
      expect(server?.status).toBe(ServerStatus.ERROR);
      expect(server?.lastError?.message).toBe('connect boom');
      expect(server?.tools).toStrictEqual([]);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to initialize server',
        expect.any(Error),
        { serverId: 's1' },
      );
      expect(vi.mocked(logger.logServerConnection)).toHaveBeenCalledWith('s1', 'failed', {
        error: 'connect boom',
      });
      await manager.shutdown();
    });

    it('getProtocolEra 返回 modern 时不产生 warn 且完成日志精确记录 era', async () => {
      mockClient.getProtocolEra = vi.fn().mockReturnValue('modern');
      const manager = new ServerManager({
        one: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      expect(manager.getAllServers().get('one')?.era).toBe('modern');
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('上游 era 探测完成（P7）', {
        serverId: 'one',
        era: 'modern',
      });
      await manager.shutdown();
    });

    it('无 type 但有 command 的配置按 stdio 连接且不注册 listChanged handler', async () => {
      // 无 changeDetector：连接成功后也不应注册通知 handler
      const manager = new ServerManager({
        s1: { command: 'node', args: ['legacy.js'], enabled: true } as unknown as ServerConfig,
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      expect(manager.getServerStatus('s1')).toBe(ServerStatus.CONNECTED);
      expect(MockStdioTransport).toHaveBeenCalledTimes(1);
      expect(MockStdioTransport.mock.calls[0]?.[0]).toMatchObject({
        command: 'node',
        args: ['legacy.js'],
      });
      expect(mockClient.setNotificationHandler).not.toHaveBeenCalled();
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Server connecting', { serverId: 's1' });
      await manager.shutdown();
    });

    it('stdio 配置缺 command 时不被守卫拦截（transport 收到 command: undefined）', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', enabled: true } as unknown as ServerConfig,
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      expect(manager.getServerStatus('s1')).toBe(ServerStatus.CONNECTED);
      expect(MockStdioTransport).toHaveBeenCalledTimes(1);
      const ctorArg = MockStdioTransport.mock.calls[0]?.[0] as {
        command?: string;
        args?: string[];
      };
      expect(ctorArg?.command).toBeUndefined();
      expect(ctorArg?.args).toEqual([]);
      await manager.shutdown();
    });

    it('sse 配置缺 url 时抛 Invalid server config for SSE connection', async () => {
      const manager = new ServerManager({
        s1: { type: 'sse', enabled: true } as unknown as ServerConfig,
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      const server = manager.getAllServers().get('s1');
      expect(server?.status).toBe(ServerStatus.ERROR);
      expect(server?.lastError?.message).toBe('Invalid server config for SSE connection');
      await manager.shutdown();
    });

    it('streaming 配置缺 url 时抛 Invalid server config for streaming connection', async () => {
      const manager = new ServerManager({
        s1: { type: 'streaming', enabled: true } as unknown as ServerConfig,
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });

      await manager.initialize();

      const server = manager.getAllServers().get('s1');
      expect(server?.status).toBe(ServerStatus.ERROR);
      expect(server?.lastError?.message).toBe('Invalid server config for streaming connection');
      await manager.shutdown();
    });
  });

  describe('变异测试第二轮：发现工具与执行路径日志', () => {
    it('发现工具成功/失败时 logToolDiscovery 与 logger.error 精确记录', async () => {
      // 成功路径：2 个工具
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({
        tools: [
          { name: 'tool1', inputSchema: {} },
          { name: 'tool2', inputSchema: {} },
        ],
      });
      await manager.initialize();

      expect(vi.mocked(logger.logToolDiscovery)).toHaveBeenCalledWith('s1', 2);
      await manager.shutdown();

      // 失败路径：logger.error 精确入参
      const failManager = new ServerManager({
        s2: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockRejectedValue(new Error('discovery crash'));
      await failManager.initialize();

      expect(failManager.getServerStatus('s2')).toBe(ServerStatus.CONNECTED);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to discover tools for server',
        expect.any(Error),
        { serverId: 's2' },
      );
      await failManager.shutdown();
    });

    it('executeToolOnServer 成功路径 debug 日志精确记录', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();

      mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      await manager.executeToolOnServer('s1', 't1', { a: 1 });

      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Executing tool on server', {
        serverId: 's1',
        toolName: 't1',
        args: { a: 1 },
      });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool execution completed', {
        serverId: 's1',
        toolName: 't1',
        executionTime: expect.any(Number),
      });
      await manager.shutdown();
    });

    it('executeToolOnServer 失败路径 logger.error 精确记录', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();

      mockClient.callTool.mockRejectedValue(new Error('exec boom'));
      await expect(manager.executeToolOnServer('s1', 't1', {})).rejects.toThrow('exec boom');

      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool execution failed',
        expect.any(Error),
        { serverId: 's1', toolName: 't1' },
      );
      await manager.shutdown();
    });

    it('executeToolOnServer 执行耗时精确等于 callTool 耗时', async () => {
      const tracker = vi.fn();
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      manager.setMessageTracker(tracker);
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      tracker.mockClear();

      vi.useFakeTimers();
      try {
        mockClient.callTool.mockImplementation(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return { content: [] };
        });

        const execPromise = manager.executeToolOnServer('s1', 't1', { a: 1 });
        await vi.advanceTimersByTimeAsync(100);
        await execPromise;

        expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'callTool', {
          content: [],
          executionTime: 100,
        });
      } finally {
        mockClient.callTool.mockReset();
        vi.useRealTimers();
      }
      await manager.shutdown();
    });
  });

  describe('变异测试第二轮：executeToolOnServerWithContext 精确断言', () => {
    async function initManager() {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      return manager;
    }

    it('debug 日志精确记录重试上下文存在性（hasInputResponses/hasRequestState）', async () => {
      const manager = await initManager();
      mockClient.callTool.mockResolvedValue({ content: [] });

      // 两者皆有
      await manager.executeToolOnServerWithContext(
        's1',
        't1',
        { a: 1 },
        {
          inputResponses: { confirm: true },
          requestState: 'opaque',
        },
      );
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Executing tool on server (with retry context)',
        {
          serverId: 's1',
          toolName: 't1',
          args: { a: 1 },
          hasInputResponses: true,
          hasRequestState: true,
        },
      );

      // 两者皆无
      await manager.executeToolOnServerWithContext('s1', 't2', {}, {});
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Executing tool on server (with retry context)',
        {
          serverId: 's1',
          toolName: 't2',
          args: {},
          hasInputResponses: false,
          hasRequestState: false,
        },
      );
      await manager.shutdown();
    });

    it('messageTracker 请求对象在无重试字段时严格不含相关键（toStrictEqual）', async () => {
      const manager = await initManager();
      const tracker = vi.fn();
      manager.setMessageTracker(tracker);
      mockClient.callTool.mockResolvedValue({ content: [] });

      await manager.executeToolOnServerWithContext('s1', 't1', {}, {});

      expect(tracker).toHaveBeenNthCalledWith(1, 's1', 'request', 'callTool', {
        name: 't1',
        arguments: {},
      });
      // toStrictEqual：多出的 undefined 值键（inputResponses/requestState）也会判不等
      expect(tracker.mock.calls[0]?.[3]).toStrictEqual({ name: 't1', arguments: {} });
      await manager.shutdown();
    });

    it('messageTracker 请求对象仅携带 requestState 键', async () => {
      const manager = await initManager();
      const tracker = vi.fn();
      manager.setMessageTracker(tracker);
      mockClient.callTool.mockResolvedValue({ content: [] });

      await manager.executeToolOnServerWithContext('s1', 't1', {}, { requestState: 'opaque' });

      expect(tracker).toHaveBeenNthCalledWith(1, 's1', 'request', 'callTool', {
        name: 't1',
        arguments: {},
        requestState: 'opaque',
      });
      expect(tracker.mock.calls[0]?.[3]).toStrictEqual({
        name: 't1',
        arguments: {},
        requestState: 'opaque',
      });
      await manager.shutdown();
    });

    it('era 为 undefined 时按 modern 翻译（requestState 仍透传到上游）', async () => {
      const manager = await initManager();
      const server = manager.getAllServers().get('s1');
      if (server) {
        delete server.era;
      }
      mockClient.callTool.mockResolvedValue({ content: [] });

      await manager.executeToolOnServerWithContext('s1', 't1', {}, { requestState: 'opaque' });

      expect(mockClient.callTool).toHaveBeenCalledWith(
        { name: 't1', arguments: {}, requestState: 'opaque' },
        { allowInputRequired: true },
      );
      await manager.shutdown();
    });

    it('成功路径 tracker response 与完成 debug 日志精确记录', async () => {
      const manager = await initManager();
      const tracker = vi.fn();
      manager.setMessageTracker(tracker);
      const mockResult = { content: [{ type: 'text', text: 'ok' }] };
      mockClient.callTool.mockResolvedValue(mockResult);

      await manager.executeToolOnServerWithContext('s1', 't1', { a: 1 }, {});

      expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'callTool', {
        ...mockResult,
        executionTime: expect.any(Number),
      });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Tool execution (with retry context) completed',
        { serverId: 's1', toolName: 't1', executionTime: expect.any(Number) },
      );
      await manager.shutdown();
    });

    it('失败路径 logger.error 与 tracker isError response 精确记录', async () => {
      const manager = await initManager();
      const tracker = vi.fn();
      manager.setMessageTracker(tracker);
      mockClient.callTool.mockRejectedValue(new Error('ctx boom'));

      await expect(manager.executeToolOnServerWithContext('s1', 't1', {}, {})).rejects.toThrow(
        'ctx boom',
      );

      expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'callTool', {
        error: 'ctx boom',
        isError: true,
      });
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool execution (with retry context) failed',
        expect.any(Error),
        { serverId: 's1', toolName: 't1' },
      );
      await manager.shutdown();
    });

    it('执行耗时精确等于 callTool 耗时（with retry context）', async () => {
      const manager = await initManager();
      const tracker = vi.fn();
      manager.setMessageTracker(tracker);
      tracker.mockClear();

      vi.useFakeTimers();
      try {
        mockClient.callTool.mockImplementation(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return { content: [] };
        });

        const execPromise = manager.executeToolOnServerWithContext('s1', 't1', {}, {});
        await vi.advanceTimersByTimeAsync(100);
        await execPromise;

        expect(tracker).toHaveBeenNthCalledWith(2, 's1', 'response', 'callTool', {
          content: [],
          executionTime: 100,
        });
      } finally {
        mockClient.callTool.mockReset();
        vi.useRealTimers();
      }
      await manager.shutdown();
    });
  });

  describe('变异测试第二轮：refetch 与 shutdown 精确断言', () => {
    it('refetch 无 changeDetector 时正常推进缓存并记录 logToolDiscovery', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools
        .mockResolvedValueOnce({ tools: [{ name: 't1', inputSchema: {} }] })
        .mockResolvedValueOnce({
          tools: [
            { name: 't1', description: 'd1', inputSchema: {} },
            { name: 't2', description: 'd2', inputSchema: {} },
          ],
        });
      await manager.initialize();

      const tools = await manager.refetchServerTools('s1');

      expect(tools).toHaveLength(2);
      expect(manager.getAllServers().get('s1')?.tools).toHaveLength(2);
      expect(vi.mocked(logger.logToolDiscovery)).toHaveBeenCalledWith('s1', 2);
      // 无 changeDetector 时不因 saveSnapshot 报错走 catch 分支（缓存已先行更新，
      // 唯一可观测差异是误报的“保留旧缓存”warn）
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
        'refetchServerTools 失败（保留旧缓存）',
        expect.anything(),
      );
      await manager.shutdown();
    });

    it('shutdown 首尾日志精确记录', async () => {
      const emptyManager = new ServerManager({});
      await emptyManager.shutdown();

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Shutting down ServerManager');
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('ServerManager shutdown completed');
    });

    it('close 成功后记录 disconnected 日志并清理超时定时器', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockResolvedValue(undefined);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      try {
        await manager.shutdown();

        // 5s 超时保护定时器被真实调度，close 胜出后必须被清理
        const timeoutCallIdx = setTimeoutSpy.mock.calls.findIndex((c) => c[1] === 5000);
        expect(timeoutCallIdx).toBeGreaterThanOrEqual(0);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(
          setTimeoutSpy.mock.results[timeoutCallIdx]?.value,
        );
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
      expect(vi.mocked(logger.logServerConnection)).toHaveBeenCalledWith('s1', 'disconnected');
    });

    it('关闭超时时先记录尝试强制终止警告再 SIGKILL', async () => {
      const kill = vi.fn();
      (mockClient as Record<string, unknown>).transport = { process: { kill, pid: 555 } };
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockRejectedValue(new Error('close timeout exceeded'));

      await manager.shutdown();

      expect(kill).toHaveBeenCalledWith('SIGKILL');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('服务器关闭超时，尝试强制终止进程', {
        serverId: 's1',
      });
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('已强制杀死服务器进程', {
        serverId: 's1',
        pid: 555,
      });
    });

    it('定时器对象无 unref 方法时（非 Node 运行时）也能正常关闭', async () => {
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();

      // 在冻结全局 setTimeout 之前捕获真实引用：close 用真实定时器稍后 resolve，
      // 保证 Promise.race 的胜者是 close，而非（mutant 下同步 reject 的）超时 promise
      const realSetTimeout = globalThis.setTimeout;
      mockClient.close.mockImplementation(async () => {
        await new Promise((resolve) => {
          realSetTimeout(resolve, 10);
        });
      });

      // 模拟 setTimeout 返回的对象没有 unref 方法（浏览器等环境）
      const bareTimer = {} as unknown as NodeJS.Timeout;
      vi.stubGlobal(
        'setTimeout',
        vi.fn(() => bareTimer),
      );
      vi.stubGlobal('clearTimeout', vi.fn());
      try {
        await manager.shutdown();
      } finally {
        vi.unstubAllGlobals();
      }

      expect(vi.mocked(logger.logServerConnection)).toHaveBeenCalledWith('s1', 'disconnected');
    });

    it('client 完全无 transport 属性时记录无法终止警告', async () => {
      const kill = vi.fn();
      (mockClient as Record<string, unknown>).transport = undefined;
      const manager = new ServerManager({
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
      });
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.listTools.mockResolvedValue({ tools: [] });
      await manager.initialize();
      mockClient.close.mockRejectedValue(new Error('close timeout exceeded'));

      await manager.shutdown();

      expect(kill).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('无法访问服务器进程，可能已经终止', {
        serverId: 's1',
      });
    });
  });
});
