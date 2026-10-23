import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as serverService from '../server';
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
  put: api.put as unknown as Mock,
  delete: api.delete as unknown as Mock,
};

describe('ServerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getServers 请求 /servers', async () => {
    mocked.get.mockResolvedValue(ok({ servers: [] }));

    const result = await serverService.getServers();

    expect(result).toEqual({ servers: [] });
    expect(mocked.get).toHaveBeenCalledWith('/servers');
  });

  it('getServer 请求 /servers/:id', async () => {
    mocked.get.mockResolvedValue(ok({ id: 's1' }));

    await serverService.getServer('s1');

    expect(mocked.get).toHaveBeenCalledWith('/servers/s1');
  });

  it('createServer POST /servers', async () => {
    mocked.post.mockResolvedValue(ok({ id: 's1', message: 'ok' }));
    const data = { id: 's1', config: { type: 'stdio' as const, command: 'node', enabled: true } };

    await serverService.createServer(data);

    expect(mocked.post).toHaveBeenCalledWith('/servers', data);
  });

  it('updateServer PUT /servers/:id', async () => {
    mocked.put.mockResolvedValue(ok({ id: 's1', message: 'ok' }));
    const data = { config: { type: 'stdio' as const, command: 'node', enabled: false } };

    await serverService.updateServer('s1', data);

    expect(mocked.put).toHaveBeenCalledWith('/servers/s1', data);
  });

  it('deleteServer DELETE /servers/:id', async () => {
    mocked.delete.mockResolvedValue(ok({ id: 's1', message: 'ok' }));

    await serverService.deleteServer('s1');

    expect(mocked.delete).toHaveBeenCalledWith('/servers/s1');
  });

  it('getServerStatus 请求 /servers/:id/status', async () => {
    mocked.get.mockResolvedValue(ok({ status: 'connected' }));

    await serverService.getServerStatus('s1');

    expect(mocked.get).toHaveBeenCalledWith('/servers/s1/status');
  });

  it('connectServer POST /servers/:id/connect', async () => {
    mocked.post.mockResolvedValue(ok({ id: 's1', message: 'ok' }));

    await serverService.connectServer('s1');

    expect(mocked.post).toHaveBeenCalledWith('/servers/s1/connect');
  });

  it('disconnectServer POST /servers/:id/disconnect', async () => {
    mocked.post.mockResolvedValue(ok({ id: 's1', message: 'ok' }));

    await serverService.disconnectServer('s1');

    expect(mocked.post).toHaveBeenCalledWith('/servers/s1/disconnect');
  });

  it('testServer POST /servers/test', async () => {
    mocked.post.mockResolvedValue(ok({ success: true }));
    const config = { type: 'sse' as const, url: 'http://x', enabled: true };

    await serverService.testServer(config);

    expect(mocked.post).toHaveBeenCalledWith('/servers/test', config);
  });

  it('validateServer POST /servers/validate', async () => {
    mocked.post.mockResolvedValue(ok({ isValid: true }));
    const config = { type: 'streaming' as const, url: 'http://x', enabled: true };

    await serverService.validateServer(config);

    expect(mocked.post).toHaveBeenCalledWith('/servers/validate', config);
  });

  it('请求失败时向上传播错误', async () => {
    mocked.get.mockRejectedValue(new Error('服务器不存在'));

    await expect(serverService.getServer('missing')).rejects.toThrow('服务器不存在');
  });
});
