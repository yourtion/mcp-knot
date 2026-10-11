import { describe, expect, it } from 'vitest';

import { HubMrtrCodec } from './relay.js';

// SDK createRequestStateCodec 要求 key >= 32 bytes；此串 35 bytes 满足约束。
const KEY = 'test-key-32-bytes-long-enough!!!!';

describe('HubMrtrCodec', () => {
  it('mint 出的 requestState 能被 verify 还原', async () => {
    const codec = new HubMrtrCodec({ key: KEY, ttlSeconds: 300 });
    const state = {
      serverId: 's1',
      toolName: 'foo',
      upstreamRequestState: 'up-rs',
      step: 1,
    };
    const token = await codec.mint(state);
    expect(typeof token).toBe('string');
    const restored = await codec.verify(token);
    expect(restored).toEqual(state);
  });

  it('mint 返回 Promise<string>（异步契约）', async () => {
    const codec = new HubMrtrCodec({ key: KEY, ttlSeconds: 300 });
    const result = codec.mint({
      serverId: 's1',
      toolName: 'foo',
      upstreamRequestState: '',
      step: 0,
    });
    expect(result).toBeInstanceOf(Promise);
    expect(typeof (await result)).toBe('string');
  });

  it('篡改的 token verify 抛错（fail-closed）', async () => {
    const codec = new HubMrtrCodec({ key: KEY, ttlSeconds: 300 });
    const token = await codec.mint({
      serverId: 's1',
      toolName: 'foo',
      upstreamRequestState: '',
      step: 0,
    });
    await expect(codec.verify(`${token}tampered`)).rejects.toThrow();
  });

  it('verify(undefined) / verify(空串) 解析为 undefined（初次调用语义）', async () => {
    const codec = new HubMrtrCodec({ key: KEY, ttlSeconds: 300 });
    expect(await codec.verify(undefined)).toBeUndefined();
    expect(await codec.verify('')).toBeUndefined();
  });

  it('不同 key mint 的 token 在本实例 verify 失败', async () => {
    const c1 = new HubMrtrCodec({ key: KEY, ttlSeconds: 300 });
    const c2 = new HubMrtrCodec({ key: 'another-key-32-bytes-long-enough!!', ttlSeconds: 300 });
    const token = await c1.mint({
      serverId: 's1',
      toolName: 'foo',
      upstreamRequestState: '',
      step: 0,
    });
    await expect(c2.verify(token)).rejects.toThrow();
  });
});
