import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const performanceMonitor = vi.hoisted(() => ({
  getStats: vi.fn(),
  getStatsByEndpoint: vi.fn(),
  getSlowRequests: vi.fn(),
  getRecentErrors: vi.fn(),
  getMetrics: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../../utils/performance-monitor.js', () => ({ performanceMonitor }));

import { performanceApi } from './index.js';

describe('Performance API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'perf-request');
      await next();
    });
    app.route('/api/performance', performanceApi);
  });

  it('GET /stats 默认不传时间窗口，参数可覆盖', async () => {
    performanceMonitor.getStats.mockReturnValueOnce({ totalRequests: 1 });

    const response = await app.request('/api/performance/stats');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { totalRequests: 1 },
    });
    expect(performanceMonitor.getStats).toHaveBeenCalledWith(undefined);

    await app.request('/api/performance/stats?timeWindow=5000');
    expect(performanceMonitor.getStats).toHaveBeenLastCalledWith(5000);
  });

  it('GET /stats/by-endpoint 返回按端点分组统计', async () => {
    performanceMonitor.getStatsByEndpoint.mockReturnValueOnce({
      '/api/tools': { totalRequests: 3 },
    });

    const response = await app.request('/api/performance/stats/by-endpoint');

    expect(response.status).toBe(200);
    expect((await response.json()).data['/api/tools']).toEqual({ totalRequests: 3 });
  });

  it('GET /slow-requests 默认阈值 1000ms，参数可覆盖', async () => {
    performanceMonitor.getSlowRequests.mockReturnValueOnce([{ id: 'r1', duration: 2000 }]);

    const response = await app.request('/api/performance/slow-requests?threshold=1500');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { threshold: 1500, count: 1, requests: [{ id: 'r1' }] },
    });
    expect(performanceMonitor.getSlowRequests).toHaveBeenCalledWith(1500);

    await app.request('/api/performance/slow-requests');
    expect(performanceMonitor.getSlowRequests).toHaveBeenLastCalledWith(1000);
  });

  it('GET /recent-errors 默认取 10 条，limit 参数可覆盖', async () => {
    performanceMonitor.getRecentErrors.mockReturnValueOnce([{ id: 'e1' }]);

    const response = await app.request('/api/performance/recent-errors?limit=3');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { count: 1, errors: [{ id: 'e1' }] } });
    expect(performanceMonitor.getRecentErrors).toHaveBeenCalledWith(3);

    await app.request('/api/performance/recent-errors');
    expect(performanceMonitor.getRecentErrors).toHaveBeenLastCalledWith(10);
  });

  it('GET /metrics 返回指标列表与数量', async () => {
    performanceMonitor.getMetrics.mockReturnValueOnce([{ name: 'm1' }, { name: 'm2' }]);

    const response = await app.request('/api/performance/metrics');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { count: 2, metrics: [{ name: 'm1' }, { name: 'm2' }] },
    });
  });

  it('DELETE /metrics 清空指标', async () => {
    const response = await app.request('/api/performance/metrics', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(performanceMonitor.clear).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ data: { message: '性能指标已清除' } });
  });

  it('GET /report 聚合各监控维度', async () => {
    performanceMonitor.getStats.mockReturnValueOnce({ totalRequests: 9 });
    performanceMonitor.getStatsByEndpoint.mockReturnValueOnce({ '/x': {} });
    performanceMonitor.getSlowRequests.mockReturnValueOnce(
      Array.from({ length: 12 }, (_, i) => ({ id: `slow-${i}` })),
    );
    performanceMonitor.getRecentErrors.mockReturnValueOnce([{ id: 'e1' }]);

    const response = await app.request('/api/performance/report');

    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.overview).toEqual({ totalRequests: 9 });
    expect(data.byEndpoint).toEqual({ '/x': {} });
    // 慢请求统计为 12 条，但报告最多返回前 10 条
    expect(data.slowRequests.count).toBe(12);
    expect(data.slowRequests.requests).toHaveLength(10);
    expect(data.recentErrors).toEqual({ count: 1, errors: [{ id: 'e1' }] });
    expect(typeof data.generatedAt).toBe('string');
  });
});
