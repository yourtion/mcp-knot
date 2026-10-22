import { defaultCompatibilityOptions } from '@mcp-core/mcp-knot-share/config';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigManager } from './config-manager.js';

import type { McpConfig, SystemConfig } from '@mcp-core/mcp-knot-share/config';

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

// ========================================
// 以下为配置加载/保存/校验的补充测试
// ========================================

/** 合法的 MCP 配置（至少一个服务器） */
const validMcpConfig = {
  servers: {
    fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
  },
} as unknown as McpConfig;

/** 合法的组配置 */
const validGroupConfig = {
  default: {
    id: 'default',
    name: '默认组',
    servers: ['fetch'],
    tools: [],
  },
};

describe('ConfigManager 构造函数', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mcp-config-test-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('CONFIG_PATH 环境变量生效', async () => {
    await writeFile(join(configDir, 'mcp_server.json'), JSON.stringify(validMcpConfig));
    vi.stubEnv('CONFIG_PATH', configDir);

    const manager = new ConfigManager();
    const config = await manager.loadMcpConfig();

    expect(config).toEqual(validMcpConfig);
  });

  it('显式 configDir 优先于 CONFIG_PATH 环境变量', async () => {
    const dirA = join(configDir, 'a');
    const dirB = join(configDir, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, 'mcp_server.json'), JSON.stringify({ servers: { from: 'A' } }));
    // dirB 不存在 mcp_server.json，若被错误使用会返回默认值
    vi.stubEnv('CONFIG_PATH', dirB);

    const manager = new ConfigManager(dirA);
    const config = await manager.loadMcpConfig();

    expect(config).toEqual({ servers: { from: 'A' } });
  });

  it('无参数且无 CONFIG_PATH 时回退到 cwd/config 并正常返回默认值', async () => {
    delete process.env.CONFIG_PATH;

    const manager = new ConfigManager();
    const all = await manager.loadAll();

    expect(all).toHaveProperty('mcps');
    expect(all).toHaveProperty('groups');
    expect(all).toHaveProperty('system');
  });
});

describe('ConfigManager 配置加载', () => {
  let configDir: string;
  let manager: ConfigManager;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mcp-config-test-'));
    manager = new ConfigManager(configDir);
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('文件不存在时 loadMcpConfig 返回 {servers:{}}', async () => {
    const config = await manager.loadMcpConfig();

    expect(config).toEqual({ servers: {} });
  });

  it('文件不存在时 loadGroupConfig/loadSystemConfig 返回空对象', async () => {
    await expect(manager.loadGroupConfig()).resolves.toEqual({});
    await expect(manager.loadSystemConfig()).resolves.toEqual({});
  });

  it('JSON 解析失败时返回默认值', async () => {
    await writeFile(join(configDir, 'mcp_server.json'), 'this is not json {');

    const config = await manager.loadMcpConfig();

    expect(config).toEqual({ servers: {} });
  });

  it('loadMcpConfig 读取并解析文件内容', async () => {
    await writeFile(join(configDir, 'mcp_server.json'), JSON.stringify(validMcpConfig));

    const config = await manager.loadMcpConfig();

    expect(config).toEqual(validMcpConfig);
  });

  it('loadAll 同时加载三份配置', async () => {
    await writeFile(join(configDir, 'mcp_server.json'), JSON.stringify(validMcpConfig));
    await writeFile(join(configDir, 'group.json'), JSON.stringify(validGroupConfig));
    await writeFile(join(configDir, 'system.json'), JSON.stringify(baseSystem));

    const all = await manager.loadAll();

    expect(all.mcps).toEqual(validMcpConfig);
    expect(all.groups).toEqual(validGroupConfig);
    expect(all.system).toEqual(baseSystem);
  });
});

