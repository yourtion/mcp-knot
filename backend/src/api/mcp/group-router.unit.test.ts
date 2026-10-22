/**
 * groupMcpRouter 路由器装配单测（变异覆盖批次）
 *
 * 首个针对 group-router.ts 的单测。mock MCP handler 工厂 / 认证中间件 / 配置，
 * 通过 Hono app.request() 断言：
 * - 组验证中间件：组不存在 → 404 JSON-RPC 错误体；配置读取失败按「组不存在」处理
 * - POST /:group/mcp：handler.fetch 透传；工厂/执行错误 → 500 归一化 JSON-RPC
 * - GET /:group/status 与 /:group/tools：成功响应字段与 500 错误映射
 * - mcpAuthMiddleware 装配参数（resourceServer 配置映射 / 元数据路径）
 * - shutdownGroupMcpRouter：统一关闭 handler 与 service，单项失败不阻断
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authDeps, resourceServerDeps } = vi.hoisted(() => ({
  authDeps: [] as unknown[],
  resourceServerDeps: [] as unknown[],
}));

vi.mock('../../middleware/mcp-auth.js', () => ({
  createMcpAuthMiddleware: vi.fn((deps: unknown) => {
    authDeps.push(deps);
    // 直通中间件：模拟认证通过（认证逻辑本身由 mcp-auth 自己的测试覆盖）
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  }),
}));

vi.mock('../../services/oauth/resource-server.js', () => ({
  createResourceServer: vi.fn((deps: unknown) => {
    resourceServerDeps.push(deps);
    return { resourceServer: true };
  }),
}));

const { getAllConfigMock } = vi.hoisted(() => ({ getAllConfigMock: vi.fn() }));
vi.mock('../../utils/config.js', () => ({ getAllConfig: getAllConfigMock }));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// GroupMcpService 仅用于类型/instanceof 语义，路由运行时不需要真实实现
vi.mock('./group-service.js', () => ({
  GroupMcpService: class {},
}));

const { groupServices, groupHandlers, createHandlerMock, ensureServiceMock } = vi.hoisted(() => ({
  groupServices: new Map<string, unknown>(),
  groupHandlers: new Map<string, unknown>(),
  createHandlerMock: vi.fn(),
  ensureServiceMock: vi.fn(),
}));

vi.mock('./mcp-handler-factory.js', () => ({
  createGroupMcpHandler: createHandlerMock,
  ensureGroupMcpService: ensureServiceMock,
  getGroupServicesCache: vi.fn(() => groupServices),
  getGroupHandlersCache: vi.fn(() => groupHandlers),
}));

import { groupMcpRouter, shutdownGroupMcpRouter } from './group-router.js';

function makeServiceStub(overrides: Record<string, unknown> = {}): {
  getStatus: ReturnType<typeof vi.fn>;
  getAvailableTools: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  return {
    getStatus: vi.fn().mockResolvedValue({ groupId: 'g1', isInitialized: true }),
    getAvailableTools: vi.fn().mockResolvedValue([{ name: 'echo', serverId: 's1' }]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeHandlerStub(overrides: Record<string, unknown> = {}): {
  fetch: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response('{"jsonrpc":"2.0","result":{},"id":1}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authDeps.length = 0;
  resourceServerDeps.length = 0;
  groupServices.clear();
  groupHandlers.clear();
  getAllConfigMock.mockReset();
  getAllConfigMock.mockResolvedValue({
    groups: { g1: { id: 'g1', name: 'G1', servers: ['s1'] } },
    system: { oauth: { enabled: false } },
  });
});

describe('groupMcpRouter - POST /:group/mcp', () => {
  function postMcp(group: string): Promise<Response> {
    return groupMcpRouter.request(`/${group}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
  }

  it('组存在时透传 MCP handler 的响应（状态码与响应体）', async () => {
    createHandlerMock.mockResolvedValue(makeHandlerStub());

    const response = await postMcp('g1');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"jsonrpc":"2.0"');
    // handler.fetch 收到原始 Request（Web-standard 桥接）
    const handler = await createHandlerMock.mock.results[0]!.value;
    expect(handler.fetch).toHaveBeenCalledOnce();
    const raw = handler.fetch.mock.calls[0]![0] as Request;
    expect(raw).toBeInstanceOf(Request);
    expect(raw.method).toBe('POST');
  });

  it('组不存在时返回 404 与 JSON-RPC 错误体（GROUP_NOT_FOUND 嵌套在 data.error）', async () => {
    const response = await postMcp('ghost');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32602,
        message: "组 'ghost' 不存在",
        data: {
          error: {
            code: 'GROUP_NOT_FOUND',
            message: "指定的组 'ghost' 在配置中不存在",
          },
        },
      },
      id: null,
    });
    expect(createHandlerMock).not.toHaveBeenCalled();
  });

  it('配置读取失败时按组不存在处理（404）', async () => {
    getAllConfigMock.mockRejectedValue(new Error('config io boom'));

    const response = await postMcp('g1');

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.data.error.code).toBe('GROUP_NOT_FOUND');
  });

  it('MCP handler 工厂抛错时返回 500 归一化 JSON-RPC（INTERNAL_ERROR 嵌套）', async () => {
    createHandlerMock.mockRejectedValue(new Error('handler factory boom'));

    const response = await postMcp('g1');

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        data: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'handler factory boom',
            groupId: 'g1',
          },
        },
      },
    });
  });

  it('handler.fetch 抛错时返回 500 INTERNAL_ERROR', async () => {
    createHandlerMock.mockResolvedValue(
      makeHandlerStub({ fetch: vi.fn().mockRejectedValue(new Error('fetch boom')) }),
    );

    const response = await postMcp('g1');

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.data.error.message).toBe('fetch boom');
    expect(body.error.data.error.groupId).toBe('g1');
  });
});

describe('groupMcpRouter - GET /:group/status', () => {
  it('返回组状态（groupId/status/timestamp），handler 不被创建', async () => {
    const service = makeServiceStub();
    ensureServiceMock.mockResolvedValue(service);

    const response = await groupMcpRouter.request('/g1/status');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.groupId).toBe('g1');
    expect(body.status).toEqual({ groupId: 'g1', isInitialized: true });
    expect(typeof body.timestamp).toBe('string');
    expect(createHandlerMock).not.toHaveBeenCalled();
  });

  it('组不存在时返回 404（验证中间件同样生效）', async () => {
    const response = await groupMcpRouter.request('/ghost/status');
    expect(response.status).toBe(404);
    expect(ensureServiceMock).not.toHaveBeenCalled();
  });

  it('getStatus 失败时返回 500 STATUS_ERROR', async () => {
    ensureServiceMock.mockResolvedValue(
      makeServiceStub({
        getStatus: vi.fn().mockRejectedValue(new Error('status boom')),
      }),
    );

    const response = await groupMcpRouter.request('/g1/status');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'STATUS_ERROR',
        message: "获取组 'g1' 状态失败: status boom",
      },
    });
  });
});

describe('groupMcpRouter - GET /:group/tools', () => {
  it('返回工具列表（tools/count/timestamp）', async () => {
    const tools = [
      { name: 'echo', serverId: 's1' },
      { name: 'search', serverId: 's2' },
    ];
    ensureServiceMock.mockResolvedValue(
      makeServiceStub({ getAvailableTools: vi.fn().mockResolvedValue(tools) }),
    );

    const response = await groupMcpRouter.request('/g1/tools');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.groupId).toBe('g1');
    expect(body.tools).toEqual(tools);
    expect(body.count).toBe(2);
    expect(typeof body.timestamp).toBe('string');
  });

  it('getAvailableTools 失败时返回 500 TOOLS_ERROR', async () => {
    ensureServiceMock.mockResolvedValue(
      makeServiceStub({
        getAvailableTools: vi.fn().mockRejectedValue(new Error('tools boom')),
      }),
    );

    const response = await groupMcpRouter.request('/g1/tools');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'TOOLS_ERROR',
        message: "获取组 'g1' 工具列表失败: tools boom",
      },
    });
  });
});

describe('groupMcpRouter - 认证中间件装配', () => {
  it('createMcpAuthMiddleware 收到 resourceServer 与受保护资源元数据路径', async () => {
    // 模块加载即装配单例；authDeps 在 beforeEach 清空后需重新读取 import 期记录：
    // 这里直接触发一次请求（装配已发生在 import 时，authDeps 已被清空——
    // 重新 import 模块以重新装配）。
    vi.resetModules();
    authDeps.length = 0;
    resourceServerDeps.length = 0;
    await import('./group-router.js');

    expect(authDeps).toHaveLength(1);
    expect(authDeps[0]).toMatchObject({
      resourceMetadataUrlPath: '/.well-known/oauth-protected-resource',
    });
    expect((authDeps[0] as { resourceServer: unknown }).resourceServer).toEqual({
      resourceServer: true,
    });
  });

  it('resourceServer 的 getConfig 把 getAllConfig 映射为 { oauth(顶层), groups }', async () => {
    vi.resetModules();
    resourceServerDeps.length = 0;
    await import('./group-router.js');

    expect(resourceServerDeps).toHaveLength(1);
    const { getConfig } = resourceServerDeps[0] as { getConfig: () => Promise<unknown> };
    const mapped = await getConfig();
    expect(mapped).toEqual({
      oauth: { enabled: false },
      groups: { g1: { id: 'g1', name: 'G1', servers: ['s1'] } },
    });
  });
});

describe('shutdownGroupMcpRouter', () => {
  it('关闭全部 handler 与 service 并清空缓存', async () => {
    const s1 = makeServiceStub();
    const s2 = makeServiceStub();
    const h1 = makeHandlerStub();
    groupServices.set('g1', s1);
    groupServices.set('g2', s2);
    groupHandlers.set('g1', h1);

    await shutdownGroupMcpRouter();

    expect(h1.close).toHaveBeenCalledTimes(1);
    expect(s1.shutdown).toHaveBeenCalledTimes(1);
    expect(s2.shutdown).toHaveBeenCalledTimes(1);
    expect(groupServices.size).toBe(0);
    expect(groupHandlers.size).toBe(0);
  });

  it('单个 handler.close / service.shutdown 抛错不阻断其余关闭', async () => {
    const s1 = makeServiceStub({
      shutdown: vi.fn().mockRejectedValue(new Error('s1 boom')),
    });
    const s2 = makeServiceStub();
    const h1 = makeHandlerStub({
      close: vi.fn().mockRejectedValue(new Error('h1 boom')),
    });
    groupServices.set('g1', s1);
    groupServices.set('g2', s2);
    groupHandlers.set('g1', h1);

    await expect(shutdownGroupMcpRouter()).resolves.toBeUndefined();

    expect(s2.shutdown).toHaveBeenCalledTimes(1);
    expect(groupServices.size).toBe(0);
    expect(groupHandlers.size).toBe(0);
  });

  it('空缓存时关闭幂等', async () => {
    await expect(shutdownGroupMcpRouter()).resolves.toBeUndefined();
    expect(groupServices.size).toBe(0);
  });
});

describe('groupMcpRouter - 路由契约', () => {
  it('仅暴露 mcp/status/tools 三条路由（middleware 也登记在 routes 中，按路径+方法去重）', () => {
    const routes = [
      ...new Set(
        groupMcpRouter.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`),
      ),
    ].toSorted();
    expect(routes).toEqual(['GET /:group/status', 'GET /:group/tools', 'POST /:group/mcp']);
  });
});
