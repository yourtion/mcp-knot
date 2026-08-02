import { describe, expect, it } from 'vitest';

import { normalizeCall } from '../model/normalized.js';
import { translateCallForUpstream, translateUpstreamResult } from './adapter.js';

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
