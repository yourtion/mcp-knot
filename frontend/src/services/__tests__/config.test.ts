import { beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '../config';
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
};

describe('ConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getCurrentConfig 请求 /config', async () => {
    mocked.get.mockResolvedValue(ok({ version: '1.0.0' }));

    const result = await configService.getCurrentConfig();

    expect(result).toEqual({ version: '1.0.0' });
    expect(mocked.get).toHaveBeenCalledWith('/config');
  });

  it('updateConfig PUT /config', async () => {
    mocked.put.mockResolvedValue(ok(null));
    const request = { configType: 'system' as const, config: { port: 3000 } };

    await configService.updateConfig(request);

    expect(mocked.put).toHaveBeenCalledWith('/config', request);
  });

  it('validateConfig POST /config/validate', async () => {
    mocked.post.mockResolvedValue(ok({ valid: true }));
    const request = { configType: 'mcp' as const, config: {} };

    const result = await configService.validateConfig(request);

    expect(result).toEqual({ valid: true });
    expect(mocked.post).toHaveBeenCalledWith('/config/validate', request);
  });

  it('getConfigHistory 拼接分页与类型参数', async () => {
    mocked.get.mockResolvedValue(ok({ history: [], total: 0 }));

    await configService.getConfigHistory(10, 5, 'system');

    expect(mocked.get).toHaveBeenCalledWith('/config/history?limit=10&offset=5&configType=system');
  });

  it('getConfigHistory 不带类型时不拼接 configType', async () => {
    mocked.get.mockResolvedValue(ok({ history: [], total: 0 }));

    await configService.getConfigHistory();

    expect(mocked.get).toHaveBeenCalledWith('/config/history?limit=50&offset=0');
  });

  it('createBackup POST /config/backup', async () => {
    mocked.post.mockResolvedValue(ok({ backupId: 'bk-1', message: 'ok' }));
    const request = { description: '升级前备份', includeTypes: ['system' as const] };

    const result = await configService.createBackup(request);

    expect(result).toEqual({ backupId: 'bk-1', message: 'ok' });
    expect(mocked.post).toHaveBeenCalledWith('/config/backup', request);
  });

  it('restoreFromBackup POST /config/restore', async () => {
    mocked.post.mockResolvedValue(ok(null));
    const request = { backupId: 'bk-1' };

    await configService.restoreFromBackup(request);

    expect(mocked.post).toHaveBeenCalledWith('/config/restore', request);
  });

  it('testConfig POST /config/test', async () => {
    mocked.post.mockResolvedValue(ok({ success: true }));
    const request = { configType: 'system' as const, config: {} };

    await configService.testConfig(request);

    expect(mocked.post).toHaveBeenCalledWith('/config/test', request);
  });

  it('previewConfigChanges POST /config/preview', async () => {
    mocked.post.mockResolvedValue(ok({ changes: [] }));
    const request = { configType: 'system' as const, config: {} };

    await configService.previewConfigChanges(request);

    expect(mocked.post).toHaveBeenCalledWith('/config/preview', request);
  });

  it('getBackupList 拼接分页参数', async () => {
    mocked.get.mockResolvedValue(ok({ backups: [], total: 0 }));

    await configService.getBackupList(20, 40);

    expect(mocked.get).toHaveBeenCalledWith('/config/backups?limit=20&offset=40');
  });

  it('getBackupList 默认分页为 50/0', async () => {
    mocked.get.mockResolvedValue(ok({ backups: [], total: 0 }));

    await configService.getBackupList();

    expect(mocked.get).toHaveBeenCalledWith('/config/backups?limit=50&offset=0');
  });

  it('请求失败时向上传播错误', async () => {
    mocked.get.mockRejectedValue(new Error('配置读取失败'));

    await expect(configService.getCurrentConfig()).rejects.toThrow('配置读取失败');
  });
});
