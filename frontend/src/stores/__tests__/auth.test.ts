import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../auth';
import * as authService from '@/services/auth';

// Mock auth service
vi.mock('@/services/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  validateToken: vi.fn(),
  refreshToken: vi.fn(),
}));

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

describe('Auth Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // 每个测试前重新 stub localStorage，因为 restoreMocks 会在 afterEach 中恢复
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock.getItem.mockReset().mockReturnValue(null);
  });

  it('应该正确初始化状态', () => {
    const authStore = useAuthStore();

    expect(authStore.user).toBeNull();
    expect(authStore.token).toBeNull();
    expect(authStore.refreshToken).toBeNull();
    expect(authStore.loading).toBe(false);
    expect(authStore.error).toBeNull();
    expect(authStore.isAuthenticated).toBe(false);
  });

  it('应该从localStorage初始化认证状态', () => {
    const mockUser = { id: '1', username: 'test', role: 'admin' };
    localStorageMock.getItem.mockImplementation((key: string) => {
      switch (key) {
        case 'auth_token':
          return 'mock-token';
        case 'refresh_token':
          return 'mock-refresh-token';
        case 'user_info':
          return JSON.stringify(mockUser);
        default:
          return null;
      }
    });

    const authStore = useAuthStore();
    authStore.initializeAuth();

    expect(authStore.token).toBe('mock-token');
    expect(authStore.refreshToken).toBe('mock-refresh-token');
    expect(authStore.user).toEqual(mockUser);
    expect(authStore.isAuthenticated).toBe(true);
  });

  it.each(['token', 'user'] as const)('只有 %s 时不应视为已登录', (field) => {
    const authStore = useAuthStore();
    if (field === 'token') authStore.token = 'token-without-user';
    else authStore.user = { id: '1', username: 'test', role: 'admin' };

    expect(authStore.isAuthenticated).toBe(false);
  });

  it('持久化用户数据损坏时清除整个会话', () => {
    localStorageMock.getItem.mockImplementation((key: string) => {
      if (key === 'auth_token') return 'token';
      if (key === 'refresh_token') return 'refresh';
      if (key === 'user_info') return '{ invalid json';
      return null;
    });
    const authStore = useAuthStore();

    authStore.initializeAuth();

    expect(authStore.token).toBeNull();
    expect(authStore.refreshToken).toBeNull();
    expect(authStore.user).toBeNull();
    expect(authStore.isAuthenticated).toBe(false);
    for (const key of ['auth_token', 'refresh_token', 'user_info']) {
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(key);
    }
  });

  it('登录失败时保留错误并结束加载状态', async () => {
    vi.mocked(authService.login).mockRejectedValue(new Error('登录凭据无效'));
    const authStore = useAuthStore();

    await expect(authStore.login({ username: 'test', password: 'wrong' })).rejects.toThrow(
      '登录凭据无效',
    );

    expect(authStore.error).toBe('登录凭据无效');
    expect(authStore.loading).toBe(false);
    expect(authStore.token).toBeNull();
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('应该正确处理登录', async () => {
    const mockResponse = {
      accessToken: 'new-token',
      refreshToken: 'new-refresh-token',
      user: { id: '1', username: 'test', role: 'admin' },
    };

    vi.mocked(authService.login).mockResolvedValue(mockResponse);

    const authStore = useAuthStore();
    await authStore.login({ username: 'test', password: 'password' });

    expect(authService.login).toHaveBeenCalledWith({
      username: 'test',
      password: 'password',
    });
    expect(authStore.token).toBe('new-token');
    expect(authStore.refreshToken).toBe('new-refresh-token');
    expect(authStore.user).toEqual(mockResponse.user);
    expect(authStore.isAuthenticated).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('auth_token', 'new-token');
    expect(localStorageMock.setItem).toHaveBeenCalledWith('refresh_token', 'new-refresh-token');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'user_info',
      JSON.stringify(mockResponse.user),
    );
  });

  it('应该正确处理登出', async () => {
    const authStore = useAuthStore();

    // 先设置一些认证状态
    authStore.token = 'test-token';
    authStore.user = { id: '1', username: 'test', role: 'admin' };

    await authStore.logout();

    expect(authService.logout).toHaveBeenCalled();
    expect(authStore.token).toBeNull();
    expect(authStore.user).toBeNull();
    expect(authStore.refreshToken).toBeNull();
    expect(authStore.isAuthenticated).toBe(false);
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('auth_token');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('refresh_token');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('user_info');
  });

  it('应该正确验证token', async () => {
    vi.mocked(authService.validateToken).mockResolvedValue(true);

    const authStore = useAuthStore();
    authStore.token = 'test-token';

    const result = await authStore.validateToken();

    expect(result).toBe(true);
    expect(authService.validateToken).toHaveBeenCalled();
  });

  it('当token无效时应该清除认证状态', async () => {
    vi.mocked(authService.validateToken).mockResolvedValue(false);

    const authStore = useAuthStore();
    authStore.token = 'invalid-token';
    authStore.user = { id: '1', username: 'test', role: 'admin' };

    const result = await authStore.validateToken();

    expect(result).toBe(false);
    expect(authStore.token).toBeNull();
    expect(authStore.user).toBeNull();
  });

  it('当token有效时应该保留认证状态', async () => {
    vi.mocked(authService.validateToken).mockResolvedValue(true);

    const authStore = useAuthStore();
    authStore.token = 'valid-token';
    authStore.user = { id: '1', username: 'test', role: 'admin' };

    const result = await authStore.validateToken();

    expect(result).toBe(true);
    expect(authStore.token).toBe('valid-token');
    expect(authStore.user).not.toBeNull();
  });

  it('没有token时直接返回 false 且不调用校验接口', async () => {
    const authStore = useAuthStore();

    const result = await authStore.validateToken();

    expect(result).toBe(false);
    expect(authService.validateToken).not.toHaveBeenCalled();
  });

  it('校验token抛出异常时清除认证状态并返回 false', async () => {
    vi.mocked(authService.validateToken).mockRejectedValue(new Error('网络错误'));

    const authStore = useAuthStore();
    authStore.token = 'expired';
    authStore.refreshToken = 'r';

    const result = await authStore.validateToken();

    expect(result).toBe(false);
    expect(authStore.token).toBeNull();
    expect(authStore.refreshToken).toBeNull();
  });

  it('本地存储不完整时不应恢复任何认证字段', () => {
    const cases: Array<Record<string, string>> = [
      { auth_token: 'token-only' },
      { refresh_token: 'refresh-only' },
      { user_info: JSON.stringify({ id: '1', username: 't', role: 'admin' }) },
      { auth_token: 't', user_info: JSON.stringify({ id: '1', username: 't', role: 'admin' }) },
      { refresh_token: 'r', user_info: JSON.stringify({ id: '1', username: 't', role: 'admin' }) },
    ];

    for (const storage of cases) {
      localStorageMock.getItem
        .mockReset()
        .mockImplementation((key: string) => storage[key] ?? null);

      const authStore = useAuthStore();
      authStore.initializeAuth();

      expect(authStore.token).toBeNull();
      expect(authStore.refreshToken).toBeNull();
      expect(authStore.user).toBeNull();
      expect(authStore.isAuthenticated).toBe(false);
    }
  });

  it('登录失败时非 Error 对象使用默认错误消息', async () => {
    vi.mocked(authService.login).mockRejectedValue('boom');

    const authStore = useAuthStore();
    await expect(authStore.login({ username: 'u', password: 'p' })).rejects.toBe('boom');

    expect(authStore.error).toBe('登录失败');
  });

  it('登录请求期间处于加载状态', async () => {
    let resolveFn: (value: { accessToken: string; refreshToken: string; user: never }) => void;
    vi.mocked(authService.login).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve;
        }) as never,
    );

    const authStore = useAuthStore();
    const pending = authStore.login({ username: 'u', password: 'p' });

    expect(authStore.loading).toBe(true);

    resolveFn({ accessToken: 'a', refreshToken: 'r', user: null as never });
    await pending;
    expect(authStore.loading).toBe(false);
  });

  it('登出请求失败时仍然清除本地认证状态', async () => {
    vi.mocked(authService.logout).mockRejectedValue(new Error('服务器错误'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const authStore = useAuthStore();
    authStore.token = 'test-token';
    authStore.refreshToken = 'refresh-token';
    authStore.user = { id: '1', username: 'test', role: 'admin' };

    await authStore.logout();

    expect(authStore.token).toBeNull();
    expect(authStore.refreshToken).toBeNull();
    expect(authStore.user).toBeNull();
    expect(authStore.isAuthenticated).toBe(false);
    expect(authStore.loading).toBe(false);
  });

  it('登出请求期间处于加载状态', async () => {
    let resolveFn: () => void;
    vi.mocked(authService.logout).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
    );

    const authStore = useAuthStore();
    const pending = authStore.logout();

    expect(authStore.loading).toBe(true);

    resolveFn();
    await pending;
    expect(authStore.loading).toBe(false);
  });

  describe('refreshAuthToken', () => {
    it('没有刷新令牌时返回 false 且不调用刷新接口', async () => {
      const authStore = useAuthStore();

      const result = await authStore.refreshAuthToken();

      expect(result).toBe(false);
      expect(authService.refreshToken).not.toHaveBeenCalled();
    });

    it('刷新成功时更新并持久化访问令牌', async () => {
      vi.mocked(authService.refreshToken).mockResolvedValue({ token: 'new-access' } as never);

      const authStore = useAuthStore();
      authStore.refreshToken = 'old-refresh';

      const result = await authStore.refreshAuthToken();

      expect(result).toBe(true);
      expect(authService.refreshToken).toHaveBeenCalledWith('old-refresh');
      expect(authStore.token).toBe('new-access');
      expect(localStorageMock.setItem).toHaveBeenCalledWith('auth_token', 'new-access');
    });

    it('刷新失败时清除认证状态并返回 false', async () => {
      vi.mocked(authService.refreshToken).mockRejectedValue(new Error('已过期'));

      const authStore = useAuthStore();
      authStore.token = 'old-access';
      authStore.refreshToken = 'old-refresh';
      authStore.user = { id: '1', username: 'test', role: 'admin' };

      const result = await authStore.refreshAuthToken();

      expect(result).toBe(false);
      expect(authStore.token).toBeNull();
      expect(authStore.refreshToken).toBeNull();
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('auth_token');
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('refresh_token');
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('user_info');
    });
  });

  it('setAuth 直接设置并持久化认证状态', () => {
    const authStore = useAuthStore();
    const user = { id: '9', username: 'direct', role: 'admin' };

    authStore.setAuth({ accessToken: 'a1', refreshToken: 'r1', user });

    expect(authStore.token).toBe('a1');
    expect(authStore.refreshToken).toBe('r1');
    expect(authStore.user).toEqual(user);
    expect(authStore.isAuthenticated).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('auth_token', 'a1');
  });

  it('clearAuth 清空全部认证状态与本地存储', () => {
    const authStore = useAuthStore();
    authStore.setAuth({
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: '1', username: 'u', role: 'admin' },
    });

    authStore.clearAuth();

    expect(authStore.token).toBeNull();
    expect(authStore.refreshToken).toBeNull();
    expect(authStore.user).toBeNull();
    expect(authStore.error).toBeNull();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('auth_token');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('refresh_token');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('user_info');
  });
});
