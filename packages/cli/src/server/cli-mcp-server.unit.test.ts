/**
 * CLI MCP服务器单元测试
 */

import { UnifiedLogger } from '@mcp-core/mcp-knot-share';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliConfig } from '../types';
import type { CompatibilityOptions } from '@mcp-core/mcp-knot-protocol';
import type { z } from 'zod/v4';

/**
 * 用于访问 CliMcpServer 私有属性的接口
 */
interface CliMcpServerInternals {
  createServiceManager: () => unknown;
  registerTools: () => Promise<void>;
  protocolHandler: unknown;
  coreService: unknown;
  server: unknown;
}

// 创建 mock 实例
const mockServiceManager = {
  initializeFromConfig: vi.fn().mockResolvedValue(undefined),
  isToolAvailable: vi.fn().mockResolvedValue(true),
  getAllTools: vi.fn().mockResolvedValue([
    {
      name: 'test_tool',
      description: '测试工具',
      serverId: 'test_server',
    },
  ]),
  executeToolCall: vi.fn().mockResolvedValue({
    success: true,
    data: { result: 'test result' },
    executionTime: 100,
  }),
  getServiceStatus: vi.fn().mockReturnValue({
    initialized: true,
    serverCount: 1,
    activeConnections: 1,
  }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

// Mock 核心包
vi.mock('@mcp-core/mcp-knot-core', () => ({
  McpServiceManager: vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, mockServiceManager);
  }),
}));

// 创建 mock stdio handle 实例（serveStdio 的返回值）。
// 用 vi.hoisted 提前初始化，因为 vi.mock 工厂会被提升到文件顶部执行。
const mockStdioHandle = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
}));

// 创建 mock MCP server 实例
const mockMcpServer = {
  setRequestHandler: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  registerTool: vi.fn(),
};

// Mock MCP SDK
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, mockMcpServer);
  }),
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  // serveStdio: 工厂在连接建立时被调用，测试中不需要真实启动 stdio。
  serveStdio: vi.fn().mockReturnValue(mockStdioHandle),
}));

import { McpServiceManager } from '@mcp-core/mcp-knot-core';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// 导入要测试的类
import { CliMcpServer } from './cli-mcp-server';

