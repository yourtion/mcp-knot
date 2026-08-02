import { ConfigError, ErrorCode, ServiceError, ToolExecutionError } from '@mcp-core/mcp-knot-core';

import { ServerStatus } from '../types/mcp-knot.js';
import { logger } from '../utils/logger.js';
import { ApiToolIntegrationService } from './api_tool_integration_service.js';
import { GroupManager } from './group_manager.js';
import { HealthMonitorService } from './health-monitor-service.js';
import { MessageAuditService } from './message-audit-service.js';
import { ServerManager } from './server_manager.js';
import { ToolManager } from './tool_manager.js';
import { UpstreamChangeDetector } from './upstream-change-detector.js';
import { UpstreamChangeFanout } from './upstream-change-fanout.js';

import type {
  Group,
  McpKnotService as IMcpKnotService,
  Tool,
  ToolResult,
} from '../types/mcp-knot.js';
import type {
  DeepReadonly,
  GroupConfig,
  ServerConfig,
  SystemConfig,
} from '@mcp-core/mcp-knot-share';

export class McpKnotService implements IMcpKnotService {
  private serverManager: ServerManager;

  /**
   * P5: 上游工具集变更检测器（listChanged 实时 + 轮询兜底）。
   * 注入 ServerManager.changeDetector，server 连接时注册 listChanged handler。
   *
   * P5 修复（代码审查 C1）：subscriptions.enabled=false 时不构造（undefined），
   * 整个 subscriptions 链路（listChanged 监听 + 轮询兜底 + fan-out）完全关闭。
   */
  private changeDetector?: UpstreamChangeDetector;
  /**
   * P5: 变更 fan-out，把 serverId 变更分发到所有含该 server 的 group。
   * 同 changeDetector，subscriptions.enabled=false 时不构造。
   */
  private changeFanout?: UpstreamChangeFanout;

  /**
   * 暴露 ServerManager 供 BackendCoreServiceAdapter 委托（P6 架构修正，spec §10.3）。
   * 适配器让 group-service（经 McpServiceManagerInterface）拿到真实连接/调用。
   */
  getServerManager(): ServerManager {
    return this.serverManager;
  }

  private groupManager: GroupManager;
  private toolManager: ToolManager;
  private apiToolService: ApiToolIntegrationService;
  private messageAudit: MessageAuditService;
  private healthMonitor: HealthMonitorService;
  private isInitialized = false;
  private readonly DEFAULT_GROUP = 'default';
  private shutdownInProgress = false;
  private serverConfigs: Record<string, ServerConfig> = {} as Record<string, ServerConfig>;
  private groupConfigs: GroupConfig = {} as GroupConfig;

  /**
   * P5 subscriptions 实际生效参数（从 systemConfig.subscriptions 读取，带默认值 fallback）。
   * 这些默认值与 system.schema.ts 的 schema 默认值保持一致，确保 config 未配置时行为不变。
   *
   * P5 修复（代码审查 C1）：新增 subscriptionsEnabled 开关（默认 true，向后兼容）。
   * 为 false 时 changeDetector/changeFanout 不构造、不 startPolling，
   * 整个 subscriptions/listen 功能完全关闭。
   */
  private readonly subscriptionsEnabled: boolean;
  private readonly subscriptionsPollIntervalMs: number;
  private readonly subscriptionsPollBackoffMs: number;
  private readonly subscriptionsFanoutDebounceMs: number;

