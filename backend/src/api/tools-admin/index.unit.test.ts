import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hubService = vi.hoisted(() => ({
  listTools: vi.fn(),
  getServerHealth: vi.fn(),
  getServiceDiagnostics: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getHubService: () => hubService,
}));

import { addExecutionRecord, toolsAdminApi } from './index.js';

import type { ToolExecutionRecord } from './index.js';

let seq = 0;

function record(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  seq += 1;
  return {
    id: `rec-${seq}`,
    toolName: 'echo',
    serverId: 'primary',
    groupId: 'default',
    arguments: {},
    result: {},
    isError: false,
    executionTime: 10,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('Tools Admin API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'admin-request');
      await next();
    });
    app.route('/api/tools', toolsAdminApi);
  });

  describe('GET /history - 执行历史', () => {
    it('默认分页返回历史记录并支持过滤', async () => {
      addExecutionRecord(record({ toolName: 'hist-a', groupId: 'g1', serverId: 's1' }));
      addExecutionRecord(
        record({ toolName: 'hist-b', groupId: 'g2', serverId: 's1', isError: true }),
      );
      addExecutionRecord(record({ toolName: 'hist-a', groupId: 'g1', serverId: 's2' }));

      const all = await app.request('/api/tools/history?limit=10');
      expect(all.status).toBe(200);
      const allBody = await all.json();
      // 新记录在最前（unshift）
      expect(allBody.data.history.map((r: { toolName: string }) => r.toolName)).toEqual([
        'hist-a',
        'hist-b',
        'hist-a',
      ]);
      expect(allBody.data.pagination).toEqual({
        total: 3,
        limit: 10,
        offset: 0,
        hasMore: false,
      });
      // 历史记录不回传参数与结果
      expect(allBody.data.history[0]).not.toHaveProperty('arguments');
      expect(allBody.data.history[0]).not.toHaveProperty('result');

      const filtered = await app.request(
        '/api/tools/history?toolName=hist-a&serverId=s1&groupId=g1',
      );
      const filteredBody = await filtered.json();
      expect(filteredBody.data.pagination.total).toBe(1);
      expect(filteredBody.data.history[0]).toMatchObject({
        toolName: 'hist-a',
        serverId: 's1',
        groupId: 'g1',
      });
    });

    it('分页偏移与 hasMore 标记', async () => {
      addExecutionRecord(record({ toolName: 'hist-page', executionTime: 1 }));
      addExecutionRecord(record({ toolName: 'hist-page', executionTime: 2 }));
      addExecutionRecord(record({ toolName: 'hist-page', executionTime: 3 }));

      const response = await app.request('/api/tools/history?toolName=hist-page&limit=2&offset=2');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.history).toHaveLength(1);
      expect(body.data.pagination).toEqual({
        total: 3,
        limit: 2,
        offset: 2,
        hasMore: false,
      });

      const firstPage = await app.request('/api/tools/history?toolName=hist-page&limit=2');
      expect((await firstPage.json()).data.pagination.hasMore).toBe(true);
    });

    it('历史记录超过上限时截断到 1000 条', async () => {
      for (let i = 0; i < 1001; i++) {
        addExecutionRecord(record({ toolName: 'hist-overflow' }));
      }

      const response = await app.request('/api/tools/history?toolName=hist-overflow&limit=2000');

      expect(response.status).toBe(200);
      expect((await response.json()).data.pagination.total).toBe(1000);
    });
  });

  describe('GET /monitoring - 状态监控', () => {
    it('按服务器聚合工具并计算可用率', async () => {
      hubService.listTools.mockResolvedValue([
        { name: 't1', serverId: 'up', inputSchema: {} },
        { name: 't2', serverId: 'up', inputSchema: {} },
        { name: 't3', serverId: 'down', inputSchema: {} },
      ]);
      hubService.getServerHealth.mockReturnValue(
        new Map([
          ['up', 'connected'],
          ['down', 'disconnected'],
        ]),
      );

      const response = await app.request('/api/tools/monitoring?groupId=team');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.groupId).toBe('team');
      expect(body.data.overview).toEqual({
        totalTools: 3,
        availableTools: 2,
        unavailableTools: 1,
        totalServers: 2,
        connectedServers: 1,
        disconnectedServers: 1,
        availabilityRate: (2 / 3) * 100,
      });
      expect(body.data.toolsByServer.up).toMatchObject({
        serverId: 'up',
        serverStatus: 'connected',
      });
      expect(body.data.toolsByServer.up.tools).toHaveLength(2);
      expect(body.data.toolsByServer.up.tools[0]).toMatchObject({ status: 'available' });
      expect(body.data.toolsByServer.down.tools[0]).toMatchObject({ status: 'unavailable' });
    });

    it('listTools 抛错返回 500', async () => {
      hubService.listTools.mockRejectedValue(new Error('服务不可用'));

      const response = await app.request('/api/tools/monitoring');

      expect(response.status).toBe(500);
    });
  });

  describe('GET /health - 工具健康检查', () => {
    it('结合服务器诊断与近期执行计算健康度', async () => {
      const toolName = 'health-tool';
      hubService.listTools.mockResolvedValue([{ name: toolName, serverId: 'diag-up' }]);
      hubService.getServiceDiagnostics.mockResolvedValue({
        servers: {
          details: [{ id: 'diag-up', status: 'connected' }],
        },
      });
      addExecutionRecord(
        record({
          toolName,
          serverId: 'diag-up',
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
        }),
      );

      const response = await app.request('/api/tools/health?groupId=team');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.overall).toEqual({
        isHealthy: true,
        totalTools: 1,
        healthyTools: 1,
        unhealthyTools: 0,
        healthRate: 100,
      });
      const check = body.data.tools[0];
      expect(check).toMatchObject({
        toolName,
        serverStatus: 'connected',
        isHealthy: true,
        recentExecutions: 1,
        recentErrors: 1,
        errorRate: 100,
        lastError: {
          executionId: expect.stringMatching(/^rec-/),
          error: [{ type: 'text', text: 'boom' }],
        },
        issues: ['错误率过高: 100%'],
      });
      expect(body.data.groupId).toBe('team');
      expect(body.data.serverDiagnostics).toEqual({
        details: [{ id: 'diag-up', status: 'connected' }],
      });
    });

    it('服务器不在诊断详情时状态为 unknown 且不健康', async () => {
      hubService.listTools.mockResolvedValue([{ name: 'health-ghost', serverId: 'ghost' }]);
      hubService.getServiceDiagnostics.mockResolvedValue({ servers: { details: [] } });

      const response = await app.request('/api/tools/health');

      expect(response.status).toBe(200);
      const check = (await response.json()).data.tools[0];
      expect(check).toMatchObject({
        serverStatus: 'unknown',
        isHealthy: false,
        issues: ['服务器 ghost 未连接'],
      });
    });
  });

  describe('GET /performance - 性能分析', () => {
    it('按时间窗口聚合执行指标与分位数', async () => {
      const toolName = 'perf-tool';
      const groupId = 'perf-group';
      const now = Date.now();
      addExecutionRecord(
        record({ toolName, groupId, executionTime: 10, timestamp: new Date(now).toISOString() }),
      );
      addExecutionRecord(
        record({ toolName, groupId, executionTime: 20, timestamp: new Date(now).toISOString() }),
      );
      addExecutionRecord(
        record({
          toolName,
          groupId,
          executionTime: 40,
          isError: true,
          timestamp: new Date(now).toISOString(),
        }),
      );
      // 3 天前的记录仅落入 7d 窗口
      addExecutionRecord(
        record({
          toolName,
          groupId,
          executionTime: 1000,
          timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      );

      const response = await app.request(`/api/tools/performance?timeRange=7d&groupId=${groupId}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.timeRange).toBe('7d');
      expect(body.data.overview).toEqual({
        totalExecutions: 4,
        successfulExecutions: 3,
        failedExecutions: 1,
        successRate: 75,
        averageExecutionTime: Math.round((10 + 20 + 40 + 1000) / 4),
        minExecutionTime: 10,
        maxExecutionTime: 1000,
      });
      expect(body.data.percentiles).toEqual({ p50: 40, p95: 1000, p99: 1000 });
      expect(body.data.toolPerformance[toolName]).toMatchObject({
        executions: 4,
        successes: 3,
        failures: 1,
        minTime: 10,
        maxTime: 1000,
        successRate: 75,
      });
      expect(body.data.timeSeries).toHaveLength(2);
      expect(body.data.timeSeries[0]).toMatchObject({
        executions: expect.any(Number),
        errors: expect.any(Number),
      });

      // 1h 窗口排除 3 天前的记录
      const short = await app.request(`/api/tools/performance?timeRange=1h&groupId=${groupId}`);
      expect((await short.json()).data.overview.totalExecutions).toBe(3);
    });

    it('未知 timeRange 回落到 1h 窗口', async () => {
      addExecutionRecord(
        record({
          toolName: 'perf-default',
          groupId: 'perf-group-2',
          executionTime: 5,
          timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        }),
      );

      const response = await app.request(
        '/api/tools/performance?timeRange=whatever&groupId=perf-group-2',
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data.overview.totalExecutions).toBe(1);
    });

    it('无执行记录时各项指标为 0', async () => {
      const response = await app.request('/api/tools/performance?groupId=perf-empty');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.overview).toEqual({
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        successRate: 0,
        averageExecutionTime: 0,
        minExecutionTime: 0,
        maxExecutionTime: 0,
      });
      expect(body.data.percentiles).toEqual({ p50: 0, p95: 0, p99: 0 });
      expect(body.data.timeSeries).toEqual([]);
    });
  });

  describe('GET /errors - 错误日志', () => {
    it('按错误文本聚合并返回分页明细', async () => {
      const toolName = 'err-tool';
      addExecutionRecord(
        record({
          toolName,
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
      );
      addExecutionRecord(
        record({
          toolName,
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
          timestamp: '2026-01-02T00:00:00.000Z',
        }),
      );
      addExecutionRecord(
        record({
          toolName,
          isError: true,
          result: 'not-an-array', // 无 text 内容 → 未知错误
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
      );

      const response = await app.request(`/api/tools/errors?toolName=${toolName}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.errors).toHaveLength(3);
      // 最新记录在最前（unshift），此处为无文本内容的错误
      expect(body.data.errors[0]).toMatchObject({
        toolName,
        arguments: {},
        result: 'not-an-array',
      });
      expect(body.data.pagination.total).toBe(3);

      const summary = new Map(
        body.data.errorSummary.map((s: { errorMessage: string }) => [s.errorMessage, s]),
      );
      expect(summary.get('boom')).toMatchObject({
        count: 2,
        affectedTools: [toolName],
        lastOccurrence: '2026-01-02T00:00:00.000Z',
        examples: [expect.objectContaining({ toolName }), expect.objectContaining({ toolName })],
      });
      expect(summary.get('未知错误').count).toBe(1);
    });

    it('超长错误文本截断到 100 字符', async () => {
      const longText = 'x'.repeat(150);
      addExecutionRecord(
        record({
          toolName: 'err-long',
          isError: true,
          result: [{ type: 'text', text: longText }],
        }),
      );

      const response = await app.request('/api/tools/errors?toolName=err-long');

      const summary = (await response.json()).data.errorSummary;
      expect(summary[0].errorMessage).toBe(`${'x'.repeat(100)}...`);
    });
  });

  describe('GET /stats - 执行统计', () => {
    it('按工具聚合执行次数与平均耗时', async () => {
      const toolName = 'stats-tool';
      // /stats 仅按 groupId/serverId 过滤，用独立 groupId 隔离其他用例的历史记录
      addExecutionRecord(record({ toolName, executionTime: 10, groupId: 'stats-group' }));
      addExecutionRecord(record({ toolName, executionTime: 30, groupId: 'stats-group' }));
      addExecutionRecord(
        record({ toolName: 'stats-other', executionTime: 5, groupId: 'stats-group' }),
      );

      const response = await app.request('/api/tools/stats?groupId=stats-group');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.overview).toEqual({
        totalExecutions: 3,
        successfulExecutions: 3,
        failedExecutions: 0,
        successRate: 100,
        averageExecutionTime: Math.round((10 + 30 + 5) / 3),
      });
      expect(body.data.topTools[0]).toMatchObject({
        toolName,
        executions: 2,
        successes: 2,
        totalTime: 40,
        averageTime: 20,
      });
      expect(body.data.filters).toEqual({ groupId: 'stats-group', serverId: undefined });
    });

    it('serverId 过滤生效', async () => {
      addExecutionRecord(
        record({ toolName: 'stats-srv', serverId: 's-one', groupId: 'stats-srv-group' }),
      );
      addExecutionRecord(
        record({ toolName: 'stats-srv', serverId: 's-two', groupId: 'stats-srv-group' }),
      );

      const response = await app.request('/api/tools/stats?groupId=stats-srv-group&serverId=s-two');

      expect((await response.json()).data.overview.totalExecutions).toBe(1);
    });
  });
});
