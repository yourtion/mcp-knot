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

  it('modern upstream：inputResponses/requestState 作为顶层字段', () => {
    const wire = translateCallForUpstream(call, 'modern');
    expect(wire.name).toBe('foo');
    expect(wire.arguments).toEqual({ x: 1 });
    // 无 mrtr 时不带 inputResponses/requestState
    expect('inputResponses' in wire).toBe(false);
  });

  it('modern upstream 带 mrtr：顶层 inputResponses + requestState', () => {
    const callMrtr = normalizeCall({
      toolName: 'foo',
      arguments: { x: 1 },
      mrtr: { requestState: 'rs-token', inputResponses: { k: 'v' } },
    });
    const wire = translateCallForUpstream(callMrtr, 'modern');
    expect(wire.requestState).toBe('rs-token');
    expect(wire.inputResponses).toEqual({ k: 'v' });
  });

  it('legacy upstream：丢弃 _meta envelope 风格字段，保留 name/arguments', () => {
    const wire = translateCallForUpstream(call, 'legacy');
    expect(wire.name).toBe('foo');
    expect('inputResponses' in wire).toBe(false);
  });

  it('upstream 成功结果归一为 success', () => {
    const r = translateUpstreamResult({ content: [{ type: 'text', text: 'ok' }] }, 'modern');
    expect(r.kind).toBe('success');
  });

  it('upstream input_required 归一为 input_required', () => {
    const r = translateUpstreamResult(
      {
        resultType: 'input_required',
        inputRequests: { key: {} },
        requestState: 'rs',
      },
      'modern',
    );
    expect(r.kind).toBe('input_required');
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

    it('modernOnly=true 时强制 modern，即使探测到 legacy', () => {
      const opts = {
        ...defaultCompatibilityOptions,
        outbound: { ...defaultCompatibilityOptions.outbound, modernOnly: true },
      };
      const adapter = new OutboundProtocolAdapter(opts);
      expect(adapter.effectiveEra('legacy')).toBe('modern');
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
    it('modernOnly=true 时，即使传 legacy era 也产出 modern wire（带 inputResponses 能力）', () => {
      const opts = {
        ...defaultCompatibilityOptions,
        outbound: { ...defaultCompatibilityOptions.outbound, modernOnly: true },
      };
      const adapter = new OutboundProtocolAdapter(opts);
      const callMrtr = normalizeCall({
        toolName: 'foo',
        arguments: {},
        mrtr: { requestState: 'rs', inputResponses: { k: 'v' } },
      });
      // 传 'legacy' era，但 modernOnly 应强制走 modern translator → wire 带 requestState
      const wire = adapter.translateCall(callMrtr, 'legacy');
      expect(wire.name).toBe('foo');
      expect(wire.requestState).toBe('rs');
      expect(wire.inputResponses).toEqual({ k: 'v' });
    });

    it('默认配置下 legacy era 产出 legacy wire（剥离 MRTR 字段）', () => {
      const adapter = new OutboundProtocolAdapter(defaultCompatibilityOptions);
      const callMrtr = normalizeCall({
        toolName: 'foo',
        arguments: {},
        mrtr: { requestState: 'rs', inputResponses: { k: 'v' } },
      });
      const wire = adapter.translateCall(callMrtr, 'legacy');
      expect(wire.name).toBe('foo');
      expect('requestState' in wire).toBe(false);
      expect('inputResponses' in wire).toBe(false);
    });
  });

  describe('translateResult 经 effectiveEra 收敛', () => {
    it('modernOnly=true 时，即使传 legacy era 也按 modern 归一（识别 input_required）', () => {
      const opts = {
        ...defaultCompatibilityOptions,
        outbound: { ...defaultCompatibilityOptions.outbound, modernOnly: true },
      };
      const adapter = new OutboundProtocolAdapter(opts);
      const r = adapter.translateResult(
        { resultType: 'input_required', inputRequests: { key: {} }, requestState: 'rs' },
        'legacy',
      );
      expect(r.kind).toBe('input_required');
    });
  });

  it('call 默认配置 modern era 往返与纯函数 translateCallForUpstream 一致', () => {
    const adapter = new OutboundProtocolAdapter(defaultCompatibilityOptions);
    const wireViaClass = adapter.translateCall(call, 'modern');
    const wireViaFn = translateCallForUpstream(call, 'modern');
    expect(wireViaClass).toEqual(wireViaFn);
  });
});