  constructor(
    serverConfigs: DeepReadonly<Record<string, ServerConfig>>,
    groupConfigs: DeepReadonly<GroupConfig>,
    private apiToolConfigPath?: string,
    systemConfig?: DeepReadonly<SystemConfig>,
  ) {
    this.serverConfigs = JSON.parse(JSON.stringify(serverConfigs));
    this.groupConfigs = JSON.parse(JSON.stringify(groupConfigs));

    // P5：从 systemConfig.subscriptions 读取轮询/fan-out 参数。
    // 各字段均带与 schema 默认值一致的 fallback，config 未配置（subscriptions 整块缺失）
    // 或部分字段缺失时行为与之前硬编码常量完全一致（向后兼容）。
    const subs = systemConfig?.subscriptions;
    this.subscriptionsEnabled = subs?.enabled ?? true;
    this.subscriptionsPollIntervalMs = subs?.pollIntervalMs ?? 60_000;
    this.subscriptionsPollBackoffMs = subs?.pollBackoffMs ?? 300_000;
    this.subscriptionsFanoutDebounceMs = subs?.fanoutDebounceMs ?? 500;

    // P5 修复（代码审查 C1）：subscriptions.enabled=false 时完全不构造
    // changeDetector/changeFanout（连带 ServerManager 不注入 detector，
    // listChanged handler 不注册、轮询不启动）。默认 true 行为与之前一致。
    if (this.subscriptionsEnabled) {
      // P5: 先建 fanout（onChange 在 detector 内被引用，故 detector 后建）。
      // fanout 回调闭包在「被调用时」才解析依赖（groupManager / serverManager / 缓存），
      // 此处仅捕获 this 引用，构造期不触发任何访问。
      this.changeFanout = new UpstreamChangeFanout({
        getGroupsForServer: (serverId) => this.getGroupsForServer(serverId),
        refreshGroupTools: (groupId, serverId) => this.refreshGroupTools(groupId, serverId),
        publishToolListChanged: (groupId) => this.publishToolListChanged(groupId),
        debounceMs: this.subscriptionsFanoutDebounceMs,
        logger,
      });

      this.changeDetector = new UpstreamChangeDetector({
        onChange: (serverId) => this.changeFanout!.handleServerChange(serverId),
        pollIntervalMs: this.subscriptionsPollIntervalMs,
        pollBackoffMs: this.subscriptionsPollBackoffMs,
        logger,
      });
    }

    // ServerManager 注入 detector（连接时注册 listChanged handler + 保存快照）；
    // subscriptions.enabled=false 时不注入（detector 为 undefined）。
    this.serverManager = new ServerManager(this.serverConfigs, {
      ...(this.changeDetector && { changeDetector: this.changeDetector }),
    });
    this.groupManager = new GroupManager(this.groupConfigs, this.serverManager);
    this.apiToolService = new ApiToolIntegrationService();
    this.toolManager = new ToolManager(this.serverManager, this.groupManager, this.apiToolService);
    this.messageAudit = new MessageAuditService();
    this.healthMonitor = new HealthMonitorService(
      this.serverManager,
      this.groupManager,
      async () => {
        // 健康检查回调：清理工具缓存
        if (this.toolManager && typeof this.toolManager.clearCache === 'function') {
          this.toolManager.clearCache();
          logger.debug('Tool cache cleared due to server disconnections');
        }
      },
    );

    // Set up message tracking
    this.serverManager.setMessageTracker((serverId, type, method, content) => {
      this.messageAudit.addMessage(serverId, type, method, content);
    });
  }

