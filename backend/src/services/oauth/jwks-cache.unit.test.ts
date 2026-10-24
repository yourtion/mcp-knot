/**
 * 外部 IdP JWKS 缓存测试
 *
 * 覆盖两条核心路径：
 * 1. TTL 内重复访问命中缓存，底层不重复拉取
 * 2. TTL 过期后访问强制重建，底层重新拉取
 *
 * 实现说明（相对 brief 的偏离）：
 * jose v6 的 createRemoteJWKSet 返回的 resolver 调用签名为
 * `(protectedHeader?: JWSHeaderParameters, token?: FlattenedJWSInput)`，
 * 内部 getKey 通过 `getKtyFromAlg(protectedHeader.alg)` 推断 kty；当 alg
 * 缺失或非 string 时直接抛 JOSENotSupported。因此 resolver 必须以
 * `{ kid, alg }` 形式调用，原始 kid 字符串会失败。本测试据此调整：生成
 * RS256 密钥对，JWK entry 带 alg，并通过 cache.getKey 内部封装的
 * `{ kid, alg: 'RS256' }` 头部调用 resolver。
 */
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJwksCache } from './jwks-cache.js';

// Mock logger（logger 委托给 McpLogger，会污染测试输出）
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

async function makeTestKey() {
  const { publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'RS256';
  const kid = 'test-kid-' + Math.random().toString(36).slice(2);
  jwk.kid = kid;
  return { jwk, kid };
}

function stubFetchReturning(jwk: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: async () => ({ keys: [jwk] }),
  });
}

describe('jwks-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('缓存命中时不重复拉取', async () => {
    const { jwk, kid } = await makeTestKey();
    const jwksUri = 'https://idp.example.com/jwks';
    const fetchMock = stubFetchReturning(jwk);
    vi.stubGlobal('fetch', fetchMock);

    const cache = createJwksCache({ ttlMs: 60_000 });
    const a = await cache.getKey(kid, jwksUri);
    const b = await cache.getKey(kid, jwksUri);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TTL 过期后重新拉取', async () => {
    const { jwk, kid } = await makeTestKey();
    const jwksUri = 'https://idp.example.com/jwks';
    const fetchMock = stubFetchReturning(jwk);
    vi.stubGlobal('fetch', fetchMock);

    const cache = createJwksCache({ ttlMs: 0 }); // 立即过期
    await cache.getKey(kid, jwksUri);
    await cache.getKey(kid, jwksUri);

    // TTL=0：每次访问 entry 都已过期，重建 remote JWKSet，触发重新拉取
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clear() 清空缓存后再次访问触发拉取', async () => {
    const { jwk, kid } = await makeTestKey();
    const jwksUri = 'https://idp.example.com/jwks';
    const fetchMock = stubFetchReturning(jwk);
    vi.stubGlobal('fetch', fetchMock);

    const cache = createJwksCache({ ttlMs: 60_000 });
    await cache.getKey(kid, jwksUri);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    cache.clear();

    await cache.getKey(kid, jwksUri);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('不同 jwksUri 各自独立缓存', async () => {
    const { jwk: jwkA, kid: kidA } = await makeTestKey();
    const { jwk: jwkB, kid: kidB } = await makeTestKey();
    const uriA = 'https://idp-a.example.com/jwks';
    const uriB = 'https://idp-b.example.com/jwks';

    let countA = 0;
    let countB = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === uriA) {
          countA++;
          return { status: 200, json: async () => ({ keys: [jwkA] }) };
        }
        countB++;
        return { status: 200, json: async () => ({ keys: [jwkB] }) };
      }),
    );

    const cache = createJwksCache({ ttlMs: 60_000 });
    await cache.getKey(kidA, uriA);
    await cache.getKey(kidA, uriA);
    await cache.getKey(kidB, uriB);
    await cache.getKey(kidB, uriB);

    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  describe('TTL 语义（fake timers）', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('自定义 ttlMs 到期（含等于阈值的边界）后重建并记录 debug 日志', async () => {
      const { jwk, kid } = await makeTestKey();
      const jwksUri = 'https://idp.example.com/jwks';
      const fetchMock = stubFetchReturning(jwk);
      vi.stubGlobal('fetch', fetchMock);

      const cache = createJwksCache({ ttlMs: 100 });
      await cache.getKey(kid, jwksUri);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // TTL 未到期：命中缓存
      await vi.advanceTimersByTimeAsync(99);
      await cache.getKey(kid, jwksUri);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 正好到达 ttlMs（now - fetchedAt === 100）：判定过期并重建
      loggerMock.debug.mockClear();
      await vi.advanceTimersByTimeAsync(1);
      await cache.getKey(kid, jwksUri);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(loggerMock.debug).toHaveBeenCalledWith('JWKS 缓存未命中或已过期，重建 remote JWKSet', {
        jwksUri,
      });
    });

    it('未传 ttlMs 时使用默认 1 小时（短时间不重建，满 1h 重建）', async () => {
      const { jwk, kid } = await makeTestKey();
      const jwksUri = 'https://idp.example.com/jwks';
      const fetchMock = stubFetchReturning(jwk);
      vi.stubGlobal('fetch', fetchMock);

      const cache = createJwksCache();
      await cache.getKey(kid, jwksUri);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 2s：远小于 1h，应命中缓存（防止 TTL 被错误地配置为秒级以下）
      await vi.advanceTimersByTimeAsync(2_000);
      await cache.getKey(kid, jwksUri);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 满 1h：过期重建
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await cache.getKey(kid, jwksUri);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
