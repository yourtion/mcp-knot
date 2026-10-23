/**
 * MRTR stateKey 解析优先级单测（变异覆盖批次）
 *
 * resolveMrtrKey 是模块私有函数，经 getMrtrRelay（ensureGroupMcpService 首次调用时触发）
 * 间接覆盖。relay 是进程级单例，故每个用例用 vi.resetModules() 重置模块状态后重新
 * import factory，保证每个用例独立走一次「读 config → resolveMrtrKey → 构造 relay」。
 *
 * 覆盖 key 候选优先级：
 *   1. system.json mrtr.stateKey（hex，解码后 ≥32 字节）
 *   2. 环境变量 MRTR_REQUEST_STATE_KEY（hex，解码后 ≥32 字节）
 *   3. 随机生成 32 字节
 * 以及 stateTtlSeconds 从 config 读取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { relayCtorCalls, getAllConfigMock } = vi.hoisted(() => ({
  relayCtorCalls: [] as Array<{ key: Uint8Array; ttlSeconds: number }>,
  getAllConfigMock: vi.fn(),
}));

vi.mock('./group-service.js', () => ({
  GroupMcpService: vi.fn(function (this: unknown) {
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.getMcpServer = vi.fn();
  }),
}));

vi.mock('../../services/mrtr-relay-service.js', () => ({
  MrtrRelayService: vi.fn(function (this: unknown, opts: { key: Uint8Array; ttlSeconds: number }) {
    relayCtorCalls.push({ key: opts.key, ttlSeconds: opts.ttlSeconds });
    Object.defineProperty(this, 'verify', { value: vi.fn(), configurable: true });
  }),
}));

vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: vi.fn(() => {
    throw new Error('createMcpHandler 不应在本测试中被调用');
  }),
}));

vi.mock('../../services/service-registry.js', () => ({
  getCoreServiceManager: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../utils/config.js', () => ({ getAllConfig: getAllConfigMock }));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// 64 个 hex 字符 = 32 字节
const KEY_HEX_A = 'aa'.repeat(32);
const KEY_HEX_B = 'bb'.repeat(32);
const KEY_HEX_SHORT = 'abcd'; // 2 字节，不足 32

async function ensureWithMrtr(mrtr: Record<string, unknown> | undefined): Promise<void> {
  vi.resetModules();
  relayCtorCalls.length = 0;
  getAllConfigMock.mockReset();
  getAllConfigMock.mockResolvedValue({
    system: mrtr === undefined ? {} : { mrtr },
  });
  const factory = await import('./mcp-handler-factory.js');
  factory.getGroupServicesCache().clear();
  await factory.ensureGroupMcpService('g1');
}

describe('MRTR stateKey 解析优先级', () => {
  beforeEach(() => {
    delete process.env['MRTR_REQUEST_STATE_KEY'];
  });

  afterEach(() => {
    delete process.env['MRTR_REQUEST_STATE_KEY'];
  });

  it('system.json mrtr.stateKey（≥32 字节）被用于构造 relay，ttl 从 config 读取', async () => {
    await ensureWithMrtr({ enabled: true, stateTtlSeconds: 1234, stateKey: KEY_HEX_A });

    expect(relayCtorCalls).toHaveLength(1);
    expect(relayCtorCalls[0]!.ttlSeconds).toBe(1234);
    expect(Buffer.from(relayCtorCalls[0]!.key).toString('hex')).toBe(KEY_HEX_A);
  });

  it('stateKey 缺失时回退环境变量 MRTR_REQUEST_STATE_KEY', async () => {
    process.env['MRTR_REQUEST_STATE_KEY'] = KEY_HEX_B;
    await ensureWithMrtr({ enabled: true, stateTtlSeconds: 600 });

    expect(relayCtorCalls).toHaveLength(1);
    expect(Buffer.from(relayCtorCalls[0]!.key).toString('hex')).toBe(KEY_HEX_B);
  });

  it('stateKey 优先于环境变量（两者都提供时用 stateKey）', async () => {
    process.env['MRTR_REQUEST_STATE_KEY'] = KEY_HEX_B;
    await ensureWithMrtr({ enabled: true, stateTtlSeconds: 600, stateKey: KEY_HEX_A });

    expect(Buffer.from(relayCtorCalls[0]!.key).toString('hex')).toBe(KEY_HEX_A);
  });

  it('stateKey 解码后不足 32 字节时回退下一候选（环境变量）', async () => {
    process.env['MRTR_REQUEST_STATE_KEY'] = KEY_HEX_B;
    await ensureWithMrtr({ enabled: true, stateTtlSeconds: 600, stateKey: KEY_HEX_SHORT });

    expect(Buffer.from(relayCtorCalls[0]!.key).toString('hex')).toBe(KEY_HEX_B);
  });

  it('所有候选都不可用时随机生成 32 字节 key（与候选值不同）', async () => {
    await ensureWithMrtr({ enabled: true, stateTtlSeconds: 600, stateKey: KEY_HEX_SHORT });

    expect(relayCtorCalls).toHaveLength(1);
    const key = relayCtorCalls[0]!.key;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
    // 随机 key 不等于短候选的解码，也几乎不可能为全 0
    expect(Buffer.from(key).toString('hex')).not.toBe(KEY_HEX_SHORT);
    expect(key.some((b) => b !== 0)).toBe(true);
  });

  it('mrtr 配置缺失时按默认 ttl=600 与随机 key 构造', async () => {
    await ensureWithMrtr(undefined);

    expect(relayCtorCalls).toHaveLength(1);
    expect(relayCtorCalls[0]!.ttlSeconds).toBe(600);
    expect(relayCtorCalls[0]!.key.byteLength).toBe(32);
  });
});
