/**
 * App 装配单元测试（依赖全部 mock）
 * 验证中间件装配顺序、服务注入、认证接线与路由挂载顺序
 * 真实装配（不 mock）的行为见 app.routes.unit.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { app, apiToMcpWebService, authService } from './app.js';
import { logger } from './utils/logger.js';
import { performanceMonitor } from './utils/performance-monitor.js';

import type { Context } from 'hono';

const mocks = vi.hoisted(() => {
  const initialize = vi.fn(async () => undefined);
  class AuthServiceMock {
    initialize = initialize;
  }
  class ApiToMcpWebServiceMock {
    marker = 'api-to-mcp-web-service';
  }
  // 默认实现：短路返回 401。必须经 Hono context 创建响应（与生产 c.json 一致），
  // 否则会丢失安全头/RequestID 等 preparedHeaders；app.ts 在模块加载期即调用创建中间件
  const createAuthMiddleware = vi.fn(() => async (c: Context) => c.text('AUTH REQUIRED', 401));
  return { initialize, AuthServiceMock, ApiToMcpWebServiceMock, createAuthMiddleware };
});

vi.mock('./services/auth.js', () => ({ AuthService: mocks.AuthServiceMock }));
vi.mock('./services/api-to-mcp-web-service.js', () => ({
  ApiToMcpWebService: mocks.ApiToMcpWebServiceMock,
}));
vi.mock('./middleware/auth.js', () => ({ createAuthMiddleware: mocks.createAuthMiddleware }));
vi.mock('./utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// hubApi 提供探针路由：暴露 requestId 与注入的 apiToMcpWebService
vi.mock('./api/hub.js', async () => {
  const { Hono } = await import('hono');
  const hubApi = new Hono();
  hubApi.get('/ping', (c) =>
    c.json({
      requestId: c.get('requestId'),
      webServiceMarker: (c.get('apiToMcpWebService') as { marker?: string } | undefined)?.marker,
    }),
  );
  return { hubApi };
});

// 其余 API 子应用统一替换为空 Hono 实例（真实路由行为在 routes 测试覆盖）
vi.mock('./api/api-to-mcp/index.js', async () => {
  const { Hono } = await import('hono');
  return { apiToMcpRoutes: new Hono() };
});
vi.mock('./api/auth/index.js', async () => {
  const { Hono } = await import('hono');
  return { createAuthApi: () => new Hono() };
});
vi.mock('./api/config/index.js', async () => {
  const { Hono } = await import('hono');
  return { configApi: new Hono() };
});
vi.mock('./api/dashboard/index.js', async () => {
  const { Hono } = await import('hono');
  return { dashboardApi: new Hono(), shutdownDashboardServices: vi.fn() };
});
vi.mock('./api/debug/index.js', async () => {
  const { Hono } = await import('hono');
  return { debugApi: new Hono() };
});
vi.mock('./api/groups/index.js', async () => {
  const { Hono } = await import('hono');
  return { groupsApi: new Hono() };
});
vi.mock('./api/performance/index.js', async () => {
  const { Hono } = await import('hono');
  return { performanceApi: new Hono() };
});
vi.mock('./api/servers/index.js', async () => {
  const { Hono } = await import('hono');
  return { serversApi: new Hono() };
});
vi.mock('./api/skills/index.js', async () => {
  const { Hono } = await import('hono');
  return { skillsApi: new Hono() };
});
vi.mock('./api/tools/index.js', async () => {
  const { Hono } = await import('hono');
  return { toolsApi: new Hono() };
});
vi.mock('./api/tools-admin/index.js', async () => {
  const { Hono } = await import('hono');
  return { toolsAdminApi: new Hono() };
});

// well-known 路由通过 spy 注册，可验证挂载调用
vi.mock('./api/oauth/index.js', async () => {
  const { Hono } = await import('hono');
  return {
    oauthApi: new Hono(),
    registerWellKnownRoutes: (target: import('hono').Hono) => {
      target.get('/.well-known/oauth-protected-resource', (c) => c.json({ registered: true }));
    },
  };
});

// 组 MCP 路由提供可命中的探针路由
vi.mock('./api/mcp/group-router.js', async () => {
  const { Hono } = await import('hono');
  const groupMcpRouter = new Hono();
  groupMcpRouter.get('/:group/status', (c) => c.json({ group: c.req.param('group') }));
  return { groupMcpRouter };
});

describe('App 装配', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    performanceMonitor.clear();
    mocks.initialize.mockImplementation(async () => undefined);
  });

  it('是可处理的 Hono 应用', async () => {
    expect(app).toBeDefined();
    expect(typeof app.fetch).toBe('function');

    // 未知路径 404（落到 mocked groupMcpRouter 之外）
    const res = await app.request('/api/unknown-path');
    expect(res.status).toBe(404);
  });

  it('导出认证服务与 api-to-mcp Web 服务单例', () => {
    expect(authService).toBeInstanceOf(mocks.AuthServiceMock);
    expect(apiToMcpWebService).toBeInstanceOf(mocks.ApiToMcpWebServiceMock);
  });

  it('每请求执行认证服务初始化', async () => {
    const res = await app.request('/api/ping');
    expect(res.status).toBe(200);
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
  });

  it('认证服务初始化失败仅告警，不阻断请求', async () => {
    mocks.initialize.mockRejectedValueOnce(new Error('init failed'));

    const res = await app.request('/api/ping');

    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      '认证服务初始化失败，某些功能可能不可用',
      expect.objectContaining({ error: 'init failed' }),
    );
  });

  it('向请求上下文注入 apiToMcpWebService 单例', async () => {
    const res = await app.request('/api/ping');

    const body = await res.json();
    expect(body.webServiceMarker).toBe('api-to-mcp-web-service');
  });

  it('公开路由不经过认证中间件', async () => {
    const res = await app.request('/api/ping');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toMatch(/^req_/);
  });

  describe('认证保护范围', () => {
    const protectedPaths = [
      '/api/servers',
      '/api/tools',
      '/api/groups',
      '/api/skills',
      '/api/config',
      '/api/dashboard/stats',
      '/api/api-to-mcp/configs',
    ];

    for (const path of protectedPaths) {
      it(`${path} 受认证中间件保护（401）`, async () => {
        const res = await app.request(path);

        expect(res.status).toBe(401);
        expect(await res.text()).toBe('AUTH REQUIRED');
      });
    }

    it('认证短路响应仍携带安全头与 X-Request-ID（安全头/RequestID 先于认证注册）', async () => {
      const res = await app.request('/api/servers');

      expect(res.status).toBe(401);
      expect(res.headers.get('X-Request-ID')).toMatch(/^req_/);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('性能监控中间件先于认证注册，401 请求也会被记录', async () => {
      await app.request('/api/servers');

      const metrics = performanceMonitor.getMetrics().filter((m) => m.endpoint === '/api/servers');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.statusCode).toBe(401);
      expect(metrics[0]!.success).toBe(false);
    });
  });

  describe('路由挂载', () => {
    it('hubApi 挂载在 /api 下', async () => {
      const res = await app.request('/api/ping');

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Request-ID')).toMatch(/^req_/);
    });

    it('well-known 路由挂载在根路径', async () => {
      const res = await app.request('/.well-known/oauth-protected-resource');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registered).toBe(true);
    });

    it('组 MCP 路由挂载在根路径（通配兜底）', async () => {
      const res = await app.request('/my-group/status');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.group).toBe('my-group');
    });

    it('公开的 hub 探针路由不受子应用认证影响', async () => {
      const res = await app.request('/api/ping', {
        headers: { 'X-Request-ID': 'unit-test-id' },
      });

      expect(res.headers.get('X-Request-ID')).toBe('unit-test-id');
    });
  });
});
