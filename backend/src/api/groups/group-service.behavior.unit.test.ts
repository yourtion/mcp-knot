/**
 * group-service 行为级测试（变异测试补强）
 *
 * 覆盖 unit.test.ts 未触达的分支与弱断言：
 * - GroupServiceError.name
 * - listGroups 的组处理异常回退（catch 分支）、空配置、缺省字段回退
 * - 各函数的 logger 调用（debug/info/warn/error 精确消息与参数）
 * - reloadCoreServiceManager 的调用与失败告警
 * - 返回结构的全形态断言（toStrictEqual / 键存在性）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreManager = vi.hoisted(() => ({
  getServerConnections: vi.fn(),
  getAllTools: vi.fn(),
  getServerTools: vi.fn(),
}));

const registryMock = vi.hoisted(() => ({
  getCoreServiceManager: vi.fn(),
  reloadCoreServiceManager: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => registryMock);

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
  averageResponseTime: 12.4,
  totalRequests: 7,
  successRate: 88.6,
}));

const getStatsByPathPrefix = vi.hoisted(() => vi.fn(() => perfStats));

vi.mock('../../utils/performance-monitor.js', () => ({
  performanceMonitor: { getStatsByPathPrefix },
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

import { GroupServiceError, type GroupServiceErrorCode } from './group-service.js';
import {
  createGroup,
  deleteGroup,
  getGroupDetail,
  getGroupHealth,
  getGroupServers,
  listGroups,
  updateGroup,
} from './group-service.js';

const ISO_STRING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function baseConfig(groups: Record<string, unknown>): void {
  configMock.getAllConfig.mockResolvedValue({
    mcps: { servers: { 'srv-a': {}, 'srv-b': {} } },
    groups,
  });
}

function expectServiceError(
  promise: Promise<unknown>,
  code: GroupServiceErrorCode,
  status: number,
  message: string,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'GroupServiceError',
    code,
    status,
    message,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  registryMock.getCoreServiceManager.mockResolvedValue(coreManager);
  registryMock.reloadCoreServiceManager.mockResolvedValue(coreManager);
  configMock.saveConfig.mockResolvedValue(undefined);
  coreManager.getAllTools.mockResolvedValue([]);
  coreManager.getServerTools.mockResolvedValue([]);
  coreManager.getServerConnections.mockReturnValue(new Map());
  getStatsByPathPrefix.mockClear();
  getStatsByPathPrefix.mockReturnValue(perfStats);
});

describe('GroupServiceError 结构', () => {
  it('name 固定为 GroupServiceError 且不携带多余 details', () => {
    const error = new GroupServiceError('GROUP_NOT_FOUND', 'x', 404);
    expect(error.name).toBe('GroupServiceError');
    expect(error.code).toBe('GROUP_NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.message).toBe('x');
    // details 恒被赋值（无参时为 undefined）
    expect(error.details).toBeUndefined();
  });
});

describe('listGroups 行为补强', () => {
  it('空配置时返回零值摘要且不产生 issue', async () => {
    baseConfig({});

    const data = await listGroups();

    expect(data).toStrictEqual({
      groups: [],
      totalGroups: 0,
      healthyGroups: 0,
      unhealthyGroups: 0,
      totalServers: 0,
      connectedServers: 0,
      totalTools: 0,
      filteredTools: 0,
      averageHealthScore: 0,
      groupsWithValidation: 0,
      groupsWithToolFilter: 0,
      summary: { status: 'unhealthy', issues: [] },
    });
  });

  it('组缺失 servers/tools 等字段时逐项回退默认值', async () => {
    baseConfig({ bare: {} });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', serverId: 'srv-a' },
      { name: 'tool-b', serverId: 'srv-b' },
    ]);

    const data = await listGroups();
    const bare = data.groups[0];

    // servers 缺失 → 空数组；tools 缺失 → 不过滤全部组内工具
    expect(bare).toStrictEqual({
      id: 'bare',
      name: 'bare',
      description: '',
      servers: [],
      serverCount: 0,
      connectedServers: 0,
      toolCount: 0,
      filteredToolCount: 0,
      tools: [],
      toolFilterMode: 'none',
      isHealthy: false,
      healthScore: 0,
      validation: {
        enabled: false,
        hasKey: false,
        createdAt: undefined,
        lastUpdated: undefined,
      },
      stats: {
        totalServers: 0,
        availableServers: 0,
        totalTools: 0,
        filteredTools: 0,
        healthPercentage: 0,
      },
      lastUpdated: expect.stringMatching(ISO_STRING),
    });
    expect(data.groupsWithToolFilter).toBe(0);
    expect(data.averageHealthScore).toBe(0);
  });

  it('tools 为空数组时不过滤组内工具且 summary 不计入 toolFilter', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', serverId: 'srv-a' },
      { name: 'tool-b', serverId: 'srv-a' },
    ]);

    const data = await listGroups();

    expect(data.groups[0].filteredToolCount).toBe(2);
    expect(data.groups[0].toolFilterMode).toBe('none');
    expect(data.groupsWithToolFilter).toBe(0);
    expect(data.filteredTools).toBe(2);
  });

  it('validation.lastUpdated 存在时作为组的 lastUpdated', async () => {
    baseConfig({
      team: { servers: [], validation: { lastUpdated: '2026-02-02T08:00:00.000Z' } },
    });

    const data = await listGroups();

    expect(data.groups[0].lastUpdated).toBe('2026-02-02T08:00:00.000Z');
  });

  it('未配置 skills 的组不包含 skills 键', async () => {
    baseConfig({ team: { servers: [], tools: [] } });

    const data = await listGroups();

    expect(Object.keys(data.groups[0])).not.toContain('skills');
  });

  it('组配置异常时走兜底分支并计入错误 issue', async () => {
    // servers 为字符串时 groupServers.filter 抛 TypeError，触发外层 catch
    baseConfig({ broken: { servers: 'oops', description: 'd' }, ok: { servers: ['srv-a'] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));

    const data = await listGroups();

    const broken = data.groups.find((g) => g.id === 'broken');
    expect(broken).toStrictEqual({
      id: 'broken',
      name: 'broken',
      description: 'd',
      servers: 'oops',
      serverCount: 4,
      connectedServers: 0,
      toolCount: 0,
      filteredToolCount: 0,
      tools: [],
      toolFilterMode: 'none',
      isHealthy: false,
      healthScore: 0,
      validation: { enabled: false, hasKey: false },
      stats: {
        totalServers: 4,
        availableServers: 0,
        totalTools: 0,
        filteredTools: 0,
        healthPercentage: 0,
      },
      lastUpdated: expect.stringMatching(ISO_STRING),
      error: 'groupServers.filter is not a function',
    });
    expect(data.summary.issues).toEqual(['部分组健康度较低', '部分组存在错误']);
    expect(loggerMock.error).toHaveBeenCalledWith('处理组信息时出错', expect.any(TypeError), {
      groupId: 'broken',
    });
  });

  it('健康度恰为 50 的组不触发 healthScore issue，混合组触发', async () => {
    baseConfig({ half: { servers: ['srv-a', 'srv-b'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));

    const data = await listGroups();

    expect(data.groups[0].healthScore).toBe(50);
    expect(data.summary.issues).toEqual([]);
    // 有连接即视为 healthy，全部 healthy 时 summary 为 healthy
    expect(data.summary.status).toBe('healthy');
  });

  it('getAllTools 返回 undefined 时按空工具处理且不告警', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue(undefined);

    const data = await listGroups();

    expect(data.groups[0].toolCount).toBe(0);
    expect(data.groups[0].filteredToolCount).toBe(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('记录 debug 与完成 info 日志', async () => {
    baseConfig({ team: { servers: [], tools: [] } });

    await listGroups();

    expect(loggerMock.debug).toHaveBeenCalledWith('获取所有组列表');
    expect(loggerMock.info).toHaveBeenCalledWith('组列表查询完成', {
      totalGroups: 1,
      healthyGroups: 0,
      totalTools: 0,
    });
  });

  it('获取组工具失败时告警且不影响列表', async () => {
    baseConfig({ team: { servers: [], tools: [] } });
    coreManager.getAllTools.mockRejectedValue(new Error('上游不可用'));

    await listGroups();

    expect(loggerMock.warn).toHaveBeenCalledWith('获取组工具数量失败', {
      groupId: 'team',
      error: '上游不可用',
    });
  });
});

describe('getGroupDetail 行为补强', () => {
  it('组缺失 servers/tools/validation 字段时全量回退', async () => {
    baseConfig({ bare: {} });

    const data = await getGroupDetail('bare');

    expect(data).toStrictEqual({
      id: 'bare',
      name: 'bare',
      description: '',
      servers: [],
      serverCount: 0,
      connectedServers: 0,
      tools: [],
      toolCount: 0,
      toolFilter: [],
      toolFilterMode: 'none',
      isHealthy: false,
      healthScore: 0,
      validation: {
        enabled: false,
        hasKey: false,
        validationKey: undefined,
        createdAt: undefined,
        lastUpdated: undefined,
      },
      stats: { totalServers: 0, availableServers: 0, totalTools: 0, healthPercentage: 0 },
      performance: {
        averageResponseTime: 12,
        totalRequests: 7,
        successRate: 89,
      },
      accessControl: { requiresValidation: false, toolAccessRestricted: undefined },
      lastUpdated: expect.stringMatching(ISO_STRING),
      timestamp: expect.stringMatching(ISO_STRING),
    });
    expect('skills' in data).toBe(false);
    // performance 查询按组路径前缀
    expect(getStatsByPathPrefix).toHaveBeenCalledWith('/bare/mcp');
  });

  it('tools 为空数组时不过滤组内工具', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', serverId: 'srv-a', extra: 'strip-me' },
      { name: 'tool-b', serverId: 'srv-a', extra: 'strip-me' },
    ]);

    const data = await getGroupDetail('team');

    expect(data.toolCount).toBe(2);
    // 工具映射仅保留固定字段
    expect(data.tools).toStrictEqual([
      {
        name: 'tool-a',
        description: undefined,
        serverId: 'srv-a',
        parameters: undefined,
        category: undefined,
      },
      {
        name: 'tool-b',
        description: undefined,
        serverId: 'srv-a',
        parameters: undefined,
        category: undefined,
      },
    ]);
  });

  it('组外与无 serverId 的工具不进入详情', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-ok', serverId: 'srv-a' },
      { name: 'tool-other', serverId: 'srv-other' },
      { name: 'tool-nosrv' },
    ]);

    const data = await getGroupDetail('team');

    expect(data.tools.map((tool) => tool.name)).toEqual(['tool-ok']);
  });

  it('两个服务器均连接时 connectedServers/isHealthy 完整统计', async () => {
    baseConfig({ team: { servers: ['srv-a', 'srv-b'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(
      new Map([
        ['srv-a', { status: 'connected' }],
        ['srv-b', { status: 'connected' }],
      ]),
    );

    const data = await getGroupDetail('team');

    expect(data.connectedServers).toBe(2);
    expect(data.isHealthy).toBe(true);
    expect(data.healthScore).toBe(100);
    expect(data.stats).toStrictEqual({
      totalServers: 2,
      availableServers: 2,
      totalTools: 0,
      healthPercentage: 100,
    });
  });

  it('组不存在时错误对象结构与日志', async () => {
    baseConfig({});

    await expectServiceError(
      getGroupDetail('missing'),
      'GROUP_NOT_FOUND',
      404,
      "组 'missing' 不存在",
    );
    expect(loggerMock.debug).toHaveBeenCalledWith('获取组详细信息', { groupId: 'missing' });
  });

  it('获取组工具失败时告警', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockRejectedValue(new Error('工具服务异常'));

    await getGroupDetail('team');

    expect(loggerMock.warn).toHaveBeenCalledWith('获取组工具失败', {
      groupId: 'team',
      error: '工具服务异常',
    });
    expect(loggerMock.info).toHaveBeenCalledWith('组详细信息查询完成', {
      groupId: 'team',
      serverCount: 1,
      connectedServers: 0,
      toolCount: 0,
    });
  });
});

describe('getGroupHealth 行为补强', () => {
  it('组缺失 servers 字段时健康度为 0 且返回 503', async () => {
    baseConfig({ bare: {} });

    const { data, status } = await getGroupHealth('bare');

    expect(status).toBe(503);
    expect(data.healthScore).toBe(0);
    expect(data.servers).toStrictEqual({
      total: 0,
      healthy: 0,
      unhealthy: 0,
      details: [],
    });
    expect(data.issues).toEqual(['没有可用的服务器连接', '没有可用的工具', '服务器健康度较低: 0%']);
    expect(data.tools).toStrictEqual({ available: 0, total: 0 });
  });

  it('健康度恰为 50 且有工具时不产生健康度 issue', async () => {
    baseConfig({ half: { servers: ['srv-a', 'srv-b'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const { data, status } = await getGroupHealth('half');

    expect(status).toBe(200);
    expect(data.healthScore).toBe(50);
    expect(data.issues).toEqual([]);
    expect(data.servers.details).toStrictEqual([
      {
        serverId: 'srv-a',
        healthy: true,
        status: 'connected',
        lastConnected: undefined,
        error: undefined,
        toolCount: 0,
      },
      {
        serverId: 'srv-b',
        healthy: undefined,
        status: 'unknown',
        lastConnected: undefined,
        error: undefined,
        toolCount: 0,
      },
    ]);
  });

  it('details 中状态与工具计数取自连接信息', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    const lastConnected = new Date('2026-03-03T00:00:00Z');
    coreManager.getServerConnections.mockReturnValue(
      new Map([['srv-a', { status: 'connected', lastConnected, tools: [{}, {}] }]]),
    );
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const { data } = await getGroupHealth('team');

    expect(data.servers.details[0]).toStrictEqual({
      serverId: 'srv-a',
      healthy: true,
      status: 'connected',
      lastConnected: '2026-03-03T00:00:00.000Z',
      error: undefined,
      toolCount: 2,
    });
    // 组未配置 tools 字段 → total 取组内工具数
    expect(data.tools).toStrictEqual({ available: 1, total: 1 });
  });

  it('无 serverId 的工具不计入可用工具', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-ok', serverId: 'srv-a' },
      { name: 'tool-nosrv' },
    ]);

    const { data } = await getGroupHealth('team');

    expect(data.tools).toStrictEqual({ available: 1, total: 1 });
  });

  it('getAllTools 失败时告警并按无工具处理', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));
    coreManager.getAllTools.mockRejectedValue(new Error('探测失败'));

    const { data, status } = await getGroupHealth('team');

    expect(status).toBe(503);
    expect(data.tools).toStrictEqual({ available: 0, total: 0 });
    expect(data.issues).toEqual(['没有可用的工具']);
    expect(loggerMock.warn).toHaveBeenCalledWith('检查组工具健康状态失败', {
      groupId: 'team',
      error: '探测失败',
    });
  });
});

describe('getGroupServers 行为补强', () => {
  it('组缺失 servers 字段时返回空列表且健康度为 0', async () => {
    baseConfig({ bare: {} });

    const data = await getGroupServers('bare');

    expect(data).toStrictEqual({
      groupId: 'bare',
      servers: [],
      totalServers: 0,
      connectedServers: 0,
      disconnectedServers: 0,
      totalTools: 0,
      healthScore: 0,
    });
  });

  it('连接无 lastConnected 时不报错且字段为 undefined', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getServerConnections.mockReturnValue(new Map([['srv-a', { status: 'connected' }]]));
    coreManager.getServerTools.mockResolvedValue(undefined);

    const data = await getGroupServers('team');

    expect(data.servers[0]).toStrictEqual({
      id: 'srv-a',
      status: 'connected',
      lastConnected: undefined,
      lastError: undefined,
      tools: [],
      toolCount: 0,
      isHealthy: true,
    });
    expect(data.totalTools).toBe(0);
    expect(data.healthScore).toBe(100);
  });

  it('获取服务器工具失败时告警且日志完整', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getServerTools.mockRejectedValue(new Error('超时'));

    await getGroupServers('team');

    expect(loggerMock.warn).toHaveBeenCalledWith('获取服务器工具失败', {
      serverId: 'srv-a',
      error: '超时',
    });
    expect(loggerMock.info).toHaveBeenCalledWith('组服务器列表查询完成', {
      groupId: 'team',
      totalServers: 1,
      connectedServers: 0,
      totalTools: 0,
    });
  });
});

describe('createGroup 行为补强', () => {
  const baseBody = { id: 'new-group', name: '新组', servers: ['srv-a'], tools: ['tool-a'] };

  it('数据校验失败时错误消息与结构精确', async () => {
    baseConfig({});

    await expectServiceError(
      createGroup({ ...baseBody, name: '' }),
      'VALIDATION_ERROR',
      400,
      '请求数据验证失败',
    );
    expect(loggerMock.debug).toHaveBeenCalledWith('创建新组请求', {
      body: { ...baseBody, name: '' },
    });
  });

  it('描述缺省时返回空字符串且返回结构完整', async () => {
    baseConfig({});

    const data = await createGroup({ ...baseBody, tools: [] });

    expect(data).toStrictEqual({
      id: 'new-group',
      name: '新组',
      description: '',
      servers: ['srv-a'],
      tools: [],
      toolFilterMode: 'none',
      validation: { enabled: false, hasKey: false },
      stats: {
        totalServers: 1,
        availableServers: 0,
        totalTools: 0,
        filteredTools: 0,
        healthPercentage: 0,
      },
      accessControl: { requiresValidation: false, toolAccessRestricted: false },
      lastUpdated: expect.stringMatching(ISO_STRING),
    });
    expect(registryMock.reloadCoreServiceManager).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith('组创建成功', {
      groupId: 'new-group',
      groupName: '新组',
      serverCount: 1,
      toolCount: 0,
    });
  });

  it('部分服务器不存在时告警携带精确的 invalidServers', async () => {
    baseConfig({});

    await createGroup({ ...baseBody, servers: ['srv-a', 'ghost-1', 'ghost-2'] });

    expect(loggerMock.warn).toHaveBeenCalledWith('创建组时发现不存在的服务器', {
      groupId: 'new-group',
      invalidServers: ['ghost-1', 'ghost-2'],
    });
  });

  it('服务器全部存在时不产生服务器告警', async () => {
    baseConfig({});

    await createGroup(baseBody);

    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      '创建组时发现不存在的服务器',
      expect.anything(),
    );
  });

  it('未提供 skills 时不调用技能仓库', async () => {
    baseConfig({});

    await createGroup(baseBody);

    expect(skillRepository.catalog).not.toHaveBeenCalled();
  });

  it('重新初始化核心服务失败时仅告警不阻断', async () => {
    baseConfig({});
    registryMock.reloadCoreServiceManager.mockRejectedValueOnce(new Error('重载失败'));

    const data = await createGroup(baseBody);

    expect(data.id).toBe('new-group');
    expect(loggerMock.warn).toHaveBeenCalledWith('重新初始化核心服务管理器失败', {
      error: '重载失败',
    });
  });

  it('tools 缺省时按空数组保存（日志中 body.tools.length 会抛 TypeError，记录现状）', async () => {
    baseConfig({});
    const { tools: _tools, ...bodyWithoutTools } = baseBody;

    // 已知缺陷：logger.info 中 body.tools.length 未做缺省保护，最终以 TypeError 拒绝
    await expect(createGroup(bodyWithoutTools)).rejects.toThrow(TypeError);

    // 保存动作已完成，且 newGroup.tools 回退为空数组
    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      'new-group': {
        id: 'new-group',
        name: '新组',
        description: '',
        servers: ['srv-a'],
        tools: [],
      },
    });
  });
});

describe('updateGroup 行为补强', () => {
  it('数据校验失败时错误消息与结构精确', async () => {
    baseConfig({ team: { servers: [] } });

    await expectServiceError(
      updateGroup('team', { description: 123 as unknown as string }),
      'VALIDATION_ERROR',
      400,
      '请求数据验证失败',
    );
  });

  it('skills 校验错误保留 code 与 details', async () => {
    const selection = {
      sourceId: 'src1',
      revision: 'a'.repeat(64),
      skill: 'demo-skill',
    };

    // 组无服务器且未发布技能 → 拒绝
    baseConfig({ team: { servers: [], tools: [] } });
    await expectServiceError(
      updateGroup('team', { skills: { include: [] } }),
      'VALIDATION_ERROR',
      400,
      '组至少需要服务器或已发布技能',
    );

    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    skillRepository.catalog.mockRejectedValueOnce(new Error('bad skill'));
    const error = await updateGroup('team', { skills: { include: [selection] } }).catch(
      (err: GroupServiceError) => err,
    );
    expect(error).toMatchObject({
      name: 'GroupServiceError',
      code: 'VALIDATION_ERROR',
      status: 400,
      message: '技能发布引用无效',
      details: ['bad skill'],
    });
  });

  it('skills 有效时调用仓库编目并保存完整配置', async () => {
    baseConfig({ team: { name: '旧名', servers: ['srv-a'], tools: [] } });
    const selection = {
      sourceId: 'src1',
      revision: 'a'.repeat(64),
      skill: 'demo-skill',
    };
    skillRepository.catalog.mockResolvedValueOnce([]);

    const data = await updateGroup('team', { skills: { include: [selection] } });

    expect(skillRepository.catalog).toHaveBeenCalledWith({ include: [selection] }, 'team');
    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      team: { name: '旧名', servers: ['srv-a'], tools: [], skills: { include: [selection] } },
    });
    expect(data.skills).toEqual({ include: [selection] });
    expect(data.toolFilterMode).toBe('none');
  });

  it('更新含无效服务器时告警，未提供 servers 时不告警', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });

    await updateGroup('team', { servers: ['srv-a', 'ghost'] });
    expect(loggerMock.warn).toHaveBeenCalledWith('更新组时发现不存在的服务器', {
      groupId: 'team',
      invalidServers: ['ghost'],
    });

    loggerMock.warn.mockClear();
    await updateGroup('team', { name: '新名' });
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('更新后调用 reload，失败时仅告警', async () => {
    baseConfig({ team: { servers: [], tools: [], description: 'keep' } });

    await updateGroup('team', { name: '新名' });
    expect(registryMock.reloadCoreServiceManager).toHaveBeenCalledTimes(1);

    registryMock.reloadCoreServiceManager.mockRejectedValueOnce(new Error('重载失败'));
    const data = await updateGroup('team', { name: '另一名' });
    expect(data.name).toBe('另一名');
    expect(loggerMock.warn).toHaveBeenCalledWith('重新初始化核心服务管理器失败', {
      error: '重载失败',
    });
  });

  it('原组无 description/validation 时返回结构逐项回退', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });

    const data = await updateGroup('team', { tools: ['tool-a'] });

    expect(data).toStrictEqual({
      id: 'team',
      name: undefined,
      description: '',
      servers: ['srv-a'],
      tools: ['tool-a'],
      toolFilterMode: 'whitelist',
      validation: {
        enabled: false,
        hasKey: false,
        createdAt: undefined,
        lastUpdated: undefined,
      },
      stats: {
        totalServers: 1,
        availableServers: 0,
        totalTools: 1,
        filteredTools: 1,
        healthPercentage: 0,
      },
      accessControl: { requiresValidation: false, toolAccessRestricted: true },
      lastUpdated: expect.stringMatching(ISO_STRING),
    });
    expect('skills' in data).toBe(false);
  });

  it('仅更新 name 时其余字段保持原值', async () => {
    baseConfig({
      team: {
        name: '旧名',
        description: '旧描述',
        servers: ['srv-a'],
        tools: ['tool-a'],
      },
    });

    await updateGroup('team', { name: '新名' });

    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      team: {
        name: '新名',
        description: '旧描述',
        servers: ['srv-a'],
        tools: ['tool-a'],
      },
    });
  });
});

describe('deleteGroup 行为补强', () => {
  it('删除后调用 reload，失败时仅告警', async () => {
    baseConfig({ team: { name: '团队' } });

    await deleteGroup('team');
    expect(registryMock.reloadCoreServiceManager).toHaveBeenCalledTimes(1);

    registryMock.reloadCoreServiceManager.mockRejectedValueOnce(new Error('重载失败'));
    const data = await deleteGroup('team');
    expect(data).toStrictEqual({ id: 'team', name: '团队', deleted: true });
    expect(loggerMock.warn).toHaveBeenCalledWith('重新初始化核心服务管理器失败', {
      error: '重载失败',
    });
    expect(loggerMock.info).toHaveBeenCalledWith('组删除成功', {
      groupId: 'team',
      groupName: '团队',
    });
  });

  it('非法组 ID 的错误结构与消息精确', async () => {
    await expectServiceError(
      deleteGroup('bad id'),
      'INVALID_GROUP_ID',
      400,
      '组ID只能包含字母、数字、连字符和下划线',
    );
  });
});
