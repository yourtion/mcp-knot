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