  // ========== Lifecycle ==========

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('McpKnotService already initialized, skipping re-initialization');
      return;
    }

    const initStartTime = Date.now();
    logger.info('Starting MCP Knot Service initialization', {
      serverCount: Object.keys(this.serverConfigs).length,
      groupCount: Object.keys(this.groupConfigs).length,
      timestamp: new Date().toISOString(),
    });

    try {
      logger.debug('Initializing server manager');
      await this.serverManager.initialize();

      const connectedServers = this.getConnectedServerCount();
      logger.info('Server manager initialized', {
        totalServers: Object.keys(this.serverConfigs).length,
        connectedServers,
        failedServers: Object.keys(this.serverConfigs).length - connectedServers,
      });

      // P5: 启动上游工具集变更轮询兜底（仅对已连接 server）。
      // listChanged 实时路径已在 ServerManager.connectServer 注册 handler；
      // 轮询作为兜底，覆盖不支持 listChanged 推送的上游。
      //
      // P5 修复（代码审查 C1）：subscriptions.enabled=false 时 detector 未构造，
      // 跳过 startPolling（subscriptions 链路全关）。
      const connectedServerIds = Array.from(this.serverManager.getAllServers().keys()).filter(
        (id) => this.serverManager.getServerStatus(id) === ServerStatus.CONNECTED,
      );
      if (this.subscriptionsEnabled && this.changeDetector && connectedServerIds.length > 0) {
        await this.changeDetector.startPolling(async (serverId) => {
          const tools = await this.serverManager.refetchServerTools(serverId);
          return tools.map((t) => ({ name: t.name }));
        }, connectedServerIds);
        logger.info('上游工具集变更轮询已启动（P5）', {
          pollIntervalMs: this.subscriptionsPollIntervalMs,
          serverCount: connectedServerIds.length,
        });
      } else if (!this.subscriptionsEnabled) {
        logger.info('subscriptions.enabled=false，跳过上游工具集变更轮询与 fan-out（P5）');
      }

      logger.debug('Initializing group manager');
      await this.groupManager.initialize();

      const loadedGroups = this.groupManager.getAllGroups().size;
      logger.info('Group manager initialized', {
        totalGroups: Object.keys(this.groupConfigs).length,
        loadedGroups,
        failedGroups: Object.keys(this.groupConfigs).length - loadedGroups,
      });

      logger.debug('Initializing API tool integration service');
      await this.apiToolService.initialize(this.apiToolConfigPath);

      const apiToolStats = await this.apiToolService.getStats();
      logger.info('API tool integration service initialized', {
        apiToolsEnabled: apiToolStats.initialized,
        totalApiTools: apiToolStats.totalApiTools,
      });

      await this.validateServiceHealth();

      this.isInitialized = true;
      this.healthMonitor.markInitialized();
      this.healthMonitor.start();

      const initDuration = Date.now() - initStartTime;
      logger.info('MCP Knot Service initialization completed successfully', {
        connectedServers,
        loadedGroups,
        initializationTimeMs: initDuration,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const initDuration = Date.now() - initStartTime;
      logger.error('MCP Knot Service initialization failed', error as Error, {
        initializationTimeMs: initDuration,
        serverCount: Object.keys(this.serverConfigs).length,
        groupCount: Object.keys(this.groupConfigs).length,
      });

      await this.cleanupFailedInitialization();

      throw new ConfigError(
        ErrorCode.SERVER_STARTUP_FAILED,
        (error as Error).message,
        error as Error,
      );
    }
  }

  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      logger.warn('MCP Knot Service not initialized, skipping shutdown');
      return;
    }

    if (this.shutdownInProgress) {
      logger.warn('Shutdown already in progress, waiting for completion');
      return;
    }

    this.shutdownInProgress = true;
    const shutdownStartTime = Date.now();

    logger.info('Starting graceful MCP Knot Service shutdown', {
      timestamp: new Date().toISOString(),
      connectedServers: this.getConnectedServerCount(),
    });

    const errors: Error[] = [];

    try {
      this.healthMonitor.stop();
      this.messageAudit.clearMessages();

      const shutdownPromise = this.performGracefulShutdown();
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Shutdown timeout')), 10000);
        timeoutId.unref?.();
      });

      await Promise.race([shutdownPromise, timeoutPromise]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      const shutdownError = error as Error;
      logger.error('Error during graceful shutdown', shutdownError);
      errors.push(shutdownError);

      try {
        logger.warn('Attempting force shutdown due to graceful shutdown failure');
        await this.performForceShutdown();
      } catch (forceError) {
        logger.error('Force shutdown also failed', forceError as Error);
        errors.push(forceError as Error);
      }
    }

    this.isInitialized = false;
    this.shutdownInProgress = false;

    const shutdownDuration = Date.now() - shutdownStartTime;

    if (errors.length > 0) {
      logger.error(
        'MCP Knot Service shutdown completed with errors',
        new Error('Shutdown errors occurred'),
        {
          shutdownTimeMs: shutdownDuration,
          errorCount: errors.length,
          errors: errors.map((e) => e.message),
        },
      );

      throw new ServiceError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        `Shutdown completed with ${errors.length} errors: ${errors.map((e) => e.message).join(', ')}`,
        undefined,
        { errorCount: errors.length, shutdownTimeMs: shutdownDuration },
      );
    }
    logger.info('MCP Knot Service shutdown completed successfully', {
      shutdownTimeMs: shutdownDuration,
      timestamp: new Date().toISOString(),
    });
  }

  // ========== Group Routing ==========

  getAllGroups(): Map<string, Group> {
    this.ensureInitialized();
    return this.groupManager.getAllGroups();
  }

  getGroupInfo(groupId: string): Group | undefined {
    this.ensureInitialized();

    try {
      const group = this.groupManager.getGroup(groupId);

      if (group) {
        const availableServers = this.groupManager.getGroupServers(groupId);
        const connectedServers = availableServers.filter((serverId) => {
          const server = this.serverManager.getAllServers().get(serverId);
          return server?.status === ServerStatus.CONNECTED;
        });

        logger.debug('Group information retrieved successfully', {
          groupId,
          groupName: group.name,
          configuredServers: group.servers.length,
          availableServers: availableServers.length,
          connectedServers: connectedServers.length,
          configuredTools: group.tools.length,
        });
      } else {
        logger.warn('Group information request for non-existent group', {
          groupId,
          availableGroups: Array.from(this.groupManager.getAllGroups().keys()),
        });
      }

      return group;
    } catch (error) {
      logger.error('Error retrieving group information', error as Error, {
        groupId,
      });
      return undefined;
    }
  }

  // ========== Tool Execution ==========

  async listTools(groupId?: string): Promise<Tool[]> {
    this.ensureInitialized();

    const targetGroupId = groupId || this.DEFAULT_GROUP;
    const operationId = `list-tools-${targetGroupId}-${Date.now()}`;

    logger.debug('Starting tool listing operation', {
      operationId,
      groupId: targetGroupId,
      timestamp: new Date().toISOString(),
    });

    try {
      if (!this.groupManager.getGroup(targetGroupId)) {
        logger.warn('Tool listing failed: group not found', {
          operationId,
          groupId: targetGroupId,
          availableGroups: Array.from(this.groupManager.getAllGroups().keys()),
        });
        throw new ServiceError(
          ErrorCode.GROUP_NOT_FOUND,
          `Group '${targetGroupId}' not found`,
          undefined,
          { groupId: targetGroupId },
        );
      }

      const startTime = Date.now();
      const tools = await this.toolManager.getToolsForGroup(targetGroupId);
      const duration = Date.now() - startTime;

      logger.info('Tools listed successfully', {
        operationId,
        groupId: targetGroupId,
        toolCount: tools.length,
        durationMs: duration,
        toolNames: tools.map((t) => t.name),
      });

      return tools;
    } catch (error) {
      logger.error('Tool listing operation failed', error as Error, {
        operationId,
        groupId: targetGroupId,
        errorType: (error as Error).constructor.name,
      });

      if (error instanceof ServiceError) {
        throw error;
      }

      throw new ServiceError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        `Failed to list tools for group '${targetGroupId}': ${(error as Error).message}`,
        undefined,
        { groupId: targetGroupId, originalError: (error as Error).message },
      );
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    groupId?: string,
  ): Promise<ToolResult> {
    this.ensureInitialized();

    const targetGroupId = groupId || this.DEFAULT_GROUP;
    const executionId = `exec-${targetGroupId}-${toolName}-${Date.now()}`;

    logger.logToolExecution(toolName, targetGroupId, 'started', {
      executionId,
      args,
      timestamp: new Date().toISOString(),
    });

    try {
      await this.validateToolExecution(toolName, targetGroupId, executionId);

      const startTime = Date.now();
      // executeTool 在内部已用 try/catch 吸收 v2 的未知工具 -32602 rejection，
      // 统一返回带 isError 的 ToolResult，不会在此处抛错。
      const result = await this.toolManager.executeTool(targetGroupId, toolName, args);
      const duration = Date.now() - startTime;

      // 此处读取 isError 仅判断工具内部执行失败（v2 下仍保留 isError 语义），
      // 与 v2 的"未知工具抛 -32602"路径无关——后者已在 executeTool 内部被吸收。
      const status = result.isError ? 'failed' : 'completed';
      logger.logToolExecution(toolName, targetGroupId, status, {
        executionId,
        durationMs: duration,
        resultSize: JSON.stringify(result.content).length,
        contentTypes: result.content.map((c: { type: string }) => c.type || 'unknown'),
      });

      if (result.isError) {
        logger.warn('Tool execution completed with error result', {
          executionId,
          toolName,
          groupId: targetGroupId,
          errorContent: result.content,
        });
      }

      return result;
    } catch (error) {
      logger.logToolExecution(toolName, targetGroupId, 'failed', {
        executionId,
        error: (error as Error).message,
        errorType: (error as Error).constructor.name,
      });

      logger.error('Tool execution failed with exception', error as Error, {
        executionId,
        toolName,
        groupId: targetGroupId,
        args,
        serviceHealth: this.getServiceHealthSummary(),
      });

      throw new ToolExecutionError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        `Tool execution failed: ${(error as Error).message}`,
        {
          toolName,
          groupId: targetGroupId,
          executionId,
          originalError: (error as Error).message,
        },
      );
    }
  }

  async isToolAvailable(toolName: string, groupId?: string): Promise<boolean> {
    this.ensureInitialized();

    const targetGroupId = groupId || this.DEFAULT_GROUP;

    try {
      const tools = await this.listTools(targetGroupId);
      return tools.some((tool) => tool.name === toolName);
    } catch (error) {
      logger.error('Error checking tool availability', error as Error, {
        toolName,
        groupId: targetGroupId,
      });
      return false;
    }
  }

  async getToolDetails(toolName: string, groupId?: string): Promise<Tool | null> {
    this.ensureInitialized();

    const targetGroupId = groupId || this.DEFAULT_GROUP;

    try {
      const tools = await this.listTools(targetGroupId);
      return tools.find((tool) => tool.name === toolName) || null;
    } catch (error) {
      logger.error('Error getting tool details', error as Error, {
        toolName,
        groupId: targetGroupId,
      });
      return null;
    }
  }

  // ========== Health & Status ==========

  getServerHealth(): Map<string, ServerStatus> {
    this.ensureInitialized();

    const healthMap = new Map<string, ServerStatus>();
    const allServers = this.serverManager.getAllServers();

    for (const [serverId, server] of allServers) {
      healthMap.set(serverId, server.status);
    }

    return healthMap;
  }

  getServiceStatus(): {
    isInitialized: boolean;
    serverCount: number;
    connectedServers: number;
    groupCount: number;
    totalTools: number;
  } {
    const serverHealth = this.isInitialized ? this.getServerHealth() : new Map();
    const connectedServers = Array.from(serverHealth.values()).filter(
      (status) => status === ServerStatus.CONNECTED,
    ).length;

    return {
      isInitialized: this.isInitialized,
      serverCount: Object.keys(this.serverConfigs).length,
      connectedServers,
      groupCount: this.isInitialized ? this.groupManager.getAllGroups().size : 0,
      totalTools: 0,
    };
  }

  async getDetailedServiceStatus(): Promise<{
    isInitialized: boolean;
    serverCount: number;
    connectedServers: number;
    groupCount: number;
    totalTools: number;
    apiTools: number;
  }> {
    const serverHealth = this.isInitialized ? this.getServerHealth() : new Map();
    const connectedServers = Array.from(serverHealth.values()).filter(
      (status) => status === ServerStatus.CONNECTED,
    ).length;

    let apiToolCount = 0;
    if (this.isInitialized) {
      try {
        const apiStats = await this.apiToolService.getStats();
        apiToolCount = apiStats.totalApiTools;
      } catch (error) {
        logger.warn('获取API工具统计失败', {
          error: (error as Error).message,
        });
      }
    }

    let totalMcpTools = 0;
    if (this.isInitialized) {
      try {
        const tools = await this.listTools();
        totalMcpTools = tools.length - apiToolCount;
      } catch (error) {
        logger.warn('获取MCP工具统计失败', {
          error: (error as Error).message,
        });
      }
    }

    return {
      isInitialized: this.isInitialized,
      serverCount: Object.keys(this.serverConfigs).length,
      connectedServers,
      groupCount: this.isInitialized ? this.groupManager.getAllGroups().size : 0,
      totalTools: totalMcpTools + apiToolCount,
      apiTools: apiToolCount,
    };
  }

  getApiToolServiceHealth(): {
    initialized: boolean;
    healthy: boolean;
    serviceStatus?: string;
    errors?: string[];
  } {
    this.ensureInitialized();

    try {
      return this.apiToolService.getHealthStatus();
    } catch (error) {
      logger.error('Error getting API tool service health', error as Error);
      return {
        initialized: false,
        healthy: false,
        errors: [`获取API工具服务健康状态失败: ${(error as Error).message}`],
      };
    }
  }

  async performApiToolHealthCheck(): Promise<{
    initialized: boolean;
    healthy: boolean;
    serviceStatus?: string;
    errors?: string[];
  }> {
    this.ensureInitialized();

    try {
      return await this.apiToolService.performHealthCheck();
    } catch (error) {
      logger.error('Error performing API tool health check', error as Error);
      return {
        initialized: false,
        healthy: false,
        errors: [`API工具健康检查失败: ${(error as Error).message}`],
      };
    }
  }

  async reloadApiToolConfig(): Promise<void> {
    this.ensureInitialized();
    logger.info('重新加载API工具配置');

    try {
      await this.apiToolService.reloadConfig();
      logger.info('API工具配置重新加载完成');
    } catch (error) {
      logger.error('重新加载API工具配置失败', error as Error);
      throw error;
    }
  }

  async getServiceDiagnostics(): Promise<{
    service: {
      isInitialized: boolean;
      uptime: number;
      version: string;
    };
    servers: {
      total: number;
      connected: number;
      failed: number;
      details: Array<{
        id: string;
        status: string;
        lastConnected?: string;
        error?: string;
        toolCount: number;
      }>;
    };
    groups: {
      total: number;
      loaded: number;
      details: Array<{
        id: string;
        name: string;
        serverCount: number;
        toolCount: number;
        isHealthy: boolean;
      }>;
    };
    apiTools: {
      initialized: boolean;
      healthy: boolean;
      totalTools: number;
      errors: string[];
    };
    performance: {
      cacheStats: Record<string, unknown>;
    };
  }> {
    this.ensureInitialized();

    try {
      const allServers = this.serverManager.getAllServers();
      const allGroups = this.groupManager.getAllGroups();

      const serverDetails = Array.from(allServers.entries()).map(([id, server]) => ({
        id,
        status: server.status,
        lastConnected: server.lastConnected?.toISOString(),
        error: server.lastError?.message,
        toolCount: server.tools.length,
      }));

      const connectedServers = serverDetails.filter(
        (s) => s.status === ServerStatus.CONNECTED,
      ).length;
      const failedServers = serverDetails.filter((s) => s.status === ServerStatus.ERROR).length;

      const groupDetails = await Promise.all(
        Array.from(allGroups.entries()).map(async ([id, group]) => {
          try {
            const tools = await this.toolManager.getToolsForGroup(id);
            return {
              id,
              name: group.name,
              serverCount: group.servers.length,
              toolCount: tools.length,
              isHealthy: tools.length > 0,
            };
          } catch (_error) {
            return {
              id,
              name: group.name,
              serverCount: group.servers.length,
              toolCount: 0,
              isHealthy: false,
            };
          }
        }),
      );

      const cacheStats = this.toolManager.getCacheStats();

      let apiToolDiagnostics = {
        initialized: false,
        healthy: false,
        totalTools: 0,
        errors: [] as string[],
      };

      try {
        const apiHealth = await this.apiToolService.performHealthCheck();
        const apiStats = await this.apiToolService.getStats();
        apiToolDiagnostics = {
          initialized: apiHealth.initialized,
          healthy: apiHealth.healthy,
          totalTools: apiStats.totalApiTools,
          errors: apiHealth.errors || [],
        };
      } catch (error) {
        apiToolDiagnostics.errors.push(`API工具诊断失败: ${(error as Error).message}`);
      }

      const diagnostics = {
        service: {
          isInitialized: this.isInitialized,
          uptime: process.uptime(),
          version: '1.0.0',
        },
        servers: {
          total: allServers.size,
          connected: connectedServers,
          failed: failedServers,
          details: serverDetails,
        },
        groups: {
          total: allGroups.size,
          loaded: allGroups.size,
          details: groupDetails,
        },
        apiTools: apiToolDiagnostics,
        performance: {
          cacheStats,
        },
      };

      logger.info('Service diagnostics generated', {
        serverCount: diagnostics.servers.total,
        connectedServers: diagnostics.servers.connected,
        groupCount: diagnostics.groups.total,
      });

      return diagnostics;
    } catch (error) {
      logger.error('Failed to generate service diagnostics', error as Error);
      throw new ServiceError(ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to generate diagnostics', {
        originalError: (error as Error).message,
      });
    }
  }

  setHealthMonitoring(enabled: boolean): void {
    this.healthMonitor.setEnabled(enabled);
  }

  getLifecycleStatus(): {
    isInitialized: boolean;
    shutdownInProgress: boolean;
    healthMonitoringEnabled: boolean;
    uptime: number;
    lastHealthCheck?: string;
    initializationTime?: string;
  } {
    const lifecycle = this.healthMonitor.getLifecycleStatus();
    return {
      ...lifecycle,
      shutdownInProgress: this.shutdownInProgress,
    };
  }

  async triggerHealthCheck(): Promise<void> {
    this.ensureInitialized();
    await this.healthMonitor.triggerCheck();
  }

  // ========== Message Audit (delegated) ==========

  addMcpMessage(
    serverId: string,
    type: 'request' | 'response' | 'notification',
    method: string,
    content: unknown,
  ): void {
    this.messageAudit.addMessage(serverId, type, method, content);
  }

  getMcpMessages(
    limit?: number,
    serverId?: string,
    type?: 'request' | 'response' | 'notification',
  ): Array<{
    id: string;
    timestamp: string;
    serverId: string;
    type: 'request' | 'response' | 'notification';
    method: string;
    content: unknown;
  }> {
    return this.messageAudit.getMessages(limit, serverId, type);
  }

  clearMcpMessages(): void {
    this.messageAudit.clearMessages();
  }

  getPerformanceStats(): {
    totalRequests: number;
    averageResponseTime: number;
    errorRate: number;
    topTools: Array<{ name: string; calls: number; avgTime: number }>;
  } {
    return this.messageAudit.getPerformanceStats();
  }

  // ========== P5: Subscriptions fan-out helpers ==========
  //
  // 以下三个方法是 UpstreamChangeFanout 回调的实现。
  // 它们桥接 ServerManager（上游工具）/ GroupManager（group-server 映射）/
  // mcp-handler-factory 缓存（GroupMcpService + McpHttpHandler）。
  //
  // mcp-handler-factory 的 groupServices/groupHandlers 缓存按 groupId 惰性创建，
  // 故此处动态 import 访问，避免模块加载期循环依赖。

  /**
   * 返回所有「servers 包含 serverId」的 group。
   * fanout 据此把单 server 变更 fan-out 到受影响的 group 集合。
   */
  private getGroupsForServer(serverId: string): { groupId: string }[] {
    const groups: { groupId: string }[] = [];
    for (const [groupId, group] of this.groupManager.getAllGroups()) {
      if (group.servers.includes(serverId)) {
        groups.push({ groupId });
      }
    }
    return groups;
  }

  /**
   * 刷新指定 group 内指定 server 的工具注册。
   * 先 refetch 上游工具（更新 ServerManager 缓存 + 快照），再调 GroupMcpService.refreshTools。
   * GroupMcpService 由 mcp-handler-factory 惰性创建并缓存——未初始化的 group 跳过
   * （惰性 group 此时无客户端持有，下次 tools/list 时按最新缓存重建）。
   */
  private async refreshGroupTools(groupId: string, serverId: string): Promise<void> {
    // 1. refetch 上游工具，更新缓存（saveSnapshot 由 refetchServerTools 内完成）
    await this.serverManager.refetchServerTools(serverId);

    // 2. 通知已初始化的 GroupMcpService 重新注册该 server 工具
    const { getGroupServicesCache } = await import('../api/mcp/mcp-handler-factory.js');
    const groupService = getGroupServicesCache().get(groupId);
    if (groupService) {
      await groupService.refreshTools(serverId);
    }
  }

  /**
   * 在该 group 的 McpHttpHandler bus 上发布 tools_list_changed 事件，
   * 经 subscriptions/listen stream 推送给已订阅客户端。
   * handler 未创建（无活跃 listen）时为 no-op。
   *
   * 使用 handler.notify.toolsChanged()（SDK 提供的类型化 publish sugar），
   * 等价于 bus.publish({ kind: 'tools_list_changed' })。
   */
  private publishToolListChanged(groupId: string): void {
    void (async () => {
      try {
        const { getGroupHandlersCache } = await import('../api/mcp/mcp-handler-factory.js');
        const handler = getGroupHandlersCache().get(groupId);
        // notify 在无 open subscription 时为 no-op（SDK 保证）
        handler?.notify.toolsChanged();
      } catch (error) {
        logger.warn('publishToolListChanged 失败', {
          groupId,
          error: (error as Error).message,
        });
      }
    })();
  }

  // ========== Utility ==========

  public static formatErrorResponse(error: Error): {
    error: {
      code: string;
      message: string;
      context?: Record<string, unknown>;
    };
  } {
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message,
      },
    };
  }

  // ========== Private Helpers ==========

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new ServiceError(
        ErrorCode.SERVICE_UNAVAILABLE,
        'McpKnotService must be initialized before use',
      );
    }
  }

  private getConnectedServerCount(): number {
    const allServers = this.serverManager.getAllServers();
    return Array.from(allServers.values()).filter(
      (server) => server.status === ServerStatus.CONNECTED,
    ).length;
  }

  private async validateServiceHealth(): Promise<void> {
    logger.debug('Validating service health after initialization');

    const issues: string[] = [];
    const warnings: string[] = [];

    const connectedServers = this.getConnectedServerCount();
    const totalServers = Object.keys(this.serverConfigs).length;

    if (connectedServers === 0) {
      warnings.push('No servers are connected - service will have limited functionality');
    } else if (connectedServers < totalServers) {
      warnings.push(`Only ${connectedServers} of ${totalServers} servers are connected`);
    }

    const loadedGroups = this.groupManager.getAllGroups().size;
    const totalGroups = Object.keys(this.groupConfigs).length;

    if (loadedGroups === 0 && totalGroups > 0) {
      issues.push('No groups are loaded');
    } else if (loadedGroups < totalGroups) {
      warnings.push(`Only ${loadedGroups} of ${totalGroups} groups are loaded`);
    }

    if (issues.length > 0) {
      logger.error(
        'Service health validation failed',
        new Error('Critical health issues detected'),
        {
          issues,
          warnings,
          connectedServers,
          totalServers,
          loadedGroups,
          totalGroups,
        },
      );
      throw new ConfigError(
        ErrorCode.SERVER_STARTUP_FAILED,
        `Critical health issues: ${issues.join(', ')}`,
      );
    }

    if (warnings.length > 0) {
      logger.warn('Service health validation completed with warnings', {
        warnings,
        connectedServers,
        totalServers,
        loadedGroups,
        totalGroups,
      });
    } else {
      logger.info('Service health validation passed', {
        connectedServers,
        totalServers,
        loadedGroups,
        totalGroups,
      });
    }
  }

  private async cleanupFailedInitialization(): Promise<void> {
    logger.debug('Cleaning up after failed initialization');

    try {
      if (this.serverManager) {
        await this.serverManager.shutdown();
      }
      logger.debug('Cleanup completed successfully');
    } catch (cleanupError) {
      logger.error('Error during initialization cleanup', cleanupError as Error);
    }
  }

  private async validateToolExecution(
    toolName: string,
    groupId: string,
    executionId: string,
  ): Promise<void> {
    logger.debug('Validating tool execution prerequisites', {
      executionId,
      toolName,
      groupId,
    });

    const group = this.groupManager.getGroup(groupId);
    if (!group) {
      throw new ServiceError(ErrorCode.GROUP_NOT_FOUND, `Group '${groupId}' not found`, undefined, {
        groupId,
      });
    }

    const isAvailable = await this.isToolAvailable(toolName, groupId);
    if (!isAvailable) {
      throw new ToolExecutionError(
        ErrorCode.TOOL_NOT_FOUND,
        `Tool '${toolName}' not found in group '${groupId}'`,
        { toolName, groupId },
      );
    }

    const availableServers = this.groupManager.getGroupServers(groupId);
    const connectedServers = availableServers.filter((serverId) => {
      const server = this.serverManager.getAllServers().get(serverId);
      return server?.status === ServerStatus.CONNECTED;
    });

    if (connectedServers.length === 0) {
      throw new ServiceError(
        ErrorCode.SERVER_UNAVAILABLE,
        `No servers are available in group '${groupId}'`,
        { groupId, availableServers, connectedServers },
      );
    }

    logger.debug('Tool execution validation passed', {
      executionId,
      toolName,
      groupId,
      availableServers: availableServers.length,
      connectedServers: connectedServers.length,
    });
  }

  private getServiceHealthSummary(): Record<string, unknown> {
    try {
      const serverHealth = this.getServerHealth();
      const connectedServers = Array.from(serverHealth.values()).filter(
        (status) => status === ServerStatus.CONNECTED,
      ).length;

      return {
        isInitialized: this.isInitialized,
        totalServers: serverHealth.size,
        connectedServers,
        totalGroups: this.groupManager.getAllGroups().size,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        error: 'Failed to get health summary',
        message: (error as Error).message,
      };
    }
  }

  private async performGracefulShutdown(): Promise<void> {
    logger.debug('Performing graceful shutdown');

    // P5: 停止上游变更轮询与 fan-out（避免 shutdown 期间触发 fanout）。
    // changeDetector/changeFanout 在 subscriptions.enabled=false 时未构造，判空调用。
    // P5 修复（代码审查 I3）：额外调 changeFanout.stop() 清空 pending debounce timer，
    // 防止泄漏的 timer 在 shutdown 后触发 fan-out（访问已关闭的 group service）。
    this.changeDetector?.stop();
    this.changeFanout?.stop();

    try {
      await this.apiToolService.shutdown();
      logger.debug('API tool service shutdown completed');
    } catch (error) {
      logger.error('API tool service shutdown failed', error as Error);
    }

    await this.serverManager.shutdown();
    logger.debug('Graceful shutdown completed');
  }

  private async performForceShutdown(): Promise<void> {
    logger.debug('Performing force shutdown');

    try {
      const allServers = this.serverManager.getAllServers();
      const forceClosePromises = Array.from(allServers.values()).map(async (server) => {
        try {
          if (server.client && typeof server.client.close === 'function') {
            let timeoutId: NodeJS.Timeout | undefined;
            await Promise.race([
              server.client.close(),
              new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Force close timeout')), 2000);
                timeoutId.unref?.();
              }),
            ]);
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }
        } catch (error) {
          logger.debug('Force close server connection failed', {
            serverId: server.id,
            error: (error as Error).message,
          });
        }
      });

      await Promise.allSettled(forceClosePromises);
      logger.debug('Force shutdown completed');
    } catch (error) {
      logger.error('Force shutdown failed', error as Error);
      throw error;
    }
  }
}
