/**
 * 性能监控工具测试
 * 覆盖指标记录、统计聚合、时间窗口过滤与监控中间件
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPerformanceMiddleware,
  PerformanceMonitor,
  performanceMonitor,
  type PerformanceMetric,
} from './performance-monitor.js';

function makeMetric(overrides: Partial<PerformanceMetric>): PerformanceMetric {
  return {
    endpoint: '/api/test',
    method: 'GET',
    duration: 100,
    timestamp: 1000,
    statusCode: 200,
    success: true,
    ...overrides,
  };
}

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    monitor = new PerformanceMonitor();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordMetric / getMetrics', () => {
    it('记录指标后可读取', () => {
      const metric = makeMetric({});
      monitor.recordMetric(metric);

      expect(monitor.getMetrics()).toEqual([metric]);
    });

    it('getMetrics 返回副本，修改不影响内部状态', () => {
      monitor.recordMetric(makeMetric({}));
      const metrics = monitor.getMetrics();
      metrics.push(makeMetric({ endpoint: '/other' }));

      expect(monitor.getMetrics()).toHaveLength(1);
    });

    it('少量指标不会被裁剪', () => {
      monitor.recordMetric(makeMetric({ duration: 1 }));
      monitor.recordMetric(makeMetric({ duration: 2 }));

      expect(monitor.getMetrics()).toHaveLength(2);
    });

    it('恰好 1000 条时全部保留', () => {
      for (let i = 0; i < 1000; i++) {
        monitor.recordMetric(makeMetric({ duration: i }));
      }

      expect(monitor.getMetrics()).toHaveLength(1000);
      expect(monitor.getMetrics()[0]!.duration).toBe(0);
    });

    it('超过 1000 条时淘汰最旧记录', () => {
      for (let i = 0; i < 1001; i++) {
        monitor.recordMetric(makeMetric({ duration: i }));
      }

      const metrics = monitor.getMetrics();
      expect(metrics).toHaveLength(1000);
      // 第一条（duration=0）被淘汰，最旧的是 duration=1
      expect(metrics[0]!.duration).toBe(1);
      expect(metrics[metrics.length - 1]!.duration).toBe(1000);
    });
  });

  describe('getStats', () => {
    it('无指标时返回全零统计', () => {
      expect(monitor.getStats()).toEqual({
        totalRequests: 0,
        averageResponseTime: 0,
        minResponseTime: 0,
        maxResponseTime: 0,
        successRate: 0,
        errorRate: 0,
        requestsPerSecond: 0,
      });
    });

    it('聚合计算平均值、最值与成功/失败率', () => {
      monitor.recordMetric(makeMetric({ duration: 100, success: true }));
      monitor.recordMetric(makeMetric({ duration: 300, success: false }));
      monitor.recordMetric(makeMetric({ duration: 200, success: true }));

      const stats = monitor.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.averageResponseTime).toBe(200);
      expect(stats.minResponseTime).toBe(100);
      expect(stats.maxResponseTime).toBe(300);
      expect(stats.successRate).toBeCloseTo((2 / 3) * 100, 5);
      expect(stats.errorRate).toBeCloseTo((1 / 3) * 100, 5);
    });

    it('无时间窗口时 RPS 基于实例启动时间计算', () => {
      vi.setSystemTime(4000);
      monitor.recordMetric(makeMetric({ timestamp: 3900 }));
      monitor.recordMetric(makeMetric({ timestamp: 3950 }));

      // timeSpan = 4000 - 0 = 4000ms → 2 / 4000 * 1000 = 0.5
      expect(monitor.getStats().requestsPerSecond).toBeCloseTo(0.5, 5);
    });

    it('指定时间窗口时只统计窗口内的指标', () => {
      monitor.recordMetric(makeMetric({ timestamp: 100, duration: 999 }));
      monitor.recordMetric(makeMetric({ timestamp: 600, duration: 200 }));
      monitor.recordMetric(makeMetric({ timestamp: 800, duration: 400 }));

      vi.setSystemTime(1000);
      const stats = monitor.getStats(500); // cutoff = 500
      expect(stats.totalRequests).toBe(2);
      expect(stats.minResponseTime).toBe(200);
      expect(stats.maxResponseTime).toBe(400);
      // timeWindow=500ms，2 个请求 → 2/500*1000 = 4
      expect(stats.requestsPerSecond).toBeCloseTo(4, 5);
    });

    it('时间窗口内无指标时返回全零', () => {
      monitor.recordMetric(makeMetric({ timestamp: 100 }));
      vi.setSystemTime(1000);

      expect(monitor.getStats(500).totalRequests).toBe(0);
      expect(monitor.getStats(500).averageResponseTime).toBe(0);
    });
  });

  describe('getStatsByEndpoint', () => {
    it('按 "方法 端点" 分组统计', () => {
      monitor.recordMetric(makeMetric({ method: 'GET', endpoint: '/a', duration: 100 }));
      monitor.recordMetric(makeMetric({ method: 'GET', endpoint: '/a', duration: 300 }));
      monitor.recordMetric(
        makeMetric({ method: 'POST', endpoint: '/a', duration: 50, success: false }),
      );

      const stats = monitor.getStatsByEndpoint();
      expect(Object.keys(stats).toSorted()).toEqual(['GET /a', 'POST /a']);

      const getA = stats['GET /a']!;
      expect(getA.totalRequests).toBe(2);
      expect(getA.averageResponseTime).toBe(200);
      expect(getA.successRate).toBe(100);
      expect(getA.errorRate).toBe(0);

      const postA = stats['POST /a']!;
      expect(postA.totalRequests).toBe(1);
      expect(postA.successRate).toBe(0);
      expect(postA.errorRate).toBe(100);
      // 端点级别不计算 RPS
      expect(postA.requestsPerSecond).toBe(0);
    });

    it('无指标时返回空对象', () => {
      expect(monitor.getStatsByEndpoint()).toEqual({});
    });
  });

  describe('getStatsByPathPrefix', () => {
    it('只统计包含前缀的端点', () => {
      monitor.recordMetric(makeMetric({ endpoint: '/api/users', duration: 100 }));
      monitor.recordMetric(makeMetric({ endpoint: '/api/users/1', duration: 300 }));
      monitor.recordMetric(makeMetric({ endpoint: '/web/home', duration: 999 }));

      const stats = monitor.getStatsByPathPrefix('/api');
      expect(stats.totalRequests).toBe(2);
      expect(stats.maxResponseTime).toBe(300);
      expect(stats.requestsPerSecond).toBe(0);
    });

    it('结合时间窗口过滤', () => {
      monitor.recordMetric(makeMetric({ endpoint: '/api/new', timestamp: 900, duration: 100 }));
      monitor.recordMetric(makeMetric({ endpoint: '/api/old', timestamp: 100, duration: 999 }));

      vi.setSystemTime(1000);
      const stats = monitor.getStatsByPathPrefix('/api', 500);
      expect(stats.totalRequests).toBe(1);
      expect(stats.maxResponseTime).toBe(100);
    });

    it('无匹配指标时返回全零', () => {
      monitor.recordMetric(makeMetric({ endpoint: '/api/x' }));

      const stats = monitor.getStatsByPathPrefix('/none');
      expect(stats).toEqual({
        totalRequests: 0,
        averageResponseTime: 0,
        minResponseTime: 0,
        maxResponseTime: 0,
        successRate: 0,
        errorRate: 0,
        requestsPerSecond: 0,
      });
    });
  });

  describe('getSlowRequests', () => {
    it('返回超过阈值的请求并按耗时降序排列', () => {
      monitor.recordMetric(makeMetric({ duration: 1500, endpoint: '/b' }));
      monitor.recordMetric(makeMetric({ duration: 2500, endpoint: '/a' }));
      monitor.recordMetric(makeMetric({ duration: 500, endpoint: '/c' }));

      const slow = monitor.getSlowRequests(1000);
      expect(slow.map((m) => m.endpoint)).toEqual(['/a', '/b']);
    });

    it('耗时恰好等于阈值不算慢请求', () => {
      monitor.recordMetric(makeMetric({ duration: 1000 }));

      expect(monitor.getSlowRequests(1000)).toEqual([]);
    });

    it('默认阈值为 1000ms', () => {
      monitor.recordMetric(makeMetric({ duration: 1001 }));
      monitor.recordMetric(makeMetric({ duration: 999 }));

      expect(monitor.getSlowRequests()).toHaveLength(1);
    });
  });

  describe('getRecentErrors', () => {
    it('返回失败请求，最近的排在前面', () => {
      monitor.recordMetric(makeMetric({ success: false, statusCode: 500, timestamp: 1 }));
      monitor.recordMetric(makeMetric({ success: true, timestamp: 2 }));
      monitor.recordMetric(makeMetric({ success: false, statusCode: 404, timestamp: 3 }));
      monitor.recordMetric(makeMetric({ success: false, statusCode: 502, timestamp: 4 }));

      const errors = monitor.getRecentErrors();
      expect(errors.map((m) => m.statusCode)).toEqual([502, 404, 500]);
    });

    it('limit 限制返回数量（取最近的）', () => {
      for (let i = 0; i < 15; i++) {
        monitor.recordMetric(makeMetric({ success: false, timestamp: i }));
      }

      const errors = monitor.getRecentErrors(5);
      expect(errors).toHaveLength(5);
      expect(errors[0]!.timestamp).toBe(14);
      expect(errors[4]!.timestamp).toBe(10);
    });

    it('无错误时返回空数组', () => {
      monitor.recordMetric(makeMetric({ success: true }));

      expect(monitor.getRecentErrors()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('清空指标并重置启动时间', () => {
      monitor.recordMetric(makeMetric({}));
      vi.setSystemTime(5000);
      monitor.clear();

      expect(monitor.getMetrics()).toEqual([]);
      expect(monitor.getStats().totalRequests).toBe(0);

      // 重置后 startTime = 5000，新指标 RPS 基于 5000 起点
      vi.setSystemTime(5010);
      monitor.recordMetric(makeMetric({ timestamp: 5010 }));
      expect(monitor.getStats().requestsPerSecond).toBeCloseTo(100, 5);
    });
  });

  it('导出全局单例', () => {
    expect(performanceMonitor).toBeInstanceOf(PerformanceMonitor);
  });
});

describe('createPerformanceMiddleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    performanceMonitor.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildApp(handler: () => Response | Promise<Response>) {
    const app = new Hono();
    app.use('*', createPerformanceMiddleware());
    app.get('/test', () => handler());
    return app;
  }

  function recorded() {
    const metrics = performanceMonitor.getMetrics();
    expect(metrics).toHaveLength(1);
    return metrics[0]!;
  }

  it('成功请求记录指标（2xx 为成功）', async () => {
    const app = buildApp(() => {
      vi.advanceTimersByTime(50);
      return new Response('ok', { status: 200 });
    });

    const res = await app.request('/test', { method: 'GET' });
    expect(res.status).toBe(200);

    const metric = recorded();
    expect(metric.endpoint).toBe('/test');
    expect(metric.method).toBe('GET');
    expect(metric.duration).toBe(50);
    expect(metric.statusCode).toBe(200);
    expect(metric.success).toBe(true);
    expect(metric.timestamp).toBe(50);
  });

  it('3xx 仍视为成功', async () => {
    const app = buildApp(() => new Response(null, { status: 302 }));
    await app.request('/test');

    expect(recorded().success).toBe(true);
  });

  it('4xx 视为失败', async () => {
    const app = buildApp(() => new Response('nope', { status: 404 }));
    await app.request('/test');

    const metric = recorded();
    expect(metric.statusCode).toBe(404);
    expect(metric.success).toBe(false);
  });

  it('状态码 400 视为失败（边界不包含 400）', async () => {
    const app = buildApp(() => new Response('bad', { status: 400 }));
    await app.request('/test');

    expect(recorded().success).toBe(false);
  });

  it('处理器抛错时记录 500 失败指标', async () => {
    const app = buildApp(() => {
      vi.advanceTimersByTime(30);
      throw new Error('boom');
    });

    // 中间件重新抛出，Hono 默认错误处理器返回 500
    const res = await app.request('/test');
    expect(res.status).toBe(500);

    const metric = recorded();
    expect(metric.statusCode).toBe(500);
    expect(metric.success).toBe(false);
    expect(metric.duration).toBe(30);
  });
});
