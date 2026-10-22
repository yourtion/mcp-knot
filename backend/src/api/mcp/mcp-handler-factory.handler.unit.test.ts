/**
 * createGroupMcpHandler / ensureGroupMcpService 行为单测（变异覆盖批次）
 *
 * 与既有 4 个 factory 测试文件（失效钩子 / mrtr 接线 / mrtr-disabled / compat）互补，覆盖：
 * - createGroupMcpHandler：createMcpHandler 装配参数（factory 闭包 / legacy / onerror）、
 *   handler 缓存复用、并发 inflight 去重、compatibility 决定 legacy reject
 * - factory 闭包：命中缓存返回该组 McpServer；缓存缺失时抛「未初始化」错误
 * - onerror 回调委托 logger.error（含 groupId）
 * - ensureGroupMcpService：缓存命中不重建、并发去重、invalidate 后重建
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { groupCtorCalls, createHandlerCalls } = vi.hoisted(() => ({
  // GroupMcpService 构造记录（含 getMcpServer 返回的 server 哨兵与注入参数）
  groupCtorCalls: [] as Array<{
    groupId: string;
    coreServiceManager: unknown;
    mrtrRelay?: unknown;
    mcpServer: { sentinel: string };
  }>,
  // createMcpHandler 调用记录（factory 闭包 + options）
  createHandlerCalls: [] as Array<{
    factory: () => unknown;
    options: { legacy?: string; onerror?: (error: Error) => void };
  }>,
}));

vi.mock('./group-service.js', () => ({
  GroupMcpService: vi.fn(function (
    this: unknown,
    groupId: string,
    coreServiceManager: unknown,
    mrtrRelay?: unknown,
  ) {
    const mcpServer = { sentinel: `mcp-server-${groupId}` };
    groupCtorCalls.push({ groupId, coreServiceManager, mrtrRelay, mcpServer });
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.getMcpServer = vi.fn().mockReturnValue(mcpServer);
  }),
}));

vi.mock('../../services/mrtr-relay-service.js', () => ({
  MrtrRelayService: vi.fn(function (this: unknown) {
    Object.defineProperty(this, 'verify', { value: vi.fn(), configurable: true });
  }),
}));

vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: vi.fn(
    (factory: () => unknown, options: { legacy?: string; onerror?: (error: Error) => void }) => {
      createHandlerCalls.push({ factory, options });
      return { fetch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    },
  ),
}));

vi.mock('../../services/service-registry.js', () => ({
  getCoreServiceManager: vi.fn().mockResolvedValue({ manager: true }),
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

import { logger } from '../../utils/logger.js';
import {
  createGroupMcpHandler,
  ensureGroupMcpService,
  getGroupServicesCache,
  invalidateGroupMcpService,
  resetCompatibilityOptionsCacheForTest,
} from './mcp-handler-factory.js';

async function resetCaches(): Promise<void> {
  getGroupServicesCache().clear();
  const { getGroupHandlersCache } = await import('./mcp-handler-factory.js');
  getGroupHandlersCache().clear();
}

beforeEach(async () => {
  groupCtorCalls.length = 0;
  createHandlerCalls.length = 0;
  vi.clearAllMocks();
  // 默认配置：无 compatibility / mrtr 段（schema 默认全开、mrtr enabled）
  getAllConfigMock.mockReset();
  getAllConfigMock.mockResolvedValue({ system: {} });
  resetCompatibilityOptionsCacheForTest();
  await resetCaches();
});

describe('createGroupMcpHandler - 装配', () => {
  it('首次创建：构造 service、createMcpHandler 收到 stateless legacy 与 onerror', async () => {
    await createGroupMcpHandler('g1');

    expect(groupCtorCalls).toHaveLength(1);
    expect(groupCtorCalls[0]!.groupId).toBe('g1');
    expect(createHandlerCalls).toHaveLength(1);
    const { options } = createHandlerCalls[0]!;
    expect(options.legacy).toBe('stateless');
    expect(typeof options.onerror).toBe('function');
  });

  it('factory 闭包返回该组的 McpServer 实例', async () => {
    await createGroupMcpHandler('g1');
    const { factory } = createHandlerCalls[0]!;
    expect(factory()).toBe(groupCtorCalls[0]!.mcpServer);
  });

  it('compatibility inbound.enabled=false 时 legacy 为 reject', async () => {
    getAllConfigMock.mockReset();
    getAllConfigMock.mockResolvedValue({
      system: { compatibility: { inbound: { enabled: false, legacyMode: 'shim' } } },
    });

    await createGroupMcpHandler('g2');

    expect(createHandlerCalls[0]!.options.legacy).toBe('reject');
  });

  it('onerror 回调把错误委托给 logger.error（携带 groupId）', async () => {
    await createGroupMcpHandler('g1');
    const { options } = createHandlerCalls[0]!;
    const boom = new Error('exchange failed');
    options.onerror!(boom);

    expect(logger.error).toHaveBeenCalledWith('组MCP handler 错误', boom, { groupId: 'g1' });
  });
});

describe('createGroupMcpHandler - 缓存与并发', () => {
  it('handler 按 groupId 缓存复用：第二次调用不重新装配', async () => {
    const first = await createGroupMcpHandler('g1');
    const second = await createGroupMcpHandler('g1');

    expect(second).toBe(first);
    expect(createHandlerCalls).toHaveLength(1);
    expect(groupCtorCalls).toHaveLength(1);
  });

  it('不同 groupId 各自装配 handler', async () => {
    await createGroupMcpHandler('g1');
    await createGroupMcpHandler('g2');

    expect(createHandlerCalls).toHaveLength(2);
    const factoryG1 = createHandlerCalls[0]!.factory;
    const factoryG2 = createHandlerCalls[1]!.factory;
    expect(factoryG1()).toBe(groupCtorCalls[0]!.mcpServer);
    expect(factoryG2()).toBe(groupCtorCalls[1]!.mcpServer);
  });

  it('并发首次创建共享同一 Promise，仅装配一次', async () => {
    const [a, b, c] = await Promise.all([
      createGroupMcpHandler('g1'),
      createGroupMcpHandler('g1'),
      createGroupMcpHandler('g1'),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(createHandlerCalls).toHaveLength(1);
    expect(groupCtorCalls).toHaveLength(1);
  });
});

describe('factory 闭包 - 缺失缓存防御', () => {
  it('组服务缓存缺失时闭包抛「未初始化」错误（消息含组名）', async () => {
    await createGroupMcpHandler('g9');
    const { factory } = createHandlerCalls[0]!;
    // 模拟「创建与失效并发」：service 缓存被外部清空后调用 factory
    getGroupServicesCache().delete('g9');

    expect(() => factory()).toThrow(/g9.*未初始化|未初始化.*g9/);
  });
});

describe('ensureGroupMcpService - 缓存与并发', () => {
  it('缓存命中时直接复用，不重复构造', async () => {
    await ensureGroupMcpService('g1');
    await ensureGroupMcpService('g1');
    expect(groupCtorCalls).toHaveLength(1);
  });

  it('并发首次调用共享同一 Promise，仅构造一个 service', async () => {
    await Promise.all([ensureGroupMcpService('g1'), ensureGroupMcpService('g1')]);
    expect(groupCtorCalls).toHaveLength(1);
  });

  it('invalidate 后再次 ensure 触发重建（新实例）', async () => {
    await ensureGroupMcpService('g1');
    const first = getGroupServicesCache().get('g1');

    await invalidateGroupMcpService('g1');
    await ensureGroupMcpService('g1');

    expect(groupCtorCalls).toHaveLength(2);
    expect(getGroupServicesCache().get('g1')).not.toBe(first);
  });

  it('构造 GroupMcpService 时注入 core manager 与 MRTR relay', async () => {
    await ensureGroupMcpService('g1');
    expect(groupCtorCalls).toHaveLength(1);
    // 第二参：来自 service registry 的 core manager
    expect(groupCtorCalls[0]!.coreServiceManager).toEqual({ manager: true });
    // 第三参：默认 mrtr enabled → relay 单例注入（有 verify 函数）
    const relay = groupCtorCalls[0]!.mrtrRelay;
    expect(relay).toBeDefined();
    expect(typeof (relay as { verify: unknown }).verify).toBe('function');
  });
});
