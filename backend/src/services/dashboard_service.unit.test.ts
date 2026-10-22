import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardService } from './dashboard_service.js';

import type { Activity } from '../types/dashboard.js';
import type { McpKnotService } from './mcp_knot_service.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockHub(overrides: Partial<McpKnotService> = {}) {
  const detailedStatus = {
    isInitialized: true,
    serverCount: 2,
    connectedServers: 2,
    groupCount: 1,
    totalTools: 5,
    apiTools: 3,
  };
  return {
    getDetailedServiceStatus: vi.fn().mockResolvedValue(detailedStatus),
    getServerHealth: vi.fn().mockReturnValue(
      new Map([
        ['s1', 'connected'],
        ['s2', 'connected'],
      ]),
    ),
    getAllGroups: vi.fn().mockReturnValue(new Map([['default', { id: 'default' }]])),
    listTools: vi.fn().mockResolvedValue([{ name: 't1' }, { name: 't2' }]),
    getApiToolServiceHealth: vi.fn().mockReturnValue({ initialized: true, healthy: true }),
    ...overrides,
  } as unknown as McpKnotService;
}

describe('DashboardService', () => {
  let hub: McpKnotService;
  let service: DashboardService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T08:00:00.000Z'));
    hub = createMockHub();
    service = new DashboardService(hub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('构造函数', () => {
    it('构造时记录 system_start 活动', () => {
      const activities = service.getRecentActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        type: 'system_start',
        message: '系统启动完成',
        severity: 'info',
      });
      expect(activities[0]?.id).toMatch(/^activity_/);
      expect(activities[0]?.timestamp).toBe('2026-01-15T08:00:00.000Z');
    });
  });

  describe('addActivity / getRecentActivities', () => {
    it('返回最新在前的活动列表并遵守 limit', () => {
      for (let i = 1; i <= 5; i++) {
        service.addActivity({ type: 'tool_executed', message: `m${i}`, severity: 'info' });
      }
      const recent = service.getRecentActivities(3);
      expect(recent.map((a) => a.message)).toEqual(['m5', 'm4', 'm3']);
    });

    it('默认返回最近 50 条', () => {
      for (let i = 1; i <= 60; i++) {
        service.addActivity({ type: 'error', message: `m${i}`, severity: 'error' });
      }
      const recent = service.getRecentActivities();
      expect(recent).toHaveLength(50);
      expect(recent[0]?.message).toBe('m60');
      expect(recent[49]?.message).toBe('m11');
    });

    it('保留 metadata', () => {
      service.addActivity({
        type: 'server_disconnected',
        message: 'srv down',
        severity: 'warning',
        metadata: { serverId: 's1' },
      });
      expect(service.getRecentActivities()[0]?.metadata).toEqual({ serverId: 's1' });
    });

    it('活动数量超过 1000 时裁剪最旧记录', () => {
      for (let i = 1; i <= 1005; i++) {
        service.addActivity({ type: 'error', message: `m${i}`, severity: 'error' });
      }
      const recent = service.getRecentActivities(2000);
      expect(recent).toHaveLength(1000);
      expect(recent[0]?.message).toBe('m1005');
      expect(recent[999]?.message).toBe('m6');
    });
  });

  describe('recordToolExecution / getPerformanceStats', () => {
    it('累计请求数、响应时间与错误数', () => {
      service.recordToolExecution('toolA', 100, true);
      service.recordToolExecution('toolA', 200, true);
      service.recordToolExecution('toolB', 50, false);

      const stats = service.getPerformanceStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.errorCount).toBe(1);
      // (100+200+50)/3 = 116.67
      expect(stats.averageResponseTime).toBe(116.67);
      // 1/3*100 = 33.33
      expect(stats.errorRate).toBe(33.33);
    });

    it('无请求时统计为零', () => {
      const stats = service.getPerformanceStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.averageResponseTime).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.topTools).toEqual([]);
    });

    it('topTools 按调用次数降序且最多 10 个', () => {
      for (let i = 1; i <= 12; i++) {
        // tool01 调用次数最多
        service.recordToolExecution(`tool${String(i).padStart(2, '0')}`, 10, true);
      }
      for (let i = 0; i < 3; i++) {
        service.recordToolExecution('tool01', 10, true);
        service.recordToolExecution('tool02', 10, true);
        service.recordToolExecution('tool03', 10, true);
      }

      const stats = service.getPerformanceStats();
      expect(stats.topTools).toHaveLength(10);
      expect(stats.topTools[0]).toMatchObject({ name: 'tool01', calls: 4, avgTime: 10 });
      expect(stats.topTools[1]?.name).toBe('tool02');
      expect(stats.topTools[2]?.name).toBe('tool03');
      expect(stats.topTools[3]?.calls).toBe(1);
      // 第 11、12 名不出现
      expect(stats.topTools.find((t) => t.name === 'tool12')).toBeUndefined();
    });

    it('toolExecutions 以对象形式返回每个工具的统计', () => {
      service.recordToolExecution('toolA', 100, true);
      service.recordToolExecution('toolA', 300, false);
      const stats = service.getPerformanceStats();
      expect(stats.toolExecutions).toEqual({
        toolA: { calls: 2, totalTime: 400 },
      });
    });
  });

  describe('addLog / queryLogs', () => {
    const addLogs = (svc: DashboardService) => {
      svc.addLog({ level: 'info', message: 'alpha 启动', category: 'system' });
      vi.setSystemTime(new Date('2026-01-15T09:00:00.000Z'));
      svc.addLog({ level: 'error', message: 'beta 崩溃', category: 'db' });
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
      svc.addLog({ level: 'warn', message: 'gamma 慢查询', category: 'db' });
    };

    it('无过滤时按时间倒序返回全部', () => {
      addLogs(service);
      const { logs, total } = service.queryLogs();
      expect(total).toBe(3);
      expect(logs.map((l) => l.message)).toEqual(['gamma 慢查询', 'beta 崩溃', 'alpha 启动']);
      expect(logs[0]?.id).toMatch(/^log_/);
    });

    it('按级别过滤', () => {
      addLogs(service);
      const { logs, total } = service.queryLogs({ level: 'error' });
      expect(total).toBe(1);
      expect(logs[0]?.message).toBe('beta 崩溃');
    });

    it('按分类过滤', () => {
      addLogs(service);
      const { logs, total } = service.queryLogs({ category: 'db' });
      expect(total).toBe(2);
      expect(logs.every((l) => l.category === 'db')).toBe(true);
    });

    it('按开始时间过滤（包含边界）', () => {
      addLogs(service);
      const { total } = service.queryLogs({ startTime: '2026-01-15T09:00:00.000Z' });
      expect(total).toBe(2);
    });

    it('按结束时间过滤（包含边界）', () => {
      addLogs(service);
      const { total } = service.queryLogs({ endTime: '2026-01-15T09:00:00.000Z' });
      expect(total).toBe(2);
    });

    it('按关键词搜索 message 与 category（大小写不敏感）', () => {
      addLogs(service);
      expect(service.queryLogs({ search: 'beta' }).total).toBe(1);
      expect(service.queryLogs({ search: 'db' }).total).toBe(2);
      expect(service.queryLogs({ search: 'BETA' }).total).toBe(1);
      expect(service.queryLogs({ search: '不存在' }).total).toBe(0);
    });

    it('组合过滤求交集', () => {
      addLogs(service);
      const { total } = service.queryLogs({ category: 'db', level: 'warn' });
      expect(total).toBe(1);
    });

    it('分页：offset 与 limit 生效，total 不变', () => {
      addLogs(service);
      const page1 = service.queryLogs({ limit: 2 });
      expect(page1.logs).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = service.queryLogs({ limit: 2, offset: 2 });
      expect(page2.logs).toHaveLength(1);
      expect(page2.logs[0]?.message).toBe('alpha 启动');
    });

    it('日志数量超过 5000 时裁剪最旧的记录', () => {
      for (let i = 0; i < 5005; i++) {
        service.addLog({ level: 'info', message: `m${i}`, category: 'c' });
      }
      const { logs, total } = service.queryLogs({ limit: 6000 });
      expect(total).toBe(5000);
      // 最旧的 m0..m4 被裁剪
      const names = new Set(logs.map((l) => l.message));
      expect(names.has('m0')).toBe(false);
      expect(names.has('m4')).toBe(false);
      expect(names.has('m5')).toBe(true);
      expect(names.has('m5004')).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('清理一周前的活动与日志', () => {
      service.addActivity({ type: 'error', message: 'old-activity', severity: 'error' });
      service.addLog({ level: 'info', message: 'old-log', category: 'c' });

      vi.setSystemTime(new Date('2026-01-20T08:00:00.000Z')); // 5 天后：保留
      service.cleanup();
      expect(service.queryLogs().total).toBeGreaterThan(0);
      expect(service.getRecentActivities().length).toBeGreaterThan(0);

      vi.setSystemTime(new Date('2026-01-25T08:00:00.000Z')); // 10 天后：清理
      service.cleanup();
      // system_start 活动也超时被清理
      expect(service.getRecentActivities()).toHaveLength(0);
      expect(service.queryLogs().total).toBe(0);
    });
  });

  describe('getSystemHealth', () => {
    it('全部正常时状态 healthy 且无 issue', async () => {
      const health = await service.getSystemHealth();
      expect(health.status).toBe('healthy');
      expect(health.issues).toEqual([]);
      expect(health.checks.servers.status).toBe('healthy');
      expect(health.checks.servers.message).toBe('2 个服务器正常连接');
      expect(health.checks.servers.details).toEqual({ total: 2, connected: 2, failed: 0 });
      expect(health.checks.groups.status).toBe('healthy');
      expect(health.checks.groups.message).toBe('1 个组正常运行');
      expect(health.checks.apiTools.status).toBe('healthy');
      expect(health.checks.apiTools.message).toBe('3 个API工具正常运行');
      expect(health.checks.apiTools.details.initialized).toBe(true);
      expect(health.checks.memory.status).toBe('healthy');
      expect(health.timestamp).toBe('2026-01-15T08:00:00.000Z');
      expect(health.lastCheck).toBe(health.timestamp);
    });

    it('uptime 随系统时间增长', async () => {
      vi.setSystemTime(new Date('2026-01-15T08:01:40.000Z')); // +100s
      const health = await service.getSystemHealth();
      expect(health.uptime).toBe(100);
    });

    it('无服务器连接时 servers 检查为 error 并记入 issues', async () => {
      vi.mocked(hub.getDetailedServiceStatus).mockResolvedValue({
        isInitialized: true,
        serverCount: 2,
        connectedServers: 0,
        groupCount: 1,
        totalTools: 5,
        apiTools: 3,
      } as never);
      const health = await service.getSystemHealth();
      expect(health.checks.servers.status).toBe('error');
      expect(health.checks.servers.message).toBe('没有服务器连接');
      expect(health.issues).toContain('没有可用的MCP服务器连接');
      expect(health.status).toBe('error');
    });

    it('有失败服务器时 servers 检查为 warning', async () => {
      vi.mocked(hub.getDetailedServiceStatus).mockResolvedValue({
        isInitialized: true,
        serverCount: 2,
        connectedServers: 1,
        groupCount: 1,
        totalTools: 5,
        apiTools: 3,
      } as never);
      vi.mocked(hub.getServerHealth).mockReturnValue(
        new Map([
          ['s1', 'connected'],
          ['s2', 'error'],
        ]) as never,
      );
      const health = await service.getSystemHealth();
      expect(health.checks.servers.status).toBe('warning');
      expect(health.checks.servers.message).toBe('1 个服务器连接失败');
      expect(health.checks.servers.details.failed).toBe(1);
      expect(health.issues).toContain('1 个MCP服务器连接失败');
    });

    it('组内无工具时该组视为不健康', async () => {
      vi.mocked(hub.listTools).mockResolvedValue([] as never);
      const health = await service.getSystemHealth();
      expect(health.checks.groups.status).toBe('error');
      expect(health.checks.groups.message).toBe('没有健康的组');
      expect(health.checks.groups.details).toEqual({ total: 1, healthy: 0, unhealthy: 1 });
      expect(health.issues).toContain('没有可用的工具组');
    });

    it('listTools 抛错的组不计入健康组', async () => {
      vi.mocked(hub.getAllGroups).mockReturnValue(
        new Map([
          ['g1', { id: 'g1' }],
          ['g2', { id: 'g2' }],
        ]) as never,
      );
      vi.mocked(hub.listTools).mockImplementation(async (groupId: string) => {
        if (groupId === 'g2') throw new Error('group down');
        return [{ name: 't1' }] as never;
      });
      const health = await service.getSystemHealth();
      expect(health.checks.groups.status).toBe('warning');
      expect(health.checks.groups.details).toEqual({ total: 2, healthy: 1, unhealthy: 1 });
      expect(health.checks.groups.message).toBe('1 个组不健康');
    });

    it('API 工具服务未初始化时为 warning', async () => {
      vi.mocked(hub.getApiToolServiceHealth).mockReturnValue({
        initialized: false,
        healthy: false,
      } as never);
      const health = await service.getSystemHealth();
      expect(health.checks.apiTools.status).toBe('warning');
      expect(health.checks.apiTools.message).toBe('API工具服务未初始化');
      // warning 不进 issues 列表
      expect(health.issues).not.toContain('API工具服务未初始化');
    });

    it('API 工具服务初始化但不健康时为 error 并记入 issues', async () => {
      vi.mocked(hub.getApiToolServiceHealth).mockReturnValue({
        initialized: true,
        healthy: false,
        errors: ['timeout'],
      } as never);
      const health = await service.getSystemHealth();
      expect(health.checks.apiTools.status).toBe('error');
      expect(health.checks.apiTools.message).toBe('API工具服务不健康');
      expect(health.checks.apiTools.details.errors).toEqual(['timeout']);
      expect(health.issues).toContain('API工具服务存在问题');
    });

    it('内存使用率超过 90% 时 memory 为 error', async () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 95 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
      } as NodeJS.MemoryUsage);
      const health = await service.getSystemHealth();
      expect(health.checks.memory.status).toBe('error');
      expect(health.checks.memory.message).toBe('内存使用率过高');
      expect(health.checks.memory.details.percentage).toBe(95);
      expect(health.checks.memory.details.used).toBe(95);
      expect(health.checks.memory.details.total).toBe(100);
      expect(health.issues).toContain('系统内存使用率超过90%');
    });

    it('内存使用率在 75%-90% 之间时 memory 为 warning', async () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 80 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
      } as NodeJS.MemoryUsage);
      const health = await service.getSystemHealth();
      expect(health.checks.memory.status).toBe('warning');
      expect(health.checks.memory.message).toBe('内存使用率较高');
      expect(health.issues).toContain('系统内存使用率超过75%');
    });

    it('检查过程抛错时返回兜底 error 健康对象', async () => {
      vi.mocked(hub.getDetailedServiceStatus).mockRejectedValue(new Error('status boom') as never);
      const health = await service.getSystemHealth();
      expect(health.status).toBe('error');
      expect(health.issues[0]).toContain('健康检查失败: status boom');
      for (const check of Object.values(health.checks)) {
        expect(check.status).toBe('error');
        expect(check.message).toBe('检查失败');
      }
    });
  });

  describe('getDashboardStats', () => {
    it('聚合 overview、性能与最近活动', async () => {
      service.recordToolExecution('toolA', 120, true);
      service.addActivity({ type: 'tool_executed', message: 'exec', severity: 'info' });

      const stats = await service.getDashboardStats();
      expect(stats.overview).toEqual({
        totalServers: 2,
        connectedServers: 2,
        totalTools: 5,
        totalGroups: 1,
        apiTools: 3,
      });
      expect(stats.systemHealth.status).toBe('healthy');
      expect(stats.performance.totalRequests).toBe(1);
      expect(stats.performance.averageResponseTime).toBe(120);
      expect(stats.performance.errorRate).toBe(0);
      expect(stats.performance.topTools[0]).toMatchObject({ name: 'toolA', calls: 1 });
      // system_start + exec 两条活动，最新在前
      expect(stats.recentActivity.map((a: Activity) => a.message)).toEqual([
        'exec',
        '系统启动完成',
      ]);
      expect(stats.systemHealth.uptime).toBe(0);
    });

    it('最近活动最多 50 条', async () => {
      for (let i = 0; i < 55; i++) {
        service.addActivity({ type: 'error', message: `m${i}`, severity: 'error' });
      }
      const stats = await service.getDashboardStats();
      expect(stats.recentActivity).toHaveLength(50);
      expect(stats.recentActivity[0]?.message).toBe('m54');
    });

    it('hub 抛错时向上传播', async () => {
      vi.mocked(hub.getDetailedServiceStatus).mockRejectedValue(new Error('boom') as never);
      await expect(service.getDashboardStats()).rejects.toThrow('boom');
    });
  });
});
