/**
 * GroupMcpService 构造时序单测
 *
 * 验证：
 * - 构造函数不再创建 McpServer（延迟到 initialize()，以便读取组配置里的 cacheHints）
 * - initialize() 后 McpServer 已创建且 getMcpServer 可用
 * - getMcpServer() 在 initialize 前抛 ServiceError
 * - cacheHints（含组级覆盖）被正确传入 McpServer 构造参数
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 捕获 McpServer 构造调用，记录入参用于断言构造时机与 cacheHints 接入
// 用普通 function 表达式以便可作为构造函数（new）调用
const constructorCalls: Array<{ serverInfo: unknown; options: unknown }> = [];
vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  // 部分模拟：McpServer 用 stub（捕获构造/register 调用），其余（含
  // createRequestStateCodec、isInputRequiredResult 等）走真实实现，
  // 以便 P5 Task 7 测试能复用 MrtrRelayService 的真实 HMAC codec。
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return {
    ...actual,
    McpServer: vi.fn(function (this: unknown, serverInfo: unknown, options?: unknown) {
      constructorCalls.push({ serverInfo, options });
      this.registerTool = vi.fn();
      this.registerResource = vi.fn();
      this.close = vi.fn();
    }),
  };
});

// getCoreServiceManager 不应在 group-service 路径中触发
vi.mock('../../services/service-registry.js', () => ({
  getCoreServiceManager: vi.fn(() => {
    throw new Error('getCoreServiceManager 不应在本测试中被调用');
  }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { ErrorCode, ServiceError } from '@mcp-core/mcp-knot-core';

import { MrtrRelayService } from '../../services/mrtr-relay-service.js';
import { GroupMcpService } from './group-service.js';

import type { HubState } from '../../services/mrtr-relay-service.js';
import type { McpServiceManagerInterface } from '@mcp-core/mcp-knot-core';

function makeCoreManagerMock(): McpServiceManagerInterface {
  return {
    getAllTools: vi.fn().mockResolvedValue([]),
    getServerTools: vi.fn().mockResolvedValue([]),
    getServerConnections: vi.fn().mockReturnValue(new Map()),
    getServiceStatus: vi.fn().mockReturnValue(new Map()),
    executeToolCall: vi.fn(),
  } as unknown as McpServiceManagerInterface;
}

// 生成 32 字节随机 key（HMAC-SHA256 用），供 MrtrRelayService 构造
function makeKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

// 构造 SDK ServerContext 形状的 extra，供 handler 直接调用。
// requestState accessor 按 SDK 契约（ctx.mcpReq.requestState<T>()）总是存在；
// requestStateValue 为 undefined 表示初次调用，传入 HubState 表示重试。
function makeExtra(opts: {
  requestStateValue?: HubState;
  inputResponses?: Record<string, unknown>;
}): {
  mcpReq: {
    _meta: Record<string, never>;
    requestState: <T>() => T | undefined;
    inputResponses?: Record<string, unknown>;
  };
} {
  const value = opts.requestStateValue;
  return {
    mcpReq: {
      _meta: {},
      requestState: <T>(): T | undefined => value as unknown as T | undefined,
      inputResponses: opts.inputResponses,
    },
  };
}

// getAllConfig 可在测试中被 spy/override（默认返回无 cacheHints 的最小 group）
// 注意：真实结构为 { mcps: { servers }, groups, system }（servers 嵌在 mcps 下），
// 见 backend/src/utils/config.ts getAllConfig()。这样 hub_config resource 的
// config.mcps?.servers 内容路径才能被真正覆盖。
const getAllConfigMock = vi.fn().mockResolvedValue({
  mcps: {
    servers: {},
  },
  groups: {
    testgroup: {
      id: 'testgroup',
      name: 'Test Group',
      servers: ['srv1'],
      tools: [],
    },
  },
});

vi.mock('../../utils/config.js', () => ({
  getAllConfig: (...args: unknown[]) => getAllConfigMock(...args),
}));

describe('GroupMcpService - 构造时序', () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      mcps: {
        servers: {},
      },
      groups: {
        testgroup: {
          id: 'testgroup',
          name: 'Test Group',
          servers: ['srv1'],
          tools: [],
        },
      },
    });
  });

  it('构造函数不应创建 McpServer（延迟到 initialize）', () => {
    const svc = new GroupMcpService('testgroup', makeCoreManagerMock());
    expect(constructorCalls).toHaveLength(0);
    void svc; // 引用避免 lint 报未使用
  });

  it('initialize() 后 McpServer 已创建且 getMcpServer 可用', async () => {
    const svc = new GroupMcpService('testgroup', makeCoreManagerMock());
    await svc.initialize();
    expect(constructorCalls).toHaveLength(1);
    expect(() => svc.getMcpServer()).not.toThrow();
  });

  it('getMcpServer() 在 initialize 前抛 ServiceError (SERVICE_UNAVAILABLE)', () => {
    const svc = new GroupMcpService('testgroup', makeCoreManagerMock());
    try {
      svc.getMcpServer();
      fail('getMcpServer 应在 initialize 前抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    }
  });

  it('cacheHints 默认值（ttlMs=60000, cacheScope=public）被传入 McpServer', async () => {
    const svc = new GroupMcpService('testgroup', makeCoreManagerMock());
    await svc.initialize();

    expect(constructorCalls).toHaveLength(1);
    const { options } = constructorCalls[0]!;
    expect(options).toMatchObject({
      cacheHints: {
        'tools/list': {
          ttlMs: 60_000,
          cacheScope: 'public',
        },
      },
    });
  });

  it('组级 cacheHints 覆盖被正确解析并传入 McpServer', async () => {
    getAllConfigMock.mockResolvedValue({
      mcps: {
        servers: {},
      },
      groups: {
        testgroup: {
          id: 'testgroup',
          name: 'Test Group',
          servers: ['srv1'],
          tools: [],
          cacheHints: {
            toolsListTtlMs: 5_000,
            toolsListCacheScope: 'private',
          },
        },
      },
    });

    const svc = new GroupMcpService('testgroup', makeCoreManagerMock());
    await svc.initialize();

    expect(constructorCalls).toHaveLength(1);
    const { options } = constructorCalls[0]!;
    expect(options).toMatchObject({
      cacheHints: {
        'tools/list': {
          ttlMs: 5_000,
          cacheScope: 'private',
        },
      },
    });
  });

  it('单字段覆盖：仅设 toolsListTtlMs 时，cacheScope 回落默认 public', async () => {
    getAllConfigMock.mockResolvedValue({
      mcps: {
        servers: {},
      },
      groups: {
        testgroup: {
          id: 'testgroup',
          name: 'Test Group',
          servers: ['srv1'],
          tools: [],
          cacheHints: {
            toolsListTtlMs: 5_000,
          },
        },
      },
    });

    const svc = new GroupMcpService('testgroup', makeCoreManagerMock());
    await svc.initialize();

    expect(constructorCalls).toHaveLength(1);
    const { options } = constructorCalls[0]!;
    expect(options).toMatchObject({
      cacheHints: {
        'tools/list': {
          ttlMs: 5_000,
          cacheScope: 'public',
        },
      },
    });
  });
});

describe('GroupMcpService - tools/list 确定性排序', () => {
  beforeEach(() => {
    // 重置默认配置
    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      mcps: {
        servers: {},
      },
      groups: {
        testgroup: {
          id: 'testgroup',
          name: 'T',
          servers: ['zServer', 'aServer'],
          tools: [],
        },
      },
    });
  });

  it('聚合注册保留上游工具描述', async () => {
    const cm = makeCoreManagerMock();
    (cm.getAllTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        name: 'lookup',
        serverId: 'aServer',
        description: 'Read-only warehouse stock lookup',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    const svc = new GroupMcpService('testgroup', cm);
    await svc.initialize();

    expect(svc.getMcpServer().registerTool).toHaveBeenCalledWith(
      'aServer_lookup',
      expect.objectContaining({ description: 'Read-only warehouse stock lookup' }),
      expect.any(Function),
    );
    await svc.shutdown();
  });

  it('工具按 先 serverId 后 toolName 排序', async () => {
    // 模拟乱序工具：zServer/a、aServer/b、aServer/a
    const cm = makeCoreManagerMock();
    (cm.getAllTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'a', serverId: 'zServer', inputSchema: { type: 'object', properties: {} } },
      { name: 'b', serverId: 'aServer', inputSchema: { type: 'object', properties: {} } },
      { name: 'a', serverId: 'aServer', inputSchema: { type: 'object', properties: {} } },
    ]);

    const svc = new GroupMcpService('testgroup', cm);
    await svc.initialize();

    // 注册顺序由 getMcpServer().registerTool 调用顺序决定
    const registerToolCalls = (
      svc.getMcpServer() as unknown as {
        registerTool: ReturnType<typeof vi.fn>;
      }
    ).registerTool.mock.calls;

    // 排除 group_status / list_group_tools 两个管理工具（前两个），后面是动态工具
    const dynamicNames = registerToolCalls.slice(2).map((c: unknown[]) => c[0] as string);
    // 注册名 = ${serverId}_${toolName}
    expect(dynamicNames).toEqual(['aServer_a', 'aServer_b', 'zServer_a']);
  });
});

describe('GroupMcpService - registerGroupResources', () => {
  // 把 testgroup 配置成含 ['srv1','srv2']，便于覆盖 servers resource 过滤。
  // 注意 mcps.servers 与 group.servers 的区别：
  //   - mcps.servers: 全局上游 MCP server 配置（key 为 serverId）
  //   - group.servers: 本组订阅的 serverId 列表（数组）
  // 这里 mcps.servers 放 srv1/srv2 两条，用于覆盖 hub_config 的
  // config.mcps?.servers 内容路径（使其 serverCount 为非零值）。
  function resetConfig(): void {
    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      mcps: {
        servers: {
          srv1: { id: 'srv1' },
          srv2: { id: 'srv2' },
        },
      },
      groups: {
        testgroup: {
          id: 'testgroup',
          name: 'Test Group',
          servers: ['srv1', 'srv2'],
          tools: [],
        },
      },
    });
  }

  beforeEach(() => {
    resetConfig();
  });

  it('注册 4 个 resource，URI 与 cacheHint 正确', async () => {
    const cm = makeCoreManagerMock();
    const svc = new GroupMcpService('testgroup', cm);
    await svc.initialize();

    const registerResourceCalls = (
      svc.getMcpServer() as unknown as {
        registerResource: ReturnType<typeof vi.fn>;
      }
    ).registerResource.mock.calls;

    // 4 个 resource
    expect(registerResourceCalls).toHaveLength(4);

    // 抽取每个调用的 [name, uri, config.cacheHint]
    const entries = registerResourceCalls.map(
      (c: unknown[]) =>
        [
          c[0] as string,
          c[1] as string,
          (c[2] as { cacheHint?: { ttlMs?: number; cacheScope?: string } }).cacheHint,
        ] as const,
    );

    // status: 运行时状态，短 ttl 私有缓存
    expect(entries).toContainEqual([
      'group_status_resource',
      'group://testgroup/status',
      { ttlMs: 5_000, cacheScope: 'private' },
    ]);
    // servers: 服务器列表与连接状态，短 ttl 私有缓存
    expect(entries).toContainEqual([
      'group_servers',
      'group://testgroup/servers',
      { ttlMs: 5_000, cacheScope: 'private' },
    ]);
    // config: 全局配置概要，长 ttl 公共缓存
    expect(entries).toContainEqual([
      'hub_config',
      'hub://config',
      { ttlMs: 300_000, cacheScope: 'public' },
    ]);
    // version: 版本信息，极长 ttl 公共缓存
    expect(entries).toContainEqual([
      'hub_version',
      'hub://version',
      { ttlMs: 86_400_000, cacheScope: 'public' },
    ]);
  });

  it('group://servers resource 的 callback 返回过滤后的服务器列表', async () => {
    // 准备 serverConnections：srv1(connected), srv2(disconnected), other(connected)
    // 其中 other 不属于 testgroup，断言里不应出现
    const connections = new Map([
      ['srv1', { id: 'srv1', status: 'connected' }],
      ['srv2', { id: 'srv2', status: 'disconnected' }],
      ['other', { id: 'other', status: 'connected' }],
    ]);

    const cm = makeCoreManagerMock();
    (cm.getServerConnections as ReturnType<typeof vi.fn>).mockReturnValue(connections);

    const svc = new GroupMcpService('testgroup', cm);
    await svc.initialize();

    const registerResourceCalls = (
      svc.getMcpServer() as unknown as {
        registerResource: ReturnType<typeof vi.fn>;
      }
    ).registerResource.mock.calls;

    // 找到 group_servers 的注册项（第 4 个参数是 callback）
    const serversEntry = registerResourceCalls.find(
      (c: unknown[]) => c[0] === 'group_servers',
    ) as unknown as [
      string,
      string,
      unknown,
      (uri: URL) => Promise<{ contents: Array<{ uri: string; text?: string }> }>,
    ];
    expect(serversEntry).toBeDefined();

    const callback = serversEntry[3]!;
    const result = await callback(new URL('group://testgroup/servers'));
    const parsed = JSON.parse(result.contents[0]!.text!);

    // 只含 testgroup 配置的 srv1/srv2，不含 other
    const ids = (parsed.servers as Array<{ id: string; status: string }>).map((s) => s.id);
    expect(ids).toEqual(['srv1', 'srv2']);
    const byId = new Map(
      (parsed.servers as Array<{ id: string; status: string }>).map((s) => [s.id, s.status]),
    );
    expect(byId.get('srv1')).toBe('connected');
    expect(byId.get('srv2')).toBe('disconnected');
    expect(parsed.groupId).toBe('testgroup');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('hub://config resource 的 callback 返回非零 serverCount（覆盖 config.mcps.servers 路径）', async () => {
    // resetConfig() 已在 beforeEach 注入 mcps.servers = { srv1, srv2 }，共 2 条。
    // 此前测试 mock 用顶层 servers（无 mcps 包装），导致 config.mcps 恒为 undefined、
    // serverCount 恒为 0，hub_config 内容路径从未被真正覆盖。本用例补齐该覆盖。
    const cm = makeCoreManagerMock();
    const svc = new GroupMcpService('testgroup', cm);
    await svc.initialize();

    const registerResourceCalls = (
      svc.getMcpServer() as unknown as {
        registerResource: ReturnType<typeof vi.fn>;
      }
    ).registerResource.mock.calls;

    const configEntry = registerResourceCalls.find(
      (c: unknown[]) => c[0] === 'hub_config',
    ) as unknown as [
      string,
      string,
      unknown,
      (uri: URL) => Promise<{ contents: Array<{ uri: string; text?: string }> }>,
    ];
    expect(configEntry).toBeDefined();

    const callback = configEntry[3]!;
    const result = await callback(new URL('hub://config'));
    const parsed = JSON.parse(result.contents[0]!.text!) as {
      version: string;
      groups: string[];
      serverCount: number;
    };

    // 与 resetConfig() 注入的 mcps.servers（srv1 + srv2）一致
    expect(parsed.serverCount).toBe(2);
    expect(parsed.serverCount).toBeGreaterThan(0);
    expect(parsed.groups).toEqual(['testgroup']);
    expect(typeof parsed.version).toBe('string');
  });
});

describe('GroupMcpService.refreshTools（P5）', () => {
  // refreshTools 只重新注册指定 server 的工具，不动其他 server。
  // registerTool 返回带 remove() 的 RegisteredTool 句柄，refreshTools 借此注销旧工具。
  beforeEach(() => {
    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      mcps: {
        servers: {},
      },
      groups: {
        testgroup: {
          id: 'testgroup',
          name: 'Test Group',
          servers: ['s1', 's2'],
          tools: [],
        },
      },
    });
  });

  it('只重新注册指定 server 的工具，不动其他 server', async () => {
    const cm = makeCoreManagerMock();
    // 初始：s1 有 t1/t2，s2 有 t3
    const initialTools = [
      { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
      { name: 't2', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
      { name: 't3', serverId: 's2', inputSchema: { type: 'object', properties: {} } },
    ];
    (cm.getAllTools as ReturnType<typeof vi.fn>).mockResolvedValue(initialTools);
    // 初始 getServerTools 也返回同样工具集，供 refreshTools 重灌时读取
    (cm.getServerTools as ReturnType<typeof vi.fn>).mockImplementation(async (serverId: string) =>
      initialTools.filter((t) => t.serverId === serverId),
    );

    const svc = new GroupMcpService('testgroup', cm);

    // 先用默认 mock 完成初始化（management tools + resource 注册），捕获 mcpServer
    await svc.initialize();
    const mcpServer = svc.getMcpServer() as unknown as {
      registerTool: ReturnType<typeof vi.fn>;
    };

    // 让 registerTool 返回带 remove() 的句柄，记录每个被 remove 的工具。
    // 在 refreshTools 前覆盖 mock，并手动「重灌」初始工具句柄，
    // 模拟初始注册时即拿到句柄（refreshTools 依赖 registeredToolHandles）。
    const removedTools: string[] = [];
    (mcpServer.registerTool as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      const handle = {
        name,
        remove: () => {
          removedTools.push(name);
        },
        enable: vi.fn(),
        disable: vi.fn(),
        update: vi.fn(),
      };
      return handle;
    });
    // 重灌初始动态工具（s1_t1, s1_t2, s2_t3），使 registeredToolHandles 填充句柄
    await svc.refreshTools('s1');
    await svc.refreshTools('s2');
    removedTools.length = 0; // 清掉重灌期间的 remove 记录

    // 上游变更：s1 工具集变为 [t1,t4]（t2 消失、t4 新增）
    (cm.getServerTools as ReturnType<typeof vi.fn>).mockImplementation(async (serverId: string) => {
      if (serverId === 's1') {
        return [
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
          { name: 't4', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ];
      }
      return [{ name: 't3', serverId: 's2', inputSchema: { type: 'object', properties: {} } }];
    });

    const registerCallsBefore = mcpServer.registerTool.mock.calls.length;
    await svc.refreshTools('s1');

    // 断言：s1 的旧工具（s1_t1, s1_t2）被 remove
    expect(removedTools).toContain('s1_t1');
    expect(removedTools).toContain('s1_t2');
    // s2 的工具未被 remove
    expect(removedTools).not.toContain('s2_t3');

    // 断言：s1 的新工具被重新注册（含 s1_t4）
    const newRegisterCalls = mcpServer.registerTool.mock.calls.slice(registerCallsBefore);
    const newNames = newRegisterCalls.map((c: unknown[]) => c[0] as string);
    expect(newNames).toContain('s1_t1');
    expect(newNames).toContain('s1_t4');
    // s2 的工具未被重复注册
    expect(newNames).not.toContain('s2_t3');
  });

  it('availableTools 在 refresh 后反映新工具集', async () => {
    const cm = makeCoreManagerMock();
    (cm.getAllTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
    ]);

    const svc = new GroupMcpService('testgroup', cm);
    await svc.initialize();

    const mcpServer = svc.getMcpServer() as unknown as {
      registerTool: ReturnType<typeof vi.fn>;
    };
    (mcpServer.registerTool as ReturnType<typeof vi.fn>).mockImplementation((name: string) => ({
      name,
      remove: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      update: vi.fn(),
    }));

    (cm.getServerTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
      { name: 't2', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
    ]);

    await svc.refreshTools('s1');
    const tools = await svc.getAvailableTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('t1');
    expect(names).toContain('t2');
  });
});

/**
 * P5 Task 7：registerDynamicTool handler 改造（修 InputRequiredResult 吞没 bug + 接入 MRTR）。
 *
 * 测试策略：initialize() 会调 mcpServer.registerTool(name, opts, handler)。
 * 我们用 mock 的 registerTool 捕获 handler 闭包（第 3 个参数），再直接调用它，
 * 传入构造的 ServerContext（含 mcpReq.requestState/inputResponses）来验证 handler 行为。
 * 这样无需真实 MCP server 即可覆盖 handler 的全部分支。
 */
