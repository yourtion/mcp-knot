import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as debugService from './debug';
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
const mocked = { get: api.get as unknown as Mock, post: api.post as unknown as Mock };

describe('Debug Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getMcpMessages 拼接全部过滤参数', async () => {
    mocked.get.mockResolvedValue(ok({ messages: [] }));

    await debugService.getMcpMessages(10, 'srv-1', 'request');

    expect(mocked.get).toHaveBeenCalledWith(
      '/debug/mcp-messages?limit=10&serverId=srv-1&type=request',
    );
  });

  it('getMcpMessages 省略未提供的过滤参数', async () => {
    mocked.get.mockResolvedValue(ok({ messages: [] }));

    await debugService.getMcpMessages();

    expect(mocked.get).toHaveBeenCalledWith('/debug/mcp-messages?');
  });

  it('testTool POST /debug/tool-test', async () => {
    mocked.post.mockResolvedValue(ok({ canExecute: true }));
    const request = { arguments: { a: 1 } };

    const result = await debugService.testTool(request);

    expect(result).toEqual({ canExecute: true });
    expect(mocked.post).toHaveBeenCalledWith('/debug/tool-test', request);
  });

  it('getPerformanceStats 请求 /debug/performance-stats', async () => {
    mocked.get.mockResolvedValue(ok({ overview: {} }));

    await debugService.getPerformanceStats();

    expect(mocked.get).toHaveBeenCalledWith('/debug/performance-stats');
  });

  it('getErrorAnalysis 请求 /debug/error-analysis', async () => {
    mocked.get.mockResolvedValue(ok({ summary: {} }));

    await debugService.getErrorAnalysis();

    expect(mocked.get).toHaveBeenCalledWith('/debug/error-analysis');
  });

  it('请求失败时向上传播错误', async () => {
    mocked.get.mockRejectedValue(new Error('调试接口不可用'));

    await expect(debugService.getErrorAnalysis()).rejects.toThrow('调试接口不可用');
  });
});
