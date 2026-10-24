import { describe, expect, it } from 'vitest';

import { validateAllConfigs, validateCrossReferences } from './cross-reference.js';

describe('validateCrossReferences', () => {
  it('组引用的服务器都存在时校验通过且无警告', () => {
    const result = validateCrossReferences(
      { srv1: { command: 'node' }, srv2: { command: 'node' } },
      {
        g1: { id: 'g1', name: 'G1', servers: ['srv1', 'srv2'], tools: [] },
      },
    );

    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('组引用未定义的服务器时报错并校验失败', () => {
    const result = validateCrossReferences(
      { srv1: {} },
      { g1: { id: 'g1', name: 'G1', servers: ['srv1', 'missing'], tools: [] } },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['组 "g1" 引用了未在MCP配置中定义的服务器 "missing"']);
    expect(result.warnings).toEqual([]);
  });

  it('多个组引用同一缺失服务器时逐条报错', () => {
    const result = validateCrossReferences(
      {},
      {
        g1: { id: 'g1', name: 'G1', servers: ['ghost'], tools: [] },
        g2: { id: 'g2', name: 'G2', servers: ['ghost'], tools: [] },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[1]).toBe('组 "g2" 引用了未在MCP配置中定义的服务器 "ghost"');
  });

  it('未被任何组使用的服务器产生警告但不影响校验结果', () => {
    const result = validateCrossReferences(
      { used: {}, idle1: {}, idle2: {} },
      { g1: { id: 'g1', name: 'G1', servers: ['used'], tools: [] } },
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['以下服务器未被任何组使用: idle1、 idle2']);
  });

  it('空组配置时所有服务器都视为未使用', () => {
    const result = validateCrossReferences({ only: {} }, {});

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(['以下服务器未被任何组使用: only']);
  });

  it('同时存在缺失引用与未使用服务器时错误与警告并存', () => {
    const result = validateCrossReferences(
      { idle: {} },
      { g1: { id: 'g1', name: 'G1', servers: ['ghost'], tools: [] } },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.warnings).toEqual(['以下服务器未被任何组使用: idle']);
  });

  it('被任意组引用过的服务器不算未使用', () => {
    const result = validateCrossReferences(
      { a: {}, b: {} },
      { g1: { id: 'g1', name: 'G1', servers: ['b'], tools: [] } },
    );

    expect(result.warnings).toEqual(['以下服务器未被任何组使用: a']);
  });
});

describe('validateAllConfigs', () => {
  const validMcp = { servers: { srv1: { type: 'stdio', command: 'node' } } };
  const validGroups = {
    g1: { id: 'g1', name: 'G1', servers: ['srv1'], tools: [] },
  };
  const validSystem = {
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

  it('全部配置合法时返回成功且携带解析后的数据', () => {
    const result = validateAllConfigs(validMcp, validGroups, validSystem);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpConfig.servers.srv1).toEqual({ type: 'stdio', command: 'node' });
      expect(result.data.groupConfig.g1?.name).toBe('G1');
      expect(result.data.systemConfig?.server.port).toBe(8181);
    }
  });

  it('systemConfig 可选，省略时成功且 systemConfig 为 undefined', () => {
    const result = validateAllConfigs(validMcp, validGroups);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemConfig).toBeUndefined();
    }
  });

  it('MCP 配置非法时报错并带上「MCP配置错误」前缀', () => {
    const result = validateAllConfigs({ servers: {} }, validGroups);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual(['MCP配置错误: servers: 至少需要配置一个MCP服务器']);
    }
  });

  it('MCP 配置非法时立即返回，不继续校验组配置', () => {
    const result = validateAllConfigs({ servers: {} }, {
      g1: { id: 'g1', servers: [], tools: [] }, // 缺 name，也是非法的
    } as never);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.every((e) => e.startsWith('MCP配置错误: '))).toBe(true);
    }
  });

  it('MCP 服务器条目非法时报具体条目路径', () => {
    const result = validateAllConfigs({ servers: { srv1: { type: 'stdio' } } }, validGroups);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].startsWith('MCP配置错误: servers.srv1')).toBe(true);
    }
  });

  it('组配置非法时报错并带上「组配置错误」前缀', () => {
    const result = validateAllConfigs(validMcp, {
      g1: { id: 'g1', name: '', servers: ['srv1'], tools: [] },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual(['组配置错误: g1.name: 组名称不能为空']);
    }
  });

  it('交叉引用失败时报错并带上「交叉引用错误」前缀', () => {
    const result = validateAllConfigs(validMcp, {
      g1: { id: 'g1', name: 'G1', servers: ['ghost'], tools: [] },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([
        '交叉引用错误: 组 "g1" 引用了未在MCP配置中定义的服务器 "ghost"',
      ]);
    }
  });

  it('系统配置非法时报错并带上「系统配置错误」前缀', () => {
    const result = validateAllConfigs(validMcp, validGroups, {
      ...validSystem,
      server: { ...validSystem.server, port: 0 },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].startsWith('系统配置错误: ')).toBe(true);
      expect(result.errors[0]).toContain('server.port');
    }
  });
});
