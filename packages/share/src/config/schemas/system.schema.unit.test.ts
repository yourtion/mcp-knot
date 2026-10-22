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

describe('SystemConfigSchema 数值边界与必填字段', () => {
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

  const expectRejected = (mutate: (cfg: typeof baseValid) => unknown) => {
    const cfg = JSON.parse(JSON.stringify(baseValid)) as typeof baseValid;
    expect(SystemConfigSchema.safeParse(mutate(cfg)).success).toBe(false);
  };

  it('jwt.secret 至少 32 个字符', () => {
    expectRejected((cfg) => {
      cfg.auth.jwt.secret = 'a'.repeat(31);
      return cfg;
    });
    expect(
      SystemConfigSchema.parse({
        ...baseValid,
        auth: { ...baseValid.auth, jwt: { ...baseValid.auth.jwt, secret: 'a'.repeat(33) } },
      }),
    ).toBeTruthy();
  });

  it('server.port 边界：1 与 65535 合法，0 与 65536 非法', () => {
    for (const port of [1, 65535]) {
      expect(
        SystemConfigSchema.parse({ ...baseValid, server: { ...baseValid.server, port } }).server
          .port,
      ).toBe(port);
    }
    expectRejected((cfg) => {
      cfg.server.port = 0;
      return cfg;
    });
    expectRejected((cfg) => {
      cfg.server.port = 65536;
      return cfg;
    });
  });

  it('server.host 不能为空', () => {
    expectRejected((cfg) => {
      cfg.server.host = '';
      return cfg;
    });
  });

  it('security 数值边界', () => {
    expectRejected((cfg) => {
      cfg.auth.security.maxLoginAttempts = 0;
      return cfg;
    });
    // lockoutDuration 允许 0，拒绝负数
    expect(
      SystemConfigSchema.parse({
        ...baseValid,
        auth: { ...baseValid.auth, security: { ...baseValid.auth.security, lockoutDuration: 0 } },
      }).auth.security.lockoutDuration,
    ).toBe(0);
    expectRejected((cfg) => {
      cfg.auth.security.lockoutDuration = -1;
      return cfg;
    });
    // passwordMinLength 最小为 4
    expectRejected((cfg) => {
      cfg.auth.security.passwordMinLength = 3;
      return cfg;
    });
    expect(
      SystemConfigSchema.parse({
        ...baseValid,
        auth: { ...baseValid.auth, security: { ...baseValid.auth.security, passwordMinLength: 4 } },
      }).auth.security.passwordMinLength,
    ).toBe(4);
  });

  it('monitoring.retentionDays 至少为 1', () => {
    expectRejected((cfg) => {
      cfg.monitoring.retentionDays = 0;
      return cfg;
    });
  });

  it('用户密码为空时报「密码不能为空」', () => {
    const result = SystemConfigSchema.safeParse({
      ...baseValid,
      users: {
        bob: {
          id: '1',
          username: 'bob',
          password: '',
          role: 'admin',
          groups: [],
          createdAt: '2024-01-01T00:00:00Z',
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['users', 'bob', 'password']);
    expect(result.error?.issues[0]?.message).toBe('密码不能为空');
  });

  it('解析结果保留 users/ui/monitoring 的原始值', () => {
    const users = {
      bob: {
        id: '1',
        username: 'bob',
        password: 'secret',
        role: 'admin',
        groups: ['g1'],
        createdAt: '2024-01-01T00:00:00Z',
      },
    };
    const parsed = SystemConfigSchema.parse({ ...baseValid, users });
    expect(parsed.users).toEqual(users);
    expect(parsed.ui.theme).toBe('light');
    expect(parsed.monitoring.metricsEnabled).toBe(true);
  });
});

describe('SystemConfigSchema oauth 默认值与外部 IdP 校验', () => {
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

  it('oauth.scopes 默认为 mcp:tools 与 mcp:resources', () => {
    const parsed = SystemConfigSchema.parse({
      ...baseValid,
      oauth: { mode: 'internal', resource: 'https://hub.example.com' },
    });
    expect(parsed.oauth?.scopes).toEqual(['mcp:tools', 'mcp:resources']);
  });

  it('oauth.internal 应用默认值：tokenTtlSeconds=3600、clients=[]', () => {
    const parsed = SystemConfigSchema.parse({
      ...baseValid,
      oauth: {
        mode: 'internal',
        resource: 'https://hub.example.com',
        internal: {},
      },
    });
    expect(parsed.oauth?.internal?.tokenTtlSeconds).toBe(3600);
    expect(parsed.oauth?.internal?.clients).toEqual([]);
  });

  it('oauth.internal 显式值保留且 clients 的 scopes 有默认值', () => {
    const parsed = SystemConfigSchema.parse({
      ...baseValid,
      oauth: {
        mode: 'both',
        resource: 'https://hub.example.com',
        internal: {
          tokenTtlSeconds: 120,
          clients: [{ clientId: 'c1', clientSecret: 'hash' }],
        },
      },
    });
    expect(parsed.oauth?.mode).toBe('both');
    expect(parsed.oauth?.internal?.tokenTtlSeconds).toBe(120);
    expect(parsed.oauth?.internal?.clients).toEqual([
      { clientId: 'c1', clientSecret: 'hash', scopes: ['mcp:tools'] },
    ]);
  });

  it('oauth.external 必填字段：issuer/clientId/clientSecret/audience', () => {
    const external = {
      issuer: 'https://idp.example.com',
      clientId: 'c',
      clientSecret: 's',
      audience: 'https://hub.example.com',
    };
    const parsed = SystemConfigSchema.parse({
      ...baseValid,
      oauth: { mode: 'external', resource: 'https://hub.example.com', external },
    });
    expect(parsed.oauth?.external).toEqual(external);

    for (const field of ['clientId', 'clientSecret', 'audience'] as const) {
      const bad = { ...external, [field]: '' };
      expect(
        SystemConfigSchema.safeParse({
          ...baseValid,
          oauth: { mode: 'external', resource: 'https://hub.example.com', external: bad },
        }).success,
      ).toBe(false);
    }
    expect(
      SystemConfigSchema.safeParse({
        ...baseValid,
        oauth: {
          mode: 'external',
          resource: 'https://hub.example.com',
          external: { ...external, issuer: 'not-a-url' },
        },
      }).success,
    ).toBe(false);
  });
});
