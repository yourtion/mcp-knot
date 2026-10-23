/**
 * 工具函数模块测试
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deepMerge,
  delay,
  formatError,
  generateId,
  isEmpty,
  isNumber,
  isObject,
  isString,
  retry,
  safeJsonParse,
  safeJsonStringify,
  withTimeout,
} from './index.js';

describe('delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('应该延迟指定毫秒后 resolve', async () => {
    let resolved = false;
    const promise = delay(100);
    promise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('resolve 值应为 undefined', async () => {
    vi.advanceTimersByTimeAsync(10);
    await expect(delay(10)).resolves.toBeUndefined();
  });
});

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('第一次成功时直接返回结果且不重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await retry(fn, { maxAttempts: 3, delay: 100 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('失败后重试直到成功', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('第1次失败'))
      .mockRejectedValueOnce(new Error('第2次失败'))
      .mockResolvedValue('recovered');

    const promise = retry(fn, { maxAttempts: 3, delay: 100 });
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('达到最大次数后抛出最后一次的错误', async () => {
    const error = new Error('始终失败');
    const fn = vi.fn().mockRejectedValue(error);

    const promise = retry(fn, { maxAttempts: 3, delay: 50 });
    const assertion = expect(promise).rejects.toThrow('始终失败');
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('maxAttempts=1 时失败后立即抛错且不等待', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('唯一一次'));

    const promise = retry(fn, { maxAttempts: 1, delay: 1000 });
    const assertion = expect(promise).rejects.toThrow('唯一一次');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('未指定 backoff 时每次重试间隔固定为 delay', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('ok');

    const promise = retry(fn, { maxAttempts: 3, delay: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);
    await expect(promise).resolves.toBe('ok');
  });

  it('指定 backoff 时按指数退避计算间隔', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('ok');

    const start = Date.now();
    const promise = retry(fn, { maxAttempts: 3, delay: 100, backoff: 2 });
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    // 间隔序列：100 * 2^0 = 100，100 * 2^1 = 200，总耗时 300ms
    expect(result).toBe('ok');
    expect(Date.now() - start).toBe(300);
  });

  it('backoff=0 时按 1 处理（间隔固定）', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('ok');

    const start = Date.now();
    const promise = retry(fn, { maxAttempts: 3, delay: 100, backoff: 0 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBe('ok');

    expect(Date.now() - start).toBe(200);
  });
});

describe('deepMerge', () => {
  it('递归合并嵌套对象并保留双方字段', () => {
    const target = { a: { x: 1, y: 2 }, keep: 'target' };
    const source = { a: { y: 9, z: 3 } };

    expect(deepMerge(target, source)).toEqual({
      a: { x: 1, y: 9, z: 3 },
      keep: 'target',
    });
  });

  it('多层嵌套也递归合并', () => {
    const target = { a: { b: { x: 1 } } };
    const source = { a: { b: { y: 2 }, c: 3 } };

    expect(deepMerge(target, source)).toEqual({ a: { b: { x: 1, y: 2 }, c: 3 } });
  });

  it('源值为数组时整体替换而不是合并', () => {
    const target = { a: { x: 1 } };
    const source = { a: [1, 2] };

    expect(deepMerge(target, source)).toEqual({ a: [1, 2] });
  });

  it('目标值为数组、源值为对象时整体替换', () => {
    const target = { a: [1, 2] };
    const source = { a: { x: 5 } };

    expect(deepMerge(target, source)).toEqual({ a: { x: 5 } });
  });

  it('源值为原始类型时覆盖目标嵌套对象', () => {
    const target = { a: { x: 1 } };
    const source = { a: 42 };

    expect(deepMerge(target, source)).toEqual({ a: 42 });
  });

  it('源值为 null 时覆盖目标值', () => {
    const target = { a: { x: 1 }, b: 1 };
    const source = { a: null, b: null };

    expect(deepMerge(target, source)).toEqual({ a: null, b: null });
  });

  it('源值为 undefined 时保留目标值', () => {
    const target = { a: 1, b: 'kept' };
    const source = { a: undefined, c: 3 };

    expect(deepMerge(target, source)).toEqual({ a: 1, b: 'kept', c: 3 });
  });

  it('源对象新增 key 时写入结果', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('源为空对象时返回目标副本', () => {
    const target = { a: 1 };
    const result = deepMerge(target, {});

    expect(result).toEqual({ a: 1 });
    expect(result).not.toBe(target);
  });

  it('不修改原始 target 对象', () => {
    const target = { a: { x: 1 } };
    const snapshot = JSON.parse(JSON.stringify(target));

    deepMerge(target, { a: { y: 2 } });

    expect(target).toEqual(snapshot);
  });
});

describe('generateId', () => {
  it('返回仅包含小写字母和数字的字符串', () => {
    expect(generateId()).toMatch(/^[a-z0-9]+$/);
  });

  it('两次调用生成不同 ID', () => {
    expect(generateId()).not.toBe(generateId());
  });
});

describe('safeJsonParse', () => {
  it('合法 JSON 返回解析结果', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}', null)).toEqual({ a: 1 });
  });

  it('非法 JSON 返回默认值', () => {
    expect(safeJsonParse('not-json', 'fallback')).toBe('fallback');
  });

  it('默认值可以是对象', () => {
    expect(safeJsonParse('[broken', { x: 1 })).toEqual({ x: 1 });
  });
});

describe('safeJsonStringify', () => {
  it('正常序列化对象', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('支持缩进参数', () => {
    const result = safeJsonStringify({ a: 1 }, 2);

    expect(result).toBe('{\n  "a": 1\n}');
  });

  it('循环引用时返回 "{}"', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;

    expect(safeJsonStringify(obj)).toBe('{}');
  });
});

describe('isEmpty', () => {
  it('null 和 undefined 为空', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
  });

  it('空数组与空对象为空', () => {
    expect(isEmpty([])).toBe(true);
    expect(isEmpty({})).toBe(true);
  });

  it('非空数组与非空对象不为空', () => {
    expect(isEmpty([1])).toBe(false);
    expect(isEmpty({ a: 1 })).toBe(false);
  });

  it('原始类型值不为空', () => {
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty('')).toBe(false);
    expect(isEmpty(false)).toBe(false);
  });
});

describe('isString', () => {
  it('字符串返回 true', () => {
    expect(isString('abc')).toBe(true);
    expect(isString('')).toBe(true);
  });

  it('非字符串返回 false', () => {
    expect(isString(123)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
    expect(isString({})).toBe(false);
  });
});

describe('isNumber', () => {
  it('有限数字返回 true', () => {
    expect(isNumber(0)).toBe(true);
    expect(isNumber(-1.5)).toBe(true);
  });

  it('NaN 返回 false', () => {
    expect(isNumber(Number.NaN)).toBe(false);
  });

  it('非数字返回 false', () => {
    expect(isNumber('123')).toBe(false);
    expect(isNumber(null)).toBe(false);
    expect(isNumber(undefined)).toBe(false);
  });
});

describe('isObject', () => {
  it('普通对象返回 true', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it('null 返回 false', () => {
    expect(isObject(null)).toBe(false);
  });

  it('数组返回 false', () => {
    expect(isObject([])).toBe(false);
  });

  it('原始类型返回 false', () => {
    expect(isObject('str')).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

describe('formatError', () => {
  it('格式化为 "name: message"', () => {
    const error = new TypeError('boom');

    expect(formatError(error)).toBe('TypeError: boom');
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Promise 先完成时返回其结果', async () => {
    const result = await withTimeout(Promise.resolve('fast'), 1000);

    expect(result).toBe('fast');
  });

  it('超时后使用默认消息拒绝', async () => {
    const promise = withTimeout(new Promise(() => {}), 50);
    const assertion = expect(promise).rejects.toThrow('操作超时');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('超时后使用自定义消息拒绝', async () => {
    const promise = withTimeout(new Promise(() => {}), 50, '自定义超时消息');
    const assertion = expect(promise).rejects.toThrow('自定义超时消息');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('超时前 Promise reject 时透传原始错误', async () => {
    const promise = withTimeout(Promise.reject(new Error('业务错误')), 5000);
    const assertion = expect(promise).rejects.toThrow('业务错误');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});
