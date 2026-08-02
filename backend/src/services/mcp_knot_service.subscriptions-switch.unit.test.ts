/**
 * P5 修复（代码审查 C1）：subscriptions.enabled 开关单测。
 *
 * 验证：
 *   - subscriptions.enabled=false 时 UpstreamChangeDetector /
 *     UpstreamChangeFanout 不被构造（subscriptions 链路全关），
 *     且 initialize() 不触发 startPolling。
 *   - subscriptions.enabled=true（默认，含整块缺失）时两者正常构造，
 *     保证向后兼容。
 *
 * 通过 spy detector/fanout 类的构造函数断言「是否构造」，避免依赖
 * McpKnotService 的私有字段。ServerManager 的 listChanged handler 注册
 * 由 detector 是否注入决定——构造期不连接真实 server，故仅断言构造次数。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 提升捕获数组（vi.mock 工厂被 hoist）
const { detectorCtorCalls, fanoutCtorCalls, startPollingCalls } = vi.hoisted(() => ({
  detectorCtorCalls: [] as Array<unknown[]>,
  fanoutCtorCalls: [] as Array<unknown[]>,
  startPollingCalls: [] as Array<unknown[]>,
}));

vi.mock('./upstream-change-detector.js', () => ({
  UpstreamChangeDetector: vi.fn(function (this: unknown, opts: unknown) {
    detectorCtorCalls.push([opts]);
    this.saveSnapshot = vi.fn();
    this.onUpstreamNotification = vi.fn();
    this.stop = vi.fn();
    this.startPolling = vi.fn(async () => {
      startPollingCalls.push([]);
    });
  }),
}));

vi.mock('./upstream-change-fanout.js', () => ({
  UpstreamChangeFanout: vi.fn(function (this: unknown, opts: unknown) {
    fanoutCtorCalls.push([opts]);
    this.handleServerChange = vi.fn();
    this.stop = vi.fn();
    this.flush = vi.fn();
  }),
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: vi.fn(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: 't1' }] }),
      callTool: vi.fn(),
      setNotificationHandler: vi.fn(),
    };
  }),
}));
// auto-mock（无工厂）：StdioClientTransport 变成可 new 的 vi.fn()，避免 connectStdioServer
// 因 `new undefined()` 抛错（与 integration.test.ts 同模式）。
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () {
    return {};
  }),
}));
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logToolExecution: vi.fn(),
    logServerConnection: vi.fn(),
    logToolDiscovery: vi.fn(),
  },
}));

import { McpKnotService } from './mcp_knot_service.js';

import type {
  DeepReadonly,
  GroupConfig,
  ServerConfig,
  SystemConfig,
} from '@mcp-core/mcp-knot-share';

const serverConfigs: Record<string, ServerConfig> = {
  s1: { type: 'stdio', command: 'node', args: ['x.js'], enabled: true },
};
const groupConfigs: GroupConfig = {
  default: {
    id: 'default',
    name: 'Default',
    description: '',
    servers: ['s1'],
    tools: [],
  },
} as GroupConfig;

describe('subscriptions.enabled 开关（P5 修复 C1）', () => {
  beforeEach(() => {
    detectorCtorCalls.length = 0;
    fanoutCtorCalls.length = 0;
    startPollingCalls.length = 0;
  });

  it('subscriptions.enabled=false：不构造 detector/fanout，initialize 不 startPolling', async () => {
    const systemConfig = {
      subscriptions: { enabled: false },
    } as unknown as DeepReadonly<SystemConfig>;

    const svc = new McpKnotService(serverConfigs, groupConfigs, undefined, systemConfig);
    await svc.initialize();

    expect(detectorCtorCalls).toHaveLength(0);
    expect(fanoutCtorCalls).toHaveLength(0);
    expect(startPollingCalls).toHaveLength(0);

    await svc.shutdown();
  });

  it('subscriptions.enabled=true（显式）：构造 detector/fanout，initialize 触发 startPolling', async () => {
    const systemConfig = {
      subscriptions: { enabled: true, pollIntervalMs: 1000 },
    } as unknown as DeepReadonly<SystemConfig>;

    const svc = new McpKnotService(serverConfigs, groupConfigs, undefined, systemConfig);
    await svc.initialize();

    expect(detectorCtorCalls).toHaveLength(1);
    expect(fanoutCtorCalls).toHaveLength(1);
    // s1 connected → startPolling 被调用
    expect(startPollingCalls).toHaveLength(1);

    await svc.shutdown();
  });

  it('subscriptions 整块缺失（默认 true）：detector/fanout 正常构造（向后兼容）', async () => {
    const svc = new McpKnotService(serverConfigs, groupConfigs, undefined, undefined);
    await svc.initialize();

    expect(detectorCtorCalls).toHaveLength(1);
    expect(fanoutCtorCalls).toHaveLength(1);

    await svc.shutdown();
  });
});
