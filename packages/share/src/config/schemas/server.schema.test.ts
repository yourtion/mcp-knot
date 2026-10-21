import { describe, it, expect } from 'vitest';

import { ServerConfigSchema } from './server.schema.js';

describe('ServerConfigSchema', () => {
  it.each([
    { command: 'npx', args: ['-y', 'test-mcp'] },
    { type: 'stdio', command: 'node', enabled: false },
    { type: 'sse', url: 'https://example.com/mcp' },
    { type: 'streaming', url: 'https://example.com/mcp' },
  ])('保留合法服务器配置 %j', (config) => {
    expect(ServerConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    { type: 'stdio' },
    { type: 'stdio', command: '' },
    { type: 'sse', url: 'not-a-url' },
    { type: 'streaming' },
    { type: 'unknown', command: 'node' },
  ])('拒绝非法服务器配置 %j', (config) => {
    expect(ServerConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('HttpServerConfigSchema auth 字段', () => {
  it('bearer auth 合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: { type: 'bearer', token: 'abc123' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('oauth auth 合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: {
        type: 'oauth',
        clientId: 'my-client',
        clientSecret: '${MY_SECRET}',
        scope: 'read',
      },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('oauth 缺 clientId 不合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', clientSecret: 'x' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('oauth 缺 clientSecret 不合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', clientId: 'x' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('oauth 空 clientId 不合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', clientId: '', clientSecret: 'x' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('bearer 缺 token 不合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: { type: 'bearer' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('bearer 空 token 不合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: { type: 'bearer', token: '' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('auth.type 非法值不合法', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: { type: 'basic', user: 'u', pass: 'p' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('无 auth 仍合法（向后兼容）', () => {
    const config = { type: 'streaming', url: 'https://example.com/mcp' };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('oauth 可选字段省略仍合法', () => {
    const config = {
      type: 'sse',
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', clientId: 'c', clientSecret: 's' },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('auth 解析后保留 clientName/scope', () => {
    const config = {
      type: 'streaming',
      url: 'https://example.com/mcp',
      auth: {
        type: 'oauth',
        clientId: 'c',
        clientSecret: 's',
        scope: 'read write',
        clientName: 'my-app',
      },
    };
    const result = ServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auth).toMatchObject({
        type: 'oauth',
        clientId: 'c',
        clientSecret: 's',
        scope: 'read write',
        clientName: 'my-app',
      });
    }
  });

  it('stdio 配置会移除不支持的 HTTP 认证字段', () => {
    const config = {
      type: 'stdio',
      command: 'echo',
      auth: { type: 'bearer', token: 'x' },
    };
    expect(ServerConfigSchema.parse(config)).toEqual({ type: 'stdio', command: 'echo' });
  });
});
