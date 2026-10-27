import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';

// 当前 jsdom 测试环境没有 localStorage
const createLocalStorage = () => {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
  };
};

vi.mock('axios', () => {
  const apiInstance = Object.assign(vi.fn(), {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  });
  return {
    default: {
      create: vi.fn(() => apiInstance),
      post: vi.fn(),
    },
  };
});

type ApiModule = typeof import('../api');

const loadApi = async () => {
  const axios = (await import('axios')).default as unknown as {
    create: Mock;
    post: Mock;
  } as { create: Mock; post: Mock };
  const apiModule: ApiModule = await import('../api');
  const apiInstance = axios.create.mock.results[0].value as {
    __call__: Mock;
    interceptors: {
      request: { use: Mock };
      response: { use: Mock };
    };
  } & Mock;
  const requestInterceptor = apiInstance.interceptors.request.use.mock.calls[0][0] as (
    config: Record<string, unknown>,
  ) => Record<string, { Authorization?: string }>;
  const responseInterceptor = apiInstance.interceptors.response.use.mock.calls[0][1] as (error: {
    config?: Record<string, unknown>;
    response?: { status: number };
  }) => Promise<unknown>;
  return { axios, apiModule, apiInstance, requestInterceptor, responseInterceptor };
};

const make401Error = (overrides: Record<string, unknown> = {}) => ({
  response: { status: 401 },
  config: { headers: {} as Record<string, string | undefined>, ...overrides },
});

