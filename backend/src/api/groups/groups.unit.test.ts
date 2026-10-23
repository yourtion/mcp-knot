import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  listGroups: vi.fn(),
  getGroupDetail: vi.fn(),
  getGroupHealth: vi.fn(),
  getGroupServers: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
}));

vi.mock('./group-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./group-service.js')>()),
  ...service,
}));

const toolAccessService = vi.hoisted(() => ({
  getGroupTools: vi.fn(),
  configureGroupTools: vi.fn(),
  getGroupAvailableTools: vi.fn(),
  validateToolAccess: vi.fn(),
}));

vi.mock('./tool-access-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-access-service.js')>()),
  ...toolAccessService,
}));

const validationKeyService = vi.hoisted(() => ({
  createValidationKey: vi.fn(),
  getValidationKey: vi.fn(),
  validateKey: vi.fn(),
  deleteValidationKey: vi.fn(),
  generateGroupValidationKey: vi.fn(),
}));

vi.mock('./validation-key-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./validation-key-service.js')>()),
  ...validationKeyService,
}));

// shutdownGroupsApi 动态 import service-registry 并关闭返回的 manager
const serviceRegistry = vi.hoisted(() => ({
  shutdownCoreServiceManager: vi.fn(),
}));

vi.mock('../../services/service-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/service-registry.js')>()),
  ...serviceRegistry,
}));

import { GroupServiceError } from './group-service.js';
import { groupsApi } from './index.js';
import { ToolAccessServiceError } from './tool-access-service.js';
import { ValidationKeyServiceError } from './validation-key-service.js';

