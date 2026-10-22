import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDashboardStore } from '../dashboard';
import { dashboardService } from '@/services/dashboard';
import { sseService } from '@/services/sse';

import type { DashboardStats, SystemHealth } from '@/types/dashboard';

// Mock services
vi.mock('@/services/dashboard', () => ({
  dashboardService: {
    getDashboardStats: vi.fn(),
    getSystemHealth: vi.fn(),
    getPerformanceStats: vi.fn(),
    getSystemInfo: vi.fn(),
    queryLogs: vi.fn(),
    getRecentActivities: vi.fn(),
    getSSEStats: vi.fn(),
  },
}));

vi.mock('@/services/sse', () => ({
  sseService: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionState: vi.fn(() => 'closed'),
    addEventListener: vi.fn(),
    removeAllEventListeners: vi.fn(),
    onServerStatus: vi.fn(),
    onToolExecution: vi.fn(),
    onSystemAlert: vi.fn(),
    onHealthCheck: vi.fn(),
  },
}));

const makeStats = (totalServers: number, connectedServers: number): DashboardStats => ({
  overview: {
    totalServers,
    connectedServers,
    totalTools: 20,
    totalGroups: 3,
    apiTools: 0,
  },
  recentActivity: [],
  systemHealth: {
    status: 'healthy',
    issues: [],
    uptime: 100,
  },
  performance: {
    totalRequests: 0,
    averageResponseTime: 0,
    errorRate: 0,
    topTools: [],
  },
});

const makeHealth = (status: SystemHealth['status']): SystemHealth => ({
  status,
  issues: [],
  checks: {
    servers: { status: 'healthy', message: 'ok', details: { total: 0, connected: 0, failed: 0 } },
    groups: { status: 'healthy', message: 'ok', details: { total: 0, healthy: 0, unhealthy: 0 } },
    apiTools: {
      status: 'healthy',
      message: 'ok',
      details: { initialized: true, totalTools: 0, errors: [] },
    },
    memory: { status: 'healthy', message: 'ok', details: { used: 0, total: 0, percentage: 0 } },
  },
  uptime: 100,
  lastCheck: '2024-01-01T00:00:00.000Z',
});

