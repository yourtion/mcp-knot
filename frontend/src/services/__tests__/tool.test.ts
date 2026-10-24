import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as toolService from '../tool';
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
};

describe('ToolService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getTools 请求 /tools 并携带过滤参数', async () => {
    mocked.get.mockResolvedValue(ok({ tools: [] }));

    const params = { groupId: 'default', status: 'available' as const, search: 'x' };
    const result = await toolService.getTools(params);

    expect(result).toEqual({ tools: [] });
    expect(mocked.get).toHaveBeenCalledWith('/tools', { params });
  });

  it('getToolsByServer 请求 /tools/server/:serverId 并携带 groupId', async () => {
    mocked.get.mockResolvedValue(ok({ tools: [] }));

    await toolService.getToolsByServer('srv-1', 'default');

    expect(mocked.get).toHaveBeenCalledWith('/tools/server/srv-1', {
      params: { groupId: 'default' },
    });
  });

  it('getToolDetail 请求 /tools/:toolName', async () => {
    mocked.get.mockResolvedValue(ok({ name: 't' }));

    await toolService.getToolDetail('my-tool', 'default');

    expect(mocked.get).toHaveBeenCalledWith('/tools/my-tool', { params: { groupId: 'default' } });
  });

  it('executeTool POST /tools/:toolName/execute', async () => {
    mocked.post.mockResolvedValue(ok({ executionId: 'e1' }));
    const request = { arguments: { a: 1 } };

    const result = await toolService.executeTool('my-tool', request);

    expect(result).toEqual({ executionId: 'e1' });
    expect(mocked.post).toHaveBeenCalledWith('/tools/my-tool/execute', request);
  });

  it('testTool POST /tools/:toolName/test', async () => {
    mocked.post.mockResolvedValue(ok({ canExecute: true }));
    const request = { arguments: {} };

    await toolService.testTool('my-tool', request);

    expect(mocked.post).toHaveBeenCalledWith('/tools/my-tool/test', request);
  });

  it('getToolHistory 请求 /tools-admin/history 并携带参数', async () => {
    mocked.get.mockResolvedValue(ok({ history: [] }));

    const params = { limit: 10, offset: 5, toolName: 't' };
    await toolService.getToolHistory(params);

    expect(mocked.get).toHaveBeenCalledWith('/tools-admin/history', { params });
  });

  it('getExecutionDetail 请求 /tools/history/:executionId', async () => {
    mocked.get.mockResolvedValue(ok({ history: [] }));

    await toolService.getExecutionDetail('exec-9');

    expect(mocked.get).toHaveBeenCalledWith('/tools/history/exec-9');
  });

  it('getToolStats 请求 /tools-admin/stats 并携带分组与服务器', async () => {
    mocked.get.mockResolvedValue(ok({ overview: {} }));

    await toolService.getToolStats('default', 'srv-1');

    expect(mocked.get).toHaveBeenCalledWith('/tools-admin/stats', {
      params: { groupId: 'default', serverId: 'srv-1' },
    });
  });

  it('getToolMonitoring 请求 /tools-admin/monitoring', async () => {
    mocked.get.mockResolvedValue(ok({ overview: {} }));

    await toolService.getToolMonitoring('default');

    expect(mocked.get).toHaveBeenCalledWith('/tools-admin/monitoring', {
      params: { groupId: 'default' },
    });
  });

  it('getToolHealth 请求 /tools-admin/health', async () => {
    mocked.get.mockResolvedValue(ok({ totalTools: 0 }));

    await toolService.getToolHealth('default');

    expect(mocked.get).toHaveBeenCalledWith('/tools-admin/health', {
      params: { groupId: 'default' },
    });
  });

  it('getToolPerformance 请求 /tools-admin/performance 并携带全部参数', async () => {
    mocked.get.mockResolvedValue(ok({ timeRange: '24h' }));

    await toolService.getToolPerformance('24h', 'default', 'srv-1');

    expect(mocked.get).toHaveBeenCalledWith('/tools-admin/performance', {
      params: { timeRange: '24h', groupId: 'default', serverId: 'srv-1' },
    });
  });

  it('getToolErrors 请求 /tools-admin/errors 并携带参数', async () => {
    mocked.get.mockResolvedValue(ok({ errors: [] }));
    const params = { limit: 5, severity: 'error' };

    await toolService.getToolErrors(params);

    expect(mocked.get).toHaveBeenCalledWith('/tools-admin/errors', { params });
  });

  it('请求失败时向上传播错误', async () => {
    mocked.get.mockRejectedValue(new Error('服务器错误'));

    await expect(toolService.getTools()).rejects.toThrow('服务器错误');
    await expect(toolService.getToolDetail('t')).rejects.toThrow('服务器错误');
  });

  it('业务失败时抛出服务端错误消息', async () => {
    mocked.get.mockResolvedValue({
      data: { success: false, error: { message: '工具不存在' } },
    });

    await expect(toolService.getToolDetail('missing')).rejects.toThrow('工具不存在');
  });
});
