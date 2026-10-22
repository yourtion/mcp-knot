import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolStore } from '../tool';
import * as toolService from '@/services/tool';

import type {
  ToolExecuteResponse,
  ToolInfo,
  ToolListResponse,
  ToolMonitoring,
  ToolPerformance,
  ToolStats,
  ToolTestResponse,
} from '@/types/tool';

vi.mock('@/services/tool', () => ({
  getTools: vi.fn(),
  getToolsByServer: vi.fn(),
  getToolDetail: vi.fn(),
  executeTool: vi.fn(),
  testTool: vi.fn(),
  getToolHistory: vi.fn(),
  getToolStats: vi.fn(),
  getToolMonitoring: vi.fn(),
  getToolPerformance: vi.fn(),
  getExecutionDetail: vi.fn(),
  getToolHealth: vi.fn(),
  getToolErrors: vi.fn(),
}));

const mockToolService = toolService as unknown as Record<string, ReturnType<typeof vi.fn>>;

const makeTool = (overrides: Partial<ToolInfo> & Pick<ToolInfo, 'name'>): ToolInfo => ({
  description: `${overrides.name} 的描述`,
  serverId: 'server-1',
  inputSchema: { type: 'object' },
  status: 'available',
  ...overrides,
});

const makeListResponse = (
  tools: ToolInfo[],
  toolsByServer?: ToolListResponse['toolsByServer'],
): ToolListResponse => ({
  tools,
  toolsByServer: toolsByServer ?? {},
  total: tools.length,
  groupId: 'default',
});

