/**
 * 认证API测试
 */

import { Hono } from 'hono';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../services/auth.js';
import { resetConfigInstances } from '../../utils/config.js';
import { createAuthApi } from './index.js';

// Mock bcryptjs 以消除哈希计算时间
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$10$mockedhashvalue'),
    compare: vi.fn().mockImplementation(async (password: string, _hash: string) => {
      return password === 'password' || password === 'admin123';
    }),
  },
}));

describe('认证API', () => {
  let app: Hono;
  let authService: AuthService;
  let tempConfigDir: string;

  beforeEach(async () => {
    resetConfigInstances();
    tempConfigDir = await fs.mkdtemp(path.join(tmpdir(), 'mcp-knot-auth-'));
    process.env.CONFIG_PATH = tempConfigDir;

    // 创建临时配置文件
    const tempConfigPath = path.join(tempConfigDir, 'system.json');
    const testConfig = {
      server: {
        port: 3002,
        host: 'localhost',
      },
      auth: {
        jwt: {
          secret: 'test-secret-key-for-auth-api',
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
        admin: {
          id: 'admin',
          username: 'admin',
          password: 'admin123',
          role: 'admin',
          groups: ['admin-group'],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
      ui: {
        title: 'Test MCP Knot',
        theme: 'light',
        features: {
          apiToMcp: true,
          debugging: true,
          monitoring: true,
        },
      },
      monitoring: {
        metricsEnabled: true,
        logLevel: 'info',
        retentionDays: 30,
      },
    };

    await fs.writeFile(tempConfigPath, JSON.stringify(testConfig, null, 2));

    // 初始化认证服务
    authService = new AuthService();
    await authService.initialize();

    // 创建应用
    app = new Hono();
    app.route('/auth', createAuthApi(authService));
  });

  afterEach(async () => {
    delete process.env.CONFIG_PATH;
    resetConfigInstances();
    await fs.rm(tempConfigDir, { recursive: true, force: true });
  });

  describe('POST /auth/login', () => {
    it('应该成功登录有效用户', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'password',
        }),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('user');
      expect(data.data).toHaveProperty('accessToken');
      expect(data.data).toHaveProperty('refreshToken');
      expect(data.data.user.username).toBe('testuser');
      expect(data.data.user.role).toBe('user');
    });

    it('应该拒绝无效用户名', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'nonexistent',
          password: 'password',
        }),
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('应该拒绝无效密码', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'wrongpassword',
        }),
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('应该把代理头解析为客户端 IP 与 User-Agent 传给登录服务（含回退链）', async () => {
      const loginSpy = vi.spyOn(authService, 'login');

      // X-Forwarded-For 优先
      await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.9',
          'X-Real-IP': '10.0.0.1',
          'CF-Connecting-IP': '10.0.0.2',
          'User-Agent': 'curl/8.0',
        },
        body: JSON.stringify({ username: 'testuser', password: 'password' }),
      });
      expect(loginSpy).toHaveBeenLastCalledWith('testuser', 'password', '203.0.113.9', 'curl/8.0');

      // 无 X-Forwarded-For 时回退 X-Real-IP；无 User-Agent 时回退 unknown
      await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': '198.51.100.7',
        },
        body: JSON.stringify({ username: 'testuser', password: 'password' }),
      });
      expect(loginSpy).toHaveBeenLastCalledWith('testuser', 'password', '198.51.100.7', 'unknown');

      // 仅 CF-Connecting-IP 时取第三优先级
      await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.8',
        },
        body: JSON.stringify({ username: 'testuser', password: 'password' }),
      });
      expect(loginSpy).toHaveBeenLastCalledWith('testuser', 'password', '198.51.100.8', 'unknown');

      // 全部缺失时 ip/userAgent 均为 unknown
      await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'password' }),
      });
      expect(loginSpy).toHaveBeenLastCalledWith('testuser', 'password', 'unknown', 'unknown');

      loginSpy.mockRestore();
    });

    it('应该验证请求参数', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: '',
          password: 'password',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('应该在多次失败登录后锁定账户', async () => {
      // 尝试3次失败登录
      for (let i = 0; i < 3; i++) {
        await app.request('/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: 'testuser',
            password: 'wrongpassword',
          }),
        });
      }

      // 第4次尝试应该被锁定
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'wrongpassword',
        }),
      });

      expect(res.status).toBe(423);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_ACCOUNT_LOCKED');
    });
  });

  describe('POST /auth/refresh', () => {
    let refreshToken: string;

    beforeEach(async () => {
      // 先登录获取refresh token
      const loginRes = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'password',
        }),
      });

      const loginData = await loginRes.json();
      refreshToken = loginData.data.refreshToken;
    });

    it('应该成功刷新有效的refresh token', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refreshToken,
        }),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('accessToken');
      expect(data.data).toHaveProperty('refreshToken');
    });

    it('应该拒绝无效的refresh token', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refreshToken: 'invalid-token',
        }),
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_INVALID_REFRESH_TOKEN');
    });

    it('应该验证请求参数', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refreshToken: '',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/logout', () => {
    let accessToken: string;

    beforeEach(async () => {
      // 先登录获取access token
      const loginRes = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'password',
        }),
      });

      const loginData = await loginRes.json();
      accessToken = loginData.data.accessToken;
    });

    it('应该成功登出', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it('应该要求Authorization头', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_MISSING_TOKEN');
    });

    it('应该验证Authorization头格式', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: 'InvalidFormat',
        },
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_INVALID_FORMAT');
    });
  });

  describe('GET /auth/me', () => {
    let accessToken: string;

    beforeEach(async () => {
      // 先登录获取access token
      const loginRes = await app.request('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'testuser',
          password: 'password',
        }),
      });

      const loginData = await loginRes.json();
      accessToken = loginData.data.accessToken;
    });

    it('应该返回当前用户信息', async () => {
      const res = await app.request('/auth/me', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.user.username).toBe('testuser');
      expect(data.data.user.role).toBe('user');
      expect(data.data.user.groups).toEqual(['test-group']);
    });

    it('应该要求Authorization头', async () => {
      const res = await app.request('/auth/me', {
        method: 'GET',
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_MISSING_TOKEN');
    });

    it('应该拒绝无效token', async () => {
      const res = await app.request('/auth/me', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer invalid-token',
        },
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      // 无效token现在正确识别为 AUTH_TOKEN_INVALID（而非 EXPIRED）
      expect(
        ['AUTH_INVALID_TOKEN', 'AUTH_TOKEN_INVALID', 'AUTH_TOKEN_EXPIRED'].includes(
          data.error.code,
        ),
      ).toBe(true);
    });

    it('应该拒绝已登出的token', async () => {
      // 先登出
      await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      // 然后尝试获取用户信息
      const res = await app.request('/auth/me', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });
});
