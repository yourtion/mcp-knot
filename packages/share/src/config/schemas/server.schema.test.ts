import { describe, it, expect } from 'vitest';

import {
  HttpServerConfigSchema,
  RetryConfigSchema,
  ServerConfigSchema,
  StdioServerConfigSchema,
} from './server.schema.js';

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

describe('RetryConfigSchema', () => {
  it('接受非负的 maxRetries 与 delay', () => {
    expect(RetryConfigSchema.parse({ maxRetries: 0, delay: 0 })).toEqual({
      maxRetries: 0,
      delay: 0,
    });
    expect(
      RetryConfigSchema.parse({ maxRetries: 3, delay: 100, exponentialBackoff: true }),
    ).toEqual({ maxRetries: 3, delay: 100, exponentialBackoff: true });
  });

  it('拒绝负数', () => {
    expect(RetryConfigSchema.safeParse({ maxRetries: -1, delay: 0 }).success).toBe(false);
    expect(RetryConfigSchema.safeParse({ maxRetries: 0, delay: -1 }).success).toBe(false);
  });
});

describe('StdioServerConfigSchema 错误消息与字段', () => {
  it('command 为空时报「命令不能为空」', () => {
    const result = StdioServerConfigSchema.safeParse({ command: '' });
    expect(result.error?.issues[0]?.message).toBe('命令不能为空');
  });

  it('timeout 必须为正数', () => {
    expect(StdioServerConfigSchema.safeParse({ command: 'x', timeout: 0 }).success).toBe(false);
  });

  it('保留 retry/env/cwd 等可选块', () => {
    const config = {
      command: 'node',
      args: ['s.js'],
      env: { A: '1' },
      cwd: '/tmp',
      retry: { maxRetries: 1, delay: 10, exponentialBackoff: false },
    };
    expect(StdioServerConfigSchema.parse(config)).toEqual(config);
  });
});

describe('HttpServerConfigSchema 错误消息', () => {
  it('url 非法时报「必须是有效的URL」', () => {
    const result = HttpServerConfigSchema.safeParse({ type: 'sse', url: 'not-a-url' });
    expect(result.error?.issues[0]?.message).toBe('必须是有效的URL');
  });

  it('type 只接受 sse/streaming', () => {
    expect(HttpServerConfigSchema.safeParse({ type: 'http', url: 'https://x.com' }).success).toBe(
      false,
    );
  });

  it('保留 headers/enabled', () => {
    const config = {
      type: 'streaming' as const,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      enabled: false,
    };
    expect(HttpServerConfigSchema.parse(config)).toEqual(config);
  });

  it('bearer token 为空时报「bearer token 不能为空」', () => {
    const result = HttpServerConfigSchema.safeParse({
      type: 'sse',
      url: 'https://example.com/mcp',
      auth: { type: 'bearer', token: '' },
    });
    expect(result.error?.issues[0]?.message).toBe('bearer token 不能为空');
  });

  it('oauth clientId/clientSecret 为空时报对应中文错误', () => {
    const clientId = HttpServerConfigSchema.safeParse({
      type: 'sse',
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', clientId: '', clientSecret: 's' },
    });
    expect(clientId.error?.issues[0]?.message).toBe('clientId 不能为空');

    const clientSecret = HttpServerConfigSchema.safeParse({
      type: 'sse',
      url: 'https://example.com/mcp',
      auth: { type: 'oauth', clientId: 'c', clientSecret: '' },
    });
    expect(clientSecret.error?.issues[0]?.message).toBe('clientSecret 不能为空');
  });
});
