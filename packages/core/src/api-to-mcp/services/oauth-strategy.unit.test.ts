/**
 * OAuthStrategy 单元测试
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../errors/index.js';
import { OAuthStrategy } from './oauth-strategy.js';

import type { HttpRequestConfig, HttpResponse } from '../types/http-client.js';
import type { CacheManager } from './cache-manager.js';
import type { HttpClient } from './http-client.js';
import type { CachedToken } from './oauth-strategy.js';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => loggerMocks,
}));

function mockResponse(data: unknown, status = 200): HttpResponse {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    headers: new Headers(),
    data,
    raw: new Response(),
    config: { url: '', method: 'POST' },
  };
}

function createMockHttpClient(tokenResponse: unknown, status = 200): HttpClient {
  return {
    request: vi.fn().mockResolvedValue(mockResponse(tokenResponse, status)),
  } as unknown as HttpClient;
}

/** 按调用次序依次返回不同响应的 mock httpClient */
function createSequentialMockHttpClient(responses: Array<{ data: unknown; status?: number }>): {
  client: HttpClient;
  request: ReturnType<typeof vi.fn>;
} {
  const queue = responses.map((r) => mockResponse(r.data, r.status ?? 200));
  const request = vi.fn(async () => queue.shift() ?? mockResponse(null, 500));
  return { client: { request } as unknown as HttpClient, request };
}

function createMockCache(): CacheManager & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    getStats: vi.fn(() => ({ hits: 0, misses: 0, keys: 0, maxKeys: 0 })),
    setStrategy: vi.fn(),
    clear: vi.fn(async () => {
      store.clear();
    }),
  } as unknown as CacheManager & { store: Map<string, unknown> };
}

const DEFAULT_REQUEST: HttpRequestConfig = {
  url: 'https://api.example.com/x',
  method: 'GET',
  headers: {},
};

function oauthConfig(overrides: Record<string, unknown> = {}) {
  return {
    type: 'oauth' as const,
    grantType: 'client_credentials' as const,
    clientId: 'cid',
    clientSecret: 'secret',
    tokenUrl: 'https://as.example.com/token',
    ...overrides,
  };
}

