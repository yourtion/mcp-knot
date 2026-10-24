import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hubService = vi.hoisted(() => ({
  getMcpMessages: vi.fn(),
  callTool: vi.fn(),
  getPerformanceStats: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getHubService: () => hubService,
}));

import { debugApi } from './index.js';

describe('调试API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'debug-request');
      await next();
    });
    app.route('/api/debug', debugApi);
  });

  it('GET /mcp-messages 透传 limit/serverId/type 过滤参数', async () => {
    const messages = [{ id: 'm1', type: 'request' }];
    hubService.getMcpMessages.mockReturnValueOnce(messages);

    const response = await app.request('/api/debug/mcp-messages?limit=5&serverId=srv&type=request');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { messages },
    });
    expect(hubService.getMcpMessages).toHaveBeenCalledWith(5, 'srv', 'request');
  });

  it('GET /mcp-messages 默认 limit 为 50', async () => {
    hubService.getMcpMessages.mockReturnValueOnce([]);

    await app.request('/api/debug/mcp-messages');

    expect(hubService.getMcpMessages).toHaveBeenCalledWith(50, undefined, undefined);
  });

  it('GET /mcp-messages 服务异常时返回 500', async () => {
    hubService.getMcpMessages.mockImplementation(() => {
      throw new Error('审计不可用');
    });

    const response = await app.request('/api/debug/mcp-messages');

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('POST /tool-test 执行工具并返回结果与耗时', async () => {
    hubService.callTool.mockResolvedValueOnce({ content: [] });

    const response = await app.request('/api/debug/tool-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolName: 'echo',
        serverId: 'srv',
        groupId: 'team',
        arguments: { q: 'x' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        toolName: 'echo',
        serverId: 'srv',
        groupId: 'team',
        arguments: { q: 'x' },
        result: { content: [] },
      },
    });
    expect(hubService.callTool).toHaveBeenCalledWith('echo', { q: 'x' }, 'team');
  });

  it('POST /tool-test 缺少 toolName 时返回 400', async () => {
    const response = await app.request('/api/debug/tool-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'toolName is required' },
      requestId: 'debug-request',
    });
    expect(hubService.callTool).not.toHaveBeenCalled();
  });

  it('POST /tool-test 未提供 arguments 时以空对象执行', async () => {
    hubService.callTool.mockResolvedValueOnce({});

    const response = await app.request('/api/debug/tool-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName: 'echo' }),
    });

    expect(response.status).toBe(200);
    expect(hubService.callTool).toHaveBeenCalledWith('echo', {}, undefined);
  });

  it('POST /tool-test 执行失败时返回 500', async () => {
    hubService.callTool.mockRejectedValue(new Error('工具崩溃'));

    const response = await app.request('/api/debug/tool-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName: 'echo' }),
    });

    expect(response.status).toBe(500);
  });

  it('GET /performance-stats 返回性能统计', async () => {
    hubService.getPerformanceStats.mockReturnValueOnce({ totalRequests: 7 });

    const response = await app.request('/api/debug/performance-stats');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { stats: { totalRequests: 7 } } });
  });

  it('GET /performance-stats 失败时返回 500', async () => {
    hubService.getPerformanceStats.mockImplementation(() => {
      throw new Error('统计不可用');
    });

    const response = await app.request('/api/debug/performance-stats');

    expect(response.status).toBe(500);
  });

  describe('GET /error-analysis', () => {
    it('汇总错误总数、错误率与最常见错误', async () => {
      hubService.getMcpMessages.mockReturnValueOnce([
        { type: 'response', content: { isError: true, error: 'timeout' } },
        { type: 'response', content: { isError: true, error: 'timeout' } },
        { type: 'response', content: { isError: true, error: 'refused' } },
        { type: 'response', content: { isError: false } },
        { type: 'request', content: { isError: true, error: 'ignored' } },
        { type: 'response', content: null },
      ]);

      const response = await app.request('/api/debug/error-analysis');

      expect(response.status).toBe(200);
      const data = (await response.json()).data;
      expect(data.errors).toHaveLength(3);
      expect(data.analysis.totalErrors).toBe(3);
      expect(data.analysis.errorRate).toBe(50);
      expect(data.analysis.mostCommonErrors).toEqual({ timeout: 2, refused: 1 });
      expect(data.analysis.recentErrors).toHaveLength(3);
    });

    it('无消息时错误率为 0', async () => {
      hubService.getMcpMessages.mockReturnValueOnce([]);

      const response = await app.request('/api/debug/error-analysis');

      expect(response.status).toBe(200);
      const data = (await response.json()).data;
      expect(data.analysis).toMatchObject({ totalErrors: 0, errorRate: 0 });
      expect(data.analysis.mostCommonErrors).toEqual({});
    });

    it('isError 但缺少 error 字段时归为 Unknown error', async () => {
      hubService.getMcpMessages.mockReturnValueOnce([
        { type: 'response', content: { isError: true } },
      ]);

      const response = await app.request('/api/debug/error-analysis');

      expect((await response.json()).data.analysis.mostCommonErrors).toEqual({
        'Unknown error': 1,
      });
    });

    it('服务异常时返回 500', async () => {
      hubService.getMcpMessages.mockImplementation(() => {
        throw new Error('boom');
      });

      const response = await app.request('/api/debug/error-analysis');

      expect(response.status).toBe(500);
    });
  });
});
