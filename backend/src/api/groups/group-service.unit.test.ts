import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreManager = vi.hoisted(() => ({
  getServerConnections: vi.fn(),
  getAllTools: vi.fn(),
  getServerTools: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getCoreServiceManager: vi.fn().mockResolvedValue(coreManager),
  reloadCoreServiceManager: vi.fn().mockResolvedValue(coreManager),
}));

const skillRepository = vi.hoisted(() => ({
  catalog: vi.fn(),
}));

vi.mock('../../services/skills-service.js', () => ({
  getSkillRepository: () => skillRepository,
}));

const configMock = vi.hoisted(() => ({
  getAllConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../../utils/config.js', () => configMock);

const perfStats = vi.hoisted(() => ({
  averageResponseTime: 0,
  totalRequests: 0,
  successRate: 0,
}));

vi.mock('../../utils/performance-monitor.js', () => ({
  performanceMonitor: {
    getStatsByPathPrefix: vi.fn(() => perfStats),
  },
}));

import { GroupServiceError } from './group-service.js';
import {
  createGroup,
  deleteGroup,
  getGroupDetail,
  getGroupHealth,
  getGroupServers,
  listGroups,
  updateGroup,
} from './group-service.js';

function baseConfig(groups: Record<string, unknown>): void {
  configMock.getAllConfig.mockResolvedValue({
    mcps: { servers: { 'srv-a': {}, 'srv-b': {} } },
    groups,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.saveConfig.mockResolvedValue(undefined);
  coreManager.getAllTools.mockResolvedValue([]);
  coreManager.getServerTools.mockResolvedValue([]);
  coreManager.getServerConnections.mockReturnValue(new Map());
});

describe('listGroups', () => {
  it('汇总各组的连接状态、工具过滤与总体健康度', async () => {
    baseConfig({
      team: {
        name: '团队组',
        description: 'desc',
        servers: ['srv-a', 'srv-b'],
        tools: ['tool-a'],
        validation: { enabled: true, validationKey: 'enc', createdAt: '2026-01-01T00:00:00Z' },
      },
      empty: { name: '空组', servers: [], tools: [] },
    });
    coreManager.getServerConnections.mockReturnValue(
      new Map([
        ['srv-a', { status: 'connected' }],
        ['srv-b', { status: 'disconnected' }],
      ]),
    );
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', serverId: 'srv-a' },
      { name: 'tool-b', serverId: 'srv-a' },
      { name: 'tool-x', serverId: 'srv-other' },
    ]);

    const data = await listGroups();

    expect(data.totalGroups).toBe(2);
    expect(data.healthyGroups).toBe(1);
    expect(data.unhealthyGroups).toBe(1);
    expect(data.totalServers).toBe(2);
    expect(data.connectedServers).toBe(1);
    expect(data.totalTools).toBe(2);
    expect(data.filteredTools).toBe(1);
    expect(data.averageHealthScore).toBe(25);
    expect(data.groupsWithValidation).toBe(1);
    expect(data.groupsWithToolFilter).toBe(1);
    expect(data.summary.status).toBe('partial');

    const team = data.groups.find((g) => g.id === 'team');
    expect(team).toMatchObject({
      name: '团队组',
      description: 'desc',
      serverCount: 2,
      connectedServers: 1,
      toolCount: 2,
      filteredToolCount: 1,
      toolFilterMode: 'whitelist',
      isHealthy: true,
      healthScore: 50,
      validation: {
        enabled: true,
        hasKey: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
    });

    const empty = data.groups.find((g) => g.id === 'empty');
    expect(empty).toMatchObject({
      isHealthy: false,
      healthScore: 0,
      toolFilterMode: 'none',
      validation: { enabled: false, hasKey: false },
    });
  });

  it('全部健康时 summary 为 healthy，全部异常时为 unhealthy', async () => {
    baseConfig({ good: { servers: ['srv-a'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));
    expect((await listGroups()).summary.status).toBe('healthy');

    baseConfig({ bad: { servers: ['srv-a'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(new Map());
    const data = await listGroups();
    expect(data.summary.status).toBe('unhealthy');
    expect(data.summary.issues).toEqual(['部分组健康度较低']);
  });

  it('健康度低于 50 的组会产生 summary issue', async () => {
    baseConfig({
      half: { servers: ['srv-a', 'srv-b', 'srv-b2'], tools: [] },
    });
    coreManager.getServerConnections.mockReturnValue(
      new Map([
        ['srv-a', { status: 'connected' }],
        ['srv-b', { status: 'disconnected' }],
      ]),
    );

    const data = await listGroups();

    expect(data.groups[0].healthScore).toBe(33);
    expect(data.summary.issues).toEqual(['部分组健康度较低']);
  });

  it('获取组工具失败时该组工具计数为 0 但不影响列表', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockRejectedValue(new Error('上游不可用'));

    const data = await listGroups();

    expect(data.totalTools).toBe(0);
    expect(data.groups[0]).toMatchObject({ id: 'team', toolCount: 0, isHealthy: false });
  });

  it('携带 skills 的组在列表中保留 skills 字段', async () => {
    baseConfig({
      team: { servers: [], tools: [], skills: { include: ['sk-1'] } },
    });

    const data = await listGroups();

    expect(data.groups[0].skills).toEqual({ include: ['sk-1'] });
  });
});

describe('getGroupDetail', () => {
  it('返回组详情（含服务器状态、工具过滤、验证脱敏与性能指标）', async () => {
    baseConfig({
      team: {
        name: '团队组',
        servers: ['srv-a', 'srv-b'],
        tools: ['tool-a'],
        validation: { enabled: true, validationKey: 'enc' },
      },
    });
    coreManager.getServerConnections.mockReturnValue(
      new Map([
        [
          'srv-a',
          {
            status: 'connected',
            lastConnected: new Date('2026-01-01T00:00:00Z'),
            tools: [{ name: 'tool-a' }, { name: 'tool-b' }],
          },
        ],
        ['srv-b', { status: 'error', lastError: new Error('超时') }],
      ]),
    );
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', description: 'A', serverId: 'srv-a', parameters: {}, category: 'cat' },
      { name: 'tool-b', description: 'B', serverId: 'srv-a', parameters: {}, category: 'cat' },
    ]);

    const data = await getGroupDetail('team');

    expect(data).toMatchObject({
      id: 'team',
      name: '团队组',
      description: '',
      serverCount: 2,
      connectedServers: 1,
      toolCount: 1,
      toolFilter: ['tool-a'],
      toolFilterMode: 'whitelist',
      isHealthy: true,
      healthScore: 50,
      validation: { enabled: true, hasKey: true, validationKey: '***' },
      accessControl: { requiresValidation: true, toolAccessRestricted: true },
      performance: perfStats,
    });
    expect(data.servers).toEqual([
      {
        id: 'srv-a',
        status: 'connected',
        lastConnected: '2026-01-01T00:00:00.000Z',
        toolCount: 2,
        error: undefined,
      },
      {
        id: 'srv-b',
        status: 'error',
        lastConnected: undefined,
        toolCount: 0,
        error: '超时',
      },
    ]);
    expect(data.tools).toEqual([expect.objectContaining({ name: 'tool-a', serverId: 'srv-a' })]);
  });

  it('未配置服务器状态时按 unknown 处理', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });

    const data = await getGroupDetail('team');

    expect(data.servers[0]).toEqual({
      id: 'srv-a',
      status: 'unknown',
      lastConnected: undefined,
      toolCount: 0,
      error: undefined,
    });
    expect(data.toolFilterMode).toBe('none');
    expect(data.accessControl).toEqual({
      requiresValidation: false,
      toolAccessRestricted: false,
    });
  });

  it('组不存在时抛 GROUP_NOT_FOUND', async () => {
    baseConfig({});

    await expect(getGroupDetail('missing')).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
      status: 404,
      message: "组 'missing' 不存在",
    });
  });

  it('获取组工具失败时不阻断详情响应', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockRejectedValue(new Error('工具服务异常'));

    const data = await getGroupDetail('team');

    expect(data.tools).toEqual([]);
    expect(data.toolCount).toBe(0);
  });
});

