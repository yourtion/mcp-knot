import * as process from 'node:process';
/**
 * 性能监控系统测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPerformanceMonitor,
  DEFAULT_PERFORMANCE_CONFIG,
  PerformanceMonitor,
  type PerformanceMonitorConfig,
} from './performance-monitor';

// Mock Node.js modules
vi.mock('node:os', () => ({
  totalmem: vi.fn(() => 8 * 1024 * 1024 * 1024), // 8GB
  freemem: vi.fn(() => 4 * 1024 * 1024 * 1024), // 4GB
  cpus: vi.fn(() => Array(4).fill({})), // 4 CPUs
  loadavg: vi.fn(() => [1.0, 1.5, 2.0]),
  uptime: vi.fn(() => 3600), // 1 hour
}));

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return {
    ...actual,
    memoryUsage: vi.fn(() => ({
      rss: 100 * 1024 * 1024, // 100MB
      heapTotal: 80 * 1024 * 1024, // 80MB
      heapUsed: 60 * 1024 * 1024, // 60MB
      external: 10 * 1024 * 1024, // 10MB
      arrayBuffers: 5 * 1024 * 1024, // 5MB
    })),
    cpuUsage: vi.fn(() => ({
      user: 1000000, // 1 second
      system: 500000, // 0.5 seconds
    })),
    env: {
      PERFORMANCE_MONITORING: 'false',
    },
  };
});

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;
  let config: PerformanceMonitorConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    config = {
      ...DEFAULT_PERFORMANCE_CONFIG,
      enabled: true, // 启用监控
      collectInterval: 1000, // 1秒用于测试
    };
    monitor = new PerformanceMonitor(config);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('构造函数和配置', () => {
    it('应该使用默认配置创建监控器', () => {
      const defaultMonitor = new PerformanceMonitor();
      expect(defaultMonitor).toBeInstanceOf(PerformanceMonitor);
    });

    it('应该使用自定义配置创建监控器', () => {
      const customConfig = { enabled: false, collectInterval: 5000 };
      const customMonitor = new PerformanceMonitor(customConfig);
      expect(customMonitor).toBeInstanceOf(PerformanceMonitor);
    });
  });

  describe('启动和停止', () => {
    it('应该正确启动监控', () => {
      const startedSpy = vi.fn();
      const testMonitor = new PerformanceMonitor({ ...config, enabled: false });
      testMonitor.on('started', startedSpy);

      testMonitor.start();

      expect(startedSpy).toHaveBeenCalled();
      testMonitor.stop();
    });

    it('应该正确停止监控', () => {
      const stoppedSpy = vi.fn();
      monitor.on('stopped', stoppedSpy);

      monitor.start();
      monitor.stop();

      expect(stoppedSpy).toHaveBeenCalled();
    });

    it('应该防止重复启动', () => {
      const startedSpy = vi.fn();
      const testMonitor = new PerformanceMonitor({ ...config, enabled: false });
      testMonitor.on('started', startedSpy);

      testMonitor.start();
      testMonitor.start(); // 第二次启动应该被忽略

      expect(startedSpy).toHaveBeenCalledTimes(1);
      testMonitor.stop();
    });
  });

  describe('请求监控', () => {
    it('应该正确记录请求开始和结束', () => {
      const requestCompletedSpy = vi.fn();
      monitor.on('requestCompleted', requestCompletedSpy);

      const requestId = 'test-request-1';
      const operation = 'testOperation';
      const component = 'TestComponent';

      monitor.startRequest(requestId, operation, component);

      // 模拟请求处理时间
      vi.advanceTimersByTime(100);

      monitor.endRequest(requestId, true);

      expect(requestCompletedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId,
          operation,
          component,
          success: true,
          duration: 100,
        }),
      );
    });

    it('应该正确记录失败的请求', () => {
      const requestCompletedSpy = vi.fn();
      monitor.on('requestCompleted', requestCompletedSpy);

      const requestId = 'test-request-2';
      const error = '测试错误';

      monitor.startRequest(requestId, 'testOperation', 'TestComponent');
      vi.advanceTimersByTime(50);
      monitor.endRequest(requestId, false, error);

      expect(requestCompletedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId,
          success: false,
          error,
          duration: 50,
        }),
      );
    });

    it('应该忽略未开始的请求结束', () => {
      const requestCompletedSpy = vi.fn();
      monitor.on('requestCompleted', requestCompletedSpy);

      monitor.endRequest('non-existent-request', true);

      expect(requestCompletedSpy).not.toHaveBeenCalled();
    });

    it('应该限制请求历史记录大小', () => {
      const smallConfig = { ...config, maxHistorySize: 2 };
      const smallMonitor = new PerformanceMonitor(smallConfig);

      // 添加3个请求，应该只保留最后2个
      for (let i = 1; i <= 3; i++) {
        smallMonitor.startRequest(`req-${i}`, 'test', 'test');
        smallMonitor.endRequest(`req-${i}`, true);
      }

      const history = smallMonitor.getRequestHistory();
      expect(history).toHaveLength(2);
      expect(history[0].requestId).toBe('req-2');
      expect(history[1].requestId).toBe('req-3');

      smallMonitor.stop();
    });
  });

  describe('指标收集', () => {
    it('应该定期收集指标', () => {
      const metricsCollectedSpy = vi.fn();
      monitor.on('metricsCollected', metricsCollectedSpy);

      monitor.start();

      // 推进时间触发指标收集
      vi.advanceTimersByTime(1000);

      expect(metricsCollectedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestCount: expect.any(Number),
          averageRequestTime: expect.any(Number),
          errorCount: expect.any(Number),
          errorRate: expect.any(Number),
          memoryUsage: expect.any(Object),
          cpuUsage: expect.any(Object),
          timestamp: expect.any(Number),
          uptime: expect.any(Number),
        }),
      );
    });

    it('应该正确计算请求统计', () => {
      monitor.start();

      // 添加一些测试请求
      monitor.startRequest('req-1', 'test', 'test');
      vi.advanceTimersByTime(100);
      monitor.endRequest('req-1', true);

      monitor.startRequest('req-2', 'test', 'test');
      vi.advanceTimersByTime(200);
      monitor.endRequest('req-2', false, '错误');

      // 触发指标收集
      vi.advanceTimersByTime(1000);

      const metrics = monitor.getCurrentMetrics();
      expect(metrics).toBeDefined();
      expect(metrics?.requestCount).toBe(2);
      expect(metrics?.errorCount).toBe(1);
      expect(metrics?.errorRate).toBe(0.5);
    });
  });

  describe('阈值检查', () => {
    it('应该在请求时间超过阈值时发出警告', () => {
      const thresholdExceededSpy = vi.fn();

      const fastConfig = {
        ...config,
        thresholds: { ...config.thresholds, maxRequestTime: 50 },
        enableAlerts: true,
      };
      const fastMonitor = new PerformanceMonitor(fastConfig);
      fastMonitor.on('thresholdExceeded', thresholdExceededSpy);

      fastMonitor.startRequest('slow-request', 'test', 'test');
      vi.advanceTimersByTime(100); // 超过50ms阈值
      fastMonitor.endRequest('slow-request', true);

      expect(thresholdExceededSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'requestTime',
          value: 100,
          threshold: 50,
        }),
      );

      fastMonitor.stop();
    });

    it('应该在错误率超过阈值时发出警告', () => {
      const thresholdExceededSpy = vi.fn();

      const strictConfig = {
        ...config,
        thresholds: { ...config.thresholds, maxErrorRate: 0.3 },
        collectInterval: 100,
        enableAlerts: true,
      };
      const strictMonitor = new PerformanceMonitor(strictConfig);
      strictMonitor.on('thresholdExceeded', thresholdExceededSpy);

      // 添加多个失败请求以超过错误率阈值
      for (let i = 1; i <= 5; i++) {
        strictMonitor.startRequest(`req-${i}`, 'test', 'test');
        strictMonitor.endRequest(`req-${i}`, i <= 2); // 前2个成功，后3个失败
      }

      expect(thresholdExceededSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'errorRate',
          value: 0.6, // 3/5 = 0.6
          threshold: 0.3,
        }),
      );

      strictMonitor.stop();
    });
  });

  describe('系统资源监控', () => {
    it('应该正确获取系统资源使用情况', () => {
      const resourceUsage = monitor.getSystemResourceUsage();

      expect(resourceUsage).toEqual({
        memory: {
          rss: expect.any(Number),
          heapTotal: expect.any(Number),
          heapUsed: expect.any(Number),
          external: expect.any(Number),
          arrayBuffers: expect.any(Number),
          usagePercentage: expect.any(Number),
        },
        cpu: {
          user: expect.any(Number),
          system: expect.any(Number),
          usagePercentage: expect.any(Number),
        },
        system: {
          totalMemory: expect.any(Number),
          freeMemory: expect.any(Number),
          loadAverage: expect.any(Array),
          uptime: expect.any(Number),
        },
      });
    });
  });

  describe('性能报告', () => {
    it('应该生成完整的性能报告', () => {
      // 添加一些测试数据
      monitor.startRequest('req-1', 'test', 'test');
      vi.advanceTimersByTime(100);
      monitor.endRequest('req-1', true);

      monitor.startRequest('req-2', 'test', 'test');
      vi.advanceTimersByTime(200);
      monitor.endRequest('req-2', false, '错误');

      const report = monitor.getPerformanceReport();

      expect(report).toEqual({
        summary: {
          totalRequests: 2,
          successfulRequests: 1,
          failedRequests: 1,
          averageResponseTime: 150, // (100 + 200) / 2
          errorRate: 0.5, // 1/2
          uptime: expect.any(Number),
        },
        resourceUsage: expect.any(Object),
        recentMetrics: expect.any(Array),
        topSlowRequests: expect.arrayContaining([
          expect.objectContaining({
            requestId: 'req-2',
            duration: 200,
          }),
          expect.objectContaining({
            requestId: 'req-1',
            duration: 100,
          }),
        ]),
      });
    });

    it('应该支持时间窗口过滤', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // 添加旧请求
      monitor.startRequest('old-req', 'test', 'test');
      monitor.endRequest('old-req', true);

      // 推进时间
      vi.advanceTimersByTime(2000);

      // 添加新请求
      monitor.startRequest('new-req', 'test', 'test');
      monitor.endRequest('new-req', true);

      // 获取最近1秒的报告
      const report = monitor.getPerformanceReport(1000);

      expect(report.summary.totalRequests).toBe(1);
      expect(report.topSlowRequests[0].requestId).toBe('new-req');
    });
  });

  describe('数据管理', () => {
    it('应该正确获取请求历史', () => {
      monitor.startRequest('req-1', 'test', 'test');
      monitor.endRequest('req-1', true);

      monitor.startRequest('req-2', 'test', 'test');
      monitor.endRequest('req-2', true);

      const allHistory = monitor.getRequestHistory();
      expect(allHistory).toHaveLength(2);

      const limitedHistory = monitor.getRequestHistory(1);
      expect(limitedHistory).toHaveLength(1);
      expect(limitedHistory[0].requestId).toBe('req-2');
    });

    it('应该正确重置数据', () => {
      const resetSpy = vi.fn();
      monitor.on('reset', resetSpy);

      // 添加一些数据
      monitor.startRequest('req-1', 'test', 'test');
      monitor.endRequest('req-1', true);

      monitor.reset();

      expect(resetSpy).toHaveBeenCalled();
      expect(monitor.getRequestHistory()).toHaveLength(0);
      expect(monitor.getMetricsHistory()).toHaveLength(0);
    });

    it('应该正确更新配置', () => {
      const configUpdatedSpy = vi.fn();
      monitor.on('configUpdated', configUpdatedSpy);

      const newConfig = { collectInterval: 2000 };
      monitor.updateConfig(newConfig);

      expect(configUpdatedSpy).toHaveBeenCalledWith(expect.objectContaining(newConfig));
    });
  });

  describe('数据清理', () => {
    it('应该定期清理过期数据', () => {
      const dataCleanupSpy = vi.fn();

      const shortRetentionConfig = {
        ...config,
        retentionPeriod: 1000, // 1秒保留期
        enabled: false, // 手动启动
      };
      const shortMonitor = new PerformanceMonitor(shortRetentionConfig);
      shortMonitor.on('dataCleanup', dataCleanupSpy);

      shortMonitor.start();

      // 添加数据
      shortMonitor.startRequest('req-1', 'test', 'test');
      shortMonitor.endRequest('req-1', true);

      // 推进时间触发清理（清理间隔是保留期的1/10）
      vi.advanceTimersByTime(200); // 200ms > 100ms (1000/10)

      expect(dataCleanupSpy).toHaveBeenCalled();

      shortMonitor.stop();
    });
  });
});

describe('createPerformanceMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('应该创建性能监控器实例并应用配置', () => {
    const monitor = createPerformanceMonitor({ enabled: false });

    expect(monitor).toBeInstanceOf(PerformanceMonitor);
    // enabled=false 时不记录请求，验证配置生效
    monitor.startRequest('r', 'op', 'c');
    monitor.endRequest('r', true);
    expect(monitor.getRequestHistory()).toHaveLength(0);
  });
});

describe('DEFAULT_PERFORMANCE_CONFIG', () => {
  it('默认配置值正确', () => {
    expect(DEFAULT_PERFORMANCE_CONFIG).toEqual({
      enabled: true,
      collectInterval: 30000,
      retentionPeriod: 24 * 60 * 60 * 1000,
      thresholds: {
        maxRequestTime: 5000,
        maxMemoryUsage: 512 * 1024 * 1024,
        maxCpuUsage: 80,
        maxErrorRate: 0.05,
      },
      enableAlerts: true,
      maxHistorySize: 1000,
    });
    expect(DEFAULT_PERFORMANCE_CONFIG.retentionPeriod).toBe(86_400_000);
    expect(DEFAULT_PERFORMANCE_CONFIG.thresholds.maxMemoryUsage).toBe(536_870_912);
  });
});

describe('PerformanceMonitor 构造与启停', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enabled=true 时构造即启动并发射 started', () => {
    const spy = vi.fn();
    const originalEmit = PerformanceMonitor.prototype.emit;
    PerformanceMonitor.prototype.emit = function patchedEmit(
      this: PerformanceMonitor,
      event: string,
      ...args: unknown[]
    ) {
      spy(event, ...args);
      return originalEmit.call(this, event, ...args);
    };

    try {
      const m = new PerformanceMonitor({ enabled: true, collectInterval: 1000 });
      m.stop();
      const disabled = new PerformanceMonitor({ enabled: false, collectInterval: 1000 });
      disabled.stop();
    } finally {
      PerformanceMonitor.prototype.emit = originalEmit;
    }

    // 只有 enabled 的实例在构造时发射 started（stopped 来自显式 stop 调用）
    const startedCalls = spy.mock.calls.filter((call) => call[0] === 'started');
    expect(startedCalls).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith('started');
  });

  it('stop 后不再收集指标', async () => {
    const m = new PerformanceMonitor({ enabled: false, collectInterval: 100 });
    m.start();
    m.stop();

    const spy = vi.fn();
    m.on('metricsCollected', spy);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spy).not.toHaveBeenCalled();
  });

  it('未收集过指标时 getCurrentMetrics 返回 null', () => {
    const m = new PerformanceMonitor({ enabled: false });

    expect(m.getCurrentMetrics()).toBeNull();
  });

  it('enabled=false 时忽略 startRequest/endRequest', () => {
    const m = new PerformanceMonitor({ enabled: false });
    const spy = vi.fn();
    m.on('requestCompleted', spy);

    m.startRequest('r1', 'op', 'component');
    m.endRequest('r1', true);

    expect(spy).not.toHaveBeenCalled();
    expect(m.getRequestHistory()).toHaveLength(0);
  });

  it('endRequest 不传 success 时默认为成功', () => {
    const m = new PerformanceMonitor({ enabled: true });
    const spy = vi.fn();
    m.on('requestCompleted', spy);

    m.startRequest('r1', 'op', 'component');
    m.endRequest('r1');

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1', success: true }));
    m.stop();
  });

  it('请求结束后清理临时数据，重复 endRequest 不产生记录', () => {
    const m = new PerformanceMonitor({ enabled: true });

    m.startRequest('r1', 'op', 'component');
    m.endRequest('r1', true);
    m.endRequest('r1', true); // 第二次应因临时数据已删除而被忽略

    expect(m.getRequestHistory()).toHaveLength(1);
    m.stop();
  });
});

describe('PerformanceMonitor 指标统计', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new PerformanceMonitor({ enabled: true, collectInterval: 1000 });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it('仅统计成功请求的耗时，失败请求计入错误率', async () => {
    monitor.startRequest('r1', 'op', 'c');
    vi.advanceTimersByTime(100);
    monitor.endRequest('r1', true);

    monitor.startRequest('r2', 'op', 'c');
    vi.advanceTimersByTime(300);
    monitor.endRequest('r2', true);

    monitor.startRequest('r3', 'op', 'c');
    vi.advanceTimersByTime(50);
    monitor.endRequest('r3', false, '错误');

    await vi.advanceTimersByTimeAsync(1000);

    expect(monitor.getCurrentMetrics()).toEqual(
      expect.objectContaining({
        requestCount: 3,
        totalRequestTime: 400,
        averageRequestTime: 200,
        minRequestTime: 100,
        maxRequestTime: 300,
        errorCount: 1,
        errorRate: 1 / 3,
        cpuUsage: { user: 1_000_000, system: 500_000 },
        timestamp: expect.any(Number),
        uptime: expect.any(Number),
      }),
    );
  });

  it('uptime 等于当前时间与启动时间之差', async () => {
    vi.advanceTimersByTime(500);

    await vi.advanceTimersByTimeAsync(500); // t=1000 触发收集

    expect(monitor.getCurrentMetrics()?.uptime).toBe(1000);
  });

  it('时间窗口边界（endTime 恰好等于 cutoff）的请求仍被统计', async () => {
    monitor.startRequest('r1', 'op', 'c');
    monitor.endRequest('r1', true); // endTime = 0

    await vi.advanceTimersByTimeAsync(1000); // cutoff = 1000 - 1000 = 0

    expect(monitor.getCurrentMetrics()?.requestCount).toBe(1);
  });

  it('指标历史超过 maxHistorySize 时淘汰最旧记录', async () => {
    const small = new PerformanceMonitor({
      enabled: true,
      collectInterval: 100,
      maxHistorySize: 3,
    });

    await vi.advanceTimersByTimeAsync(400); // 收集 4 次

    expect(small.getMetricsHistory()).toHaveLength(3);
    small.stop();
  });

  it('getMetricsHistory 支持限制数量并返回副本', async () => {
    await vi.advanceTimersByTimeAsync(3000); // 收集 3 次

    const all = monitor.getMetricsHistory();
    expect(all).toHaveLength(3);

    const limited = monitor.getMetricsHistory(2);
    expect(limited).toHaveLength(2);
    expect(limited[0]).toBe(all[1]);
    expect(limited[1]).toBe(all[2]);
  });

  it('getRequestHistory 支持限制数量并返回副本', () => {
    for (let i = 1; i <= 3; i++) {
      monitor.startRequest(`r${i}`, 'op', 'c');
      monitor.endRequest(`r${i}`, true);
    }

    const all = monitor.getRequestHistory();
    expect(all).toHaveLength(3);

    const limited = monitor.getRequestHistory(2);
    expect(limited).toHaveLength(2);
    expect(limited[0].requestId).toBe('r2');
    expect(limited[1].requestId).toBe('r3');
  });
});

describe('PerformanceMonitor 阈值告警', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  it('enableAlerts=false 时不发射任何阈值事件', () => {
    monitor = new PerformanceMonitor({
      enabled: true,
      enableAlerts: false,
      thresholds: { maxRequestTime: 10, maxMemoryUsage: 1, maxCpuUsage: 1, maxErrorRate: 0 },
    });
    const spy = vi.fn();
    monitor.on('thresholdExceeded', spy);

    monitor.startRequest('slow', 'op', 'c');
    vi.advanceTimersByTime(100);
    monitor.endRequest('slow', false, '错误');

    expect(spy).not.toHaveBeenCalled();
  });

  it('请求耗时恰好等于阈值时不告警（严格大于才告警）', () => {
    monitor = new PerformanceMonitor({
      enabled: true,
      thresholds: { maxRequestTime: 100, maxMemoryUsage: 1, maxCpuUsage: 1, maxErrorRate: 1 },
    });
    const spy = vi.fn();
    monitor.on('thresholdExceeded', spy);

    monitor.startRequest('boundary', 'op', 'c');
    vi.advanceTimersByTime(100); // duration === 100 === maxRequestTime
    monitor.endRequest('boundary', true);

    expect(spy).not.toHaveBeenCalled();
  });

  it('请求耗时超过阈值时携带具体数值告警', () => {
    monitor = new PerformanceMonitor({
      enabled: true,
      thresholds: { maxRequestTime: 100, maxMemoryUsage: 1, maxCpuUsage: 1, maxErrorRate: 1 },
    });
    const spy = vi.fn();
    monitor.on('thresholdExceeded', spy);

    monitor.startRequest('slow', 'op', 'c');
    vi.advanceTimersByTime(101);
    monitor.endRequest('slow', true);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'requestTime',
        value: 101,
        threshold: 100,
        request: expect.objectContaining({ requestId: 'slow' }),
      }),
    );
  });

  it('错误率恰好等于阈值时不告警，超过阈值时告警', () => {
    monitor = new PerformanceMonitor({
      enabled: true,
      collectInterval: 10_000,
      thresholds: { maxRequestTime: 10_000, maxMemoryUsage: 1, maxCpuUsage: 1, maxErrorRate: 0.5 },
    });
    const spy = vi.fn();
    monitor.on('thresholdExceeded', spy);

    // 1 成功 + 1 失败 = 0.5，恰好等于阈值
    monitor.startRequest('a', 'op', 'c');
    monitor.endRequest('a', true);
    monitor.startRequest('b', 'op', 'c');
    monitor.endRequest('b', false, '错误');

    expect(spy).not.toHaveBeenCalled();

    // 再加 1 次失败 → 错误率 2/3 > 0.5
    monitor.startRequest('c', 'op', 'c');
    monitor.endRequest('c', false, '错误');

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'errorRate', value: 2 / 3, threshold: 0.5 }),
    );
  });
});

describe('PerformanceMonitor 数据清理', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  it('保留期边界（endTime 恰好等于 cutoff）的记录不被清理', async () => {
    monitor = new PerformanceMonitor({
      enabled: true,
      collectInterval: 10_000,
      retentionPeriod: 1000, // 清理间隔 100ms
    });

    monitor.startRequest('r1', 'op', 'c');
    monitor.endRequest('r1', true); // endTime = 0

    await vi.advanceTimersByTimeAsync(1000); // cutoff = 0，endTime == cutoff 应保留

    expect(monitor.getRequestHistory()).toHaveLength(1);
  });

  it('超过保留期的记录被清理', async () => {
    monitor = new PerformanceMonitor({
      enabled: true,
      collectInterval: 10_000,
      retentionPeriod: 1000,
    });

    monitor.startRequest('old', 'op', 'c');
    monitor.endRequest('old', true);

    await vi.advanceTimersByTimeAsync(1100); // t=1100 时 cutoff=100 > endTime=0 → 清理

    expect(monitor.getRequestHistory()).toHaveLength(0);
  });

  it('指标历史按时间戳清理并发射 dataCleanup 事件', async () => {
    monitor = new PerformanceMonitor({
      enabled: true,
      collectInterval: 1000,
      retentionPeriod: 1000,
    });
    const spy = vi.fn();
    monitor.on('dataCleanup', spy);

    await vi.advanceTimersByTimeAsync(2000); // 两次收集（ts=1000, ts=2000）

    // t=2000 的清理 cutoff=1000，ts=1000 的指标在边界上应保留
    expect(monitor.getMetricsHistory()).toHaveLength(2);
    expect(spy).toHaveBeenCalledWith({
      requestHistorySize: expect.any(Number),
      metricsHistorySize: expect.any(Number),
    });
  });

  it('reset 清空历史并重置启动时间', async () => {
    monitor = new PerformanceMonitor({ enabled: true, collectInterval: 1000 });

    monitor.startRequest('r1', 'op', 'c');
    monitor.endRequest('r1', true);
    await vi.advanceTimersByTimeAsync(1000);

    vi.advanceTimersByTime(500);
    monitor.reset();

    expect(monitor.getRequestHistory()).toHaveLength(0);
    expect(monitor.getMetricsHistory()).toHaveLength(0);
    expect(monitor.getCurrentMetrics()).toBeNull();

    vi.advanceTimersByTime(100);
    const report = monitor.getPerformanceReport();
    expect(report.summary.uptime).toBe(100); // 以 reset 时刻重新计算
  });
});

describe('PerformanceMonitor 系统资源', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('使用 mocked os/process 数据计算资源使用率', () => {
    const monitor = new PerformanceMonitor({ enabled: false });

    expect(monitor.getSystemResourceUsage()).toEqual({
      memory: {
        rss: 100 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 60 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
        usagePercentage: 50, // (8GB - 4GB) / 8GB
      },
      cpu: {
        user: 1_000_000,
        system: 500_000,
        usagePercentage: 37.5, // (1s + 0.5s) / (1ms * 4核) * 100
      },
      system: {
        totalMemory: 8 * 1024 * 1024 * 1024,
        freeMemory: 4 * 1024 * 1024 * 1024,
        loadAverage: [1.0, 1.5, 2.0],
        uptime: 3600,
      },
    });
  });
});

describe('PerformanceMonitor 性能报告', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    // enabled 且手动 stop，避免定时器干扰（默认 collectInterval 30s 内不会触发）
    monitor = new PerformanceMonitor({ enabled: true });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  function addRequest(id: string, duration: number, success = true): void {
    monitor.startRequest(id, 'op', 'c');
    vi.advanceTimersByTime(duration);
    monitor.endRequest(id, success);
  }

  it('平均响应时间包含失败请求，错误率按失败数计算', () => {
    addRequest('ok', 100, true);
    addRequest('fail', 200, false);

    const report = monitor.getPerformanceReport();

    expect(report.summary).toEqual({
      totalRequests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      averageResponseTime: 150,
      errorRate: 0.5,
      uptime: expect.any(Number),
    });
  });

  it('uptime 等于当前时间与启动时间之差', () => {
    vi.advanceTimersByTime(500);

    expect(monitor.getPerformanceReport().summary.uptime).toBe(500);
  });

  it('topSlowRequests 按耗时降序排列且最多 10 条', () => {
    for (let i = 1; i <= 12; i++) {
      addRequest(`r${i}`, i * 10);
    }

    const report = monitor.getPerformanceReport();

    expect(report.topSlowRequests).toHaveLength(10);
    expect(report.topSlowRequests[0].requestId).toBe('r12');
    expect(report.topSlowRequests[0].duration).toBe(120);
    expect(report.topSlowRequests[9].requestId).toBe('r3');
    const durations = report.topSlowRequests.map((r) => r.duration);
    expect([...durations].toSorted((a, b) => b - a)).toEqual(durations);
  });

  it('recentMetrics 只保留最近 10 条', async () => {
    vi.setSystemTime(0);
    const m = new PerformanceMonitor({ enabled: true, collectInterval: 100 });
    await vi.advanceTimersByTimeAsync(1200); // 收集 12 次

    const report = m.getPerformanceReport();

    expect(report.recentMetrics).toHaveLength(10);
    expect(report.recentMetrics[0].timestamp).toBe(300); // 第 3 次收集
    expect(report.recentMetrics[9].timestamp).toBe(1200);
    m.stop();
  });

  it('带时间窗口时只统计窗口内的请求', () => {
    addRequest('old', 100);
    vi.advanceTimersByTime(2000);
    addRequest('new', 100);

    const report = monitor.getPerformanceReport(1000);

    expect(report.summary.totalRequests).toBe(1);
    expect(report.topSlowRequests[0].requestId).toBe('new');
  });
});

describe('PerformanceMonitor 更新配置', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('从禁用切换到启用时自动启动', () => {
    const m = new PerformanceMonitor({ enabled: false, collectInterval: 1000 });
    const spy = vi.fn();
    m.on('started', spy);

    m.updateConfig({ enabled: true });

    expect(spy).toHaveBeenCalledTimes(1);
    m.stop();
  });

  it('从启用切换到禁用时自动停止', async () => {
    const m = new PerformanceMonitor({ enabled: true, collectInterval: 100 });
    const spy = vi.fn();
    m.on('stopped', spy);
    const collectSpy = vi.fn();
    m.on('metricsCollected', collectSpy);

    m.updateConfig({ enabled: false });
    await vi.advanceTimersByTimeAsync(1000);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(collectSpy).not.toHaveBeenCalled();
  });

  it('保持启用状态时既不重启也不停止', () => {
    const m = new PerformanceMonitor({ enabled: true, collectInterval: 1000 });
    const startedSpy = vi.fn();
    const stoppedSpy = vi.fn();
    const updatedSpy = vi.fn();
    m.on('started', startedSpy);
    m.on('stopped', stoppedSpy);
    m.on('configUpdated', updatedSpy);

    m.updateConfig({ collectInterval: 5000 });

    expect(startedSpy).not.toHaveBeenCalled();
    expect(stoppedSpy).not.toHaveBeenCalled();
    expect(updatedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, collectInterval: 5000, maxHistorySize: 1000 }),
    );
    m.stop();
  });
});

describe('performanceMonitor 单例代理', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    // 恢复被单例测试修改的 mock 环境变量
    process.env.PERFORMANCE_MONITORING = 'false';
    delete process.env.PERFORMANCE_COLLECT_INTERVAL;
  });

  it('PERFORMANCE_MONITORING=false 时禁用监控', async () => {
    process.env.PERFORMANCE_MONITORING = 'false';
    vi.resetModules();
    const { performanceMonitor } = await import('./performance-monitor');

    performanceMonitor.startRequest('proxy-req', 'op', 'c');
    performanceMonitor.endRequest('proxy-req', true);

    expect(performanceMonitor.getRequestHistory()).toHaveLength(0);
  });

  it('未显式禁用时启用监控并按环境变量间隔收集指标', async () => {
    process.env.PERFORMANCE_MONITORING = 'true';
    process.env.PERFORMANCE_COLLECT_INTERVAL = '250';
    vi.resetModules();
    const { performanceMonitor } = await import('./performance-monitor');

    expect(performanceMonitor.getCurrentMetrics()).toBeNull();

    await vi.advanceTimersByTimeAsync(249);
    expect(performanceMonitor.getCurrentMetrics()).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(performanceMonitor.getCurrentMetrics()).not.toBeNull();
    performanceMonitor.stop();
  });
});
