import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const metadataFns = vi.hoisted(() => ({
  getProtectedResourceMetadata: vi.fn(),
  getInternalAsMetadata: vi.fn(),
}));

vi.mock('../../services/oauth/as-metadata.js', () => ({
  getProtectedResourceMetadata: metadataFns.getProtectedResourceMetadata,
}));

vi.mock('../../services/oauth/internal-as.js', () => ({
  getInternalAsMetadata: metadataFns.getInternalAsMetadata,
}));

const configMock = vi.hoisted(() => ({
  getAllConfig: vi.fn(),
}));

vi.mock('../../utils/config.js', () => configMock);

import { registerWellKnownRoutes } from './well-known.js';

function makeApp(): Hono {
  const app = new Hono();
  registerWellKnownRoutes(app);
  return app;
}

describe('well-known 元数据端点', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metadataFns.getProtectedResourceMetadata.mockImplementation((_oauth, resource: string) => ({
      resource,
    }));
    metadataFns.getInternalAsMetadata.mockImplementation((issuer: string) => ({ issuer }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('配置了 issuer 时 protected-resource 使用显式 issuer', async () => {
    configMock.getAllConfig.mockResolvedValue({
      system: { oauth: { mode: 'external', internal: { issuer: 'https://hub.example.com' } } },
    });

    const response = await makeApp().request('/.well-known/oauth-protected-resource', {
      headers: { host: 'other.example.com' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resource: 'https://hub.example.com' });
  });

  it('未配置 issuer 时按 Host 头与 OAUTH_PUBLIC_SCHEME 推导 resource', async () => {
    configMock.getAllConfig.mockResolvedValue({
      system: { oauth: { mode: 'external', internal: {} } },
    });
    vi.stubEnv('OAUTH_PUBLIC_SCHEME', 'http');

    const response = await makeApp().request('/.well-known/oauth-protected-resource', {
      headers: { host: 'hub.local:8080' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resource: 'http://hub.local:8080' });
  });

  it('无 Host 头且无环境变量时默认 https://localhost', async () => {
    configMock.getAllConfig.mockResolvedValue({
      system: { oauth: { mode: 'external' } },
    });
    delete process.env.OAUTH_PUBLIC_SCHEME;

    const response = await makeApp().request('/.well-known/oauth-protected-resource');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resource: 'https://localhost' });
  });

  it('OAuth 未配置时 protected-resource 返回 404', async () => {
    configMock.getAllConfig.mockResolvedValue({ system: {} });

    const response = await makeApp().request('/.well-known/oauth-protected-resource');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'OAuth 未配置' });
  });

  it('按组路径变体返回 `${resource}/${group}/mcp` 元数据', async () => {
    configMock.getAllConfig.mockResolvedValue({
      system: { oauth: { mode: 'external', internal: { issuer: 'https://hub.example.com' } } },
    });

    const response = await makeApp().request('/.well-known/oauth-protected-resource/team/mcp');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resource: 'https://hub.example.com/team/mcp' });
  });

  it('内置 AS 元数据仅在 internal/both 模式暴露', async () => {
    configMock.getAllConfig.mockResolvedValue({
      system: { oauth: { mode: 'external' } },
    });
    const external = await makeApp().request('/.well-known/oauth-authorization-server');
    expect(external.status).toBe(404);
    expect(await external.json()).toEqual({ error: '内置 AS 未启用' });

    configMock.getAllConfig.mockResolvedValue({
      system: {
        oauth: {
          mode: 'internal',
          internal: { issuer: 'https://as.example.com' },
        },
      },
    });
    const internal = await makeApp().request('/.well-known/oauth-authorization-server');
    expect(internal.status).toBe(200);
    expect(await internal.json()).toEqual({ issuer: 'https://as.example.com' });

    configMock.getAllConfig.mockResolvedValue({
      system: { oauth: { mode: 'both' } },
    });
    const both = await makeApp().request('/.well-known/oauth-authorization-server', {
      headers: { host: 'hub.example.com' },
    });
    expect(both.status).toBe(200);
    expect(await both.json()).toEqual({ issuer: 'https://hub.example.com' });
  });
});
