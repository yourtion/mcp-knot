import { describe, expect, it } from 'vitest';

import {
  ApiEndpointConfigSchema,
  ApiToolConfigSchema,
  ApiToolsConfigSchema,
  AuthConfigSchema,
  CacheConfigSchema,
  HttpMethodSchema,
  JsonSchemaSchema,
  RateLimitConfigSchema,
  ResponseConfigSchema,
  SecurityConfigSchema,
} from './api-tools.schema.js';

describe('HttpMethodSchema', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])('接受方法 %s', (method) => {
    expect(HttpMethodSchema.parse(method)).toBe(method);
  });

  it('拒绝未知方法', () => {
    const result = HttpMethodSchema.safeParse('FETCH');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('GET');
  });
});

describe('AuthConfigSchema', () => {
  it('接受三种认证类型并原样保留', () => {
    expect(AuthConfigSchema.parse({ type: 'bearer', token: 't' })).toEqual({
      type: 'bearer',
      token: 't',
    });
    expect(AuthConfigSchema.parse({ type: 'apikey', header: 'X-Key' })).toEqual({
      type: 'apikey',
      header: 'X-Key',
    });
    expect(AuthConfigSchema.parse({ type: 'basic', username: 'u', password: 'p' })).toEqual({
      type: 'basic',
      username: 'u',
      password: 'p',
    });
  });

  it('type 为必填且只接受枚举值', () => {
    expect(AuthConfigSchema.safeParse({}).success).toBe(false);
    expect(AuthConfigSchema.safeParse({ type: 'digest' }).success).toBe(false);
  });
});

describe('RateLimitConfigSchema', () => {
  it('接受正数配置', () => {
    expect(
      RateLimitConfigSchema.parse({ windowSeconds: 60, maxRequests: 100, enabled: true }),
    ).toEqual({ windowSeconds: 60, maxRequests: 100, enabled: true });
  });

  it.each([
    { windowSeconds: 0, maxRequests: 10, enabled: true },
    { windowSeconds: 60, maxRequests: 0, enabled: true },
    { windowSeconds: -1, maxRequests: 10, enabled: false },
  ])('拒绝非正数 %j', (config) => {
    expect(RateLimitConfigSchema.safeParse(config).success).toBe(false);
  });

  it('enabled 必须是布尔值', () => {
    expect(
      RateLimitConfigSchema.safeParse({ windowSeconds: 1, maxRequests: 1, enabled: 1 }).success,
    ).toBe(false);
  });
});

describe('SecurityConfigSchema', () => {
  it('三个子配置都可选，也可同时提供', () => {
    expect(SecurityConfigSchema.parse({})).toEqual({});
    const full = {
      authentication: { type: 'bearer' as const, token: 't' },
      allowedDomains: ['https://a.com'],
      rateLimiting: { windowSeconds: 1, maxRequests: 2, enabled: false },
    };
    expect(SecurityConfigSchema.parse(full)).toEqual(full);
  });
});

describe('CacheConfigSchema', () => {
  it('ttl 必须为正数，maxSize 可选', () => {
    expect(CacheConfigSchema.parse({ enabled: true, ttl: 30 })).toEqual({ enabled: true, ttl: 30 });
    expect(CacheConfigSchema.safeParse({ enabled: true, ttl: 0 }).success).toBe(false);
    expect(CacheConfigSchema.safeParse({ enabled: true, ttl: -5 }).success).toBe(false);
    expect(CacheConfigSchema.safeParse({ enabled: true, ttl: 1, maxSize: 0 }).success).toBe(false);
  });
});

describe('ResponseConfigSchema', () => {
  it('所有字段可选且原样保留', () => {
    const full = { jsonata: '$', errorPath: 'error', successCondition: 'ok' };
    expect(ResponseConfigSchema.parse({})).toEqual({});
    expect(ResponseConfigSchema.parse(full)).toEqual(full);
  });
});