describe('ConfigManager 配置保存', () => {
  let configDir: string;
  let manager: ConfigManager;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'mcp-config-test-'));
    manager = new ConfigManager(configDir);
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('saveMcpConfig 以两空格缩进写入 mcp_server.json', async () => {
    await manager.saveMcpConfig(validMcpConfig);

    const content = await readFile(join(configDir, 'mcp_server.json'), 'utf-8');

    expect(content).toBe(JSON.stringify(validMcpConfig, null, 2));
  });

  it('saveGroupConfig 写入 group.json', async () => {
    await manager.saveGroupConfig(validGroupConfig as never);

    const content = await readFile(join(configDir, 'group.json'), 'utf-8');

    expect(JSON.parse(content)).toEqual(validGroupConfig);
  });

  it('saveSystemConfig 写入 system.json', async () => {
    await manager.saveSystemConfig(baseSystem);

    const content = await readFile(join(configDir, 'system.json'), 'utf-8');

    expect(JSON.parse(content)).toEqual(baseSystem);
  });

  it('保存后不留存 .tmp 临时文件（原子写入）', async () => {
    await manager.saveMcpConfig(validMcpConfig);

    const files = await readdir(configDir);

    expect(files).toEqual(['mcp_server.json']);
  });

  it('保存时自动创建不存在的（嵌套）目录', async () => {
    const nestedDir = join(configDir, 'level1', 'level2');
    const nestedManager = new ConfigManager(nestedDir);

    await nestedManager.saveGroupConfig(validGroupConfig as never);

    expect(existsSync(join(nestedDir, 'group.json'))).toBe(true);
  });

  it('保存后可重新加载（往返一致）', async () => {
    await manager.saveMcpConfig(validMcpConfig);

    await expect(manager.loadMcpConfig()).resolves.toEqual(validMcpConfig);
  });

  it('saveConfig 按类型分发到对应文件', async () => {
    await manager.saveConfig('mcp_server.json', validMcpConfig);
    await manager.saveConfig('group.json', validGroupConfig as never);
    await manager.saveConfig('system.json', baseSystem);

    expect(JSON.parse(await readFile(join(configDir, 'mcp_server.json'), 'utf-8'))).toEqual(
      validMcpConfig,
    );
    expect(JSON.parse(await readFile(join(configDir, 'group.json'), 'utf-8'))).toEqual(
      validGroupConfig,
    );
    expect(JSON.parse(await readFile(join(configDir, 'system.json'), 'utf-8'))).toEqual(baseSystem);
  });

  it('saveConfig 遇到未知类型时抛出明确错误', async () => {
    await expect(manager.saveConfig('unknown.json' as never, {} as never)).rejects.toThrow(
      '不支持的配置文件类型: unknown.json',
    );
  });
});

describe('ConfigManager 单项校验', () => {
  const manager = new ConfigManager('/nonexistent-config-dir');

  it('validateMcpConfig 接受合法配置', () => {
    const result = manager.validateMcpConfig(validMcpConfig);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(validMcpConfig);
  });

  it('validateMcpConfig 拒绝空 servers 并给出中文错误', () => {
    const result = manager.validateMcpConfig({ servers: {} });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('servers: 至少需要配置一个MCP服务器');
  });

  it('validateGroupConfig 接受合法组配置', () => {
    const result = manager.validateGroupConfig(validGroupConfig);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(validGroupConfig);
  });

  it('validateGroupConfig 拒绝空 ID', () => {
    const result = manager.validateGroupConfig({
      default: { id: '', name: '默认组', servers: ['fetch'], tools: [] },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('组ID不能为空'))).toBe(true);
  });

  it('validateSystemConfig 接受合法系统配置', () => {
    const result = manager.validateSystemConfig(baseSystem);

    expect(result.success).toBe(true);
  });

  it('validateSystemConfig 拒绝非法端口类型', () => {
    const result = manager.validateSystemConfig({
      server: { port: 'not-a-number' },
    });

    expect(result.success).toBe(false);
    expect((result.errors ?? []).length).toBeGreaterThan(0);
  });
});

describe('ConfigManager.validateAll', () => {
  const manager = new ConfigManager('/nonexistent-config-dir');

  it('全部合法且未提供 system 时返回成功，systemConfig 为 undefined', () => {
    const result = manager.validateAll(validMcpConfig, validGroupConfig);

    expect(result).toEqual({
      success: true,
      data: {
        mcpConfig: validMcpConfig,
        groupConfig: validGroupConfig,
        systemConfig: undefined,
      },
    });
  });

  it('提供合法 system 时一并解析返回', () => {
    const result = manager.validateAll(validMcpConfig, validGroupConfig, baseSystem);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpConfig).toEqual(validMcpConfig);
      expect(result.data.groupConfig).toEqual(validGroupConfig);
      expect(result.data.systemConfig).toEqual(
        expect.objectContaining({ server: baseSystem.server }),
      );
    }
  });

  it('MCP 配置非法时报 MCP配置错误 并短路（不再校验组配置）', () => {
    const result = manager.validateAll(
      { servers: {} },
      {
        bad: { id: '', name: '', servers: [''], tools: [] },
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.startsWith('MCP配置错误: '))).toBe(true);
      expect(result.errors.some((e) => e.startsWith('组配置错误: '))).toBe(false);
    }
  });

  it('组配置非法时报 组配置错误', () => {
    const result = manager.validateAll(validMcpConfig, {
      bad: { id: '', name: '组', servers: ['fetch'], tools: [] },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.startsWith('组配置错误: '))).toBe(true);
    }
  });

  it('组引用不存在的服务器时报 交叉引用错误', () => {
    const result = manager.validateAll(validMcpConfig, {
      default: { id: 'default', name: '默认组', servers: ['ghost-server'], tools: [] },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some(
          (e) =>
            e.startsWith('交叉引用错误: ') &&
            e.includes('未在MCP配置中定义的服务器 "ghost-server"'),
        ),
      ).toBe(true);
    }
  });

  it('system 配置非法时报 系统配置错误', () => {
    const result = manager.validateAll(validMcpConfig, validGroupConfig, {
      server: { port: 'bad' },
    } as unknown as SystemConfig);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.startsWith('系统配置错误: '))).toBe(true);
    }
  });
});
