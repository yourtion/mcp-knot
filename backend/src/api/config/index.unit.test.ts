import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  getCurrentConfig: vi.fn(),
  getLastUpdatedTime: vi.fn(),
  getConfigVersion: vi.fn(),
  validateConfig: vi.fn(),
  updateConfig: vi.fn(),
  analyzeConfigImpact: vi.fn(),
  getConfigHistory: vi.fn(),
  getConfigHistoryCount: vi.fn(),
  createBackup: vi.fn(),
  restoreFromBackup: vi.fn(),
  testConfig: vi.fn(),
  previewConfigChanges: vi.fn(),
  getBackupList: vi.fn(),
  getBackupCount: vi.fn(),
}));

vi.mock('../../services/config_service.js', () => ({
  ConfigService: class {
    constructor() {
      return service;
    }
  },
}));

import { configApi } from './index.js';

describe('Config API', () => {
  let app: Hono;
  const payload = { configType: 'system', config: { server: { port: 3001 } } };

  beforeEach(() => {
    for (const method of Object.values(service)) method.mockReset();
    service.validateConfig.mockResolvedValue({ valid: true, errors: [], warnings: [] });
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'config-request');
      c.set('auth', { user: { username: 'alice' } });
      await next();
    });
    app.route('/api/config', configApi);
  });

  function send(path: string, body: unknown, method = 'POST') {
    return app.request(`/api/config${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('返回真实服务配置并将 mcps 映射为公开的 mcp 字段', async () => {
    const config = {
      system: { server: { port: 8181 } },
      mcps: { servers: { local: { command: 'node' } } },
      groups: { default: { name: 'Default' } },
    };
    service.getCurrentConfig.mockResolvedValue(config);
    service.getLastUpdatedTime.mockResolvedValue('2026-01-01T00:00:00.000Z');
    service.getConfigVersion.mockResolvedValue('version-1');

    const response = await app.request('/api/config');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      requestId: 'config-request',
      data: {
        system: config.system,
        mcp: config.mcps,
        groups: config.groups,
        lastUpdated: '2026-01-01T00:00:00.000Z',
        version: 'version-1',
      },
    });
  });

  it('验证通过后更新配置并保留描述和操作者', async () => {
    const response = await send('', { ...payload, description: 'change port' }, 'PUT');

    expect(response.status).toBe(200);
    expect(service.validateConfig).toHaveBeenCalledWith('system', payload.config);
    expect(service.updateConfig).toHaveBeenCalledWith(
      'system',
      payload.config,
      'change port',
      'alice',
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { message: '配置更新成功' },
    });
  });

  it('未认证上下文更新配置时操作者为 undefined', async () => {
    const bare = new Hono();
    bare.route('/api/config', configApi);

    const response = await bare.request('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configType: 'mcp', config: {} }),
    });

    expect(response.status).toBe(200);
    expect(service.updateConfig).toHaveBeenCalledWith('mcp', {}, undefined, undefined);
  });

  it('更新配置服务失败时返回 500', async () => {
    service.updateConfig.mockRejectedValue(new Error('写入失败'));

    const response = await send('', payload, 'PUT');

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, requestId: 'config-request' });
  });

  it('配置验证失败时返回 400 且不写配置', async () => {
    const errors = [{ path: 'server.port', message: 'port is invalid', code: 'INVALID_PORT' }];
    service.validateConfig.mockResolvedValue({ valid: false, errors, warnings: [] });

    const response = await send('', payload, 'PUT');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'CONFIG_VALIDATION_ERROR', message: '配置验证失败', details: errors },
      requestId: 'config-request',
    });
    expect(service.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    { configType: 'unknown', config: {} },
    { configType: 'system' },
    { configType: 'system', config: null },
  ])('请求 schema 拒绝非法更新 %j', async (body) => {
    expect((await send('', body, 'PUT')).status).toBe(400);
    expect(service.validateConfig).not.toHaveBeenCalled();
    expect(service.updateConfig).not.toHaveBeenCalled();
  });

  it('验证接口保留错误、警告和影响分析', async () => {
    const validation = { valid: false, errors: ['bad config'], warnings: ['restart needed'] };
    const impact = { affectedServices: ['api'], requiresRestart: true };
    service.validateConfig.mockResolvedValue(validation);
    service.analyzeConfigImpact.mockResolvedValue(impact);

    const response = await send('/validate', { configType: 'groups', config: payload.config });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ ...validation, impact });
    expect(service.analyzeConfigImpact).toHaveBeenCalledWith('groups', payload.config);
  });

  it('验证接口服务失败时返回 500', async () => {
    service.validateConfig.mockRejectedValue(new Error('校验服务崩溃'));

    const response = await send('/validate', payload);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it.each([
    { query: '', limit: 50, offset: 0, type: undefined },
    { query: '?limit=10&offset=20&configType=mcp', limit: 10, offset: 20, type: 'mcp' },
  ])('历史记录保留分页与配置类型 $query', async ({ query, limit, offset, type }) => {
    const history = [{ id: 'history-1' }];
    service.getConfigHistory.mockResolvedValue(history);
    service.getConfigHistoryCount.mockResolvedValue(41);

    const response = await app.request(`/api/config/history${query}`);

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ history, total: 41, limit, offset });
    expect(service.getConfigHistory).toHaveBeenCalledWith(limit, offset, type);
    expect(service.getConfigHistoryCount).toHaveBeenCalledWith(type);
  });

  it('历史记录查询失败时返回 500', async () => {
    service.getConfigHistory.mockRejectedValue(new Error('历史存储不可用'));

    const response = await app.request('/api/config/history');

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('创建备份时传递范围、描述和操作者', async () => {
    service.createBackup.mockResolvedValue('backup-1');

    const response = await send('/backup', {
      description: 'manual',
      includeTypes: ['mcp', 'groups'],
    });

    expect(response.status).toBe(200);
    expect(service.createBackup).toHaveBeenCalledWith('manual', ['mcp', 'groups'], 'alice');
    expect(await response.json()).toMatchObject({
      data: { backupId: 'backup-1', message: '配置备份创建成功' },
    });
  });

  it('备份创建失败时返回 500', async () => {
    service.createBackup.mockRejectedValue(new Error('备份失败'));

    const response = await send('/backup', {});

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('恢复备份时传递备份 ID 和配置范围', async () => {
    const response = await send('/restore', {
      backupId: 'backup-1',
      configTypes: ['system', 'mcp', 'groups'],
    });

    expect(response.status).toBe(200);
    expect(service.restoreFromBackup).toHaveBeenCalledWith('backup-1', ['system', 'mcp', 'groups']);
    expect((await response.json()).data.message).toBe('配置恢复成功');
  });

  it('恢复备份失败时返回 500', async () => {
    service.restoreFromBackup.mockRejectedValue(new Error('备份损坏'));

    const response = await send('/restore', { backupId: 'broken' });

    expect(response.status).toBe(500);
  });

  it('配置测试接口保留测试失败结果', async () => {
    const result = { success: false, tests: [{ name: 'connection', status: 'failed' }] };
    service.testConfig.mockResolvedValue(result);

    const response = await send('/test', { configType: 'groups', config: payload.config });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(result);
    expect(service.testConfig).toHaveBeenCalledWith('groups', payload.config);
  });

  it('配置测试接口失败时返回 500', async () => {
    service.testConfig.mockRejectedValue(new Error('测试超时'));

    const response = await send('/test', payload);

    expect(response.status).toBe(500);
  });

  it('预览接口返回实际配置差异', async () => {
    const preview = { changes: [{ path: 'server.port', oldValue: 8181, newValue: 3001 }] };
    service.previewConfigChanges.mockResolvedValue(preview);

    const response = await send('/preview', { configType: 'mcp', config: payload.config });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(preview);
    expect(service.previewConfigChanges).toHaveBeenCalledWith('mcp', payload.config);
  });

  it('预览接口失败时返回 500', async () => {
    service.previewConfigChanges.mockRejectedValue(new Error('diff 失败'));

    const response = await send('/preview', payload);

    expect(response.status).toBe(500);
  });

  it('备份列表保留分页和总数', async () => {
    service.getBackupList.mockResolvedValue([{ id: 'backup-1' }]);
    service.getBackupCount.mockResolvedValue(12);

    const response = await app.request('/api/config/backups?limit=5&offset=10');

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      backups: [{ id: 'backup-1' }],
      total: 12,
      limit: 5,
      offset: 10,
    });
    expect(service.getBackupList).toHaveBeenCalledWith(5, 10);
  });

  it('备份列表查询失败时返回 500', async () => {
    service.getBackupList.mockRejectedValue(new Error('存储不可用'));

    const response = await app.request('/api/config/backups');

    expect(response.status).toBe(500);
  });

  it('服务读取失败时返回包含 requestId 的错误响应', async () => {
    service.getCurrentConfig.mockRejectedValue(new Error('storage unavailable'));

    const response = await app.request('/api/config');

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, requestId: 'config-request' });
  });
});
