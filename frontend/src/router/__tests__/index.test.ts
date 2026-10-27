import { createPinia, setActivePinia } from 'pinia';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authService from '@/services/auth';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/services/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  validateToken: vi.fn(),
  refreshToken: vi.fn(),
}));

const mockAuthService = authService as unknown as Record<string, ReturnType<typeof vi.fn>>;

// 当前 jsdom 测试环境没有 localStorage；router 的模块依赖链（MainLayout → useTheme）
// 在模块初始化时读取 localStorage，必须在动态导入 router 前就绪
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

let router: typeof import('@/router').default;

const loginAsAuthenticated = () => {
  const authStore = useAuthStore();
  authStore.token = 'token';
  authStore.user = { id: '1', username: 'tester', role: 'admin' };
  return authStore;
};

describe('Router', () => {
  beforeAll(async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    router = (await import('@/router')).default;
  }, 30000);

  beforeEach(async () => {
    vi.stubGlobal('localStorage', createLocalStorage());
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockAuthService.validateToken.mockResolvedValue(false);
    // 从无需认证的 NotFound 路由出发，避免与目标路由产生重复导航
    await router.push('/__test_start__');
    expect(router.currentRoute.value.name).toBe('NotFound');
  });

  it('已认证用户访问登录页时重定向到仪表板', async () => {
    loginAsAuthenticated();

    await router.push('/login');

    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('未认证用户访问受保护路由时跳转登录并携带回跳地址', async () => {
    await router.push('/servers');

    expect(router.currentRoute.value.name).toBe('Login');
    expect(router.currentRoute.value.query.redirect).toBe('/servers');
  });

  it('本地会话校验通过时放行受保护路由', async () => {
    const authStore = useAuthStore();
    authStore.token = 'token';
    mockAuthService.validateToken.mockResolvedValue(true);

    await router.push('/servers');

    expect(router.currentRoute.value.path).toBe('/servers');
    expect(mockAuthService.validateToken).toHaveBeenCalledTimes(1);
  });

  it('已认证用户访问受保护路由时无需再次校验', async () => {
    loginAsAuthenticated();

    await router.push('/servers');

    expect(router.currentRoute.value.path).toBe('/servers');
    expect(mockAuthService.validateToken).not.toHaveBeenCalled();
  });

  it('未认证用户可以访问登录页', async () => {
    await router.push('/login');

    expect(router.currentRoute.value.name).toBe('Login');
  });

  it('访问根路径重定向到仪表板', async () => {
    loginAsAuthenticated();

    await router.push('/');

    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('未匹配的路径进入 NotFound', async () => {
    loginAsAuthenticated();

    await router.push('/no-such-page');

    expect(router.currentRoute.value.name).toBe('NotFound');
  });

  it('导航时按路由 meta 设置页面标题', async () => {
    loginAsAuthenticated();

    await router.push('/servers');

    expect(document.title).toBe('服务器管理 - MCP Knot');

    await router.push('/tools');

    expect(document.title).toBe('工具管理 - MCP Knot');
  });

  it('校验失败后清除本地会话', async () => {
    const authStore = useAuthStore();
    // 仅设置 token（未设置 user），守卫需要调用 validateToken 校验
    authStore.token = 'token';
    mockAuthService.validateToken.mockResolvedValue(false);

    await router.push('/groups');

    expect(router.currentRoute.value.name).toBe('Login');
    expect(authStore.token).toBeNull();
    expect(authStore.user).toBeNull();
  });
});
