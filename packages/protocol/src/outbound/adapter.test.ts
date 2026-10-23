import { describe, expect, it } from 'vitest';

import { defaultCompatibilityOptions } from '../config.js';
import { normalizeCall } from '../model/normalized.js';
import {
  OutboundProtocolAdapter,
  translateCallForUpstream,
  translateUpstreamResult,
} from './adapter.js';

describe('OutboundProtocolAdapter', () => {
  const call = normalizeCall({ toolName: 'foo', arguments: { x: 1 } });

  it('modern upstream：无 mrtr 时 wire 仅含 name/arguments（键形态精确）', () => {
    const wire = translateCallForUpstream(call, 'modern');
    expect(wire).toStrictEqual({ name: 'foo', arguments: { x: 1 } });
  });

  it('modern upstream 带 mrtr：顶层 inputResponses + requestState', () => {
    const callMrtr = normalizeCall({
      toolName: 'foo',
      arguments: { x: 1 },
      mrtr: { requestState: 'rs-token', inputResponses: { k: 'v' } },
    });
    expect(translateCallForUpstream(callMrtr, 'modern')).toStrictEqual({
      name: 'foo',
      arguments: { x: 1 },
      requestState: 'rs-token',
      inputResponses: { k: 'v' },
    });
  });

  it('legacy upstream：携带 mrtr 的 call 也只产出 name/arguments（era 分派不可退化为 modern）', () => {
    const callMrtr = normalizeCall({
      toolName: 'foo',
      arguments: { x: 1 },
      mrtr: { requestState: 'rs-token', inputResponses: { k: 'v' } },
    });
    expect(translateCallForUpstream(callMrtr, 'legacy')).toStrictEqual({
      name: 'foo',
      arguments: { x: 1 },
    });
  });

  it('modern result 缺 content 时归一为空 success（覆盖 ?? [] 与 isError ?? false 假分支）', () => {
    expect(translateUpstreamResult({}, 'modern')).toStrictEqual({
      kind: 'success',
      content: [],
      isError: false,
    });
  });

  it('modern result isError=true 透传且 content 原样归一', () => {
    const r = translateUpstreamResult(
      { content: [{ type: 'text', text: 'err' }], isError: true },
      'modern',
    );
    expect(r).toStrictEqual({
      kind: 'success',
      content: [{ type: 'text', text: 'err' }],
      isError: true,
    });
  });

  it('legacy result 缺 content/isError 时归一为空 success（覆盖 legacy translator 的 ?? 分支）', () => {
    expect(translateUpstreamResult({}, 'legacy')).toStrictEqual({
      kind: 'success',
      content: [],
      isError: false,
    });
  });

  it('legacy result isError=true 透传（legacy translator 的 isError ?? false 真分支）', () => {
    const r = translateUpstreamResult(
      { content: [{ type: 'text', text: 'legacy err' }], isError: true },
      'legacy',
    );
    expect(r).toStrictEqual({
      kind: 'success',
      content: [{ type: 'text', text: 'legacy err' }],
      isError: true,
    });
  });

  it('legacy era 忽略 modern 专属 resultType=input_required（era 分派不可退化为 modern）', () => {
    const r = translateUpstreamResult(
      {
        content: [{ type: 'text', text: 'ok' }],
        resultType: 'input_required',
        inputRequests: { key: {} },
        requestState: 'rs',
      },
      'legacy',
    );
    expect(r).toStrictEqual({
      kind: 'success',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
  });

  it('upstream input_required 归一：inputRequests 与 requestState 逐字段透传', () => {
    const r = translateUpstreamResult(
      {
        resultType: 'input_required',
        inputRequests: { key: { id: 'k1' } },
        requestState: 'rs',
      },
      'modern',
    );
    expect(r).toStrictEqual({
      kind: 'input_required',
      inputRequests: { key: { id: 'k1' } },
      mrtr: { requestState: 'rs' },
    });
  });
});

// ---------------------------------------------------------------------------
// OutboundProtocolAdapter 类方法：effectiveEra / handleLegacyMrtr /
// translateCall / translateResult。这些方法封装了「据 CompatibilityOptions
// 决策 era 与 MRTR 降级」的核心兼容逻辑，此前仅经纯函数间接覆盖，此处补直接断言。
// ---------------------------------------------------------------------------
describe('OutboundProtocolAdapter 类方法', () => {
  const call = normalizeCall({ toolName: 'foo', arguments: { x: 1 } });

  describe('effectiveEra', () => {
    it('默认(modernOnly=false)透传探测到的 era', () => {
      const adapter = new OutboundProtocolAdapter(defaultCompatibilityOptions);
      expect(adapter.effectiveEra('modern')).toBe('modern');
      expect(adapter.effectiveEra('legacy')).toBe('legacy');
    });

    it('modernOnly=true 时拒绝 legacy，保留 modern', () => {
      const opts = {
        ...defaultCompatibilityOptions,
        outbound: { ...defaultCompatibilityOptions.outbound, modernOnly: true },
      };
      const adapter = new OutboundProtocolAdapter(opts);
      expect(() => adapter.effectiveEra('legacy')).toThrow(/Legacy upstream is disabled/);
      expect(adapter.effectiveEra('modern')).toBe('modern');
    });
  });

  describe('handleLegacyMrtr', () => {
    it('返回 error 结果，code -32601（legacy upstream 不支持 input_required）', () => {
      // 默认 mrtrLegacyDegradation='shim'
      const adapter = new OutboundProtocolAdapter(defaultCompatibilityOptions);
      const r = adapter.handleLegacyMrtr();
      expect(r.kind).toBe('error');
      if (r.kind === 'error') {
        expect(r.error.code).toBe(-32601);
        expect(r.error.message).toMatch(/input_required|MRTR|legacy/i);
      }
    });

    it('mrtrLegacyDegradation=reject 同样返回 -32601（MVP 阶段 shim/reject 统一为不支持）', () => {
      const opts = {
        ...defaultCompatibilityOptions,
        outbound: {
          ...defaultCompatibilityOptions.outbound,
          mrtrLegacyDegradation: 'reject' as const,
        },
      };
      const adapter = new OutboundProtocolAdapter(opts);
      const r = adapter.handleLegacyMrtr();
      expect(r.kind).toBe('error');
      if (r.kind === 'error') {
        expect(r.error.code).toBe(-32601);
      }
    });
  });

  describe('translateCall 经 effectiveEra 收敛', () => {
    it('modernOnly=true 时禁止向 legacy 上游发送现代 MRTR 字段', () => {
      const adapter = new OutboundProtocolAdapter({
        ...defaultCompatibilityOptions,
        outbound: { ...defaultCompatibilityOptions.outbound, modernOnly: true },
      });
      expect(() => adapter.translateCall(call, 'legacy')).toThrow(/Legacy upstream is disabled/);
    });

    it('默认配置下 legacy era 产出 legacy wire（剥离 MRTR 字段）', () => {
      const adapter = new OutboundProtocolAdapter(defaultCompatibilityOptions);
      const callMrtr = normalizeCall({
        toolName: 'foo',
        arguments: {},
        mrtr: { requestState: 'rs', inputResponses: { k: 'v' } },
      });
      const wire = adapter.translateCall(callMrtr, 'legacy');
      expect(wire).toStrictEqual({ name: 'foo', arguments: {} });
    });
  });

  describe('translateResult 经 effectiveEra 收敛', () => {
    it('关闭出站兼容时拒绝 legacy 响应', () => {
      const adapter = new OutboundProtocolAdapter({
        ...defaultCompatibilityOptions,
        outbound: { ...defaultCompatibilityOptions.outbound, enabled: false },
      });
      expect(() => adapter.translateResult({ content: [] }, 'legacy')).toThrow(
        /Legacy upstream is disabled/,
      );
    });
  });

  it('call 默认配置 modern era 往返与纯函数 translateCallForUpstream 一致', () => {
    const adapter = new OutboundProtocolAdapter(defaultCompatibilityOptions);
    const wireViaClass = adapter.translateCall(call, 'modern');
    const wireViaFn = translateCallForUpstream(call, 'modern');
    expect(wireViaClass).toEqual(wireViaFn);
  });
});
