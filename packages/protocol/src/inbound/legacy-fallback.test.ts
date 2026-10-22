import { legacyStatelessFallback, type McpServerFactory } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import { createLegacyFallback } from './legacy-fallback.js';

// createLegacyFallback 的契约是「原样委托 SDK legacyStatelessFallback」：
// mock SDK 以断言透传参数与返回值，避免构造真实 McpServer。
vi.mock('@modelcontextprotocol/server', () => ({
  legacyStatelessFallback: vi.fn(),
}));

const mockedFallback = vi.mocked(legacyStatelessFallback);

describe('createLegacyFallback', () => {
  const factory: McpServerFactory = () => {
    throw new Error('factory 不应在此测试中被调用');
  };

  it('透传 factory 与 onError 给 SDK，并原样返回其 handler', () => {
    const handler = vi.fn(async () => new Response('ok'));
    mockedFallback.mockReturnValue(handler);
    const onError = (e: Error) => void e;

    const result = createLegacyFallback(factory, onError);

    expect(mockedFallback).toHaveBeenCalledTimes(1);
    expect(mockedFallback).toHaveBeenCalledWith(factory, onError);
    expect(result).toBe(handler);
  });

  it('onError 可选：未提供时以 undefined 作为第二参透传', () => {
    const handler = vi.fn(async () => new Response('ok'));
    mockedFallback.mockReturnValue(handler);

    const result = createLegacyFallback(factory);

    expect(mockedFallback).toHaveBeenCalledTimes(1);
    expect(mockedFallback).toHaveBeenCalledWith(factory, undefined);
    expect(result).toBe(handler);
  });
});
