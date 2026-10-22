import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getInternalPublicKeySet = vi.hoisted(() => vi.fn());

vi.mock('../../services/oauth/crypto-keys.js', () => ({
  getInternalPublicKeySet,
}));

import { registerJwksRoutes } from './jwks.js';

describe('GET /jwks - 内置 AS 公钥集合', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    registerJwksRoutes(app);
  });

  it('返回 RFC7517 JWK Set', async () => {
    const keys = [{ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', use: 'sig', alg: 'ES256' }];
    getInternalPublicKeySet.mockReturnValueOnce(keys);

    const response = await app.request('/jwks');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys });
  });

  it('密钥集为空时返回空数组', async () => {
    getInternalPublicKeySet.mockReturnValueOnce([]);

    const response = await app.request('/jwks');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [] });
  });
});
