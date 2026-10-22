import { describe, expect, it } from 'vitest';

import { SystemConfigSchema } from '../schemas/system.schema.js';
import { validateWithSchema } from './config-validator.js';

describe('validateWithSchema', () => {
  it('校验成功时返回 success 与解析后的数据', () => {
    const result = validateWithSchema(SystemConfigSchema, {
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
    });

    expect(result.success).toBe(true);
    expect(result.data?.server.port).toBe(8181);
    expect(result.errors).toBeUndefined();
  });

  it('解析数据时应用 schema 默认值', () => {
    const result = validateWithSchema(SystemConfigSchema, {
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
      mrtr: {},
    });

    expect(result.data?.mrtr?.stateTtlSeconds).toBe(600);
  });

  it('校验失败时返回错误列表，不返回数据', () => {
    const result = validateWithSchema(SystemConfigSchema, {
      server: { port: 0, host: '' },
    });

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.errors).toBeDefined();
  });

  it('错误格式为「路径: 消息」且嵌套路径以点号连接', () => {
    const result = validateWithSchema(SystemConfigSchema, {
      server: { port: 8181, host: '0.0.0.0' },
      auth: {
        jwt: { secret: 'short', expiresIn: '24h', refreshExpiresIn: '7d', issuer: 'hub' },
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
    });

    expect(result.errors).toEqual([
      'auth.jwt.secret: Too small: expected string to have >=32 characters',
    ]);
  });

  it('record 键与数组路径同样按点号拼接', () => {
    const result = validateWithSchema(SystemConfigSchema, {
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
      ui: {
        title: 't',
        theme: 'light',
        features: { apiToMcp: true, debugging: false, monitoring: true },
      },
      monitoring: { metricsEnabled: true, logLevel: 'info', retentionDays: 30 },
    });

    expect(result.errors).toEqual(['users.bob.password: 密码不能为空']);
  });
});
