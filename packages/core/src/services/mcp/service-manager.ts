/**
 * MCP服务管理器
 * 负责MCP服务的注册、初始化和生命周期管理
 */

import { createLogger } from '@mcp-core/mcp-knot-share';

import { performanceMonitor } from '../../utils/performance-monitor.js';
import { performanceOptimizer } from '../../utils/performance-optimizer.js';

import type {
  InputRequiredResult,
  McpServerConfig,
  RetryContext,
  ServerConfig,
  ServiceStatus,
  ToolInfo,
  ToolResult,
} from '../../types/index.js';

/**
 * MCP服务管理器错误类
 */
export class McpServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpServiceError';
  }
}

export class ServiceNotInitializedError extends McpServiceError {
  constructor() {
    super('MCP服务管理器必须在使用前初始化', 'SERVICE_NOT_INITIALIZED');
  }
}

export class ServerNotFoundError extends McpServiceError {
  constructor(serverId: string) {
    super(`服务器 '${serverId}' 未找到`, 'SERVER_NOT_FOUND', { serverId });
  }
}

export class ToolNotFoundError extends McpServiceError {
  constructor(toolName: string, serverId?: string) {
    super(
      `工具 '${toolName}' 未找到${serverId ? ` 在服务器 '${serverId}'` : ''}`,
      'TOOL_NOT_FOUND',
      { toolName, serverId },
    );
  }
}

/**
 * 服务器连接状态
 */
export enum ServerStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

/**
 * 服务器连接信息
 */
export interface ServerConnection {
  id: string;
  config: ServerConfig;
  status: ServerStatus;
  tools: ToolInfo[];
  lastConnected?: Date;
  lastError?: Error;
  reconnectAttempts: number;
}

/**
 * MCP服务管理器接口
 */
export interface McpServiceManagerInterface {
  /**
   * 从配置初始化MCP服务
   */
  initializeFromConfig(config: McpServerConfig): Promise<void>;

  /**
   * 注册MCP服务器
   */
  registerServer(serverId: string, config: ServerConfig): Promise<void>;

  /**
   * 获取所有可用工具
   */
  getAllTools(): Promise<ToolInfo[]>;

  /**
   * 获取指定服务器的工具
   */
  getServerTools(serverId: string): Promise<ToolInfo[]>;

  /**
   * 执行工具调用
   */
  executeToolCall(toolName: string, args: unknown, serverId?: string): Promise<ToolResult>;

  /**
   * P5 MRTR：带重试上下文（inputResponses + requestState）的工具调用路径。
   *
   * 用于多轮中转：上游首次返回 input_required 后，客户端收集应答，经由
   * 本方法把 retryContext 透传给上游 callTool 的 request params（顶层字段），
   * 继续这一轮工具调用。返回 ToolResult 或 InputRequiredResult（仍需输入）。
   */
  executeToolCallWithContext(
    toolName: string,
    args: unknown,
    serverId: string,
    retryContext: RetryContext,
  ): Promise<ToolResult | InputRequiredResult>;

  /**
   * 获取服务状态
   */
  getServiceStatus(): ServiceStatus;

  /**
   * 获取所有服务器连接状态
   */
  getServerConnections(): Map<string, ServerConnection>;

  /**
   * 检查工具是否可用
   */
  isToolAvailable(toolName: string, serverId?: string): Promise<boolean>;

  /**
   * 关闭所有连接
   */
  shutdown(): Promise<void>;
}

/**
 * MCP服务管理器实现
 */
export class McpServiceManager implements McpServiceManagerInterface {
  private servers = new Map<string, ServerConnection>();
  private serverConfigs = new Map<string, ServerConfig>();
  private initialized = false;
  private shutdownInProgress = false;
  private logger = createLogger({ component: 'Core' });

  constructor(config?: McpServerConfig) {
    if (config) {
      // 异步初始化将在initializeFromConfig中处理
      this.initializeFromConfig(config).catch((error) => {
        this.logger.error('MCP服务管理器初始化失败', error as Error);
      });
    }
  }

