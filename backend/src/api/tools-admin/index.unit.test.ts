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

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

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

    it('offset+limit 恰好等于 total 时 hasMore 为 false', async () => {
      addExecutionRecord(record({ toolName: 'hist-boundary' }));
      addExecutionRecord(record({ toolName: 'hist-boundary' }));
      addExecutionRecord(record({ toolName: 'hist-boundary' }));

      const response = await app.request(
        '/api/tools/history?toolName=hist-boundary&limit=2&offset=1',
      );

      expect((await response.json()).data.pagination).toEqual({
        total: 3,
        limit: 2,
        offset: 1,
        hasMore: false,
      });
    });

    it('默认 limit=50、offset=0', async () => {
      addExecutionRecord(record({ toolName: 'hist-default' }));

      const response = await app.request('/api/tools/history?toolName=hist-default');

      const body = await response.json();
      expect(body.data.pagination.limit).toBe(50);
      expect(body.data.pagination.offset).toBe(0);
    });

    it('groupId 过滤独立于 toolName/serverId 过滤', async () => {
      addExecutionRecord(
        record({ toolName: 'hist-group', serverId: 'hist-gsrv', groupId: 'hist-ga' }),
      );
      addExecutionRecord(
        record({ toolName: 'hist-group', serverId: 'hist-gsrv', groupId: 'hist-gb' }),
      );

      const response = await app.request(
        '/api/tools/history?toolName=hist-group&serverId=hist-gsrv&groupId=hist-ga',
      );

      const body = await response.json();
      expect(body.data.pagination.total).toBe(1);
      expect(body.data.history[0].groupId).toBe('hist-ga');
    });

    it('addExecutionRecord 记录调试日志', () => {
      loggerMock.debug.mockClear();
      addExecutionRecord(record({ id: 'hist-dbg-1', toolName: 'hist-dbg' }));

      expect(loggerMock.debug).toHaveBeenCalledWith('添加工具执行记录', {
        executionId: 'hist-dbg-1',
        toolName: 'hist-dbg',
        totalRecords: expect.any(Number),
      });
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
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'admin-request',
        error: { message: '服务不可用' },
      });
    });

    it('未指定 groupId 时回落 default，缺失健康信息的服务器为 unknown', async () => {
      hubService.listTools.mockResolvedValue([{ name: 'mon-ghost', serverId: 'mon-ghost-srv' }]);
      hubService.getServerHealth.mockReturnValue(new Map([['mon-other', 'connected']]));

      const response = await app.request('/api/tools/monitoring');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.groupId).toBe('default');
      expect(body.data.toolsByServer['mon-ghost-srv']).toMatchObject({
        serverId: 'mon-ghost-srv',
        serverStatus: 'unknown',
      });
      expect(body.data.toolsByServer['mon-ghost-srv'].tools[0]).toMatchObject({
        name: 'mon-ghost',
        status: 'unavailable',
      });
      expect(body.data.overview).toEqual({
        totalTools: 1,
        availableTools: 0,
        unavailableTools: 1,
        totalServers: 1,
        connectedServers: 0,
        disconnectedServers: 1,
        availabilityRate: 0,
      });
    });

    it('工具列表为空时汇总全部为 0 且可用率不为 NaN', async () => {
      hubService.listTools.mockResolvedValue([]);
      hubService.getServerHealth.mockReturnValue(new Map());

      const response = await app.request('/api/tools/monitoring');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.overview).toEqual({
        totalTools: 0,
        availableTools: 0,
        unavailableTools: 0,
        totalServers: 0,
        connectedServers: 0,
        disconnectedServers: 0,
        availabilityRate: 0,
      });
      expect(body.data.toolsByServer).toEqual({});
    });

    it('多服务器时 connected/disconnected 计数并输出监控日志', async () => {
      hubService.listTools.mockResolvedValue([
        { name: 'mon-t1', serverId: 'mon-a' },
        { name: 'mon-t2', serverId: 'mon-b' },
      ]);
      hubService.getServerHealth.mockReturnValue(
        new Map([
          ['mon-a', 'connected'],
          ['mon-b', 'connected'],
        ]),
      );

      const response = await app.request('/api/tools/monitoring?groupId=mon-g');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.overview).toEqual({
        totalTools: 2,
        availableTools: 2,
        unavailableTools: 0,
        totalServers: 2,
        connectedServers: 2,
        disconnectedServers: 0,
        availabilityRate: 100,
      });
      expect(loggerMock.info).toHaveBeenCalledWith('获取工具状态监控信息', {
        groupId: 'mon-g',
        totalTools: 2,
        availableTools: 2,
        totalServers: 2,
        connectedServers: 2,
      });
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

    it('健康比例不足 80% 时整体不健康且 50% 错误率不触发告警', async () => {
      hubService.listTools.mockResolvedValue([
        { name: 'hl-ok', serverId: 'hl-up' },
        { name: 'hl-bad', serverId: 'hl-down' },
      ]);
      hubService.getServiceDiagnostics.mockResolvedValue({
        servers: {
          details: [
            { id: 'hl-up', status: 'connected' },
            { id: 'hl-down', status: 'disconnected' },
          ],
        },
      });
      addExecutionRecord(
        record({ id: 'hl-e1', toolName: 'hl-ok', serverId: 'hl-up', isError: true }),
      );
      addExecutionRecord(record({ id: 'hl-e2', toolName: 'hl-ok', serverId: 'hl-up' }));

      const response = await app.request('/api/tools/health?groupId=hl-g');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.overall).toEqual({
        isHealthy: false,
        totalTools: 2,
        healthyTools: 1,
        unhealthyTools: 1,
        healthRate: 50,
      });
      const byName = new Map(body.data.tools.map((t: { toolName: string }) => [t.toolName, t]));
      expect(byName.get('hl-ok')).toMatchObject({
        serverStatus: 'connected',
        isHealthy: true,
        recentExecutions: 2,
        recentErrors: 1,
        errorRate: 50,
        lastError: { executionId: 'hl-e1', error: {} },
        issues: [],
      });
      expect(byName.get('hl-bad')).toMatchObject({
        serverStatus: 'disconnected',
        isHealthy: false,
        issues: ['服务器 hl-down 未连接'],
      });
      expect(loggerMock.info).toHaveBeenCalledWith('获取工具健康检查信息', {
        groupId: 'hl-g',
        totalTools: 2,
        healthyTools: 1,
        overallHealthy: false,
      });
    });

    it('健康比例恰好 80% 时整体健康', async () => {
      hubService.listTools.mockResolvedValue([
        { name: 'hp-1', serverId: 'hp-up' },
        { name: 'hp-2', serverId: 'hp-up' },
        { name: 'hp-3', serverId: 'hp-up' },
        { name: 'hp-4', serverId: 'hp-up' },
        { name: 'hp-5', serverId: 'hp-down' },
      ]);
      hubService.getServiceDiagnostics.mockResolvedValue({
        servers: {
          details: [
            { id: 'hp-up', status: 'connected' },
            { id: 'hp-down', status: 'disconnected' },
          ],
        },
      });

      const response = await app.request('/api/tools/health');

      const overall = (await response.json()).data.overall;
      expect(overall.isHealthy).toBe(true);
      expect(overall.totalTools).toBe(5);
      expect(overall.healthyTools).toBe(4);
      expect(overall.unhealthyTools).toBe(1);
      expect(overall.healthRate).toBeCloseTo(80, 10);
    });

    it('近期执行仅统计匹配工具且最多取 10 条', async () => {
      for (let i = 0; i < 12; i++) {
        addExecutionRecord(
          record({
            id: `cap-${i}`,
            toolName: 'cap-tool',
            serverId: 'cap-srv',
            isError: i % 2 === 0,
          }),
        );
      }
      addExecutionRecord(record({ toolName: 'cap-other', serverId: 'cap-srv' }));
      hubService.listTools.mockResolvedValue([{ name: 'cap-tool', serverId: 'cap-srv' }]);
      hubService.getServiceDiagnostics.mockResolvedValue({
        servers: { details: [{ id: 'cap-srv', status: 'connected' }] },
      });

      const response = await app.request('/api/tools/health');

      const check = (await response.json()).data.tools[0];
      expect(check.recentExecutions).toBe(10);
      expect(check.recentErrors).toBe(5);
      expect(check.errorRate).toBe(50);
      // 最新记录在最前（unshift），最近一次错误是 cap-10
      expect(check.lastError.executionId).toBe('cap-10');
      expect(check.issues).toEqual([]);
    });

    it('无近期执行的工具有零错误率与空 lastError', async () => {
      hubService.listTools.mockResolvedValue([{ name: 'nr-tool', serverId: 'nr-srv' }]);
      hubService.getServiceDiagnostics.mockResolvedValue({
        servers: { details: [{ id: 'nr-srv', status: 'connected' }] },
      });

      const response = await app.request('/api/tools/health');

      const check = (await response.json()).data.tools[0];
      expect(check).toMatchObject({
        recentExecutions: 0,
        recentErrors: 0,
        errorRate: 0,
        lastError: null,
        issues: [],
      });
    });

    it('诊断详情按服务器 ID 匹配而非取第一条', async () => {
      hubService.listTools.mockResolvedValue([{ name: 'diag-match', serverId: 'diag-up' }]);
      hubService.getServiceDiagnostics.mockResolvedValue({
        servers: {
          details: [
            { id: 'diag-other', status: 'error' },
            { id: 'diag-up', status: 'connected' },
          ],
        },
      });

      const response = await app.request('/api/tools/health');

      const check = (await response.json()).data.tools[0];
      expect(check).toMatchObject({ serverStatus: 'connected', isHealthy: true });
    });

    it('诊断服务抛错返回 500', async () => {
      hubService.listTools.mockResolvedValue([]);
      hubService.getServiceDiagnostics.mockRejectedValue(new Error('诊断失败'));

      const response = await app.request('/api/tools/health');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        requestId: 'admin-request',
        error: { message: '诊断失败' },
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

    it('各时间窗口按边界裁剪并回显 period 与默认 timeRange', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
      try {
        const now = Date.now();
        const g = 'perf-win-g';
        const hour = 60 * 60 * 1000;
        // 恰好位于 1h 窗口起点（>= 边界包含）
        addExecutionRecord(
          record({ toolName: 'win-1h', groupId: g, timestamp: new Date(now - hour).toISOString() }),
        );
        // 恰好位于窗口终点（<= 边界包含）
        addExecutionRecord(
          record({ toolName: 'win-now', groupId: g, timestamp: new Date(now).toISOString() }),
        );
        // 2h 前仅落入 6h/24h/7d 窗口
        addExecutionRecord(
          record({
            toolName: 'win-2h',
            groupId: g,
            timestamp: new Date(now - 2 * hour).toISOString(),
          }),
        );
        // 12h 前仅落入 24h/7d 窗口
        addExecutionRecord(
          record({
            toolName: 'win-12h',
            groupId: g,
            timestamp: new Date(now - 12 * hour).toISOString(),
          }),
        );

        const fetchJson = async (query: string) =>
          (await (await app.request(`/api/tools/performance?${query}`)).json()).data;

        const h1 = await fetchJson(`timeRange=1h&groupId=${g}`);
        expect(h1.timeRange).toBe('1h');
        expect(h1.period).toEqual({
          startTime: new Date(now - hour).toISOString(),
          endTime: new Date(now).toISOString(),
        });
        expect(h1.overview.totalExecutions).toBe(2);

        const h6 = await fetchJson(`timeRange=6h&groupId=${g}`);
        expect(h6.timeRange).toBe('6h');
        expect(h6.period.startTime).toBe(new Date(now - 6 * hour).toISOString());
        expect(h6.overview.totalExecutions).toBe(3);

        const h24 = await fetchJson(`timeRange=24h&groupId=${g}`);
        expect(h24.timeRange).toBe('24h');
        expect(h24.period.startTime).toBe(new Date(now - 24 * hour).toISOString());
        expect(h24.overview.totalExecutions).toBe(4);

        const d7 = await fetchJson(`timeRange=7d&groupId=${g}`);
        expect(d7.timeRange).toBe('7d');
        expect(d7.period.startTime).toBe(new Date(now - 7 * 24 * hour).toISOString());
        expect(d7.overview.totalExecutions).toBe(4);

        // 不传 timeRange 时回落 1h 并回显 '1h'
        const def = await fetchJson(`groupId=${g}`);
        expect(def.timeRange).toBe('1h');
        expect(def.overview.totalExecutions).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('serverId 过滤生效且不带过滤条件时统计窗口内全部记录', async () => {
      const g = 'perf-srv-g';
      addExecutionRecord(record({ toolName: 'ps-a', groupId: g, serverId: 'ps-1' }));
      addExecutionRecord(record({ toolName: 'ps-b', groupId: g, serverId: 'ps-2' }));

      const filtered = await app.request(`/api/tools/performance?groupId=${g}&serverId=ps-1`);
      const filteredBody = (await filtered.json()).data;
      expect(filteredBody.overview.totalExecutions).toBe(1);
      expect(filteredBody.filters).toEqual({ groupId: g, serverId: 'ps-1' });

      // 无过滤条件时不应把 groupId===undefined 当作过滤值
      const unfiltered = await app.request(`/api/tools/performance?serverId=ps-2`);
      expect((await unfiltered.json()).data.overview.totalExecutions).toBe(1);
    });

    it('分工具统计平均耗时与成功率', async () => {
      const g = 'perf-per-tool-g';
      addExecutionRecord(
        record({
          toolName: 'pt-a',
          groupId: g,
          executionTime: 10,
          timestamp: new Date().toISOString(),
        }),
      );
      addExecutionRecord(
        record({
          toolName: 'pt-a',
          groupId: g,
          executionTime: 30,
          timestamp: new Date().toISOString(),
        }),
      );
      addExecutionRecord(
        record({
          toolName: 'pt-b',
          groupId: g,
          executionTime: 50,
          isError: true,
          timestamp: new Date().toISOString(),
        }),
      );

      const response = await app.request(`/api/tools/performance?groupId=${g}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.toolPerformance['pt-a']).toStrictEqual({
        executions: 2,
        successes: 2,
        failures: 0,
        averageTime: 20,
        minTime: 10,
        maxTime: 30,
        successRate: 100,
      });
      expect(body.data.toolPerformance['pt-b']).toStrictEqual({
        executions: 1,
        successes: 0,
        failures: 1,
        averageTime: 50,
        minTime: 50,
        maxTime: 50,
        successRate: 0,
      });
      expect(loggerMock.info).toHaveBeenCalledWith('获取工具性能分析信息', {
        timeRange: '1h',
        totalExecutions: 3,
        successfulExecutions: 2,
        failedExecutions: 1,
        toolCount: 2,
        filters: { groupId: g, serverId: undefined },
      });
    });

    it('按小时聚合时间序列并计算平均耗时与错误率', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:30:00.000Z'));
      try {
        const now = Date.now();
        const g = 'perf-ts-g';
        const _hour = 60 * 60 * 1000;
        const bucket = (t: number) => `${new Date(t).toISOString().slice(0, 13)}:00:00.000Z`;

        // 上一小时（11:55，仍在 1h 窗口内）：1 次成功，耗时 100
        addExecutionRecord(
          record({
            toolName: 'ts-x',
            groupId: g,
            executionTime: 100,
            timestamp: new Date(now - 35 * 60 * 1000).toISOString(),
          }),
        );
        // 当前小时：3 次执行（10/20/40），其中 1 次失败（40）
        addExecutionRecord(
          record({
            toolName: 'ts-x',
            groupId: g,
            executionTime: 10,
            timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
          }),
        );
        addExecutionRecord(
          record({
            toolName: 'ts-x',
            groupId: g,
            executionTime: 20,
            timestamp: new Date(now - 4 * 60 * 1000).toISOString(),
          }),
        );
        addExecutionRecord(
          record({
            toolName: 'ts-x',
            groupId: g,
            executionTime: 40,
            isError: true,
            timestamp: new Date(now - 3 * 60 * 1000).toISOString(),
          }),
        );

        const response = await app.request(`/api/tools/performance?groupId=${g}`);

        const body = await response.json();
        expect(body.data.timeSeries).toStrictEqual([
          {
            timestamp: bucket(now - 35 * 60 * 1000),
            executions: 1,
            errors: 0,
            averageTime: 100,
            errorRate: 0,
          },
          {
            timestamp: bucket(now - 5 * 60 * 1000),
            executions: 3,
            errors: 1,
            averageTime: 23,
            errorRate: (1 / 3) * 100,
          },
        ]);
      } finally {
        vi.useRealTimers();
      }
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

    it('serverId 与 groupId 过滤错误记录', async () => {
      addExecutionRecord(
        record({
          toolName: 'err-f',
          serverId: 'es1',
          groupId: 'eg1',
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
        }),
      );
      addExecutionRecord(
        record({
          toolName: 'err-f',
          serverId: 'es2',
          groupId: 'eg1',
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
        }),
      );
      addExecutionRecord(
        record({
          toolName: 'err-f',
          serverId: 'es2',
          groupId: 'eg2',
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
        }),
      );

      const byBoth = await app.request('/api/tools/errors?toolName=err-f&serverId=es2&groupId=eg2');
      expect((await byBoth.json()).data.pagination.total).toBe(1);

      const byServer = await app.request('/api/tools/errors?toolName=err-f&serverId=es2');
      expect((await byServer.json()).data.pagination.total).toBe(2);

      const byGroup = await app.request('/api/tools/errors?toolName=err-f&groupId=eg1');
      expect((await byGroup.json()).data.pagination.total).toBe(2);
    });

    it('不带过滤条件时返回错误记录，非错误记录被排除', async () => {
      addExecutionRecord(
        record({
          toolName: 'err-all',
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
        }),
      );
      addExecutionRecord(
        record({
          toolName: 'err-all',
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
        }),
      );
      addExecutionRecord(record({ toolName: 'err-all' }));

      const response = await app.request('/api/tools/errors');

      const body = await response.json();
      // 全量错误记录中只包含 isError 的条目（err-all 的成功记录不应出现）
      const errAllErrors = body.data.errors.filter(
        (e: { toolName: string }) => e.toolName === 'err-all',
      );
      expect(errAllErrors).toHaveLength(2);
      expect(body.data.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('offset+limit 恰好等于 total 时 hasMore 为 false', async () => {
      for (let i = 0; i < 3; i++) {
        addExecutionRecord(
          record({
            toolName: 'err-hm',
            isError: true,
            result: [{ type: 'text', text: 'boom' }],
          }),
        );
      }

      const response = await app.request('/api/tools/errors?toolName=err-hm&limit=2&offset=1');

      expect((await response.json()).data.pagination).toEqual({
        total: 3,
        limit: 2,
        offset: 1,
        hasMore: false,
      });
    });

    it('回显 severity 过滤参数', async () => {
      addExecutionRecord(
        record({
          toolName: 'err-sev',
          isError: true,
          result: [{ type: 'text', text: 'boom' }],
        }),
      );

      const response = await app.request('/api/tools/errors?severity=high');

      const body = await response.json();
      expect(body.data.filters).toEqual({ severity: 'high' });
    });

    it('同一错误最多保留 3 个示例且 lastOccurrence 取最新', async () => {
      for (let i = 1; i <= 4; i++) {
        addExecutionRecord(
          record({
            id: `dup-${i}`,
            toolName: 'err-dup',
            isError: true,
            result: [{ type: 'text', text: 'dup-err' }],
            timestamp: `2026-01-0${i}T00:00:00.000Z`,
          }),
        );
      }

      const response = await app.request('/api/tools/errors?toolName=err-dup');

      const summary = (await response.json()).data.errorSummary[0];
      expect(summary.count).toBe(4);
      expect(summary.examples).toHaveLength(3);
      // 新记录在最前（unshift），示例按新到旧
      expect(summary.examples.map((e: { executionId: string }) => e.executionId)).toEqual([
        'dup-4',
        'dup-3',
        'dup-2',
      ]);
      expect(summary.lastOccurrence).toBe('2026-01-04T00:00:00.000Z');
    });

    it('错误摘要按出现次数降序排列', async () => {
      addExecutionRecord(
        record({
          toolName: 'err-order',
          isError: true,
          result: [{ type: 'text', text: 'minor' }],
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
      );
      for (let i = 2; i <= 4; i++) {
        addExecutionRecord(
          record({
            toolName: 'err-order',
            isError: true,
            result: [{ type: 'text', text: 'major' }],
            timestamp: `2026-01-0${i}T00:00:00.000Z`,
          }),
        );
      }

      const response = await app.request('/api/tools/errors?toolName=err-order');

      const summary = (await response.json()).data.errorSummary;
      expect(summary.map((s: { errorMessage: string }) => s.errorMessage)).toEqual([
        'major',
        'minor',
      ]);
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

    it('topTools 按执行次数降序并包含成败计数', async () => {
      const g = 'stats-top-g';
      // 先插入执行次数少的工具，验证排序不是插入顺序
      addExecutionRecord(record({ toolName: 'st-b', executionTime: 5, groupId: g }));
      addExecutionRecord(record({ toolName: 'st-a', executionTime: 10, groupId: g }));
      addExecutionRecord(
        record({ toolName: 'st-a', executionTime: 30, isError: true, groupId: g }),
      );

      const response = await app.request(`/api/tools/stats?groupId=${g}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.topTools[0]).toStrictEqual({
        toolName: 'st-a',
        executions: 2,
        successes: 1,
        failures: 1,
        totalTime: 40,
        averageTime: 20,
      });
      expect(body.data.topTools[1].toolName).toBe('st-b');
      expect(body.data.overview).toEqual({
        totalExecutions: 3,
        successfulExecutions: 2,
        failedExecutions: 1,
        successRate: expect.closeTo(66.66666666666667, 10),
        averageExecutionTime: 15,
      });
      expect(loggerMock.info).toHaveBeenCalledWith('获取工具执行统计信息', {
        totalExecutions: 3,
        successfulExecutions: 2,
        failedExecutions: 1,
        topToolsCount: 2,
        filters: { groupId: g, serverId: undefined },
      });
    });

    it('无匹配记录时各项统计为 0', async () => {
      const response = await app.request('/api/tools/stats?groupId=stats-empty-g');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.overview).toEqual({
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        successRate: 0,
        averageExecutionTime: 0,
      });
      expect(body.data.topTools).toEqual([]);
    });

    it('不带 groupId 时按 serverId 统计全部记录', async () => {
      addExecutionRecord(record({ toolName: 'stats-nog', serverId: 'stats-uniq-srv' }));

      const response = await app.request('/api/tools/stats?serverId=stats-uniq-srv');

      expect((await response.json()).data.overview.totalExecutions).toBe(1);
    });
  });
});
