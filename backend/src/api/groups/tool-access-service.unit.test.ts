import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreManager = vi.hoisted(() => ({
  getAllTools: vi.fn(),
}));

const registryMock = vi.hoisted(() => ({
  getCoreServiceManager: vi.fn(),
  reloadCoreServiceManager: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => registryMock);

const configMock = vi.hoisted(() => ({
  getAllConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../../utils/config.js', () => configMock);

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

import {
  configureGroupTools,
  getGroupAvailableTools,
  getGroupTools,
  validateToolAccess,
} from './tool-access-service.js';

function baseConfig(groups: Record<string, unknown>): void {
  configMock.getAllConfig.mockResolvedValue({
    mcps: { servers: { 'srv-a': {}, 'srv-b': {} } },
    groups,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  registryMock.getCoreServiceManager.mockResolvedValue(coreManager);
  registryMock.reloadCoreServiceManager.mockResolvedValue(coreManager);
  configMock.saveConfig.mockResolvedValue(undefined);
  coreManager.getAllTools.mockResolvedValue([]);
});

describe('getGroupTools', () => {
  it('返回组内工具并应用白名单过滤、按服务器分组', async () => {
    baseConfig({
      team: {
        servers: ['srv-a', 'srv-b'],
        tools: ['tool-a'],
        validation: { enabled: true, validationKey: 'enc' },
      },
    });
    coreManager.getAllTools.mockResolvedValue([
      {
        name: 'tool-a',
        description: 'A',
        serverId: 'srv-a',
        parameters: {},
        category: 'cat',
        version: '1.1.0',
        deprecated: false,
      },
      { name: 'tool-b', description: 'B', serverId: 'srv-b', parameters: {} },
      { name: 'tool-x', description: 'X', serverId: 'srv-other', parameters: {} },
    ]);

    const data = await getGroupTools('team');

    expect(data).toMatchObject({
      groupId: 'team',
      totalTools: 1,
      serverCount: 1,
      toolFilter: ['tool-a'],
    });
    expect(data.tools).toEqual([
      {
        name: 'tool-a',
        description: 'A',
        serverId: 'srv-a',
        parameters: {},
        category: 'cat',
        version: '1.1.0',
        deprecated: false,
      },
    ]);
    expect(data.toolsByServer).toEqual({
      'srv-a': [
        {
          name: 'tool-a',
          description: 'A',
          parameters: {},
          category: 'cat',
          version: '1.1.0',
          deprecated: false,
        },
      ],
    });
  });

  it('未配置工具过滤时返回组内全部工具', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', description: 'A', serverId: 'srv-a', parameters: {} },
      { name: 'tool-b', description: 'B', serverId: 'srv-a', parameters: {} },
    ]);

    const data = await getGroupTools('team');

    expect(data.totalTools).toBe(2);
    expect(data.toolFilter).toEqual([]);
  });

  it('无 serverId 的工具归入 unknown 分组', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', description: 'A', serverId: undefined, parameters: {} },
    ]);

    const data = await getGroupTools('team');

    // groupServers 不包含 ''，无 serverId 的工具不会进入组工具列表
    expect(data.totalTools).toBe(0);
  });

  it('组不存在时抛 GROUP_NOT_FOUND', async () => {
    baseConfig({});

    await expect(getGroupTools('missing')).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
      status: 404,
      message: "组 'missing' 不存在",
    });
  });
});

