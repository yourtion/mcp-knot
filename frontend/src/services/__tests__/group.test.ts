import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as groupService from '../group';
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

describe('GroupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getGroups 请求 /groups', async () => {
    mocked.get.mockResolvedValue(ok({ groups: [] }));

    const result = await groupService.getGroups();

    expect(result).toEqual({ groups: [] });
    expect(mocked.get).toHaveBeenCalledWith('/groups');
  });

  it('getGroup 请求 /groups/:groupId', async () => {
    mocked.get.mockResolvedValue(ok({ id: 'g1' }));

    await groupService.getGroup('g1');

    expect(mocked.get).toHaveBeenCalledWith('/groups/g1');
  });

  it('createGroup POST /groups', async () => {
    mocked.post.mockResolvedValue(ok({ success: true }));
    const data = { id: 'g1', name: '组', servers: [], tools: [] };

    await groupService.createGroup(data);

    expect(mocked.post).toHaveBeenCalledWith('/groups', data);
  });

  it('updateGroup PUT /groups/:groupId', async () => {
    mocked.put.mockResolvedValue(ok({ success: true }));
    const data = { name: '新名称' };

    await groupService.updateGroup('g1', data);

    expect(mocked.put).toHaveBeenCalledWith('/groups/g1', data);
  });

  it('deleteGroup DELETE /groups/:groupId', async () => {
    mocked.delete.mockResolvedValue(ok({ success: true }));

    await groupService.deleteGroup('g1');

    expect(mocked.delete).toHaveBeenCalledWith('/groups/g1');
  });

  it('getGroupHealth 请求 /groups/:groupId/health', async () => {
    mocked.get.mockResolvedValue(ok({ healthy: true }));

    await groupService.getGroupHealth('g1');

    expect(mocked.get).toHaveBeenCalledWith('/groups/g1/health');
  });

  it('getGroupTools 请求 /groups/:groupId/tools', async () => {
    mocked.get.mockResolvedValue(ok({ tools: [] }));

    await groupService.getGroupTools('g1');

    expect(mocked.get).toHaveBeenCalledWith('/groups/g1/tools');
  });

  it('getGroupServers 请求 /groups/:groupId/servers', async () => {
    mocked.get.mockResolvedValue(ok({ servers: [] }));

    await groupService.getGroupServers('g1');

    expect(mocked.get).toHaveBeenCalledWith('/groups/g1/servers');
  });

  it('configureGroupTools POST /groups/:groupId/tools', async () => {
    mocked.post.mockResolvedValue(ok({ success: true }));
    const data = { tools: ['t1'] };

    await groupService.configureGroupTools('g1', data);

    expect(mocked.post).toHaveBeenCalledWith('/groups/g1/tools', data);
  });

  it('getGroupAvailableTools 请求 /groups/:groupId/available-tools', async () => {
    mocked.get.mockResolvedValue(ok({ tools: [] }));

    await groupService.getGroupAvailableTools('g1');

    expect(mocked.get).toHaveBeenCalledWith('/groups/g1/available-tools');
  });

  it('validateGroupToolAccess POST /groups/:groupId/validate-tool-access', async () => {
    mocked.post.mockResolvedValue(ok({ allowed: true }));
    const data = { toolName: 't1' };

    await groupService.validateGroupToolAccess('g1', data);

    expect(mocked.post).toHaveBeenCalledWith('/groups/g1/validate-tool-access', data);
  });

  it('setGroupValidationKey POST /groups/:groupId/validation-key', async () => {
    mocked.post.mockResolvedValue(ok({ success: true }));
    const data = { validationKey: 'k', enabled: true };

    await groupService.setGroupValidationKey('g1', data);

    expect(mocked.post).toHaveBeenCalledWith('/groups/g1/validation-key', data);
  });

  it('getGroupValidationKeyStatus 请求 /groups/:groupId/validation-key', async () => {
    mocked.get.mockResolvedValue(ok({ hasKey: true }));

    await groupService.getGroupValidationKeyStatus('g1');

    expect(mocked.get).toHaveBeenCalledWith('/groups/g1/validation-key');
  });

  it('validateGroupKey POST /groups/:groupId/validate-key', async () => {
    mocked.post.mockResolvedValue(ok({ valid: true }));
    const data = { validationKey: 'k' };

    await groupService.validateGroupKey('g1', data);

    expect(mocked.post).toHaveBeenCalledWith('/groups/g1/validate-key', data);
  });

  it('deleteGroupValidationKey DELETE /groups/:groupId/validation-key', async () => {
    mocked.delete.mockResolvedValue(ok({ success: true }));

    await groupService.deleteGroupValidationKey('g1');

    expect(mocked.delete).toHaveBeenCalledWith('/groups/g1/validation-key');
  });

  it('generateGroupValidationKey POST /groups/:groupId/generate-validation-key', async () => {
    mocked.post.mockResolvedValue(ok({ validationKey: 'new' }));

    await groupService.generateGroupValidationKey('g1');

    expect(mocked.post).toHaveBeenCalledWith('/groups/g1/generate-validation-key');
  });

  it('请求失败时向上传播错误', async () => {
    mocked.get.mockRejectedValue(new Error('组不存在'));

    await expect(groupService.getGroup('missing')).rejects.toThrow('组不存在');
  });
});