  async initializeFromConfig(config: McpServerConfig): Promise<void> {
    if (this.initialized) {
      this.logger.warn('MCP服务管理器已初始化，跳过重复初始化');
      return;
    }

    const requestId = `init-${Date.now()}`;
    performanceMonitor.startRequest(requestId, 'initializeFromConfig', 'McpServiceManager');

    const initStartTime = Date.now();
    this.logger.info('开始初始化MCP服务管理器', {
      serverCount: Object.keys(config.servers).length,
      timestamp: new Date().toISOString(),
    });

    try {
      // 存储服务器配置
      for (const [serverId, serverConfig] of Object.entries(config.servers)) {
        this.serverConfigs.set(serverId, serverConfig);
      }

      // 使用性能优化器进行并行初始化
      const serverEntries = Array.from(this.serverConfigs.entries());
      const initTasks = serverEntries.map(
        ([serverId, serverConfig]) =>
          () =>
            this.initializeServer(serverId, serverConfig),
      );
      const serverNames = serverEntries.map(([serverId]) => serverId);

      // 并发初始化所有服务器，但不因部分失败而整体失败
      let settledResults: PromiseSettledResult<void>[];
      try {
        // 尝试使用性能优化器进行并行初始化
        const initResults = await performanceOptimizer.optimizeParallelInitialization(
          initTasks,
          serverNames,
        );
        // 将成功结果转换为Promise.allSettled格式
        settledResults = initResults.map(
          (result): PromiseSettledResult<void> => ({
            status: 'fulfilled',
            value: result,
          }),
        );
      } catch (_error) {
        // 如果并行初始化失败，回退到Promise.allSettled
        settledResults = await Promise.allSettled(initTasks.map((task) => task()));
      }

      // 检查是否有严重错误（所有服务器都失败）
      const failures = settledResults.filter((result) => result.status === 'rejected');
      if (failures.length === settledResults.length && settledResults.length > 0) {
        // 如果所有服务器都失败了，抛出第一个错误
        const firstFailure = failures[0] as PromiseRejectedResult;
        throw firstFailure.reason;
      }

      const connectedCount = this.getConnectedServerCount();
      this.initialized = true;

      const initDuration = Date.now() - initStartTime;
      this.logger.info('MCP服务管理器初始化完成', {
        totalServers: this.serverConfigs.size,
        connectedServers: connectedCount,
        failedServers: this.serverConfigs.size - connectedCount,
        initializationTimeMs: initDuration,
        timestamp: new Date().toISOString(),
      });

      performanceMonitor.endRequest(requestId, true);
    } catch (error) {
      const initDuration = Date.now() - initStartTime;
      this.logger.error('MCP服务管理器初始化失败', error as Error, {
        initializationTimeMs: initDuration,
        serverCount: Object.keys(config.servers).length,
      });

      // 清理失败的初始化
      await this.cleanupFailedInitialization();

      performanceMonitor.endRequest(requestId, false, (error as Error).message);

      throw new McpServiceError(
        `服务初始化失败: ${(error as Error).message}`,
        'INITIALIZATION_FAILED',
        { originalError: (error as Error).message },
      );
    }
  }

  async registerServer(serverId: string, config: ServerConfig): Promise<void> {
    this.logger.info('注册MCP服务器', { serverId });

    try {
      // 存储配置
      this.serverConfigs.set(serverId, config);

      // 如果已初始化，立即初始化新服务器
      if (this.initialized) {
        await this.initializeServer(serverId, config);
      }

      this.logger.info('MCP服务器注册成功', { serverId });
    } catch (error) {
      this.logger.error('MCP服务器注册失败', error as Error, { serverId });
      throw new McpServiceError(
        `服务器注册失败: ${(error as Error).message}`,
        'SERVER_REGISTRATION_FAILED',
        { serverId, originalError: (error as Error).message },
      );
    }
  }