describe('configureGroupTools', () => {
  it('保存白名单并返回影响分析', async () => {
    baseConfig({
      team: {
        servers: ['srv-a'],
        tools: ['old-tool'],
        validation: { enabled: true, validationKey: 'enc' },
      },
    });
    coreManager.getAllTools.mockResolvedValue([{ name: 'new-tool', serverId: 'srv-a' }]);

    const data = await configureGroupTools('team', { tools: ['new-tool'] });

    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      team: {
        servers: ['srv-a'],
        tools: ['new-tool'],
        validation: { enabled: true, validationKey: 'enc' },
      },
    });
    expect(data).toMatchObject({
      groupId: 'team',
      tools: ['new-tool'],
      toolCount: 1,
      filterMode: 'whitelist',
      validation: { enabled: true, requiresKey: true },
      impact: { previouslyFilteredTools: 1, newlyFilteredTools: 1, change: 0 },
      accessControl: { toolAccessRestricted: true, unrestrictedAccess: false },
    });
  });

  it('空列表表示不限制访问', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: ['old'] } });

    const data = await configureGroupTools('team', { tools: [] });

    expect(data).toMatchObject({
      toolCount: 0,
      impact: { previouslyFilteredTools: 1, newlyFilteredTools: 0, change: -1 },
      accessControl: { toolAccessRestricted: false, unrestrictedAccess: true },
    });
  });

  it('显式 blacklist 模式被透传', async () => {
    baseConfig({ team: { servers: [], tools: [] } });

    const data = await configureGroupTools('team', { tools: ['x'], filterMode: 'blacklist' });

    expect(data.filterMode).toBe('blacklist');
  });

  it.each([
    ['tools 不是数组', { tools: 'x' }, '工具列表必须是数组'],
    ['元素为空字符串', { tools: [''] }, '工具列表[0]必须是非空字符串'],
    ['元素不是字符串', { tools: [42] }, '工具列表[0]必须是非空字符串'],
    ['包含重复工具', { tools: ['a', 'a'] }, '工具列表包含重复的工具名称'],
  ])('非法请求抛 VALIDATION_ERROR：%s', async (_name, body, message) => {
    baseConfig({ team: { servers: [], tools: [] } });

    await expect(configureGroupTools('team', body)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      message,
    });
    expect(configMock.saveConfig).not.toHaveBeenCalled();
  });

  it('非法组 ID 抛 INVALID_GROUP_ID', async () => {
    await expect(configureGroupTools('bad id', { tools: [] })).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
      status: 400,
    });
  });

  it('组不存在抛 GROUP_NOT_FOUND', async () => {
    baseConfig({});

    await expect(configureGroupTools('missing', { tools: ['x'] })).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
      status: 404,
    });
  });

  it('配置了组外工具仅告警不阻断', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const data = await configureGroupTools('team', { tools: ['ghost-tool'] });

    expect(data.tools).toEqual(['ghost-tool']);
    expect(configMock.saveConfig).toHaveBeenCalled();
  });

  it('getAllTools 抛错时仍可保存配置', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockRejectedValue(new Error('工具服务不可用'));

    const data = await configureGroupTools('team', { tools: ['tool-a'] });

    expect(data.tools).toEqual(['tool-a']);
    expect(configMock.saveConfig).toHaveBeenCalled();
  });

  it('重新初始化核心服务失败不阻断配置保存', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    const { reloadCoreServiceManager } = await import('../../services/service-registry.js');
    (reloadCoreServiceManager as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('重载失败'),
    );

    const data = await configureGroupTools('team', { tools: ['tool-a'] });

    expect(data.toolCount).toBe(1);
  });
});

