import { describe, expect, it } from 'vitest';

import { normalizeError, toJsonRpcError } from './normalizer.js';

describe('UnifiedErrorNormalizer', () => {
  it('SDK 风格错误（含 code/message/data）原样归一', () => {
    const e = normalizeError({
      code: -32601,
      message: 'method not found',
      data: { method: 'foo' },
    });
    expect(e.code).toBe(-32601);
    expect(e.data).toEqual({ method: 'foo' });
  });

  it('裸 Error 转为 -32603 internal error', () => {
    const e = normalizeError(new Error('boom'));
    expect(e.code).toBe(-32603);
    expect(e.message).toBe('boom');
  });

  it('未知对象兜底 -32603', () => {
    const e = normalizeError('whatever');
    expect(e.code).toBe(-32603);
  });

  it('toJsonRpcError 输出标准 JSON-RPC error object', () => {
    const obj = toJsonRpcError({ code: -32602, message: 'bad params' });
    expect(obj).toEqual({ code: -32602, message: 'bad params' });
  });
});
