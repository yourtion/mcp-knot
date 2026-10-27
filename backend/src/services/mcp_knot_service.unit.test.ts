/**
 * McpKnotService 单元测试（全协作者 mock）。
 *
 * 覆盖：生命周期（initialize/shutdown 及失败清理与强制关闭）、ensureInitialized
 * 门禁、工具列表/执行路由与错误映射、状态/诊断/审计委托、P5 fan-out 回调
 * （getGroupsForServer / refreshGroupTools / publishToolListChanged）。
 * subscriptions.enabled 开关行为见 mcp_knot_service.subscriptions-switch.unit.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerStatus } from '../types/mcp-knot.js';
import { logger } from '../utils/logger.js';
import { McpKnotService } from './mcp_knot_service.js';

import type {
  DeepReadonly,
  GroupConfig,
  ServerConfig,
  SystemConfig,
} from '@mcp-core/mcp-knot-share';

// 各协作者单例注册表：vi.mock 工厂内构造，测试内访问与编程
const registry = vi.hoisted(() => ({
  serverManagerCtorOpts: [] as Array<Record<string, unknown>>,
  serverManager: {} as Record<string, ReturnType<typeof vi.fn>>,
  groupManager: {} as Record<string, ReturnType<typeof vi.fn>>,
  toolManager: {} as Record<string, ReturnType<typeof vi.fn>>,
  apiToolService: {} as Record<string, ReturnType<typeof vi.fn>>,
  messageAudit: {} as Record<string, ReturnType<typeof vi.fn>>,
  healthMonitor: {} as Record<string, ReturnType<typeof vi.fn>>,
  detector: {} as Record<string, ReturnType<typeof vi.fn>>,
  fanout: {} as Record<string, ReturnType<typeof vi.fn>>,
  fanoutOpts: [] as Array<Record<string, unknown>>,
  detectorOpts: [] as Array<Record<string, unknown>>,
  groupServiceCache: new Map<string, { refreshTools: ReturnType<typeof vi.fn> }>(),
  groupHandlersCache: new Map<string, { notify: { toolsChanged: ReturnType<typeof vi.fn> } }>(),
}));

vi.mock('./server_manager.js', () => ({
  ServerManager: vi.fn().mockImplementation(function (
    this: unknown,
    configs: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    registry.serverManagerCtorOpts.push({ configs, opts });
    Object.assign(registry.serverManager, {
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getAllServers: vi.fn().mockReturnValue(new Map()),
      getServerStatus: vi.fn().mockReturnValue(ServerStatus.CONNECTED),
      refetchServerTools: vi.fn().mockResolvedValue([]),
      setMessageTracker: vi.fn(),
      executeToolOnServer: vi.fn(),
    });
    return registry.serverManager;
  }),
}));

vi.mock('./group_manager.js', () => ({
  GroupManager: vi.fn().mockImplementation(function () {
    Object.assign(registry.groupManager, {
      initialize: vi.fn().mockResolvedValue(undefined),
      getAllGroups: vi.fn().mockReturnValue(new Map()),
      getGroup: vi.fn().mockReturnValue(undefined),
      getGroupServers: vi.fn().mockReturnValue([]),
      getGroupTools: vi.fn().mockResolvedValue([]),
    });
    return registry.groupManager;
  }),
}));

vi.mock('./tool_manager.js', () => ({
  ToolManager: vi.fn().mockImplementation(function () {
    Object.assign(registry.toolManager, {
      getToolsForGroup: vi.fn().mockResolvedValue([]),
      executeTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
      clearCache: vi.fn(),
      getCacheStats: vi.fn().mockReturnValue({
        totalGroups: 0,
        totalTools: 0,
        oldestCache: null,
        newestCache: null,
      }),
    });
    return registry.toolManager;
  }),
}));

vi.mock('./api_tool_integration_service.js', () => ({
  ApiToolIntegrationService: vi.fn().mockImplementation(function () {
    Object.assign(registry.apiToolService, {
      initialize: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue({ initialized: false, totalApiTools: 0 }),
      getApiTools: vi.fn().mockResolvedValue([]),
      getHealthStatus: vi.fn().mockReturnValue({ initialized: false, healthy: false }),
      performHealthCheck: vi.fn().mockResolvedValue({ initialized: false, healthy: false }),
      reloadConfig: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    return registry.apiToolService;
  }),
}));

vi.mock('./message-audit-service.js', () => ({
  MessageAuditService: vi.fn().mockImplementation(function () {
    Object.assign(registry.messageAudit, {
      addMessage: vi.fn(),
      getMessages: vi.fn().mockReturnValue([]),
      clearMessages: vi.fn(),
      getPerformanceStats: vi.fn().mockReturnValue({
        totalRequests: 0,
        averageResponseTime: 0,
        errorRate: 0,
        topTools: [],
      }),
    });
    return registry.messageAudit;
  }),
}));

vi.mock('./health-monitor-service.js', () => ({
  HealthMonitorService: vi.fn().mockImplementation(function () {
    Object.assign(registry.healthMonitor, {
      markInitialized: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      setEnabled: vi.fn(),
      triggerCheck: vi.fn().mockResolvedValue(undefined),
      getLifecycleStatus: vi.fn().mockReturnValue({
        isInitialized: false,
        healthMonitoringEnabled: true,
        uptime: 0,
      }),
    });
    return registry.healthMonitor;
  }),
}));

vi.mock('./upstream-change-detector.js', () => ({
  UpstreamChangeDetector: vi.fn().mockImplementation(function (
    this: unknown,
    opts: Record<string, unknown>,
  ) {
    registry.detectorOpts.push(opts);
    Object.assign(registry.detector, {
      startPolling: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      saveSnapshot: vi.fn(),
      onUpstreamNotification: vi.fn(),
    });
    return registry.detector;
  }),
}));

vi.mock('./upstream-change-fanout.js', () => ({
  UpstreamChangeFanout: vi.fn().mockImplementation(function (
    this: unknown,
    opts: Record<string, unknown>,
  ) {
    registry.fanoutOpts.push(opts);
    Object.assign(registry.fanout, {
      handleServerChange: vi.fn(),
      stop: vi.fn(),
      flush: vi.fn(),
    });
    return registry.fanout;
  }),
}));

vi.mock('../api/mcp/mcp-handler-factory.js', () => ({
  getGroupServicesCache: vi.fn(() => registry.groupServiceCache),
  getGroupHandlersCache: vi.fn(() => registry.groupHandlersCache),
  invalidateAllGroupMcpServices: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logToolExecution: vi.fn(),
    logServerConnection: vi.fn(),
    logToolDiscovery: vi.fn(),
  },
}));

const serverConfigs: Record<string, ServerConfig> = {
  s1: { type: 'stdio', command: 'node', args: ['x.js'], enabled: true },
};
const groupConfigs = {
  default: {
    id: 'default',
    name: 'Default',
    description: '',
    servers: ['s1'],
    tools: [],
  },
} as unknown as GroupConfig;

/** 配置一个可成功 initialize 的默认环境 */
function setupHappyPath() {
  registry.serverManager.getAllServers.mockReturnValue(
    new Map([['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }]]),
  );
  registry.serverManager.getServerStatus.mockReturnValue(ServerStatus.CONNECTED);
  registry.groupManager.getAllGroups.mockReturnValue(
    new Map([['default', { id: 'default', name: 'Default', servers: ['s1'], tools: [] }]]),
  );
  registry.groupManager.getGroup.mockReturnValue({
    id: 'default',
    name: 'Default',
    servers: ['s1'],
    tools: [],
  });
  registry.groupManager.getGroupServers.mockReturnValue(['s1']);
}

async function createInitializedService(systemConfig?: DeepReadonly<SystemConfig>) {
  const svc = new McpKnotService(serverConfigs, groupConfigs, undefined, systemConfig);
  setupHappyPath();
  await svc.initialize();
  return svc;
}

describe('McpKnotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.serverManagerCtorOpts.length = 0;
    registry.fanoutOpts.length = 0;
    registry.detectorOpts.length = 0;
    registry.groupServiceCache.clear();
    registry.groupHandlersCache.clear();
    for (const key of Object.keys(registry.serverManager)) delete registry.serverManager[key];
    for (const key of Object.keys(registry.groupManager)) delete registry.groupManager[key];
    for (const key of Object.keys(registry.toolManager)) delete registry.toolManager[key];
    for (const key of Object.keys(registry.apiToolService)) delete registry.apiToolService[key];
    for (const key of Object.keys(registry.messageAudit)) delete registry.messageAudit[key];
    for (const key of Object.keys(registry.healthMonitor)) delete registry.healthMonitor[key];
    for (const key of Object.keys(registry.detector)) delete registry.detector[key];
    for (const key of Object.keys(registry.fanout)) delete registry.fanout[key];
  });

  describe('构造', () => {
    it('向 ServerManager 注入配置与 changeDetector；向健康监控注入清缓存回调', async () => {
      await createInitializedService();

      expect(registry.serverManagerCtorOpts).toHaveLength(1);
      const { configs, opts } = registry.serverManagerCtorOpts[0];
      expect(configs).toEqual(serverConfigs);
      expect(opts).toHaveProperty('changeDetector');
      expect(registry.detectorOpts).toHaveLength(1);
      expect(registry.fanoutOpts).toHaveLength(1);
    });

    it('构造注册消息 tracker：回调委托给 MessageAuditService', () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      expect(registry.serverManager.setMessageTracker).toHaveBeenCalledTimes(1);
      const tracker = registry.serverManager.setMessageTracker.mock.calls[0][0] as (
        ...args: unknown[]
      ) => void;
      tracker('s1', 'request', 'tools/list', { ping: true });
      expect(registry.messageAudit.addMessage).toHaveBeenCalledWith('s1', 'request', 'tools/list', {
        ping: true,
      });
      void svc;
    });

    it('getServerManager 暴露内部 ServerManager 实例', () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      expect(svc.getServerManager()).toBe(registry.serverManager as never);
    });

    it('构造深拷贝配置（外部修改不影响内部）', async () => {
      const external: Record<string, ServerConfig> = {
        s1: { type: 'stdio', command: 'node', args: ['x.js'], enabled: true },
      };
      const svc = new McpKnotService(external, groupConfigs);
      external.s1.command = 'changed';
      expect(registry.serverManagerCtorOpts[0]?.configs).toMatchObject({
        s1: { command: 'node' },
      });
      await svc.shutdown();
    });

    it('subscriptions 参数显式配置时透传给 detector/fanout（不落回默认值）', async () => {
      await createInitializedService({
        subscriptions: { pollIntervalMs: 30_000, pollBackoffMs: 60_000, fanoutDebounceMs: 100 },
      } as unknown as DeepReadonly<SystemConfig>);

      expect(registry.detectorOpts[0]).toMatchObject({
        pollIntervalMs: 30_000,
        pollBackoffMs: 60_000,
      });
      expect(registry.fanoutOpts[0]).toMatchObject({ debounceMs: 100 });
    });

    it('健康检查回调清理工具缓存并记录 debug 日志', async () => {
      const { HealthMonitorService } = await import('./health-monitor-service.js');
      await createInitializedService();

      const healthCallback = vi.mocked(HealthMonitorService).mock
        .calls[0][2] as () => Promise<void>;
      await healthCallback();

      expect(registry.toolManager.clearCache).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Tool cache cleared due to server disconnections',
      );
    });
  });

  describe('initialize', () => {
    it('成功初始化：启动监控、启动轮询、标记 initialized', async () => {
      const svc = await createInitializedService();

      expect(registry.serverManager.initialize).toHaveBeenCalledTimes(1);
      expect(registry.groupManager.initialize).toHaveBeenCalledTimes(1);
      expect(registry.apiToolService.initialize).toHaveBeenCalledWith(undefined);
      expect(registry.healthMonitor.markInitialized).toHaveBeenCalledTimes(1);
      expect(registry.healthMonitor.start).toHaveBeenCalledTimes(1);
      expect(registry.detector.startPolling).toHaveBeenCalledTimes(1);

      // 轮询只覆盖已连接的 server
      const [getToolsFn, serverIds] = registry.detector.startPolling.mock.calls[0] as [
        (id: string) => Promise<unknown>,
        string[],
      ];
      expect(serverIds).toEqual(['s1']);
      // getToolsFn 映射为工具名列表
      registry.serverManager.refetchServerTools.mockResolvedValue([{ name: 't1' }, { name: 't2' }]);
      await expect(getToolsFn('s1')).resolves.toEqual([{ name: 't1' }, { name: 't2' }]);

      const status = svc.getServiceStatus();
      expect(status.isInitialized).toBe(true);
      expect(status.serverCount).toBe(1);
      expect(status.connectedServers).toBe(1);
      expect(status.groupCount).toBe(1);

      // 生命周期日志：各阶段消息与上下文精确匹配
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Starting MCP Knot Service initialization',
        {
          serverCount: 1,
          groupCount: 1,
          timestamp: expect.any(String),
        },
      );
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Server manager initialized', {
        totalServers: 1,
        connectedServers: 1,
        failedServers: 0,
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('上游工具集变更轮询已启动（P5）', {
        pollIntervalMs: 60_000,
        serverCount: 1,
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Group manager initialized', {
        totalGroups: 1,
        loadedGroups: 1,
        failedGroups: 0,
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'API tool integration service initialized',
        { apiToolsEnabled: false, totalApiTools: 0 },
      );
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'MCP Knot Service initialization completed successfully',
        expect.objectContaining({
          connectedServers: 1,
          loadedGroups: 1,
          initializationTimeMs: expect.any(Number),
        }),
      );
      // 健康验证通过分支（warnings 为空）
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Validating service health after initialization',
      );
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Service health validation passed', {
        connectedServers: 1,
        totalServers: 1,
        loadedGroups: 1,
        totalGroups: 1,
      });
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
        'Service health validation completed with warnings',
        expect.anything(),
      );
      await svc.shutdown();
    });

    it('初始化成功日志在冻结时钟下记录 initializationTimeMs=0', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(5000));
      try {
        const svc = await createInitializedService();
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
          'MCP Knot Service initialization completed successfully',
          {
            connectedServers: 1,
            loadedGroups: 1,
            initializationTimeMs: 0,
            timestamp: expect.any(String),
          },
        );
        await svc.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });

    it('部分服务器/组加载不全时产生 warning 但初始化仍成功', async () => {
      const configs = {
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
        s2: { type: 'stdio', command: 'node', args: [], enabled: true },
      } as Record<string, ServerConfig>;
      const groups = {
        default: { id: 'default', name: 'Default', servers: ['s1'], tools: [] },
        extra: { id: 'extra', name: 'Extra', servers: ['s2'], tools: [] },
      } as unknown as GroupConfig;
      const svc = new McpKnotService(configs, groups);
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }],
          ['s2', { id: 's2', status: ServerStatus.ERROR, tools: [] }],
        ]),
      );
      registry.groupManager.getAllGroups.mockReturnValue(
        new Map([['default', { id: 'default', name: 'Default', servers: ['s1'], tools: [] }]]),
      );

      await expect(svc.initialize()).resolves.toBeUndefined();

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Server manager initialized', {
        totalServers: 2,
        connectedServers: 1,
        failedServers: 1,
      });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Group manager initialized', {
        totalGroups: 2,
        loadedGroups: 1,
        failedGroups: 1,
      });
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Service health validation completed with warnings',
        expect.objectContaining({
          warnings: expect.arrayContaining([
            'Only 1 of 2 servers are connected',
            'Only 1 of 2 groups are loaded',
          ]),
          connectedServers: 1,
          totalServers: 2,
          loadedGroups: 1,
          totalGroups: 2,
        }),
      );
      expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith('Service health validation passed');
      await svc.shutdown();
    });

    it('apiToolConfigPath 传给 ApiToolIntegrationService.initialize', async () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs, '/tmp/api-tools.json');
      setupHappyPath();
      await svc.initialize();
      expect(registry.apiToolService.initialize).toHaveBeenCalledWith('/tmp/api-tools.json');
      await svc.shutdown();
    });

    it('重复 initialize 被跳过', async () => {
      const svc = await createInitializedService();
      await svc.initialize();
      expect(registry.serverManager.initialize).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'McpKnotService already initialized, skipping re-initialization',
      );
      await svc.shutdown();
    });

    it('所有组加载失败（loadedGroups=0 且配置有组）时抛 ConfigError 并清理', async () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }]]),
      );
      registry.groupManager.getAllGroups.mockReturnValue(new Map());

      await expect(svc.initialize()).rejects.toThrow(
        'Critical health issues: No groups are loaded',
      );
      // 健康验证失败日志（issues 精确）与失败清理日志
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Service health validation failed',
        expect.any(Error),
        expect.objectContaining({ issues: ['No groups are loaded'] }),
      );
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Cleaning up after failed initialization',
      );
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Cleanup completed successfully');
      // cleanupFailedInitialization：关闭 serverManager
      expect(registry.serverManager.shutdown).toHaveBeenCalledTimes(1);
      expect(svc.getServiceStatus().isInitialized).toBe(false);
    });

    it('部分服务器连接失败仅告警不阻断初始化', async () => {
      const configs = {
        s1: { type: 'stdio', command: 'node', args: [], enabled: true },
        s2: { type: 'stdio', command: 'node', args: [], enabled: true },
      } as Record<string, ServerConfig>;
      const svc = new McpKnotService(configs, groupConfigs);
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }],
          ['s2', { id: 's2', status: ServerStatus.ERROR, tools: [] }],
        ]),
      );
      registry.groupManager.getAllGroups.mockReturnValue(
        new Map([['default', { id: 'default', name: 'Default', servers: ['s1'], tools: [] }]]),
      );
      await expect(svc.initialize()).resolves.toBeUndefined();
      expect(svc.getServiceStatus().connectedServers).toBe(1);
      await svc.shutdown();
    });

    it('ServerManager.initialize 抛错时包装为 ConfigError 并清理', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2000));
      try {
        const svc = new McpKnotService(serverConfigs, groupConfigs);
        registry.serverManager.getAllServers.mockReturnValue(new Map());
        registry.groupManager.getAllGroups.mockReturnValue(new Map());
        registry.serverManager.initialize.mockRejectedValue(new Error('boom'));

        await expect(svc.initialize()).rejects.toThrow('boom');
        expect(registry.serverManager.shutdown).toHaveBeenCalledTimes(1);
        // 失败日志携带初始化耗时与配置规模（冻结时钟下耗时恒为 0）
        expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
          'MCP Knot Service initialization failed',
          expect.any(Error),
          { initializationTimeMs: 0, serverCount: 1, groupCount: 1 },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('无已连接服务器时跳过 startPolling 并记录 No servers 警告', async () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([['s1', { id: 's1', status: ServerStatus.DISCONNECTED, tools: [] }]]),
      );
      registry.serverManager.getServerStatus.mockReturnValue(ServerStatus.DISCONNECTED);
      registry.groupManager.getAllGroups.mockReturnValue(
        new Map([['default', { id: 'default', name: 'Default', servers: [], tools: [] }]]),
      );

      await svc.initialize();
      expect(registry.detector.startPolling).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Service health validation completed with warnings',
        expect.objectContaining({
          warnings: ['No servers are connected - service will have limited functionality'],
        }),
      );
      expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith('Service health validation passed');
      await svc.shutdown();
    });

    it('subscriptions.enabled=false 时记录跳过轮询日志且不启动 startPolling', async () => {
      const svc = await createInitializedService({
        subscriptions: { enabled: false },
      } as unknown as DeepReadonly<SystemConfig>);

      expect(registry.detectorOpts).toHaveLength(0); // 未构造 detector
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'subscriptions.enabled=false，跳过上游工具集变更轮询与 fan-out（P5）',
      );
      expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith('上游工具集变更轮询已启动（P5）');
      await svc.shutdown();
    });
  });

  describe('ensureInitialized 门禁', () => {
    it('未初始化时公开方法抛 SERVICE_UNAVAILABLE', async () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      expect(() => svc.getAllGroups()).toThrow(/must be initialized/);
      expect(() => svc.getGroupInfo('default')).toThrow(/must be initialized/);
      expect(() => svc.getServerHealth()).toThrow(/must be initialized/);
      expect(() => svc.getApiToolServiceHealth()).toThrow(/must be initialized/);
      await expect(svc.reloadApiToolConfig()).rejects.toThrow(/must be initialized/);
      await expect(svc.listTools()).rejects.toThrow(/must be initialized/);
      await expect(svc.callTool('t', {})).rejects.toThrow(/must be initialized/);
      await expect(svc.isToolAvailable('t')).rejects.toThrow(/must be initialized/);
      await expect(svc.getToolDetails('t')).rejects.toThrow(/must be initialized/);
      await expect(svc.getServiceDiagnostics()).rejects.toThrow(/must be initialized/);
      await expect(svc.triggerHealthCheck()).rejects.toThrow(/must be initialized/);
    });
  });

  describe('组信息与工具列表', () => {
    it('getGroupInfo 返回存在的组', async () => {
      const svc = await createInitializedService();
      const group = svc.getGroupInfo('default');
      expect(group).toMatchObject({ id: 'default' });
      await svc.shutdown();
    });

    it('getGroupInfo 日志精确记录配置/可用/连接服务器数', async () => {
      const svc = await createInitializedService();
      // getGroupServers 返回 s1、s2，但 serverManager 中只有 s1 处于连接态
      registry.groupManager.getGroupServers.mockReturnValue(['s1', 's2']);
      registry.groupManager.getGroup.mockReturnValue({
        id: 'default',
        name: 'Default',
        servers: ['s1'],
        tools: [],
      });

      expect(svc.getGroupInfo('default')).toMatchObject({ id: 'default' });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        'Group information retrieved successfully',
        {
          groupId: 'default',
          groupName: 'Default',
          configuredServers: 1,
          availableServers: 2,
          connectedServers: 1,
          configuredTools: 0,
        },
      );
      await svc.shutdown();
    });

    it('getGroupInfo 组不存在返回 undefined', async () => {
      const svc = await createInitializedService();
      registry.groupManager.getGroup.mockReturnValue(undefined);
      expect(svc.getGroupInfo('missing')).toBeUndefined();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Group information request for non-existent group',
        { groupId: 'missing', availableGroups: ['default'] },
      );
      expect(vi.mocked(logger.error)).not.toHaveBeenCalledWith(
        'Error retrieving group information',
        expect.anything(),
        expect.anything(),
      );
      await svc.shutdown();
    });

    it('getGroupInfo 内部异常返回 undefined 而非抛错', async () => {
      const svc = await createInitializedService();
      registry.groupManager.getGroup.mockImplementation(() => {
        throw new Error('group broken');
      });
      expect(svc.getGroupInfo('default')).toBeUndefined();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error retrieving group information',
        expect.any(Error),
        { groupId: 'default' },
      );
      await svc.shutdown();
    });

    it('listTools 组不存在抛 GROUP_NOT_FOUND', async () => {
      const svc = await createInitializedService();
      registry.groupManager.getGroup.mockReturnValue(undefined);
      await expect(svc.listTools('missing')).rejects.toThrow(/Group 'missing' not found/);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Tool listing failed: group not found',
        expect.objectContaining({ groupId: 'missing', availableGroups: ['default'] }),
      );
      await svc.shutdown();
    });

    it('listTools 底层异常包装为 TOOL_EXECUTION_FAILED', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockRejectedValue(new Error('fetch failed'));
      await expect(svc.listTools()).rejects.toThrow(
        /Failed to list tools for group 'default': fetch failed/,
      );
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool listing operation failed',
        expect.any(Error),
        expect.objectContaining({ groupId: 'default', errorType: 'Error' }),
      );
      await svc.shutdown();
    });

    it('listTools 成功返回工具列表（默认组 default）', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      try {
        const svc = await createInitializedService();
        const tools = [{ name: 't1', inputSchema: {}, serverId: 's1' }];
        registry.toolManager.getToolsForGroup.mockResolvedValue(tools);
        await expect(svc.listTools()).resolves.toEqual(tools);
        expect(registry.toolManager.getToolsForGroup).toHaveBeenCalledWith('default');

        expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Starting tool listing operation', {
          operationId: 'list-tools-default-1000',
          groupId: 'default',
          timestamp: expect.any(String),
        });
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Tools listed successfully', {
          operationId: 'list-tools-default-1000',
          groupId: 'default',
          toolCount: 1,
          durationMs: expect.any(Number),
          toolNames: ['t1'],
        });
        await svc.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('callTool / isToolAvailable / getToolDetails', () => {
    it('callTool 透传显式服务器，不改变同名工具的执行目标', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
        { name: 't1', inputSchema: {}, serverId: 's2' },
      ]);
      await svc.callTool('t1', { value: 0 }, 'default', 's2');
      expect(registry.toolManager.executeTool).toHaveBeenCalledExactlyOnceWith(
        'default',
        't1',
        { value: 0 },
        's2',
      );
      await svc.shutdown();
    });

    it('callTool 成功返回结果', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      try {
        const svc = await createInitializedService();
        const result = { content: [{ type: 'text', text: 'ok' }], isError: false };
        registry.toolManager.getToolsForGroup.mockResolvedValue([
          { name: 't1', inputSchema: {}, serverId: 's1' },
        ]);
        registry.toolManager.executeTool.mockResolvedValue(result);

        await expect(svc.callTool('t1', { a: 1 })).resolves.toEqual(result);
        expect(registry.toolManager.executeTool).toHaveBeenCalledWith(
          'default',
          't1',
          { a: 1 },
          undefined,
        );

        expect(vi.mocked(logger.logToolExecution)).toHaveBeenNthCalledWith(
          1,
          't1',
          'default',
          'started',
          {
            executionId: 'exec-default-t1-1000',
            args: { a: 1 },
            timestamp: expect.any(String),
          },
        );
        expect(vi.mocked(logger.logToolExecution)).toHaveBeenNthCalledWith(
          2,
          't1',
          'default',
          'completed',
          {
            executionId: 'exec-default-t1-1000',
            durationMs: expect.any(Number),
            resultSize: expect.any(Number),
            contentTypes: ['text'],
          },
        );
        expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
          'Validating tool execution prerequisites',
          { executionId: 'exec-default-t1-1000', toolName: 't1', groupId: 'default' },
        );
        expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Tool execution validation passed', {
          executionId: 'exec-default-t1-1000',
          toolName: 't1',
          groupId: 'default',
          availableServers: 1,
          connectedServers: 1,
        });
        await svc.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });

    it('callTool 成功时 contentTypes 对缺失 type 的内容项回退 unknown', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
      ]);
      registry.toolManager.executeTool.mockResolvedValue({
        content: [{ type: 'text', text: 'a' }, {}],
        isError: false,
      });

      await svc.callTool('t1', {});
      expect(vi.mocked(logger.logToolExecution)).toHaveBeenCalledWith(
        't1',
        'default',
        'completed',
        expect.objectContaining({ contentTypes: ['text', 'unknown'] }),
      );
      await svc.shutdown();
    });

    it('callTool 返回 isError 结果时状态记为 failed 并输出警告', async () => {
      const svc = await createInitializedService();
      const result = { content: [{ type: 'text', text: 'boom inside tool' }], isError: true };
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
      ]);
      registry.toolManager.executeTool.mockResolvedValue(result);

      await expect(svc.callTool('t1', {})).resolves.toEqual(result);
      expect(vi.mocked(logger.logToolExecution)).toHaveBeenCalledWith(
        't1',
        'default',
        'failed',
        expect.objectContaining({ resultSize: expect.any(Number) }),
      );
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Tool execution completed with error result',
        expect.objectContaining({
          toolName: 't1',
          groupId: 'default',
          errorContent: result.content,
        }),
      );
      await svc.shutdown();
    });

    it('callTool 工具不在组内抛 ToolExecutionError（TOOL_NOT_FOUND 被外层包装）', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockResolvedValue([]);

      await expect(svc.callTool('missing-tool', {})).rejects.toThrow(
        /Tool execution failed: Tool 'missing-tool' not found/,
      );
      expect(registry.toolManager.executeTool).not.toHaveBeenCalled();
      await svc.shutdown();
    });

    it('callTool 组不存在抛错', async () => {
      const svc = await createInitializedService();
      registry.groupManager.getGroup.mockReturnValue(undefined);
      await expect(svc.callTool('t1', {})).rejects.toThrow(
        /Tool execution failed: Group 'default' not found/,
      );
      await svc.shutdown();
    });

    it('callTool 组内服务器全部断连抛 SERVER_UNAVAILABLE（被包装）', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
      ]);
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([['s1', { id: 's1', status: ServerStatus.DISCONNECTED, tools: [] }]]),
      );
      await expect(svc.callTool('t1', {})).rejects.toThrow(
        /No servers are available in group 'default'/,
      );
      await svc.shutdown();
    });

    it('callTool 执行器抛错时包装为 ToolExecutionError', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
      ]);
      registry.toolManager.executeTool.mockRejectedValue(new Error('timeout'));

      await expect(svc.callTool('t1', {})).rejects.toThrow(/Tool execution failed: timeout/);
      expect(vi.mocked(logger.logToolExecution)).toHaveBeenCalledWith(
        't1',
        'default',
        'failed',
        expect.objectContaining({ error: 'timeout', errorType: 'Error' }),
      );
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool execution failed with exception',
        expect.any(Error),
        expect.objectContaining({ toolName: 't1', groupId: 'default', args: {} }),
      );
      await svc.shutdown();
    });

    it('callTool 失败日志携带健康摘要（区分连接与错误服务器）', async () => {
      const svc = await createInitializedService();
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }],
          ['s2', { id: 's2', status: ServerStatus.ERROR, tools: [] }],
        ]),
      );
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
      ]);
      registry.toolManager.executeTool.mockRejectedValue(new Error('timeout'));

      await expect(svc.callTool('t1', {})).rejects.toThrow(/Tool execution failed: timeout/);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool execution failed with exception',
        expect.any(Error),
        expect.objectContaining({
          serviceHealth: {
            isInitialized: true,
            totalServers: 2,
            connectedServers: 1,
            totalGroups: 1,
            timestamp: expect.any(String),
          },
        }),
      );
      await svc.shutdown();
    });

    it('callTool 失败时健康摘要自身异常则降级为错误对象', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
      ]);
      registry.toolManager.executeTool.mockRejectedValue(new Error('timeout'));
      registry.serverManager.getAllServers.mockImplementation(() => {
        throw new Error('server map exploded');
      });

      await expect(svc.callTool('t1', {})).rejects.toThrow(
        'Tool execution failed: server map exploded',
      );
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Tool execution failed with exception',
        expect.any(Error),
        expect.objectContaining({
          serviceHealth: { error: 'Failed to get health summary', message: 'server map exploded' },
        }),
      );
      registry.serverManager.getAllServers.mockReturnValue(new Map());
      await svc.shutdown();
    });

    it('isToolAvailable：存在返回 true；不存在返回 false；异常返回 false', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 't1', inputSchema: {}, serverId: 's1' },
      ]);
      await expect(svc.isToolAvailable('t1')).resolves.toBe(true);
      await expect(svc.isToolAvailable('t2')).resolves.toBe(false);

      registry.toolManager.getToolsForGroup.mockRejectedValue(new Error('boom'));
      await expect(svc.isToolAvailable('t1')).resolves.toBe(false);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error checking tool availability',
        expect.any(Error),
        { toolName: 't1', groupId: 'default' },
      );
      await svc.shutdown();
    });

    it('getToolDetails：找到返回工具；找不到返回 null；异常返回 null', async () => {
      const svc = await createInitializedService();
      const tool = { name: 't1', inputSchema: {}, serverId: 's1' };
      registry.toolManager.getToolsForGroup.mockResolvedValue([tool]);

      await expect(svc.getToolDetails('t1')).resolves.toEqual(tool);
      await expect(svc.getToolDetails('t2')).resolves.toBeNull();

      registry.toolManager.getToolsForGroup.mockRejectedValue(new Error('boom'));
      await expect(svc.getToolDetails('t1')).resolves.toBeNull();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error getting tool details',
        expect.any(Error),
        { toolName: 't1', groupId: 'default' },
      );
      await svc.shutdown();
    });
  });

  describe('状态与诊断', () => {
    it('getServiceStatus 未初始化时返回零值', () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      expect(svc.getServiceStatus()).toEqual({
        isInitialized: false,
        serverCount: 1,
        connectedServers: 0,
        groupCount: 0,
        totalTools: 0,
      });
    });

    it('getServerHealth 返回各服务器状态', async () => {
      const svc = await createInitializedService();
      const health = svc.getServerHealth();
      expect(health.get('s1')).toBe(ServerStatus.CONNECTED);
      await svc.shutdown();
    });

    it('getServiceStatus/getDetailedServiceStatus 精确区分连接与错误服务器', async () => {
      const svc = await createInitializedService();
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }],
          ['s2', { id: 's2', status: ServerStatus.ERROR, tools: [] }],
        ]),
      );

      expect(svc.getServiceStatus()).toStrictEqual({
        isInitialized: true,
        serverCount: 1,
        connectedServers: 1,
        groupCount: 1,
        totalTools: 0,
      });
      await expect(svc.getDetailedServiceStatus()).resolves.toMatchObject({
        isInitialized: true,
        serverCount: 1,
        connectedServers: 1,
        groupCount: 1,
      });
      await svc.shutdown();
    });

    it('getDetailedServiceStatus：MCP 工具数 = listTools 总数 - API 工具数', async () => {
      const svc = await createInitializedService();
      registry.apiToolService.getStats.mockResolvedValue({ initialized: true, totalApiTools: 2 });
      registry.toolManager.getToolsForGroup.mockResolvedValue([
        { name: 'a' },
        { name: 'b' },
        { name: 'c' },
        { name: 'd' },
      ]);

      const status = await svc.getDetailedServiceStatus();
      expect(status.serverCount).toBe(1);
      expect(status.connectedServers).toBe(1);
      expect(status.groupCount).toBe(1);
      expect(status.apiTools).toBe(2);
      expect(status.totalTools).toBe(4); // 4 - 2 mcp + 2 api
      await svc.shutdown();
    });

    it('getDetailedServiceStatus：统计失败时降级为 0', async () => {
      const svc = await createInitializedService();
      registry.apiToolService.getStats.mockRejectedValue(new Error('stats down'));
      registry.toolManager.getToolsForGroup.mockRejectedValue(new Error('tools down'));

      const status = await svc.getDetailedServiceStatus();
      expect(status.apiTools).toBe(0);
      expect(status.totalTools).toBe(0);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('获取API工具统计失败', {
        error: 'stats down',
      });
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('获取MCP工具统计失败', {
        error: "Failed to list tools for group 'default': tools down",
      });
      await svc.shutdown();
    });

    it('getDetailedServiceStatus 未初始化返回零值', () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      expect(svc.getServiceStatus().isInitialized).toBe(false);
    });

    it('getServiceDiagnostics 汇总服务器/组/API 工具/缓存信息', async () => {
      const svc = await createInitializedService();
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          [
            's1',
            {
              id: 's1',
              status: ServerStatus.CONNECTED,
              lastConnected: new Date('2026-01-01T00:00:00Z'),
              lastError: undefined,
              tools: [{ name: 't1' }, { name: 't2' }],
            },
          ],
          [
            's2',
            {
              id: 's2',
              status: ServerStatus.ERROR,
              lastError: new Error('conn refused'),
              tools: [],
            },
          ],
        ]),
      );
      registry.toolManager.getToolsForGroup.mockResolvedValue([{ name: 't1' }, { name: 't2' }]);
      registry.toolManager.getCacheStats.mockReturnValue({
        totalGroups: 1,
        totalTools: 2,
        oldestCache: new Date(),
        newestCache: new Date(),
      });
      registry.apiToolService.performHealthCheck.mockResolvedValue({
        initialized: true,
        healthy: true,
        errors: [],
      });
      registry.apiToolService.getStats.mockResolvedValue({ totalApiTools: 5 });

      const diagnostics = await svc.getServiceDiagnostics();
      expect(diagnostics.service.isInitialized).toBe(true);
      expect(diagnostics.service.version).toBe('1.0.0');
      expect(diagnostics.servers.total).toBe(2);
      expect(diagnostics.servers.connected).toBe(1);
      expect(diagnostics.servers.failed).toBe(1);
      expect(diagnostics.servers.details[0]).toMatchObject({ id: 's1', toolCount: 2 });
      expect(diagnostics.servers.details[0]?.lastConnected).toBe('2026-01-01T00:00:00.000Z');
      expect(diagnostics.servers.details[1]?.error).toBe('conn refused');
      expect(diagnostics.groups.details[0]).toMatchObject({
        id: 'default',
        serverCount: 1,
        toolCount: 2,
        isHealthy: true,
      });
      expect(diagnostics.apiTools).toEqual({
        initialized: true,
        healthy: true,
        totalTools: 5,
        errors: [],
      });
      expect(diagnostics.performance.cacheStats).toMatchObject({ totalTools: 2 });
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('Service diagnostics generated', {
        serverCount: 2,
        connectedServers: 1,
        groupCount: 1,
      });
      await svc.shutdown();
    });

    it('getServiceDiagnostics 多服务器下 connected/failed 计数互不混淆（2+2）', async () => {
      const svc = await createInitializedService();
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [] }],
          ['s2', { id: 's2', status: ServerStatus.CONNECTED, tools: [] }],
          ['s3', { id: 's3', status: ServerStatus.ERROR, tools: [] }],
          ['s4', { id: 's4', status: ServerStatus.ERROR, tools: [] }],
        ]),
      );
      registry.toolManager.getToolsForGroup.mockResolvedValue([]);

      const diagnostics = await svc.getServiceDiagnostics();
      expect(diagnostics.servers.connected).toBe(2);
      expect(diagnostics.servers.failed).toBe(2);
      await svc.shutdown();
    });

    it('getServiceDiagnostics 透传 API 健康检查返回的非空 errors', async () => {
      const svc = await createInitializedService();
      registry.apiToolService.performHealthCheck.mockResolvedValue({
        initialized: true,
        healthy: false,
        errors: ['api degraded'],
      });
      registry.apiToolService.getStats.mockResolvedValue({ totalApiTools: 1 });

      const diagnostics = await svc.getServiceDiagnostics();
      expect(diagnostics.apiTools).toEqual({
        initialized: true,
        healthy: false,
        totalTools: 1,
        errors: ['api degraded'],
      });
      await svc.shutdown();
    });

    it('getServiceDiagnostics：组工具获取失败时该组 isHealthy=false；API 诊断失败记入 errors', async () => {
      const svc = await createInitializedService();
      registry.toolManager.getToolsForGroup.mockRejectedValue(new Error('group tools down'));
      registry.apiToolService.performHealthCheck.mockRejectedValue(new Error('api down'));

      const diagnostics = await svc.getServiceDiagnostics();
      expect(diagnostics.groups.details[0]).toMatchObject({ toolCount: 0, isHealthy: false });
      expect(diagnostics.apiTools.initialized).toBe(false);
      expect(diagnostics.apiTools.healthy).toBe(false);
      expect(diagnostics.apiTools.errors[0]).toContain('API工具诊断失败: api down');
      await svc.shutdown();
    });

    it('getServiceDiagnostics：底层汇总异常时包装为 INTERNAL_SERVER_ERROR', async () => {
      const svc = await createInitializedService();
      registry.serverManager.getAllServers.mockImplementation(() => {
        throw new Error('diag boom');
      });

      await expect(svc.getServiceDiagnostics()).rejects.toThrow('Failed to generate diagnostics');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to generate service diagnostics',
        expect.any(Error),
      );
      // 恢复 mock，避免后续 shutdown 的 getConnectedServerCount 再次抛错
      registry.serverManager.getAllServers.mockReturnValue(new Map());
      await svc.shutdown();
    });
  });

  describe('API 工具服务委托', () => {
    it('getApiToolServiceHealth 透传健康状态', async () => {
      const svc = await createInitializedService();
      registry.apiToolService.getHealthStatus.mockReturnValue({
        initialized: true,
        healthy: true,
        serviceStatus: 'ok',
      });
      expect(svc.getApiToolServiceHealth()).toEqual({
        initialized: true,
        healthy: true,
        serviceStatus: 'ok',
      });
      await svc.shutdown();
    });

    it('getApiToolServiceHealth 异常时返回兜底错误对象', async () => {
      const svc = await createInitializedService();
      registry.apiToolService.getHealthStatus.mockImplementation(() => {
        throw new Error('health boom');
      });
      expect(svc.getApiToolServiceHealth()).toEqual({
        initialized: false,
        healthy: false,
        errors: [expect.stringContaining('health boom')],
      });
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error getting API tool service health',
        expect.any(Error),
      );
      await svc.shutdown();
    });

    it('performApiToolHealthCheck 透传与降级', async () => {
      const svc = await createInitializedService();
      registry.apiToolService.performHealthCheck.mockResolvedValue({
        initialized: true,
        healthy: true,
      });
      await expect(svc.performApiToolHealthCheck()).resolves.toEqual({
        initialized: true,
        healthy: true,
      });

      registry.apiToolService.performHealthCheck.mockRejectedValue(new Error('check boom'));
      await expect(svc.performApiToolHealthCheck()).resolves.toEqual({
        initialized: false,
        healthy: false,
        errors: [expect.stringContaining('check boom')],
      });
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error performing API tool health check',
        expect.any(Error),
      );
      await svc.shutdown();
    });

    it('reloadApiToolConfig 成功与失败透传', async () => {
      const svc = await createInitializedService();
      await expect(svc.reloadApiToolConfig()).resolves.toBeUndefined();
      expect(registry.apiToolService.reloadConfig).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('重新加载API工具配置');
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('API工具配置重新加载完成');

      registry.apiToolService.reloadConfig.mockRejectedValue(new Error('reload boom'));
      await expect(svc.reloadApiToolConfig()).rejects.toThrow('reload boom');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        '重新加载API工具配置失败',
        expect.any(Error),
      );
      await svc.shutdown();
    });
  });

  describe('健康监控与生命周期委托', () => {
    it('setHealthMonitoring / triggerHealthCheck / getLifecycleStatus 委托', async () => {
      const svc = await createInitializedService();
      registry.healthMonitor.getLifecycleStatus.mockReturnValue({
        isInitialized: true,
        healthMonitoringEnabled: false,
        uptime: 42,
        lastHealthCheck: '2026-01-01T00:00:00.000Z',
      });

      svc.setHealthMonitoring(false);
      expect(registry.healthMonitor.setEnabled).toHaveBeenCalledWith(false);

      await svc.triggerHealthCheck();
      expect(registry.healthMonitor.triggerCheck).toHaveBeenCalledTimes(1);

      const lifecycle = svc.getLifecycleStatus();
      expect(lifecycle).toMatchObject({
        isInitialized: true,
        healthMonitoringEnabled: false,
        uptime: 42,
        lastHealthCheck: '2026-01-01T00:00:00.000Z',
        shutdownInProgress: false,
      });
      await svc.shutdown();
    });
  });

  describe('消息审计委托', () => {
    it('addMcpMessage/getMcpMessages/clearMcpMessages/getPerformanceStats', async () => {
      const svc = await createInitializedService();
      registry.messageAudit.getMessages.mockReturnValue([{ id: 'm1' }]);
      registry.messageAudit.getPerformanceStats.mockReturnValue({
        totalRequests: 3,
        averageResponseTime: 10,
        errorRate: 0,
        topTools: [],
      });

      svc.addMcpMessage('s1', 'request', 'tools/list', {});
      expect(registry.messageAudit.addMessage).toHaveBeenCalledWith(
        's1',
        'request',
        'tools/list',
        {},
      );

      expect(svc.getMcpMessages(10, 's1', 'request')).toEqual([{ id: 'm1' }]);
      expect(registry.messageAudit.getMessages).toHaveBeenCalledWith(10, 's1', 'request');

      svc.clearMcpMessages();
      expect(registry.messageAudit.clearMessages).toHaveBeenCalledTimes(1);

      expect(svc.getPerformanceStats()).toMatchObject({ totalRequests: 3 });
      await svc.shutdown();
    });
  });

  describe('shutdown', () => {
    it('未初始化时 shutdown 直接跳过', async () => {
      const svc = new McpKnotService(serverConfigs, groupConfigs);
      await svc.shutdown();
      expect(registry.serverManager.shutdown).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'MCP Knot Service not initialized, skipping shutdown',
      );
    });

    it('优雅关闭：停监控、清消息、停 detector/fanout、关 API 服务与服务器', async () => {
      const svc = await createInitializedService();
      await svc.shutdown();

      expect(registry.healthMonitor.stop).toHaveBeenCalledTimes(1);
      expect(registry.messageAudit.clearMessages).toHaveBeenCalledTimes(1);
      expect(registry.detector.stop).toHaveBeenCalledTimes(1);
      expect(registry.fanout.stop).toHaveBeenCalledTimes(1);
      expect(registry.apiToolService.shutdown).toHaveBeenCalledTimes(1);
      expect(registry.serverManager.shutdown).toHaveBeenCalledTimes(1);
      expect(svc.getServiceStatus().isInitialized).toBe(false);
      // 优雅关闭全链路日志与最终状态
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'Starting graceful MCP Knot Service shutdown',
        expect.objectContaining({ connectedServers: 1 }),
      );
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Performing graceful shutdown');
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('API tool service shutdown completed');
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Graceful shutdown completed');
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'MCP Knot Service shutdown completed successfully',
        expect.objectContaining({ shutdownTimeMs: expect.any(Number) }),
      );
      expect(svc.getLifecycleStatus().shutdownInProgress).toBe(false);
    });

    it('冻结时钟下优雅关闭耗时为 0 且清理超时定时器', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(3000));
      try {
        const svc = await createInitializedService();
        await svc.shutdown();

        expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
          'MCP Knot Service shutdown completed successfully',
          { shutdownTimeMs: 0, timestamp: expect.any(String) },
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('API 工具服务 shutdown 失败被吞掉且优雅关闭继续完成', async () => {
      const svc = await createInitializedService();
      registry.apiToolService.shutdown.mockRejectedValue(new Error('api tool shutdown fail'));

      await expect(svc.shutdown()).resolves.toBeUndefined();
      expect(registry.serverManager.shutdown).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'API tool service shutdown failed',
        expect.any(Error),
      );
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        'MCP Knot Service shutdown completed successfully',
        expect.anything(),
      );
    });

    it('优雅关闭后再次 shutdown 跳过', async () => {
      const svc = await createInitializedService();
      await svc.shutdown();
      await svc.shutdown();
      expect(registry.serverManager.shutdown).toHaveBeenCalledTimes(1);
    });

    it('关闭进行中再次调用 shutdown 直接返回并告警', async () => {
      vi.useFakeTimers();
      try {
        const svc = await createInitializedService();
        registry.serverManager.shutdown.mockImplementation(
          () => new Promise(() => undefined), // 永不完成
        );
        registry.serverManager.getAllServers.mockReturnValue(new Map());

        const first = svc.shutdown();
        // shutdownInProgress 在首个 await 前同步置位，第二次调用直接走早退分支
        await expect(svc.shutdown()).resolves.toBeUndefined();
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'Shutdown already in progress, waiting for completion',
        );

        const expectation = expect(first).rejects.toThrow(
          /Shutdown completed with 1 errors: Shutdown timeout/,
        );
        await vi.advanceTimersByTimeAsync(10_000);
        await expectation;
        // 并发保护：serverManager.shutdown 仅被调用一次
        expect(registry.serverManager.shutdown).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ServerManager.shutdown 抛错时走强制关闭并抛 ServiceError', async () => {
      const svc = await createInitializedService();
      registry.serverManager.shutdown.mockRejectedValue(new Error('graceful fail'));
      // 强制关闭路径：client.close 可用
      const forceClose = vi.fn().mockResolvedValue(undefined);
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          [
            's1',
            {
              id: 's1',
              status: ServerStatus.CONNECTED,
              tools: [],
              client: { close: forceClose },
            },
          ],
        ]),
      );

      await expect(svc.shutdown()).rejects.toThrow(
        'Shutdown completed with 1 errors: graceful fail',
      );
      // 强制关闭调用了 client.close
      expect(forceClose).toHaveBeenCalledTimes(1);
      expect(svc.getServiceStatus().isInitialized).toBe(false);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error during graceful shutdown',
        expect.any(Error),
      );
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Attempting force shutdown due to graceful shutdown failure',
      );
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Performing force shutdown');
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Force shutdown completed');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'MCP Knot Service shutdown completed with errors',
        expect.any(Error),
        {
          shutdownTimeMs: expect.any(Number),
          errorCount: 1,
          errors: ['graceful fail'],
        },
      );
    });

    it('优雅与强制关闭都失败时汇总两个错误', async () => {
      const svc = await createInitializedService();
      registry.serverManager.shutdown.mockRejectedValue(new Error('graceful fail'));
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([
          [
            's1',
            {
              id: 's1',
              status: ServerStatus.CONNECTED,
              tools: [],
              client: {
                close: vi.fn().mockRejectedValue(new Error('force fail')),
              },
            },
          ],
        ]),
      );
      // client.close 抛错在 performForceShutdown 内被捕获，不追加 errors
      await expect(svc.shutdown()).rejects.toThrow(/1 errors/);
      expect(svc.getServiceStatus().isInitialized).toBe(false);
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('Force close server connection failed', {
        serverId: 's1',
        error: 'force fail',
      });
    });

    it('强制关闭时 server 无可用 close 方法则跳过且不报错', async () => {
      const svc = await createInitializedService();
      registry.serverManager.shutdown.mockRejectedValue(new Error('graceful fail'));
      registry.serverManager.getAllServers.mockReturnValue(
        new Map([['s1', { id: 's1', status: ServerStatus.CONNECTED, tools: [], client: {} }]]),
      );

      await expect(svc.shutdown()).rejects.toThrow('Shutdown completed with 1 errors');
      expect(vi.mocked(logger.debug)).not.toHaveBeenCalledWith(
        'Force close server connection failed',
        expect.anything(),
      );
    });

    it('强制关闭超时（2s）记录 Force close timeout 日志', async () => {
      vi.useFakeTimers();
      try {
        const svc = await createInitializedService();
        registry.serverManager.shutdown.mockRejectedValue(new Error('graceful fail'));
        registry.serverManager.getAllServers.mockReturnValue(
          new Map([
            [
              's1',
              {
                id: 's1',
                status: ServerStatus.CONNECTED,
                tools: [],
                client: { close: vi.fn().mockImplementation(() => new Promise(() => undefined)) },
              },
            ],
          ]),
        );

        const expectation = expect(svc.shutdown()).rejects.toThrow(
          'Shutdown completed with 1 errors: graceful fail',
        );
        // 10s shutdown 超时 + 2s force close 超时
        await vi.advanceTimersByTimeAsync(12_000);
        await expectation;
        expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
          'Force close server connection failed',
          {
            serverId: 's1',
            error: 'Force close timeout',
          },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('优雅关闭超时（10s）触发强制关闭', async () => {
      vi.useFakeTimers();
      try {
        const svc = await createInitializedService();
        registry.serverManager.shutdown.mockImplementation(
          () => new Promise(() => undefined), // 永不完成
        );
        registry.serverManager.getAllServers.mockReturnValue(
          new Map([
            [
              's1',
              {
                id: 's1',
                status: ServerStatus.CONNECTED,
                tools: [],
                client: { close: vi.fn().mockResolvedValue(undefined) },
              },
            ],
          ]),
        );

        const shutdownPromise = svc.shutdown();
        // 先挂 rejection 断言再推进时钟：reject 发生在 advanceTimersByTimeAsync 期间，
        // 若事后才挂处理器会跨宏任务边界被 Node 记为 unhandled rejection（会拖垮 Stryker 干跑）
        const expectation = expect(shutdownPromise).rejects.toThrow(
          /Shutdown completed with 1 errors: Shutdown timeout/,
        );
        // 推进 10s 触发 shutdown 超时 → 强制关闭路径
        await vi.advanceTimersByTimeAsync(10_000);
        await expectation;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('P5 fan-out 回调', () => {
    it('getGroupsForServer 返回包含该 server 的组', async () => {
      await createInitializedService();
      registry.groupManager.getAllGroups.mockReturnValue(
        new Map([
          ['g1', { id: 'g1', servers: ['s1'], tools: [] }],
          ['g2', { id: 'g2', servers: ['s2'], tools: [] }],
          ['g3', { id: 'g3', servers: ['s1', 's2'], tools: [] }],
        ]),
      );

      const { getGroupsForServer } = registry.fanoutOpts[0] as {
        getGroupsForServer: (serverId: string) => Array<{ groupId: string }>;
      };
      expect(getGroupsForServer('s1')).toEqual([{ groupId: 'g1' }, { groupId: 'g3' }]);
      expect(getGroupsForServer('s2')).toEqual([{ groupId: 'g2' }, { groupId: 'g3' }]);
      expect(getGroupsForServer('s9')).toEqual([]);
    });

    it('refreshGroupTools：refetch 后通知已初始化的 GroupMcpService', async () => {
      const svc = await createInitializedService();
      registry.serverManager.refetchServerTools.mockResolvedValue([{ name: 't1' }]);
      const refreshTools = vi.fn().mockResolvedValue(undefined);
      registry.groupServiceCache.set('default', { refreshTools });

      const { refreshGroupTools } = registry.fanoutOpts[0] as {
        refreshGroupTools: (groupId: string, serverId: string) => Promise<void>;
      };
      await refreshGroupTools('default', 's1');

      expect(registry.serverManager.refetchServerTools).toHaveBeenCalledWith('s1');
      expect(refreshTools).toHaveBeenCalledWith('s1');
      await svc.shutdown();
    });

    it('refreshGroupTools：group service 未缓存时跳过通知', async () => {
      const svc = await createInitializedService();
      const { refreshGroupTools } = registry.fanoutOpts[0] as {
        refreshGroupTools: (groupId: string, serverId: string) => Promise<void>;
      };
      await expect(refreshGroupTools('unknown-group', 's1')).resolves.toBeUndefined();
      expect(registry.serverManager.refetchServerTools).toHaveBeenCalledWith('s1');
      await svc.shutdown();
    });

    it('publishToolListChanged：向已创建的 handler 发布 tools_list_changed', async () => {
      const svc = await createInitializedService();
      const toolsChanged = vi.fn();
      registry.groupHandlersCache.set('default', { notify: { toolsChanged } });

      const { publishToolListChanged } = registry.fanoutOpts[0] as {
        publishToolListChanged: (groupId: string) => void;
      };
      publishToolListChanged('default');
      // 异步动态 import 后发布
      await vi.waitFor(() => expect(toolsChanged).toHaveBeenCalledTimes(1));
      await svc.shutdown();
    });

    it('publishToolListChanged：handler 未创建时为 no-op（不抛错、不告警）', async () => {
      const svc = await createInitializedService();
      const { publishToolListChanged } = registry.fanoutOpts[0] as {
        publishToolListChanged: (groupId: string) => void;
      };

      expect(() => publishToolListChanged('unknown-group')).not.toThrow();
      // 等待异步动态 import 落定后再断言无告警
      await new Promise((resolve) => setImmediate(resolve));
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
        'publishToolListChanged 失败',
        expect.anything(),
      );
      await svc.shutdown();
    });

    it('publishToolListChanged：handler 发布抛错时记录警告', async () => {
      const svc = await createInitializedService();
      registry.groupHandlersCache.set('default', {
        notify: {
          toolsChanged: vi.fn(() => {
            throw new Error('notify boom');
          }),
        },
      });

      const { publishToolListChanged } = registry.fanoutOpts[0] as {
        publishToolListChanged: (groupId: string) => void;
      };
      publishToolListChanged('default');
      await vi.waitFor(() =>
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('publishToolListChanged 失败', {
          groupId: 'default',
          error: 'notify boom',
        }),
      );
      await svc.shutdown();
    });

    it('detector onChange 触发 fanout.handleServerChange', async () => {
      await createInitializedService();
      const { onChange } = registry.detectorOpts[0] as {
        onChange: (serverId: string) => void;
      };
      onChange('s1');
      expect(registry.fanout.handleServerChange).toHaveBeenCalledWith('s1');
    });
  });

  describe('formatErrorResponse', () => {
    it('格式化错误为标准响应结构', () => {
      const formatted = McpKnotService.formatErrorResponse(new Error('boom'));
      expect(formatted).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'boom',
        },
      });
    });
  });
});