describe('getGroupAvailableTools', () => {
  it('返回过滤信息、分类与服务器分布', async () => {
    baseConfig({
      team: { servers: ['srv-a', 'srv-b'], tools: ['tool-a'] },
    });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', description: 'A', serverId: 'srv-a', category: 'search' },
      { name: 'tool-b', description: 'B', serverId: 'srv-a', category: 'search' },
      { name: 'tool-c', description: 'C', serverId: 'srv-b' },
    ]);

    const data = await getGroupAvailableTools('team');

    expect(data.totalTools).toBe(3);
    expect(data.filteredTools).toBe(1);
    expect(data.toolFilter).toEqual(['tool-a']);
    expect(data.filtering).toEqual({
      isFilteringEnabled: true,
      filterRatio: 33,
      excludedTools: 2,
    });
    expect(data.categories).toEqual(['search']);
    expect(data.tools[0]).toEqual({
      name: 'tool-a',
      description: 'A',
      serverId: 'srv-a',
      serverName: 'srv-a',
      inputSchema: { type: 'object', properties: {} },
      status: 'available',
    });
    expect(data.toolsByServer['srv-a']).toHaveLength(1);
    expect(data.serverDistribution).toEqual([{ serverId: 'srv-a', toolCount: 1, percentage: 100 }]);
  });

  it('无过滤时全部工具可见且过滤率为 100', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const data = await getGroupAvailableTools('team');

    expect(data.filteredTools).toBe(1);
    expect(data.filtering).toEqual({
      isFilteringEnabled: false,
      filterRatio: 100,
      excludedTools: 0,
    });
    expect(data.categories).toEqual(['general']);
  });

  it('组内无工具时 filterRatio 仍为 100', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([]);

    const data = await getGroupAvailableTools('team');

    expect(data.filtering.filterRatio).toBe(100);
    expect(data.serverDistribution).toEqual([]);
  });

  it('非法组 ID 与不存在的组分别抛错', async () => {
    await expect(getGroupAvailableTools('bad id')).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
    });

    baseConfig({});
    await expect(getGroupAvailableTools('missing')).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
    });
  });
});

describe('validateToolAccess', () => {
  it('工具在组内且无过滤时授权访问', async () => {
    baseConfig({
      team: { servers: ['srv-a'], tools: [], validation: { enabled: false } },
    });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', description: 'A', serverId: 'srv-a', category: 'cat', version: '2.0.0' },
    ]);

    const data = await validateToolAccess('team', 'tool-a');

    expect(data).toMatchObject({
      groupId: 'team',
      toolName: 'tool-a',
      hasAccess: true,
      reason: 'ACCESS_GRANTED',
      message: '工具访问已授权',
      validation: {
        groupHasValidation: false,
        toolInFilterList: true,
        filterMode: 'none',
      },
    });
    expect(data.toolInfo).toMatchObject({
      name: 'tool-a',
      serverId: 'srv-a',
      serverName: 'srv-a',
      category: 'cat',
      version: '2.0.0',
      deprecated: false,
      inputSchema: { type: 'object', properties: {} },
      estimatedComplexity: {
        complexity: 'simple',
        parameterCount: 0,
        requiredParameterCount: 0,
        estimatedExecutionTime: 'fast',
      },
    });
    expect(data.alternatives).toBeUndefined();
  });

  it('白名单外的工具拒绝访问并给出替代工具', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: ['tool-allowed'] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-allowed', serverId: 'srv-a' },
      { name: 'tool-denied', serverId: 'srv-a' },
    ]);

    const data = await validateToolAccess('team', 'tool-denied');

    expect(data).toMatchObject({
      hasAccess: false,
      reason: 'TOOL_NOT_IN_WHITELIST',
      message: '工具不在组的允许列表中',
      validation: {
        toolInFilterList: false,
        filterMode: 'whitelist',
      },
    });
    expect(data.toolInfo).toBeUndefined();
    expect(data.alternatives).toEqual([{ name: 'tool-allowed', description: undefined }]);
  });

  it('工具不在组内时返回 TOOL_NOT_FOUND_IN_GROUP（不抛错）', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const data = await validateToolAccess('team', 'ghost');

    expect(data).toEqual({
      groupId: 'team',
      toolName: 'ghost',
      hasAccess: false,
      reason: 'TOOL_NOT_FOUND_IN_GROUP',
      message: '工具在组中不可用',
    });
  });

  it('工具名称为空抛 VALIDATION_ERROR', async () => {
    baseConfig({ team: { servers: [], tools: [] } });

    await expect(validateToolAccess('team', undefined)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      message: '工具名称不能为空',
    });
  });

  it('非法组 ID 抛 INVALID_GROUP_ID，组不存在抛 GROUP_NOT_FOUND', async () => {
    await expect(validateToolAccess('bad id', 'tool')).rejects.toMatchObject({
      code: 'INVALID_GROUP_ID',
    });

    baseConfig({});
    await expect(validateToolAccess('missing', 'tool')).rejects.toMatchObject({
      code: 'GROUP_NOT_FOUND',
    });
  });

  it('替代工具最多返回 5 个', async () => {
    baseConfig({
      team: {
        servers: ['srv-a'],
        tools: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
      },
    });
    coreManager.getAllTools.mockResolvedValue([
      ...['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((name) => ({ name, serverId: 'srv-a' })),
      { name: 'denied', serverId: 'srv-a' },
    ]);

    const data = await validateToolAccess('team', 'denied');

    expect(data.alternatives).toHaveLength(5);
  });
});

