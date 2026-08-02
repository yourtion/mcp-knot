import { describe, expect, it } from 'vitest';

import {
  normalizeInboundRequest,
  normalizeCall,
  okResult,
  inputRequiredResult,
  errorResult,
} from './normalized.js';

describe('normalized model', () => {
  it('normalizeInboundRequest 提取 method/params/meta/era', () => {
    const r = normalizeInboundRequest({
      method: 'tools/call',
      params: { name: 'foo', arguments: { x: 1 } },
      meta: { clientInfo: { name: 'c', version: '1' } },
      era: 'modern',
    });
    expect(r.method).toBe('tools/call');
    expect(r.era).toBe('modern');
    expect((r.params as { name: string }).name).toBe('foo');
  });

  it('okResult 包含 content', () => {
    const r = okResult([{ type: 'text', text: 'hi' }]);
    expect(r.kind).toBe('success');
  });

  it('normalizeCall 组装 toolName/arguments/mrtr', () => {
    const c = normalizeCall({ toolName: 'foo', arguments: { x: 1 } });
    expect(c.toolName).toBe('foo');
    expect((c.arguments as { x: number }).x).toBe(1);
    expect(c.mrtr).toBeUndefined();
  });

  it('inputRequiredResult 携带 inputRequests', () => {
    const r = inputRequiredResult({ key: {} });
    expect(r.kind).toBe('input_required');
    expect(r.mrtr).toBeDefined();
  });

  it('errorResult 携带归一化错误', () => {
    const r = errorResult({ code: -32603, message: 'boom' });
    expect(r.kind).toBe('error');
    expect(r.error.code).toBe(-32603);
  });
});
