import { describe, expect, it } from 'vitest';

import {
  AuthConfigSchema,
  CacheConfigSchema,
  HttpMethodSchema,
  JsonSchemaSchema,
  RateLimitConfigSchema,
  SecurityConfigSchema,
} from './api-config.js';

describe('HttpMethodSchema', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])('%s 应为合法方法', (m) => {
    expect(HttpMethodSchema.safeParse(m).success).toBe(true);
  });

  it('小写与非标准方法应被拒绝', () => {
    expect(HttpMethodSchema.safeParse('get').success).toBe(false);
    expect(HttpMethodSchema.safeParse('TRACE').success).toBe(false);
    expect(HttpMethodSchema.safeParse('').success).toBe(false);
  });
});

describe('OAuthAuthConfigSchema grantType', () => {
  it('refresh_token 应为合法 grantType', () => {
    const result = AuthConfigSchema.safeParse({
      type: 'oauth',
      grantType: 'refresh_token',
      clientId: 'cid',
      clientSecret: 'secret',
      tokenUrl: 'https://as.example.com/token',
      refreshToken: 'rt',
    });
    expect(result.success).toBe(true);
  });
});

describe('RateLimitConfigSchema', () => {
  it('空对象应被拒绝（字段必填）', () => {
    expect(RateLimitConfigSchema.safeParse({}).success).toBe(false);
  });

  it('合法限流配置应通过', () => {
    expect(
      RateLimitConfigSchema.safeParse({ windowSeconds: 60, maxRequests: 10, enabled: true })
        .success,
    ).toBe(true);
  });
});

describe('SecurityConfigSchema', () => {
  it('非法 authentication 配置应被拒绝', () => {
    expect(SecurityConfigSchema.safeParse({ authentication: { type: 'unknown' } }).success).toBe(
      false,
    );
  });
});

describe('CacheConfigSchema', () => {
  it('空对象应被拒绝（enabled/ttl 必填）', () => {
    expect(CacheConfigSchema.safeParse({}).success).toBe(false);
  });

  it('合法缓存配置应通过', () => {
    expect(CacheConfigSchema.safeParse({ enabled: true, ttl: 300 }).success).toBe(true);
  });
});

describe('JsonSchemaSchema 属性类型枚举', () => {
  it.each(['boolean', 'object', 'array', 'null'] as const)('属性 type %s 应为合法类型', (t) => {
    const result = JsonSchemaSchema.safeParse({
      type: 'object',
      properties: { p: { type: t } },
    });
    expect(result.success).toBe(true);
  });

  it('非法属性 type 应被拒绝', () => {
    const result = JsonSchemaSchema.safeParse({
      type: 'object',
      properties: { p: { type: 'integer' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('AuthConfigSchema（discriminated union）', () => {
  it('接受有效的 bearer 配置', () => {
    const result = AuthConfigSchema.safeParse({ type: 'bearer', token: 'xxx' });
    expect(result.success).toBe(true);
  });

  it('接受有效的 apikey 配置', () => {
    const result = AuthConfigSchema.safeParse({ type: 'apikey', token: 'xxx', header: 'X-Key' });
    expect(result.success).toBe(true);
  });

  it('接受有效的 basic 配置', () => {
    const result = AuthConfigSchema.safeParse({ type: 'basic', username: 'u', password: 'p' });
    expect(result.success).toBe(true);
  });

  it('接受有效的 oauth client_credentials 配置', () => {
    const result = AuthConfigSchema.safeParse({
      type: 'oauth',
      grantType: 'client_credentials',
      clientId: 'cid',
      clientSecret: 'secret',
      tokenUrl: 'https://as.example.com/token',
      scope: 'read',
    });
    expect(result.success).toBe(true);
  });

  it('oauth 缺 clientId 被拒', () => {
    const result = AuthConfigSchema.safeParse({
      type: 'oauth',
      grantType: 'client_credentials',
      clientSecret: 'secret',
      tokenUrl: 'https://as.example.com/token',
    });
    expect(result.success).toBe(false);
  });

  it('oauth tokenUrl 非 URL 被拒', () => {
    const result = AuthConfigSchema.safeParse({
      type: 'oauth',
      grantType: 'client_credentials',
      clientId: 'cid',
      clientSecret: 'secret',
      tokenUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('oauth 非法 grantType 被拒', () => {
    const result = AuthConfigSchema.safeParse({
      type: 'oauth',
      grantType: 'password',
      clientId: 'cid',
      clientSecret: 'secret',
      tokenUrl: 'https://as.example.com/token',
    });
    expect(result.success).toBe(false);
  });

  it('未知 type 被拒', () => {
    const result = AuthConfigSchema.safeParse({ type: 'unknown', token: 'x' });
    expect(result.success).toBe(false);
  });
});
