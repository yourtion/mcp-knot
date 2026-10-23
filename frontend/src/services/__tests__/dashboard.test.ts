import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dashboardService } from '../dashboard';
import api from '@/services/api';

import type { Mock } from 'vitest';

vi.mock('@/services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  handleApiResponse: vi.fn((response: unknown) => {
    const body = (
      response as {
        data: { success: boolean; data?: unknown; error?: { message?: string } };
      }
    ).data;
    if (body.success && body.data !== undefined) return body.data;
    throw new Error(body.error?.message || '请求失败');
  }),
}));

const ok = (data: unknown) => ({ data: { success: true, data } });
const mocked = {
  get: api.get as unknown as Mock,
  post: api.post as unknown as Mock,
  delete: api.delete as unknown as Mock,
};

describe('DashboardService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getDashboardStats 请求 /dashboard/stats', async () => {
    mocked.get.mockResolvedValue(ok({ overview: {} }));

    const result = await dashboardService.getDashboardStats();

    expect(result).toEqual({ overview: {} });
    expect(mocked.get).toHaveBeenCalledWith('/dashboard/stats');
  });

  it('getSystemHealth 请求 /dashboard/health', async () => {
    mocked.get.mockResolvedValue(ok({ status: 'healthy' }));

    await dashboardService.getSystemHealth();

    expect(mocked.get).toHaveBeenCalledWith('/dashboard/health');
  });

  it('getDetailedHealth 请求 /dashboard/health-detailed', async () => {
    mocked.get.mockResolvedValue(ok({ status: 'healthy', additionalChecks: {} }));

    await dashboardService.getDetailedHealth();

    expect(mocked.get).toHaveBeenCalledWith('/dashboard/health-detailed');
  });

  it('queryLogs 拼接全部查询参数', async () => {
    mocked.get.mockResolvedValue(ok({ logs: [], total: 0 }));

    await dashboardService.queryLogs({
      level: 'error',
      category: 'api',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
      limit: 10,
      offset: 20,
      search: 'keyword',
    });

    expect(mocked.get).toHaveBeenCalledWith(
      '/dashboard/logs?level=error&category=api&startTime=2024-01-01&endTime=2024-01-02&limit=10&offset=20&search=keyword',
    );
  });

  it('queryLogs 仅拼接存在的查询参数', async () => {
    mocked.get.mockResolvedValue(ok({ logs: [], total: 0 }));

    await dashboardService.queryLogs({ level: 'warn' });

    expect(mocked.get).toHaveBeenCalledWith('/dashboard/logs?level=warn');
  });

  it('queryLogs 空查询时不带参数后缀', async () => {
    mocked.get.mockResolvedValue(ok({ logs: [], total: 0 }));

    await dashboardService.queryLogs({});

    expect(mocked.get).toHaveBeenCalledWith('/dashboard/logs?');
  });

  it('getRecentActivities 默认 limit 为 50，可自定义', async () => {
    mocked.get.mockResolvedValue(ok({ activities: [], total: 0 }));

    await dashboardService.getRecentActivities();
    expect(mocked.get).toHaveBeenCalledWith('/dashboard/activities?limit=50');

    await dashboardService.getRecentActivities(5);
    expect(mocked.get).toHaveBeenCalledWith('/dashboard/activities?limit=5');
  });

  it('getPerformanceStats 请求 /dashboard/performance', async () => {
    mocked.get.mockResolvedValue(ok({ totalRequests: 1 }));

    await dashboardService.getPerformanceStats();

    expect(mocked.get).toHaveBeenCalledWith('/dashboard/performance');
  });

  it('getSystemInfo 请求 /dashboard/system-info', async () => {
    mocked.get.mockResolvedValue(ok({ version: '1' }));

    await dashboardService.getSystemInfo();

    expect(mocked.get).toHaveBeenCalledWith('/dashboard/system-info');
  });

  it('getSSEStats 请求 /dashboard/sse-stats', async () => {
    mocked.get.mockResolvedValue(ok({ connectedClients: 0 }));

    await dashboardService.getSSEStats();

    expect(mocked.get).toHaveBeenCalledWith('/dashboard/sse-stats');
  });

  it('clearLogs 删除 /dashboard/logs', async () => {
    mocked.delete.mockResolvedValue(ok({ message: '已清理' }));

    const result = await dashboardService.clearLogs();

    expect(result).toEqual({ message: '已清理' });
    expect(mocked.delete).toHaveBeenCalledWith('/dashboard/logs');
  });

  it('sendTestAlert 默认分类为 test，可自定义', async () => {
    mocked.post.mockResolvedValue(ok({ message: 'ok' }));

    await dashboardService.sendTestAlert('warning', '磁盘告警');
    expect(mocked.post).toHaveBeenCalledWith('/dashboard/test-alert', {
      severity: 'warning',
      message: '磁盘告警',
      category: 'test',
    });

    await dashboardService.sendTestAlert('error', '严重告警', 'custom');
    expect(mocked.post).toHaveBeenCalledWith('/dashboard/test-alert', {
      severity: 'error',
      message: '严重告警',
      category: 'custom',
    });
  });

  it('sendTestToolExecution 透传事件数据', async () => {
    mocked.post.mockResolvedValue(ok({ message: 'ok' }));
    const data = { toolName: 't', serverId: 's', success: false, executionTime: 3 };

    await dashboardService.sendTestToolExecution(data);

    expect(mocked.post).toHaveBeenCalledWith('/dashboard/test-tool-execution', data);
  });

  it('sendTestServerStatus 透传事件数据', async () => {
    mocked.post.mockResolvedValue(ok({ message: 'ok' }));
    const data = { serverId: 's', status: 'error', error: 'boom' };

    await dashboardService.sendTestServerStatus(data);

    expect(mocked.post).toHaveBeenCalledWith('/dashboard/test-server-status', data);
  });

  it('addLog 透传日志数据', async () => {
    mocked.post.mockResolvedValue(ok({ message: 'ok' }));
    const data = { level: 'info' as const, message: 'm', category: 'c' };

    await dashboardService.addLog(data);

    expect(mocked.post).toHaveBeenCalledWith('/dashboard/add-log', data);
  });

  it('请求失败时向上传播错误', async () => {
    mocked.get.mockRejectedValue(new Error('网络中断'));

    await expect(dashboardService.getDashboardStats()).rejects.toThrow('网络中断');
  });
});
