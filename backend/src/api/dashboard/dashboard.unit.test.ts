import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

const dashboardService = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getSystemHealth: vi.fn(),
  queryLogs: vi.fn(),
  getRecentActivities: vi.fn(),
  getPerformanceStats: vi.fn(),
  addLog: vi.fn(),
  addActivity: vi.fn(),
  recordToolExecution: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock('../../services/dashboard_service.js', () => ({
  DashboardService: class {
    constructor() {
      return dashboardService;
    }
  },
}));

const sseEventManager = vi.hoisted(() => ({
  createConnection: vi.fn(),
  getConnectionStats: vi.fn(),
  broadcastSystemAlert: vi.fn(),
  broadcastToolExecution: vi.fn(),
  broadcastServerStatus: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('../../services/sse_event_manager.js', () => ({
  SSEEventManager: class {
    constructor() {
      return sseEventManager;
    }
  },
}));

const eventIntegrationService = vi.hoisted(() => ({
  recordSystemStart: vi.fn(),
  recordHealthCheck: vi.fn(),
}));

vi.mock('../../services/event_integration_service.js', () => ({
  EventIntegrationService: class {
    constructor() {
      return eventIntegrationService;
    }
  },
}));

const memoryMonitor = vi.hoisted(() => ({
  getCurrentMemory: vi.fn(),
  analyzeTrend: vi.fn(),
  takeSnapshot: vi.fn(),
  forceGC: vi.fn(),
}));

vi.mock('../../utils/memory-monitor.js', () => ({ memoryMonitor }));

const resourceMonitor = vi.hoisted(() => ({
  getStats: vi.fn(),
}));

vi.mock('../../utils/resource-monitor.js', () => ({ resourceMonitor }));

import {
  dashboardApi,
  getEventIntegrationService,
  initializeDashboardServices,
  shutdownDashboardServices,
} from './index.js';

const MB = 1024 * 1024;

describe('仪表板 API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'dashboard-request');
      await next();
    });
    app.route('/api/dashboard', dashboardApi);
  });

  function post(path: string, body: unknown = {}): Promise<Response> {
    return app.request(`/api/dashboard${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('GET /stats 返回统计信息，失败时返回 500', async () => {
    dashboardService.getDashboardStats.mockResolvedValueOnce({
      overview: { totalServers: 2 },
      recentActivity: [],
    });

    const ok = await app.request('/api/dashboard/stats');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      success: true,
      data: { overview: { totalServers: 2 } },
      requestId: 'dashboard-request',
    });

    dashboardService.getDashboardStats.mockRejectedValueOnce(new Error('统计失败'));
    const failed = await app.request('/api/dashboard/stats');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ success: false });
  });

  it('GET /health 返回健康状态，失败时返回 500', async () => {
    dashboardService.getSystemHealth.mockResolvedValueOnce({
      status: 'healthy',
      issues: [],
    });

    const ok = await app.request('/api/dashboard/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ data: { status: 'healthy', issues: [] } });

    dashboardService.getSystemHealth.mockRejectedValueOnce(new Error('健康检查失败'));
    const failed = await app.request('/api/dashboard/health');
    expect(failed.status).toBe(500);
  });

  it('GET /logs 解析查询参数并回传查询条件', async () => {
    dashboardService.queryLogs.mockReturnValueOnce({ logs: [{ level: 'error' }], total: 1 });

    const response = await app.request(
      '/api/dashboard/logs?level=error&category=api&startTime=t1&endTime=t2&limit=5&offset=10&search=boom',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        logs: [{ level: 'error' }],
        total: 1,
        query: {
          level: 'error',
          category: 'api',
          startTime: 't1',
          endTime: 't2',
          limit: 5,
          offset: 10,
          search: 'boom',
        },
      },
    });
  });

  it('GET /logs 不带分页参数时不设置 limit/offset', async () => {
    dashboardService.queryLogs.mockReturnValueOnce({ logs: [], total: 0 });

    const response = await app.request('/api/dashboard/logs');

    expect(dashboardService.queryLogs).toHaveBeenCalledWith({
      level: undefined,
      category: undefined,
      startTime: undefined,
      endTime: undefined,
      limit: undefined,
      offset: undefined,
      search: undefined,
    });
    expect((await response.json()).data.total).toBe(0);
  });

  it('GET /activities 默认 limit 50，可由参数覆盖', async () => {
    dashboardService.getRecentActivities.mockReturnValueOnce([]);

    const response = await app.request('/api/dashboard/activities?limit=7');
    expect(dashboardService.getRecentActivities).toHaveBeenCalledWith(7);
    expect(await response.json()).toMatchObject({ data: { activities: [], total: 0 } });

    await app.request('/api/dashboard/activities');
    expect(dashboardService.getRecentActivities).toHaveBeenLastCalledWith(50);
  });

  it('GET /performance 返回性能统计', async () => {
    dashboardService.getPerformanceStats.mockReturnValueOnce({
      totalRequests: 10,
      averageResponseTime: 42,
      errorRate: 0,
    });

    const response = await app.request('/api/dashboard/performance');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { totalRequests: 10, averageResponseTime: 42 },
    });
  });

  it('GET /events 建立 SSE 连接并按逗号拆分订阅', async () => {
    const sseResponse = new Response('data: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    sseEventManager.createConnection.mockReturnValueOnce({ response: sseResponse, clientId: 'c1' });

    const response = await app.request('/api/dashboard/events?subscriptions=tools,servers');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(sseEventManager.createConnection).toHaveBeenCalledWith(['tools', 'servers']);

    await app.request('/api/dashboard/events');
    expect(sseEventManager.createConnection).toHaveBeenLastCalledWith([]);
  });

  it('GET /events 建连失败时返回 500', async () => {
    sseEventManager.createConnection.mockImplementationOnce(() => {
      throw new Error('连接耗尽');
    });

    const response = await app.request('/api/dashboard/events');

    expect(response.status).toBe(500);
  });

  it('GET /sse-stats 返回连接统计', async () => {
    sseEventManager.getConnectionStats.mockReturnValueOnce({
      totalClients: 2,
      eventHistoryCount: 5,
    });

    const response = await app.request('/api/dashboard/sse-stats');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { totalClients: 2, eventHistoryCount: 5 },
    });
  });

  it('POST /test-alert 支持默认值与自定义值并广播告警', async () => {
    const defaulted = await post('/test-alert', {});
    expect(defaulted.status).toBe(200);
    expect(await defaulted.json()).toMatchObject({
      data: { message: '测试告警已发送', severity: 'info', category: 'test' },
    });
    expect(sseEventManager.broadcastSystemAlert).toHaveBeenCalledWith('info', '测试告警', 'test', {
      test: true,
    });
    expect(dashboardService.addActivity).toHaveBeenCalledWith({
      type: 'system_start',
      message: '测试告警: 测试告警',
      severity: 'info',
    });

    await post('/test-alert', { severity: 'warning', message: '磁盘告急', category: 'disk' });
    expect(sseEventManager.broadcastSystemAlert).toHaveBeenLastCalledWith(
      'warning',
      '磁盘告急',
      'disk',
      { test: true },
    );
  });

  it('POST /test-tool-execution 广播工具执行事件并记录指标', async () => {
    const response = await post('/test-tool-execution', {
      toolName: 'search',
      serverId: 'srv',
      groupId: 'team',
      success: false,
      executionTime: 250,
      error: 'timeout',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        message: '测试工具执行事件已发送',
        toolName: 'search',
        serverId: 'srv',
        groupId: 'team',
        success: false,
        executionTime: 250,
      },
    });
    expect(sseEventManager.broadcastToolExecution).toHaveBeenCalledWith(
      'search',
      'srv',
      'team',
      false,
      250,
      'timeout',
    );
    expect(dashboardService.recordToolExecution).toHaveBeenCalledWith('search', 250, false);
  });

  it('POST /test-server-status 按状态派生活动类型与严重级别', async () => {
    const connected = await post('/test-server-status', {
      serverId: 'a',
      status: 'connected',
      previousStatus: 'disconnected',
    });
    expect(connected.status).toBe(200);
    expect(sseEventManager.broadcastServerStatus).toHaveBeenCalledWith(
      'a',
      'connected',
      'disconnected',
      undefined,
    );
    expect(dashboardService.addActivity).toHaveBeenLastCalledWith({
      type: 'server_connected',
      message: '服务器 a 状态变更: disconnected -> connected',
      severity: 'info',
    });

    await post('/test-server-status', { serverId: 'b', status: 'error' });
    expect(dashboardService.addActivity).toHaveBeenLastCalledWith({
      type: 'server_disconnected',
      message: '服务器 b 状态变更: disconnected -> error',
      severity: 'error',
    });

    await post('/test-server-status', { serverId: 'c', status: 'disconnected' });
    expect(dashboardService.addActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'server_disconnected', severity: 'warning' }),
    );
  });

  it('GET /system-info 返回节点与内存概要', async () => {
    const response = await app.request('/api/dashboard/system-info');

    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.node).toMatchObject({
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    expect(typeof data.node.uptime).toBe('number');
    expect(data.memory).toHaveProperty('rss');
    expect(data.cpu).toHaveProperty('user');
    expect(data.environment.nodeEnv).toBe(process.env.NODE_ENV ?? 'development');
    expect(typeof data.environment.timezone).toBe('string');
  });

  it('POST /add-log 记录自定义日志并带默认值', async () => {
    const response = await post('/add-log', {
      level: 'warn',
      message: 'hello',
      metadata: { a: 1 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { message: '日志条目已添加', level: 'warn', category: 'test' },
    });
    expect(dashboardService.addLog).toHaveBeenCalledWith({
      level: 'warn',
      message: 'hello',
      category: 'test',
      metadata: { a: 1 },
    });

    await post('/add-log', {});
    expect(dashboardService.addLog).toHaveBeenLastCalledWith({
      level: 'info',
      message: '测试日志',
      category: 'test',
      metadata: undefined,
    });
  });

  it('DELETE /logs 清理日志', async () => {
    const response = await app.request('/api/dashboard/logs', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(dashboardService.cleanup).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ data: { message: '日志已清理' } });
  });

  it('GET /health-detailed 附加磁盘/网络/进程检查', async () => {
    dashboardService.getSystemHealth.mockResolvedValueOnce({
      status: 'healthy',
      issues: ['x'],
      uptime: 100,
    });

    const response = await app.request('/api/dashboard/health-detailed');

    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.status).toBe('healthy');
    expect(data.issues).toEqual(['x']);
    expect(data.additionalChecks.disk).toEqual({ available: true, message: '磁盘空间充足' });
    expect(data.additionalChecks.network).toEqual({ available: true, message: '网络连接正常' });
    expect(data.additionalChecks.processHealth).toMatchObject({
      status: 'healthy',
      message: '进程运行正常',
      details: { pid: process.pid },
    });
  });

  describe('内存与资源监控端点', () => {
    it('GET /memory 把字节数换算为 MB 并计算堆占用率', async () => {
      memoryMonitor.getCurrentMemory.mockReturnValueOnce({
        rss: 2 * MB + 100,
        heapTotal: 4 * MB,
        heapUsed: 1 * MB,
        external: 512 * 1024,
        arrayBuffers: 0,
        timestamp: Date.now(),
      });

      const response = await app.request('/api/dashboard/memory');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          memory: {
            rss: 2,
            heapTotal: 4,
            heapUsed: 1,
            external: 1,
            arrayBuffers: 0,
            heapUsageRatio: '25.0',
          },
        },
      });
    });

    it('GET /memory 堆总量为 0 时占用率为 0.0', async () => {
      memoryMonitor.getCurrentMemory.mockReturnValueOnce({
        rss: 0,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0,
        timestamp: Date.now(),
      });

      const response = await app.request('/api/dashboard/memory');

      expect((await response.json()).data.memory.heapUsageRatio).toBe('0.0');
    });

    it('GET /memory/trend 数据不足时返回 null 趋势', async () => {
      memoryMonitor.analyzeTrend.mockReturnValueOnce(null);

      const response = await app.request('/api/dashboard/memory/trend');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { message: '内存趋势数据不足，请稍后再试', trend: null },
      });
    });

    it('GET /memory/trend 支持 duration 参数并换算 MB', async () => {
      memoryMonitor.analyzeTrend.mockReturnValueOnce({
        duration: 60000,
        growthRate: 1.5 * MB,
        totalGrowth: 3 * MB,
        trend: 'growing',
        snapshots: [1, 2, 3],
      });

      const response = await app.request('/api/dashboard/memory/trend?duration=120000');

      expect(memoryMonitor.analyzeTrend).toHaveBeenCalledWith(120000);
      expect(await response.json()).toMatchObject({
        data: {
          trend: {
            duration: 60000,
            growthRate: 1.5,
            totalGrowth: 3,
            direction: 'growing',
            snapshotCount: 3,
          },
        },
      });
    });

    it('GET /resources 返回资源占用统计', async () => {
      resourceMonitor.getStats.mockReturnValueOnce({
        current: {
          activeTimers: 1,
          activeHandles: 2,
          fileDescriptors: 3,
          heapUsed: 2 * MB,
          timestamp: Date.now(),
        },
        trend: 'stable',
        snapshotCount: 4,
      });

      const response = await app.request('/api/dashboard/resources');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          resources: {
            activeTimers: 1,
            activeHandles: 2,
            fileDescriptors: 3,
            heapUsed: 2,
            trend: 'stable',
            snapshotCount: 4,
          },
        },
      });
    });

    it('POST /memory/snapshot 记录快照', async () => {
      memoryMonitor.takeSnapshot.mockReturnValueOnce({
        timestamp: Date.now(),
        rss: 2 * MB,
        heapTotal: 4 * MB,
        heapUsed: 1 * MB,
        external: 0,
      });

      const response = await post('/memory/snapshot');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          snapshot: { rss: 2, heapTotal: 4, heapUsed: 1 },
          message: '内存快照已记录',
        },
      });
    });

    it('POST /memory/gc 触发成功与不可用两种结果', async () => {
      memoryMonitor.forceGC.mockReturnValueOnce(true);
      const ok = await post('/memory/gc');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        data: { message: '垃圾回收已触发' },
      });

      memoryMonitor.forceGC.mockReturnValueOnce(false);
      const unavailable = await post('/memory/gc');
      expect(unavailable.status).toBe(200);
      expect(await unavailable.json()).toMatchObject({
        success: false,
        data: { message: '垃圾回收不可用' },
      });
    });
  });
});

describe('仪表板服务生命周期', () => {
  const hub = {} as unknown as Parameters<typeof initializeDashboardServices>[0];

  afterEach(async () => {
    vi.useRealTimers();
    await shutdownDashboardServices();
  });

  it('initializeDashboardServices 记录系统启动并注册定时任务', async () => {
    vi.useFakeTimers();
    dashboardService.getSystemHealth.mockResolvedValue({ status: 'healthy', issues: [] });

    initializeDashboardServices(hub);

    expect(eventIntegrationService.recordSystemStart).toHaveBeenCalledOnce();

    // 健康状态未变化时不记录；变化时记录健康检查
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(eventIntegrationService.recordHealthCheck).not.toHaveBeenCalled();

    dashboardService.getSystemHealth.mockResolvedValue({ status: 'warning', issues: ['x'] });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(eventIntegrationService.recordHealthCheck).toHaveBeenCalledWith('warning', [
      {
        component: 'system',
        previousStatus: 'healthy',
        currentStatus: 'warning',
      },
    ]);

    // 每日清理任务
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(dashboardService.cleanup).toHaveBeenCalled();
  });

  it('健康检查抛错时被吞掉且不中断后续检查', async () => {
    vi.useFakeTimers();
    dashboardService.getSystemHealth.mockRejectedValue(new Error('探测失败'));

    initializeDashboardServices(hub);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(eventIntegrationService.recordHealthCheck).not.toHaveBeenCalled();

    dashboardService.getSystemHealth.mockResolvedValue({ status: 'error', issues: [] });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(eventIntegrationService.recordHealthCheck).toHaveBeenCalledWith(
      'error',
      expect.any(Array),
    );
  });

  it('重复初始化会先关闭旧的 SSE 管理器', () => {
    initializeDashboardServices(hub);
    initializeDashboardServices(hub);

    expect(sseEventManager.shutdown).toHaveBeenCalled();
  });

  it('shutdownDashboardServices 关闭 SSE 并清空实例', async () => {
    initializeDashboardServices(hub);
    sseEventManager.shutdown.mockClear();

    await shutdownDashboardServices();

    expect(sseEventManager.shutdown).toHaveBeenCalledOnce();
  });
});

describe('仪表板 API 行为补强', () => {
  let app: Hono;
  const hub = {} as unknown as Parameters<typeof initializeDashboardServices>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'dashboard-request');
      await next();
    });
    app.route('/api/dashboard', dashboardApi);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await shutdownDashboardServices();
  });

  function post(path: string, body: unknown = {}): Promise<Response> {
    return app.request(`/api/dashboard${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function expectFailure(path: string, init?: RequestInit): Promise<void> {
    const response = await app.request(`/api/dashboard${path}`, init);
    expect(response.status, `${path} 应返回 500`).toBe(500);
    const body = (await response.json()) as { success: boolean };
    expect(body.success, `${path} 应返回失败响应体`).toBe(false);
  }

  it('各服务端点失败时返回 500 与失败响应体', async () => {
    dashboardService.getDashboardStats.mockRejectedValueOnce(new Error('统计失败'));
    await expectFailure('/stats');

    dashboardService.getSystemHealth.mockRejectedValueOnce(new Error('健康检查失败'));
    await expectFailure('/health');

    dashboardService.queryLogs.mockImplementationOnce(() => {
      throw new Error('日志查询失败');
    });
    await expectFailure('/logs');

    dashboardService.getRecentActivities.mockImplementationOnce(() => {
      throw new Error('活动查询失败');
    });
    await expectFailure('/activities');

    dashboardService.getPerformanceStats.mockImplementationOnce(() => {
      throw new Error('性能统计失败');
    });
    await expectFailure('/performance');

    sseEventManager.createConnection.mockImplementationOnce(() => {
      throw new Error('连接耗尽');
    });
    await expectFailure('/events');

    sseEventManager.getConnectionStats.mockImplementationOnce(() => {
      throw new Error('统计不可用');
    });
    await expectFailure('/sse-stats');
  });

  it('开发用端点失败时返回 500 与失败响应体', async () => {
    sseEventManager.broadcastSystemAlert.mockImplementationOnce(() => {
      throw new Error('广播失败');
    });
    await expectFailure('/test-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    sseEventManager.broadcastToolExecution.mockImplementationOnce(() => {
      throw new Error('广播失败');
    });
    await expectFailure('/test-tool-execution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    sseEventManager.broadcastServerStatus.mockImplementationOnce(() => {
      throw new Error('广播失败');
    });
    await expectFailure('/test-server-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    dashboardService.addLog.mockImplementationOnce(() => {
      throw new Error('日志写入失败');
    });
    await expectFailure('/add-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    dashboardService.cleanup.mockImplementationOnce(() => {
      throw new Error('清理失败');
    });
    await expectFailure('/logs', { method: 'DELETE' });
  });

  it('监控端点失败时返回 500 与失败响应体', async () => {
    const memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockImplementationOnce(() => {
      throw new Error('内存信息不可用');
    });
    await expectFailure('/system-info');
    memoryUsageSpy.mockRestore();

    dashboardService.getSystemHealth.mockRejectedValueOnce(new Error('健康检查失败'));
    await expectFailure('/health-detailed');

    memoryMonitor.getCurrentMemory.mockImplementationOnce(() => {
      throw new Error('内存监控不可用');
    });
    await expectFailure('/memory');

    memoryMonitor.analyzeTrend.mockImplementationOnce(() => {
      throw new Error('趋势分析失败');
    });
    await expectFailure('/memory/trend');

    resourceMonitor.getStats.mockImplementationOnce(() => {
      throw new Error('资源监控不可用');
    });
    await expectFailure('/resources');

    memoryMonitor.takeSnapshot.mockImplementationOnce(() => {
      throw new Error('快照失败');
    });
    await expectFailure('/memory/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    memoryMonitor.forceGC.mockImplementationOnce(() => {
      throw new Error('GC 失败');
    });
    await expectFailure('/memory/gc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  });

  it('GET /system-info 按固定内存数据精确换算 MB', async () => {
    const memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 2 * MB,
      heapTotal: 4 * MB,
      heapUsed: 1 * MB,
      external: 1 * MB,
      arrayBuffers: 2 * MB,
    } as NodeJS.MemoryUsage);

    const response = await app.request('/api/dashboard/system-info');

    expect((await response.json()).data.memory).toStrictEqual({
      rss: 2,
      heapTotal: 4,
      heapUsed: 1,
      external: 1,
      arrayBuffers: 2,
    });
    memoryUsageSpy.mockRestore();
  });

  it('GET /health-detailed 的进程内存占用率按堆内存精确计算', async () => {
    const memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 2 * MB,
      heapTotal: 4 * MB,
      heapUsed: 1 * MB,
      external: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
    dashboardService.getSystemHealth.mockResolvedValueOnce({ status: 'healthy', issues: [] });

    const response = await app.request('/api/dashboard/health-detailed');

    const data = (await response.json()).data;
    expect(data.additionalChecks.processHealth.status).toBe('healthy');
    expect(data.additionalChecks.processHealth.message).toBe('进程运行正常');
    expect(data.additionalChecks.processHealth.details.memoryUsage).toBe(25);
    memoryUsageSpy.mockRestore();
  });

  it('GET /memory 的 arrayBuffers 换算为 MB（非零值）', async () => {
    memoryMonitor.getCurrentMemory.mockReturnValueOnce({
      rss: 2 * MB,
      heapTotal: 4 * MB,
      heapUsed: 1 * MB,
      external: 0,
      arrayBuffers: 3 * MB,
      timestamp: Date.now(),
    });

    const response = await app.request('/api/dashboard/memory');

    expect((await response.json()).data.memory.arrayBuffers).toBe(3);
  });

  it('POST /memory/snapshot 的 external 换算为 MB（非零值）', async () => {
    memoryMonitor.takeSnapshot.mockReturnValueOnce({
      timestamp: Date.now(),
      rss: 2 * MB,
      heapTotal: 4 * MB,
      heapUsed: 1 * MB,
      external: 3 * MB,
    });

    const response = await post('/memory/snapshot');

    expect((await response.json()).data.snapshot.external).toBe(3);
  });

  it('POST /memory/gc 响应携带 note 字段', async () => {
    memoryMonitor.forceGC.mockReturnValueOnce(true);
    const ok = await post('/memory/gc');
    expect(await ok.json()).toMatchObject({
      success: true,
      data: {
        message: '垃圾回收已触发',
        note: '需要使用 --expose-gc 标志启动进程才能使用此功能',
      },
    });

    memoryMonitor.forceGC.mockReturnValueOnce(false);
    const unavailable = await post('/memory/gc');
    expect(await unavailable.json()).toMatchObject({
      success: false,
      data: {
        message: '垃圾回收不可用',
        note: '需要使用 --expose-gc 标志启动进程才能使用此功能',
      },
    });
    expect(loggerMock.warn).toHaveBeenCalledWith('垃圾回收不可用');
  });

  it('GET /system-info 在 NODE_ENV 为空时回退 development', async () => {
    vi.stubEnv('NODE_ENV', '');

    const response = await app.request('/api/dashboard/system-info');

    expect((await response.json()).data.environment.nodeEnv).toBe('development');
  });

  it('成功路径记录各端点日志', async () => {
    dashboardService.getDashboardStats.mockResolvedValueOnce({
      overview: { totalServers: 1, connectedServers: 1, totalTools: 1 },
      recentActivity: [],
    });
    await app.request('/api/dashboard/stats');
    expect(loggerMock.debug).toHaveBeenCalledWith('获取仪表板统计信息请求');
    expect(loggerMock.info).toHaveBeenCalledWith('仪表板统计信息获取成功', {
      totalServers: 1,
      connectedServers: 1,
      totalTools: 1,
      recentActivityCount: 0,
    });

    dashboardService.getSystemHealth.mockResolvedValueOnce({ status: 'healthy', issues: [] });
    await app.request('/api/dashboard/health');
    expect(loggerMock.debug).toHaveBeenCalledWith('获取系统健康状态请求');
    expect(loggerMock.debug).toHaveBeenCalledWith('系统健康状态获取成功', {
      status: 'healthy',
      issueCount: 0,
    });

    dashboardService.queryLogs.mockReturnValueOnce({ logs: [], total: 0 });
    await app.request('/api/dashboard/logs');
    expect(loggerMock.debug).toHaveBeenCalledWith('查询系统日志请求');
    expect(loggerMock.debug).toHaveBeenCalledWith(
      '系统日志查询成功',
      expect.objectContaining({ totalLogs: 0, returnedLogs: 0 }),
    );

    dashboardService.getRecentActivities.mockReturnValueOnce([]);
    await app.request('/api/dashboard/activities');
    expect(loggerMock.debug).toHaveBeenCalledWith('获取最近活动请求');

    dashboardService.getPerformanceStats.mockReturnValueOnce({
      totalRequests: 1,
      averageResponseTime: 1,
      errorRate: 0,
    });
    await app.request('/api/dashboard/performance');
    expect(loggerMock.debug).toHaveBeenCalledWith('获取性能统计请求');

    sseEventManager.getConnectionStats.mockReturnValueOnce({
      totalClients: 0,
      eventHistoryCount: 0,
    });
    await app.request('/api/dashboard/sse-stats');
    expect(loggerMock.debug).toHaveBeenCalledWith('获取SSE连接统计请求');
  });

  it('SSE 连接建立与失败路径日志完整', async () => {
    const sseResponse = new Response('data: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    sseEventManager.createConnection.mockReturnValueOnce({ response: sseResponse, clientId: 'c1' });

    await app.request('/api/dashboard/events?subscriptions=tools');

    expect(loggerMock.info).toHaveBeenCalledWith('创建SSE连接请求');
    expect(loggerMock.info).toHaveBeenCalledWith('SSE连接创建成功', {
      clientId: 'c1',
      subscriptions: ['tools'],
    });

    sseEventManager.createConnection.mockImplementationOnce(() => {
      throw new Error('连接耗尽');
    });
    await app.request('/api/dashboard/events');
    expect(loggerMock.error).toHaveBeenCalledWith('创建SSE连接失败', expect.any(Error));
  });

  it('test-alert / add-log / 删除日志记录日志', async () => {
    await post('/test-alert', { severity: 'warning', message: '磁盘告急', category: 'disk' });
    expect(loggerMock.debug).toHaveBeenCalledWith('发送测试告警', {
      severity: 'warning',
      message: '磁盘告急',
      category: 'disk',
    });

    await post('/test-tool-execution', { toolName: 'search', serverId: 'srv', groupId: 'g' });
    expect(loggerMock.debug).toHaveBeenCalledWith(
      '发送测试工具执行事件',
      expect.objectContaining({ toolName: 'search', serverId: 'srv', groupId: 'g' }),
    );

    await post('/test-server-status', { serverId: 'a', status: 'connected' });
    expect(loggerMock.debug).toHaveBeenCalledWith('发送测试服务器状态事件', {
      serverId: 'a',
      status: 'connected',
      previousStatus: 'disconnected',
    });

    await post('/add-log', { level: 'warn', message: 'hello' });
    expect(loggerMock.debug).toHaveBeenCalledWith('添加自定义日志', {
      level: 'warn',
      message: 'hello',
      category: 'test',
    });

    await app.request('/api/dashboard/logs', { method: 'DELETE' });
    expect(loggerMock.info).toHaveBeenCalledWith('清理日志请求');
    expect(loggerMock.info).toHaveBeenCalledWith('日志清理完成');
  });

  it('test-server-status 响应包含固定消息', async () => {
    const response = await post('/test-server-status', { serverId: 'a', status: 'connected' });

    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        message: '测试服务器状态事件已发送',
        serverId: 'a',
        status: 'connected',
        previousStatus: 'disconnected',
      },
    });
  });

  it('服务未初始化时懒创建仪表板服务并告警', async () => {
    await shutdownDashboardServices();
    dashboardService.getDashboardStats.mockResolvedValueOnce({
      overview: {},
      recentActivity: [],
    });

    const response = await app.request('/api/dashboard/stats');

    expect(response.status).toBe(200);
    expect(loggerMock.warn).toHaveBeenCalledWith('仪表板服务未初始化，创建临时实例用于测试');
  });

  it('SSE 管理器与事件集成服务未初始化时懒创建并告警', async () => {
    await shutdownDashboardServices();
    sseEventManager.getConnectionStats.mockReturnValueOnce({
      totalClients: 0,
      eventHistoryCount: 0,
    });

    await app.request('/api/dashboard/sse-stats');
    expect(loggerMock.warn).toHaveBeenCalledWith('SSE事件管理器未初始化，创建临时实例');

    const integration = getEventIntegrationService();
    expect(integration).toBe(eventIntegrationService);
    expect(loggerMock.warn).toHaveBeenCalledWith('事件集成服务未初始化，创建临时实例');
  });

  it('初始化注册每日清理与每 5 分钟健康检查定时器并 unref', () => {
    const timer = { unref: vi.fn() };
    const setIntervalSpy = vi.fn(() => timer);
    const clearIntervalSpy = vi.fn();
    vi.stubGlobal('setInterval', setIntervalSpy);
    vi.stubGlobal('clearInterval', clearIntervalSpy);

    initializeDashboardServices(hub);

    expect(setIntervalSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 24 * 60 * 60 * 1000);
    expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 5 * 60 * 1000);
    expect(timer.unref).toHaveBeenCalledTimes(2);
    expect(loggerMock.info).toHaveBeenCalledWith('初始化仪表板服务');
    expect(loggerMock.info).toHaveBeenCalledWith('仪表板服务初始化完成');

    // 重复初始化时先清理旧定时器
    clearIntervalSpy.mockClear();
    initializeDashboardServices(hub);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('定时器句柄无 unref 方法时初始化不报错', () => {
    vi.stubGlobal(
      'setInterval',
      vi.fn(() => 42 as unknown as NodeJS.Timeout),
    );
    vi.stubGlobal('clearInterval', vi.fn());

    expect(() => initializeDashboardServices(hub)).not.toThrow();
  });

  it('关闭后定时器回调不再触发错误日志', async () => {
    vi.useFakeTimers();
    initializeDashboardServices(hub);
    await shutdownDashboardServices();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 5 * 60 * 1000);

    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('关闭时 SSE shutdown 抛错则记录并向上抛出', async () => {
    initializeDashboardServices(hub);
    sseEventManager.shutdown.mockImplementationOnce(() => {
      throw new Error('关闭失败');
    });

    await expect(shutdownDashboardServices()).rejects.toThrow('关闭失败');
    expect(loggerMock.error).toHaveBeenCalledWith('关闭仪表板服务时发生错误', expect.any(Error));
  });

  it('正常关闭记录日志', async () => {
    initializeDashboardServices(hub);
    sseEventManager.shutdown.mockClear();

    await shutdownDashboardServices();

    expect(loggerMock.info).toHaveBeenCalledWith('关闭仪表板服务');
    expect(loggerMock.info).toHaveBeenCalledWith('仪表板服务关闭完成');
  });
});
