/**
 * 资源监控工具测试
 * mock process 内部 API + fake timers，验证快照采集、阈值告警与趋势分析
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';
import { ResourceMonitor, resourceMonitor, type ResourceAlert } from './resource-monitor.js';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type HandleLike = Record<string, unknown> | Date;

function timerHandle(): Record<string, unknown> {
  return { _onTimeout: () => {} };
}

function stubActiveHandles(handles: HandleLike[]) {
  return vi
    .spyOn(process as unknown as { _getActiveHandles?: () => HandleLike[] }, '_getActiveHandles')
    .mockReturnValue(handles);
}

function stubMemoryUsage(heapUsed = 10 * 1024 * 1024) {
  return vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: 50 * 1024 * 1024,
    heapTotal: 20 * 1024 * 1024,
    heapUsed,
    external: 1024,
    arrayBuffers: 1024,
  } as NodeJS.MemoryUsage);
}

describe('ResourceMonitor', () => {
  let monitor: ResourceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stubActiveHandles([]);
    stubMemoryUsage();
    monitor = new ResourceMonitor();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe('takeSnapshot', () => {
    it('记录定时器数、句柄数、堆内存与时间戳', () => {
      stubActiveHandles([
        timerHandle(),
        { _onImmediate: () => {} },
        new Date(0),
        { unrelated: true },
      ]);
      stubMemoryUsage(42);

      const snapshot = monitor.takeSnapshot();
      expect(snapshot.timestamp).toBe(0);
      // _onTimeout / _onImmediate / Date 实例计为定时器
      expect(snapshot.activeTimers).toBe(3);
      expect(snapshot.activeHandles).toBe(4);
      expect(snapshot.heapUsed).toBe(42);
    });

    it('内部 API 不可用时定时器与句柄计为 0', () => {
      vi.spyOn(
        process as unknown as { _getActiveHandles?: () => HandleLike[] },
        '_getActiveHandles',
      ).mockImplementation(() => {
        throw new Error('not available');
      });

      const snapshot = monitor.takeSnapshot();
      expect(snapshot.activeTimers).toBe(0);
      expect(snapshot.activeHandles).toBe(0);
    });

    it('_getActiveHandles 返回非数组时计为 0', () => {
      vi.spyOn(
        process as unknown as { _getActiveHandles?: () => unknown },
        '_getActiveHandles',
      ).mockReturnValue('not-an-array' as unknown as []);

      const snapshot = monitor.takeSnapshot();
      expect(snapshot.activeTimers).toBe(0);
      expect(snapshot.activeHandles).toBe(0);
    });

    it('getCurrentResources 采集并返回最新快照', () => {
      stubActiveHandles([timerHandle()]);
      const current = monitor.getCurrentResources();
      expect(current.activeTimers).toBe(1);
      expect(current.activeHandles).toBe(1);
    });
  });

  describe('快照上限', () => {
    it('最多保留 60 个快照，淘汰最旧的', () => {
      for (let i = 0; i < 61; i++) {
        stubActiveHandles(Array.from({ length: i + 1 }, () => ({})));
        vi.setSystemTime(i);
        monitor.takeSnapshot();
      }

      const stats = monitor.getStats();
      // getStats 自身会再采集一次
      expect(stats.snapshotCount).toBe(60);
      expect(stats.trend!.handles).toBe('increasing'); // 1 → 61
    });

    it('clear 清空历史快照', () => {
      monitor.takeSnapshot();
      monitor.takeSnapshot();
      monitor.clear();

      const stats = monitor.getStats();
      expect(stats.trend).toBeUndefined(); // 仅剩 getStats 采集的 1 个快照
      expect(stats.snapshotCount).toBe(1);
    });
  });

  describe('start/stop', () => {
    it('启动时立即采集，之后按间隔检查告警', () => {
      monitor.start(1000);
      // 立即 1 次 + getCurrentResources 断言再采 1 次
      expect(monitor.getCurrentResources().heapUsed).toBe(10 * 1024 * 1024);

      // 推进一个间隔：采集 1 次 + 告警检查采集 1 次 + getStats 自身 1 次 → 共 5
      vi.advanceTimersByTime(1000);
      expect(monitor.getStats().snapshotCount).toBe(5);
    });

    it('重复启动不会创建第二个定时器', () => {
      monitor.start(1000);
      monitor.start(1000);
      expect(logger.warn).toHaveBeenCalledWith('资源监控已在运行');

      vi.advanceTimersByTime(1000);
      // 立即 1 次 + 单个间隔（采集 + 告警检查再采集 1 次）+ getStats 1 次 = 4
      expect(monitor.getStats().snapshotCount).toBe(4);
    });

    it('stop 后不再采集', () => {
      monitor.start(1000);
      monitor.stop();
      const snapshotCount = monitor.getStats().snapshotCount; // 含 getStats 自身采集

      vi.advanceTimersByTime(5000);
      expect(monitor.getStats().snapshotCount).toBe(snapshotCount + 1); // 仅 getStats 自身多采 1 次
    });

    it('未启动时 stop 不产生副作用', () => {
      expect(() => monitor.stop()).not.toThrow();
      expect(logger.info).not.toHaveBeenCalledWith('资源监控已停止');
    });
  });

  describe('资源告警', () => {
    function collectAlerts() {
      const alerts: ResourceAlert[] = [];
      monitor.onAlert((alert) => alerts.push(alert));
      return alerts;
    }

    it('活动定时器超过 50 触发 critical 告警', () => {
      stubActiveHandles(Array.from({ length: 51 }, timerHandle));
      const alerts = collectAlerts();

      monitor.start(1000);
      vi.advanceTimersByTime(1000);

      expect(alerts).toEqual([
        {
          level: 'critical',
          resource: 'timers',
          message: '活动定时器数量过多: 51',
          currentValue: 51,
          threshold: 50,
        },
      ]);
    });

    it('活动定时器在 30-50 之间触发 warning 告警', () => {
      stubActiveHandles(Array.from({ length: 40 }, timerHandle));
      const alerts = collectAlerts();

      monitor.start(1000);
      vi.advanceTimersByTime(1000);

      expect(alerts).toEqual([
        {
          level: 'warning',
          resource: 'timers',
          message: '活动定时器数量较多: 40',
          currentValue: 40,
          threshold: 30,
        },
      ]);
    });

    it('活动句柄超过 200 触发 critical 告警', () => {
      stubActiveHandles(Array.from({ length: 201 }, () => ({ socket: true })));
      const alerts = collectAlerts();

      monitor.start(1000);
      vi.advanceTimersByTime(1000);

      expect(alerts).toEqual([
        {
          level: 'critical',
          resource: 'handles',
          message: '活动句柄数量过多: 201',
          currentValue: 201,
          threshold: 200,
        },
      ]);
    });

    it('活动句柄在 100-200 之间触发 warning 告警', () => {
      stubActiveHandles(Array.from({ length: 150 }, () => ({ socket: true })));
      const alerts = collectAlerts();

      monitor.start(1000);
      vi.advanceTimersByTime(1000);

      expect(alerts).toEqual([
        {
          level: 'warning',
          resource: 'handles',
          message: '活动句柄数量较多: 150',
          currentValue: 150,
          threshold: 100,
        },
      ]);
    });

    it('资源水位低于阈值时不触发告警', () => {
      stubActiveHandles(Array.from({ length: 30 }, timerHandle)); // 30 不超过 30
      const alerts = collectAlerts();

      monitor.start(1000);
      vi.advanceTimersByTime(1000);

      expect(alerts).toEqual([]);
    });

    it('告警回调抛错不影响监控且被记录', () => {
      stubActiveHandles(Array.from({ length: 51 }, timerHandle));
      monitor.onAlert(() => {
        throw new Error('callback boom');
      });

      monitor.start(1000);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith('告警回调执行失败', expect.any(Error));
    });

    it('未设置告警回调时仅记录日志', () => {
      stubActiveHandles(Array.from({ length: 51 }, timerHandle));

      monitor.start(1000);
      vi.advanceTimersByTime(1000);

      expect(logger.warn).toHaveBeenCalledWith(
        '资源告警',
        expect.objectContaining({ resource: 'timers', level: 'critical' }),
      );
    });
  });

  describe('getStats 趋势', () => {
    function recordHandlesSequence(sequence: number[]) {
      for (const [i, count] of sequence.entries()) {
        stubActiveHandles(Array.from({ length: count }, () => ({})));
        vi.setSystemTime(i);
        monitor.takeSnapshot();
      }
    }

    it('句柄增长超过 5 判定为 increasing', () => {
      recordHandlesSequence([2, 8]); // +6
      expect(monitor.getStats().trend).toEqual({ timers: 'stable', handles: 'increasing' });
    });

    it('句柄增长恰好 5 判定为 stable（边界不包含）', () => {
      recordHandlesSequence([2, 7]); // +5
      expect(monitor.getStats().trend!.handles).toBe('stable');
    });

    it('句柄减少超过 5 判定为 decreasing', () => {
      recordHandlesSequence([10, 4]); // -6
      expect(monitor.getStats().trend!.handles).toBe('decreasing');
    });

    it('句柄减少恰好 5 判定为 stable（边界不包含）', () => {
      recordHandlesSequence([10, 5]); // -5
      expect(monitor.getStats().trend!.handles).toBe('stable');
    });

    it('无历史快照时无趋势（getStats 内部仅采集当次快照，不足以计算趋势）', () => {
      // 注意：getCurrentResources 会以 takeSnapshot 作为副作用追加快照，因此不能先手动 takeSnapshot
      expect(monitor.getStats().trend).toBeUndefined();
    });
  });

  it('导出全局单例', () => {
    expect(resourceMonitor).toBeInstanceOf(ResourceMonitor);
  });
});