describe('CliMcpServer', () => {
  let server: CliMcpServer;
  let mockConfig: CliConfig;

  beforeEach(() => {
    // 清除所有mock调用记录，但保留实现
    vi.clearAllMocks();

    // 重置 mock 函数的返回值
    mockServiceManager.getAllTools.mockResolvedValue([
      {
        name: 'test_tool',
        description: '测试工具',
        serverId: 'test_server',
      },
    ]);

    server = new CliMcpServer();

    const serverInternals = server as unknown as CliMcpServerInternals;

    // 直接 spy createServiceManager 方法
    vi.spyOn(serverInternals, 'createServiceManager').mockReturnValue(mockServiceManager);

    // Mock registerTools 方法以避免 registerTool 错误
    vi.spyOn(serverInternals, 'registerTools').mockResolvedValue(undefined);

    // 直接设置 server 属性以确保 mock 正确工作
    serverInternals.server = mockMcpServer;

    mockConfig = {
      servers: {
        test_server: {
          type: 'stdio',
          command: 'node',
          args: ['test.js'],
        },
      },
      logging: {
        level: 'info',
      },
      transport: {
        type: 'stdio',
      },
    };

    // 重置 mock 函数的返回值（在清除之后）
    mockServiceManager.getAllTools.mockResolvedValue([
      {
        name: 'test_tool',
        description: '测试工具',
        serverId: 'test_server',
      },
    ]);
  });

  afterEach(async () => {
    try {
      await server.shutdown();
    } catch {
      // 忽略关闭错误
    }
  });

  describe('initialize', () => {
    it('应该成功初始化CLI MCP服务器', async () => {
      await server.initialize(mockConfig);

      const status = server.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.config?.serverCount).toBe(1);
      expect(status.config?.loggingLevel).toBe('info');
    });
  });

  describe('start', () => {
    beforeEach(async () => {
      await server.initialize(mockConfig);
    });

    it('应该成功启动CLI MCP服务器', async () => {
      await server.start();

      const status = server.getStatus();
      expect(status.started).toBe(true);
    });

    it('应该在未初始化时抛出错误', async () => {
      const uninitializedServer = new CliMcpServer();

      await expect(uninitializedServer.start()).rejects.toThrow('CLI MCP服务器必须先初始化');
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      await server.initialize(mockConfig);
      await server.start();
    });

    it('应该成功关闭CLI MCP服务器', async () => {
      await server.shutdown();

      const status = server.getStatus();
      expect(status.initialized).toBe(false);
      expect(status.started).toBe(false);
    });

    it('应该在未初始化时也能安全关闭', async () => {
      const uninitializedServer = new CliMcpServer();

      // 应该不抛出错误
      await expect(uninitializedServer.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('应该返回正确的初始状态', () => {
      const status = server.getStatus();

      expect(status.initialized).toBe(false);
      expect(status.started).toBe(false);
      expect(status.config).toBeNull();
      expect(status.coreServiceStatus).toBeUndefined();
    });

    it('应该在初始化后返回正确状态', async () => {
      await server.initialize(mockConfig);

      const status = server.getStatus();

      expect(status.initialized).toBe(true);
      expect(status.config?.serverCount).toBe(1);
      expect(status.config?.loggingLevel).toBe('info');
      expect(status.coreServiceStatus).toBeDefined();
    });
  });

  describe('初始化参数与 McpServer 构造', () => {
    it('应把 servers 配置传给核心服务初始化', async () => {
      await server.initialize(mockConfig);

      expect(mockServiceManager.initializeFromConfig).toHaveBeenCalledWith({
        servers: mockConfig.servers,
      });
    });

    it('应使用固定的服务器名称、版本与能力构造 McpServer', async () => {
      await server.initialize(mockConfig);

      expect(vi.mocked(McpServer)).toHaveBeenCalledWith(
        { name: 'mcp-knot-cli', version: '1.0.0' },
        {
          capabilities: { tools: {} },
          instructions: 'MCP Knot CLI - 聚合多个MCP服务的命令行界面',
        },
      );
    });

    it('重复初始化不应再次初始化核心服务', async () => {
      await server.initialize(mockConfig);
      mockServiceManager.initializeFromConfig.mockClear();

      await expect(server.initialize(mockConfig)).resolves.toBeUndefined();
      // 第二次初始化被跳过，核心服务初始化只发生一次
      expect(mockServiceManager.initializeFromConfig).not.toHaveBeenCalled();
    });

    it('初始化失败时应记录错误日志并清理状态', async () => {
      const errorSpy = vi.spyOn(UnifiedLogger.prototype, 'error').mockImplementation(() => {});
      const failingServiceManager = {
        initializeFromConfig: vi.fn().mockRejectedValue(new Error('初始化失败')),
        getServiceStatus: vi.fn().mockReturnValue({}),
      };
      const failingServer = new CliMcpServer();
      vi.spyOn(
        failingServer as unknown as CliMcpServerInternals,
        'createServiceManager',
      ).mockReturnValue(failingServiceManager as unknown as McpServiceManager);

      await expect(failingServer.initialize(mockConfig)).rejects.toThrow('初始化失败');

      expect(errorSpy).toHaveBeenCalledWith(
        'CLI MCP服务器初始化失败',
        expect.objectContaining({ message: '初始化失败' }),
      );
      expect(failingServer.getStatus().initialized).toBe(false);
    });
  });

  describe('start 与 serveStdio 接线', () => {
    beforeEach(async () => {
      await server.initialize(mockConfig);
    });

    it('默认兼容配置下 serveStdio 应收到 legacy=serve 与工厂函数', async () => {
      await server.start();

      expect(serveStdio).toHaveBeenCalledTimes(1);
      const [factory, options] = vi.mocked(serveStdio).mock.calls[0];
      expect(typeof factory).toBe('function');
      // 工厂应返回当前持有的 McpServer 实例
      expect(factory()).toBe((server as unknown as CliMcpServerInternals).server);
      expect(options).toEqual({
        legacy: 'serve',
        onerror: expect.any(Function),
      });
    });

    it('关闭入站 legacy shim 时 serveStdio 应收到 legacy=reject', async () => {
      const compat = {
        inbound: { enabled: false },
        outbound: { modernOnly: false },
      } as unknown as CompatibilityOptions;

      const localServer = new CliMcpServer();
      vi.spyOn(
        localServer as unknown as CliMcpServerInternals,
        'createServiceManager',
      ).mockReturnValue(mockServiceManager as unknown as McpServiceManager);
      await localServer.initialize(mockConfig, compat);
      await localServer.start();

      expect(vi.mocked(serveStdio).mock.calls[0][1].legacy).toBe('reject');
    });

    it('启动失败时应记录错误并向上抛出', async () => {
      const errorSpy = vi.spyOn(UnifiedLogger.prototype, 'error').mockImplementation(() => {});
      vi.spyOn(server as unknown as CliMcpServerInternals, 'registerTools').mockRejectedValueOnce(
        new Error('注册工具失败'),
      );

      await expect(server.start()).rejects.toThrow('注册工具失败');
      expect(errorSpy).toHaveBeenCalledWith(
        'CLI MCP服务器启动失败',
        expect.objectContaining({ message: '注册工具失败' }),
      );
      expect(server.getStatus().started).toBe(false);
    });

    it('重复启动应被跳过且不再调用 serveStdio', async () => {
      await server.start();

      await expect(server.start()).resolves.toBeUndefined();
      // 第二次启动被跳过：serveStdio 仍只被调用一次
      expect(serveStdio).toHaveBeenCalledTimes(1);
    });

    it('初始化后 server 引用缺失时启动应报服务器未初始化', async () => {
      (server as unknown as CliMcpServerInternals).server = null;

      await expect(server.start()).rejects.toThrow('服务器未初始化');
    });
  });

  describe('registerTools 真实路径', () => {
    let realServer: CliMcpServer;

    beforeEach(async () => {
      realServer = new CliMcpServer();
      vi.spyOn(
        realServer as unknown as CliMcpServerInternals,
        'createServiceManager',
      ).mockReturnValue(mockServiceManager as unknown as McpServiceManager);
      await realServer.initialize(mockConfig);
    });

    it('应为每个工具注册处理器并保留描述回退逻辑', async () => {
      mockServiceManager.getAllTools.mockResolvedValue([
        { name: 'tool_a', description: '描述A', serverId: 's1' },
        { name: 'tool_b', description: '', serverId: 's2' },
      ]);

      await realServer.start();

      expect(mockMcpServer.registerTool).toHaveBeenCalledTimes(2);
      const [nameA, configA] = mockMcpServer.registerTool.mock.calls[0];
      expect(nameA).toBe('tool_a');
      expect(configA.description).toBe('描述A');

      const [nameB, configB] = mockMcpServer.registerTool.mock.calls[1];
      expect(nameB).toBe('tool_b');
      expect(configB.description).toBe('来自服务器 s2 的工具');

      // 输入 schema 应声明可选 args 字段
      const schemaA = configA.inputSchema as z.ZodObject;
      expect('args' in schemaA.shape).toBe(true);
    });

    it('获取工具列表失败时启动应失败并记录日志', async () => {
      const errorSpy = vi.spyOn(UnifiedLogger.prototype, 'error').mockImplementation(() => {});
      mockServiceManager.getAllTools.mockRejectedValue(new Error('获取工具失败'));

      await expect(realServer.start()).rejects.toThrow('获取工具失败');
      expect(errorSpy).toHaveBeenCalledWith(
        '注册工具失败',
        expect.objectContaining({ message: '获取工具失败' }),
      );
    });

    it('server 或 coreService 缺失时 registerTools 应直接报错', async () => {
      (realServer as unknown as CliMcpServerInternals).coreService = null;

      await expect(
        (realServer as unknown as CliMcpServerInternals).registerTools(),
      ).rejects.toThrow('服务器或核心服务未初始化');
    });
  });

  describe('createToolHandler 行为', () => {
    let toolHandler: (args?: Record<string, unknown>) => Promise<unknown>;

    beforeEach(async () => {
      mockServiceManager.getAllTools.mockResolvedValue([
        { name: 'test_tool', description: '测试工具', serverId: 'test_server' },
      ]);
      const localServer = new CliMcpServer();
      vi.spyOn(
        localServer as unknown as CliMcpServerInternals,
        'createServiceManager',
      ).mockReturnValue(mockServiceManager as unknown as McpServiceManager);
      await localServer.initialize(mockConfig);
      await localServer.start();

      toolHandler = mockMcpServer.registerTool.mock.calls[0][2] as typeof toolHandler;
    });

    it('协议处理器就绪时应转发调用并返回其结果', async () => {
      mockServiceManager.isToolAvailable.mockResolvedValue(true);
      mockServiceManager.executeToolCall.mockResolvedValue({
        success: true,
        data: 'ok',
        executionTime: 5,
      });

      await expect(toolHandler({ x: 1 })).resolves.toEqual({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });
    });

    it('协议处理器缺失时应返回降级错误结果而不抛出', async () => {
      const localServer = new CliMcpServer();
      vi.spyOn(
        localServer as unknown as CliMcpServerInternals,
        'createServiceManager',
      ).mockReturnValue(mockServiceManager as unknown as McpServiceManager);
      await localServer.initialize(mockConfig);
      (localServer as unknown as CliMcpServerInternals).protocolHandler = null;
      mockServiceManager.getAllTools.mockResolvedValue([
        { name: 'test_tool', description: '', serverId: 's' },
      ]);
      mockMcpServer.registerTool.mockClear();
      await localServer.start();
      const handler = mockMcpServer.registerTool.mock.calls[0][2] as typeof toolHandler;

      await expect(handler({})).resolves.toEqual({
        content: [{ type: 'text', text: '工具执行失败: 协议处理器未初始化' }],
        isError: true,
      });
    });

    it('工具执行抛错时应转为协议错误响应', async () => {
      mockServiceManager.isToolAvailable.mockResolvedValue(true);
      mockServiceManager.executeToolCall.mockRejectedValue(new Error('执行异常'));

      await expect(toolHandler({})).resolves.toEqual({
        content: [{ type: 'text', text: '协议错误 (-32001): 工具执行失败: 执行异常' }],
        isError: true,
      });
    });
  });

  describe('shutdown 与清理', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('启动后关闭应关闭 stdio 句柄并保留 server 实例兜底分支不触发', async () => {
      await server.initialize(mockConfig);
      await server.start();
      mockMcpServer.close.mockClear();
      mockStdioHandle.close.mockClear();

      await server.shutdown();

      expect(mockStdioHandle.close).toHaveBeenCalledTimes(1);
      expect(mockMcpServer.close).not.toHaveBeenCalled();
      expect(mockServiceManager.shutdown).toHaveBeenCalledTimes(1);
      // 超时保护定时器应被清理
      expect(vi.getTimerCount()).toBe(0);
    });

    it('未启动时关闭应回退为直接关闭 server', async () => {
      await server.initialize(mockConfig);
      mockMcpServer.close.mockClear();

      await server.shutdown();

      expect(mockMcpServer.close).toHaveBeenCalledTimes(1);
      expect(mockStdioHandle.close).not.toHaveBeenCalled();
    });

    it('关闭超时应强制清理并抛出超时错误', async () => {
      await server.initialize(mockConfig);
      await server.start();
      mockStdioHandle.close.mockImplementationOnce(() => new Promise<void>(() => {}));
      const errorSpy = vi.spyOn(UnifiedLogger.prototype, 'error').mockImplementation(() => {});

      const shutdownPromise = server.shutdown();
      // 先挂上断言再推进时钟，避免 reject 短暂无 handler 被判为 unhandled
      const rejectionAssertion = expect(shutdownPromise).rejects.toThrow('关闭超时');
      await vi.advanceTimersByTimeAsync(5000);

      await rejectionAssertion;
      expect(errorSpy).toHaveBeenCalledWith(
        '关闭失败或超时，强制清理资源',
        expect.objectContaining({ message: '关闭超时' }),
      );
      expect(server.getStatus().initialized).toBe(false);
    });

    it('句柄关闭失败时应向上抛出并记录关闭错误', async () => {
      await server.initialize(mockConfig);
      await server.start();
      const closeError = new Error('句柄关闭失败');
      mockStdioHandle.close.mockRejectedValueOnce(closeError);
      const errorSpy = vi.spyOn(UnifiedLogger.prototype, 'error').mockImplementation(() => {});

      await expect(server.shutdown()).rejects.toThrow('句柄关闭失败');
      expect(errorSpy).toHaveBeenCalledWith(
        'CLI MCP服务器关闭时出错',
        expect.objectContaining({ message: '句柄关闭失败' }),
      );
      expect(server.getStatus().initialized).toBe(false);
    });

    it('global.gc 可用时应触发垃圾回收', async () => {
      const gcMock = vi.fn();
      vi.stubGlobal('gc', gcMock);
      const failingServer = new CliMcpServer();
      vi.spyOn(
        failingServer as unknown as CliMcpServerInternals,
        'createServiceManager',
      ).mockReturnValue({
        initializeFromConfig: vi.fn().mockRejectedValue(new Error('初始化失败')),
      } as unknown as McpServiceManager);

      await expect(failingServer.initialize(mockConfig)).rejects.toThrow('初始化失败');

      expect(gcMock).toHaveBeenCalledTimes(1);
    });

    it('global.gc 抛错时清理流程应继续完成', async () => {
      const debugSpy = vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.stubGlobal(
        'gc',
        vi.fn(() => {
          throw new Error('gc 不可用');
        }),
      );
      const failingServer = new CliMcpServer();
      vi.spyOn(
        failingServer as unknown as CliMcpServerInternals,
        'createServiceManager',
      ).mockReturnValue({
        initializeFromConfig: vi.fn().mockRejectedValue(new Error('初始化失败')),
        getServiceStatus: vi.fn().mockReturnValue({}),
      } as unknown as McpServiceManager);

      await expect(failingServer.initialize(mockConfig)).rejects.toThrow('初始化失败');

      expect(debugSpy).toHaveBeenCalledWith('垃圾回收调用失败（可能未启用 --expose-gc）');
      expect(failingServer.getStatus().initialized).toBe(false);
    });
  });

  describe('serveStdio onerror 回调', () => {
    it('传输层错误应记录日志', async () => {
      await server.initialize(mockConfig);
      await server.start();

      const errorSpy = vi.spyOn(UnifiedLogger.prototype, 'error').mockImplementation(() => {});
      const onerror = vi.mocked(serveStdio).mock.calls[0][1].onerror as (error: Error) => void;
      const transportError = new Error('传输层错误');
      onerror(transportError);

      expect(errorSpy).toHaveBeenCalledWith('serveStdio 传输层错误', transportError);
    });
  });
});
