import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  getHubService: vi.fn(),
  getHubServiceSafe: vi.fn(),
}));

vi.mock('../services/service-registry.js', () => registry);

const shutdownGroupsApi = vi.hoisted(() => vi.fn());

vi.mock('./groups/index.js', () => ({
  shutdownGroupsApi,
}));

import { hubApi } from './hub.js';

function makeService(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getServerHealth: vi.fn().mockReturnValue(new Map([['srv', 'connected']])),
    getDetailedServiceStatus: vi
      .fn()
      .mockResolvedValue({
        isInitialized: true,
        serverCount: 2,
        connectedServers: 1,
        groupCount: 3,
        totalTools: 8,
        apiTools: 2,
      }),
    getApiToolServiceHealth: vi.fn().mockReturnValue({ initialized: true, healthy: true }),
    getServiceDiagnostics: vi
      .fn()
      .mockResolvedValue({
        servers: { total: 2, connected: 1 },
        groups: { total: 3 },
        apiTools: { totalTools: 2 },
      }),
    performApiToolHealthCheck: vi.fn().mockResolvedValue({ healthy: true, initialized: true }),
    reloadApiToolConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Hub API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    registry.getHubService.mockImplementation(() => {
      throw new Error('服务未初始化');
    });
    registry.getHubServiceSafe.mockReturnValue(null);
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'hub-request');
      await next();
    });
    app.route('/api', hubApi);
  });

  it('GET /ping 无需服务初始化即可返回', async () => {
    const response = await app.request('/api/ping');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      message: 'Hub API is running',
    });
  });

  it('GET /health 服务未就绪时返回 503 与 initializing 状态', async () => {
    const response = await app.request('/api/health');

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      requestId: 'hub-request',
      data: {
        service: {
          status: 'initializing',
          isInitialized: false,
          message: 'MCP Knot Service is still initializing or failed to initialize',
        },
      },
    });
  });

  it('GET /health 有连接服务器时状态为 healthy', async () => {
    const service = makeService();
    registry.getHubServiceSafe.mockReturnValue(service);

    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        service: {
          status: 'healthy',
          isInitialized: true,
          serverCount: 2,
          connectedServers: 1,
          groupCount: 3,
          totalTools: 8,
          apiTools: 2,
        },
        servers: { srv: 'connected' },
        apiToolService: { initialized: true, healthy: true },
      },
    });
  });

  it('GET /health 无连接服务器时状态为 degraded', async () => {
    registry.getHubServiceSafe.mockReturnValue(
      makeService({
        getDetailedServiceStatus: vi.fn().mockResolvedValue({
          isInitialized: true,
          serverCount: 2,
          connectedServers: 0,
          groupCount: 1,
          totalTools: 0,
          apiTools: 0,
        }),
      }),
    );

    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { service: { status: 'degraded', connectedServers: 0 } },
    });
  });

  it('GET /health 服务抛错时返回 500', async () => {
    registry.getHubServiceSafe.mockReturnValue(
      makeService({
        getDetailedServiceStatus: vi.fn().mockRejectedValue(new Error('状态探测失败')),
      }),
    );

    const response = await app.request('/api/health');

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('GET /diagnostics 返回完整诊断信息', async () => {
    const service = makeService();
    registry.getHubService.mockReturnValue(service);

    const response = await app.request('/api/diagnostics');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        servers: { total: 2, connected: 1 },
        groups: { total: 3 },
        apiTools: { totalTools: 2 },
      },
    });
  });

  it('GET /diagnostics 服务异常时返回 500', async () => {
    registry.getHubService.mockReturnValue(
      makeService({
        getServiceDiagnostics: vi.fn().mockRejectedValue(new Error('诊断失败')),
      }),
    );

    const response = await app.request('/api/diagnostics');

    expect(response.status).toBe(500);
  });

  it('GET /api-tools/health 返回 API 工具服务健康检查结果', async () => {
    const service = makeService();
    registry.getHubService.mockReturnValue(service);

    const response = await app.request('/api/api-tools/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { healthy: true, initialized: true },
    });
  });

  it('POST /api-tools/reload 重新加载配置并返回提示', async () => {
    const service = makeService();
    registry.getHubService.mockReturnValue(service);

    const response = await app.request('/api/api-tools/reload', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(service.reloadApiToolConfig).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      data: { message: 'API工具配置重新加载完成' },
    });
  });

  it('POST /api-tools/reload 失败时返回 500', async () => {
    registry.getHubService.mockReturnValue(
      makeService({
        reloadApiToolConfig: vi.fn().mockRejectedValue(new Error('重载失败')),
      }),
    );

    const response = await app.request('/api/api-tools/reload', { method: 'POST' });

    expect(response.status).toBe(500);
  });

  it('shutdownHubApi 关闭组管理 API，失败时抛出异常', async () => {
    const { shutdownHubApi } = await import('./hub.js');

    await shutdownHubApi();
    expect(shutdownGroupsApi).toHaveBeenCalledOnce();

    shutdownGroupsApi.mockRejectedValueOnce(new Error('关闭失败'));
    await expect(shutdownHubApi()).rejects.toThrow('关闭失败');
  });
});
