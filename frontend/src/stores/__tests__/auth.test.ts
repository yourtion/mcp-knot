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
});