describe('Dashboard Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('应该正确初始化状态', () => {
    const store = useDashboardStore();

    expect(store.stats).toBeNull();
    expect(store.systemHealth).toBeNull();
    expect(store.performanceStats).toBeNull();
    expect(store.systemInfo).toBeNull();
    expect(store.sseStats).toBeNull();
    expect(store.activities).toEqual([]);
    expect(store.logs).toEqual([]);
    expect(store.loading).toEqual({
      stats: false,
      health: false,
      performance: false,
      logs: false,
      activities: false,
      systemInfo: false,
    });
    expect(store.error).toBeNull();
    expect(store.sseConnected).toBe(false);
    expect(store.sseConnectionState).toBe('closed');
  });

  it('应该正确计算健康状态', () => {
    const store = useDashboardStore();

    // 初始状态
    expect(store.isHealthy).toBe(false);
    expect(store.hasWarnings).toBe(false);
    expect(store.hasErrors).toBe(false);

    // 设置健康状态
    store.systemHealth = makeHealth('healthy');

    expect(store.isHealthy).toBe(true);
    expect(store.hasWarnings).toBe(false);
    expect(store.hasErrors).toBe(false);

    store.systemHealth = makeHealth('warning');
    expect(store.isHealthy).toBe(false);
    expect(store.hasWarnings).toBe(true);

    store.systemHealth = makeHealth('error');
    expect(store.hasErrors).toBe(true);
  });

  it('应该正确计算统计卡片数据', () => {
    const store = useDashboardStore();

    // 设置模拟数据
    store.stats = makeStats(5, 4);

    const cards = store.statCards;
    expect(cards).toHaveLength(4);
    expect(cards[0].value).toBe(5);
    expect(cards[0].label).toBe('总服务器数');
    expect(cards[1].value).toBe(4);
    expect(cards[1].label).toBe('已连接服务器');
    expect(cards[2].value).toBe(20);
    expect(cards[2].label).toBe('可用工具数');
    expect(cards[3].value).toBe(3);
    expect(cards[3].label).toBe('服务器组数');
  });

  it('应该正确计算服务器连接率', () => {
    const store = useDashboardStore();

    // 无统计数据时为 0
    expect(store.serverConnectionRate).toBe(0);

    store.stats = makeStats(10, 8);
    expect(store.serverConnectionRate).toBe(80);

    // 服务器数为 0 时避免除零
    store.stats = makeStats(0, 0);
    expect(store.serverConnectionRate).toBe(0);
  });

  it('统计卡片连接率趋势按阈值划分', () => {
    const store = useDashboardStore();

    store.stats = makeStats(10, 8); // 80%
    expect(store.statCards[1].trend?.direction).toBe('up');

    store.stats = makeStats(10, 5); // 50%
    expect(store.statCards[1].trend?.direction).toBe('stable');

    store.stats = makeStats(10, 4); // 40%
    expect(store.statCards[1].trend?.direction).toBe('down');

    // 无统计数据时没有卡片
    store.stats = null;
    expect(store.statCards).toEqual([]);
  });

  it('应该正确计算错误事件数量', () => {
    const store = useDashboardStore();

    const oneHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    store.activities = [
      { id: '1', type: 'error', message: '最近错误', timestamp: oneHourAgo, severity: 'error' },
      { id: '2', type: 'error', message: '较早错误', timestamp: twoHoursAgo, severity: 'error' },
      // 非 error 级别的活动不计入
      {
        id: '3',
        type: 'system_start',
        message: '普通信息',
        timestamp: oneHourAgo,
        severity: 'info',
      },
    ];

    expect(store.recentErrorCount).toBe(1);
  });

  describe('数据获取', () => {
    it('fetchDashboardStats 成功时保存数据并记录更新时间', async () => {
      const stats = makeStats(1, 1);
      vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(stats);

      const store = useDashboardStore();
      await store.fetchDashboardStats();

      expect(store.stats).toEqual(stats);
      expect(store.error).toBeNull();
      expect(store.loading.stats).toBe(false);
      expect(store.lastUpdated.stats).toBeDefined();
    });

    it('fetchDashboardStats 请求期间处于加载状态', async () => {
      let resolveFn!: (value: DashboardStats) => void;
      vi.mocked(dashboardService.getDashboardStats).mockImplementation(
        () => new Promise<DashboardStats>((resolve) => (resolveFn = resolve)),
      );

      const store = useDashboardStore();
      const pending = store.fetchDashboardStats();

      expect(store.loading.stats).toBe(true);

      resolveFn(makeStats(0, 0));
      await pending;
    });

    it('fetchDashboardStats 失败时记录 Error 消息', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockRejectedValue(new Error('超时'));

      const store = useDashboardStore();
      await store.fetchDashboardStats();

      expect(store.error).toBe('超时');
      expect(store.loading.stats).toBe(false);
    });

    it('fetchDashboardStats 失败时非 Error 对象使用默认错误消息', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockRejectedValue(null);

      const store = useDashboardStore();
      await store.fetchDashboardStats();

      expect(store.error).toBe('获取仪表板统计失败');
    });

    it('fetchSystemHealth 成功时保存并结束加载', async () => {
      const health = makeHealth('healthy');
      vi.mocked(dashboardService.getSystemHealth).mockResolvedValue(health);

      const store = useDashboardStore();
      await store.fetchSystemHealth();

      expect(store.systemHealth).toEqual(health);
      expect(store.loading.health).toBe(false);
    });

    it('fetchSystemHealth 失败时不设置 error 字段', async () => {
      vi.mocked(dashboardService.getSystemHealth).mockRejectedValue(new Error('x'));

      const store = useDashboardStore();
      await store.fetchSystemHealth();

      expect(store.error).toBeNull();
      expect(store.loading.health).toBe(false);
    });

    it('fetchPerformanceStats 成功时保存', async () => {
      const performance = {
        totalRequests: 1,
        averageResponseTime: 1,
        errorRate: 0,
        topTools: [],
      };
      vi.mocked(dashboardService.getPerformanceStats).mockResolvedValue(performance);

      const store = useDashboardStore();
      await store.fetchPerformanceStats();

      expect(store.performanceStats).toEqual(performance);
      expect(store.loading.performance).toBe(false);
    });

    it('fetchSystemInfo 成功时保存', async () => {
      const systemInfo = { version: '1.0.0', nodeVersion: 'v20', uptime: 10, hostname: 'h' };
      vi.mocked(dashboardService.getSystemInfo).mockResolvedValue(systemInfo as never);

      const store = useDashboardStore();
      await store.fetchSystemInfo();

      expect(store.systemInfo).toEqual(systemInfo);
      expect(store.loading.systemInfo).toBe(false);
    });

    it('fetchLogs 成功时保存日志并透传查询', async () => {
      const logs = [{ id: 'l1', timestamp: '', level: 'info', message: 'm', category: 'app' }];
      vi.mocked(dashboardService.queryLogs).mockResolvedValue({
        logs: logs as never[],
        total: 1,
        query: { level: 'info', limit: 10 },
      });

      const store = useDashboardStore();
      await store.fetchLogs({ level: 'info', limit: 10 });

      expect(dashboardService.queryLogs).toHaveBeenCalledWith({ level: 'info', limit: 10 });
      expect(store.logs).toEqual(logs);
      expect(store.loading.logs).toBe(false);
    });

    it('fetchActivities 成功时保存活动并透传 limit', async () => {
      const activities = [
        { id: 'a1', type: 'info', message: 'm', timestamp: '', severity: 'info' },
      ];
      vi.mocked(dashboardService.getRecentActivities).mockResolvedValue({
        activities: activities as never[],
        total: 1,
      });

      const store = useDashboardStore();
      await store.fetchActivities(25);

      expect(dashboardService.getRecentActivities).toHaveBeenCalledWith(25);
      expect(store.activities).toEqual(activities);
    });

    it('fetchActivities 默认 limit 为 50', async () => {
      vi.mocked(dashboardService.getRecentActivities).mockResolvedValue({
        activities: [],
        total: 0,
      });

      const store = useDashboardStore();
      await store.fetchActivities();

      expect(dashboardService.getRecentActivities).toHaveBeenCalledWith(50);
    });

    it('fetchSSEStats 成功时保存统计', async () => {
      const sseStats = { connectedClients: 3, totalEventsSent: 100, eventsPerSecond: 1 };
      vi.mocked(dashboardService.getSSEStats).mockResolvedValue(sseStats as never);

      const store = useDashboardStore();
      await store.fetchSSEStats();

      expect(store.sseStats).toEqual(sseStats);
    });
  });

  describe('SSE 连接管理', () => {
    it('connectSSE 成功时标记已连接并注册事件监听', async () => {
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE(['server_status']);

      expect(sseService.connect).toHaveBeenCalledWith(['server_status']);
      expect(store.sseConnected).toBe(true);
      expect(store.sseConnectionState).toBe('open');
      expect(sseService.removeAllEventListeners).toHaveBeenCalled();
      expect(sseService.onServerStatus).toHaveBeenCalled();
      expect(sseService.onToolExecution).toHaveBeenCalled();
      expect(sseService.onSystemAlert).toHaveBeenCalled();
      expect(sseService.onHealthCheck).toHaveBeenCalled();
    });

    it('connectSSE 默认不传订阅参数', async () => {
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();

      expect(sseService.connect).toHaveBeenCalledWith([]);
    });

    it('connectSSE 失败时标记为断开', async () => {
      vi.mocked(sseService.connect).mockRejectedValue(new Error('无法连接'));

      const store = useDashboardStore();
      await store.connectSSE();

      expect(store.sseConnected).toBe(false);
      expect(store.sseConnectionState).toBe('closed');
    });

    it('disconnectSSE 断开连接并复位状态', async () => {
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();
      store.disconnectSSE();

      expect(sseService.disconnect).toHaveBeenCalled();
      expect(store.sseConnected).toBe(false);
      expect(store.sseConnectionState).toBe('closed');
    });

    it('cleanup 断开连接并移除全部监听', () => {
      const store = useDashboardStore();

      store.cleanup();

      expect(sseService.disconnect).toHaveBeenCalled();
      expect(sseService.removeAllEventListeners).toHaveBeenCalled();
    });
  });

  describe('SSE 事件处理器', () => {
    it('服务器状态事件：刷新统计并写入活动', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(makeStats(1, 1));
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();

      const handler = vi.mocked(sseService.onServerStatus).mock.calls[0][0];
      handler({ serverId: 's1', status: 'connected', timestamp: new Date().toISOString() });
      await Promise.resolve();

      expect(dashboardService.getDashboardStats).toHaveBeenCalledTimes(1);
      expect(store.activities).toHaveLength(1);
      expect(store.activities[0].type).toBe('server_connected');
      expect(store.activities[0].severity).toBe('info');
      expect(store.activities[0].message).toContain('s1');
      expect(store.activities[0].message).toContain('已连接');
    });

    it('服务器断开事件：活动类型为 server_disconnected', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(makeStats(1, 1));
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();

      const handler = vi.mocked(sseService.onServerStatus).mock.calls[0][0];
      handler({ serverId: 's2', status: 'disconnected', timestamp: new Date().toISOString() });
      await Promise.resolve();

      expect(store.activities[0].type).toBe('server_disconnected');
      expect(store.activities[0].message).toContain('已断开');
    });

    it('服务器错误状态事件：severity 为 error', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(makeStats(1, 1));
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();

      const handler = vi.mocked(sseService.onServerStatus).mock.calls[0][0];
      handler({ serverId: 's3', status: 'error', timestamp: new Date().toISOString() });
      await Promise.resolve();

      expect(store.activities[0].severity).toBe('error');
    });

    it('服务器状态事件超过 100 条时截断', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(makeStats(1, 1));
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      store.activities = Array.from({ length: 100 }, (_, i) => ({
        id: `old-${i}`,
        type: 'system_start',
        message: '',
        timestamp: '',
        severity: 'info',
      }));
      await store.connectSSE();

      const handler = vi.mocked(sseService.onServerStatus).mock.calls[0][0];
      handler({ serverId: 's1', status: 'connected', timestamp: new Date().toISOString() });
      await Promise.resolve();

      expect(store.activities).toHaveLength(100);
      expect(store.activities[0].id).not.toBe('old-0');
    });

    it('工具执行事件：成功与失败的消息和级别不同', async () => {
      vi.mocked(dashboardService.getPerformanceStats).mockResolvedValue({
        totalRequests: 0,
        averageResponseTime: 0,
        errorRate: 0,
        topTools: [],
      });
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();

      const handler = vi.mocked(sseService.onToolExecution).mock.calls[0][0];
      handler({
        toolName: 't1',
        serverId: 's1',
        groupId: 'default',
        executionTime: 5,
        success: true,
        timestamp: new Date().toISOString(),
      });
      handler({
        toolName: 't2',
        serverId: 's1',
        groupId: 'default',
        executionTime: 5,
        success: false,
        timestamp: new Date().toISOString(),
      });
      await Promise.resolve();

      expect(dashboardService.getPerformanceStats).toHaveBeenCalledTimes(2);
      expect(store.activities).toHaveLength(2);
      expect(store.activities[1].message).toContain('执行成功');
      expect(store.activities[1].severity).toBe('info');
      expect(store.activities[0].message).toContain('执行失败');
      expect(store.activities[0].severity).toBe('error');
    });

    it('系统告警事件：写入活动并保留分类元数据', async () => {
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();

      const handler = vi.mocked(sseService.onSystemAlert).mock.calls[0][0];
      handler({
        message: '磁盘空间不足',
        severity: 'warning',
        category: 'system',
        metadata: { disk: 'sda' },
        timestamp: '',
      });
      await Promise.resolve();

      expect(store.activities).toHaveLength(1);
      expect(store.activities[0].message).toBe('磁盘空间不足');
      expect(store.activities[0].severity).toBe('warning');
      expect(store.activities[0].metadata).toEqual({ category: 'system', disk: 'sda' });
    });

    it('健康检查事件：更新现有健康状态', async () => {
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      store.systemHealth = makeHealth('healthy');
      await store.connectSSE();

      const handler = vi.mocked(sseService.onHealthCheck).mock.calls[0][0];
      handler({
        status: 'warning',
        timestamp: new Date().toISOString(),
        lastCheck: '2024-06-01T00:00:00.000Z',
        changes: [],
      });

      expect(store.systemHealth?.status).toBe('warning');
      expect(store.systemHealth?.lastCheck).toBe('2024-06-01T00:00:00.000Z');
    });

    it('健康检查事件：lastCheck 缺省时使用当前时间', async () => {
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      store.systemHealth = makeHealth('healthy');
      await store.connectSSE();

      const handler = vi.mocked(sseService.onHealthCheck).mock.calls[0][0];
      handler({ status: 'error', timestamp: new Date().toISOString(), changes: [] });

      expect(store.systemHealth?.status).toBe('error');
      expect(store.systemHealth?.lastCheck).toBeDefined();
      expect(store.systemHealth?.lastCheck).not.toBe('2024-01-01T00:00:00.000Z');
    });

    it('健康检查事件：无健康状态时不创建', async () => {
      vi.mocked(sseService.connect).mockResolvedValue(undefined);

      const store = useDashboardStore();
      await store.connectSSE();

      const handler = vi.mocked(sseService.onHealthCheck).mock.calls[0][0];
      handler({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        lastCheck: '',
        changes: [],
      });

      expect(store.systemHealth).toBeNull();
    });
  });

  describe('初始化与刷新', () => {
    it('initializeDashboard 并行拉取全部数据', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(makeStats(0, 0));
      vi.mocked(dashboardService.getSystemHealth).mockResolvedValue(makeHealth('healthy'));
      vi.mocked(dashboardService.getPerformanceStats).mockResolvedValue({
        totalRequests: 0,
        averageResponseTime: 0,
        errorRate: 0,
        topTools: [],
      });
      vi.mocked(dashboardService.getSystemInfo).mockResolvedValue({} as never);
      vi.mocked(dashboardService.getRecentActivities).mockResolvedValue({
        activities: [],
        total: 0,
      });

      const store = useDashboardStore();
      await store.initializeDashboard();

      expect(dashboardService.getDashboardStats).toHaveBeenCalledTimes(1);
      expect(dashboardService.getSystemHealth).toHaveBeenCalledTimes(1);
      expect(dashboardService.getPerformanceStats).toHaveBeenCalledTimes(1);
      expect(dashboardService.getSystemInfo).toHaveBeenCalledTimes(1);
      expect(dashboardService.getRecentActivities).toHaveBeenCalledTimes(1);
    });

    it('refreshAll 等价于重新初始化', async () => {
      vi.mocked(dashboardService.getDashboardStats).mockResolvedValue(makeStats(0, 0));
      vi.mocked(dashboardService.getSystemHealth).mockResolvedValue(makeHealth('healthy'));
      vi.mocked(dashboardService.getPerformanceStats).mockResolvedValue({
        totalRequests: 0,
        averageResponseTime: 0,
        errorRate: 0,
        topTools: [],
      });
      vi.mocked(dashboardService.getSystemInfo).mockResolvedValue({} as never);
      vi.mocked(dashboardService.getRecentActivities).mockResolvedValue({
        activities: [],
        total: 0,
      });

      const store = useDashboardStore();
      await store.refreshAll();

      expect(dashboardService.getDashboardStats).toHaveBeenCalledTimes(1);
      expect(dashboardService.getRecentActivities).toHaveBeenCalledTimes(1);
    });
  });
});
