import { describe, expect, it } from 'vitest';

import { CompatibilityOptionsSchema, defaultCompatibilityOptions } from './compatibility.schema.js';
import { SystemConfigSchema } from './system.schema.js';

const baseValidSystem = {
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

describe('CompatibilityOptionsSchema', () => {
  it('空对象解析为「默认全开」', () => {
    expect(CompatibilityOptionsSchema.parse({})).toEqual({
      inbound: { enabled: true, legacyMode: 'shim' },
      outbound: { enabled: true, modernOnly: false, mrtrLegacyDegradation: 'shim' },
      errors: { unified: true },
    });
  });

  it('默认实例与 parse({}) 深相等', () => {
    expect(defaultCompatibilityOptions).toEqual(CompatibilityOptionsSchema.parse({}));
  });

  it('部分覆盖保留其余字段默认值', () => {
    const r = CompatibilityOptionsSchema.parse({ outbound: { modernOnly: true } });
    expect(r.outbound.modernOnly).toBe(true);
    expect(r.inbound.enabled).toBe(true); // 未覆盖段保留默认
    expect(r.errors.unified).toBe(true);
  });

  it('legacyMode 只接受 reject | shim', () => {
    expect(() => CompatibilityOptionsSchema.parse({ inbound: { legacyMode: 'bridge' } })).toThrow();
  });

  it('mrtrLegacyDegradation 只接受 shim | reject', () => {
    expect(() =>
      CompatibilityOptionsSchema.parse({ outbound: { mrtrLegacyDegradation: 'force' } }),
    ).toThrow();
  });
});

describe('SystemConfigSchema P7 compatibility 字段', () => {
  it('compatibility 缺失时 prefault 兜底为默认全开', () => {
    const parsed = SystemConfigSchema.parse(baseValidSystem);
    expect(parsed.compatibility).toEqual(defaultCompatibilityOptions);
  });

  it('compatibility 提供空对象时 prefault 回填字段默认值（默认全开）', () => {
    const parsed = SystemConfigSchema.parse({ ...baseValidSystem, compatibility: {} });
    expect(parsed.compatibility).toEqual(defaultCompatibilityOptions);
  });

  it('compatibility 可被显式覆盖且未覆盖段保留默认', () => {
    const parsed = SystemConfigSchema.parse({
      ...baseValidSystem,
      compatibility: { inbound: { enabled: false } },
    });
    expect(parsed.compatibility?.inbound.enabled).toBe(false);
    expect(parsed.compatibility?.outbound.enabled).toBe(true); // 未覆盖段保留默认
    expect(parsed.compatibility?.errors.unified).toBe(true);
  });
});