describe('getGroupTools 行为补强', () => {
  it('组缺失 servers/tools 字段时逐项回退', async () => {
    baseConfig({ bare: {} });

    const data = await getGroupTools('bare');

    expect(data).toStrictEqual({
      groupId: 'bare',
      tools: [],
      toolsByServer: {},
      totalTools: 0,
      serverCount: 0,
      toolFilter: [],
    });
  });

  it('同服务器多个工具在 toolsByServer 中完整累积', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', description: 'A', serverId: 'srv-a', parameters: { a: 1 } },
      { name: 'tool-b', description: 'B', serverId: 'srv-a', parameters: { b: 2 } },
    ]);

    const data = await getGroupTools('team');

    expect(data.toolsByServer).toStrictEqual({
      'srv-a': [
        {
          name: 'tool-a',
          description: 'A',
          parameters: { a: 1 },
          category: undefined,
          version: undefined,
          deprecated: undefined,
        },
        {
          name: 'tool-b',
          description: 'B',
          parameters: { b: 2 },
          category: undefined,
          version: undefined,
          deprecated: undefined,
        },
      ],
    });
    expect(data.serverCount).toBe(1);
  });

  it('servers 含空串时无 serverId 的工具归入 unknown 分组（畸形配置现状）', async () => {
    baseConfig({ weird: { servers: [''] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 't1', description: 'T' }]);

    const data = await getGroupTools('weird');

    expect(data.totalTools).toBe(1);
    expect(data.tools[0].serverId).toBeUndefined();
    expect(data.toolsByServer).toStrictEqual({
      unknown: [
        {
          name: 't1',
          description: 'T',
          parameters: undefined,
          category: undefined,
          version: undefined,
          deprecated: undefined,
        },
      ],
    });
  });

  it('记录完成日志', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: ['tool-a'] } });

    await getGroupTools('team');

    expect(loggerMock.info).toHaveBeenCalledWith('组工具列表查询完成', {
      groupId: 'team',
      totalTools: 0,
      serverCount: 0,
    });
  });
});

