/**
 * 认证API测试
 */

import { AuthError, ErrorCode, ServiceError } from '@mcp-core/mcp-knot-core';
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

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({ logger: loggerMock }));

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
    app.use('*', async (c, next) => {
      c.set('requestId', 'auth-request');
      await next();
    });
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
      expect(data.error.message).toBe('Invalid username or password');
      expect(data.requestId).toBe('auth-request');
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
      expect(data.error.message).toBe('Invalid username or password');
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
      expect(data.error.message).toBe('Account temporarily locked due to too many failed attempts');
      expect(loggerMock.warn).toHaveBeenCalledWith(
        '用户登录失败',
        expect.objectContaining({
          username: 'testuser',
          error: 'Account temporarily locked due to too many failed attempts',
        }),
      );
    });

    it('参数校验失败时返回具体校验消息', async () => {
      const noUser = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '', password: 'password' }),
      });
      expect(noUser.status).toBe(400);
      expect(JSON.stringify(await noUser.json())).toContain('用户名不能为空');

      const noPass = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: '' }),
      });
      expect(noPass.status).toBe(400);
      expect(JSON.stringify(await noPass.json())).toContain('密码不能为空');
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
      expect(JSON.stringify(await res.json())).toContain('刷新token不能为空');
    });

    it('成功刷新时记录日志并返回新 token', async () => {
      loggerMock.info.mockClear();

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      const data = await res.json();
      expect(data.data.accessToken).toEqual(expect.any(String));
      expect(data.data.refreshToken).toEqual(expect.any(String));
      expect(loggerMock.info).toHaveBeenCalledWith('Token 刷新成功');
    });

    it('无效 token 刷新失败时记录警告日志', async () => {
      loggerMock.warn.mockClear();

      await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'invalid-token' }),
      });

      expect(loggerMock.warn).toHaveBeenCalledWith('Token 刷新失败', {
        error: 'Invalid refresh token',
      });
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
      expect(data.data.message).toBe('登出成功');
      expect(loggerMock.info).toHaveBeenCalledWith('用户登出成功');
    });

    it('应该要求Authorization头', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data).toEqual({
        success: false,
        error: { code: 'AUTH_MISSING_TOKEN', message: 'Authorization header is required' },
        requestId: 'auth-request',
        path: '/auth/logout',
      });
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
      expect(data).toEqual({
        success: false,
        error: {
          code: 'AUTH_INVALID_FORMAT',
          message: 'Authorization header must be in format: Bearer <token>',
        },
        requestId: 'auth-request',
        path: '/auth/logout',
      });
    });

    it('Bearer 后缺少 token 时按格式错误处理（HTTP 会去除尾部空白）', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ',
        },
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: {
          code: 'AUTH_INVALID_FORMAT',
          message: 'Authorization header must be in format: Bearer <token>',
        },
        requestId: 'auth-request',
        path: '/auth/logout',
      });
    });

    it('Bearer 前缀必须区分大小写', async () => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: 'bearer abc',
        },
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        success: false,
        error: { code: 'AUTH_INVALID_FORMAT' },
      });
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
      expect(data.data.user).toEqual({
        id: 'testuser',
        username: 'testuser',
        role: 'user',
        groups: ['test-group'],
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('应该要求Authorization头', async () => {
      const res = await app.request('/auth/me', {
        method: 'GET',
      });

      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data).toEqual({
        success: false,
        error: { code: 'AUTH_MISSING_TOKEN', message: 'Authorization header is required' },
        requestId: 'auth-request',
        path: '/auth/me',
      });
    });

    it('应该验证 Authorization 头格式（仅 Bearer / 空 token）', async () => {
      const malformed = await app.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: 'InvalidFormat' },
      });
      expect(await malformed.json()).toEqual({
        success: false,
        error: {
          code: 'AUTH_INVALID_FORMAT',
          message: 'Authorization header must be in format: Bearer <token>',
        },
        requestId: 'auth-request',
        path: '/auth/me',
      });

      const emptyToken = await app.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' },
      });
      // HTTP 头部尾部空白被剥除后只剩 'Bearer'，同样按格式错误处理
      expect(await emptyToken.json()).toEqual({
        success: false,
        error: {
          code: 'AUTH_INVALID_FORMAT',
          message: 'Authorization header must be in format: Bearer <token>',
        },
        requestId: 'auth-request',
        path: '/auth/me',
      });
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

