/**
 * 认证服务测试
 */

import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.js';

// Mock bcryptjs 以消除哈希计算时间
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$10$mockedhashvalue'),
    compare: vi.fn().mockImplementation(async (password: string, _hash: string) => {
      // 简单判断：如果密码匹配测试配置中的密码则返回 true
      return password === 'password' || password === 'admin123';
    }),
  },
}));

// Mock getAllConfig to return in-memory config
// Note: vi.mock factory is hoisted, so config must be inlined (not referenced via top-level variable)
vi.mock('../utils/config.js', () => ({
  getAllConfig: vi.fn().mockResolvedValue({
    mcps: { servers: {} },
    groups: {},
    system: {
      server: { port: 3000, host: 'localhost' },
      auth: {
        jwt: {
          secret: 'test-secret-key',
          expiresIn: '15m',
          refreshExpiresIn: '7d',
          issuer: 'mcp-knot-test',
        },
        security: {
          maxLoginAttempts: 3,
          lockoutDuration: 300000,
          passwordMinLength: 4,
          requireStrongPassword: false,
        },
      },
      users: {
        testuser: {
          id: 'testuser',
          username: 'testuser',
          password: 'password',
          role: 'user',
          groups: ['test-group'],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
      ui: {
        title: 'Test MCP Knot',
        theme: 'light',
        features: { apiToMcp: true, debugging: true, monitoring: true },
      },
      monitoring: { metricsEnabled: true, logLevel: 'info', retentionDays: 30 },
    },
    apiToolsConfigPath: undefined,
  }),
  resetConfigInstances: vi.fn(),
}));

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    authService = new AuthService();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('初始化', () => {
    it('应该成功初始化认证服务', async () => {
      await expect(authService.initialize()).resolves.not.toThrow();
    });

    it('重复 initialize 时跳过已加载的配置（幂等）', async () => {
      const { getAllConfig } = await import('../utils/config.js');

      await authService.initialize();
      await authService.initialize();

      expect(vi.mocked(getAllConfig)).toHaveBeenCalledTimes(1);
    });

    it('配置加载失败时抛出 Failed to load system config', async () => {
      const { getAllConfig } = await import('../utils/config.js');

      (vi.mocked(getAllConfig) as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('disk error'),
      );

      await expect(authService.initialize()).rejects.toThrow(
        'Failed to load system config: Error: disk error',
      );
    });

    it('应该在配置文件不存在时使用默认配置初始化', async () => {
      const { getAllConfig } = await import('../utils/config.js');

      // Mock getAllConfig to return empty system config for this test
      // biome-ignore lint/suspicious/noExplicitAny: mock requires flexible return type
      (vi.mocked(getAllConfig) as any).mockImplementationOnce(async () => ({
        mcps: { servers: {} },
        groups: {},
        system: {},
        apiToolsConfigPath: undefined,
      }));

      // JsonStorage 在文件不存在时会创建默认文件，所以初始化应该成功
      await expect(authService.initialize()).resolves.not.toThrow();
    });
  });

  describe('默认配置兜底', () => {
    it('空 system 配置时使用默认 admin 用户与 jwt issuer', async () => {
      const { getAllConfig } = await import('../utils/config.js');
      // biome-ignore lint/suspicious/noExplicitAny: mock requires flexible return type
      (vi.mocked(getAllConfig) as any).mockImplementationOnce(async () => ({
        mcps: { servers: {} },
        groups: {},
        system: {},
        apiToolsConfigPath: undefined,
      }));
      const bcrypt = (await import('bcryptjs')).default;
      // 默认密码 'admin' 不在 compare mock 的白名单内，单独放行一次
      vi.mocked(bcrypt.compare).mockResolvedValueOnce(true);

      await authService.initialize();
      const result = await authService.login('admin', 'admin');

      expect(result.user).toStrictEqual({ id: 'admin', username: 'admin', role: 'admin' });
      const payload = jwt.decode(result.accessToken) as jwt.JwtPayload;
      expect(payload.iss).toBe('mcp-knot');
    });

    it('默认配置的锁定阈值为 5 次（第 4 次失败尚未锁定）', async () => {
      const { getAllConfig } = await import('../utils/config.js');
      // biome-ignore lint/suspicious/noExplicitAny: mock requires flexible return type
      (vi.mocked(getAllConfig) as any).mockImplementationOnce(async () => ({
        mcps: { servers: {} },
        groups: {},
        system: {},
        apiToolsConfigPath: undefined,
      }));

      await authService.initialize();

      // 默认 maxLoginAttempts=5：前 5 次失败均为普通凭据错误（第 4 次仍不锁定，
      // 区别于测试配置的 3 次阈值）
      for (let i = 0; i < 5; i++) {
        await expect(authService.login('admin', 'wrong')).rejects.toThrow(
          'Invalid username or password',
        );
      }
      // 第 6 次达到锁定阈值
      await expect(authService.login('admin', 'wrong')).rejects.toThrow(
        'Account temporarily locked',
      );
    });
  });

  describe('未初始化的服务调用', () => {
    it('login 未初始化时抛出 Auth service not initialized', async () => {
      await expect(authService.login('testuser', 'password')).rejects.toThrow(
        'Auth service not initialized',
      );
    });

    it('refreshAccessToken 未初始化时抛出 Auth service not initialized', async () => {
      await expect(authService.refreshAccessToken('any-token')).rejects.toThrow(
        'Auth service not initialized',
      );
    });

    it('verifyAccessToken 未初始化时抛出 Auth service not initialized', async () => {
      await expect(authService.verifyAccessToken('any-token')).rejects.toThrow(
        'Auth service not initialized',
      );
    });

    it('getUserById 未初始化时返回 null', () => {
      expect(authService.getUserById('testuser')).toBeNull();
    });
  });

  describe('用户登录', () => {
    beforeEach(async () => {
      await authService.initialize();
    });

    it('应该成功登录有效用户', async () => {
      const result = await authService.login('testuser', 'password');

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user.username).toBe('testuser');
      expect(result.user.role).toBe('user');
    });

    it('登录会话完整记录 sessionId、ip 与 userAgent 等字段', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.12345678901234);

      const result = await authService.login('testuser', 'password', '10.0.0.1', 'UA/vitest');

      const sessions = authService.getUserSessions('testuser');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: 'session_1000_4fzzzxkxf',
        userId: 'testuser',
        ip: '10.0.0.1',
        userAgent: 'UA/vitest',
        createdAt: 1000,
        lastActivity: 1000,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });

      // access token 携带唯一 jti（与 sessionId 同源的 session_ 前缀格式）
      const payload = jwt.decode(result.accessToken) as jwt.JwtPayload;
      expect(payload.jti).toBe('session_1000_4fzzzxkxf');

      randomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('应该拒绝无效用户名', async () => {
      await expect(authService.login('nonexistent', 'password')).rejects.toThrow(
        'Invalid username or password',
      );
    });

    it('应该拒绝无效密码', async () => {
      await expect(authService.login('testuser', 'wrongpassword')).rejects.toThrow(
        'Invalid username or password',
      );
    });

    it('应该在多次失败登录后锁定用户', async () => {
      // 尝试3次失败登录
      for (let i = 0; i < 3; i++) {
        try {
          await authService.login('testuser', 'wrongpassword');
        } catch {
          // 忽略预期的错误
        }
      }

      // 第4次尝试应该被锁定
      await expect(authService.login('testuser', 'wrongpassword')).rejects.toThrow(
        'Account temporarily locked',
      );
    });

    it('不存在的用户名失败次数同样计入锁定', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(authService.login('nonexistent', 'password')).rejects.toThrow(
          'Invalid username or password',
        );
      }

      await expect(authService.login('nonexistent', 'password')).rejects.toThrow(
        'Account temporarily locked',
      );
    });

    it('成功登录会清空此前的失败计数（穿插失败不累积锁定）', async () => {
      // 失败、失败、成功（清空）、再失败：此后仅 1 条失败记录，不应锁定
      for (let i = 0; i < 2; i++) {
        await expect(authService.login('testuser', 'wrong')).rejects.toThrow(
          'Invalid username or password',
        );
      }
      await expect(authService.login('testuser', 'password')).resolves.toBeDefined();
      await expect(authService.login('testuser', 'wrong')).rejects.toThrow(
        'Invalid username or password',
      );

      // 下一次失败仍是普通凭据错误，而非锁定
      await expect(authService.login('testuser', 'wrong')).rejects.toThrow(
        'Invalid username or password',
      );
    });

    it('失败记录超过锁定窗口后不再锁定（窗口边界）', async () => {
      vi.useFakeTimers();
      const base = Date.now();
      vi.setSystemTime(base);

      for (let i = 0; i < 3; i++) {
        await expect(authService.login('testuser', 'wrong')).rejects.toThrow(
          'Invalid username or password',
        );
      }
      await expect(authService.login('testuser', 'wrong')).rejects.toThrow(
        'Account temporarily locked',
      );

      // 恰好到达 lockoutDuration（300000ms）时窗口关闭，恢复为普通凭据错误
      vi.setSystemTime(base + 300000);
      await expect(authService.login('testuser', 'wrong')).rejects.toThrow(
        'Invalid username or password',
      );

      vi.useRealTimers();
    });
  });

  describe('Token验证', () => {
    let accessToken: string;

    beforeEach(async () => {
      await authService.initialize();
      const result = await authService.login('testuser', 'password');
      accessToken = result.accessToken;
    });

    it('应该成功验证有效token', async () => {
      const payload = await authService.verifyAccessToken(accessToken);

      expect(payload.sub).toBe('testuser');
      expect(payload.username).toBe('testuser');
      expect(payload.role).toBe('user');
    });

    it('验证通过时会更新会话的 lastActivity', async () => {
      vi.useFakeTimers();
      const base = Date.now();
      vi.setSystemTime(base);

      const result = await authService.login('testuser', 'password');
      vi.setSystemTime(base + 5000);
      await authService.verifyAccessToken(result.accessToken);

      const session = authService
        .getUserSessions('testuser')
        .find((s) => s.accessToken === result.accessToken);
      expect(session?.lastActivity).toBe(base + 5000);

      vi.useRealTimers();
    });

    it('应该拒绝无效token', async () => {
      await expect(authService.verifyAccessToken('invalid-token')).rejects.toThrow('Invalid token');
    });

    it('应该拒绝已过期的token', async () => {
      vi.useFakeTimers();
      const base = Date.now();
      vi.setSystemTime(base);

      const expiredToken = jwt.sign(
        { sub: 'testuser', role: 'user' } as jwt.JwtPayload,
        'test-secret-key',
        { expiresIn: '1s' },
      );
      vi.setSystemTime(base + 2000);

      await expect(authService.verifyAccessToken(expiredToken)).rejects.toThrow(
        'Token has expired',
      );

      vi.useRealTimers();
    });

    it('应该拒绝已撤销的token', async () => {
      await authService.logout(accessToken);

      await expect(authService.verifyAccessToken(accessToken)).rejects.toThrow(
        'Token has been revoked',
      );
    });

    it('登出后删除会话并将 refresh token 一并拉黑', async () => {
      const result = await authService.login('testuser', 'password');
      await authService.logout(result.accessToken);

      // 该 token 对应的会话被删除（beforeEach 建立的会话不受影响）
      expect(
        authService.getUserSessions('testuser').some((s) => s.refreshToken === result.refreshToken),
      ).toBe(false);
      await expect(authService.verifyAccessToken(result.accessToken)).rejects.toThrow(
        'Token has been revoked',
      );
      await expect(authService.refreshAccessToken(result.refreshToken)).rejects.toThrow(
        'Invalid refresh token',
      );
    });
  });

  describe('Token刷新', () => {
    let refreshToken: string;
    let accessToken: string;

    beforeEach(async () => {
      await authService.initialize();
      const result = await authService.login('testuser', 'password');
      refreshToken = result.refreshToken;
      accessToken = result.accessToken;
    });

    it('应该成功刷新有效的refresh token', async () => {
      const result = await authService.refreshAccessToken(refreshToken);

      const accessPayload = jwt.decode(result.accessToken) as jwt.JwtPayload;
      expect(accessPayload.sub).toBe('testuser');
      expect(accessPayload.role).toBe('user');
      const refreshPayload = jwt.decode(result.refreshToken) as jwt.JwtPayload;
      expect(refreshPayload.type).toBe('refresh');
      expect(result.refreshToken).not.toBe(refreshToken);
    });

    it('刷新后同步更新会话中的 token 对', async () => {
      const loginResult = await authService.login('testuser', 'password');
      const refreshed = await authService.refreshAccessToken(loginResult.refreshToken);

      const sessions = authService.getUserSessions('testuser');
      expect(sessions).toHaveLength(2);
      const updated = sessions.find((s) => s.refreshToken === refreshed.refreshToken);
      expect(updated?.accessToken).toBe(refreshed.accessToken);
      expect(updated?.refreshToken).toBe(refreshed.refreshToken);
      // 旧 token 对应的会话已更新而非新增
      expect(sessions.some((s) => s.refreshToken === loginResult.refreshToken)).toBe(false);
    });

    it('使用 access token 充当 refresh token 时被拒绝', async () => {
      await expect(authService.refreshAccessToken(accessToken)).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('refresh token 指向的用户不存在时被拒绝', async () => {
      const ghostToken = jwt.sign(
        { sub: 'ghost', type: 'refresh' } as jwt.JwtPayload,
        'test-secret-key',
      );

      await expect(authService.refreshAccessToken(ghostToken)).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('应该拒绝无效的refresh token', async () => {
      await expect(authService.refreshAccessToken('invalid-refresh-token')).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('应该拒绝已使用的refresh token', async () => {
      // 使用一次refresh token
      await authService.refreshAccessToken(refreshToken);

      // 再次使用应该失败
      await expect(authService.refreshAccessToken(refreshToken)).rejects.toThrow(
        'Invalid refresh token',
      );
    });
  });

  describe('用户管理', () => {
    beforeEach(async () => {
      await authService.initialize();
    });

    it('应该能够根据ID获取用户', () => {
      const user = authService.getUserById('testuser');

      expect(user).not.toBeNull();
      expect(user?.username).toBe('testuser');
      expect(user?.role).toBe('user');
    });

    it('应该在用户不存在时返回null', () => {
      const user = authService.getUserById('nonexistent');
      expect(user).toBeNull();
    });

    it('应该能够获取活跃会话数量', async () => {
      const initialCount = authService.getActiveSessionCount();
      expect(initialCount).toBe(0);

      await authService.login('testuser', 'password');

      const afterLoginCount = authService.getActiveSessionCount();
      expect(afterLoginCount).toBe(1);
    });

    it('getUserSessions 只返回指定用户的会话', async () => {
      const { getAllConfig } = await import('../utils/config.js');
      // biome-ignore lint/suspicious/noExplicitAny: mock requires flexible return type
      (vi.mocked(getAllConfig) as any).mockImplementationOnce(async () => ({
        mcps: { servers: {} },
        groups: {},
        system: {
          users: {
            user1: {
              id: 'user1',
              username: 'user1',
              password: 'password',
              role: 'user',
              groups: [],
              createdAt: '2024-01-01T00:00:00.000Z',
            },
            user2: {
              id: 'user2',
              username: 'user2',
              password: 'password',
              role: 'user',
              groups: [],
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          },
        },
        apiToolsConfigPath: undefined,
      }));

      // 用新实例消费 Once mock（当前实例已在 beforeEach 初始化过）
      const multiUserService = new AuthService();
      await multiUserService.initialize();
      await multiUserService.login('user1', 'password');
      await multiUserService.login('user2', 'password');

      const user1Sessions = multiUserService.getUserSessions('user1');
      expect(user1Sessions).toHaveLength(1);
      expect(user1Sessions[0]?.userId).toBe('user1');
      expect(multiUserService.getUserSessions('user2')).toHaveLength(1);
      expect(multiUserService.getActiveSessionCount()).toBe(2);
    });
  });

  describe('清理功能', () => {
    beforeEach(async () => {
      await authService.initialize();
    });

    it('会话闲置恰好 24 小时（含边界）时不清理', async () => {
      vi.useFakeTimers();
      const base = Date.now();
      vi.setSystemTime(base);

      const result = await authService.login('testuser', 'password');
      vi.setSystemTime(base + 24 * 60 * 60 * 1000);
      await authService.cleanup();

      expect(authService.getActiveSessionCount()).toBe(1);
      // 未被拉黑：黑名单检查先于过期检查，此处报过期而非 revoked
      await expect(authService.verifyAccessToken(result.accessToken)).rejects.toThrow(
        'Token has expired',
      );

      vi.useRealTimers();
    });

    it('会话闲置超过 24 小时时清理会话并拉黑双 token', async () => {
      vi.useFakeTimers();
      const base = Date.now();
      vi.setSystemTime(base);

      const result = await authService.login('testuser', 'password');
      vi.setSystemTime(base + 24 * 60 * 60 * 1000 + 1);
      await authService.cleanup();

      expect(authService.getActiveSessionCount()).toBe(0);
      expect(authService.getUserSessions('testuser')).toHaveLength(0);
      await expect(authService.verifyAccessToken(result.accessToken)).rejects.toThrow(
        'Token has been revoked',
      );
      await expect(authService.refreshAccessToken(result.refreshToken)).rejects.toThrow(
        'Invalid refresh token',
      );

      vi.useRealTimers();
    });
  });
});
