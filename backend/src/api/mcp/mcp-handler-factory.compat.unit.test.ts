import {
  CompatibilityOptionsSchema,
  InboundProtocolAdapter,
  defaultCompatibilityOptions,
} from '@mcp-core/mcp-knot-protocol';
/**
 * P7 Task 9：协议兼容层入站集成单测。
 *
 * 验证：
 * - CompatibilityOptions 默认全开时 InboundProtocolAdapter.resolveLegacyMode('http')
 *   返回 'stateless'（HTTP 走无状态 legacy shim，SDK 服务 legacy 客户端）。
 * - inbound.enabled=false / legacyMode='reject' 时返回 'reject'。
 * - getCompatibilityOptions 单例从 system.json compatibility 段读取（缺失回退默认全开）。
 *
 * 隔离到独立文件，避免与 mcp-handler-factory.unit.test.ts（失效路径，getCoreServiceManager
 * 被桩成抛错）/ mcp-handler-factory.mrtr.unit.test.ts（mrtr 接线）的 vi.mock 冲突。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock createMcpHandler 不在 compat 单测路径触发（仅 createGroupMcpHandler 用，本测试不调）。
vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: vi.fn(() => {
    throw new Error('createMcpHandler 不应在本测试中被调用');
  }),
}));

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

// getAllConfig 受控返回（getCompatibilityOptions 从 system.compatibility 读）。
// 默认 mock：无 compatibility 段（回退默认全开）。各用例可在 beforeEach 后覆写。
const { getAllConfigMock } = vi.hoisted(() => ({
  getAllConfigMock: vi.fn(),
}));
vi.mock('../../utils/config.js', () => ({
  getAllConfig: getAllConfigMock,
}));

import type { CompatibilityOptions } from '@mcp-core/mcp-knot-protocol';

describe('P7 协议兼容层入站集成', () => {
  describe('InboundProtocolAdapter.resolveLegacyMode', () => {
    it('compatibility 默认全开时 legacyMode=http → stateless', () => {
      const adapter = new InboundProtocolAdapter(defaultCompatibilityOptions);
      expect(adapter.resolveLegacyMode('http')).toBe('stateless');
    });

    it('inbound.enabled=false → reject（拒绝 legacy 流量）', () => {
      const opts = CompatibilityOptionsSchema.parse({
        inbound: { enabled: false, legacyMode: 'shim' },
      }) satisfies CompatibilityOptions;
      const adapter = new InboundProtocolAdapter(opts);
      expect(adapter.resolveLegacyMode('http')).toBe('reject');
    });

    it("inbound.legacyMode='reject' → reject", () => {
      const opts = CompatibilityOptionsSchema.parse({
        inbound: { enabled: true, legacyMode: 'reject' },
      }) satisfies CompatibilityOptions;
      const adapter = new InboundProtocolAdapter(opts);
      expect(adapter.resolveLegacyMode('http')).toBe('reject');
    });

    it('stdio 传输默认全开 → serve', () => {
      const adapter = new InboundProtocolAdapter(defaultCompatibilityOptions);
      expect(adapter.resolveLegacyMode('stdio')).toBe('serve');
    });

    it('CompatibilityOptionsSchema.parse({}) 回退默认全开（inbound.enabled=true, legacyMode=shim）', () => {
      const opts = CompatibilityOptionsSchema.parse({});
      expect(opts.inbound.enabled).toBe(true);
      expect(opts.inbound.legacyMode).toBe('shim');
      const adapter = new InboundProtocolAdapter(opts);
      expect(adapter.resolveLegacyMode('http')).toBe('stateless');
    });
  });

  describe('getCompatibilityOptions 单例', () => {
    beforeEach(async () => {
      // 每个用例前重置单例缓存，让各用例独立读 config（mock）
      const mod = await import('./mcp-handler-factory.js');
      mod.resetCompatibilityOptionsCacheForTest();
      getAllConfigMock.mockReset();
    });

    it('system.json 无 compatibility 段时回退默认全开', async () => {
      getAllConfigMock.mockResolvedValue({ system: {} });
      const { getCompatibilityOptions } = await import('./mcp-handler-factory.js');
      const opts = await getCompatibilityOptions();
      expect(opts.inbound.enabled).toBe(true);
      expect(opts.inbound.legacyMode).toBe('shim');
      expect(opts.outbound.modernOnly).toBe(false);
      expect(opts.errors.unified).toBe(true);
    });

    it('system.json 提供显式 compatibility 段时按配置解析', async () => {
      getAllConfigMock.mockResolvedValue({
        system: {
          compatibility: {
            inbound: { enabled: false, legacyMode: 'shim' },
          },
        },
      });
      const { getCompatibilityOptions } = await import('./mcp-handler-factory.js');
      const opts = await getCompatibilityOptions();
      expect(opts.inbound.enabled).toBe(false);
      // outbound/errors 缺失字段经 schema default 回填
      expect(opts.outbound.modernOnly).toBe(false);
      expect(opts.errors.unified).toBe(true);
    });

    it('getAllConfig 抛错时回退默认全开（不阻断）', async () => {
      getAllConfigMock.mockRejectedValue(new Error('config read boom'));
      const { getCompatibilityOptions } = await import('./mcp-handler-factory.js');
      const opts = await getCompatibilityOptions();
      expect(opts.inbound.enabled).toBe(true);
      expect(opts.inbound.legacyMode).toBe('shim');
    });
  });
});