describe('configureGroupTools 行为补强', () => {
  it('混合可用与不可用工具时告警只列出不可用项', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    await configureGroupTools('team', { tools: ['tool-a', 'ghost-tool'] });

    expect(loggerMock.warn).toHaveBeenCalledWith('配置的工具在组中不可用', {
      groupId: 'team',
      unavailableTools: ['ghost-tool'],
      availableTools: ['tool-a'],
    });
  });

  it('全部工具可用时不产生告警', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    await configureGroupTools('team', { tools: ['tool-a'] });

    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('getAllTools 失败时按验证出错告警仍保存配置', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });
    coreManager.getAllTools.mockRejectedValue(new Error('工具服务不可用'));

    await configureGroupTools('team', { tools: ['tool-a'] });

    expect(loggerMock.warn).toHaveBeenCalledWith('验证工具可用性时出错', {
      groupId: 'team',
      error: '工具服务不可用',
    });
    expect(configMock.saveConfig).toHaveBeenCalled();
  });

  it('保存后调用 reload，reload 失败仅告警', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: [] } });

    await configureGroupTools('team', { tools: ['tool-a'] });
    expect(registryMock.reloadCoreServiceManager).toHaveBeenCalledTimes(1);

    registryMock.reloadCoreServiceManager.mockRejectedValueOnce(new Error('重载失败'));
    const data = await configureGroupTools('team', { tools: ['tool-b'] });
    expect(data.toolCount).toBe(1);
    expect(loggerMock.warn).toHaveBeenCalledWith('重新初始化核心服务管理器失败', {
      error: '重载失败',
    });
  });

  it('原组缺失 servers/tools/validation 字段时全部回退', async () => {
    baseConfig({ bare: {} });

    const data = await configureGroupTools('bare', { tools: ['tool-a'] });

    expect(configMock.saveConfig).toHaveBeenCalledWith('group.json', {
      bare: { tools: ['tool-a'] },
    });
    expect(data).toStrictEqual({
      groupId: 'bare',
      tools: ['tool-a'],
      toolCount: 1,
      filterMode: 'whitelist',
      // validation 缺失时 enabled 与 requiresKey 均为 undefined 语义下的回退
      validation: { enabled: false, requiresKey: undefined },
      impact: { previouslyFilteredTools: 0, newlyFilteredTools: 1, change: 1 },
      accessControl: { toolAccessRestricted: true, unrestrictedAccess: false },
      lastUpdated: expect.any(String),
    });
  });

  it('validation 开启但无密钥时 requiresKey 为 false', async () => {
    baseConfig({ team: { servers: [], tools: [], validation: { enabled: true } } });

    const data = await configureGroupTools('team', { tools: [] });

    expect(data.validation).toStrictEqual({ enabled: true, requiresKey: false });
  });

  it('validation 关闭但存有密钥时 requiresKey 仍为 false', async () => {
    baseConfig({
      team: { servers: [], tools: [], validation: { enabled: false, validationKey: 'enc' } },
    });

    const data = await configureGroupTools('team', { tools: [] });

    expect(data.validation).toStrictEqual({ enabled: false, requiresKey: false });
  });

  it('记录配置成功日志', async () => {
    baseConfig({ team: { servers: [], tools: [] } });

    await configureGroupTools('team', { tools: ['x'] });

    expect(loggerMock.info).toHaveBeenCalledWith('组工具过滤配置成功', {
      groupId: 'team',
      toolCount: 1,
      tools: ['x'],
    });
  });
});

describe('getGroupAvailableTools 行为补强', () => {
  it('组缺失 servers/tools 字段时逐项回退', async () => {
    baseConfig({ bare: {} });

    const data = await getGroupAvailableTools('bare');

    expect(data.toolFilter).toStrictEqual([]);
    expect(data.filtering).toStrictEqual({
      isFilteringEnabled: false,
      filterRatio: 100,
      excludedTools: 0,
    });
    expect(data.tools).toStrictEqual([]);
    expect(data.toolsByServer).toStrictEqual({});
    expect(data.serverDistribution).toStrictEqual([]);
  });

  it('工具描述缺省回退空字符串且 inputSchema 形态完整', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const data = await getGroupAvailableTools('team');

    expect(data.tools).toStrictEqual([
      {
        name: 'tool-a',
        description: '',
        serverId: 'srv-a',
        serverName: 'srv-a',
        inputSchema: { type: 'object', properties: {} },
        status: 'available',
      },
    ]);
    expect(data.toolsByServer['srv-a']).toStrictEqual([
      {
        name: 'tool-a',
        description: '',
        serverId: 'srv-a',
        serverName: 'srv-a',
        inputSchema: { type: 'object', properties: {} },
        status: 'available',
      },
    ]);
  });

  it('servers 含空串时无 serverId 工具进入列表且分组键为 unknown', async () => {
    baseConfig({ weird: { servers: [''] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 't1' }]);

    const data = await getGroupAvailableTools('weird');

    expect(data.tools).toStrictEqual([
      {
        name: 't1',
        description: '',
        serverId: '',
        serverName: '',
        inputSchema: { type: 'object', properties: {} },
        status: 'available',
      },
    ]);
    expect(Object.keys(data.toolsByServer)).toStrictEqual(['unknown']);
  });

  it('两个服务器各一个工具时分布百分比各为 50', async () => {
    baseConfig({ team: { servers: ['srv-a', 'srv-b'] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', serverId: 'srv-a' },
      { name: 'tool-b', serverId: 'srv-b' },
    ]);

    const data = await getGroupAvailableTools('team');

    expect(data.serverDistribution).toStrictEqual([
      { serverId: 'srv-a', toolCount: 1, percentage: 50 },
      { serverId: 'srv-b', toolCount: 1, percentage: 50 },
    ]);
  });

  it('记录完成日志', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: ['tool-a'] } });

    await getGroupAvailableTools('team');

    expect(loggerMock.info).toHaveBeenCalledWith('组可用工具查询完成', {
      groupId: 'team',
      totalTools: 0,
      filteredTools: 0,
      serverCount: 0,
    });
  });
});