  async getAllTools(): Promise<ToolInfo[]> {
    this.ensureInitialized();

    // 尝试从缓存获取
    const cacheKey = 'all-tools';
    const cachedTools = performanceOptimizer.getCached<ToolInfo[]>(cacheKey);
    if (cachedTools) {
      this.logger.debug('从缓存获取所有工具', {
        context: { toolCount: cachedTools.length },
      });
      return cachedTools;
    }

    const requestId = `get-all-tools-${Date.now()}`;
    performanceMonitor.startRequest(requestId, 'getAllTools', 'McpServiceManager');

    this.logger.debug('获取所有可用工具');

    try {
      const allTools: ToolInfo[] = [];
      const connectedServers = Array.from(this.servers.values()).filter(
        (server) => server.status === ServerStatus.CONNECTED,
      );

      for (const server of connectedServers) {
        allTools.push(...server.tools);
      }

      // 缓存结果
      performanceOptimizer.setCached(cacheKey, allTools, 60000); // 缓存1分钟

      this.logger.debug('获取所有工具完成', {
        totalTools: allTools.length,
        connectedServers: connectedServers.length,
      });

      performanceMonitor.endRequest(requestId, true);
      return allTools;
    } catch (error) {
      this.logger.error('获取所有工具失败', error as Error);
      performanceMonitor.endRequest(requestId, false, (error as Error).message);

      throw new McpServiceError(`获取工具失败: ${(error as Error).message}`, 'GET_TOOLS_FAILED', {
        originalError: (error as Error).message,
      });
    }
  }

  async getServerTools(serverId: string): Promise<ToolInfo[]> {
    this.ensureInitialized();

    const server = this.servers.get(serverId);
    if (!server) {
      throw new ServerNotFoundError(serverId);
    }

    if (server.status !== ServerStatus.CONNECTED) {
      this.logger.warn('服务器未连接，返回空工具列表', {
        serverId,
        status: server.status,
      });
      return [];
    }

    return [...server.tools];
  }

  async executeToolCall(toolName: string, args: unknown, serverId?: string): Promise<ToolResult> {
    this.ensureInitialized();

    const executionId = `exec-${toolName}-${Date.now()}`;
    performanceMonitor.startRequest(executionId, 'executeToolCall', 'McpServiceManager', {
      toolName,
      serverId,
    });

    this.logger.info('开始执行工具调用', {
      executionId,
      toolName,
      serverId,
      args,
    });

    try {
      // 如果指定了服务器ID，直接在该服务器上执行
      if (serverId) {
        const result = await this.executeToolOnServer(serverId, toolName, args, executionId);
        performanceMonitor.endRequest(executionId, true);
        return result;
      }

      // 否则查找包含该工具的服务器
      const targetServerId = await this.findToolServer(toolName);
      if (!targetServerId) {
        throw new ToolNotFoundError(toolName);
      }

      const result = await this.executeToolOnServer(targetServerId, toolName, args, executionId);
      performanceMonitor.endRequest(executionId, true);
      return result;
    } catch (error) {
      this.logger.error('工具执行失败', error as Error, {
        executionId,
        toolName,
        serverId,
      });

      performanceMonitor.endRequest(executionId, false, (error as Error).message);

      if (error instanceof McpServiceError) {
        throw error;
      }

      throw new McpServiceError(
        `工具执行失败: ${(error as Error).message}`,
        'TOOL_EXECUTION_FAILED',
        {
          toolName,
          serverId,
          executionId,
          originalError: (error as Error).message,
        },
      );
    }
  }

  getServiceStatus(): ServiceStatus {
    const connectedServers = this.getConnectedServerCount();

    return {
      initialized: this.initialized,
      serverCount: this.serverConfigs.size,
      activeConnections: connectedServers,
      lastUpdated: new Date(),
      error: this.initialized ? undefined : '服务未初始化',
    };
  }

