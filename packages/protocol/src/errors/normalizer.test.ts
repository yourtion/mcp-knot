import { describe, expect, it } from 'vitest';

import { normalizeError, toJsonRpcError, UnifiedErrorNormalizer } from './normalizer.js';

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

  // —— 分支精细化：断言精确到协议错误码与输出键形态 ——

  it('null 输入走兜底，输出 -32603 / "Internal error"（不落入对象成员分支）', () => {
    expect(normalizeError(null)).toStrictEqual({ code: -32603, message: 'Internal error' });
  });

  it('对象带 code/message 但 code 非 number 时，code 回退 -32603', () => {
    expect(normalizeError({ code: 'oops', message: 'm' })).toStrictEqual({
      code: -32603,
      message: 'm',
    });
  });

  it('对象带 code/message 但 message 非 string 时，message 回退 "Internal error"', () => {
    expect(normalizeError({ code: -32601, message: 42 })).toStrictEqual({
      code: -32601,
      message: 'Internal error',
    });
  });

  it('对象缺 code 键时不进规范化分支，走兜底（Error 分支不得误吞非 Error 对象）', () => {
    expect(normalizeError({ message: 'looks-like-error' })).toStrictEqual({
      code: -32603,
      message: 'Internal error',
    });
  });

  it('输入无 data 键时输出不携带 data 键（键形态精确）', () => {
    expect(normalizeError({ code: -32601, message: 'm' })).toStrictEqual({
      code: -32601,
      message: 'm',
    });
  });

  it('Error 实例空消息回退 "Internal error"', () => {
    expect(normalizeError(new Error(''))).toStrictEqual({
      code: -32603,
      message: 'Internal error',
    });
  });

  it('toJsonRpcError 携带 data 时完整透传 code/message/data 三键', () => {
    expect(
      toJsonRpcError({ code: -32602, message: 'bad params', data: { method: 'foo' } }),
    ).toEqual({ code: -32602, message: 'bad params', data: { method: 'foo' } });
  });
});

// 类方法：薄委托，补直接断言。
describe('UnifiedErrorNormalizer 类方法', () => {
  const normalizer = new UnifiedErrorNormalizer();

  it('normalize 与同名纯函数一致', () => {
    const e = normalizer.normalize(new Error('x'));
    expect(e.code).toBe(-32603);
    expect(e.message).toBe('x');
  });

  it('toJsonRpc 与同名纯函数一致（无 data 时省略 data 键）', () => {
    const obj = normalizer.toJsonRpc({ code: -32601, message: 'm' });
    expect(obj).toEqual({ code: -32601, message: 'm' });
    expect('data' in obj).toBe(false);
  });
});
