/**
 * 服务器连接管理器单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectionFailedError,
  ConnectionManagerError,
  ConnectionNotFoundError,
  ConnectionState,
  type ServerConnectionInfo,
  ServerConnectionManager,
} from './connection-manager';

import type { ServerConfig } from '../../types';

// 模拟 logger（生产代码使用项目统一 Logger）；使用 vi.hoisted 保证 vi.mock 工厂可访问
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  createLogger: () => mockLogger,
  logger: mockLogger,
}));

describe('ServerConnectionManager', () => {
  let connectionManager: ServerConnectionManager;
  let mockServerConfig: ServerConfig;

  beforeEach(() => {
    // 重置所有模拟
    vi.clearAllMocks();

    // 创建模拟服务器配置
    mockServerConfig = {
      command: 'node',
      args: ['test-server.js'],
      disabled: false,
    };

    connectionManager = new ServerConnectionManager();
  });

  afterEach(() => {
    // 清理
    if (connectionManager) {
      connectionManager.shutdown().catch(() => {
        // 忽略关闭错误
      });
    }
  });

  describe('初始化', () => {
    it('应该成功初始化连接管理器', async () => {
      await connectionManager.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith('初始化服务器连接管理器');
      expect(mockLogger.info).toHaveBeenCalledWith('服务器连接管理器初始化完成');
    });

    it('应该跳过重复初始化', async () => {
      await connectionManager.initialize();

      // 清除之前的日志调用
      mockLogger.warn.mockClear();

      // 尝试再次初始化
      await connectionManager.initialize();

      expect(mockLogger.warn).toHaveBeenCalledWith('服务器连接管理器已初始化，跳过重复初始化');
    });

    it('应该在未初始化时抛出错误', async () => {
      const error = await connectionManager
        .createConnection('test-server', mockServerConfig)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ConnectionManagerError);
      expect((error as ConnectionManagerError).message).toBe('连接管理器必须在使用前初始化');
      expect((error as ConnectionManagerError).code).toBe('NOT_INITIALIZED');
    });
  });

  describe('连接管理', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('应该成功创建服务器连接', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      const status = connectionManager.getConnectionStatus('test-server');
      expect(status.connected).toBe(true);
      expect(status.lastConnected).toBeInstanceOf(Date);
      expect(status.error).toBeNull();

      expect(mockLogger.info).toHaveBeenCalledWith(
        '创建服务器连接',
        expect.objectContaining({
          serverId: 'test-server',
          context: { command: 'node' },
        }),
      );

      expect(mockLogger.info).toHaveBeenCalledWith('服务器连接创建成功', {
        serverId: 'test-server',
      });
    });

    it('应该重新创建已存在的连接', async () => {
      // 创建第一个连接
      await connectionManager.createConnection('test-server', mockServerConfig);

      // 清除日志
      mockLogger.warn.mockClear();

      // 重新创建连接
      await connectionManager.createConnection('test-server', mockServerConfig);

      expect(mockLogger.warn).toHaveBeenCalledWith('服务器连接已存在，将重新创建', {
        serverId: 'test-server',
      });
    });

    it('应该处理连接创建失败', async () => {
      // 模拟连接失败
      const originalPerformConnection = (
        connectionManager as unknown as { performConnection: unknown }
      ).performConnection;
      (connectionManager as unknown as { performConnection: unknown }).performConnection = vi
        .fn()
        .mockRejectedValue(new Error('连接失败'));

      await expect(
        connectionManager.createConnection('test-server', mockServerConfig),
      ).rejects.toThrow(ConnectionFailedError);

      const status = connectionManager.getConnectionStatus('test-server');
      expect(status.connected).toBe(false);
      expect(status.error).toBe('连接失败');

      // 恢复原方法
      (connectionManager as unknown as { performConnection: unknown }).performConnection =
        originalPerformConnection;
    });

    it('应该成功关闭连接', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      // 清除日志
      mockLogger.info.mockClear();

      await connectionManager.closeConnection('test-server');

      const status = connectionManager.getConnectionStatus('test-server');
      expect(status.connected).toBe(false);
      expect(status.error).toBe('连接不存在');

      expect(mockLogger.info).toHaveBeenCalledWith('关闭服务器连接', {
        serverId: 'test-server',
      });
    });

    it('应该处理关闭不存在的连接', async () => {
      await connectionManager.closeConnection('nonexistent-server');

      expect(mockLogger.warn).toHaveBeenCalledWith('尝试关闭不存在的连接', {
        serverId: 'nonexistent-server',
      });
    });
  });

  describe('连接状态管理', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('应该返回正确的连接状态', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      const status = connectionManager.getConnectionStatus('test-server');
      expect(status).toMatchObject({
        connected: true,
        error: null,
      });
      expect(status.lastConnected).toBeInstanceOf(Date);
    });

    it('应该返回不存在连接的状态', () => {
      const status = connectionManager.getConnectionStatus('nonexistent-server');
      expect(status).toEqual({
        connected: false,
        lastConnected: null,
        error: '连接不存在',
      });
    });

    it('应该返回连接信息', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      const info = connectionManager.getConnectionInfo('test-server');
      expect(info).toMatchObject({
        id: 'test-server',
        state: ConnectionState.CONNECTED,
        reconnectAttempts: 0,
        healthCheckCount: 0,
      });
      expect(info?.config).toEqual(mockServerConfig);
      expect(info?.tools).toHaveLength(2); // 模拟工具
      expect(info?.lastConnected).toBeInstanceOf(Date);
    });

    it('应该返回所有连接信息', async () => {
      await connectionManager.createConnection('server1', mockServerConfig);
      await connectionManager.createConnection('server2', mockServerConfig);

      const allConnections = connectionManager.getAllConnections();
      expect(allConnections.size).toBe(2);
      expect(allConnections.has('server1')).toBe(true);
      expect(allConnections.has('server2')).toBe(true);
    });

    it('应该返回活跃连接列表', async () => {
      await connectionManager.createConnection('server1', mockServerConfig);
      await connectionManager.createConnection('server2', mockServerConfig);

      const activeConnections = connectionManager.getActiveConnections();
      expect(activeConnections).toHaveLength(2);
      expect(activeConnections).toContain('server1');
      expect(activeConnections).toContain('server2');
    });
  });

  describe('健康检查', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('应该对连接的服务器返回健康状态', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      const isHealthy = await connectionManager.healthCheck('test-server');
      expect(isHealthy).toBe(true);

      const info = connectionManager.getConnectionInfo('test-server');
      expect(info?.healthCheckCount).toBe(1);
      expect(info?.lastHealthCheck).toBeInstanceOf(Date);
    });

    it('应该对不存在的服务器返回不健康状态', async () => {
      const isHealthy = await connectionManager.healthCheck('nonexistent-server');
      expect(isHealthy).toBe(false);
    });

    it('应该对未连接的服务器返回不健康状态', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      await connectionManager.closeConnection('test-server');

      const isHealthy = await connectionManager.healthCheck('test-server');
      expect(isHealthy).toBe(false);
    });
  });

  describe('工具管理', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('应该返回服务器工具列表', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      const tools = await connectionManager.getServerTools('test-server');
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({
        name: 'test-server_tool_1',
        description: '来自服务器 test-server 的工具 1',
        serverId: 'test-server',
      });
    });

    it('应该在服务器不存在时抛出错误', async () => {
      await expect(connectionManager.getServerTools('nonexistent-server')).rejects.toThrow(
        ConnectionNotFoundError,
      );
    });

    it('应该在服务器未连接时返回空工具列表', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      await connectionManager.closeConnection('test-server');

      // 手动添加连接信息以模拟未连接状态
      const mockConnection: ServerConnectionInfo = {
        id: 'test-server',
        config: mockServerConfig,
        state: ConnectionState.DISCONNECTED,
        tools: [],
        reconnectAttempts: 0,
        healthCheckCount: 0,
      };
      (
        connectionManager as unknown as {
          connections: Map<string, ServerConnectionInfo>;
        }
      ).connections.set('test-server', mockConnection);

      const tools = await connectionManager.getServerTools('test-server');
      expect(tools).toHaveLength(0);
    });

    it('应该成功执行工具调用', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      const result = await connectionManager.executeToolOnServer('test-server', 'test-tool', {
        param: 'value',
      });

      expect(result).toMatchObject({
        content: [
          {
            type: 'text',
            text: '工具 test-tool 在服务器 test-server 上执行成功',
          },
        ],
        isError: false,
      });
    });

    it('应该在服务器不存在时抛出错误', async () => {
      await expect(
        connectionManager.executeToolOnServer('nonexistent-server', 'test-tool', {}),
      ).rejects.toThrow(ConnectionNotFoundError);
    });

    it('应该在服务器未连接时抛出错误', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      await connectionManager.closeConnection('test-server');

      // 手动添加连接信息以模拟未连接状态
      const mockConnection: ServerConnectionInfo = {
        id: 'test-server',
        config: mockServerConfig,
        state: ConnectionState.DISCONNECTED,
        tools: [],
        reconnectAttempts: 0,
        healthCheckCount: 0,
      };
      (
        connectionManager as unknown as {
          connections: Map<string, ServerConnectionInfo>;
        }
      ).connections.set('test-server', mockConnection);

      await expect(
        connectionManager.executeToolOnServer('test-server', 'test-tool', {}),
      ).rejects.toThrow(ConnectionManagerError);
    });
  });

  describe('连接池统计', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('应该返回正确的连接池统计信息', async () => {
      await connectionManager.createConnection('server1', mockServerConfig);
      await connectionManager.createConnection('server2', mockServerConfig);

      // 执行一些健康检查
      await connectionManager.healthCheck('server1');
      await connectionManager.healthCheck('server2');

      const stats = connectionManager.getPoolStats();
      expect(stats).toMatchObject({
        totalConnections: 2,
        activeConnections: 2,
        failedConnections: 0,
        reconnectingConnections: 0,
        averageReconnectAttempts: 0,
        totalHealthChecks: 2,
      });
    });

    it('应该返回空连接池的统计信息', () => {
      const stats = connectionManager.getPoolStats();
      expect(stats).toEqual({
        totalConnections: 0,
        activeConnections: 0,
        failedConnections: 0,
        reconnectingConnections: 0,
        averageReconnectAttempts: 0,
        totalHealthChecks: 0,
      });
    });
  });

  describe('重新连接', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('应该成功重新连接服务器', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      await connectionManager.createConnection('test-server', mockServerConfig);

      // 模拟连接断开
      const connection = connectionManager.getConnectionInfo('test-server');
      if (connection) {
        connection.state = ConnectionState.ERROR;
        connection.lastError = new Error('连接断开');
      }

      const reconnectPromise = connectionManager.reconnectServer('test-server');
      await vi.advanceTimersByTimeAsync(2000);
      await reconnectPromise;

      vi.useRealTimers();

      const status = connectionManager.getConnectionStatus('test-server');
      expect(status.connected).toBe(true);
      expect(status.error).toBeNull();

      const info = connectionManager.getConnectionInfo('test-server');
      expect(info?.reconnectAttempts).toBe(1);
    });

    it('应该在服务器不存在时抛出错误', async () => {
      await expect(connectionManager.reconnectServer('nonexistent-server')).rejects.toThrow(
        ConnectionNotFoundError,
      );
    });

    it('应该在达到最大重连次数时抛出错误', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);

      // 设置重连次数达到上限
      const connection = connectionManager.getConnectionInfo('test-server');
      if (connection) {
        connection.reconnectAttempts = 3; // MAX_RECONNECT_ATTEMPTS
      }

      const error = await connectionManager
        .reconnectServer('test-server')
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ConnectionManagerError);
      expect((error as ConnectionManagerError).message).toBe(
        "服务器 'test-server' 重连次数已达上限",
      );
      expect((error as ConnectionManagerError).code).toBe('MAX_RECONNECT_ATTEMPTS_EXCEEDED');
      expect((error as ConnectionManagerError).context).toEqual({ maxAttempts: 3 });
    });

    it('重连失败时进入 ERROR 状态并记录失败原因', async () => {
      // 先用真实定时器建立连接（simulateConnection 含 100ms 真实延迟），
      // 再启用 fake timers 处理重连退避；否则 await 会因定时器冻结而挂起，
      // 超时后 finally 不会执行，fake timers 泄漏拖垮后续所有测试
      await connectionManager.createConnection('test-server', mockServerConfig);
      vi.useFakeTimers();
      try {
        const internal = connectionManager as unknown as { performConnection: unknown };
        const original = internal.performConnection;
        internal.performConnection = vi.fn().mockRejectedValue(new Error('重连失败'));
        const connection = connectionManager.getConnectionInfo('test-server')!;
        connection.state = ConnectionState.ERROR;

        const reconnecting = connectionManager.reconnectServer('test-server');
        await vi.advanceTimersByTimeAsync(1_100);
        await expect(reconnecting).rejects.toThrow("连接 'test-server' 失败: 重连失败");

        expect(connection.state).toBe(ConnectionState.ERROR);
        expect(connection.lastError?.message).toBe('重连失败');
        expect(connection.reconnectAttempts).toBe(1);
        internal.performConnection = original;
      } finally {
        vi.useRealTimers();
      }
    });

    it('重连前关闭旧客户端并按指数退避等待', async () => {
      // 同上：先真实定时器建连，再启用 fake timers 验证退避
      await connectionManager.createConnection('test-server', mockServerConfig);
      vi.useFakeTimers();
      try {
        const connection = connectionManager.getConnectionInfo('test-server')!;
        const close = vi.fn();
        connection.client = { close };
        connection.state = ConnectionState.ERROR;

        let resolved = false;
        const reconnecting = connectionManager.reconnectServer('test-server').then(() => {
          resolved = true;
        });
        // 关闭与状态清理在 reconnectServer 内部的首个 await 之后完成，先刷新微任务
        await vi.advanceTimersByTimeAsync(0);
        expect(close).toHaveBeenCalledTimes(1);
        expect(connection.client).toBeUndefined();
        expect(connection.state).toBe(ConnectionState.RECONNECTING);

        await vi.advanceTimersByTimeAsync(999);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        expect(resolved).toBe(true);
        await reconnecting;

        expect(connection.state).toBe(ConnectionState.CONNECTED);
        expect(connection.lastError).toBeUndefined();
        expect(connection.lastConnected).toBeInstanceOf(Date);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('客户端生命周期', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('首次创建连接不应误报关闭不存在的连接', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      expect(mockLogger.warn).not.toHaveBeenCalledWith('尝试关闭不存在的连接', expect.anything());
    });

    it('创建连接后提供模拟客户端并发现以服务器命名的工具', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      const info = connectionManager.getConnectionInfo('test-server');
      expect(info?.client).toMatchObject({ id: 'test-server', connected: true });
      expect(typeof (info?.client as { close: () => void }).close).toBe('function');
      expect(info?.tools.map((tool) => tool.name)).toEqual([
        'test-server_tool_1',
        'test-server_tool_2',
      ]);
    });

    it('连接失败后工具列表为空且计入失败统计', async () => {
      const internal = connectionManager as unknown as { performConnection: unknown };
      const original = internal.performConnection;
      internal.performConnection = vi.fn().mockRejectedValue(new Error('连接失败'));
      await expect(
        connectionManager.createConnection('broken', mockServerConfig),
      ).rejects.toThrow();
      internal.performConnection = original;

      expect(await connectionManager.getServerTools('broken')).toEqual([]);
      expect(connectionManager.getPoolStats()).toMatchObject({
        totalConnections: 1,
        activeConnections: 0,
        failedConnections: 1,
      });
    });

    it('关闭连接时调用客户端 close 并清理状态', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      const info = connectionManager.getConnectionInfo('test-server')!;
      const close = vi.fn();
      info.client = { close };

      await connectionManager.closeConnection('test-server');

      expect(close).toHaveBeenCalledTimes(1);
      expect(info.client).toBeUndefined();
      expect(info.state).toBe(ConnectionState.DISCONNECTED);
      expect(info.lastError).toBeUndefined();
      expect(connectionManager.getAllConnections().has('test-server')).toBe(false);
    });

    it('客户端缺少 close 方法时不阻塞关闭且不记录错误', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      const info = connectionManager.getConnectionInfo('test-server')!;
      info.client = {};

      await connectionManager.closeConnection('test-server');

      expect(info.lastError).toBeUndefined();
      expect(connectionManager.getConnectionInfo('test-server')).toBeUndefined();
    });

    it('客户端 close 失败时记录错误但仍移除连接', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      const info = connectionManager.getConnectionInfo('test-server')!;
      info.client = { close: vi.fn().mockRejectedValue(new Error('关闭失败')) };

      await connectionManager.closeConnection('test-server');

      expect(info.lastError?.message).toBe('关闭失败');
      expect(connectionManager.getConnectionInfo('test-server')).toBeUndefined();
    });
  });

  describe('健康检查边界', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('对非 CONNECTED 状态或缺少客户端的连接返回不健康', async () => {
      await connectionManager.createConnection('test-server', mockServerConfig);
      const info = connectionManager.getConnectionInfo('test-server')!;

      info.state = ConnectionState.CONNECTING;
      info.client = { close: vi.fn() };
      expect(await connectionManager.healthCheck('test-server')).toBe(false);

      info.state = ConnectionState.CONNECTED;
      info.client = undefined;
      expect(await connectionManager.healthCheck('test-server')).toBe(false);

      // 即使检查失败也应记录健康检查次数
      expect(info.healthCheckCount).toBe(2);
      expect(info.lastHealthCheck).toBeInstanceOf(Date);
    });
  });

  describe('工具执行边界', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    function injectConnection(state: ConnectionState, client?: unknown) {
      const connection: ServerConnectionInfo = {
        id: 'test-server',
        config: mockServerConfig,
        state,
        client,
        tools: [],
        reconnectAttempts: 0,
        healthCheckCount: 0,
      };
      (
        connectionManager as unknown as {
          connections: Map<string, ServerConnectionInfo>;
        }
      ).connections.set('test-server', connection);
      return connection;
    }

    it('未连接时抛出携带当前状态的错误', async () => {
      injectConnection(ConnectionState.DISCONNECTED);
      const error = await connectionManager
        .executeToolOnServer('test-server', 'tool', {})
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ConnectionManagerError);
      expect((error as ConnectionManagerError).message).toBe(
        "服务器 'test-server' 未连接 (状态: disconnected)",
      );
      expect((error as ConnectionManagerError).code).toBe('SERVER_NOT_CONNECTED');
      expect((error as ConnectionManagerError).context).toEqual({ state: 'disconnected' });
    });

    it('已连接但客户端不可用时抛出专用错误', async () => {
      injectConnection(ConnectionState.CONNECTED);
      await expect(
        connectionManager.executeToolOnServer('test-server', 'tool', {}),
      ).rejects.toThrow("服务器 'test-server' 客户端不可用");
      const error = await connectionManager
        .executeToolOnServer('test-server', 'tool', {})
        .catch((cause: unknown) => cause);
      expect((error as ConnectionManagerError).code).toBe('CLIENT_NOT_AVAILABLE');
    });
  });

  describe('连接池统计边界', () => {
    beforeEach(async () => {
      await connectionManager.initialize();
    });

    it('按状态分别统计并计算平均重连次数', async () => {
      const connections = (
        connectionManager as unknown as {
          connections: Map<string, ServerConnectionInfo>;
        }
      ).connections;
      const base = {
        config: mockServerConfig,
        tools: [],
        healthCheckCount: 0,
      };
      connections.set('active', {
        ...base,
        id: 'active',
        state: ConnectionState.CONNECTED,
        client: { close: vi.fn() },
        reconnectAttempts: 0,
        healthCheckCount: 2,
      });
      connections.set('failed', {
        ...base,
        id: 'failed',
        state: ConnectionState.ERROR,
        reconnectAttempts: 3,
        healthCheckCount: 1,
      });
      connections.set('reconnecting', {
        ...base,
        id: 'reconnecting',
        state: ConnectionState.RECONNECTING,
        reconnectAttempts: 1,
        healthCheckCount: 0,
      });

      expect(connectionManager.getPoolStats()).toEqual({
        totalConnections: 3,
        activeConnections: 1,
        failedConnections: 1,
        reconnectingConnections: 1,
        averageReconnectAttempts: 4 / 3,
        totalHealthChecks: 3,
      });
      expect(connectionManager.getActiveConnections()).toEqual(['active']);
    });
  });

  describe('关闭', () => {
    it('应该在未初始化时跳过关闭', async () => {
      await connectionManager.shutdown();

      expect(mockLogger.warn).toHaveBeenCalledWith('连接管理器未初始化，跳过关闭');
    });

    it('应该成功关闭连接管理器', async () => {
      await connectionManager.initialize();
      await connectionManager.createConnection('server1', mockServerConfig);
      await connectionManager.createConnection('server2', mockServerConfig);

      // 清除初始化日志
      mockLogger.info.mockClear();

      await connectionManager.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith(
        '开始关闭服务器连接管理器',
        expect.objectContaining({
          context: expect.objectContaining({
            totalConnections: 2,
          }),
        }),
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        '服务器连接管理器关闭完成',
        expect.objectContaining({
          duration: expect.any(Number),
        }),
      );
      const completion = mockLogger.info.mock.calls.find(
        (call) => call[0] === '服务器连接管理器关闭完成',
      );
      expect((completion?.[1] as { duration: number }).duration).toBeGreaterThanOrEqual(0);

      // 单次关闭不应触发重复关闭告警
      expect(mockLogger.warn).not.toHaveBeenCalledWith('关闭已在进行中，等待完成');

      const stats = connectionManager.getPoolStats();
      expect(stats.totalConnections).toBe(0);
    });

    it('应该防止重复关闭', async () => {
      await connectionManager.initialize();

      // 开始第一次关闭（不等待完成）
      const shutdownPromise1 = connectionManager.shutdown();

      // 立即开始第二次关闭
      const shutdownPromise2 = connectionManager.shutdown();

      await Promise.all([shutdownPromise1, shutdownPromise2]);

      expect(mockLogger.warn).toHaveBeenCalledWith('关闭已在进行中，等待完成');
    });
  });

  describe('错误处理', () => {
    it('应该正确创建ConnectionManagerError', () => {
      const error = new ConnectionManagerError('测试错误', 'TEST_ERROR', 'test-server', {
        key: 'value',
      });

      expect(error.name).toBe('ConnectionManagerError');
      expect(error.message).toBe('测试错误');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.serverId).toBe('test-server');
      expect(error.context).toEqual({ key: 'value' });
    });

    it('应该正确创建ConnectionNotFoundError', () => {
      const error = new ConnectionNotFoundError('test-server');

      expect(error).toBeInstanceOf(ConnectionManagerError);
      expect(error.code).toBe('CONNECTION_NOT_FOUND');
      expect(error.message).toBe("连接 'test-server' 未找到");
      expect(error.serverId).toBe('test-server');
    });

    it('应该正确创建ConnectionFailedError', () => {
      const error = new ConnectionFailedError('test-server', '网络错误');

      expect(error).toBeInstanceOf(ConnectionManagerError);
      expect(error.code).toBe('CONNECTION_FAILED');
      expect(error.message).toBe("连接 'test-server' 失败: 网络错误");
      expect(error.serverId).toBe('test-server');
      expect(error.context).toEqual({ reason: '网络错误' });
    });
  });
});