describe('Tool Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('应该正确初始化状态和默认过滤条件', () => {
    const store = useToolStore();

    expect(store.tools.size).toBe(0);
    expect(store.toolsByServer.size).toBe(0);
    expect(store.executionHistory).toEqual([]);
    expect(store.currentExecution).toBeNull();
    expect(store.testResults.size).toBe(0);
    expect(store.stats).toBeNull();
    expect(store.monitoring).toBeNull();
    expect(store.performance).toBeNull();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.filters).toEqual({
      groupId: 'default',
      status: 'all',
      sortBy: 'name',
      sortOrder: 'asc',
    });
  });

  describe('fetchTools', () => {
    it('成功时填充工具列表和按服务器分组', async () => {
      const toolA = makeTool({ name: 'tool-a' });
      const toolB = makeTool({ name: 'tool-b', serverId: 'server-2', status: 'unavailable' });
      const response = makeListResponse([toolA, toolB], {
        'server-1': [toolA],
        'server-2': [toolB],
      });
      mockToolService.getTools.mockResolvedValue(response);

      const store = useToolStore();
      const result = await store.fetchTools({ groupId: 'default' });

      expect(result).toBe(response);
      expect(mockToolService.getTools).toHaveBeenCalledWith({ groupId: 'default' });
      expect(store.tools.size).toBe(2);
      expect(store.tools.get('tool-a')).toEqual(toolA);
      expect(store.toolsByServer.size).toBe(2);
      expect(store.toolsByServer.get('server-2')).toEqual([toolB]);
      expect(store.error).toBeNull();
      expect(store.loading).toBe(false);
    });

    it('成功时会先清除旧的本地数据', async () => {
      const store = useToolStore();
      store.tools.set('stale', makeTool({ name: 'stale' }));
      store.toolsByServer.set('old-server', [makeTool({ name: 'old' })]);

      const toolA = makeTool({ name: 'tool-a' });
      mockToolService.getTools.mockResolvedValue(makeListResponse([toolA]));

      await store.fetchTools();

      expect(store.tools.size).toBe(1);
      expect(store.tools.has('stale')).toBe(false);
      expect(store.toolsByServer.has('old-server')).toBe(false);
    });

    it('请求期间处于加载状态，结束后复位', async () => {
      let resolveFetch: (value: ToolListResponse) => void;
      mockToolService.getTools.mockImplementation(
        () => new Promise<ToolListResponse>((resolve) => (resolveFetch = resolve)),
      );

      const store = useToolStore();
      const pending = store.fetchTools();

      expect(store.loading).toBe(true);

      resolveFetch(makeListResponse([]));
      await pending;

      expect(store.loading).toBe(false);
    });

    it('失败时记录错误消息并向上抛出', async () => {
      mockToolService.getTools.mockRejectedValue(new Error('网络错误'));

      const store = useToolStore();
      await expect(store.fetchTools()).rejects.toThrow('网络错误');

      expect(store.error).toBe('网络错误');
      expect(store.loading).toBe(false);
    });

    it('失败时非 Error 对象使用默认错误消息', async () => {
      mockToolService.getTools.mockRejectedValue('boom');

      const store = useToolStore();
      await expect(store.fetchTools()).rejects.toBe('boom');

      expect(store.error).toBe('获取工具列表失败');
    });
  });

  describe('fetchToolsByServer', () => {
    it('成功时更新对应服务器分组并合并到全局列表', async () => {
      const toolA = makeTool({ name: 'tool-a' });
      mockToolService.getToolsByServer.mockResolvedValue(makeListResponse([toolA]));

      const store = useToolStore();
      const result = await store.fetchToolsByServer('server-1', 'default');

      expect(result).toEqual(makeListResponse([toolA]));
      expect(mockToolService.getToolsByServer).toHaveBeenCalledWith('server-1', 'default');
      expect(store.toolsByServer.get('server-1')).toEqual([toolA]);
      expect(store.tools.get('tool-a')).toEqual(toolA);
    });

    it('失败时记录默认错误消息并抛出', async () => {
      mockToolService.getToolsByServer.mockRejectedValue({});

      const store = useToolStore();
      await expect(store.fetchToolsByServer('server-1')).rejects.toBeDefined();

      expect(store.error).toBe('获取服务器工具失败');
    });
  });

  describe('fetchToolDetail', () => {
    it('成功时写入工具详情', async () => {
      const tool = makeTool({ name: 'tool-a' });
      mockToolService.getToolDetail.mockResolvedValue(tool);

      const store = useToolStore();
      const result = await store.fetchToolDetail('tool-a', 'default');

      expect(result).toEqual(tool);
      expect(store.tools.get('tool-a')).toEqual(tool);
      expect(mockToolService.getToolDetail).toHaveBeenCalledWith('tool-a', 'default');
    });

    it('失败时记录默认错误消息并抛出', async () => {
      mockToolService.getToolDetail.mockRejectedValue(null);

      const store = useToolStore();
      await expect(store.fetchToolDetail('tool-a')).rejects.toBeNull();

      expect(store.error).toBe('获取工具详情失败');
    });
  });

  describe('executeTool', () => {
    const executionResult: ToolExecuteResponse = {
      executionId: 'exec-1',
      toolName: 'tool-a',
      serverId: 'server-1',
      groupId: 'default',
      result: [{ type: 'text', text: 'ok' }],
      isError: false,
      executionTime: 12,
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    it('成功时保存当前执行结果并插入执行历史头部', async () => {
      mockToolService.executeTool.mockResolvedValue(executionResult);

      const store = useToolStore();
      store.executionHistory.push({
        executionId: 'exec-0',
        toolName: 'old-tool',
        serverId: 'server-1',
        groupId: 'default',
        arguments: {},
        result: [],
        isError: false,
        executionTime: 1,
        timestamp: '2023-01-01T00:00:00.000Z',
      });

      const request = { arguments: { key: 'value' } };
      const result = await store.executeTool('tool-a', request);

      expect(result).toEqual(executionResult);
      expect(store.currentExecution).toEqual(executionResult);
      expect(store.executionHistory).toHaveLength(2);
      expect(store.executionHistory[0].executionId).toBe('exec-1');
      expect(store.executionHistory[0].arguments).toEqual({ key: 'value' });
      expect(store.executionHistory[0].result).toEqual(executionResult.result);
      expect(store.loading).toBe(false);
    });

    it('请求期间处于加载状态', async () => {
      let resolveExec: (value: ToolExecuteResponse) => void;
      mockToolService.executeTool.mockImplementation(
        () => new Promise<ToolExecuteResponse>((resolve) => (resolveExec = resolve)),
      );

      const store = useToolStore();
      const pending = store.executeTool('tool-a', { arguments: {} });

      expect(store.loading).toBe(true);

      resolveExec(executionResult);
      await pending;
    });

    it('失败时记录默认错误消息并抛出', async () => {
      mockToolService.executeTool.mockRejectedValue(undefined);

      const store = useToolStore();
      await expect(store.executeTool('tool-a', { arguments: {} })).rejects.toBeUndefined();

      expect(store.error).toBe('工具执行失败');
      expect(store.currentExecution).toBeNull();
    });
  });

  describe('testTool', () => {
    const testResult: ToolTestResponse = {
      toolName: 'tool-a',
      serverId: 'server-1',
      groupId: 'default',
      serverStatus: 'connected',
      isAvailable: true,
      validation: { isValid: true, errors: [], warnings: [] },
      canExecute: true,
    };

    it('成功时保存测试结果', async () => {
      mockToolService.testTool.mockResolvedValue(testResult);

      const store = useToolStore();
      const result = await store.testTool('tool-a', { arguments: {} });

      expect(result).toEqual(testResult);
      expect(store.testResults.get('tool-a')).toEqual(testResult);
    });

    it('失败时记录默认错误消息并抛出', async () => {
      mockToolService.testTool.mockRejectedValue('bad');

      const store = useToolStore();
      await expect(store.testTool('tool-a', { arguments: {} })).rejects.toBe('bad');

      expect(store.error).toBe('工具测试失败');
    });
  });

  describe('fetchExecutionHistory', () => {
    it('成功时替换执行历史', async () => {
      const history = [
        {
          executionId: 'exec-1',
          toolName: 'tool-a',
          serverId: 'server-1',
          groupId: 'default',
          arguments: {},
          result: [],
          isError: false,
          executionTime: 5,
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      ];
      mockToolService.getToolHistory.mockResolvedValue({
        history,
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      });

      const store = useToolStore();
      const result = await store.fetchExecutionHistory({ limit: 20 });

      expect(result.history).toEqual(history);
      expect(mockToolService.getToolHistory).toHaveBeenCalledWith({ limit: 20 });
      expect(store.executionHistory).toEqual(history);
    });

    it('失败时记录默认错误消息并抛出', async () => {
      mockToolService.getToolHistory.mockRejectedValue('oops');

      const store = useToolStore();
      await expect(store.fetchExecutionHistory()).rejects.toBe('oops');

      expect(store.error).toBe('获取执行历史失败');
    });
  });

  describe('统计类接口', () => {
    it('fetchStats 成功时保存统计并透传参数', async () => {
      const stats: ToolStats = {
        overview: {
          totalExecutions: 10,
          successfulExecutions: 9,
          failedExecutions: 1,
          successRate: 90,
          averageExecutionTime: 100,
        },
        topTools: [],
      };
      mockToolService.getToolStats.mockResolvedValue(stats);

      const store = useToolStore();
      const result = await store.fetchStats('default', 'server-1');

      expect(result).toEqual(stats);
      expect(store.stats).toEqual(stats);
      expect(mockToolService.getToolStats).toHaveBeenCalledWith('default', 'server-1');
    });

    it('fetchStats 失败时记录默认错误消息并抛出', async () => {
      mockToolService.getToolStats.mockRejectedValue(0);

      const store = useToolStore();
      await expect(store.fetchStats()).rejects.toBe(0);

      expect(store.error).toBe('获取统计信息失败');
    });

    it('fetchMonitoring 成功时保存监控数据并透传参数', async () => {
      const monitoring = {
        overview: {
          totalTools: 1,
          availableTools: 1,
          unavailableTools: 0,
          totalServers: 1,
          connectedServers: 1,
          disconnectedServers: 0,
          availabilityRate: 100,
        },
        toolsByServer: {},
      } as ToolMonitoring;
      mockToolService.getToolMonitoring.mockResolvedValue(monitoring);

      const store = useToolStore();
      await store.fetchMonitoring('default');

      expect(store.monitoring).toEqual(monitoring);
      expect(mockToolService.getToolMonitoring).toHaveBeenCalledWith('default');
    });

    it('fetchMonitoring 失败时记录默认错误消息并抛出', async () => {
      mockToolService.getToolMonitoring.mockRejectedValue(false);

      const store = useToolStore();
      await expect(store.fetchMonitoring()).rejects.toBe(false);

      expect(store.error).toBe('获取监控信息失败');
    });

    it('fetchPerformance 成功时保存性能数据并透传参数', async () => {
      const performance = {
        timeRange: '24h',
        period: { startTime: '', endTime: '' },
        overview: {
          totalExecutions: 0,
          successfulExecutions: 0,
          failedExecutions: 0,
          successRate: 0,
          averageExecutionTime: 0,
        },
        percentiles: { p50: 0, p95: 0, p99: 0 },
        timeSeries: [],
      } as ToolPerformance;
      mockToolService.getToolPerformance.mockResolvedValue(performance);

      const store = useToolStore();
      await store.fetchPerformance('24h', 'default', 'server-1');

      expect(store.performance).toEqual(performance);
      expect(mockToolService.getToolPerformance).toHaveBeenCalledWith('24h', 'default', 'server-1');
    });

    it('fetchPerformance 失败时记录默认错误消息并抛出', async () => {
      mockToolService.getToolPerformance.mockRejectedValue(NaN);

      const store = useToolStore();
      await expect(store.fetchPerformance()).rejects.toBeNaN();

      expect(store.error).toBe('获取性能分析失败');
    });
  });

  describe('计算属性', () => {
    let store: ReturnType<typeof useToolStore>;

    beforeEach(() => {
      store = useToolStore();
      store.tools.clear();
      store.tools.set(
        'alpha',
        makeTool({ name: 'alpha', serverId: 'server-b', status: 'unavailable' }),
      );
      store.tools.set('beta', makeTool({ name: 'beta', serverId: 'server-a' }));
      store.tools.set(
        'gamma',
        makeTool({ name: 'gamma', serverId: 'server-a', description: '特殊描述' }),
      );
    });

    it('toolList 返回全部工具', () => {
      expect(store.toolList.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('availableTools / unavailableTools 按状态划分', () => {
      expect(store.availableTools.map((t) => t.name)).toEqual(['beta', 'gamma']);
      expect(store.unavailableTools.map((t) => t.name)).toEqual(['alpha']);
    });

    it('serverList 去重汇总服务器', () => {
      expect(store.serverList.toSorted()).toEqual(['server-a', 'server-b']);
    });

    it('按服务器过滤', () => {
      store.updateFilters({ serverId: 'server-b' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['alpha']);
    });

    it('按状态过滤', () => {
      store.updateFilters({ status: 'unavailable' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['alpha']);
    });

    it('status 为 all 时不过滤状态', () => {
      store.updateFilters({ status: 'all' });
      expect(store.filteredTools).toHaveLength(3);
    });

    it('按名称关键词搜索（大小写不敏感）', () => {
      store.updateFilters({ search: 'ALPH' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['alpha']);
    });

    it('按描述关键词搜索', () => {
      store.updateFilters({ search: '特殊' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['gamma']);
    });

    it('按服务器关键词搜索', () => {
      store.updateFilters({ search: 'SERVER-B' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['alpha']);
    });

    it('按名称升序 / 降序排序', () => {
      store.resetFilters();
      expect(store.filteredTools.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);

      store.updateFilters({ sortOrder: 'desc' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['gamma', 'beta', 'alpha']);
    });

    it('按服务器排序', () => {
      store.updateFilters({ sortBy: 'server', sortOrder: 'asc' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['beta', 'gamma', 'alpha']);
    });

    it('按状态排序', () => {
      store.updateFilters({ sortBy: 'status', sortOrder: 'asc' });
      expect(store.filteredTools.map((t) => t.status)).toEqual([
        'available',
        'available',
        'unavailable',
      ]);
    });

    it('未知排序字段回退到名称排序', () => {
      store.updateFilters({ sortBy: 'unknown' as ToolInfo['status'] });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('过滤条件可以叠加', () => {
      store.updateFilters({ serverId: 'server-a', search: '特殊' });
      expect(store.filteredTools.map((t) => t.name)).toEqual(['gamma']);
    });
  });

  describe('状态维护方法', () => {
    it('updateFilters 合并部分字段', () => {
      const store = useToolStore();
      store.updateFilters({ search: 'abc' });
      store.updateFilters({ status: 'unavailable' });

      expect(store.filters).toMatchObject({
        groupId: 'default',
        search: 'abc',
        status: 'unavailable',
        sortBy: 'name',
        sortOrder: 'asc',
      });
    });

    it('resetFilters 恢复默认值', () => {
      const store = useToolStore();
      store.updateFilters({
        search: 'abc',
        serverId: 'x',
        status: 'unavailable',
        sortBy: 'server',
        sortOrder: 'desc',
      });
      store.resetFilters();

      expect(store.filters).toEqual({
        groupId: 'default',
        status: 'all',
        sortBy: 'name',
        sortOrder: 'asc',
      });
    });

    it('clearCurrentExecution 清除当前执行结果', () => {
      const store = useToolStore();
      store.currentExecution = {
        executionId: 'e',
        toolName: 't',
        serverId: 's',
        groupId: 'g',
        result: [],
        isError: false,
        executionTime: 0,
        timestamp: '',
      };

      store.clearCurrentExecution();
      expect(store.currentExecution).toBeNull();
    });

    it('clearTestResults 清空测试结果', () => {
      const store = useToolStore();
      store.testResults.set('tool-a', {} as ToolTestResponse);

      store.clearTestResults();
      expect(store.testResults.size).toBe(0);
    });

    it('refresh 使用当前过滤条件重新拉取列表', async () => {
      mockToolService.getTools.mockResolvedValue(makeListResponse([]));

      const store = useToolStore();
      store.updateFilters({ search: 'abc' });
      await store.refresh();

      expect(mockToolService.getTools).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'abc' }),
      );
    });

    it('setError / clearError / setLoading 直接操作状态', () => {
      const store = useToolStore();

      store.setError('出错了');
      expect(store.error).toBe('出错了');

      store.clearError();
      expect(store.error).toBeNull();

      store.setLoading(true);
      expect(store.loading).toBe(true);
      store.setLoading(false);
      expect(store.loading).toBe(false);
    });
  });
});