describe('Groups API', () => {
  let app: Hono;

  beforeEach(() => {
    for (const method of Object.values(service)) method.mockReset();
    for (const method of Object.values(toolAccessService)) method.mockReset();
    for (const method of Object.values(validationKeyService)) method.mockReset();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'groups-request');
      await next();
    });
    app.route('/api/groups', groupsApi);
  });

  function request(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`/api/groups${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('保持既有的分组 API 路由契约', () => {
    const routes = groupsApi.routes
      .filter((route) => route.method !== 'ALL')
      .map((route) => `${route.method} ${route.path}`)
      .toSorted();
    expect(routes).toEqual(
      [
        'GET /',
        'POST /',
        'GET /:groupId',
        'PUT /:groupId',
        'DELETE /:groupId',
        'GET /:groupId/health',
        'GET /:groupId/servers',
        'GET /:groupId/tools',
        'POST /:groupId/tools',
        'GET /:groupId/available-tools',
        'POST /:groupId/validate-tool-access',
        'POST /:groupId/validation-key',
        'GET /:groupId/validation-key',
        'POST /:groupId/validate-key',
        'DELETE /:groupId/validation-key',
        'POST /:groupId/generate-validation-key',
      ].toSorted(),
    );
  });

  it('返回服务提供的组列表', async () => {
    const data = { groups: [{ id: 'team', name: 'Team' }], total: 1 };
    service.listGroups.mockResolvedValue(data);

    const response = await app.request('/api/groups');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data,
      requestId: 'groups-request',
    });
    expect(service.listGroups).toHaveBeenCalledOnce();
  });

  it('详情接口传递解码后的组 ID', async () => {
    const data = { id: 'team space', name: 'Team' };
    service.getGroupDetail.mockResolvedValue(data);

    const response = await app.request('/api/groups/team%20space');

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(data);
    expect(service.getGroupDetail).toHaveBeenCalledWith('team space');
  });

  it('健康检查保留服务提供的降级状态码', async () => {
    const data = { status: 'unhealthy', servers: [] };
    service.getGroupHealth.mockResolvedValue({ data, status: 503 });

    const response = await app.request('/api/groups/team/health');

    expect(response.status).toBe(503);
    expect((await response.json()).data).toEqual(data);
    expect(service.getGroupHealth).toHaveBeenCalledWith('team');
  });

  it('服务器接口返回对应组的服务器', async () => {
    const data = { servers: [{ id: 'local', status: 'connected' }] };
    service.getGroupServers.mockResolvedValue(data);

    const response = await app.request('/api/groups/team/servers');

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(data);
    expect(service.getGroupServers).toHaveBeenCalledWith('team');
  });

  it('创建和更新请求保留客户端配置', async () => {
    const input = { id: 'team', name: 'Team', servers: ['local'], tools: ['search'] };
    service.createGroup.mockResolvedValue({ group: input });
    service.updateGroup.mockResolvedValue({ group: { ...input, name: 'Renamed' } });
    const request = (method: string, body: unknown) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const created = await app.request('/api/groups', request('POST', input));
    const updated = await app.request('/api/groups/team', request('PUT', { name: 'Renamed' }));

    expect(created.status).toBe(200);
    expect((await created.json()).data.group).toEqual(input);
    expect(service.createGroup).toHaveBeenCalledWith(input);
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.group.name).toBe('Renamed');
    expect(service.updateGroup).toHaveBeenCalledWith('team', { name: 'Renamed' });
  });

  it('删除请求传递组 ID 并返回删除结果', async () => {
    service.deleteGroup.mockResolvedValue({ deleted: true });

    const response = await app.request('/api/groups/team', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ deleted: true });
    expect(service.deleteGroup).toHaveBeenCalledWith('team');
  });

  it('不存在的组返回 404 并保留业务错误码', async () => {
    service.getGroupDetail.mockRejectedValue(
      new GroupServiceError('GROUP_NOT_FOUND', '组不存在', 404),
    );

    const response = await app.request('/api/groups/missing');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'GROUP_NOT_FOUND', message: '组不存在' },
      requestId: 'groups-request',
    });
  });

  it('创建校验失败时保留详细错误', async () => {
    service.createGroup.mockRejectedValue(
      new GroupServiceError('VALIDATION_ERROR', '组配置无效', 400, ['名称不能为空']),
    );

    const response = await app.request('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({
      code: 'VALIDATION_ERROR',
      message: '组配置无效',
      details: ['名称不能为空'],
    });
  });

  it('默认组删除限制保留 403', async () => {
    service.deleteGroup.mockRejectedValue(
      new GroupServiceError('CANNOT_DELETE_DEFAULT_GROUP', '不能删除默认组', 403),
    );

    const response = await app.request('/api/groups/default', { method: 'DELETE' });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CANNOT_DELETE_DEFAULT_GROUP');
  });

  it('未预期的服务异常返回 500', async () => {
    service.listGroups.mockRejectedValue(new Error('service unavailable'));

    const response = await app.request('/api/groups');

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, requestId: 'groups-request' });
  });

  describe('工具访问端点', () => {
    it('GET /:groupId/tools 返回组工具列表', async () => {
      const data = { groupId: 'team', tools: [{ name: 'echo' }], totalTools: 1 };
      toolAccessService.getGroupTools.mockResolvedValue(data);

      const response = await request('GET', '/team/tools');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, data });
      expect(toolAccessService.getGroupTools).toHaveBeenCalledWith('team');
    });

    it('GET /:groupId/tools 服务错误映射状态码', async () => {
      toolAccessService.getGroupTools.mockRejectedValue(
        new ToolAccessServiceError('GROUP_NOT_FOUND', "组 'team' 不存在", 404),
      );

      const response = await request('GET', '/team/tools');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'GROUP_NOT_FOUND', message: "组 'team' 不存在" },
        requestId: 'groups-request',
      });
    });

    it('POST /:groupId/tools 保存工具过滤配置', async () => {
      const body = { tools: ['echo', 'search'] };
      const data = { groupId: 'team', toolCount: 2, filterMode: 'whitelist' };
      toolAccessService.configureGroupTools.mockResolvedValue(data);

      const response = await request('POST', '/team/tools', body);

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual(data);
      expect(toolAccessService.configureGroupTools).toHaveBeenCalledWith('team', body);
    });

    it('POST /:groupId/tools 校验失败返回 400', async () => {
      toolAccessService.configureGroupTools.mockRejectedValue(
        new ToolAccessServiceError('VALIDATION_ERROR', '工具列表必须是数组', 400),
      );

      const response = await request('POST', '/team/tools', { tools: 'x' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR', message: '工具列表必须是数组' },
      });
    });

    it('GET /:groupId/available-tools 返回可用工具', async () => {
      const data = { groupId: 'team', totalTools: 3, filteredTools: 1 };
      toolAccessService.getGroupAvailableTools.mockResolvedValue(data);

      const response = await request('GET', '/team/available-tools');

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual(data);
    });

    it('POST /:groupId/validate-tool-access 返回验证结果', async () => {
      const data = { hasAccess: true, reason: 'ACCESS_GRANTED' };
      toolAccessService.validateToolAccess.mockResolvedValue(data);

      const response = await request('POST', '/team/validate-tool-access', {
        toolName: 'echo',
      });

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual(data);
      expect(toolAccessService.validateToolAccess).toHaveBeenCalledWith('team', 'echo');
    });

    it('POST /:groupId/validate-tool-access 参数错误返回 400', async () => {
      toolAccessService.validateToolAccess.mockRejectedValue(
        new ToolAccessServiceError('VALIDATION_ERROR', '工具名称不能为空', 400),
      );

      const response = await request('POST', '/team/validate-tool-access', {});

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    });

    it('工具访问端点未预期异常返回 500', async () => {
      toolAccessService.getGroupAvailableTools.mockRejectedValue(new Error('boom'));

      const response = await request('GET', '/team/available-tools');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('验证密钥端点', () => {
    it('POST /:groupId/validation-key 设置密钥', async () => {
      const data = { groupId: 'team', validation: { enabled: true, hasKey: true } };
      validationKeyService.createValidationKey.mockResolvedValue(data);

      const response = await request('POST', '/team/validation-key', {
        validationKey: 'abcd1234',
      });

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual(data);
      expect(validationKeyService.createValidationKey).toHaveBeenCalledWith('team', {
        validationKey: 'abcd1234',
      });
    });

    it('GET /:groupId/validation-key 返回密钥状态', async () => {
      const data = { groupId: 'team', validation: { enabled: false, hasKey: false } };
      validationKeyService.getValidationKey.mockResolvedValue(data);

      const response = await request('GET', '/team/validation-key');

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual(data);
    });

    it.each([
      ['createValidationKey', 'POST', '/team/validation-key', { validationKey: '' }],
      ['getValidationKey', 'GET', '/team/validation-key', undefined],
      ['validateKey', 'POST', '/team/validate-key', { validationKey: 'x' }],
      ['deleteValidationKey', 'DELETE', '/team/validation-key', undefined],
      ['generateGroupValidationKey', 'POST', '/team/generate-validation-key', undefined],
    ])('%s 抛 ValidationKeyServiceError 时映射状态码', async (method, httpMethod, path, body) => {
      const fn = validationKeyService[method as keyof typeof validationKeyService] as ReturnType<
        typeof vi.fn
      >;
      fn.mockRejectedValue(
        new ValidationKeyServiceError('INVALID_VALIDATION_KEY', '密钥长度至少为8个字符', 400),
      );

      const response = await request(httpMethod, path, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'INVALID_VALIDATION_KEY', message: '密钥长度至少为8个字符' },
        requestId: 'groups-request',
      });
    });

    it('验证密钥端点未预期异常返回 500', async () => {
      validationKeyService.validateKey.mockRejectedValue(new Error('boom'));

      const response = await request('POST', '/team/validate-key', { validationKey: 'x' });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
    });
  });

  describe('未预期异常兜底（非服务层错误一律 500）', () => {
    it.each([
      ['GET /:groupId', 'GET', '/team', undefined, service.getGroupDetail],
      ['GET /:groupId/health', 'GET', '/team/health', undefined, service.getGroupHealth],
      ['GET /:groupId/servers', 'GET', '/team/servers', undefined, service.getGroupServers],
      ['POST /', 'POST', '', { id: 'team' }, service.createGroup],
      ['PUT /:groupId', 'PUT', '/team', { name: 'x' }, service.updateGroup],
      ['DELETE /:groupId', 'DELETE', '/team', undefined, service.deleteGroup],
      ['GET /:groupId/tools', 'GET', '/team/tools', undefined, toolAccessService.getGroupTools],
      [
        'POST /:groupId/tools',
        'POST',
        '/team/tools',
        { tools: ['echo'] },
        toolAccessService.configureGroupTools,
      ],
      [
        'POST /:groupId/validate-tool-access',
        'POST',
        '/team/validate-tool-access',
        { toolName: 'echo' },
        toolAccessService.validateToolAccess,
      ],
    ])('%s 抛非服务层错误时返回 500', async (_name, method, path, body, fn) => {
      (fn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unexpected boom'));

      const response = await request(method, path, body);

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false, requestId: 'groups-request' });
    });

    it('POST / 携带非法 JSON 请求体时返回 500（body 解析错误走兜底分支）', async () => {
      const response = await app.request('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false });
      expect(service.createGroup).not.toHaveBeenCalled();
    });
  });

  describe('health / servers / update 的服务层错误映射', () => {
    it('健康检查抛 GroupServiceError 时映射服务状态码', async () => {
      service.getGroupHealth.mockRejectedValue(
        new GroupServiceError('GROUP_NOT_FOUND', "组 'team' 不存在", 404),
      );

      const response = await request('GET', '/team/health');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'GROUP_NOT_FOUND', message: "组 'team' 不存在" },
        requestId: 'groups-request',
      });
    });

    it('服务器列表抛 GroupServiceError 时映射服务状态码（含 details 透传）', async () => {
      service.getGroupServers.mockRejectedValue(
        new GroupServiceError('VALIDATION_ERROR', '组配置无效', 400, ['servers 不能为空']),
      );

      const response = await request('GET', '/team/servers');

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '组配置无效',
          details: ['servers 不能为空'],
        },
        requestId: 'groups-request',
      });
    });

    it('更新组抛 GroupServiceError 时映射服务状态码', async () => {
      service.updateGroup.mockRejectedValue(new GroupServiceError('GROUP_EXISTS', '组名冲突', 409));

      const response = await request('PUT', '/team', { name: 'dup' });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'GROUP_EXISTS', message: '组名冲突' },
      });
    });

    it('无 details 的服务错误响应不携带 details 字段', async () => {
      service.deleteGroup.mockRejectedValue(
        new GroupServiceError('GROUP_NOT_FOUND', "组 'team' 不存在", 404),
      );

      const response = await request('DELETE', '/team');

      const body = await response.json();
      expect(body.error).not.toHaveProperty('details');
    });
  });

  describe('shutdownGroupsApi', () => {
    it('关闭 registry 返回的 core manager', async () => {
      const managerShutdown = vi.fn().mockResolvedValue(undefined);
      serviceRegistry.shutdownCoreServiceManager.mockResolvedValue({ shutdown: managerShutdown });

      const { shutdownGroupsApi } = await import('./index.js');
      await expect(shutdownGroupsApi()).resolves.toBeUndefined();

      expect(serviceRegistry.shutdownCoreServiceManager).toHaveBeenCalledOnce();
      expect(managerShutdown).toHaveBeenCalledOnce();
    });

    it('registry 未初始化（返回 null）时不调用 shutdown 也正常结束', async () => {
      serviceRegistry.shutdownCoreServiceManager.mockResolvedValue(null);

      const { shutdownGroupsApi } = await import('./index.js');
      await expect(shutdownGroupsApi()).resolves.toBeUndefined();
    });

    it('manager.shutdown 抛错时透传原始异常', async () => {
      serviceRegistry.shutdownCoreServiceManager.mockResolvedValue({
        shutdown: vi.fn().mockRejectedValue(new Error('manager shutdown boom')),
      });

      const { shutdownGroupsApi } = await import('./index.js');
      await expect(shutdownGroupsApi()).rejects.toThrow('manager shutdown boom');
    });
  });
});
