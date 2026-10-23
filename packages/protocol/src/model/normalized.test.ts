import { describe, expect, it } from 'vitest';

import {
  normalizeInboundRequest,
  normalizeCall,
  okResult,
  inputRequiredResult,
  errorResult,
} from './normalized.js';

describe('normalized model', () => {
  it('normalizeInboundRequest 提取 method/params/meta/era（浅拷贝键形态精确）', () => {
    const r = normalizeInboundRequest({
      method: 'tools/call',
      params: { name: 'foo', arguments: { x: 1 } },
      meta: { clientInfo: { name: 'c', version: '1' } },
      era: 'modern',
    });
    expect(r).toStrictEqual({
      method: 'tools/call',
      params: { name: 'foo', arguments: { x: 1 } },
      meta: { clientInfo: { name: 'c', version: '1' } },
      era: 'modern',
    });
  });

  it('okResult 默认 isError=false（成功结果键形态精确）', () => {
    expect(okResult([{ type: 'text', text: 'hi' }])).toStrictEqual({
      kind: 'success',
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
    });
  });

  it('normalizeCall 组装 toolName/arguments，未提供 mrtr 时无 mrtr 键', () => {
    expect(normalizeCall({ toolName: 'foo', arguments: { x: 1 } })).toStrictEqual({
      toolName: 'foo',
      arguments: { x: 1 },
    });
  });

  it('inputRequiredResult 携带 inputRequests，mrtr 默认空对象', () => {
    expect(inputRequiredResult({ key: {} })).toStrictEqual({
      kind: 'input_required',
      inputRequests: { key: {} },
      mrtr: {},
    });
  });

  it('errorResult 携带归一化错误（code/message 逐字段）', () => {
    expect(errorResult({ code: -32603, message: 'boom' })).toStrictEqual({
      kind: 'error',
      error: { code: -32603, message: 'boom' },
    });
  });
});