  /**
   * P5 MRTR：带重试上下文的工具调用。
   *
   * core 包的 McpServiceManager 是 mock 壳（真实上游连接在 backend 的
   * ServerManager）；这里返回 mock 结果以维持接口契约，真实实现见
   * BackendCoreServiceAdapter.executeToolCallWithContext。
   */
  async executeToolCallWithContext(
    toolName: string,
    args: unknown,
    serverId: string,
    _retryContext: RetryContext,
  ): Promise<ToolResult | InputRequiredResult> {
    this.ensureInitialized();
    this.logger.warn(
      'executeToolCallWithContext 在 core mock 壳中被调用；应经 backend 适配器执行',
      {
        toolName,
        serverId,
      },
    );
    // 复用 executeToolCall 的 mock 结果结构（真实重试在 backend 侧）
    return this.executeToolCall(toolName, args, serverId);
  }

  getServerConnections(): Map<string, ServerConnection> {
    return new Map(this.servers);
  }

  async isToolAvailable(toolName: string, serverId?: string): Promise<boolean> {
    this.ensureInitialized();

    try {
      if (serverId) {
        const server = this.servers.get(serverId);
        if (!server || server.status !== ServerStatus.CONNECTED) {
          return false;
        }
        return server.tools.some((tool) => tool.name === toolName);
      }

      // 在所有连接的服务器中查找
      const targetServerId = await this.findToolServer(toolName);
      return targetServerId !== undefined;
    } catch (error) {
      this.logger.error('检查工具可用性失败', error as Error, {
        toolName,
        serverId,
      });
      return false;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('MCP服务管理器未初始化，跳过关闭');
      return;
    }

    if (this.shutdownInProgress) {
      this.logger.warn('关闭已在进行中，等待完成');
      return;
    }

    this.shutdownInProgress = true;
    const shutdownStartTime = Date.now();

    this.logger.info('开始关闭MCP服务管理器', {
      timestamp: new Date().toISOString(),
      connectedServers: this.getConnectedServerCount(),
    });

    try {
      // 关闭所有服务器连接
      const shutdownPromises = Array.from(this.servers.values()).map(async (server) => {
        try {
          if (server.status === ServerStatus.CONNECTED) {
            // 这里应该调用实际的客户端关闭方法
            // 由于我们在核心包中，暂时只更新状态
            server.status = ServerStatus.DISCONNECTED;
            this.logger.debug('服务器连接已关闭', { serverId: server.id });
          }
        } catch (error) {
          this.logger.error('关闭服务器连接时出错', error as Error, {
            serverId: server.id,
          });
        }
      });

      await Promise.allSettled(shutdownPromises);

      // 清理状态
      this.servers.clear();
      this.serverConfigs.clear();
      this.initialized = false;
      this.shutdownInProgress = false;

      const shutdownDuration = Date.now() - shutdownStartTime;
      this.logger.info('MCP服务管理器关闭完成', {
        context: {
          shutdownTimeMs: shutdownDuration,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const shutdownDuration = Date.now() - shutdownStartTime;
      this.logger.error('MCP服务管理器关闭时出错', error as Error, {
        context: {
          shutdownTimeMs: shutdownDuration,
        },
      });

      this.shutdownInProgress = false;
      throw new McpServiceError(`服务关闭失败: ${(error as Error).message}`, 'SHUTDOWN_FAILED', {
        originalError: (error as Error).message,
      });
    }
  }

  // 私有辅助方法

  private async initializeServer(serverId: string, config: ServerConfig): Promise<void> {
    // 跳过禁用的服务器（仅 stdio 类型支持 disabled）
    if ('disabled' in config && config.disabled === true) {
      this.logger.info('跳过禁用的服务器', { serverId });
      return;
    }

    this.logger.info('初始化服务器', { serverId });

    const serverConnection: ServerConnection = {
      id: serverId,
      config,
      status: ServerStatus.CONNECTING,
      tools: [],
      reconnectAttempts: 0,
    };

    this.servers.set(serverId, serverConnection);

    try {
      // 这里应该实现实际的服务器连接逻辑
      // 由于我们在核心包中，暂时模拟连接成功
      await this.simulateServerConnection(serverConnection);

      serverConnection.status = ServerStatus.CONNECTED;
      serverConnection.lastConnected = new Date();
      serverConnection.reconnectAttempts = 0;

      this.logger.info('服务器连接成功', { serverId });

      // 发现工具
      await this.discoverServerTools(serverConnection);
    } catch (error) {
      serverConnection.status = ServerStatus.ERROR;
      serverConnection.lastError = error as Error;
      this.logger.error('服务器初始化失败', error as Error, { serverId });
      throw error;
    }
  }

  private async simulateServerConnection(serverConnection: ServerConnection): Promise<void> {
    // 模拟连接延迟
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    // 这里应该实现实际的MCP客户端连接逻辑
    // 暂时只是模拟成功
    this.logger.debug('模拟服务器连接', { serverId: serverConnection.id });
  }

  private async discoverServerTools(serverConnection: ServerConnection): Promise<void> {
    const { id: serverId } = serverConnection;

    try {
      // 这里应该调用实际的MCP客户端listTools方法
      // 暂时返回模拟的工具列表
      const mockTools: ToolInfo[] = [
        {
          name: `${serverId}_tool_1`,
          description: `来自服务器 ${serverId} 的工具 1`,
          serverId,
        },
        {
          name: `${serverId}_tool_2`,
          description: `来自服务器 ${serverId} 的工具 2`,
          serverId,
        },
      ];

      serverConnection.tools = mockTools;
      this.logger.info('工具发现完成', {
        serverId,
        context: {
          toolCount: mockTools.length,
          toolNames: mockTools.map((t) => t.name),
        },
      });
    } catch (error) {
      this.logger.error('工具发现失败', error as Error, { serverId });
      serverConnection.tools = [];
    }
  }

  private async executeToolOnServer(
    serverId: string,
    toolName: string,
    args: unknown,
    executionId: string,
  ): Promise<ToolResult> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new ServerNotFoundError(serverId);
    }

    if (server.status !== ServerStatus.CONNECTED) {
      throw new McpServiceError(
        `服务器 ${serverId} 未连接 (状态: ${server.status})`,
        'SERVER_NOT_CONNECTED',
        { serverId, status: server.status },
      );
    }

    // 验证工具存在
    const tool = server.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName, serverId);
    }