describe('OAuthStrategy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('applyAuth — 配置类型守卫', () => {
    it('非 oauth 配置 → 抛 OAUTH_OUTBOUND_CONFIG_INVALID 且不请求 token endpoint', async () => {
      const httpClient = createMockHttpClient({ access_token: 'tok' });
      const strategy = new OAuthStrategy(httpClient, createMockCache());

      const config = {
        type: 'bearer' as const,
        token: 't',
      };

      await expect(strategy.applyAuth(DEFAULT_REQUEST, config)).rejects.toMatchObject({
        code: ErrorCode.OAUTH_OUTBOUND_CONFIG_INVALID,
      });
      expect(httpClient.request).not.toHaveBeenCalled();
    });
  });

  describe('applyAuth — client_credentials 首次取 token', () => {
    it('缓存未命中 → fetchToken → 注入 Authorization: Bearer', async () => {
      const httpClient = createMockHttpClient({
        access_token: 'tok-123',
        expires_in: 3600,
        token_type: 'Bearer',
      });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      const result = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig({ scope: 'read' }));

      expect(result.headers!.Authorization).toBe('Bearer tok-123');
      expect(httpClient.request).toHaveBeenCalledOnce();
    });

    it('缓存命中 → 不再调 token endpoint，输出缓存命中日志', async () => {
      const httpClient = createMockHttpClient({ access_token: 'tok-fresh', expires_in: 3600 });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);
      const config = oauthConfig({ scope: 'read' });

      // 第一次：miss → fetch
      await strategy.applyAuth(DEFAULT_REQUEST, config);
      // 第二次：应命中缓存
      await strategy.applyAuth(DEFAULT_REQUEST, config);

      expect(httpClient.request).toHaveBeenCalledOnce();
      expect(loggerMocks.debug).toHaveBeenCalledWith('OAuth token 缓存命中', {
        context: { clientId: 'cid' },
      });
    });

    it('自定义 headerName/tokenPrefix → 注入到指定 header', async () => {
      const httpClient = createMockHttpClient({ access_token: 'tok-x', expires_in: 3600 });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      const config = oauthConfig({ headerName: 'X-Token', tokenPrefix: '' });

      const result = await strategy.applyAuth(DEFAULT_REQUEST, config);

      expect(result.headers!['X-Token']).toBe('tok-x');
    });

    it('保留请求原有 headers，且不修改入参对象', async () => {
      const httpClient = createMockHttpClient({ access_token: 'tok-x', expires_in: 3600 });
      const strategy = new OAuthStrategy(httpClient, createMockCache());

      const request: HttpRequestConfig = {
        url: 'https://api.example.com/x',
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Basic old' },
      };

      const result = await strategy.applyAuth(request, oauthConfig());

      // 原有无关 header 保留，Authorization 被覆盖
      expect(result.headers!.Accept).toBe('application/json');
      expect(result.headers!.Authorization).toBe('Bearer tok-x');
      // 入参 request 不被原地修改
      expect(request.headers.Authorization).toBe('Basic old');
    });

    it('并发请求同 cacheKey → 只打一次 token endpoint（in-flight 去重）', async () => {
      // 慢响应：让第一个 request 在第二个 applyAuth 进入时还未完成
      let callCount = 0;
      const httpClient = {
        request: vi.fn(async () => {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            data: { access_token: 'tok-concurrent', expires_in: 3600 },
            raw: new Response(),
            config: { url: '', method: 'POST' },
          } as unknown as import('../types/http-client.js').HttpResponse;
        }),
      } as unknown as HttpClient;
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      const config = oauthConfig({ scope: 'read' });

      // 并发发起两个 applyAuth，缓存都 miss
      const [r1, r2] = await Promise.all([
        strategy.applyAuth(DEFAULT_REQUEST, config),
        strategy.applyAuth(DEFAULT_REQUEST, config),
      ]);

      expect(r1.headers!.Authorization).toBe('Bearer tok-concurrent');
      expect(r2.headers!.Authorization).toBe('Bearer tok-concurrent');
      expect(callCount).toBe(1);
      expect(loggerMocks.debug).toHaveBeenCalledWith('OAuth token in-flight 去重命中', {
        context: { clientId: 'cid' },
      });
    });
  });

  describe('fetchToken — 请求构造与缓存写入', () => {
    it('按规范构造 token 请求（表单体含 scope），并以派生 key 写入缓存', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const httpClient = createMockHttpClient({
        access_token: 'tok-123',
        expires_in: 3600,
        refresh_token: 'rt-1',
      });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig({ scope: 'read' }));

      // token endpoint 请求形态
      const call = vi.mocked(httpClient.request).mock.calls[0][0];
      expect(call.url).toBe('https://as.example.com/token');
      expect(call.method).toBe('POST');
      expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(String(call.data)).toBe(
        'grant_type=client_credentials&client_id=cid&client_secret=secret&scope=read',
      );

      // 缓存写入：key 由 clientId|tokenUrl|scope|grantType 派生
      const expectedKey = `oauth:token:${createHash('sha256')
        .update('cid|https://as.example.com/token|read|client_credentials')
        .digest('hex')
        .slice(0, 32)}`;
      expect(cache.set).toHaveBeenCalledTimes(1);
      const [setKey, setValue, setTtl] = vi.mocked(cache.set).mock.calls[0];
      expect(setKey).toBe(expectedKey);
      expect(setValue).toMatchObject({
        accessToken: 'tok-123',
        expiresAt: Date.now() + 3_600_000,
        refreshToken: 'rt-1',
      });
      expect(setTtl).toBe(3540); // expires_in - 60
    });

    it('无 scope → 请求体不携带 scope 参数', async () => {
      const httpClient = createMockHttpClient({ access_token: 'tok-noscope', expires_in: 3600 });
      const strategy = new OAuthStrategy(httpClient, createMockCache());

      await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());

      const call = vi.mocked(httpClient.request).mock.calls[0][0];
      expect(String(call.data)).toBe(
        'grant_type=client_credentials&client_id=cid&client_secret=secret',
      );
    });

    it('响应缺 expires_in → 按 3600s 默认值计算过期与 TTL', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const httpClient = createMockHttpClient({ access_token: 'tok-noexp' });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());

      const [setValue, setTtl] = vi.mocked(cache.set).mock.calls[0].slice(1);
      expect(setValue).toMatchObject({ expiresAt: Date.now() + 3_600_000 });
      expect(setTtl).toBe(3540);
    });

    it('expires_in 很短（100s）→ TTL 收敛到下限 60s', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const httpClient = createMockHttpClient({ access_token: 'tok-short', expires_in: 100 });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());

      const [setValue, setTtl] = vi.mocked(cache.set).mock.calls[0].slice(1);
      expect(setValue).toMatchObject({ expiresAt: Date.now() + 100_000 });
      expect(setTtl).toBe(60);
    });
  });

  describe('缓存 key 语义', () => {
    it('不同 clientId / scope / grantType 的配置互不共享 token 缓存', async () => {
      const { client: httpClient, request } = createSequentialMockHttpClient([
        { data: { access_token: 'tok-a', expires_in: 3600 } },
        { data: { access_token: 'tok-b', expires_in: 3600 } },
        { data: { access_token: 'tok-c', expires_in: 3600 } },
      ]);
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      const results = await Promise.all([
        strategy.applyAuth(DEFAULT_REQUEST, oauthConfig()),
        strategy.applyAuth(DEFAULT_REQUEST, oauthConfig({ clientId: 'cid-2' })),
        strategy.applyAuth(DEFAULT_REQUEST, oauthConfig({ scope: 'write' })),
      ]);

      // 三次都 miss → 三次 token 请求，各得各的 token
      expect(request).toHaveBeenCalledTimes(3);
      expect(results[0].headers!.Authorization).toBe('Bearer tok-a');
      expect(results[1].headers!.Authorization).toBe('Bearer tok-b');
      expect(results[2].headers!.Authorization).toBe('Bearer tok-c');

      // 写入的 key 互不相同
      const keys = vi.mocked(cache.set).mock.calls.map((c) => c[0]);
      expect(new Set(keys).size).toBe(3);
    });
  });

  describe('缓存过期边界', () => {
    it('剩余有效期恰为 60s 缓冲 → 视为将过期，重新取 token', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const httpClient = createMockHttpClient({ access_token: 'tok-new', expires_in: 3600 });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);
      vi.spyOn(cache, 'get').mockResolvedValue({
        accessToken: 'tok-old',
        expiresAt: Date.now() + 60_000,
      } as unknown as CachedToken);

      const result = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());

      expect(result.headers!.Authorization).toBe('Bearer tok-new');
      expect(httpClient.request).toHaveBeenCalledOnce();
    });

    it('剩余 60_001ms → 命中缓存，直接复用旧 token', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const httpClient = createMockHttpClient({ access_token: 'tok-new', expires_in: 3600 });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);
      vi.spyOn(cache, 'get').mockResolvedValue({
        accessToken: 'tok-old',
        expiresAt: Date.now() + 60_001,
      } as unknown as CachedToken);

      const result = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());

      expect(result.headers!.Authorization).toBe('Bearer tok-old');
      expect(httpClient.request).not.toHaveBeenCalled();
    });
  });

  describe('in-flight 生命周期', () => {
    it('取 token 完成后从 in-flight 移除：后续缓存过期能再次取新 token', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const { client: httpClient, request } = createSequentialMockHttpClient([
        { data: { access_token: 'tok-first', expires_in: 3600 } },
        { data: { access_token: 'tok-second', expires_in: 3600 } },
      ]);
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);
      const getSpy = vi.spyOn(cache, 'get');
      // 第一次 miss；第二次返回已过期 token（早已过缓冲窗口）
      getSpy.mockResolvedValueOnce(null).mockResolvedValueOnce({
        accessToken: 'tok-first',
        expiresAt: Date.now() - 1_000,
      } as unknown as CachedToken);

      const r1 = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());
      const r2 = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());

      expect(r1.headers!.Authorization).toBe('Bearer tok-first');
      expect(r2.headers!.Authorization).toBe('Bearer tok-second');
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  describe('applyAuth — 失败处理', () => {
    it('token endpoint 返回 401 → 抛 OAUTH_OUTBOUND_TOKEN_FETCH_FAILED 且 message 携带状态码', async () => {
      const httpClient = createMockHttpClient({ error: 'invalid_client' }, 401);
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      const err = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig()).catch((e: unknown) => e);

      expect(err).toMatchObject({
        code: ErrorCode.OAUTH_OUTBOUND_TOKEN_FETCH_FAILED,
        message: expect.stringContaining('401'),
        context: expect.objectContaining({
          clientId: 'cid',
          tokenUrl: 'https://as.example.com/token',
          statusCode: 401,
        }),
      });
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('401 但响应体带 access_token → 依然视为失败，不吞错误', async () => {
      const httpClient = createMockHttpClient({ access_token: 'should-not-be-used' }, 401);
      const strategy = new OAuthStrategy(httpClient, createMockCache());

      await expect(strategy.applyAuth(DEFAULT_REQUEST, oauthConfig())).rejects.toThrow(/401/);
    });

    it('状态码 300 恰在成功边界之外 → 同样视为失败', async () => {
      const httpClient = createMockHttpClient({ access_token: 'tok-300' }, 300);
      const strategy = new OAuthStrategy(httpClient, createMockCache());

      await expect(strategy.applyAuth(DEFAULT_REQUEST, oauthConfig())).rejects.toThrow(/300/);
    });

    it('2xx 但响应缺 access_token → 抛错且不写缓存', async () => {
      const httpClient = createMockHttpClient({ expires_in: 3600 });
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      const err = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig()).catch((e: unknown) => e);

      expect(err).toMatchObject({
        code: ErrorCode.OAUTH_OUTBOUND_TOKEN_FETCH_FAILED,
        message: expect.stringContaining('access_token'),
      });
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('错误 context 不含 clientSecret', async () => {
      const httpClient = createMockHttpClient({ error: 'bad' }, 500);
      const cache = createMockCache();
      const strategy = new OAuthStrategy(httpClient, cache);

      try {
        await strategy.applyAuth(
          DEFAULT_REQUEST,
          oauthConfig({ clientSecret: 'super-secret-value' }),
        );
        expect.fail('应抛错');
      } catch (err) {
        const str = JSON.stringify(err);
        expect(str).not.toContain('super-secret-value');
      }
    });
  });

  describe('applyAuth — refresh_token 续期', () => {
    function createRefreshMockHttpClient(overrides?: {
      refreshResponse?: { data: unknown; status?: number };
      clientCredentialsToken?: string;
    }): { client: HttpClient; request: ReturnType<typeof vi.fn> } {
      const refreshResponse = overrides?.refreshResponse ?? {
        data: { access_token: 'refreshed-tok', expires_in: 3600 },
      };
      const fallbackToken = overrides?.clientCredentialsToken ?? 'fresh-tok';
      const request = vi.fn(async (req: HttpRequestConfig) => {
        const body = req.data as string;
        if (body.includes('grant_type=refresh_token')) {
          return mockResponse(refreshResponse.data, refreshResponse.status ?? 200);
        }
        return mockResponse({ access_token: fallbackToken, expires_in: 3600 });
      });
      return { client: { request } as unknown as HttpClient, request };
    }

    function seedExpiringCache(cache: CacheManager, refreshToken = 'rt-xxx') {
      vi.spyOn(cache, 'get').mockResolvedValue({
        accessToken: 'old-tok',
        expiresAt: Date.now() + 30_000, // 30s 后过期，< 60s buffer → 触发 refresh
        refreshToken,
      } as unknown as CachedToken);
    }

    it('缓存将过期 + 有 refreshToken → refresh 成功且请求体符合规范', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const cache = createMockCache();
      const { client: httpClient, request } = createRefreshMockHttpClient();

      const strategy = new OAuthStrategy(httpClient, cache);
      seedExpiringCache(cache);

      const result = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());
      expect(result.headers!.Authorization).toBe('Bearer refreshed-tok');
      expect(request).toHaveBeenCalledOnce();

      const refreshCall = request.mock.calls[0][0];
      expect(String(refreshCall.data)).toBe(
        'grant_type=refresh_token&refresh_token=rt-xxx&client_id=cid&client_secret=secret',
      );

      // 刷新结果写缓存，且响应未带新 refresh_token 时保留旧值
      const [setValue, setTtl] = vi.mocked(cache.set).mock.calls[0].slice(1);
      expect(setValue).toMatchObject({
        accessToken: 'refreshed-tok',
        expiresAt: Date.now() + 3_600_000,
        refreshToken: 'rt-xxx',
      });
      expect(setTtl).toBe(3540);
    });

    it('refresh 响应带新 refresh_token → 缓存新值', async () => {
      const cache = createMockCache();
      const { client: httpClient } = createRefreshMockHttpClient({
        refreshResponse: { data: { access_token: 'refreshed-tok', refresh_token: 'rt-new' } },
      });

      const strategy = new OAuthStrategy(httpClient, cache);
      seedExpiringCache(cache, 'rt-old');

      await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());

      const setValue = vi.mocked(cache.set).mock.calls[0][1] as CachedToken;
      expect(setValue.refreshToken).toBe('rt-new');
    });

    it('refresh 失败（invalid_grant）→ 记录 warn 日志并静默回退 client_credentials', async () => {
      const cache = createMockCache();
      const { client: httpClient, request } = createRefreshMockHttpClient({
        refreshResponse: { data: { error: 'invalid_grant' }, status: 400 },
        clientCredentialsToken: 'fallback-tok',
      });

      const strategy = new OAuthStrategy(httpClient, cache);
      seedExpiringCache(cache);

      const result = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());
      expect(result.headers!.Authorization).toBe('Bearer fallback-tok');
      expect(request).toHaveBeenCalledTimes(2); // refresh 1 次 + client_credentials 1 次

      // 回退时记录 warn，且日志不含凭证原文
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        'OAuth refresh 失败，回退到 client_credentials',
        expect.anything(),
      );
      const warnLog = JSON.stringify(vi.mocked(loggerMocks.warn).mock.calls);
      expect(warnLog).not.toContain('secret');
      expect(warnLog).not.toContain('rt-xxx');
    });

    it('refresh 返回 300（含有效 token）→ 视为失败，回退 client_credentials', async () => {
      const cache = createMockCache();
      const { client: httpClient, request } = createRefreshMockHttpClient({
        refreshResponse: { data: { access_token: 'tok-300' }, status: 300 },
        clientCredentialsToken: 'fallback-tok',
      });

      const strategy = new OAuthStrategy(httpClient, cache);
      seedExpiringCache(cache);

      const result = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());
      expect(result.headers!.Authorization).toBe('Bearer fallback-tok');
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('refresh 返回 2xx 但缺 access_token → 回退 client_credentials', async () => {
      const cache = createMockCache();
      const { client: httpClient, request } = createRefreshMockHttpClient({
        refreshResponse: { data: { expires_in: 3600 } }, // 缺 access_token
        clientCredentialsToken: 'fallback-tok',
      });

      const strategy = new OAuthStrategy(httpClient, cache);
      seedExpiringCache(cache);

      const result = await strategy.applyAuth(DEFAULT_REQUEST, oauthConfig());
      expect(result.headers!.Authorization).toBe('Bearer fallback-tok');
      expect(request).toHaveBeenCalledTimes(2); // refresh 1 次（抛错）+ client_credentials 1 次
    });
  });

  describe('validateConfig', () => {
    const strategy = new OAuthStrategy({} as HttpClient, {} as CacheManager);

    it('非 oauth 配置 → 无效', async () => {
      const result = await strategy.validateConfig({
        type: 'bearer',
        token: 't',
      });
      expect(result).toEqual({ valid: false, error: '认证类型不匹配' });
    });

    it('缺 clientId → 无效', async () => {
      const result = await strategy.validateConfig({
        type: 'oauth',
        grantType: 'client_credentials',
        // @ts-expect-error 测试缺字段
        clientId: undefined,
        clientSecret: 's',
        tokenUrl: 'https://x.com/token',
      });
      expect(result).toEqual({ valid: false, error: 'OAuth 需要 clientId' });
    });

    it('缺 clientSecret → 无效', async () => {
      const result = await strategy.validateConfig({
        type: 'oauth',
        grantType: 'client_credentials',
        clientId: 'cid',
        // @ts-expect-error 测试缺字段
        clientSecret: undefined,
        tokenUrl: 'https://x.com/token',
      });
      expect(result).toEqual({ valid: false, error: 'OAuth 需要 clientSecret' });
    });

    it('缺 tokenUrl → 无效', async () => {
      const result = await strategy.validateConfig({
        type: 'oauth',
        grantType: 'client_credentials',
        clientId: 'cid',
        clientSecret: 's',
        // @ts-expect-error 测试缺字段
        tokenUrl: undefined,
      });
      expect(result).toEqual({ valid: false, error: 'OAuth 需要 tokenUrl' });
    });

    it('refresh_token grant 缺 refreshToken → 无效', async () => {
      const result = await strategy.validateConfig({
        type: 'oauth',
        grantType: 'refresh_token',
        clientId: 'cid',
        clientSecret: 's',
        tokenUrl: 'https://x.com/token',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('refreshToken');
    });

    it('refresh_token grant 带 refreshToken → 有效', async () => {
      const result = await strategy.validateConfig({
        type: 'oauth',
        grantType: 'refresh_token',
        clientId: 'cid',
        clientSecret: 's',
        tokenUrl: 'https://x.com/token',
        refreshToken: 'rt',
      });
      expect(result).toEqual({ valid: true });
    });

    it('完整 client_credentials 配置 → 有效', async () => {
      const result = await strategy.validateConfig({
        type: 'oauth',
        grantType: 'client_credentials',
        clientId: 'cid',
        clientSecret: 's',
        tokenUrl: 'https://x.com/token',
      });
      expect(result).toEqual({ valid: true });
    });
  });
});
