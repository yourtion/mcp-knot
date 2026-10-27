import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerStatus } from '../types/mcp-knot.js';
import { logger } from '../utils/logger.js';
import { HealthMonitorService } from './health-monitor-service.js';

import type { GroupManager, ServerManager } from '../types/mcp-knot.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createMockManagers(
  servers: Array<{ id: string; status: ServerStatus }>,
  groups: Array<{ id: string; servers: string[] }>,
) {
  const serverMap = new Map(
    servers.map((s) => [
      s.id,
      {
        id: s.id,
        status: s.status,
        tools: [],
      },
    ]),
  );
  const groupMap = new Map(groups.map((g) => [g.id, { id: g.id, servers: g.servers, tools: [] }]));

  const serverManager = {
    getAllServers: vi.fn().mockReturnValue(serverMap),
  } as unknown as ServerManager;
  const groupManager = {
    getAllGroups: vi.fn().mockReturnValue(groupMap),
    getGroupServers: vi.fn().mockImplementation((groupId: string) => {
      const group = groups.find((g) => g.id === groupId);
      return group ? group.servers : [];
    }),
  } as unknown as GroupManager;
  return { serverManager, groupManager, serverMap };
}

describe('HealthMonitorService', () => {
  let onHealthCheck: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T08:00:00.000Z'));
    onHealthCheck = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('生命周期状态', () => {
    it('未 markInitialized 时 isInitialized=false 且 uptime=0', () => {
      const { serverManager, groupManager } = createMockManagers([], []);
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      const status = monitor.getLifecycleStatus();
      expect(status.isInitialized).toBe(false);
      expect(status.uptime).toBe(0);
      expect(status.healthMonitoringEnabled).toBe(true);
      expect(status.lastHealthCheck).toBeUndefined();
      expect(status.initializationTime).toBeUndefined();
    });

    it('markInitialized 记录初始化时间，uptime 按秒增长', () => {
      const { serverManager, groupManager } = createMockManagers([], []);
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      monitor.markInitialized();
      vi.setSystemTime(new Date('2026-01-15T08:01:30.000Z')); // +90s

      const status = monitor.getLifecycleStatus();
      expect(status.isInitialized).toBe(true);
      expect(status.uptime).toBe(90);
      expect(status.initializationTime).toBe('2026-01-15T08:00:00.000Z');
    });
  });

  describe('triggerCheck', () => {
    it('触发检查后记录 lastHealthCheck', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.CONNECTED }],
        [{ id: 'g1', servers: ['s1'] }],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();
      expect(monitor.getLifecycleStatus().lastHealthCheck).toBe('2026-01-15T08:00:00.000Z');
      // 全部健康：不触发断连回调
      expect(onHealthCheck).not.toHaveBeenCalled();
    });

    it('所有服务器断连时（critical 路径）不触发清理回调（无 disconnected 计数）', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.ERROR }],
        [{ id: 'g1', servers: ['s1'] }],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();
      // error 状态计入 failed（非 disconnected），回调由 failed>0 触发
      expect(onHealthCheck).toHaveBeenCalledTimes(1);
    });

    it('存在 disconnected 服务器时触发健康检查回调（清理缓存）', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [
          { id: 's1', status: ServerStatus.CONNECTED },
          { id: 's2', status: ServerStatus.DISCONNECTED },
        ],
        [{ id: 'g1', servers: ['s1', 's2'] }],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();
      expect(onHealthCheck).toHaveBeenCalledTimes(1);
    });

    it('健康检查回调抛错被吞掉（triggerCheck 仍正常完成）', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const failing = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const monitor = new HealthMonitorService(serverManager, groupManager, failing);

      await expect(monitor.triggerCheck()).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalledTimes(1);
    });

    it('generateReport 抛错时 triggerCheck 不抛错', async () => {
      const serverManager = {
        getAllServers: vi.fn().mockImplementation(() => {
          throw new Error('server map broken');
        }),
      } as unknown as ServerManager;
      const groupManager = {} as unknown as GroupManager;
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await expect(monitor.triggerCheck()).resolves.toBeUndefined();
    });

    it('无任何服务器时报告 critical（connected=0）', async () => {
      const { serverManager, groupManager } = createMockManagers([], []);
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();
      expect(onHealthCheck).not.toHaveBeenCalled();
    });
  });

  describe('start / stop 定时检查', () => {
    it('start 后先执行初始检查，再按 30s 间隔执行', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      monitor.start();

      // setImmediate 初始检查
      await vi.advanceTimersByTimeAsync(0);
      expect(onHealthCheck).toHaveBeenCalledTimes(1);

      // 30s 间隔触发
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onHealthCheck).toHaveBeenCalledTimes(2);

      // 60s / 90s 继续触发
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onHealthCheck).toHaveBeenCalledTimes(4);
      monitor.stop();
    });

    it('重复 start 不产生重复定时器', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      monitor.start();
      monitor.start();

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      // 只有一个 interval + 一次 initial：共 2 次
      expect(onHealthCheck).toHaveBeenCalledTimes(2);
      monitor.stop();
    });

    it('stop 后重新 start 会注册新定时器', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();

      monitor.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      monitor.stop();
      monitor.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      monitor.stop();
    });
  });

  describe('setEnabled', () => {
    it('禁用后 start 被跳过；重新启用自动恢复监控', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();

      monitor.setEnabled(false);
      expect(monitor.getLifecycleStatus().healthMonitoringEnabled).toBe(false);
      monitor.start(); // enabled=false：直接跳过
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onHealthCheck).not.toHaveBeenCalled();

      // 重新启用：未在运行时自动 start
      monitor.setEnabled(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onHealthCheck).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it('未初始化时启用不会自动 start', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      // 未 markInitialized
      monitor.setEnabled(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onHealthCheck).not.toHaveBeenCalled();
    });
  });

  describe('start/stop 日志与状态（补强）', () => {
    it('全新实例 stop 不产生任何清理日志或错误', () => {
      const { serverManager, groupManager } = createMockManagers([], []);
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      expect(() => monitor.stop()).not.toThrow();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalledWith('Health monitoring stopped', expect.anything());
    });

    it('start 记录监控启动与定时器注册日志', () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      monitor.start();

      expect(logger.info).toHaveBeenCalledWith('Starting service health monitoring', {
        intervalMs: 30000,
      });
      expect(logger.debug).toHaveBeenCalledWith('Health monitoring timers registered', {
        timerCount: 2,
      });
      monitor.stop();
    });

    it('重复 start 记录 debug 且不再注册定时器', () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      monitor.start();
      monitor.start();

      expect(logger.debug).toHaveBeenCalledWith('Health monitoring already running');
      monitor.stop();
    });

    it('禁用状态下 start 记录 debug 并跳过', () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.setEnabled(false);
      monitor.start();

      expect(logger.debug).toHaveBeenCalledWith('Health monitoring disabled, skipping start');
    });

    it('stop 记录精确的清理数量', () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.start();
      monitor.stop();

      expect(logger.info).toHaveBeenCalledWith('Health monitoring stopped', { clearedTimers: 2 });
    });

    it('start→stop→start→stop：每次清理 2 个且不产生清理错误', () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.start();
      monitor.stop();
      monitor.start();
      monitor.stop();

      expect(logger.error).not.toHaveBeenCalled();
      const stoppedCalls = vi
        .mocked(logger.info)
        .mock.calls.filter(([msg]) => msg === 'Health monitoring stopped');
      expect(stoppedCalls).toHaveLength(2);
      expect(stoppedCalls[1]).toEqual(['Health monitoring stopped', { clearedTimers: 2 }]);
    });

    it('performCheck 抛错时 initial/interval 回调均记录错误且不产生未处理拒绝', async () => {
      const { serverManager, groupManager } = createMockManagers([], []);
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      (monitor as unknown as { performCheck: () => Promise<void> }).performCheck = async () => {
        throw new Error('check boom');
      };
      monitor.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith('Initial health check failed', expect.any(Error));

      await vi.advanceTimersByTimeAsync(30_000);
      expect(logger.error).toHaveBeenCalledWith('Health check failed', expect.any(Error));
      monitor.stop();
    });
  });

  describe('setEnabled（补强）', () => {
    it('运行中重新 setEnabled(true) 不停止监控', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // 初始检查

      monitor.setEnabled(true);
      expect(logger.info).toHaveBeenCalledWith('Health monitoring setting changed', {
        enabled: true,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onHealthCheck).toHaveBeenCalledTimes(2); // 仍在运行
      monitor.stop();
    });

    it('运行中重复 setEnabled(true) 不重启监控（Starting 日志仅一次）', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // 初始检查

      monitor.setEnabled(true);
      monitor.setEnabled(true);
      const startingCalls = vi
        .mocked(logger.info)
        .mock.calls.filter(([msg]) => msg === 'Starting service health monitoring');
      expect(startingCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onHealthCheck).toHaveBeenCalledTimes(2); // 监控持续运行
      monitor.stop();
    });

    it('运行中 setEnabled(false) 记录设置变更日志', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      monitor.setEnabled(false);
      expect(logger.info).toHaveBeenCalledWith('Health monitoring setting changed', {
        enabled: false,
      });
    });
  });

  describe('getLifecycleStatus（补强）', () => {
    it('返回完整状态对象（toStrictEqual）', async () => {
      const { serverManager, groupManager } = createMockManagers([], []);
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      monitor.markInitialized();
      await monitor.triggerCheck();

      expect(monitor.getLifecycleStatus()).toStrictEqual({
        isInitialized: true,
        healthMonitoringEnabled: true,
        uptime: 0,
        lastHealthCheck: '2026-01-15T08:00:00.000Z',
        initializationTime: '2026-01-15T08:00:00.000Z',
      });
    });
  });

  describe('健康报告精确断言（logger payload）', () => {
    it('全部健康：debug 记录精确的 healthScore/connectedServers/totalServers', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.CONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();

      expect(logger.debug).toHaveBeenCalledWith('Performing service health check', {
        timestamp: '2026-01-15T08:00:00.000Z',
      });
      expect(logger.debug).toHaveBeenCalledWith('Service health check passed', {
        healthScore: 100,
        connectedServers: 1,
        totalServers: 1,
      });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('零服务器：critical 记录精确的 criticalIssues 与 healthScore', async () => {
      const { serverManager, groupManager } = createMockManagers([], []);
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();

      expect(logger.error).toHaveBeenCalledWith(
        'Critical health issues detected',
        expect.any(Error),
        {
          criticalIssues: ['No servers are connected'],
          warnings: [],
          healthScore: 70,
        },
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('连接率低于一半且有 error 服务器：两条 warning、healthScore 80、触发断连处理', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [
          { id: 's1', status: ServerStatus.CONNECTED },
          { id: 's2', status: ServerStatus.DISCONNECTED },
          { id: 's3', status: ServerStatus.ERROR },
        ],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();

      expect(logger.warn).toHaveBeenCalledWith('Service health warnings detected', {
        warnings: ['Only 1 of 3 servers are connected', '1 servers are in error state'],
        healthScore: 80,
      });
      expect(logger.info).toHaveBeenCalledWith('Handling server disconnections', {
        disconnectedServers: 1,
        failedServers: 1,
      });
      expect(onHealthCheck).toHaveBeenCalledTimes(1);
    });

    it('恰好一半连接（1/2）：不产生 Only 警告但仍处理断连', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [
          { id: 's1', status: ServerStatus.CONNECTED },
          { id: 's2', status: ServerStatus.DISCONNECTED },
        ],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('Service health check passed', {
        healthScore: 100,
        connectedServers: 1,
        totalServers: 2,
      });
      expect(logger.info).toHaveBeenCalledWith('Handling server disconnections', {
        disconnectedServers: 1,
        failedServers: 0,
      });
      expect(onHealthCheck).toHaveBeenCalledTimes(1);
    });

    it('三分之二连接（2/3）：不产生 Only 警告', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [
          { id: 's1', status: ServerStatus.CONNECTED },
          { id: 's2', status: ServerStatus.CONNECTED },
          { id: 's3', status: ServerStatus.DISCONNECTED },
        ],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('Service health check passed', {
        healthScore: 100,
        connectedServers: 2,
        totalServers: 3,
      });
    });

    it('组内无已连接服务器：warning 精确内容、healthScore 90', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.CONNECTED }],
        [{ id: 'g1', servers: ['missing'] }],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();

      expect(logger.warn).toHaveBeenCalledWith('Service health warnings detected', {
        warnings: ["Group 'g1' has no connected servers"],
        healthScore: 90,
      });
    });

    it('健康组：不产生组警告', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.CONNECTED }],
        [{ id: 'g1', servers: ['s1'] }],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await monitor.triggerCheck();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('getGroupServers 抛错：warning 携带错误信息、healthScore 90', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.CONNECTED }],
        [{ id: 'g1', servers: ['s1'] }],
      );
      vi.mocked(groupManager.getGroupServers).mockImplementation(() => {
        throw new Error('group broken');
      });
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await expect(monitor.triggerCheck()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith('Service health warnings detected', {
        warnings: ["Group 'g1' health check failed: group broken"],
        healthScore: 90,
      });
    });

    it('generateReport 抛错：记录 Health check execution failed', async () => {
      const serverManager = {
        getAllServers: vi.fn().mockImplementation(() => {
          throw new Error('server map broken');
        }),
      } as unknown as ServerManager;
      const groupManager = {} as unknown as GroupManager;
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await expect(monitor.triggerCheck()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith('Health check execution failed', expect.any(Error));
    });

    it('回调抛错：记录 Error in health check callback', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const failing = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const monitor = new HealthMonitorService(serverManager, groupManager, failing);

      await expect(monitor.triggerCheck()).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Error in health check callback',
        expect.any(Error),
      );
    });

    it('未设置回调且有断连：不误报回调错误', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.DISCONNECTED }],
        [],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, undefined);

      await expect(monitor.triggerCheck()).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalledWith(
        'Error in health check callback',
        expect.anything(),
      );
    });
  });

  describe('组健康统计（经 triggerCheck 间接验证）', () => {
    it('组内无已连接服务器时发出警告', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [
          { id: 's1', status: ServerStatus.CONNECTED },
          { id: 's2', status: ServerStatus.CONNECTED },
        ],
        [{ id: 'g1', servers: ['s2'] }],
      );
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);
      // s2 连接正常 → g1 健康；再用一个引用不存在 server 的组触发不健康路径
      vi.mocked(groupManager.getAllGroups).mockReturnValue(
        new Map([
          ['g1', { id: 'g1', servers: ['s2'], tools: [] }],
          ['g2', { id: 'g2', servers: ['missing'], tools: [] }],
        ]) as never,
      );

      await monitor.triggerCheck();
      expect(onHealthCheck).not.toHaveBeenCalled();
      // 警告路径：logger.warn 被调用（g2 无连接服务器）
      expect(logger.warn).toHaveBeenCalled();
    });

    it('getGroupServers 抛错的组计入不健康', async () => {
      const { serverManager, groupManager } = createMockManagers(
        [{ id: 's1', status: ServerStatus.CONNECTED }],
        [],
      );
      vi.mocked(groupManager.getAllGroups).mockReturnValue(
        new Map([['g1', { id: 'g1', servers: ['s1'], tools: [] }]]) as never,
      );
      vi.mocked(groupManager.getGroupServers).mockImplementation(() => {
        throw new Error('group broken');
      });
      const monitor = new HealthMonitorService(serverManager, groupManager, onHealthCheck);

      await expect(monitor.triggerCheck()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