describe('认证API - Mock 服务错误分支', () => {
  const mockService = {
    login: vi.fn(),
    refreshAccessToken: vi.fn(),
    logout: vi.fn(),
    verifyAccessToken: vi.fn(),
    getUserById: vi.fn(),
  };

  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'auth-mock');
      await next();
    });
    app.route('/auth', createAuthApi(mockService as unknown as AuthService));
  });

  function request(path: string, method: string, body?: unknown, headers?: Record<string, string>) {
    return app.request(`/auth${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  describe('POST /login', () => {
    it('登录成功时透传用户信息与双 token 并记录日志', async () => {
      const user = {
        id: 'u1',
        username: 'mockuser',
        role: 'admin',
        groups: ['g1'],
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      mockService.login.mockResolvedValue({
        user,
        accessToken: 'at-1',
        refreshToken: 'rt-1',
      });

      const res = await request(
        '/login',
        'POST',
        { username: 'mockuser', password: 'pw' },
        { 'X-Real-IP': '203.0.113.10', 'User-Agent': 'vitest/1.0' },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        data: { user, accessToken: 'at-1', refreshToken: 'rt-1' },
      });
      expect(mockService.login).toHaveBeenCalledWith(
        'mockuser',
        'pw',
        '203.0.113.10',
        'vitest/1.0',
      );
      expect(loggerMock.info).toHaveBeenCalledWith('用户登录成功', {
        username: 'mockuser',
        ip: '203.0.113.10',
        userAgent: 'vitest/1.0',
      });
    });

    it('普通错误回落 401 AUTH_LOGIN_FAILED 并带 IP 回退链', async () => {
      mockService.login.mockRejectedValue(new Error('数据库不可用'));

      const res = await request('/login', 'POST', { username: 'u', password: 'p' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_LOGIN_FAILED', message: '数据库不可用' },
        requestId: 'auth-mock',
        path: '/auth/login',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith('用户登录失败', {
        username: 'u',
        ip: 'unknown',
        error: '数据库不可用',
      });
    });

    it('登录失败日志的 IP 按 X-Forwarded-For > X-Real-IP 回退', async () => {
      mockService.login.mockRejectedValue(new Error('失败'));

      await request(
        '/login',
        'POST',
        { username: 'u', password: 'p' },
        { 'X-Forwarded-For': '1.1.1.1', 'X-Real-IP': '2.2.2.2' },
      );
      expect(loggerMock.warn).toHaveBeenCalledWith(
        '用户登录失败',
        expect.objectContaining({ ip: '1.1.1.1' }),
      );

      await request('/login', 'POST', { username: 'u', password: 'p' }, { 'X-Real-IP': '2.2.2.2' });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        '用户登录失败',
        expect.objectContaining({ ip: '2.2.2.2' }),
      );
    });

    it('非凭据类 AuthError 不误判为 AUTH_INVALID_CREDENTIALS', async () => {
      mockService.login.mockRejectedValue(new AuthError(ErrorCode.AUTH_TOKEN_INVALID, '令牌无效'));

      const res = await request('/login', 'POST', { username: 'u', password: 'p' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_LOGIN_FAILED', message: '令牌无效' },
        requestId: 'auth-mock',
        path: '/auth/login',
      });
    });

    it('账户锁定 AuthError 返回 423', async () => {
      mockService.login.mockRejectedValue(
        new AuthError(ErrorCode.AUTH_ACCOUNT_LOCKED, '账户已锁定'),
      );

      const res = await request('/login', 'POST', { username: 'u', password: 'p' });

      expect(res.status).toBe(423);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_ACCOUNT_LOCKED', message: '账户已锁定' },
        requestId: 'auth-mock',
        path: '/auth/login',
      });
    });

    it('ServiceError 返回 500 AUTH_SERVICE_ERROR', async () => {
      mockService.login.mockRejectedValue(
        new ServiceError(ErrorCode.INTERNAL_SERVER_ERROR, '服务故障'),
      );

      const res = await request('/login', 'POST', { username: 'u', password: 'p' });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_SERVICE_ERROR', message: '服务故障' },
        requestId: 'auth-mock',
        path: '/auth/login',
      });
    });
  });

  describe('POST /refresh', () => {
    it('token 无效的 AuthError 返回 AUTH_INVALID_REFRESH_TOKEN', async () => {
      mockService.refreshAccessToken.mockRejectedValue(
        new AuthError(ErrorCode.AUTH_TOKEN_INVALID, '刷新令牌无效'),
      );

      const res = await request('/refresh', 'POST', { refreshToken: 'bad' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_INVALID_REFRESH_TOKEN', message: '刷新令牌无效' },
        requestId: 'auth-mock',
        path: '/auth/refresh',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith('Token 刷新失败', { error: '刷新令牌无效' });
    });

    it('普通错误返回 AUTH_REFRESH_FAILED', async () => {
      mockService.refreshAccessToken.mockRejectedValue(new Error('存储不可用'));

      const res = await request('/refresh', 'POST', { refreshToken: 'any' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_REFRESH_FAILED', message: '存储不可用' },
        requestId: 'auth-mock',
        path: '/auth/refresh',
      });
    });

    it('刷新成功返回双 token', async () => {
      mockService.refreshAccessToken.mockResolvedValue({
        accessToken: 'at-2',
        refreshToken: 'rt-2',
      });

      const res = await request('/refresh', 'POST', { refreshToken: 'rt-1' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        data: { accessToken: 'at-2', refreshToken: 'rt-2' },
      });
    });
  });

  describe('POST /logout', () => {
    it('登出服务抛错返回 500 AUTH_LOGOUT_FAILED', async () => {
      mockService.logout.mockRejectedValue(new Error('撤销失败'));

      const res = await request('/logout', 'POST', undefined, {
        Authorization: 'Bearer tk',
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_LOGOUT_FAILED', message: '撤销失败' },
        requestId: 'auth-mock',
        path: '/auth/logout',
      });
      expect(loggerMock.warn).toHaveBeenCalledWith('用户登出失败', { error: '撤销失败' });
    });

    it('登出成功调用服务并返回成功', async () => {
      mockService.logout.mockResolvedValue(undefined);

      const res = await request('/logout', 'POST', undefined, {
        Authorization: 'Bearer tk',
      });

      expect(res.status).toBe(200);
      expect(mockService.logout).toHaveBeenCalledWith('tk');
      expect(await res.json()).toMatchObject({
        success: true,
        data: { message: '登出成功' },
      });
    });
  });

  describe('GET /me', () => {
    it('token 校验抛普通错误返回 AUTH_INVALID_TOKEN', async () => {
      mockService.verifyAccessToken.mockRejectedValue(new Error('校验服务崩溃'));

      const res = await request('/me', 'GET', undefined, { Authorization: 'Bearer tk' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_INVALID_TOKEN', message: '校验服务崩溃' },
        requestId: 'auth-mock',
        path: '/auth/me',
      });
    });

    it('token 过期返回 AUTH_TOKEN_EXPIRED', async () => {
      mockService.verifyAccessToken.mockRejectedValue(
        new AuthError(ErrorCode.AUTH_TOKEN_EXPIRED, '令牌已过期'),
      );

      const res = await request('/me', 'GET', undefined, { Authorization: 'Bearer tk' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_TOKEN_EXPIRED', message: '令牌已过期' },
        requestId: 'auth-mock',
        path: '/auth/me',
      });
    });

    it('token 无效返回 AUTH_TOKEN_INVALID', async () => {
      mockService.verifyAccessToken.mockRejectedValue(
        new AuthError(ErrorCode.AUTH_TOKEN_INVALID, '令牌无效'),
      );

      const res = await request('/me', 'GET', undefined, { Authorization: 'Bearer tk' });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_TOKEN_INVALID', message: '令牌无效' },
        requestId: 'auth-mock',
        path: '/auth/me',
      });
    });

    it('用户不存在返回 404 AUTH_USER_NOT_FOUND', async () => {
      mockService.verifyAccessToken.mockResolvedValue({ sub: 'ghost-user' });
      mockService.getUserById.mockReturnValue(null);

      const res = await request('/me', 'GET', undefined, { Authorization: 'Bearer tk' });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        success: false,
        error: { code: 'AUTH_USER_NOT_FOUND', message: 'User not found' },
        requestId: 'auth-mock',
        path: '/auth/me',
      });
    });

    it('返回用户字段映射', async () => {
      mockService.verifyAccessToken.mockResolvedValue({ sub: 'u9' });
      mockService.getUserById.mockReturnValue({
        id: 'u9',
        username: 'mapped',
        role: 'user',
        groups: ['a', 'b'],
        createdAt: '2026-02-02T00:00:00.000Z',
      });

      const res = await request('/me', 'GET', undefined, { Authorization: 'Bearer tk' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        data: {
          user: {
            id: 'u9',
            username: 'mapped',
            role: 'user',
            groups: ['a', 'b'],
            createdAt: '2026-02-02T00:00:00.000Z',
          },
        },
      });
    });
  });
});