describe('MRTR handler（P5）', () => {
  // 构造一个带注入 mrtrRelay 的 GroupMcpService，并捕获动态工具 handler 闭包。
  async function setupWithTool(opts: {
    mrtrRelay?: MrtrRelayService;
    upstreamResult: unknown;
  }): Promise<{
    handler: (args: unknown, extra: unknown) => Promise<unknown>;
    executeToolCallWithContext: ReturnType<typeof vi.fn>;
    mrtrRelay: MrtrRelayService | undefined;
  }> {
    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      mcps: { servers: {} },
      groups: {
        testgroup: { id: 'testgroup', name: 'T', servers: ['s1'], tools: [] },
      },
    });

    const cm = makeCoreManagerMock();
    (cm.getAllTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
    ]);
    const executeToolCallWithContext = vi
      .fn()
      .mockResolvedValue(opts.upstreamResult) as unknown as ReturnType<typeof vi.fn>;
    // 挂到 core manager mock 上（接口未显式声明，但 backend 适配器有此方法；
    // handler 改造后走 executeToolCallWithContext 路径）
    (cm as unknown as Record<string, unknown>).executeToolCallWithContext =
      executeToolCallWithContext;

    const svc = new GroupMcpService('testgroup', cm, opts.mrtrRelay);
    await svc.initialize();

    const mcpServer = svc.getMcpServer() as unknown as {
      registerTool: ReturnType<typeof vi.fn>;
    };
    const registerCalls = mcpServer.registerTool.mock.calls;
    // 找到动态工具注册项（排除 group_status / list_group_tools 管理工具）
    const dynamic = registerCalls.find((c: unknown[]) => c[0] === 's1_t') as unknown as [
      string,
      unknown,
      (args: unknown, extra: unknown) => Promise<unknown>,
    ];
    expect(dynamic).toBeDefined();
    return { handler: dynamic[2], executeToolCallWithContext, mrtrRelay: opts.mrtrRelay };
  }

  it('上游执行异常必须标记为工具错误', async () => {
    const { handler, executeToolCallWithContext } = await setupWithTool({
      upstreamResult: undefined,
    });
    executeToolCallWithContext.mockRejectedValue(new Error('upstream failed'));
    const result = await handler({}, makeExtra({ requestStateValue: undefined }));
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('upstream failed') }],
    });
  });

  it('上游返回 input_required 时正确透传 InputRequiredResult（不包成 text）', async () => {
    const mrtrRelay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
    const upstream = {
      resultType: 'input_required',
      inputRequests: { confirm: { type: 'elicitation', message: 'sure?' } },
      requestState: 'upstream-opaque-state',
    };
    const { handler } = await setupWithTool({ mrtrRelay, upstreamResult: upstream });

    // 初次调用：无 requestState（非重试）。SDK 在生产中总会提供 requestState
    // accessor（返回 undefined 表示本轮无 state）；此处用同构 stub 模拟。
    const extra = makeExtra({ requestStateValue: undefined });
    const result = await handler({ foo: 'bar' }, extra);

    // 断言：返回的是 InputRequiredResult，而非被包成 text
    expect(result).toMatchObject({ resultType: 'input_required' });
    expect(result).not.toHaveProperty('content');
    expect(result).toHaveProperty('inputRequests');
    expect(result).toHaveProperty('requestState');
    // requestState 是 Hub mint 的（≠ 上游原始 'upstream-opaque-state'）
    expect((result as { requestState: string }).requestState).not.toBe('upstream-opaque-state');
  });

  it('上游正常结果（带 content）仍正常返回 CallToolResult', async () => {
    const mrtrRelay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
    const upstream = {
      content: [{ type: 'text', text: 'hello' }],
    };
    const { handler, executeToolCallWithContext } = await setupWithTool({
      mrtrRelay,
      upstreamResult: upstream,
    });

    const result = await handler({}, makeExtra({ requestStateValue: undefined }));

    // 断言：带 content 直传（不被 JSON.stringify 包成新 text）
    expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    // executeToolCallWithContext 被调用（而非旧 executeToolCall）
    expect(executeToolCallWithContext).toHaveBeenCalledOnce();
  });

  it('重试请求：ctx.mcpReq.requestState 还原上游上下文并透传 inputResponses', async () => {
    const mrtrRelay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
    // 先 mint 一个 Hub state，模拟客户端重试带回的已 verify 的 state
    const upstreamFirst = {
      resultType: 'input_required',
      inputRequests: { q: { type: 'text' } },
      requestState: 'upstream-state-xyz',
    };
    const hubState = await mrtrRelay.relay('s1', 't', upstreamFirst, 1);
    // 用 codec.verify 解出 HubState，模拟 SDK seam 在 handler 前已 verify
    const verifiedHubState = await mrtrRelay.verify(hubState.requestState, {} as never);

    // 第二轮：上游返回最终结果（带 content），断言 retryContext 透传
    const upstreamSecond = { content: [{ type: 'text', text: 'done' }] };
    const { handler, executeToolCallWithContext } = await setupWithTool({
      mrtrRelay,
      upstreamResult: upstreamSecond,
    });

    const inputResponses = { q: 'user-answer' };
    const extra = makeExtra({ requestStateValue: verifiedHubState, inputResponses });
    await handler({}, extra);

    // 断言：executeToolCallWithContext 收到 inputResponses + upstreamRequestState
    expect(executeToolCallWithContext).toHaveBeenCalledOnce();
    const callArgs = executeToolCallWithContext.mock.calls[0]!;
    // 签名：(toolName, args, serverId, retryContext)
    const retryContext = callArgs[3] as {
      inputResponses?: unknown;
      requestState?: string;
    };
    expect(retryContext.inputResponses).toEqual(inputResponses);
    expect(retryContext.requestState).toBe('upstream-state-xyz');
  });

  /**
   * 多轮 MRTR（>2）：上游连续 2 次 input_required（每轮 mint 不同 upstreamRequestState），
   * 第 3 轮才返回最终结果。覆盖之前缺失的「step 递增、每轮 mint 不同 Hub state、各自
   * verify 还原对应轮次 upstreamRequestState」中转链路（group-service handler 是 step
   * 递增逻辑所在层：resume?.isResume ? (resume.step ?? 0) + 1 : 1）。
   *
   * 注：Hub 无状态，step 单调性非 Hub 层安全防御（见 spec「安全要点」第 3 条）；
   * 此处验证的是 step 作为可观测审计字段的递增行为 + 每轮 state 各自可还原。
   */
  it('多轮 MRTR：上游连续 2 次 input_required → step 1→2→3 递增，每轮 mint 不同 Hub state 各自可还原', async () => {
    const mrtrRelay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });

    // 上游响应序列：round1 input_required(up1) → round2 input_required(up2) → round3 最终结果
    const upstreamRound1 = {
      resultType: 'input_required',
      inputRequests: { r1: { type: 'text' } },
      requestState: 'upstream-state-round-1',
    };
    const upstreamRound2 = {
      resultType: 'input_required',
      inputRequests: { r2: { type: 'text' } },
      requestState: 'upstream-state-round-2',
    };
    const upstreamRound3 = { content: [{ type: 'text', text: 'final done' }] };

    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      mcps: { servers: {} },
      groups: {
        testgroup: { id: 'testgroup', name: 'T', servers: ['s1'], tools: [] },
      },
    });

    const cm = makeCoreManagerMock();
    (cm.getAllTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
    ]);
    // executeToolCallWithContext 顺序返回 3 个上游结果
    const executeToolCallWithContext = vi
      .fn()
      .mockResolvedValueOnce(upstreamRound1)
      .mockResolvedValueOnce(upstreamRound2)
      .mockResolvedValueOnce(upstreamRound3) as unknown as ReturnType<typeof vi.fn>;
    (cm as unknown as Record<string, unknown>).executeToolCallWithContext =
      executeToolCallWithContext;

    const svc = new GroupMcpService('testgroup', cm, mrtrRelay);
    await svc.initialize();
    const mcpServer = svc.getMcpServer() as unknown as {
      registerTool: ReturnType<typeof vi.fn>;
    };
    const registerCalls = mcpServer.registerTool.mock.calls;
    const dynamic = registerCalls.find((c: unknown[]) => c[0] === 's1_t') as unknown as [
      string,
      unknown,
      (args: unknown, extra: unknown) => Promise<unknown>,
    ];
    expect(dynamic).toBeDefined();
    const handler = dynamic[2];

    // ── Round 1：初次调用（无 requestState）→ 上游 input_required(up1) → Hub mint state₁(step=1)
    const r1 = (await handler({}, makeExtra({ requestStateValue: undefined }))) as {
      resultType: string;
      requestState: string;
    };
    expect(r1.resultType).toBe('input_required');
    const state1 = r1.requestState;
    expect(state1).toBeDefined();
    const hub1 = await mrtrRelay.verify(state1, {} as never);
    expect(hub1.step).toBe(1);
    expect(hub1.upstreamRequestState).toBe('upstream-state-round-1');

    // ── Round 2：客户端带 state₁ 重试 → Hub verify 还原 up1 → 上游再次 input_required(up2)
    //            → Hub mint state₂(step = hub1.step+1 = 2)
    const r2 = (await handler(
      {},
      makeExtra({ requestStateValue: hub1, inputResponses: { r1: 'ans1' } }),
    )) as { resultType: string; requestState: string };
    expect(r2.resultType).toBe('input_required');
    const state2 = r2.requestState;
    expect(state2).toBeDefined();
    expect(state2).not.toBe(state1); // 每轮 mint 的 state 不同
    const hub2 = await mrtrRelay.verify(state2, {} as never);
    expect(hub2.step).toBe(2); // step 递增 1→2
    expect(hub2.upstreamRequestState).toBe('upstream-state-round-2');

    // ── Round 3：客户端带 state₂ 重试 → Hub verify 还原 up2 → 上游返回最终结果
    const r3 = (await handler(
      {},
      makeExtra({ requestStateValue: hub2, inputResponses: { r2: 'ans2' } }),
    )) as { content: Array<{ type: string; text: string }> };
    expect(r3.content).toBeDefined();
    expect(r3.content[0]!.text).toBe('final done');

    // executeToolCallWithContext 共被调 3 次（3 轮），每次 retryContext.requestState 透传对应该轮的 upstreamRequestState
    expect(executeToolCallWithContext).toHaveBeenCalledTimes(3);
    const rc1 = executeToolCallWithContext.mock.calls[0]![3] as { requestState?: string };
    const rc2 = executeToolCallWithContext.mock.calls[1]![3] as { requestState?: string };
    const rc3 = executeToolCallWithContext.mock.calls[2]![3] as { requestState?: string };
    // round1 初次调用 retryContext 为空对象（无 requestState）；round2/3 透传上游 state
    expect(rc1.requestState).toBeUndefined();
    expect(rc2.requestState).toBe('upstream-state-round-1');
    expect(rc3.requestState).toBe('upstream-state-round-2');
  });

  it('mrtrRelay 未注入时仍识别 input_required（直传上游 result，不包成 text）', async () => {
    // MRTR 未启用：构造时不传 mrtrRelay。上游返回 input_required 不应被吞成 text。
    const upstream = {
      resultType: 'input_required',
      inputRequests: { q: { type: 'text' } },
      requestState: 'upstream-raw',
    };
    const { handler } = await setupWithTool({ mrtrRelay: undefined, upstreamResult: upstream });

    const result = await handler({}, makeExtra({ requestStateValue: undefined }));

    // 断言：直传上游 InputRequiredResult，未包成 text
    expect(result).toMatchObject({ resultType: 'input_required' });
    expect(result).not.toHaveProperty('content');
    // 未 mint Hub state，requestState 仍是上游原值
    expect((result as { requestState: string }).requestState).toBe('upstream-raw');
  });
});