describe('api 服务', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createLocalStorage());
    // 屏蔽 jsdom 的导航报错
    const { window } = globalThis as unknown as { window: { location: { href: string } } };
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/' },
      writable: true,
    });
  });

  it('以约定的基础配置创建 axios 实例', async () => {
    const { axios } = await loadApi();

    expect(axios.create).toHaveBeenCalledWith({
      baseURL: '/api',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  });

  it('注册请求与响应拦截器', async () => {
    const { apiInstance } = await loadApi();

    expect(apiInstance.interceptors.request.use).toHaveBeenCalledTimes(1);
    expect(apiInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
  });

  describe('请求拦截器', () => {
    it('存在 token 时附加 Authorization 头', async () => {
      const { requestInterceptor } = await loadApi();
      localStorage.setItem('auth_token', 'abc');

      const config = requestInterceptor({ headers: {} });

      expect(config.headers.Authorization).toBe('Bearer abc');
    });

    it('无 token 时不附加 Authorization 头', async () => {
      const { requestInterceptor } = await loadApi();

      const config = requestInterceptor({ headers: {} });

      expect(config.headers.Authorization).toBeUndefined();
    });

    it('请求拦截器的错误分支原样拒绝', async () => {
      const rejectHandler = await loadApiForReject();
      const error = new Error('请求构造失败');

      await expect(rejectHandler(error)).rejects.toBe(error);
    });
  });

  async function loadApiForReject() {
    const axios = (await import('axios')).default as unknown as {
      create: Mock;
    } as { create: Mock };
    await import('../api');
    const apiInstance = axios.create.mock.results[0].value as {
      interceptors: { request: { use: Mock } };
    };
    return apiInstance.interceptors.request.use.mock.calls[0][1] as (
      e: unknown,
    ) => Promise<unknown>;
  }

  describe('响应拦截器', () => {
    it('非 401 错误直接拒绝', async () => {
      const { responseInterceptor } = await loadApi();
      const error = {
        response: { status: 500 },
        config: { headers: {} } as Record<string, unknown>,
      };

      await expect(responseInterceptor(error)).rejects.toBe(error);
      expect(error.config._retry).toBeUndefined();
    });

    it('已重试过的 401 不再刷新令牌', async () => {
      const { responseInterceptor, axios } = await loadApi();
      const error = make401Error({ _retry: true });
      localStorage.setItem('refresh_token', 'r');

      await expect(responseInterceptor(error)).rejects.toBe(error);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('401 且无刷新令牌时清除 token 并跳转登录页', async () => {
      const { responseInterceptor } = await loadApi();
      localStorage.setItem('auth_token', 'expired');
      const error = make401Error();

      await expect(responseInterceptor(error)).rejects.toBe(error);
      expect(localStorage.getItem('auth_token')).toBeNull();
      expect(window.location.href).toBe('/login');
    });

    it('401 时用刷新令牌换新 token 并重试原请求', async () => {
      const { responseInterceptor, axios, apiModule, apiInstance } = await loadApi();
      localStorage.setItem('refresh_token', 'r1');
      axios.post.mockResolvedValue({ data: { data: { accessToken: 'new-token' } } });
      const retried = { data: { success: true } };
      (apiInstance as unknown as Mock).mockResolvedValue(retried);

      const error = make401Error();
      const promise = responseInterceptor(error);

      await expect(promise).resolves.toBe(retried);
      expect(axios.post).toHaveBeenCalledWith('/api/auth/refresh', { refreshToken: 'r1' });
      expect(localStorage.getItem('auth_token')).toBe('new-token');
      expect(error.config.headers.Authorization).toBe('Bearer new-token');
      expect(apiModule.default).toHaveBeenCalledWith(error.config);
    });

    it('刷新响应无 data 包装时也能取到 token', async () => {
      const { responseInterceptor, axios, apiInstance } = await loadApi();
      localStorage.setItem('refresh_token', 'r1');
      axios.post.mockResolvedValue({ data: { accessToken: 'flat-token' } });
      (apiInstance as unknown as Mock).mockResolvedValue({ data: {} });

      await responseInterceptor(make401Error());

      expect(localStorage.getItem('auth_token')).toBe('flat-token');
    });

    it('刷新失败时清除全部令牌并跳转登录页', async () => {
      const { responseInterceptor, axios } = await loadApi();
      localStorage.setItem('auth_token', 'expired');
      localStorage.setItem('refresh_token', 'expired-refresh');
      axios.post.mockRejectedValue(new Error('刷新失败'));
      const error = make401Error();

      await expect(responseInterceptor(error)).rejects.toBe(error);
      expect(localStorage.getItem('auth_token')).toBeNull();
      expect(localStorage.getItem('refresh_token')).toBeNull();
      expect(window.location.href).toBe('/login');
    });

    it('rejects every queued request when a shared refresh fails', async () => {
      const { responseInterceptor, axios } = await loadApi();
      localStorage.setItem('refresh_token', 'expired');
      let fail!: (error: Error) => void;
      axios.post.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
      const first = responseInterceptor(make401Error());
      const second = responseInterceptor(make401Error());
      const settled = Promise.allSettled([first, second]);
      fail(new Error('refresh failed'));
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe('/login');
    });

    it('并发 401 时排队等待刷新完成后统一重试', async () => {
      const { responseInterceptor, axios, apiInstance } = await loadApi();
      localStorage.setItem('refresh_token', 'r1');

      let resolveRefresh: (value: { data: { data: { accessToken: string } } }) => void;
      axios.post.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      (apiInstance as unknown as Mock).mockResolvedValue({ data: { success: true } });

      const first = responseInterceptor(make401Error());
      const second = responseInterceptor(make401Error());

      // 只应触发一次刷新请求
      expect(axios.post).toHaveBeenCalledTimes(1);

      resolveRefresh!({ data: { data: { accessToken: 'shared-token' } } });
      await expect(first).resolves.toEqual({ data: { success: true } });
      await expect(second).resolves.toEqual({ data: { success: true } });

      const calls = (apiInstance as unknown as Mock).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].headers.Authorization).toBe('Bearer shared-token');
      expect(calls[1][0].headers.Authorization).toBe('Bearer shared-token');
    });
  });

  describe('handleApiResponse', () => {
    it('成功且有数据时返回数据部分', async () => {
      const { apiModule } = await loadApi();

      const data = apiModule.handleApiResponse({
        data: { success: true, data: { id: 1 }, timestamp: '' },
      } as never);

      expect(data).toEqual({ id: 1 });
    });

    it('数据缺失时抛出服务端错误消息', async () => {
      const { apiModule } = await loadApi();

      expect(() =>
        apiModule.handleApiResponse({
          data: { success: true, data: undefined, error: { message: '服务端错误' } },
        } as never),
      ).toThrow('服务端错误');
    });

    it('无错误消息时使用默认提示', async () => {
      const { apiModule } = await loadApi();

      expect(() =>
        apiModule.handleApiResponse({
          data: { success: false },
        } as never),
      ).toThrow('请求失败');
    });

    it('success 为 false 时同样进入错误分支', async () => {
      const { apiModule } = await loadApi();

      expect(() =>
        apiModule.handleApiResponse({
          data: { success: false, data: { id: 1 } },
        } as never),
      ).toThrow('请求失败');
    });
  });
});