    try {
      this.logger.debug('在服务器上执行工具', {
        executionId,
        serverId,
        toolName,
        args,
      });

      // 这里应该调用实际的MCP客户端callTool方法
      // 暂时返回模拟结果
      const mockResult: ToolResult = {
        success: true,
        data: {
          message: `工具 ${toolName} 在服务器 ${serverId} 上执行成功`,
          args,
          timestamp: new Date().toISOString(),
        },
        executionTime: 100,
        metadata: {
          serverId,
          toolName,
          executionId,
        },
      };

      this.logger.debug('工具执行完成', {
        executionId,
        serverId,
        toolName,
        context: {
          success: mockResult.success,
        },
      });

      return mockResult;
    } catch (error) {
      this.logger.error('工具执行失败', error as Error, {
        executionId,
        serverId,
        toolName,
      });
      throw error;
    }
  }

  private async findToolServer(toolName: string): Promise<string | undefined> {
    const connectedServers = Array.from(this.servers.values()).filter(
      (server) => server.status === ServerStatus.CONNECTED,
    );

    for (const server of connectedServers) {
      if (server.tools.some((tool) => tool.name === toolName)) {
        return server.id;
      }
    }

    return undefined;
  }

  private getConnectedServerCount(): number {
    return Array.from(this.servers.values()).filter(
      (server) => server.status === ServerStatus.CONNECTED,
    ).length;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new ServiceNotInitializedError();
    }
  }

  private async cleanupFailedInitialization(): Promise<void> {
    this.logger.debug('清理失败的初始化');

    try {
      // 清理部分初始化的服务器连接
      for (const server of this.servers.values()) {
        if (server.status === ServerStatus.CONNECTED) {
          server.status = ServerStatus.DISCONNECTED;
        }
      }

      this.servers.clear();
      this.logger.debug('初始化清理完成');
    } catch (cleanupError) {
      this.logger.error('初始化清理时出错', cleanupError as Error);
      // 不抛出清理错误，只记录
    }
  }
}
