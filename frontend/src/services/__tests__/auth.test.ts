import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as authService from '../auth';
import api from '@/services/api';

import type { Mock } from 'vitest';

vi.mock('@/services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  handleApiResponse: vi.fn((response: unknown) => {
    const body = (
      response as {
        data: { success: boolean; data?: unknown; error?: { message?: string } };
      }
    ).data;
    if (body.success && body.data !== undefined) return body.data;
    throw new Error(body.error?.message || '请求失败');
  }),
}));

const ok = (data: unknown) => ({ data: { success: true, data } });
const mocked = { get: api.get as unknown as Mock, post: api.post as unknown as Mock };

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

describe('AuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  it('login POST /auth/login 并返回响应数据', async () => {
    const credentials = { username: 'admin', password: 'secret' };
    const loginResponse = {
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: '1', username: 'admin', role: 'admin' },
    };
    mocked.post.mockResolvedValue(ok(loginResponse));

    const result = await authService.login(credentials);

    expect(result).toEqual(loginResponse);
    expect(mocked.post).toHaveBeenCalledWith('/auth/login', credentials);
  });

  it('logout POST /auth/logout 并清除本地令牌', async () => {
    mocked.post.mockResolvedValue(ok(null));
    localStorage.setItem('auth_token', 'a');
    localStorage.setItem('refresh_token', 'r');
    localStorage.setItem('user_info', '{}');

    await authService.logout();

    expect(mocked.post).toHaveBeenCalledWith('/auth/logout');
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(localStorage.getItem('user_info')).toBeNull();
  });

  it('logout 请求失败时仍清除本地令牌', async () => {
    mocked.post.mockRejectedValue(new Error('网络错误'));
    localStorage.setItem('auth_token', 'a');

    await expect(authService.logout()).rejects.toThrow('网络错误');

    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('refreshToken POST /auth/refresh 并携带刷新令牌', async () => {
    mocked.post.mockResolvedValue(ok({ token: 'new-access' }));

    const result = await authService.refreshToken('old-refresh');

    expect(result).toEqual({ token: 'new-access' });
    expect(mocked.post).toHaveBeenCalledWith('/auth/refresh', { refreshToken: 'old-refresh' });
  });

  it('validateToken 校验通过返回 true', async () => {
    mocked.get.mockResolvedValue(ok({ id: '1' }));

    await expect(authService.validateToken()).resolves.toBe(true);
    expect(mocked.get).toHaveBeenCalledWith('/auth/me');
  });

  it('validateToken 校验失败返回 false', async () => {
    mocked.get.mockRejectedValue(new Error('401'));

    await expect(authService.validateToken()).resolves.toBe(false);
  });

  it('login 请求失败时向上传播错误', async () => {
    mocked.post.mockRejectedValue(new Error('凭据无效'));

    await expect(authService.login({ username: 'u', password: 'p' })).rejects.toThrow('凭据无效');
  });
});
