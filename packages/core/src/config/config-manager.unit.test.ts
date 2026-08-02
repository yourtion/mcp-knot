import { defaultCompatibilityOptions } from '@mcp-core/mcp-knot-share/config';
import { describe, expect, it } from 'vitest';

import { ConfigManager } from './config-manager.js';

import type { SystemConfig } from '@mcp-core/mcp-knot-share/config';

const baseSystem = {
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
} as unknown as SystemConfig;

describe('ConfigManager.getCompatibility', () => {
  const manager = new ConfigManager('/nonexistent-config-dir');

  it('system 缺失 compatibility 时兜底为默认全开', () => {
    const compat = manager.getCompatibility(baseSystem);
    expect(compat).toEqual(defaultCompatibilityOptions);
    expect(compat.inbound.enabled).toBe(true);
    expect(compat.outbound.modernOnly).toBe(false);
    expect(compat.errors.unified).toBe(true);
  });

  it('system 未传（undefined）时也兜底为默认全开', () => {
    const compat = manager.getCompatibility();
    expect(compat).toEqual(defaultCompatibilityOptions);
  });

  it('system 提供 compatibility 部分覆盖时保留其余字段默认值', () => {
    const system = {
      ...baseSystem,
      compatibility: { inbound: { enabled: false } },
    } as SystemConfig;
    const compat = manager.getCompatibility(system);
    expect(compat.inbound.enabled).toBe(false);
    expect(compat.outbound.enabled).toBe(true); // 未覆盖保留默认
    expect(compat.errors.unified).toBe(true);
  });

  it('system 提供完整 compatibility 时原样（解析）返回', () => {
    const system = {
      ...baseSystem,
      compatibility: {
        inbound: { enabled: false, legacyMode: 'reject' },
        outbound: { enabled: false, modernOnly: true, mrtrLegacyDegradation: 'reject' },
        errors: { unified: false },
      },
    } as SystemConfig;
    const compat = manager.getCompatibility(system);
    expect(compat.inbound.enabled).toBe(false);
    expect(compat.inbound.legacyMode).toBe('reject');
    expect(compat.outbound.modernOnly).toBe(true);
    expect(compat.errors.unified).toBe(false);
  });
});
