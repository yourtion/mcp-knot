/**
 * 内存监控工具测试
 * mock process.memoryUsage + fake timers，验证快照、趋势分析、告警阈值触发
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryMonitor, memoryMonitor, type MemoryAlert } from './memory-monitor.js';

const MB = 1024 * 1024;

function usage(overrides: Partial<MemoryUsage>): MemoryUsage {
  return {
    rss: 50 * MB,
    heapTotal: 20 * MB,
    heapUsed: 10 * MB,
    external: 2 * MB,
    arrayBuffers: 1 * MB,
    ...overrides,
  } as MemoryUsage;
}

function spyOnMemoryUsage() {
  return vi.spyOn(process, 'memoryUsage');
}

describe('MemoryMonitor', () => {
  let monitor: MemoryMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    monitor = new MemoryMonitor();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('takeSnapshot', () => {
    it('从 process.memoryUsage 记录各内存字段与时间戳', () => {
      const mem = usage({
        rss: 111,
        heapTotal: 222,
        heapUsed: 333,
        external: 444,
        arrayBuffers: 555,
      });
      spyOnMemoryUsage().mockReturnValue(mem);

      const snapshot = monitor.takeSnapshot();
      expect(snapshot).toEqual({
        timestamp: 0,
        rss: 111,
        heapTotal: 222,
        heapUsed: 333,
        external: 444,
        arrayBuffers: 555,
      });
    });

    it('getCurrentMemory 等价于采集一次快照', () => {
      spyOnMemoryUsage().mockReturnValue(usage({ heapUsed: 42 }));
      const current = monitor.getCurrentMemory();
      expect(current.heapUsed).toBe(42);
    });
  });

  describe('快照上限', () => {
    it('最多保留 60 个快照，淘汰最旧的', () => {
      const spy = spyOnMemoryUsage();
      for (let i = 0; i < 61; i++) {
        spy.mockReturnValue(usage({ heapUsed: i }));
        vi.setSystemTime(i);
        monitor.takeSnapshot();
      }

      const trend = monitor.analyzeTrend(60_000_000)!; // 覆盖全部历史的窗口
      expect(trend.snapshots).toHaveLength(60);
      // 最旧的快照（heapUsed=0）被淘汰
      expect(trend.snapshots[0]!.heapUsed).toBe(1);
      expect(trend.snapshots.at(-1)!.heapUsed).toBe(60);
    });

    it('clear 清空历史快照', () => {
      spyOnMemoryUsage().mockReturnValue(usage({ heapUsed: 10 * MB }));
      monitor.takeSnapshot();
      monitor.takeSnapshot();
      monitor.clear();

      expect(monitor.analyzeTrend(60000)).toBeNull();
    });
  });

  describe('analyzeTrend', () => {
    it('快照不足 2 个时返回 null', () => {
      expect(monitor.analyzeTrend(60000)).toBeNull();
      monitor.takeSnapshot();
      expect(monitor.analyzeTrend(60000)).toBeNull();
    });

    function recordSequence(pairs: Array<[time: number, heapUsed: number]>) {
      const spy = spyOnMemoryUsage();
      for (const [time, heapUsed] of pairs) {
        vi.setSystemTime(time);
        spy.mockReturnValue(usage({ heapUsed }));
        monitor.takeSnapshot();
      }
    }

    it('只分析时间窗口内的快照', () => {
      recordSequence([
        [0, 10 * MB],
        [1000, 11 * MB], // 窗口外
        [2000, 20 * MB],
        [3000, 30 * MB],
      ]);

      vi.setSystemTime(3000);
      const trend = monitor.analyzeTrend(1500)!; // 起点 1500
      expect(trend.snapshots).toHaveLength(2);
      expect(trend.duration).toBe(1000); // 3000 - 2000
      expect(trend.totalGrowth).toBe(10 * MB);
      expect(trend.growthRate).toBe(600 * MB); // 10MB / 1000ms * 60000
      expect(trend.trend).toBe('stable'); // 增长恰好 10MB，不超过 10MB
    });

    it('窗口内快照不足 2 个时返回 null', () => {
      recordSequence([
        [0, 10 * MB],
        [2000, 20 * MB],
      ]);

      vi.setSystemTime(2000);
      expect(monitor.analyzeTrend(1000)).toBeNull(); // 只剩 t=2000 一个
    });

    it('增长超过 10MB 判定为 increasing', () => {
      recordSequence([
        [0, 10 * MB],
        [1000, 21 * MB],
      ]);
      vi.setSystemTime(1000);

      expect(monitor.analyzeTrend(60000)!.trend).toBe('increasing');
    });

    it('减少超过 10MB 判定为 decreasing', () => {
      recordSequence([
        [0, 30 * MB],
        [1000, 19 * MB],
      ]);
      vi.setSystemTime(1000);

      expect(monitor.analyzeTrend(60000)!.trend).toBe('decreasing');
    });

    it('增长率为每分钟字节数', () => {
      recordSequence([
        [0, 10 * MB],
        [30000, 13 * MB], // 30s 增长 3MB → 6MB/min
      ]);
      vi.setSystemTime(30000);

      const trend = monitor.analyzeTrend(60000)!;
      expect(trend.growthRate).toBe(6 * MB);
    });

    it('两个快照时间相同时增长率为 0', () => {
      recordSequence([
        [0, 10 * MB],
        [0, 10 * MB],
      ]);

      const trend = monitor.analyzeTrend(60000)!;
      expect(trend.duration).toBe(0);
      expect(trend.growthRate).toBe(0);
    });
  });

  describe('start/stop 与告警', () => {
    it('启动时立即采集一个快照，之后按间隔采集并停止', () => {
      const spy = spyOnMemoryUsage().mockReturnValue(usage({ heapUsed: 10 * MB }));
      monitor.start(1000);

      // 仅 1 个快照时无法分析趋势
      expect(monitor.analyzeTrend(60000)).toBeNull();

      vi.advanceTimersByTime(1000);
      // 间隔触发：采集 1 次 + 告警检查再采集 1 次
      expect(monitor.analyzeTrend(60_000_000)!.snapshots).toHaveLength(3);

      spy.mockRestore();
      monitor.stop();
      vi.advanceTimersByTime(5000);
      expect(monitor.analyzeTrend(60_000_000)!.snapshots).toHaveLength(3);
    });

    it('重复启动不会创建第二个定时器', () => {
      spyOnMemoryUsage().mockReturnValue(usage({ heapUsed: 10 * MB }));
      monitor.start(1000);
      monitor.start(1000);

      vi.advanceTimersByTime(1000);
      // 若创建了两个定时器会新增 4 个快照（2 采集 + 2 告警检查）
      expect(monitor.analyzeTrend(60_000_000)!.snapshots).toHaveLength(3);
      monitor.stop();
    });

    it('未启动时 stop 不产生副作用', () => {
      expect(() => monitor.stop()).not.toThrow();
    });

    it('增长率超过临界阈值（10MB/min）触发 critical 告警', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValueOnce(usage({ heapUsed: 10 * MB, heapTotal: 100 * MB }));
      monitor.start(60000);

      const alerts: MemoryAlert[] = [];
      monitor.onAlert((alert) => alerts.push(alert));

      spy.mockReturnValue(usage({ heapUsed: 22 * MB, heapTotal: 100 * MB }));
      vi.advanceTimersByTime(60000);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.level).toBe('critical');
      expect(alerts[0]!.growthRate).toBe(12 * MB);
      expect(alerts[0]!.threshold).toBe(10 * MB);
      expect(alerts[0]!.currentUsage).toBe(22 * MB);
      expect(alerts[0]!.message).toContain('12.00 MB');
      monitor.stop();
    });

    it('增长率在 5-10MB/min 之间触发 warning 告警', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValueOnce(usage({ heapUsed: 10 * MB, heapTotal: 100 * MB }));
      monitor.start(60000);

      const alerts: MemoryAlert[] = [];
      monitor.onAlert((alert) => alerts.push(alert));

      spy.mockReturnValue(usage({ heapUsed: 16 * MB, heapTotal: 100 * MB }));
      vi.advanceTimersByTime(60000);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.level).toBe('warning');
      expect(alerts[0]!.growthRate).toBe(6 * MB);
      expect(alerts[0]!.threshold).toBe(5 * MB);
      monitor.stop();
    });

    it('增长率低于 5MB/min 不触发增长率告警', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValueOnce(usage({ heapUsed: 10 * MB, heapTotal: 100 * MB }));
      monitor.start(60000);

      const alerts: MemoryAlert[] = [];
      monitor.onAlert((alert) => alerts.push(alert));

      spy.mockReturnValue(usage({ heapUsed: 13 * MB, heapTotal: 100 * MB })); // 3MB/min
      vi.advanceTimersByTime(60000);

      expect(alerts).toHaveLength(0);
      monitor.stop();
    });

    it('堆内存使用率超过 90% 触发 critical 告警', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValueOnce(usage({ heapUsed: 10 * MB, heapTotal: 20 * MB }));
      monitor.start(60000);

      const alerts: MemoryAlert[] = [];
      monitor.onAlert((alert) => alerts.push(alert));

      spy.mockReturnValue(usage({ heapUsed: 19 * MB, heapTotal: 20 * MB })); // 95%
      vi.advanceTimersByTime(60000);

      const heapAlert = alerts.find((a) => a.message.includes('堆内存使用率过高'));
      expect(heapAlert).toBeDefined();
      expect(heapAlert!.level).toBe('critical');
      expect(heapAlert!.threshold).toBe(20 * MB * 0.9);
      expect(heapAlert!.message).toContain('95.0%');
      monitor.stop();
    });

    it('堆内存使用率在 75%-90% 之间触发 warning 告警', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValueOnce(usage({ heapUsed: 10 * MB, heapTotal: 20 * MB }));
      monitor.start(60000);

      const alerts: MemoryAlert[] = [];
      monitor.onAlert((alert) => alerts.push(alert));

      spy.mockReturnValue(usage({ heapUsed: 16 * MB, heapTotal: 20 * MB })); // 80%
      vi.advanceTimersByTime(60000);

      const heapAlert = alerts.find((a) => a.message.includes('堆内存使用率较高'));
      expect(heapAlert).toBeDefined();
      expect(heapAlert!.level).toBe('warning');
      expect(heapAlert!.message).toContain('80.0%');
      monitor.stop();
    });

    it('堆内存使用率低于 75% 不触发使用率告警', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValueOnce(usage({ heapUsed: 10 * MB, heapTotal: 20 * MB }));
      monitor.start(60000);

      const alerts: MemoryAlert[] = [];
      monitor.onAlert((alert) => alerts.push(alert));

      spy.mockReturnValue(usage({ heapUsed: 14 * MB, heapTotal: 20 * MB })); // 70%
      vi.advanceTimersByTime(60000);

      expect(alerts).toHaveLength(0);
      monitor.stop();
    });

    it('告警回调抛错不影响监控且被记录', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValueOnce(usage({ heapUsed: 10 * MB, heapTotal: 20 * MB }));
      monitor.start(60000);
      monitor.onAlert(() => {
        throw new Error('callback boom');
      });

      spy.mockReturnValue(usage({ heapUsed: 19 * MB, heapTotal: 20 * MB }));
      expect(() => vi.advanceTimersByTime(60000)).not.toThrow();
      monitor.stop();
    });
  });

  describe('getStats', () => {
    it('返回当前内存、趋势、快照数与堆使用率', () => {
      const spy = spyOnMemoryUsage();
      spy.mockReturnValue(usage({ heapUsed: 10 * MB, heapTotal: 20 * MB }));
      monitor.takeSnapshot();
      vi.setSystemTime(1000);
      spy.mockReturnValue(usage({ heapUsed: 11 * MB, heapTotal: 20 * MB }));
      monitor.takeSnapshot();

      const stats = monitor.getStats();
      // getStats 自身会再采集一次当前内存
      expect(stats.current.heapUsed).toBe(11 * MB);
      expect(stats.snapshotCount).toBe(3);
      expect(stats.heapUsageRatio).toBeCloseTo(11 / 20, 5);
      expect(stats.trend).not.toBeNull();
    });

    it('heapTotal 为 0 时使用率为 0', () => {
      spyOnMemoryUsage().mockReturnValue(usage({ heapUsed: 0, heapTotal: 0 }));

      expect(monitor.getStats().heapUsageRatio).toBe(0);
    });
  });

  describe('forceGC', () => {
    it('gc 不可用时返回 false', () => {
      vi.stubGlobal('gc', undefined);
      expect(monitor.forceGC()).toBe(false);
    });

    it('gc 可用时触发并返回 true', () => {
      const gc = vi.fn();
      vi.stubGlobal('gc', gc);

      expect(monitor.forceGC()).toBe(true);
      expect(gc).toHaveBeenCalledTimes(1);
    });

    it('gc 抛错时返回 false', () => {
      vi.stubGlobal(
        'gc',
        vi.fn(() => {
          throw new Error('gc failed');
        }),
      );

      expect(monitor.forceGC()).toBe(false);
    });
  });

  it('导出全局单例', () => {
    expect(memoryMonitor).toBeInstanceOf(MemoryMonitor);
  });
});