describe('getGroupHealth', () => {
  function healthySetup(): void {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(
      new Map([['srv-a', { status: 'connected', tools: [1], lastConnected: new Date() }]]),
    );
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);
  }

  it('有连接且有工具时返回 200 与健康详情', async () => {
    healthySetup();

    const { data, status } = await getGroupHealth('team');

    expect(status).toBe(200);
    expect(data).toMatchObject({
      groupId: 'team',
      healthy: true,
      healthScore: 100,
      servers: { total: 1, healthy: 1, unhealthy: 0 },
      tools: { available: 1, total: 1 },
      issues: [],
    });
    expect(data.servers.details[0]).toMatchObject({ serverId: 'srv-a', healthy: true });
  });

  it('无连接服务器时返回 503 并列出问题', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(new Map());
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const { data, status } = await getGroupHealth('team');

    expect(status).toBe(503);
    expect(data.healthy).toBe(false);
    expect(data.issues).toEqual(['没有可用的服务器连接', '服务器健康度较低: 0%']);
  });

  it('无可用工具时返回 503 且提示工具问题', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));
    coreManager.getAllTools.mockResolvedValue([]);

    const { data, status } = await getGroupHealth('team');

    expect(status).toBe(503);
    expect(data.issues).toEqual(['没有可用的工具']);
  });

  it('健康度低于 50 时追加健康度问题', async () => {
    baseConfig({ team: { servers: ['srv-a', 'srv-b', 'srv-b2'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(
      new Map([
        ['srv-a', { status: 'connected' }],
        ['srv-b', { status: 'disconnected' }],
        ['srv-b2', { status: 'error' }],
      ]),
    );
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const { data, status } = await getGroupHealth('team');

    expect(status).toBe(200);
    expect(data.healthScore).toBe(33);
    expect(data.issues).toEqual(['服务器健康度较低: 33%']);
  });

  it('配置了工具白名单时 total 取白名单长度', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: ['tool-a', 'tool-b'] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const { data } = await getGroupHealth('team');

    expect(data.tools).toEqual({ available: 1, total: 2 });
  });

  it('组不存在时抛 GROUP_NOT_FOUND', async () => {
    baseConfig({});

    await expect(getGroupHealth('missing')).rejects.toBeInstanceOf(GroupServiceError);
  });
});

describe('getGroupServers', () => {
  it('返回组内服务器详情与汇总', async () => {
    baseConfig({ team: { servers: ['srv-a', 'srv-b'] } });
    coreManager.getServerConnections.mockReturnValue(
      new Map([
        ['srv-a', { status: 'connected', lastConnected: new Date('2026-01-01T00:00:00Z') }],
      ]),
    );
    coreManager.getServerTools.mockImplementation(async (serverId: string) =>
      serverId === 'srv-a' ? [{ name: 'tool-a', description: 'A', category: 'cat' }] : [],
    );

    const data = await getGroupServers('team');

    expect(data).toMatchObject({
      groupId: 'team',
      totalServers: 2,
      connectedServers: 1,
      disconnectedServers: 1,
      totalTools: 1,
      healthScore: 50,
    });
    expect(data.servers).toEqual([
      {
        id: 'srv-a',
        status: 'connected',
        lastConnected: '2026-01-01T00:00:00.000Z',
        lastError: undefined,
        tools: [{ name: 'tool-a', description: 'A', category: 'cat' }],
        toolCount: 1,
        isHealthy: true,
      },
      {
        id: 'srv-b',
        status: 'unknown',
        lastConnected: undefined,
        lastError: undefined,
        tools: [],
        toolCount: 0,
        isHealthy: false,
      },
    ]);
  });

  it('获取服务器工具失败时该服务器工具为空', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getServerTools.mockRejectedValue(new Error('超时'));

    const data = await getGroupServers('team');

    expect(data.servers[0].tools).toEqual([]);
    expect(data.totalTools).toBe(0);
  });

  it('组不存在时抛 GROUP_NOT_FOUND', async () => {
    baseConfig({});
    await expect(getGroupServers('missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('createGroup', () => {
  const body = {
    id: 'new-group',
    name: '新组',
    servers: ['srv-a'],
    tools: ['tool-a'],
  };

  it('校验通过后保存组配置并返回摘要', async () => {
    baseConfig({});

    const data = await createGroup(body);

    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      'new-group': {
        id: 'new-group',
        name: '新组',
        description: '',
        servers: ['srv-a'],
        tools: ['tool-a'],
      },
    });
    expect(data).toMatchObject({
      id: 'new-group',
      name: '新组',
      toolFilterMode: 'whitelist',
      validation: { enabled: false, hasKey: false },
      stats: { totalServers: 1, totalTools: 1, filteredTools: 1 },
      accessControl: { requiresValidation: false, toolAccessRestricted: true },
    });
  });

  it('数据校验失败时抛 VALIDATION_ERROR 且带详情', async () => {
    baseConfig({});

    await expect(
      createGroup({ ...body, name: '', servers: 'x', tools: ['a', 'a'] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      details: expect.arrayContaining([
        '组名称不能为空',
        '服务器列表必须是数组',
        '工具列表包含重复的工具名称',
      ]),
    });
    expect(configMock.saveConfig).not.toHaveBeenCalled();
  });

  it('非法组 ID 抛 INVALID_GROUP_ID', async () => {
    baseConfig({});

    await expect(createGroup({ ...body, id: 'bad id' })).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
      status: 400,
      message: '组ID只能包含字母、数字、连字符和下划线',
    });
  });

  it('组已存在抛 GROUP_ALREADY_EXISTS', async () => {
    baseConfig({ 'new-group': { servers: [] } });

    await expect(createGroup(body)).rejects.toMatchObject({
      code: 'GROUP_ALREADY_EXISTS',
      status: 409,
      message: "组 'new-group' 已存在",
    });
  });

  it('引用不存在的服务器只告警不阻断创建', async () => {
    baseConfig({});

    await createGroup({ ...body, servers: ['ghost'] });

    expect(configMock.saveConfig).toHaveBeenCalled();
  });

  it('skills 校验：无服务器且无技能时抛错，引用无效时抛错', async () => {
    baseConfig({});
    const selection = {
      sourceId: 'src1',
      revision: 'a'.repeat(64),
      skill: 'demo-skill',
    };

    await expect(
      createGroup({ ...body, servers: [], skills: { include: [] } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      message: '组至少需要服务器或已发布技能',
    });

    skillRepository.catalog.mockRejectedValueOnce(new Error('技能不存在'));
    await expect(
      createGroup({ ...body, servers: [], skills: { include: [selection] } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: '技能发布引用无效',
      details: ['技能不存在'],
    });
  });

  it('skills 有效时调用仓库编目并保留字段', async () => {
    baseConfig({});
    const selection = {
      sourceId: 'src1',
      revision: 'a'.repeat(64),
      skill: 'demo-skill',
    };
    skillRepository.catalog.mockResolvedValueOnce([]);

    const data = await createGroup({ ...body, skills: { include: [selection] } });

    expect(skillRepository.catalog).toHaveBeenCalledWith({ include: [selection] }, 'new-group');
    expect(data.skills).toEqual({ include: [selection] });
    expect(configMock.saveConfig).toHaveBeenCalledWith(
      'group.json',
      expect.objectContaining({
        'new-group': expect.objectContaining({ skills: { include: [selection] } }),
      }),
    );
  });

  it('重新初始化核心服务失败不阻断创建', async () => {
    baseConfig({});
    const { reloadCoreServiceManager } = await import('../../services/service-registry.js');
    (reloadCoreServiceManager as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('重载失败'),
    );

    const data = await createGroup(body);

    expect(data.id).toBe('new-group');
    expect(configMock.saveConfig).toHaveBeenCalled();
  });
});

describe('updateGroup', () => {
  it('按提供的字段合并更新并保留验证配置', async () => {
    baseConfig({
      team: {
        name: '旧名',
        description: '旧描述',
        servers: ['srv-a'],
        tools: ['tool-a'],
        validation: { enabled: true, validationKey: 'enc', createdAt: '2026-01-01T00:00:00Z' },
      },
    });

    const data = await updateGroup('team', {
      name: '新名',
      servers: ['srv-b'],
      tools: [],
    });

    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      team: {
        name: '新名',
        description: '旧描述',
        servers: ['srv-b'],
        tools: [],
        validation: { enabled: true, validationKey: 'enc', createdAt: '2026-01-01T00:00:00Z' },
      },
    });
    expect(data).toMatchObject({
      id: 'team',
      name: '新名',
      toolFilterMode: 'none',
      validation: { enabled: true, hasKey: true, createdAt: '2026-01-01T00:00:00Z' },
      stats: { totalServers: 1, totalTools: 0 },
    });
  });

  it('非法组 ID 抛 INVALID_GROUP_ID（先于数据校验）', async () => {
    await expect(updateGroup('bad id', { name: 'x' })).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
    });
  });

  it('数据校验失败抛 VALIDATION_ERROR', async () => {
    baseConfig({ team: { servers: [] } });

    await expect(
      updateGroup('team', { description: 123 as unknown as string }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: ['组描述必须是字符串类型'],
    });
  });

  it('组不存在抛 GROUP_NOT_FOUND', async () => {
    baseConfig({});

    await expect(updateGroup('missing', { name: 'x' })).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
      status: 404,
    });
  });

  it('更新时服务器不存在仅告警', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });

    await updateGroup('team', { servers: ['ghost'] });

    expect(configMock.saveConfig).toHaveBeenCalled();
  });

  it('skills 更新走相同的技能校验规则', async () => {
    baseConfig({ team: { servers: [] } });
    const selection = {
      sourceId: 'src1',
      revision: 'a'.repeat(64),
      skill: 'demo-skill',
    };

    await expect(updateGroup('team', { skills: { include: [] } })).rejects.toMatchObject({
      message: '组至少需要服务器或已发布技能',
    });

    skillRepository.catalog.mockRejectedValueOnce(new Error('bad skill'));
    await expect(updateGroup('team', { skills: { include: [selection] } })).rejects.toMatchObject({
      message: '技能发布引用无效',
    });
  });
});

describe('deleteGroup', () => {
  it('删除组并保存剩余配置', async () => {
    baseConfig({ team: { name: '团队' }, other: { servers: [] } });

    const data = await deleteGroup('team');

    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', { other: { servers: [] } });
    expect(data).toEqual({ id: 'team', name: '团队', deleted: true });
  });

  it('非法组 ID 抛 INVALID_GROUP_ID', async () => {
    await expect(deleteGroup('bad id')).rejects.toMatchObject({ code: 'INVALID_GROUP_ID' });
  });

  it('组不存在抛 GROUP_NOT_FOUND', async () => {
    baseConfig({});
    await expect(deleteGroup('missing')).rejects.toMatchObject({ code: 'GROUP_NOT_FOUND' });
  });

  it('默认组禁止删除（403）', async () => {
    baseConfig({ default: { servers: [] } });

    await expect(deleteGroup('default')).rejects.toMatchObject({
      code: 'CANNOT_DELETE_DEFAULT_GROUP',
      status: 403,
      message: '不能删除默认组',
    });
    expect(configMock.saveConfig).not.toHaveBeenCalled();
  });
});
