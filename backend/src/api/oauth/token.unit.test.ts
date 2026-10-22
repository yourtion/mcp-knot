import { ErrorCode, McpKnotCoreError } from '@mcp-core/mcp-knot-core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const issueClientCredentialsToken = vi.hoisted(() => vi.fn());

vi.mock('../../services/oauth/internal-as.js', () => ({
  issueClientCredentialsToken,
}));

const configMock = vi.hoisted(() => ({
  getAllConfig: vi.fn(),
}));

vi.mock('../../utils/config.js', () => configMock);

import { registerTokenRoutes } from './token.js';

function tokenRequest(params: Record<string, string>): Promise<Response> {
  const app = new Hono();
  registerTokenRoutes(app);
  return app.request('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

const oauthConfig = {
  mode: 'internal',
  internal: { issuer: 'https://hub.example.com' },
};

describe('POST /token - OAuth client_credentials 签发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.getAllConfig.mockResolvedValue({ system: { oauth: oauthConfig } });
  });

  it('签发成功返回 RFC6749 响应', async () => {
    issueClientCredentialsToken.mockResolvedValueOnce({
      accessToken: 'token-1',
      expiresIn: 3600,
      scope: 'mcp:read',
    });

    const response = await tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      client_secret: 'secret-1',
      scope: 'mcp:read',
      resource: 'https://res.example.com',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: 'token-1',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:read',
    });
    expect(issueClientCredentialsToken).toHaveBeenCalledWith(
      {
        clientId: 'client-1',
        clientSecret: 'secret-1',
        scope: 'mcp:read',
        resource: 'https://res.example.com',
      },
      oauthConfig,
    );
  });

  it('不支持的 grant_type 返回 400 unsupported_grant_type', async () => {
    const response = await tokenRequest({
      grant_type: 'password',
      client_id: 'client-1',
      resource: 'https://res.example.com',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unsupported_grant_type',
      error_description: '仅支持 client_credentials grant',
    });
    expect(issueClientCredentialsToken).not.toHaveBeenCalled();
  });

  it.each([
    ['缺少 client_id', { grant_type: 'client_credentials', resource: 'https://r' }],
    ['缺少 resource', { grant_type: 'client_credentials', client_id: 'client-1' }],
  ])('%s 返回 400 invalid_request', async (_name, params) => {
    const response = await tokenRequest(params as Record<string, string>);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: '缺少 client_id 或 resource',
    });
  });

  it('内置 AS 未配置时返回 503', async () => {
    configMock.getAllConfig.mockResolvedValueOnce({ system: { oauth: { mode: 'external' } } });

    const response = await tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      resource: 'https://res.example.com',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: '内置 AS 未配置',
    });
  });

  it('凭据无效映射为 401 invalid_client', async () => {
    issueClientCredentialsToken.mockRejectedValueOnce(
      new McpKnotCoreError(ErrorCode.AUTH_INVALID_CREDENTIALS, '客户端凭据无效'),
    );

    const response = await tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      client_secret: 'bad',
      resource: 'https://res.example.com',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: '客户端凭据无效',
    });
  });

  it('OAuth 配置错误同样映射为 401 invalid_client', async () => {
    issueClientCredentialsToken.mockRejectedValueOnce(
      new McpKnotCoreError(ErrorCode.OAUTH_CONFIG_ERROR, 'AS 未配置'),
    );

    const response = await tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      resource: 'https://res.example.com',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'AS 未配置',
    });
  });

  it('scope 不足映射为 400 invalid_scope', async () => {
    issueClientCredentialsToken.mockRejectedValueOnce(
      new McpKnotCoreError(ErrorCode.OAUTH_INSUFFICIENT_SCOPE, 'scope 超出注册范围'),
    );

    const response = await tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      resource: 'https://res.example.com',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_scope',
      error_description: 'scope 超出注册范围',
    });
  });

  it.each([
    ['普通 Error', new Error('内部服务异常'), '内部服务异常'],
    ['非 Error 值', 'boom', '未知错误'],
  ])('%s 映射为 503 server_error', async (_name, err, description) => {
    issueClientCredentialsToken.mockRejectedValueOnce(err);

    const response = await tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      resource: 'https://res.example.com',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: description,
    });
  });
});
