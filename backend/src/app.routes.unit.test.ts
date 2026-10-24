/**
 * 路由注册验证测试（真实装配，不 mock 依赖）
 * 验证所有 API 模块挂载路径、认证保护范围与全局中间件生效
 */
import { describe, expect, it } from 'vitest';

import { app } from './app.js';
import { performanceMonitor } from './utils/performance-monitor.js';

describe('App Routes Registration', () => {
  describe('公开端点', () => {
    it('GET /api/ping 返回 200 与运行消息', async () => {
      const response = await app.request('/api/ping', { method: 'GET' });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Hub API is running');
    });

    it('GET /api/performance/stats 无需认证返回 200', async () => {
      const response = await app.request('/api/performance/stats', { method: 'GET' });

      expect(response.status).toBe(200);
    });

    it('GET /api/tools-admin/stats 挂载在 /api/tools-admin 下', async () => {
      const response = await app.request('/api/tools-admin/stats', { method: 'GET' });

      expect(response.status).not.toBe(404);
    });

    it('GET /api/debug/performance-stats 挂载在 /api/debug 下', async () => {
      const response = await app.request('/api/debug/performance-stats', { method: 'GET' });

      expect(response.status).not.toBe(404);
    });

    it('GET /api/oauth/jwks 挂载在 /api/oauth 下', async () => {
      const response = await app.request('/api/oauth/jwks', { method: 'GET' });

      expect(response.status).toBe(200);
    });

    it('POST /api/auth/login 挂载在 /api/auth 下', async () => {
      const response = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'u', password: 'p' }),
      });

      // 路由已注册（参数或凭据问题不应导致 404）
      expect(response.status).not.toBe(404);
    });

    it('根级 /.well-known 路由已挂载（OAuth 未配置时返回 JSON 404 而非默认 404）', async () => {
      const response = await app.request('/.well-known/oauth-protected-resource');

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = await response.json();
      expect(body.error).toBe('OAuth 未配置');
    });

    it('组级 MCP 路由已挂载（未知组返回 JSON-RPC 404）', async () => {
      const response = await app.request('/no-such-group/status');

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = await response.json();
      expect(body.error.message).toContain("组 'no-such-group' 不存在");
    });
  });

  describe('受认证保护的端点（无凭据返回 401）', () => {
    const protectedRoutes: Array<{ path: string; description: string }> = [
      { path: '/api/servers', description: 'Servers API' },
      { path: '/api/tools', description: 'Tools API' },
      { path: '/api/groups', description: 'Groups API' },
      { path: '/api/config', description: 'Config API' },
      { path: '/api/dashboard/stats', description: 'Dashboard API' },
      { path: '/api/skills/sources', description: 'Skills API' },
      { path: '/api/api-to-mcp/configs', description: 'API-to-MCP API' },
    ];

    for (const route of protectedRoutes) {
      it(`GET ${route.path}（${route.description}）未认证返回 401`, async () => {
        const response = await app.request(route.path, { method: 'GET' });

        expect(response.status).toBe(401);
        // 认证中间件在安全头/RequestID 之后执行：401 响应仍应带上全局中间件产物
        expect(response.headers.get('X-Request-ID')).toMatch(/^req_/);
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      });
    }
  });

  describe('全局中间件', () => {
    it('为每个请求注入 X-Request-ID 响应头', async () => {
      const response = await app.request('/api/ping');

      expect(response.headers.get('X-Request-ID')).toMatch(/^req_[a-z0-9]+_[a-z0-9]{6}$/);
    });

    it('透传入站 X-Request-ID', async () => {
      const response = await app.request('/api/ping', {
        headers: { 'X-Request-ID': 'trace-me-42' },
      });

      expect(response.headers.get('X-Request-ID')).toBe('trace-me-42');
    });

    it('注入安全响应头', async () => {
      const response = await app.request('/api/ping');

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(response.headers.get('Permissions-Policy')).toContain('geolocation=()');
    });

    it('性能监控中间件记录请求指标', async () => {
      performanceMonitor.clear();
      await app.request('/api/ping');

      const metrics = performanceMonitor.getMetrics().filter((m) => m.endpoint === '/api/ping');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.method).toBe('GET');
      expect(metrics[0]!.statusCode).toBe(200);
      expect(metrics[0]!.success).toBe(true);
    });

    it('未知路径返回 404', async () => {
      const response = await app.request('/api/nonexistent-endpoint');

      expect(response.status).toBe(404);
    });
  });
});
