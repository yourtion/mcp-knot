/**
 * GroupMcpService 行为补强单测（变异覆盖批次）
 *
 * 与 group-service.unit.test.ts（构造时序 / cacheHints / MRTR handler）互补，本文件覆盖：
 * - 生命周期：重复 initialize 幂等、配置缺失失败、shutdown 状态重置、getAvailableTools 惰性初始化
 * - getStatus：字段计算（connectedServers 过滤、servers 缺失回落）与错误重抛
 * - 组管理工具 handler：group_status / list_group_tools 的成功与失败文本
 * - 动态工具：tools 白名单过滤、空 servers、getAllTools/registerTool 失败不阻断
 * - convertToZodSchema：JSON Schema 属性类型 → Zod shape（required/optional/description）
 * - resources callback：group://status 成功/失败、hub://version、servers 缺失条目 disconnected
 * - refreshTools：未初始化跳过、remove 抛错继续、getServerTools 抛错不抛出
 * - skills 分支：groupConfig.skills 存在时 catalog + registerSkills 接线
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

// 捕获 McpServer 上 registerTool 的注册项（name / opts / handler）与句柄 remove 调用
interface ToolRegistration {
  name: string;
  opts: { description?: string; inputSchema?: z.ZodTypeAny };
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
  remove: ReturnType<typeof vi.fn>;
}
const toolRegistrations: ToolRegistration[] = [];
const constructorCalls: Array<{ serverInfo: unknown; options: unknown }> = [];
const closeCalls: Array<{ closedBy: string }> = [];

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return {
    ...actual,
    McpServer: vi.fn(function (this: unknown, serverInfo: unknown, options?: unknown) {
      constructorCalls.push({ serverInfo, options });
      this.registerTool = vi.fn(
        (name: string, opts: ToolRegistration['opts'], handler: ToolRegistration['handler']) => {
          const remove = vi.fn();
          toolRegistrations.push({ name, opts, handler, remove });
          return { remove };
        },
      );
      this.registerResource = vi.fn();
      this.close = vi.fn(() => {
        closeCalls.push({ closedBy: 'mcpServer' });
      });
    }),
  };
});

vi.mock('../../services/skills-service.js', () => ({
  getSkillRepository: vi.fn(() => ({
    catalog: vi.fn().mockResolvedValue({ sentinel: 'catalog' }),
  })),
}));

vi.mock('@mcp-core/mcp-knot-core/skills', () => ({
  registerSkills: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { ErrorCode, ConfigError } from '@mcp-core/mcp-knot-core';
import { registerSkills } from '@mcp-core/mcp-knot-core/skills';

import { GroupMcpService } from './group-service.js';

import type { McpServiceManagerInterface } from '@mcp-core/mcp-knot-core';

const getAllConfigMock = vi.fn();
vi.mock('../../utils/config.js', () => ({
  getAllConfig: (...args: unknown[]) => getAllConfigMock(...args),
}));

function setConfig(groups: Record<string, unknown>): void {
  getAllConfigMock.mockReset();
  getAllConfigMock.mockResolvedValue({ mcps: { servers: {} }, groups });
}

function makeCoreManagerMock(
  overrides: Partial<Record<string, unknown>> = {},
): McpServiceManagerInterface & {
  executeToolCallWithContext: ReturnType<typeof vi.fn>;
} {
  return {
    getAllTools: vi.fn().mockResolvedValue([]),
    getServerTools: vi.fn().mockResolvedValue([]),
    getServerConnections: vi.fn().mockReturnValue(new Map()),
    getServiceStatus: vi.fn().mockReturnValue(new Map()),
    executeToolCall: vi.fn(),
    executeToolCallWithContext: vi.fn().mockResolvedValue({ content: [] }),
    ...overrides,
  } as never;
}

function makeSvc(
  groupId = 'g1',
  cm = makeCoreManagerMock(),
): { svc: GroupMcpService; cm: ReturnType<typeof makeCoreManagerMock> } {
  return { svc: new GroupMcpService(groupId, cm), cm };
}

beforeEach(() => {
  toolRegistrations.length = 0;
  constructorCalls.length = 0;
  closeCalls.length = 0;
  vi.clearAllMocks();
  setConfig({
    g1: { id: 'g1', name: 'G1', servers: ['s1', 's2'], tools: [] },
  });
});

describe('GroupMcpService - 生命周期', () => {
  it('重复 initialize 幂等：第二次不再构造 McpServer、不再注册工具', async () => {
    const { svc } = makeSvc();
    await svc.initialize();
    const toolCountAfterFirst = toolRegistrations.length;

    await svc.initialize();

    expect(constructorCalls).toHaveLength(1);
    expect(toolRegistrations).toHaveLength(toolCountAfterFirst);
  });

  it('组配置不存在时 initialize 抛 ConfigError（CONFIG_FILE_NOT_FOUND，消息含组名）', async () => {
    setConfig({});
    const { svc } = makeSvc('missing');

    await expect(svc.initialize()).rejects.toBeInstanceOf(ConfigError);
    await expect(svc.initialize()).rejects.toMatchObject({
      code: ErrorCode.CONFIG_FILE_NOT_FOUND,
      message: expect.stringContaining('missing'),
    });
    expect(() => svc.getMcpServer()).toThrow();
  });

  it('getAllConfig 抛错时 initialize 透传原始错误', async () => {
    getAllConfigMock.mockReset();
    getAllConfigMock.mockRejectedValue(new Error('config io boom'));
    const { svc } = makeSvc();

    await expect(svc.initialize()).rejects.toThrow('config io boom');
  });

  it('getMcpServer 未初始化时错误消息包含组名', async () => {
    const { svc } = makeSvc('mygroup');
    expect(() => svc.getMcpServer()).toThrow(/mygroup/);
  });

  it('shutdown 关闭 McpServer 并重置状态（下次访问触发惰性重建）', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi
        .fn()
        .mockResolvedValue([
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();
    expect(await svc.getAvailableTools()).toHaveLength(1);

    await svc.shutdown();

    expect(closeCalls).toHaveLength(1);
    expect(() => svc.getMcpServer()).toThrow();
    // shutdown 重置后 getAvailableTools 惰性重新 initialize（构造第二个 McpServer）
    expect(await svc.getAvailableTools()).toHaveLength(1);
    expect(constructorCalls).toHaveLength(2);
  });

  it('getAvailableTools 在未初始化时自动触发 initialize', async () => {
    const { svc } = makeSvc();
    const tools = await svc.getAvailableTools();
    expect(tools).toEqual([]);
    expect(constructorCalls).toHaveLength(1);
    expect(() => svc.getMcpServer()).not.toThrow();
  });
});

describe('GroupMcpService - getStatus', () => {
  it('返回组作用域的状态字段：仅统计组内且 connected 的服务器', async () => {
    const cm = makeCoreManagerMock({
      getServerConnections: vi.fn().mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: 'connected' }],
          ['s2', { id: 's2', status: 'connected' }],
          ['s3', { id: 's3', status: 'connected' }], // 不属于 g1
          ['s4', { id: 's4', status: 'disconnected' }], // 不属于 g1
        ]),
      ),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const status = await svc.getStatus();
    expect(status).toMatchObject({
      groupId: 'g1',
      isInitialized: true,
      serverCount: 2,
      connectedServers: 2,
      availableTools: 0,
    });
    expect(() => new Date(status.lastUpdate).toISOString()).not.toThrow();
  });

  it('connected 计数排除组内非 connected 的服务器', async () => {
    const cm = makeCoreManagerMock({
      getServerConnections: vi.fn().mockReturnValue(
        new Map([
          ['s1', { id: 's1', status: 'connected' }],
          ['s2', { id: 's2', status: 'connecting' }],
        ]),
      ),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();
    expect((await svc.getStatus()).connectedServers).toBe(1);
  });

  it('组配置未加载（未初始化）时 serverCount 回落为 0', async () => {
    const { svc } = makeSvc('g1');
    const status = await svc.getStatus();
    expect(status).toMatchObject({ groupId: 'g1', isInitialized: false, serverCount: 0 });
  });

  it('getServerConnections 抛错时 getStatus 重抛', async () => {
    const cm = makeCoreManagerMock({
      getServerConnections: vi.fn(() => {
        throw new Error('connections broken');
      }),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();
    await expect(svc.getStatus()).rejects.toThrow('connections broken');
  });
});

describe('GroupMcpService - 组管理工具', () => {
  function findHandler(name: string): ToolRegistration {
    const reg = toolRegistrations.find((r) => r.name === name);
    expect(reg).toBeDefined();
    return reg!;
  }

  it('注册 group_status / list_group_tools，描述中包含组名', async () => {
    const { svc } = makeSvc('g1');
    await svc.initialize();

    expect(findHandler('group_status').opts.description).toContain('g1');
    expect(findHandler('list_group_tools').opts.description).toContain('g1');
  });

  it('group_status handler 返回包含状态 JSON 的文本', async () => {
    const { svc } = makeSvc('g1');
    await svc.initialize();

    const result = (await findHandler('group_status').handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    const statusLine = result.content[0]!.text.split('\n')[0]!;
    expect(statusLine).toContain("组 'g1' 状态");
    const payload = JSON.parse(result.content[0]!.text.split('\n').slice(1).join('\n'));
    expect(payload).toMatchObject({ groupId: 'g1', serverCount: 2 });
  });

  it('group_status handler 在 getStatus 失败时返回错误文本', async () => {
    const cm = makeCoreManagerMock({
      getServerConnections: vi.fn(() => {
        throw new Error('status boom');
      }),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const result = (await findHandler('group_status').handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]!.text).toContain('获取组状态失败');
    expect(result.content[0]!.text).toContain('status boom');
  });

  it('list_group_tools handler 列出工具：含 serverId、description 与「无描述」fallback', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi.fn().mockResolvedValue([
        {
          name: 'echo',
          description: '回显',
          serverId: 's1',
          inputSchema: { type: 'object', properties: {} },
        },
        { name: 'plain', serverId: 's2', inputSchema: { type: 'object', properties: {} } },
      ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const result = (await findHandler('list_group_tools').handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    const text = result.content[0]!.text;
    expect(text).toContain('2 个');
    expect(text).toContain('- echo (来自 s1): 回显');
    expect(text).toContain('- plain (来自 s2): 无描述');
  });

  it('list_group_tools handler 在惰性重新初始化失败时返回错误文本', async () => {
    const { svc } = makeSvc('g1');
    await svc.initialize();
    // shutdown 后 isInitialized=false，handler 内 getAvailableTools 会重新 initialize；
    // 此时让配置读取失败 → handler catch 分支
    await svc.shutdown();
    getAllConfigMock.mockReset();
    getAllConfigMock.mockRejectedValue(new Error('tools boom'));

    const result = (await findHandler('list_group_tools').handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]!.text).toContain('列出组工具失败');
    expect(result.content[0]!.text).toContain('tools boom');
  });
});

// SDK ServerContext 形状的最小 extra：requestState accessor 按 SDK 契约总是存在
function makeExtra(meta?: Record<string, unknown>): { mcpReq: Record<string, unknown> } {
  return {
    mcpReq: {
      _meta: meta ?? {},
      requestState: () => undefined,
    },
  };
}

describe('GroupMcpService - 动态工具注册', () => {
  it('tools 白名单过滤：仅注册与保留白名单内工具', async () => {
    setConfig({
      g1: { id: 'g1', name: 'G1', servers: ['s1'], tools: ['wanted'] },
    });
    const cm = makeCoreManagerMock({
      getAllTools: vi.fn().mockResolvedValue([
        { name: 'wanted', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        { name: 'blocked', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
      ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const dynamicNames = toolRegistrations
      .filter((r) => r.name.startsWith('s1_'))
      .map((r) => r.name);
    expect(dynamicNames).toEqual(['s1_wanted']);
    expect(await svc.getAvailableTools()).toEqual([
      expect.objectContaining({ name: 'wanted', serverId: 's1' }),
    ]);
  });

  it('组无 servers 时不注册动态工具且不报错', async () => {
    setConfig({
      g1: { id: 'g1', name: 'G1', servers: [], tools: [] },
    });
    const { svc } = makeSvc('g1');
    await svc.initialize();

    expect(toolRegistrations.map((r) => r.name).toSorted()).toEqual([
      'group_status',
      'list_group_tools',
    ]);
    expect(await svc.getAvailableTools()).toEqual([]);
  });

  it('getAllTools 抛错不阻断初始化（动态工具注册失败被吞）', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi.fn().mockRejectedValue(new Error('tools fetch boom')),
    });
    const { svc } = makeSvc('g1', cm);
    await expect(svc.initialize()).resolves.toBeUndefined();
    expect(await svc.getAvailableTools()).toEqual([]);
  });

  it('registerTool 抛错时单个工具注册失败被吞、初始化继续', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi
        .fn()
        .mockResolvedValue([
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    // 初始化完成后，把 registerTool 替换为抛错再走 refreshTools 内的 registerDynamicTool
    const server = svc.getMcpServer() as unknown as {
      registerTool: ReturnType<typeof vi.fn>;
    };
    server.registerTool.mockImplementation(() => {
      throw new Error('register boom');
    });
    await expect(svc.refreshTools('s1')).resolves.toBeUndefined();
    expect(toolRegistrations.filter((r) => r.name === 's1_t1')).toHaveLength(1);
  });

  it('上游返回字符串 / 普通对象时包装为 CallToolResult 文本', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi.fn().mockResolvedValue([
        { name: 'str', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        { name: 'obj', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
      ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const byName = new Map(toolRegistrations.map((r) => [r.name, r]));
    cm.executeToolCallWithContext.mockResolvedValueOnce('plain text');
    cm.executeToolCallWithContext.mockResolvedValueOnce({ answer: 42 });

    const asText = (await byName.get('s1_str')!.handler({}, makeExtra())) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(asText).toEqual({ content: [{ type: 'text', text: 'plain text' }] });

    const asJson = (await byName.get('s1_obj')!.handler({}, makeExtra())) as {
      content: Array<{ text: string }>;
    };
    expect(asJson.content[0]!.text).toBe(JSON.stringify({ answer: 42 }, null, 2));
  });

  it('extra 缺失 mcpReq / 整个 extra 为 undefined 时 handler 仍可执行（防御 optional chaining）', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi
        .fn()
        .mockResolvedValue([
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();
    const reg = toolRegistrations.find((r) => r.name === 's1_t1')!;

    await expect(reg.handler({}, makeExtra())).resolves.toBeDefined();
    await expect(reg.handler({}, {})).resolves.toBeDefined();
    await expect(reg.handler({}, undefined)).resolves.toBeDefined();
    expect(cm.executeToolCallWithContext).toHaveBeenCalledTimes(3);
  });

  it('请求 _meta 携带 trace 上下文时正常透传执行（trace-context 真实注入路径）', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi
        .fn()
        .mockResolvedValue([
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();
    const reg = toolRegistrations.find((r) => r.name === 's1_t1')!;

    await reg.handler(
      {},
      makeExtra({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }),
    );

    expect(cm.executeToolCallWithContext).toHaveBeenCalledOnce();
  });
});

describe('GroupMcpService - convertToZodSchema', () => {
  it('JSON Schema 属性映射为 Zod shape：类型 / required / description', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi.fn().mockResolvedValue([
        {
          name: 'rich',
          serverId: 's1',
          inputSchema: {
            type: 'object',
            properties: {
              s: { type: 'string', description: '字符串参数' },
              n: { type: 'number' },
              b: { type: 'boolean' },
              o: { type: 'object' },
              a: { type: 'array' },
              weird: { type: 'unknown-type' },
            },
            required: ['s', 'n'],
          },
        },
      ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const reg = toolRegistrations.find((r) => r.name === 's1_rich')!;
    const shape = (reg.opts.inputSchema as z.ZodObject).shape;

    const unwrap = (t: z.ZodTypeAny): z.ZodTypeAny =>
      t instanceof z.ZodOptional ? unwrap(t.unwrap()) : t;

    // required 字段不可缺省，其余 optional
    expect(shape['s']!.isOptional()).toBe(false);
    expect(shape['n']!.isOptional()).toBe(false);
    expect(shape['b']!.isOptional()).toBe(true);
    expect(shape['o']!.isOptional()).toBe(true);
    expect(shape['a']!.isOptional()).toBe(true);
    expect(shape['weird']!.isOptional()).toBe(true);
    // description 被挂到字段上
    expect(unwrap(shape['s']!).description).toBe('字符串参数');
    // 类型映射：string/number/boolean 的 Zod 类型正确
    expect(unwrap(shape['s']!)).toBeInstanceOf(z.ZodString);
    expect(unwrap(shape['n']!)).toBeInstanceOf(z.ZodNumber);
    expect(unwrap(shape['b']!)).toBeInstanceOf(z.ZodBoolean);
    // object → record、array → array
    expect(unwrap(shape['o']!)).toBeInstanceOf(z.ZodRecord);
    expect(unwrap(shape['a']!)).toBeInstanceOf(z.ZodArray);
  });

  it('inputSchema 无 properties 时映射为空 shape（全部参数缺省）', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi.fn().mockResolvedValue([{ name: 'bare', serverId: 's1' }]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const reg = toolRegistrations.find((r) => r.name === 's1_bare')!;
    expect(Object.keys((reg.opts.inputSchema as z.ZodObject).shape)).toEqual([]);
  });
});

describe('GroupMcpService - resources callback', () => {
  function getResource(name: string): {
    uri: string;
    callback: (uri: URL) => Promise<{ contents: Array<{ uri: string; text: string }> }>;
  } {
    const server = resourceServerRef!;
    const call = server.registerResource.mock.calls.find((c: unknown[]) => c[0] === name) as [
      string,
      string,
      unknown,
      (uri: URL) => Promise<{ contents: Array<{ uri: string; text: string }> }>,
    ];
    expect(call).toBeDefined();
    return { uri: call[1]!, callback: call[3]! };
  }

  let resourceServerRef: {
    registerResource: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } | null = null;

  beforeEach(() => {
    resourceServerRef = null;
  });

  async function initSvc(cm = makeCoreManagerMock()): Promise<void> {
    const svc = new GroupMcpService('g1', cm);
    await svc.initialize();
    resourceServerRef = svc.getMcpServer() as unknown as typeof resourceServerRef;
  }

  it('group://status callback 返回状态 JSON 文本', async () => {
    await initSvc();
    const { uri, callback } = getResource('group_status_resource');
    const result = await callback(new URL(uri));
    expect(result.contents[0]!.uri).toBe(uri);
    expect(JSON.parse(result.contents[0]!.text)).toMatchObject({ groupId: 'g1', serverCount: 2 });
  });

  it('group://status callback 在 getStatus 失败时返回含错误与组名的 JSON', async () => {
    const cm = makeCoreManagerMock({
      getServerConnections: vi.fn(() => {
        throw new Error('status resource boom');
      }),
    });
    await initSvc(cm);
    const { callback } = getResource('group_status_resource');
    const result = await callback(new URL('group://g1/status'));
    expect(JSON.parse(result.contents[0]!.text)).toEqual({
      error: 'status resource boom',
      groupId: 'g1',
    });
  });

  it('group://servers callback 对缺失连接条目回落 disconnected', async () => {
    const cm = makeCoreManagerMock({
      getServerConnections: vi
        .fn()
        .mockReturnValue(new Map([['s1', { id: 's1', status: 'connected' }]])),
    });
    await initSvc(cm);
    const { callback } = getResource('group_servers');
    const result = await callback(new URL('group://g1/servers'));
    const parsed = JSON.parse(result.contents[0]!.text);
    expect(parsed.servers).toEqual([
      { id: 's1', status: 'connected' },
      { id: 's2', status: 'disconnected' },
    ]);
  });

  it('hub://version callback 返回包名与版本', async () => {
    await initSvc();
    const { callback } = getResource('hub_version');
    const result = await callback(new URL('hub://version'));
    const parsed = JSON.parse(result.contents[0]!.text) as { name: string; version: string };
    // 与生产代码同一来源（backend/package.json），断言字段完整一致
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      name: string;
      version: string;
    };
    expect(parsed).toEqual({ name: pkg.name, version: pkg.version });
  });

  it('hub://config callback 在 getAllConfig 失败时返回全局错误 JSON', async () => {
    await initSvc();
    // 初始化时 config 读取成功；读取 callback 时改为失败
    getAllConfigMock.mockReset();
    getAllConfigMock.mockRejectedValue(new Error('config resource boom'));
    const { callback } = getResource('hub_config');
    const result = await callback(new URL('hub://config'));
    expect(JSON.parse(result.contents[0]!.text)).toEqual({
      error: 'config resource boom',
      scope: 'global',
    });
  });
});

describe('GroupMcpService - refreshTools 边界', () => {
  it('未初始化时 refreshTools 直接跳过（不读 server 工具）', async () => {
    const { svc, cm } = makeSvc('g1');
    await expect(svc.refreshTools('s1')).resolves.toBeUndefined();
    expect(cm.getServerTools).not.toHaveBeenCalled();
  });

  it('旧句柄 remove 抛错时继续重注册', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi
        .fn()
        .mockResolvedValue([
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();

    const oldHandle = toolRegistrations.find((r) => r.name === 's1_t1')!;
    oldHandle.remove.mockImplementation(() => {
      throw new Error('remove boom');
    });
    cm.getServerTools = vi.fn().mockResolvedValue([
      { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
      { name: 't2', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
    ]);

    await expect(svc.refreshTools('s1')).resolves.toBeUndefined();
    const names = (await svc.getAvailableTools()).map((t) => t.name);
    expect(names).toContain('t2');
  });

  it('getServerTools 抛错时 refreshTools 不抛出、工具列表保持不变', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi
        .fn()
        .mockResolvedValue([
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();
    cm.getServerTools = vi.fn().mockRejectedValue(new Error('server tools boom'));

    await expect(svc.refreshTools('s1')).resolves.toBeUndefined();
    expect((await svc.getAvailableTools()).map((t) => t.name)).toEqual(['t1']);
  });

  it('getServerTools 返回其他 server 的工具时被 serverId 过滤跳过', async () => {
    const cm = makeCoreManagerMock({
      getAllTools: vi
        .fn()
        .mockResolvedValue([
          { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
        ]),
    });
    const { svc } = makeSvc('g1', cm);
    await svc.initialize();
    cm.getServerTools = vi.fn().mockResolvedValue([
      { name: 'foreign', serverId: 's2', inputSchema: { type: 'object', properties: {} } },
      { name: 't1', serverId: 's1', inputSchema: { type: 'object', properties: {} } },
    ]);

    await svc.refreshTools('s1');
    expect(toolRegistrations.map((r) => r.name)).not.toContain('s2_foreign');
    expect((await svc.getAvailableTools()).map((t) => t.name)).toEqual(['t1']);
  });
});

describe('GroupMcpService - skills 注册分支', () => {
  it('组配置含 skills 时调用 catalog 并 registerSkills(mcpServer, catalog)', async () => {
    setConfig({
      g1: { id: 'g1', name: 'G1', servers: [], tools: [], skills: { include: ['demo'] } },
    });
    const { svc } = makeSvc('g1');
    await svc.initialize();

    const { getSkillRepository } = await import('../../services/skills-service.js');
    expect(getSkillRepository).toHaveBeenCalled();
    expect(registerSkills).toHaveBeenCalledOnce();
    const [target, catalog] = vi.mocked(registerSkills).mock.calls[0]!;
    expect(target).toBe(svc.getMcpServer());
    expect(catalog).toMatchObject({ sentinel: 'catalog' });
  });

  it('组配置无 skills 时不注册 skills', async () => {
    const { svc } = makeSvc('g1');
    await svc.initialize();
    expect(registerSkills).not.toHaveBeenCalled();
  });
});