/**
 * P5 Task 8：requestState.verify 注入 McpServer 构造（MRTR 启用接线点）。
 *
 * SDK 事实核实（见 task-8-report）：`createMcpHandler(factory, options)` 不读
 * `options.requestState`（编译产物 index.mjs:1205 只解构 legacy/onerror/responseMode）。
 * `requestState.verify` 属于 `ServerOptions`——`new McpServer(info, options)` 的第二参数，
 * 由 McpServer 构造函数读取（mcp-DXXb3Vv3.mjs:725 `this._requestStateVerify = options?.requestState?.verify`）。
 * 故 verify 必须落在 GroupMcpService.buildMcpServer() 的 McpServer 构造参数，而非 createMcpHandler options。
 */
describe('requestState.verify 注入（P5 Task 8）', () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      mcps: { servers: {} },
      groups: {
        testgroup: { id: 'testgroup', name: 'T', servers: ['s1'], tools: [] },
      },
    });
  });

  it('注入 mrtrRelay 时 McpServer 构造收到 requestState.verify（函数）', async () => {
    const mrtrRelay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
    const svc = new GroupMcpService('testgroup', makeCoreManagerMock(), mrtrRelay);
    await svc.initialize();

    expect(constructorCalls).toHaveLength(1);
    const { options } = constructorCalls[0]!;
    expect(options).toMatchObject({
      requestState: { verify: expect.any(Function) },
    });
  });

  it('未注入 mrtrRelay 时 McpServer 构造不带 requestState.verify', async () => {
    const svc = new GroupMcpService('testgroup', makeCoreManagerMock());
    await svc.initialize();

    expect(constructorCalls).toHaveLength(1);
    const { options } = constructorCalls[0]! as { options?: { requestState?: unknown } };
    expect(options?.requestState).toBeUndefined();
  });

  it('注入的 verify 与 mrtrRelay.verify 是同一函数引用', async () => {
    const mrtrRelay = new MrtrRelayService({ key: makeKey(), ttlSeconds: 600 });
    const svc = new GroupMcpService('testgroup', makeCoreManagerMock(), mrtrRelay);
    await svc.initialize();

    const { options } = constructorCalls[0]! as {
      options: { requestState: { verify: unknown } };
    };
    expect(options.requestState.verify).toBe(mrtrRelay.verify);
  });
});
