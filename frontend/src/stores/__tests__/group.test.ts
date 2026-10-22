import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGroupStore } from '../group';

// Mock group service
vi.mock('@/services/group', () => ({
  getGroups: vi.fn(),
  getGroup: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  getGroupHealth: vi.fn(),
  getGroupTools: vi.fn(),
  getGroupServers: vi.fn(),
  configureGroupTools: vi.fn(),
  getGroupAvailableTools: vi.fn(),
  validateGroupToolAccess: vi.fn(),
  setGroupValidationKey: vi.fn(),
  getGroupValidationKeyStatus: vi.fn(),
  validateGroupKey: vi.fn(),
  deleteGroupValidationKey: vi.fn(),
  generateGroupValidationKey: vi.fn(),
}));

import * as groupService from '@/services/group';

import type { GroupDetailInfo, GroupInfo } from '@/types/group';

// Get mocked functions
const mockGroupService = groupService as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('Group Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('应该正确初始化状态', () => {
    const groupStore = useGroupStore();

    expect(groupStore.groups.size).toBe(0);
    expect(groupStore.loading).toBe(false);
    expect(groupStore.error).toBeNull();
    expect(groupStore.summary.totalGroups).toBe(0);
    expect(groupStore.summary.healthyGroups).toBe(0);
    expect(groupStore.summary.totalServers).toBe(0);
  });

  it('应该正确获取组列表', async () => {
    const mockGroups = [
      {
        id: 'group1',
        name: 'Test Group 1',
        description: 'Test group description',
        servers: ['server1', 'server2'],
        serverCount: 2,
        connectedServers: 2,
        toolCount: 10,
        filteredToolCount: 8,
        tools: ['tool1', 'tool2'],
        toolFilterMode: 'whitelist' as const,
        isHealthy: true,
        healthScore: 100,
        validation: {
          enabled: true,
          hasKey: true,
        },
        stats: {
          totalServers: 2,
          availableServers: 2,
          totalTools: 10,
          filteredTools: 8,
          healthPercentage: 100,
        },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'group2',
        name: 'Test Group 2',
        servers: ['server3'],
        serverCount: 1,
        connectedServers: 0,
        toolCount: 5,
        filteredToolCount: 5,
        tools: [],
        toolFilterMode: 'none' as const,
        isHealthy: false,
        healthScore: 0,
        validation: {
          enabled: false,
          hasKey: false,
        },
        stats: {
          totalServers: 1,
          availableServers: 0,
          totalTools: 5,
          filteredTools: 5,
          healthPercentage: 0,
        },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    ];

    const mockResponse = {
      groups: mockGroups,
      totalGroups: 2,
      healthyGroups: 1,
      totalServers: 3,
      connectedServers: 2,
      totalTools: 15,
      filteredTools: 13,
      averageHealthScore: 50,
      groupsWithValidation: 1,
      groupsWithToolFilter: 1,
      summary: {
        status: 'partial' as const,
        issues: ['部分组健康度较低'],
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    mockGroupService.getGroups.mockResolvedValue(mockResponse);

    const groupStore = useGroupStore();
    await groupStore.fetchGroups();

    expect(mockGroupService.getGroups).toHaveBeenCalled();
    expect(groupStore.groups.size).toBe(2);
    expect(groupStore.groups.get('group1')).toEqual(mockGroups[0]);
    expect(groupStore.groups.get('group2')).toEqual(mockGroups[1]);
    expect(groupStore.summary.summaryStatus).toBe('partial');
    expect(groupStore.summary.issues).toEqual(['部分组健康度较低']);
  });

  it('应该正确处理获取组列表错误', async () => {
    const error = new Error('Network error');
    mockGroupService.getGroups.mockRejectedValue(error);

    const groupStore = useGroupStore();
    await groupStore.fetchGroups();

    expect(mockGroupService.getGroups).toHaveBeenCalled();
    expect(groupStore.error).toBe('Network error');
    expect(groupStore.loading).toBe(false);
  });

  it('读取组详情不会覆盖列表中的服务器 ID、工具白名单与已发布技能', async () => {
    const summary: GroupInfo = {
      id: 'team',
      name: 'Team',
      servers: ['server1'],
      tools: ['offline-tool'],
      skills: { include: [{ sourceId: 'skills', skill: 'review', revision: 'a'.repeat(64) }] },
      serverCount: 1,
      connectedServers: 1,
      toolCount: 3,
      filteredToolCount: 0,
      toolFilterMode: 'whitelist',
      isHealthy: true,
      healthScore: 1,
      validation: { enabled: true, hasKey: true },
      stats: {
        totalServers: 1,
        availableServers: 1,
        totalTools: 3,
        filteredTools: 0,
        healthPercentage: 100,
      },
      lastUpdated: '2026-10-21T10:00:00Z',
    };
    const detail: GroupDetailInfo = {
      ...summary,
      servers: [{ id: 'server1', status: 'connected', toolCount: 3 }],
      tools: [],
      performance: { averageResponseTime: 0, totalRequests: 0, successRate: 1 },
      accessControl: { requiresValidation: true, toolAccessRestricted: true },
    };
    mockGroupService.getGroup.mockResolvedValue(detail);
    const groupStore = useGroupStore();
    groupStore.groups.set(summary.id, summary);

    expect(await groupStore.fetchGroup(summary.id)).toEqual(detail);
    expect(groupStore.groupList).toEqual([summary]);
    expect(groupStore.groups.get(summary.id)?.servers).toEqual(['server1']);
    expect(groupStore.groups.get(summary.id)?.tools).toEqual(['offline-tool']);
    expect(groupStore.groups.get(summary.id)?.skills).toEqual(summary.skills);
  });

  it('应该正确创建组', async () => {
    const createRequest = {
      id: 'new-group',
      name: 'New Group',
      description: 'New group description',
      servers: ['server1'],
      tools: ['tool1'],
    };

    const mockResponse = {
      success: true,
      data: {
        id: 'new-group',
        name: 'New Group',
        description: 'New group description',
        servers: ['server1'],
        tools: ['tool1'],
        toolFilterMode: 'whitelist' as const,
        validation: {
          enabled: false,
          hasKey: false,
        },
        stats: {
          totalServers: 1,
          availableServers: 0,
          totalTools: 1,
          filteredTools: 1,
          healthPercentage: 0,
        },
        accessControl: {
          requiresValidation: false,
          toolAccessRestricted: true,
        },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    mockGroupService.createGroup.mockResolvedValue(mockResponse);

    // Mock fetchGroups call
    mockGroupService.getGroups.mockResolvedValue({
      groups: [],
      totalGroups: 0,
      healthyGroups: 0,
      totalServers: 0,
      connectedServers: 0,
      totalTools: 0,
      filteredTools: 0,
      averageHealthScore: 0,
      groupsWithValidation: 0,
      groupsWithToolFilter: 0,
      summary: {
        status: 'healthy' as const,
        issues: [],
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    });

    const groupStore = useGroupStore();
    const result = await groupStore.createGroup(createRequest);

    expect(mockGroupService.createGroup).toHaveBeenCalledWith(createRequest);
    expect(result).toEqual(mockResponse);
    expect(groupStore.loading).toBe(false);
  });

  it('应该正确处理创建组错误', async () => {
    const createRequest = {
      id: 'new-group',
      name: 'New Group',
      servers: [],
      tools: [],
    };

    const error = new Error('创建组失败');
    mockGroupService.createGroup.mockRejectedValue(error);

    const groupStore = useGroupStore();
    await expect(groupStore.createGroup(createRequest)).rejects.toThrow(error);

    expect(mockGroupService.createGroup).toHaveBeenCalledWith(createRequest);
    expect(groupStore.error).toBe('创建组失败');
    expect(groupStore.loading).toBe(false);
  });

  it('应该正确更新组', async () => {
    const groupId = 'group1';
    const updateRequest = {
      name: 'Updated Group Name',
      servers: ['server1', 'server2'],
    };

    const mockResponse = {
      success: true,
      data: {
        id: 'group1',
        name: 'Updated Group Name',
        description: 'Test group description',
        servers: ['server1', 'server2'],
        tools: ['tool1'],
        toolFilterMode: 'whitelist' as const,
        validation: {
          enabled: true,
          hasKey: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
        stats: {
          totalServers: 2,
          availableServers: 1,
          totalTools: 1,
          filteredTools: 1,
          healthPercentage: 50,
        },
        accessControl: {
          requiresValidation: true,
          toolAccessRestricted: true,
        },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    mockGroupService.updateGroup.mockResolvedValue(mockResponse);

    // Mock fetchGroups call
    mockGroupService.getGroups.mockResolvedValue({
      groups: [],
      totalGroups: 0,
      healthyGroups: 0,
      totalServers: 0,
      connectedServers: 0,
      totalTools: 0,
      filteredTools: 0,
      averageHealthScore: 0,
      groupsWithValidation: 0,
      groupsWithToolFilter: 0,
      summary: {
        status: 'healthy' as const,
        issues: [],
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    });

    const groupStore = useGroupStore();
    const result = await groupStore.updateGroup(groupId, updateRequest);

    expect(mockGroupService.updateGroup).toHaveBeenCalledWith(groupId, updateRequest);
    expect(result).toEqual(mockResponse);
    expect(groupStore.loading).toBe(false);
  });

  it('应该正确删除组', async () => {
    const groupId = 'group1';

    mockGroupService.deleteGroup.mockResolvedValue({
      success: true,
      data: {
        id: 'group1',
        name: 'Test Group 1',
        deleted: true,
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    });

    // Mock fetchGroups call
    mockGroupService.getGroups.mockResolvedValue({
      groups: [],
      totalGroups: 0,
      healthyGroups: 0,
      totalServers: 0,
      connectedServers: 0,
      totalTools: 0,
      filteredTools: 0,
      averageHealthScore: 0,
      groupsWithValidation: 0,
      groupsWithToolFilter: 0,
      summary: {
        status: 'healthy' as const,
        issues: [],
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    });

    const groupStore = useGroupStore();
    await groupStore.deleteGroup(groupId);

    expect(mockGroupService.deleteGroup).toHaveBeenCalledWith(groupId);
    expect(groupStore.groups.has(groupId)).toBe(false);
    expect(groupStore.loading).toBe(false);
  });

  it('应该正确获取组健康状态', async () => {
    const groupId = 'group1';
    const mockHealthResponse = {
      groupId: 'group1',
      healthy: true,
      healthScore: 100,
      servers: {
        total: 2,
        healthy: 2,
        unhealthy: 0,
        details: [
          {
            serverId: 'server1',
            healthy: true,
            status: 'connected',
            toolCount: 5,
          },
          {
            serverId: 'server2',
            healthy: true,
            status: 'connected',
            toolCount: 5,
          },
        ],
      },
      tools: {
        available: 10,
        total: 10,
      },
      issues: [],
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    mockGroupService.getGroupHealth.mockResolvedValue(mockHealthResponse);

    const groupStore = useGroupStore();
    const result = await groupStore.getGroupHealth(groupId);

    expect(mockGroupService.getGroupHealth).toHaveBeenCalledWith(groupId);
    expect(result).toEqual(mockHealthResponse);
  });

  it('应该正确设置组验证密钥', async () => {
    const groupId = 'group1';
    const setKeyRequest = {
      validationKey: 'test-key-123',
      enabled: true,
    };

    const mockResponse = {
      success: true,
      data: {
        groupId: 'group1',
        validation: {
          enabled: true,
          hasKey: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    mockGroupService.setGroupValidationKey.mockResolvedValue(mockResponse);

    const groupStore = useGroupStore();
    const result = await groupStore.setGroupValidationKey(groupId, setKeyRequest);

    expect(mockGroupService.setGroupValidationKey).toHaveBeenCalledWith(groupId, setKeyRequest);
    expect(result).toEqual(mockResponse);
  });

  it('应该正确生成组验证密钥', async () => {
    const groupId = 'group1';

    const mockResponse = {
      success: true,
      data: {
        groupId: 'group1',
        validationKey: 'generated-key-456',
        validation: {
          enabled: true,
          hasKey: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
        security: {
          keyComplexity: 'strong' as const,
          keyLength: 32,
          entropy: 256,
          recommendations: ['密钥强度良好'],
        },
        warnings: [],
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    mockGroupService.generateGroupValidationKey.mockResolvedValue(mockResponse);

    const groupStore = useGroupStore();
    const result = await groupStore.generateGroupValidationKey(groupId);

    expect(mockGroupService.generateGroupValidationKey).toHaveBeenCalledWith(groupId);
    expect(result).toEqual(mockResponse);
  });

  it('应该正确清除错误', () => {
    const groupStore = useGroupStore();

    groupStore.error = 'Test error';
    expect(groupStore.error).toBe('Test error');

    groupStore.clearError();
    expect(groupStore.error).toBeNull();
  });

  it('应该正确计算计算属性', () => {
    const groupStore = useGroupStore();

    // 设置一些测试数据
    groupStore.groups.set('group1', {
      id: 'group1',
      name: 'Group 1',
      description: '',
      servers: ['server1'],
      serverCount: 1,
      connectedServers: 1,
      toolCount: 5,
      filteredToolCount: 5,
      tools: [],
      toolFilterMode: 'whitelist',
      isHealthy: true,
      healthScore: 100,
      validation: { enabled: false, hasKey: false },
      stats: {
        totalServers: 1,
        availableServers: 1,
        totalTools: 5,
        filteredTools: 5,
        healthPercentage: 100,
      },
      lastUpdated: '2024-01-01T00:00:00.000Z',
    });

    groupStore.groups.set('group2', {
      id: 'group2',
      name: 'Group 2',
      description: '',
      servers: ['server2'],
      serverCount: 1,
      connectedServers: 0,
      toolCount: 3,
      filteredToolCount: 3,
      tools: [],
      toolFilterMode: 'none',
      isHealthy: false,
      healthScore: 0,
      validation: { enabled: true, hasKey: true },
      stats: {
        totalServers: 1,
        availableServers: 0,
        totalTools: 3,
        filteredTools: 3,
        healthPercentage: 0,
      },
      lastUpdated: '2024-01-01T00:00:00.000Z',
    });

    groupStore.groups.set('group3', {
      id: 'group3',
      name: 'Group 3',
      description: '',
      servers: ['server3'],
      serverCount: 1,
      connectedServers: 1,
      toolCount: 2,
      filteredToolCount: 1,
      tools: ['tool-x'],
      toolFilterMode: 'whitelist',
      isHealthy: true,
      healthScore: 80,
      validation: { enabled: false, hasKey: false },
      stats: {
        totalServers: 1,
        availableServers: 1,
        totalTools: 2,
        filteredTools: 1,
        healthPercentage: 80,
      },
      lastUpdated: '2024-01-01T00:00:00.000Z',
    });

    // 数量刻意不对称，确保过滤条件本身被验证
    expect(groupStore.groupList).toHaveLength(3);
    expect(groupStore.healthyGroups).toHaveLength(2);
    expect(groupStore.unhealthyGroups).toHaveLength(1);
    expect(groupStore.unhealthyGroups[0].id).toBe('group2');
    expect(groupStore.groupsWithValidation).toHaveLength(1);
    expect(groupStore.groupsWithValidation[0].id).toBe('group2');
    expect(groupStore.groupsWithToolFilter).toHaveLength(2);
    expect(groupStore.groupsWithToolFilter.map((g) => g.id)).toEqual(['group1', 'group3']);
  });

  describe('补充行为覆盖', () => {
    const makeGroupInfo = (id: string) =>
      ({
        id,
        name: `组 ${id}`,
        description: '',
        servers: [],
        serverCount: 0,
        connectedServers: 0,
        toolCount: 0,
        filteredToolCount: 0,
        tools: [],
        toolFilterMode: 'none',
        isHealthy: true,
        healthScore: 100,
        validation: { enabled: false, hasKey: false },
        stats: {
          totalServers: 0,
          availableServers: 0,
          totalTools: 0,
          filteredTools: 0,
          healthPercentage: 100,
        },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      }) as never;

    it('fetchGroups 时 summary 统计字段全部更新', async () => {
      mockGroupService.getGroups.mockResolvedValue({
        groups: [],
        totalGroups: 7,
        healthyGroups: 5,
        unhealthyGroups: 2,
        totalServers: 11,
        connectedServers: 9,
        totalTools: 40,
        filteredTools: 30,
        averageHealthScore: 71,
        groupsWithValidation: 3,
        groupsWithToolFilter: 4,
        summary: { status: 'partial', issues: [] },
        timestamp: '2024-01-01T00:00:00.000Z',
      });

      const groupStore = useGroupStore();
      await groupStore.fetchGroups();

      expect(groupStore.summary).toMatchObject({
        totalGroups: 7,
        healthyGroups: 5,
        unhealthyGroups: 2,
        totalServers: 11,
        connectedServers: 9,
        totalTools: 40,
        filteredTools: 30,
        averageHealthScore: 71,
        groupsWithValidation: 3,
        groupsWithToolFilter: 4,
        summaryStatus: 'partial',
        issues: [],
      });
    });

    it('fetchGroups 响应缺少 unhealthyGroups 时按差值计算', async () => {
      mockGroupService.getGroups.mockResolvedValue({
        groups: [],
        totalGroups: 10,
        healthyGroups: 7,
        totalServers: 0,
        connectedServers: 0,
        totalTools: 0,
        filteredTools: 0,
        averageHealthScore: 0,
        groupsWithValidation: 0,
        groupsWithToolFilter: 0,
        summary: { status: 'healthy', issues: [] },
        timestamp: '2024-01-01T00:00:00.000Z',
      });

      const groupStore = useGroupStore();
      await groupStore.fetchGroups();

      expect(groupStore.summary.unhealthyGroups).toBe(3);
    });

    it('fetchGroups 失败时非 Error 对象使用默认错误消息', async () => {
      mockGroupService.getGroups.mockRejectedValue('boom');

      const groupStore = useGroupStore();
      await groupStore.fetchGroups();

      expect(groupStore.error).toBe('获取组列表失败');
    });

    it('fetchGroups 请求期间处于加载状态', async () => {
      let resolveFn: (value: unknown) => void;
      mockGroupService.getGroups.mockImplementation(
        () => new Promise((resolve) => (resolveFn = resolve)),
      );

      const groupStore = useGroupStore();
      const pending = groupStore.fetchGroups();

      expect(groupStore.loading).toBe(true);

      resolveFn({
        groups: [],
        totalGroups: 0,
        healthyGroups: 0,
        totalServers: 0,
        connectedServers: 0,
        totalTools: 0,
        filteredTools: 0,
        averageHealthScore: 0,
        groupsWithValidation: 0,
        groupsWithToolFilter: 0,
        summary: { status: 'healthy', issues: [] },
      });
      await pending;
    });

    it('fetchGroup 成功时写入组详情', async () => {
      const detail = { ...makeGroupInfo('g1'), name: '详情' };
      mockGroupService.getGroup.mockResolvedValue(detail);

      const groupStore = useGroupStore();
      const result = await groupStore.fetchGroup('g1');

      expect(result).toEqual(detail);
      expect(groupStore.groups.get('g1')).toEqual(detail);
    });

    it('fetchGroup 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.getGroup.mockRejectedValue(null);

      const groupStore = useGroupStore();
      await expect(groupStore.fetchGroup('g1')).rejects.toBeNull();

      expect(groupStore.error).toBe('获取组信息失败');
    });

    it('updateGroup 会合并本地已有组信息', async () => {
      const groupStore = useGroupStore();
      groupStore.groups.set('g1', makeGroupInfo('g1'));

      mockGroupService.updateGroup.mockResolvedValue({
        success: true,
        data: { name: '新名称', description: '新描述' },
        timestamp: '2024-01-01T00:00:00.000Z',
      });
      // 让后续的 fetchGroups 失败，避免列表刷新覆盖本地合并结果
      mockGroupService.getGroups.mockRejectedValue(new Error('refresh failed'));

      await expect(groupStore.updateGroup('g1', { name: '新名称' })).resolves.toBeDefined();

      const merged = groupStore.groups.get('g1') as {
        name: string;
        description: string;
        id: string;
      };
      expect(merged.name).toBe('新名称');
      expect(merged.description).toBe('新描述');
      expect(merged.id).toBe('g1');
    });

    it('updateGroup 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.updateGroup.mockRejectedValue('x');

      const groupStore = useGroupStore();
      await expect(groupStore.updateGroup('g1', {})).rejects.toBe('x');

      expect(groupStore.error).toBe('更新组失败');
    });

    it('deleteGroup 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.deleteGroup.mockRejectedValue(1);

      const groupStore = useGroupStore();
      await expect(groupStore.deleteGroup('g1')).rejects.toBe(1);

      expect(groupStore.error).toBe('删除组失败');
    });

    it.each([
      ['getGroupHealth', '获取组健康状态失败'],
      ['getGroupTools', '获取组工具列表失败'],
      ['getGroupServers', '获取组服务器列表失败'],
      ['getGroupAvailableTools', '获取组可用工具失败'],
      ['getGroupValidationKeyStatus', '获取组验证密钥状态失败'],
      ['validateGroupKey', '验证组密钥失败'],
    ] as const)('%s 失败时记录默认错误消息并抛出', async (method, message) => {
      mockGroupService[method].mockRejectedValue(undefined);

      const groupStore = useGroupStore();
      const action =
        method === 'validateGroupKey'
          ? groupStore.validateGroupKey('g1', { validationKey: 'k' })
          : groupStore[method]('g1');

      await expect(action).rejects.toBeUndefined();
      expect(groupStore.error).toBe(message);
    });

    it('getGroupHealth 等只读接口直接透传结果', async () => {
      const tools = { tools: [] };
      const servers = { servers: [] };
      mockGroupService.getGroupTools.mockResolvedValue(tools);
      mockGroupService.getGroupServers.mockResolvedValue(servers);

      const groupStore = useGroupStore();

      await expect(groupStore.getGroupTools('g1')).resolves.toBe(tools);
      await expect(groupStore.getGroupServers('g1')).resolves.toBe(servers);
      expect(mockGroupService.getGroupTools).toHaveBeenCalledWith('g1');
      expect(mockGroupService.getGroupServers).toHaveBeenCalledWith('g1');
    });

    it('validateGroupToolAccess 以工具名调用服务', async () => {
      const response = { allowed: true, reason: '' };
      mockGroupService.validateGroupToolAccess.mockResolvedValue(response);

      const groupStore = useGroupStore();
      await expect(groupStore.validateGroupToolAccess('g1', 'tool-x')).resolves.toBe(response);

      expect(mockGroupService.validateGroupToolAccess).toHaveBeenCalledWith('g1', {
        toolName: 'tool-x',
      });
    });

    it('validateGroupToolAccess 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.validateGroupToolAccess.mockRejectedValue('denied');

      const groupStore = useGroupStore();
      await expect(groupStore.validateGroupToolAccess('g1', 'tool-x')).rejects.toBe('denied');

      expect(groupStore.error).toBe('验证工具访问权限失败');
    });

    it('configureGroupTools 更新本地工具白名单', async () => {
      const groupStore = useGroupStore();
      groupStore.groups.set('g1', makeGroupInfo('g1'));

      mockGroupService.configureGroupTools.mockResolvedValue({
        success: true,
        timestamp: '2024-01-01T00:00:00.000Z',
      });

      await groupStore.configureGroupTools('g1', { tools: ['tool-a', 'tool-b'] });

      const group = groupStore.groups.get('g1') as { tools: string[]; toolFilterMode: string };
      expect(group.tools).toEqual(['tool-a', 'tool-b']);
      expect(group.toolFilterMode).toBe('whitelist');
      expect(mockGroupService.configureGroupTools).toHaveBeenCalledWith('g1', {
        tools: ['tool-a', 'tool-b'],
      });
    });

    it('configureGroupTools 清空工具时过滤模式回到 none', async () => {
      const groupStore = useGroupStore();
      groupStore.groups.set('g1', makeGroupInfo('g1'));

      mockGroupService.configureGroupTools.mockResolvedValue({
        success: true,
        timestamp: '2024-01-01T00:00:00.000Z',
      });

      await groupStore.configureGroupTools('g1', { tools: [] });

      const group = groupStore.groups.get('g1') as { tools: string[]; toolFilterMode: string };
      expect(group.tools).toEqual([]);
      expect(group.toolFilterMode).toBe('none');
    });

    it('configureGroupTools 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.configureGroupTools.mockRejectedValue('bad');

      const groupStore = useGroupStore();
      await expect(groupStore.configureGroupTools('g1', { tools: [] })).rejects.toBe('bad');

      expect(groupStore.error).toBe('配置组工具过滤失败');
    });

    it('setGroupValidationKey 更新本地验证状态', async () => {
      const groupStore = useGroupStore();
      groupStore.groups.set('g1', makeGroupInfo('g1'));

      mockGroupService.setGroupValidationKey.mockResolvedValue({
        success: true,
        data: {
          groupId: 'g1',
          validation: {
            enabled: true,
            hasKey: true,
            lastUpdated: '2024-02-01T00:00:00.000Z',
          },
        },
        timestamp: '2024-02-01T00:00:00.000Z',
      });

      const response = await groupStore.setGroupValidationKey('g1', {
        validationKey: 'k',
        enabled: true,
      });

      expect(response.data.validation.enabled).toBe(true);
      const group = groupStore.groups.get('g1') as { validation: Record<string, unknown> };
      expect(group.validation).toMatchObject({
        enabled: true,
        hasKey: true,
        lastUpdated: '2024-02-01T00:00:00.000Z',
      });
    });

    it('setGroupValidationKey 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.setGroupValidationKey.mockRejectedValue('k');

      const groupStore = useGroupStore();
      await expect(
        groupStore.setGroupValidationKey('g1', { validationKey: 'k', enabled: true }),
      ).rejects.toBe('k');

      expect(groupStore.error).toBe('设置组验证密钥失败');
    });

    it('generateGroupValidationKey 更新本地验证状态', async () => {
      const groupStore = useGroupStore();
      groupStore.groups.set('g1', makeGroupInfo('g1'));

      mockGroupService.generateGroupValidationKey.mockResolvedValue({
        success: true,
        data: {
          groupId: 'g1',
          validationKey: 'new-key',
          validation: {
            enabled: true,
            hasKey: true,
            lastUpdated: '2024-03-01T00:00:00.000Z',
          },
        },
        timestamp: '2024-03-01T00:00:00.000Z',
      });

      await groupStore.generateGroupValidationKey('g1');

      const group = groupStore.groups.get('g1') as { validation: Record<string, unknown> };
      expect(group.validation).toMatchObject({
        enabled: true,
        hasKey: true,
        lastUpdated: '2024-03-01T00:00:00.000Z',
      });
    });

    it('generateGroupValidationKey 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.generateGroupValidationKey.mockRejectedValue(false);

      const groupStore = useGroupStore();
      await expect(groupStore.generateGroupValidationKey('g1')).rejects.toBe(false);

      expect(groupStore.error).toBe('生成组验证密钥失败');
    });

    it('deleteGroupValidationKey 重置本地验证状态', async () => {
      const groupStore = useGroupStore();
      const groupInfo = makeGroupInfo('g1') as { validation: Record<string, unknown> };
      groupInfo.validation = { enabled: true, hasKey: true };
      groupStore.groups.set('g1', groupInfo);

      mockGroupService.deleteGroupValidationKey.mockResolvedValue({
        success: true,
        timestamp: '2024-04-01T00:00:00.000Z',
      });

      await groupStore.deleteGroupValidationKey('g1');

      expect(groupStore.groups.get('g1')?.validation).toEqual({ enabled: false, hasKey: false });
    });

    it('deleteGroupValidationKey 失败时记录默认错误消息并抛出', async () => {
      mockGroupService.deleteGroupValidationKey.mockRejectedValue('nope');

      const groupStore = useGroupStore();
      await expect(groupStore.deleteGroupValidationKey('g1')).rejects.toBe('nope');

      expect(groupStore.error).toBe('删除组验证密钥失败');
    });
  });
});