describe('ApiEndpointConfigSchema', () => {
  const valid = { url: 'https://api.example.com/v1', method: 'GET' };

  it('接受最小配置并保留', () => {
    expect(ApiEndpointConfigSchema.parse(valid)).toEqual(valid);
  });

  it('url 必须是合法 URL', () => {
    const result = ApiEndpointConfigSchema.safeParse({ ...valid, url: 'not-a-url' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Invalid URL');
  });

  it('headers/queryParams 的键值都必须是字符串', () => {
    expect(
      ApiEndpointConfigSchema.parse({ ...valid, headers: { 'X-A': '1' }, queryParams: { q: 'v' } }),
    ).toEqual({ ...valid, headers: { 'X-A': '1' }, queryParams: { q: 'v' } });
    expect(ApiEndpointConfigSchema.safeParse({ ...valid, queryParams: { q: 1 } }).success).toBe(
      false,
    );
  });

  it('body 接受字符串或对象', () => {
    expect(ApiEndpointConfigSchema.parse({ ...valid, body: 'raw' }).body).toBe('raw');
    expect(ApiEndpointConfigSchema.parse({ ...valid, body: { k: 'v' } }).body).toEqual({ k: 'v' });
    expect(ApiEndpointConfigSchema.safeParse({ ...valid, body: 1 }).success).toBe(false);
  });

  it('timeout 必须为正数，retries 必须为非负数', () => {
    expect(ApiEndpointConfigSchema.safeParse({ ...valid, timeout: 0 }).success).toBe(false);
    expect(ApiEndpointConfigSchema.safeParse({ ...valid, retries: -1 }).success).toBe(false);
    expect(ApiEndpointConfigSchema.parse({ ...valid, retries: 0 }).retries).toBe(0);
  });
});

describe('JsonSchemaSchema', () => {
  it('type 必须是字面量 object', () => {
    expect(JsonSchemaSchema.safeParse({ type: 'string', properties: {} }).success).toBe(false);
    expect(JsonSchemaSchema.safeParse({ properties: {} }).success).toBe(false);
  });

  it('支持递归的属性定义', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        q: {
          type: 'string' as const,
          minLength: 1,
          maxLength: 10,
          pattern: '^a',
          description: 'query',
          default: 'abc',
          enum: ['abc'],
          format: 'text',
        },
        nested: {
          type: 'object' as const,
          properties: {
            inner: { type: 'number' as const, minimum: 0, maximum: 10 },
            list: {
              type: 'array' as const,
              minItems: 1,
              maxItems: 5,
              items: { type: 'boolean' as const },
            },
          },
          required: ['inner'],
          additionalProperties: false,
        },
        nil: { type: 'null' as const },
      },
      additionalProperties: true,
    };
    expect(JsonSchemaSchema.parse(schema)).toEqual(schema);
  });

  it('拒绝非法的属性类型与数值约束', () => {
    expect(
      JsonSchemaSchema.safeParse({
        type: 'object',
        properties: { q: { type: 'integer' } },
      }).success,
    ).toBe(false);
    expect(
      JsonSchemaSchema.safeParse({
        type: 'object',
        properties: { q: { type: 'string', minLength: 'x' } },
      }).success,
    ).toBe(false);
  });
});

describe('ApiToolConfigSchema', () => {
  const valid = {
    id: 'weather',
    name: 'Weather',
    description: '查询天气',
    api: { url: 'https://api.example.com/weather', method: 'GET' },
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    response: {},
  };

  it('接受完整配置并保留 security/cache 可选块', () => {
    const full = {
      ...valid,
      security: { authentication: { type: 'bearer', token: 't' } },
      cache: { enabled: true, ttl: 60 },
    };
    expect(ApiToolConfigSchema.parse(full)).toEqual(full);
  });

  it.each(['id', 'name', 'description'] as const)('%s 不能为空字符串', (field) => {
    expect(ApiToolConfigSchema.safeParse({ ...valid, [field]: '' }).success).toBe(false);
  });

  it('api 与 parameters 为必填', () => {
    const { api: _api, ...withoutApi } = valid;
    expect(ApiToolConfigSchema.safeParse(withoutApi).success).toBe(false);
    const { parameters: _params, ...withoutParams } = valid;
    expect(ApiToolConfigSchema.safeParse(withoutParams).success).toBe(false);
  });
});

describe('ApiToolsConfigSchema', () => {
  it('顶层需要 version 与 tools 数组', () => {
    const config = {
      version: '1.0.0',
      tools: [
        {
          id: 't1',
          name: 'T1',
          description: 'd',
          api: { url: 'https://api.example.com', method: 'POST' },
          parameters: { type: 'object', properties: {} },
          response: {},
        },
      ],
    };
    expect(ApiToolsConfigSchema.parse(config)).toEqual(config);
    expect(ApiToolsConfigSchema.safeParse({ version: '1.0.0' }).success).toBe(false);
    expect(ApiToolsConfigSchema.safeParse({ tools: [] }).success).toBe(false);
    expect(ApiToolsConfigSchema.parse({ version: '1.0.0', tools: [] }).tools).toEqual([]);
  });
});