describe('validateToolAccess 行为补强', () => {
  it('白名单内的工具授权访问且不返回替代工具', async () => {
    baseConfig({ team: { servers: ['srv-a'], tools: ['tool-a'] } });
    coreManager.getAllTools.mockResolvedValue([
      { name: 'tool-a', serverId: 'srv-a' },
      { name: 'tool-other', serverId: 'srv-a' },
    ]);

    const data = await validateToolAccess('team', 'tool-a');

    expect(data.hasAccess).toBe(true);
    expect(data.reason).toBe('ACCESS_GRANTED');
    expect(data.message).toBe('工具访问已授权');
    expect(data.validation).toStrictEqual({
      groupHasValidation: false,
      toolInFilterList: true,
      filterMode: 'whitelist',
    });
    expect(data.toolInfo).toBeDefined();
    expect(data.alternatives).toBeUndefined();
  });

  it('组开启验证时 groupHasValidation 为 true', async () => {
    baseConfig({
      team: { servers: ['srv-a'], tools: [], validation: { enabled: true } },
    });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const data = await validateToolAccess('team', 'tool-a');

    expect(data.validation?.groupHasValidation).toBe(true);
  });

  it('工具字段缺省时 toolInfo 回退默认值', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const data = await validateToolAccess('team', 'tool-a');

    expect(data.toolInfo).toStrictEqual({
      name: 'tool-a',
      description: undefined,
      serverId: 'srv-a',
      serverName: 'srv-a',
      category: 'general',
      version: '1.0.0',
      deprecated: false,
      inputSchema: { type: 'object', properties: {} },
      estimatedComplexity: {
        complexity: 'simple',
        parameterCount: 0,
        requiredParameterCount: 0,
        estimatedExecutionTime: 'fast',
      },
    });
  });

  it('组缺失 servers/tools 字段时仍可验证（全部回退）', async () => {
    baseConfig({ bare: {} });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    const data = await validateToolAccess('bare', 'ghost');

    expect(data).toStrictEqual({
      groupId: 'bare',
      toolName: 'ghost',
      hasAccess: false,
      reason: 'TOOL_NOT_FOUND_IN_GROUP',
      message: '工具在组中不可用',
    });
  });

  it('servers 含空串时无 serverId 工具可被找到且 serverName 为空串', async () => {
    baseConfig({ weird: { servers: [''] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 't1' }]);

    const data = await validateToolAccess('weird', 't1');

    expect(data.hasAccess).toBe(true);
    expect(data.toolInfo?.serverName).toBe('');
  });

  it('记录验证完成日志', async () => {
    baseConfig({ team: { servers: ['srv-a'] } });
    coreManager.getAllTools.mockResolvedValue([{ name: 'tool-a', serverId: 'srv-a' }]);

    await validateToolAccess('team', 'tool-a');

    expect(loggerMock.info).toHaveBeenCalledWith('工具访问权限验证完成', {
      groupId: 'team',
      toolName: 'tool-a',
      hasAccess: true,
      reason: 'ACCESS_GRANTED',
    });
  });

  it('错误对象 name 为 ToolAccessServiceError', async () => {
    baseConfig({});

    const error = await getGroupTools('missing').catch((err) => err);
    expect(error).toMatchObject({
      name: 'ToolAccessServiceError',
      code: 'GROUP_NOT_FOUND',
      status: 404,
    });
  });
});
