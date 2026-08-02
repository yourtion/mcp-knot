import { describe, expect, it } from 'vitest';

import { SystemConfigSchema } from './system.schema.js';

describe('SystemConfigSchema oauth 字段', () => {
  const baseValid = {
    server: { port: 8181, host: '0.0.0.0' },
    auth: {
      jwt: { secret: 'a'.repeat(32), expiresIn: '24h', refreshExpiresIn: '7d', issuer: 'hub' },
      security: {
        maxLoginAttempts: 5,
        lockoutDuration: 900000,
        passwordMinLength: 6,
        requireStrongPassword: false,
      },
    },
    users: {},
    ui: {
      title: 't',
      theme: 'light',
      features: { apiToMcp: true, debugging: false, monitoring: true },
    },
    monitoring: { metricsEnabled: true, logLevel: 'info', retentionDays: 30 },
  };

  it('oauth 字段缺失时通过校验（可选）', () => {
    expect(() => SystemConfigSchema.parse(baseValid)).not.toThrow();
  });

  it('mode=internal 时 internal 配置生效', () => {
    const cfg = {
      ...baseValid,
      oauth: {
        mode: 'internal' as const,
        resource: 'https://hub.example.com',
        internal: {
          tokenTtlSeconds: 3600,
          clients: [{ clientId: 'c1', clientSecret: 'h', scopes: ['mcp:tools'] }],
        },
      },
    };
    expect(() => SystemConfigSchema.parse(cfg)).not.toThrow();
  });

  it('mode=external 时 external 配置生效', () => {
    const cfg = {
      ...baseValid,
      oauth: {
        mode: 'external' as const,
        resource: 'https://hub.example.com',
        external: {
          issuer: 'https://idp.example.com',
          clientId: 'c',
          clientSecret: 's',
          audience: 'https://hub.example.com',
        },
      },
    };
    expect(() => SystemConfigSchema.parse(cfg)).not.toThrow();
  });

  it('resource 必须是合法 URL', () => {
    const cfg = { ...baseValid, oauth: { mode: 'internal' as const, resource: 'not-a-url' } };
    expect(() => SystemConfigSchema.parse(cfg)).toThrow();
  });

  it('mode 枚举校验非法值', () => {
    const cfg = { ...baseValid, oauth: { mode: 'hybrid', resource: 'https://hub.example.com' } };
    expect(() => SystemConfigSchema.parse(cfg)).toThrow();
  });
});

describe('SystemConfigSchema P5 subscriptions/mrtr 字段', () => {
  // 复用 oauth describe 的最小合法配置（无 subscriptions/mrtr）
  const baseValid = {
    server: { port: 8181, host: '0.0.0.0' },
    auth: {
      jwt: { secret: 'a'.repeat(32), expiresIn: '24h', refreshExpiresIn: '7d', issuer: 'hub' },
      security: {
        maxLoginAttempts: 5,
        lockoutDuration: 900000,
        passwordMinLength: 6,
        requireStrongPassword: false,
      },
    },
    users: {},
    ui: {
      title: 't',
      theme: 'light',
      features: { apiToMcp: true, debugging: false, monitoring: true },
    },
    monitoring: { metricsEnabled: true, logLevel: 'info', retentionDays: 30 },
  };

  it('subscriptions/mrtr 缺失时整块可选（不报错，且解析为 undefined）', () => {
    const parsed = SystemConfigSchema.parse(baseValid);
    expect(parsed.subscriptions).toBeUndefined();
    expect(parsed.mrtr).toBeUndefined();
  });

  it('subscriptions 块提供时内部字段应用默认值', () => {
    const parsed = SystemConfigSchema.parse({ ...baseValid, subscriptions: {} });
    expect(parsed.subscriptions).toBeDefined();
    expect(parsed.subscriptions?.enabled).toBe(true);
    expect(parsed.subscriptions?.pollIntervalMs).toBe(60_000);
    expect(parsed.subscriptions?.pollBackoffMs).toBe(300_000);
    expect(parsed.subscriptions?.fanoutDebounceMs).toBe(500);
  });

  it('mrtr 块提供时应用默认值，stateKey 可选（默认 undefined → 运行时随机生成）', () => {
    const parsed = SystemConfigSchema.parse({ ...baseValid, mrtr: {} });
    expect(parsed.mrtr).toBeDefined();
    expect(parsed.mrtr?.enabled).toBe(true);
    expect(parsed.mrtr?.stateTtlSeconds).toBe(600);
    expect(parsed.mrtr?.stateKey).toBeUndefined();
  });

  it('subscriptions/mrtr 字段可被显式覆盖', () => {
    const parsed = SystemConfigSchema.parse({
      ...baseValid,
      subscriptions: {
        enabled: false,
        pollIntervalMs: 15_000,
        pollBackoffMs: 60_000,
        fanoutDebounceMs: 0,
      },
      mrtr: {
        enabled: false,
        stateTtlSeconds: 120,
        stateKey: 'ab'.repeat(32), // hex 编码 32 字节
      },
    });
    expect(parsed.subscriptions?.enabled).toBe(false);
    expect(parsed.subscriptions?.pollIntervalMs).toBe(15_000);
    expect(parsed.subscriptions?.fanoutDebounceMs).toBe(0);
    expect(parsed.mrtr?.enabled).toBe(false);
    expect(parsed.mrtr?.stateTtlSeconds).toBe(120);
    expect(parsed.mrtr?.stateKey).toBe('ab'.repeat(32));
  });

  it('pollIntervalMs/pollBackoffMs/stateTtlSeconds 必须为正整数', () => {
    expect(() =>
      SystemConfigSchema.parse({ ...baseValid, subscriptions: { pollIntervalMs: 0 } }),
    ).toThrow();
    expect(() =>
      SystemConfigSchema.parse({ ...baseValid, subscriptions: { pollBackoffMs: -1 } }),
    ).toThrow();
    expect(() =>
      SystemConfigSchema.parse({ ...baseValid, mrtr: { stateTtlSeconds: 0 } }),
    ).toThrow();
  });
});
